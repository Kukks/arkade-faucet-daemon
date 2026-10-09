import { setTimeout as sleep } from "node:timers/promises";
import { EventSource } from "eventsource";
import bolt11 from "light-bolt11-decoder";
import {
  MnemonicIdentity,
  Wallet,
  Ramps,
  RestArkProvider,
  EsploraProvider,
  PaymentRouter,
  arkRail,
  onchainRail,
  walletFeeSource,
  BIP21,
  arkTarget,
  btcTarget,
  invoiceTarget,
} from "@arkade-os/sdk";
import {
  SQLiteWalletRepository,
  SQLiteContractRepository,
} from "@arkade-os/sdk/repositories/sqlite";
import { createSwapClient, lightningRail, isSwapError, REGISTRY_URL } from "@arkade-os/swap";
import { createNodeSqlExecutor } from "@arkade-os/swap/node";
import { SQLiteAssetSwapRepository } from "@arkade-os/swap/repositories/sqlite";

// The SDK uses Server-Sent Events for settlement updates; Node has no global EventSource.
globalThis.EventSource ??= EventSource;

export async function initWallet(config) {
  // mutinynet/testnet needs testnet derivation; mainnet identity vs mutinynet operator throws.
  const identity = MnemonicIdentity.fromMnemonic(config.mnemonic, { isMainnet: config.isMainnet });
  // Persist wallet + contract state on disk: an in-memory store would lose the daemon's
  // VTXO/sync state on every restart (and the SDK's default store is browser IndexedDB).
  const db = createNodeSqlExecutor(config.dbPath);
  const wallet = await Wallet.create({
    identity,
    arkProvider: new RestArkProvider(config.arkServerUrl),
    ...(config.esploraUrl ? { onchainProvider: new EsploraProvider(config.esploraUrl) } : {}),
    storage: {
      walletRepository: new SQLiteWalletRepository(db),
      contractRepository: new SQLiteContractRepository(db),
    },
  });
  const swaps = createSwapClient({ wallet, repository: new SQLiteAssetSwapRepository(db) });
  // The router's availability check never fetches markets; without a warm snapshot the swap rails stay hidden.
  await swaps.markets().catch((e) => console.warn(`swap market discovery failed: ${e.message}`));
  // Touching ready restores persisted swaps and resumes their claims and refunds after a restart.
  swaps.ready.catch((e) => console.warn(`swap restore failed: ${e.message}`));
  // No on-chain swap rail: on mutinynet its solver accepted and funded a swap it never filled, holding
  // the send until refund, while the collaborative exit pays the same addresses at no fee.
  const router = new PaymentRouter({ wallet, prefs: { priority: ["ark", "lightning", "onchain"] } })
    .use(arkRail())
    .use(lightningRail(swaps))
    .use(onchainRail({ feeInfo: walletFeeSource(wallet) }));
  return { wallet, router };
}

export async function onboard(wallet) {
  const info = await wallet.getArkadeInfo();
  return new Ramps(wallet).onboard(info.fees);
}

// Replenishment policy, tuned by env vars: MIN_BALANCE is the low-water mark
// (passed in as `minBalance`); REPLENISH_AMOUNT sets the top-up size requested
// in createReplenisher. Request a top-up only when spendable funds are below the
// mark AND no prior top-up is already inbound (`boardingTotal`) covering the
// deficit — so a boarding deposit that's still confirming isn't double-funded.
export function shouldReplenish({ available, boardingTotal, minBalance }) {
  if (available >= minBalance) return false;
  if (boardingTotal >= minBalance - available) return false;
  return true;
}

export function createReplenisher({ wallet, config, shouldReplenish, requestOnchain, onboard, getBoardingAddress, log }) {
  let inFlight = false;
  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      const bal = await wallet.getBalance();
      const boarding = bal.boarding ?? { confirmed: 0, total: 0 };
      if (boarding.confirmed > 0) {
        log(`onboarding ${boarding.confirmed} sats of confirmed boarding funds`);
        await onboard(wallet);
      } else if (shouldReplenish({ available: bal.available, boardingTotal: boarding.total, minBalance: config.minBalance })) {
        const addr = await getBoardingAddress();
        log(`requesting ${config.replenishAmount} sats onchain to boarding address`);
        await requestOnchain({ faucetApi: config.faucetApi, token: config.faucetToken, sats: config.replenishAmount, address: addr });
      }
    } catch (e) {
      log(`replenish error: ${e?.message ?? e}`);
    } finally {
      inFlight = false;
    }
  }
  return { tick };
}

const UNRECOGNIZED =
  "Paste an Arkade address (tark1…), a bitcoin address, a BOLT11 invoice, a Lightning address or a bitcoin: URI.";

const fail = (status, message) => Object.assign(new Error(message), { status });
const tooMuch = (asked, max) => fail(400, `This destination asks for ${asked} sats, more than the ${max} you entered.`);

function within(ms, promise, message) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

function invoiceSats(invoice) {
  try {
    const msat = bolt11.decode(invoice).sections.find((s) => s.name === "amount")?.value;
    return msat ? Number(BigInt(msat) / 1000n) : undefined;
  } catch {
    throw fail(400, UNRECOGNIZED);
  }
}

// 4xx tells faucet-rs nothing left the wallet, so it releases the user's quota. Swap errors are
// thrown before funding; a swap that fails after it (refunding, needs_recovery) stays a 500.
function payFailure(e) {
  // "No vtxos available": coin selection found nothing spendable, e.g. while an exit holds them for its batch.
  if (/insufficient funds|no vtxos available/i.test(e?.message) || isSwapError(e, "InsufficientFunds")) {
    return fail(409, "The Arkade faucet wallet can't cover this right now. Try again in a few minutes.");
  }
  if (isSwapError(e)) {
    return fail(422, `Payment failed, nothing was sent: ${e.message}`);
  }
  return e;
}

export async function fetchLightningRange(network, fetchFn = fetch) {
  const { markets } = await (await fetchFn(REGISTRY_URL[network])).json();
  const m = markets.find((x) => x.quote_corridor === "lightning");
  const fmt = (n) => Number(n).toLocaleString("en-US");
  return `${fmt(m.min_quote_amount)}–${fmt(m.max_quote_amount)}`;
}

export function createSender({ router, lightningRange, isMainnet = false, routeMs = 6000, waitMs = 8000 }) {
  return async function send({ address, sats }) {
    const pasted = String(address ?? "").trim().replace(/^"|"$/g, "");
    // QR codes upper-case invoices; bech32 is case-insensitive.
    const raw = /^(lightning:)?ln/i.test(pasted) ? pasted.toLowerCase() : pasted;
    const invoice = invoiceTarget(raw);
    if (!invoice && !arkTarget(raw) && !btcTarget(raw)) throw fail(400, UNRECOGNIZED);
    // The SDK classifies addresses of any network, and the collaborative exit would pay a mainnet one.
    if ([btcTarget(raw), arkTarget(raw)].some((t) => t && /^(bc1|[13]|ark1)/i.test(t) !== isMainnet)) {
      throw fail(400, "That destination is for another network.");
    }
    const max = Number(sats);
    if (!(Number.isSafeInteger(max) && max > 0)) throw fail(400, "Enter an amount in sats.");
    const pinned = BIP21.amountSats(raw) ?? (invoice && invoiceSats(invoice));
    if (pinned > max) throw tooMuch(pinned, max);
    // The lightning rail refuses an explicit amount beside an amount-bearing invoice, even an equal one.
    const options = await router.options({ raw, amount: pinned === undefined ? max : undefined });
    let q, failure;
    // A rail whose quote fails (a solver at its exposure cap, say) falls through to the next one.
    for (const option of options) {
      try {
        q = await within(routeMs, option.quote(), "the solver didn't answer in time");
        break;
      } catch (e) {
        failure = e;
      }
    }
    if (!q && invoice) {
      const range = failure ? undefined : await lightningRange().catch(() => undefined);
      const why = failure?.message ?? `${range ? `solver range: ${range} sats; ` : ""}this network's invoices only`;
      throw fail(400, `Lightning via Arkade swap can't pay this invoice (${why}). Use the Lightning tab instead.`);
    }
    // Nothing has moved before send(), so every failure up to here is a 4xx.
    if (!q) throw fail(400, `Can't pay this destination: ${failure?.message ?? "no route"}`);
    // A URI's amount= can understate the invoice it carries; the quote is what would be paid.
    if (q.amount > max) throw tooMuch(q.amount, max);
    try {
      const handle = await q.send();
      const settled = handle.settled();
      settled.catch((e) => console.error(`settlement failed (rail=${q.railId}): ${e?.message ?? e}`));
      const { txid, swapId } = (await Promise.race([settled, sleep(waitMs, undefined, { ref: false })])) ?? {};
      return { rail: q.railId, status: handle.status, amount: q.amount, fee: q.fee, txid, swapId };
    } catch (e) {
      throw payFailure(e);
    }
  };
}
