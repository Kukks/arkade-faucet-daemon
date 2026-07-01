import { loadConfig } from "./config.js";
import { initWallet, dispense, onboard, shouldReplenish, createReplenisher } from "./arkade.js";
import { requestOnchain } from "./faucet.js";
import { startServer } from "./server.js";

const config = loadConfig();
const wallet = await initWallet(config);
const log = (m) => console.log(`[arkade-faucet-daemon] ${m}`);
log(`wallet ready: ${await wallet.getAddress()}`);
if (config.internalToken) log("shared-secret gate ENABLED on POST /send");

startServer({
  wallet,
  config,
  dispense,
  getAvailable: async () => (await wallet.getBalance()).available,
});

if (config.faucetApi && config.faucetToken) {
  const replenisher = createReplenisher({
    wallet,
    config,
    shouldReplenish,
    requestOnchain: (args) => requestOnchain(args),
    onboard,
    getBoardingAddress: () => wallet.getBoardingAddress(),
    log,
  });
  setInterval(() => replenisher.tick(), config.replenishIntervalMs);
  replenisher.tick();
  log(`auto-replenish enabled: interval=${config.replenishIntervalMs}ms, min=${config.minBalance}, top-up=${config.replenishAmount}`);
} else {
  log("auto-replenish disabled (FAUCET_API and FAUCET_API_TOKEN not both set)");
}
