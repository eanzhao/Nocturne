import pino from "pino";
import { app } from "./app";
import { config } from "./config";

const log = pino({ level: config.NODE_ENV === "production" ? "info" : "debug" });

const server = Bun.serve({
  port: config.PORT,
  idleTimeout: 60,
  fetch: app.fetch,
});

log.info(
  {
    port: server.port,
    base_url: config.BASE_URL,
    env: config.NODE_ENV,
  },
  "nocturne started",
);

const shutdown = (signal: string) => {
  log.info({ signal }, "shutting down");
  server.stop(false);
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
