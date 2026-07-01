import { test } from "node:test";
import assert from "node:assert/strict";
import { requestOnchain } from "./faucet.js";

test("requestOnchain posts sats+address with the configured token and throws on failure", async () => {
  let body, headers;
  await requestOnchain({ faucetApi: "https://f", token: "Bearer t", sats: 1000, address: "tb1q" },
    async (u, opts) => { body = JSON.parse(opts.body); headers = opts.headers; return { ok: true, text: async () => "{}" }; });
  assert.deepEqual(body, { sats: 1000, address: "tb1q" });
  assert.equal(headers.Authorization, "Bearer t");

  await assert.rejects(() => requestOnchain({ faucetApi: "https://f", token: "Bearer t", sats: 1, address: "x" },
    async () => ({ ok: false, status: 429, text: async () => "Rate limit exceeded" })), /Rate limit/);
});
