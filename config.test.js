import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const base = {
  ARKADE_MNEMONIC: "abandon abandon abandon",
};

test("loadConfig throws when ARKADE_MNEMONIC is missing", () => {
  assert.throws(() => loadConfig({}), /ARKADE_MNEMONIC/);
});

test("loadConfig applies defaults and parses numbers", () => {
  const c = loadConfig({ ...base, MIN_BALANCE: "50000", PORT: "9000" });
  assert.equal(c.port, 9000);
  assert.equal(c.minBalance, 50000);
  assert.equal(c.arkServerUrl, "https://mutinynet.arkade.sh");
  assert.equal(c.isMainnet, false);
  assert.equal(typeof c.replenishAmount, "number");
  assert.equal(typeof c.maxSend, "number");
});

test("loadConfig reads IS_MAINNET as a boolean (default false)", () => {
  assert.equal(loadConfig({ ...base }).isMainnet, false);
  assert.equal(loadConfig({ ...base, IS_MAINNET: "true" }).isMainnet, true);
});

test("faucet + internalToken default to empty when unset", () => {
  const c = loadConfig({ ...base });
  assert.equal(c.faucetApi, "");
  assert.equal(c.faucetToken, "");
  assert.equal(c.internalToken, "");
});

test("faucetApi trailing slash is stripped", () => {
  const c = loadConfig({ ...base, FAUCET_API: "https://faucet.example/" });
  assert.equal(c.faucetApi, "https://faucet.example");
});
