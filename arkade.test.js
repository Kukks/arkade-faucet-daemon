import { test } from "node:test";
import assert from "node:assert/strict";
import { dispense, shouldReplenish, createReplenisher } from "./arkade.js";

test("dispense rejects non-positive and over-cap amounts", async () => {
  const wallet = { send: async () => "txid" };
  await assert.rejects(() => dispense({ wallet, address: "tark1", sats: 0, maxSend: 100 }));
  await assert.rejects(() => dispense({ wallet, address: "tark1", sats: 101, maxSend: 100 }));
});

test("dispense forwards address+amount and returns txid", async () => {
  let got;
  const wallet = { send: async (args) => { got = args; return "abc123"; } };
  const txid = await dispense({ wallet, address: "tark1xyz", sats: 50, maxSend: 100 });
  assert.equal(txid, "abc123");
  assert.deepEqual(got, { address: "tark1xyz", amount: 50 });
});

test("shouldReplenish: true below threshold, false when covered by available or inbound", () => {
  assert.equal(shouldReplenish({ available: 10, boardingTotal: 0, minBalance: 100 }), true);
  assert.equal(shouldReplenish({ available: 100, boardingTotal: 0, minBalance: 100 }), false);
  // already topping up (boarding inbound covers the deficit) -> don't request again
  assert.equal(shouldReplenish({ available: 10, boardingTotal: 999, minBalance: 100 }), false);
});

test("replenisher tick onboards when confirmed boarding funds exist", async () => {
  const calls = [];
  const r = createReplenisher({
    wallet: { getBalance: async () => ({ available: 0, boarding: { confirmed: 500, total: 500 } }) },
    config: { minBalance: 100, replenishAmount: 1000, faucetApi: "f", faucetToken: "t" },
    shouldReplenish,
    onboard: async () => { calls.push("onboard"); return "ob"; },
    requestOnchain: async () => { calls.push("request"); },
    getBoardingAddress: async () => "tb1board",
    log: () => {},
  });
  await r.tick();
  assert.deepEqual(calls, ["onboard"]);
});

test("replenisher tick requests onchain when low and nothing inbound", async () => {
  const calls = [];
  const r = createReplenisher({
    wallet: { getBalance: async () => ({ available: 0, boarding: { confirmed: 0, total: 0 } }) },
    config: { minBalance: 100, replenishAmount: 1000, faucetApi: "f", faucetToken: "t" },
    shouldReplenish,
    onboard: async () => { calls.push("onboard"); },
    requestOnchain: async (args) => { calls.push(["request", args.sats, args.address]); },
    getBoardingAddress: async () => "tb1board",
    log: () => {},
  });
  await r.tick();
  assert.deepEqual(calls, [["request", 1000, "tb1board"]]);
});

test("replenisher tick is single-flight (no overlap)", async () => {
  let active = 0, maxActive = 0;
  const r = createReplenisher({
    wallet: { getBalance: async () => { active++; maxActive = Math.max(maxActive, active);
      await new Promise(res => setTimeout(res, 10)); active--;
      return { available: 999, boarding: { confirmed: 0, total: 0 } }; } },
    config: { minBalance: 100, replenishAmount: 1000, faucetApi: "f", faucetToken: "t" },
    shouldReplenish, onboard: async () => {}, requestOnchain: async () => {},
    getBoardingAddress: async () => "tb1", log: () => {},
  });
  await Promise.all([r.tick(), r.tick(), r.tick()]);
  assert.equal(maxActive, 1);
});
