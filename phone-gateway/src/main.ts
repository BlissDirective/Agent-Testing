// Entry point: tsx src/main.ts (config from GATEWAY_CONFIG, default ./gateway.json).

import { startApi } from "./api.js";
import { loadConfig } from "./config.js";
import { Gateway } from "./gateway.js";

const config = await loadConfig(process.env.GATEWAY_CONFIG ?? "gateway.json");
const gateway = new Gateway(config);
await gateway.start();
startApi(gateway, config.port);
console.log(`Phone gateway API on http://localhost:${config.port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    gateway.stop();
    process.exit(0);
  });
}
