import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "./server.js";

const baseConfig = { allowedOrigin: "http://localhost:3000", internalToken: "" };
const baseDeps = {
  config: baseConfig,
  send: async ({ address, sats }) => ({ txid: `tx-${sats}-${address}` }),
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

test("errors keep their status as text; unknown ones are 500", async () => {
  const throwing = (e) => ({ ...baseDeps, send: async () => { throw e; } });
  const known = await handle({ method: "POST", url: "/send", headers: {}, body: {} },
    throwing(Object.assign(new Error("refilling"), { status: 409 })));
  assert.deepEqual([known.status, known.body], [409, "refilling"]);
  const unknown = await handle({ method: "POST", url: "/send", headers: {}, body: {} }, throwing(new Error("boom")));
  assert.deepEqual([unknown.status, unknown.body], [500, "boom"]);
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
