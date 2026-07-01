import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "./server.js";

const baseConfig = { maxSend: 100000, allowedOrigin: "http://localhost:3000", internalToken: "" };
const baseDeps = {
  config: baseConfig,
  dispense: async ({ address, sats }) => `tx-${sats}-${address}`,
  getAvailable: async () => 4242,
};

test("OPTIONS preflight returns CORS headers", async () => {
  const r = await handle({ method: "OPTIONS", url: "/send", headers: {}, body: null }, baseDeps);
  assert.equal(r.status, 204);
  assert.equal(r.headers["Access-Control-Allow-Origin"], "http://localhost:3000");
  assert.match(r.headers["Access-Control-Allow-Headers"], /X-Internal-Token/);
});

test("POST /send without shared secret configured dispenses freely (internal network trust)", async () => {
  const r = await handle({ method: "POST", url: "/send", headers: {}, body: { address: "tark1abc", sats: 50 } }, baseDeps);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { txid: "tx-50-tark1abc" });
});

test("POST /send with shared secret configured rejects on mismatch", async () => {
  const deps = { ...baseDeps, config: { ...baseConfig, internalToken: "s3cret" } };
  const r = await handle({ method: "POST", url: "/send", headers: { "x-internal-token": "wrong" }, body: { address: "tark1", sats: 10 } }, deps);
  assert.equal(r.status, 401);
});

test("POST /send with shared secret configured accepts on match", async () => {
  const deps = { ...baseDeps, config: { ...baseConfig, internalToken: "s3cret" } };
  const r = await handle({ method: "POST", url: "/send", headers: { "x-internal-token": "s3cret" }, body: { address: "tark1xyz", sats: 50 } }, deps);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { txid: "tx-50-tark1xyz" });
});

test("POST /send surfaces dispense errors as 400 text", async () => {
  const deps = { ...baseDeps, dispense: async () => { throw new Error("amount exceeds per-request cap of 100000 sats"); } };
  const r = await handle({ method: "POST", url: "/send", headers: {}, body: { address: "tark1", sats: 9 } }, deps);
  assert.equal(r.status, 400);
  assert.match(String(r.body), /exceeds per-request cap/);
});

test("GET /info returns available balance", async () => {
  const r = await handle({ method: "GET", url: "/info", headers: {}, body: null }, baseDeps);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { available: 4242 });
});

test("unknown route -> 404", async () => {
  const r = await handle({ method: "GET", url: "/nope", headers: {}, body: null }, baseDeps);
  assert.equal(r.status, 404);
});
