import { test } from "node:test";
import assert from "node:assert/strict";
import { ArkAddress } from "@arkade-os/sdk";
import { SwapPaymentFailedError } from "@arkade-os/swap";
import { shouldReplenish, createReplenisher, createSender, fetchLightningRange } from "./arkade.js";

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

const ARK = new ArkAddress(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), "tark").encode();
const BTC = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
// Minted on mutinynet: 21,000 sats, and amountless.
const INVOICE_21K = "lntbs210u1p4v0akwpp5y6mjspm2q4x0s6hrcl9kp49t4lthle5eu5sey9kqy82cfn3qy4ssdqqcqzzsxqyz5vqsp5myh3czujrt5egq0mruyynf8rlt9uhz92pcfwau3u0f7apgf46cqq9qxpqysgqzvtq8ps7hm33663qcpydka3vtjyvjkkapy45e0u6qhq9vyqc4j6qgf29aq2xx5c5pwrw8xqjudkgqjeh58z7c4h4mz2tzngfhvv6z5qpmjjlv4";
const INVOICE_ANY = "lntbs1p4v0ak6pp5d22447fc026ehwgjk4smmyufj9m9zaeveymgpqztk4ml9mv2jzkqdqqcqzzsxqyz5vqsp59m5qfml256wpjnylse7a5jtx9kv2uxrshsupgyvsdyz49003pv6q9qxpqysgq7eh34tuju4mawsng34haasj0wwcehu3r8xaql4r68fljfgysmkfhevc00fkq0m7f50ze642eul2uxmtywljl4at6dnxguky7qgpyj4qpmjhalj";

function fakeRouter({ rails = [{ railId: "ark" }], status = "settled", settled } = {}) {
  const seen = [];
  return {
    seen,
    options: async (req) => {
      seen.push(req);
      return rails.map(({ railId, fail }) => ({
        railId,
        quote: async () => {
          if (fail) throw fail;
          const done = settled ?? (async () => ({ railId, txid: "tx1" }));
          return { railId, amount: req.amount ?? 21000, fee: 0, send: async () => ({ status, settled: done }) };
        },
      }));
    },
  };
}
const sender = (router, opts = {}) =>
  createSender({ router, lightningRange: async () => "1,000–25,000", ...opts });

test("send reports the routed rail's result", async () => {
  assert.deepEqual(await sender(fakeRouter())({ address: ARK, sats: 500 }),
    { rail: "ark", status: "settled", amount: 500, fee: 0, txid: "tx1", swapId: undefined });
});

test("unrecognized destinations and bad amounts are refused before routing", async () => {
  const router = fakeRouter();
  const send = sender(router);
  for (const address of ["hello", "alice@example.com", "", undefined]) {
    await assert.rejects(send({ address, sats: 5 }), { status: 400, message: /^Paste an Arkade address/ });
  }
  for (const sats of [undefined, null, 0, 1.5, -3, "abc"]) {
    await assert.rejects(send({ address: ARK, sats }), { status: 400, message: "Enter an amount in sats." });
  }
  await assert.rejects(send({ address: INVOICE_21K, sats: 5000 }), {
    status: 400,
    message: "This destination asks for 21000 sats, more than the 5000 you entered.",
  });
  assert.equal(router.seen.length, 0);
});

test("a destination's own amount is paid when it fits under sats", async () => {
  const router = fakeRouter();
  const send = sender(router);
  await send({ address: INVOICE_21K, sats: 50000 });
  await send({ address: `LIGHTNING:${INVOICE_21K.toUpperCase()}`, sats: 50000 });
  await send({ address: `bitcoin:${BTC}?amount=0.0001`, sats: 50000 });
  await send({ address: INVOICE_ANY, sats: 777 });
  await send({ address: `  "${ARK}"  `, sats: 10 });
  assert.deepEqual(router.seen.map((r) => r.amount), [undefined, undefined, undefined, 777, 10]);
  assert.equal(router.seen[1].raw, `lightning:${INVOICE_21K}`);
  assert.equal(router.seen[4].raw, ARK);
});

test("an invoice with no route says what the swap can pay", async () => {
  await assert.rejects(sender(fakeRouter({ rails: [] }))({ address: INVOICE_21K, sats: 50000 }), {
    status: 400,
    message: "Lightning via Arkade swap can't pay this invoice (solver range: 1,000–25,000 sats; this network's invoices only). Use the Lightning tab instead.",
  });
  const offline = sender(fakeRouter({ rails: [] }), { lightningRange: async () => { throw new Error("offline"); } });
  await assert.rejects(offline({ address: INVOICE_21K, sats: 50000 }), {
    status: 400,
    message: "Lightning via Arkade swap can't pay this invoice (this network's invoices only). Use the Lightning tab instead.",
  });
});

test("a failing rail falls through to the next; when all fail nothing moved, so it is a 400", async () => {
  const refusal = new Error("solver refused: exposure_cap");
  const fallback = sender(fakeRouter({ rails: [{ railId: "onchain-swap", fail: refusal }, { railId: "onchain" }] }));
  assert.equal((await fallback({ address: BTC, sats: 20000 })).rail, "onchain");
  await assert.rejects(sender(fakeRouter({ rails: [{ railId: "lightning", fail: refusal }] }))({ address: INVOICE_21K, sats: 50000 }), {
    status: 400,
    message: "Lightning via Arkade swap can't pay this invoice (solver refused: exposure_cap). Use the Lightning tab instead.",
  });
  await assert.rejects(sender(fakeRouter({ rails: [{ railId: "onchain", fail: new Error("Invalid checksum") }] }))({ address: BTC, sats: 20000 }), {
    status: 400,
    message: "Can't pay this destination: Invalid checksum",
  });
});

test("payment failures map to the status faucet-rs acts on", async () => {
  const failing = (error) => sender(fakeRouter({ settled: async () => { throw error; } }));
  for (const [error, status] of [
    [new Error("Insufficient funds"), 409],
    [new SwapPaymentFailedError("lightning", "refunded", { id: "s1" }), 422],
  ]) {
    await assert.rejects(failing(error)({ address: ARK, sats: 1 }), { status });
  }
  await assert.rejects(failing(new Error("boom"))({ address: ARK, sats: 1 }),
    (e) => e.status === undefined && e.message === "boom");
});

test("a slow payment reports its in-flight status", async () => {
  const send = sender(fakeRouter({ status: "sent", settled: () => new Promise(() => {}) }), { waitMs: 5 });
  assert.deepEqual(await send({ address: ARK, sats: 1 }),
    { rail: "ark", status: "sent", amount: 1, fee: 0, txid: undefined, swapId: undefined });
});

test("fetchLightningRange reads the lightning market's take-side bounds", async () => {
  const fetchFn = async () => ({ json: async () => ({ markets: [
    { quote_corridor: "onchain", min_quote_amount: "1", max_quote_amount: "2" },
    { quote_corridor: "lightning", min_quote_amount: "1000", max_quote_amount: "25000" },
  ] }) });
  assert.equal(await fetchLightningRange("mutinynet", fetchFn), "1,000–25,000");
});
