FROM node:24-slim AS build
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY arkade.js config.js faucet.js index.js server.js gen-mnemonic.js ./

FROM node:24-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    DB_PATH=/data/arkade-wallet.sqlite

RUN mkdir -p /data && chown node:node /data
USER node

COPY --from=build --chown=node:node /app /app
VOLUME ["/data"]
EXPOSE 8080

CMD ["node", "index.js"]
