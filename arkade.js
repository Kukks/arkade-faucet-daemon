import { EventSource } from "eventsource";
import { DatabaseSync } from "node:sqlite";
import { MnemonicIdentity, Wallet, Ramps } from "@arkade-os/sdk";
import {
  SQLiteWalletRepository,
  SQLiteContractRepository,
} from "@arkade-os/sdk/repositories/sqlite";

// The SDK uses Server-Sent Events for settlement updates; Node has no global EventSource.
globalThis.EventSource ??= EventSource;

// Wrap Node's built-in sqlite as the SQLExecutor the SDK's SQLite repositories expect
// ({ run, get, all }). node:sqlite avoids a native better-sqlite3 build.
function createSqlExecutor(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  return {
    run: async (sql, params) => { db.prepare(sql).run(...(params ?? [])); },
    get: async (sql, params) => db.prepare(sql).get(...(params ?? [])),
    all: async (sql, params) => db.prepare(sql).all(...(params ?? [])),
  };
}

export async function initWallet(config) {
  // mutinynet/testnet needs testnet derivation; mainnet identity vs mutinynet operator throws.
  const identity = MnemonicIdentity.fromMnemonic(config.mnemonic, { isMainnet: config.isMainnet });
  // Persist wallet + contract state on disk: an in-memory store would lose the daemon's
  // VTXO/sync state on every restart (and the SDK's default store is browser IndexedDB).
  const executor = createSqlExecutor(config.dbPath);
  return Wallet.create({
    identity,
    arkServerUrl: config.arkServerUrl,
    ...(config.esploraUrl ? { esploraUrl: config.esploraUrl } : {}),
    storage: {
      walletRepository: new SQLiteWalletRepository(executor),
      contractRepository: new SQLiteContractRepository(executor),
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
  const info = await wallet.arkProvider.getInfo();
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
