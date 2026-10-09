# arkade-faucet-daemon

Small Node service that holds a mutinynet [Arkade](https://arkade.sh) wallet and dispenses funds
on behalf of a faucet backend. Designed to run **inside a private network** — a faucet backend
(e.g. [`mutinynet-faucet-rs`](https://github.com/MutinyWallet/mutinynet-faucet-rs)) authenticates
the end user with its own machinery, then forwards `{ address, sats }` here.

## Architecture

```
browser ──► faucet backend (public, does auth) ──► arkade-faucet-daemon (internal)
                                                        │
                                                        └── @arkade-os/sdk + @arkade-os/swap ──► Arkade operator, swap solvers
```

`POST /send` accepts `{ "address": "…", "sats": 50000 }`. `address` is any destination: an Arkade
address, a bitcoin address, a BOLT11 invoice or a `bitcoin:` URI. `sats` is the most to pay; a
destination that carries its own amount is paid that amount when it is lower and refused when it is
higher. Returns `{ rail, status, amount, fee, txid?, swapId? }`; a 4xx means nothing left the wallet.
There is no user-level auth on the daemon — that belongs to the faucet
backend. As defense in depth, set `INTERNAL_TOKEN` to require an `X-Internal-Token` header on
`/send`.

## Endpoints

| Method | Path    | Body / Response                                      |
| ------ | ------- | ---------------------------------------------------- |
| POST   | `/send` | `{address, sats}` → `{rail, status, amount, fee, txid?, swapId?}` (4xx: nothing sent) |
| GET    | `/info` | `{available}` (spendable sats)                       |

## Docker

Published to `ghcr.io/kukks/arkade-faucet-daemon` on every push to `main` and every `v*.*.*` tag.

```yaml
# docker-compose.yml snippet
services:
  arkade-daemon:
    image: ghcr.io/kukks/arkade-faucet-daemon:latest
    environment:
      ARKADE_MNEMONIC: "abandon abandon …"
      ARK_SERVER_URL: https://mutinynet.arkade.sh
      IS_MAINNET: "false"
      DB_PATH: /data/arkade-wallet.sqlite
      # Optional auto-replenish from an upstream faucet
      FAUCET_API: http://faucet:3000
      FAUCET_API_TOKEN: "Bearer <token>"
      # Optional defense-in-depth
      INTERNAL_TOKEN: "shared-secret"
    volumes:
      - arkade-data:/data
    # No public port needed — expose only inside the compose network.

volumes:
  arkade-data:
```

## Local development

```bash
pnpm install
node gen-mnemonic.js            # print a fresh 12-word seed for ARKADE_MNEMONIC
cp .env.sample .env             # edit
pnpm start                      # loads .env automatically
```

Node ≥ 24 is required (uses stable `node:sqlite`).

## Auto-replenishment

Optional. When both `FAUCET_API` and `FAUCET_API_TOKEN` are set, a background loop
(`REPLENISH_INTERVAL_MS`) checks the wallet each tick and does at most one thing per tick:

1. If confirmed boarding funds exist, onboard them into VTXOs.
2. Otherwise, if `available < MIN_BALANCE` and no top-up is already inbound, POST
   `${FAUCET_API}/api/onchain` with `Authorization: ${FAUCET_API_TOKEN}` to request
   `REPLENISH_AMOUNT` sats onchain to the wallet's boarding address.

Single-flight guarded so ticks never overlap. Leave `FAUCET_API`/`FAUCET_API_TOKEN` unset to
disable the loop entirely (manual top-ups only).

## Environment reference

| Var                     | Default                          | Notes                                                                 |
| ----------------------- | -------------------------------- | --------------------------------------------------------------------- |
| `PORT`                  | `8080`                           |                                                                       |
| `ARKADE_MNEMONIC`       | *required*                       | BIP-39 seed for the wallet. Use `gen-mnemonic` to generate one.       |
| `ARK_SERVER_URL`        | `https://mutinynet.arkade.sh`    |                                                                       |
| `IS_MAINNET`            | `false`                          | Derivation network. `false` = testnet/mutinynet.                      |
| `ESPLORA_URL`           | *(SDK default)*                  | Optional override.                                                    |
| `DB_PATH`               | `./arkade-wallet.sqlite`         | Persist across restarts — mount a volume in Docker.                   |
| `INTERNAL_TOKEN`        | *(disabled)*                     | If set, `X-Internal-Token` must match on `/send`.                     |
| `FAUCET_API`            | *(disabled)*                     | Upstream faucet base URL for auto-replenish.                          |
| `FAUCET_API_TOKEN`      | *(disabled)*                     | Full `Authorization` header value for the upstream faucet.            |
| `MIN_BALANCE`           | `100000`                         | Replenish threshold (sats).                                           |
| `REPLENISH_AMOUNT`      | `1000000`                        | Top-up size requested from upstream (sats).                           |
| `MAX_SEND`              | *(no cap)*                       | Optional backstop: refuse requests above this many sats. The faucet backend's quota and per-request max apply first. |
| `ALLOWED_ORIGIN`        | `*`                              | CORS. Set to the faucet backend origin if it calls in-browser.        |
| `REPLENISH_INTERVAL_MS` | `30000`                          |                                                                       |

## Tests

```bash
node --test
```
