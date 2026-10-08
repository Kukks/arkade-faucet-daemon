import { setTimeout as sleep } from "node:timers/promises";
import { EventSource } from "eventsource";
import bolt11 from "light-bolt11-decoder";
import {
  MnemonicIdentity,
  Wallet,
  Ramps,
  RestArkProvider,
  EsploraProvider,
  BIP21,
  arkTarget,
  btcTarget,
  invoiceTarget,
} from "@arkade-os/sdk";
import {
  SQLiteWalletRepository,
  SQLiteContractRepository,
} from "@arkade-os/sdk/repositories/sqlite";
import { isSwapError, SwapPaymentFailedError, REGISTRY_URL } from "@arkade-os/swap";
import { createNodeSqlExecutor } from "@arkade-os/swap/node";

// The SDK uses Server-Sent Events for settlement updates; Node has no global EventSource.
globalThis.EventSource ??= EventSource;

export async function initWallet(config) {
  // mutinynet/testnet needs testnet derivation; mainnet identity vs mutinynet operator throws.
  const identity = MnemonicIdentity.fromMnemonic(config.mnemonic, { isMainnet: config.isMainnet });
  // Persist wallet + contract state on disk: an in-memory store would lose the daemon's
  // VTXO/sync state on every restart (and the SDK's default store is browser IndexedDB).
  const db = createNodeSqlExecutor(config.dbPath);
  return Wallet.create({
    identity,
    arkProvider: new RestArkProvider(config.arkServerUrl),
    ...(config.esploraUrl ? { onchainProvider: new EsploraProvider(config.esploraUrl) } : {}),
    storage: {
      walletRepository: new SQLiteWalletRepository(db),
      contractRepository: new SQLiteContractRepository(db),
    },
  });
}

export async function dispense({ wallet, address, sats, maxSend }) {
  if (!Number.isInteger(sats) || sats <= 0) throw new Error("sats must be a positive integer");
  if (sats > maxSend) throw new Error(`amount exceeds per-request cap of ${maxSend} sats`);
  // SDK 0.4.39 confirmed: wallet.send({ address, amount }) -> txid (one Recipient).
  return wallet.send({ address, amount: sats });
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

export class PayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function invoiceSats(invoice) {
  try {
    const msat = bolt11.decode(invoice).sections.find((s) => s.name === "amount")?.value;
    return msat ? Number(BigInt(msat) / 1000n) : undefined;
  } catch {
    throw new PayError(400, UNRECOGNIZED);
  }
}

// 4xx tells faucet-rs nothing left the wallet, so it releases the user's quota.
function payFailure(e) {
  if (/insufficient funds/i.test(e?.message) || isSwapError(e, "InsufficientFunds")) {
    return new PayError(409, "The Arkade faucet wallet is refilling. Try again in a few minutes.");
  }
  if (isSwapError(e) || e instanceof SwapPaymentFailedError) {
    return new PayError(422, `Payment failed, nothing was sent: ${e.message}`);
  }
  return e;
}

export async function fetchLightningRange(network, fetchFn = fetch) {
  const { markets } = await (await fetchFn(REGISTRY_URL[network])).json();
  const m = markets.find((x) => x.quote_corridor === "lightning");
  const fmt = (n) => Number(n).toLocaleString("en-US");
  return `${fmt(m.min_quote_amount)}–${fmt(m.max_quote_amount)}`;
}

export function createSender({ router, lightningRange, waitMs = 8000 }) {
  return async function send({ address, sats }) {
    const pasted = String(address ?? "").trim().replace(/^"|"$/g, "");
    // QR codes upper-case invoices; bech32 is case-insensitive.
    const raw = /^(lightning:)?ln/i.test(pasted) ? pasted.toLowerCase() : pasted;
    const invoice = invoiceTarget(raw);
    if (!invoice && !arkTarget(raw) && !btcTarget(raw)) throw new PayError(400, UNRECOGNIZED);
    const max = Number(sats);
    if (!(Number.isSafeInteger(max) && max > 0)) throw new PayError(400, "Enter an amount in sats.");
    const pinned = BIP21.amountSats(raw) ?? (invoice && invoiceSats(invoice));
    if (pinned > max) {
      throw new PayError(400, `This destination asks for ${pinned} sats, more than the ${max} you entered.`);
    }
    let q;
    try {
      // The lightning rail refuses an explicit amount beside an amount-bearing invoice, even an equal one.
      q = await router.route({ raw, amount: pinned === undefined ? max : undefined });
    } catch (e) {
      if (invoice && e?.message?.startsWith("no rail for")) {
        const range = await lightningRange().catch(() => undefined);
        throw new PayError(400, `Lightning via Arkade swap can't pay this invoice (${range ? `solver range: ${range} sats; ` : ""}this network's invoices only). Use the Lightning tab instead.`);
      }
      throw isSwapError(e) ? new PayError(400, e.message) : e;
    }
    try {
      const handle = await q.send();
      const settled = handle.settled();
      settled.catch(() => {});
      const { txid, swapId } = (await Promise.race([settled, sleep(waitMs, undefined, { ref: false })])) ?? {};
      return { rail: q.railId, status: handle.status, amount: q.amount, fee: q.fee, txid, swapId };
    } catch (e) {
      throw payFailure(e);
    }
  };
}
