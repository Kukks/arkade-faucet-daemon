function required(env, key) {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT ?? 8080),
    arkServerUrl: env.ARK_SERVER_URL ?? "https://mutinynet.arkade.sh",
    esploraUrl: env.ESPLORA_URL,
    isMainnet: (env.IS_MAINNET ?? "false").toLowerCase() === "true",
    dbPath: env.DB_PATH ?? "./arkade-wallet.sqlite",
    mnemonic: required(env, "ARKADE_MNEMONIC"),
    // Optional: URL of an upstream faucet the daemon calls to top up its own boarding
    // address. Unset both FAUCET_API and FAUCET_API_TOKEN to disable auto-replenishment.
    faucetApi: env.FAUCET_API ? env.FAUCET_API.replace(/\/$/, "") : "",
    faucetToken: env.FAUCET_API_TOKEN ?? "",
    // Optional shared secret. When set, POST /send requires `X-Internal-Token: <value>`.
    // Defense in depth; the daemon is meant to sit behind the faucet backend on an
    // internal network, so this is off by default.
    internalToken: env.INTERNAL_TOKEN ?? "",
    minBalance: Number(env.MIN_BALANCE ?? 100000),
    replenishAmount: Number(env.REPLENISH_AMOUNT ?? 1000000),
    maxSend: Number(env.MAX_SEND ?? 100000),
    allowedOrigin: env.ALLOWED_ORIGIN ?? "*",
    replenishIntervalMs: Number(env.REPLENISH_INTERVAL_MS ?? 30000),
  };
}
