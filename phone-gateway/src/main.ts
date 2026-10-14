// Entry point: tsx src/main.ts (config from GATEWAY_CONFIG, default ./gateway.json).
//
// Stopping (SIGTERM from systemd/Docker/Kubernetes, or Ctrl-C) drains first:
// new calls get a busy signal while calls in progress finish, for up to
// shutdown.drainSeconds. A second signal stops immediately.

import { startApi } from "./api.js";
import { loadConfig } from "./config.js";
import { Gateway } from "./gateway.js";

const config = await loadConfig(process.env.GATEWAY_CONFIG ?? "gateway.json");
const gateway = new Gateway(config);
await gateway.start();
const api = startApi(gateway, config.port);
console.log(`Phone gateway API on http://localhost:${config.port}`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) {
      console.log(`${signal} again: stopping now, without waiting for calls`);
      process.exit(1);
    }
    stopping = true;
    console.log(`${signal}: shutting down gracefully (send it again to stop immediately)`);
    void gateway.drain().then(() => {
      api.close();
      gateway.stop();
      process.exit(0);
    });
  });
}
