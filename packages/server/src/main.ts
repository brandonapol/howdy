import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { createEventBus } from "./events.js";
import { createBotStore } from "./bots/store.js";
import { createTurnQueue } from "./orchestrator/queue.js";
import { createApp } from "./http/app.js";

const config = loadConfig();
mkdirSync(config.botsDir, { recursive: true });
mkdirSync(config.workspacesDir, { recursive: true });

const db = openDb(config.dbPath);
const bus = createEventBus();
const bots = createBotStore(db, config);
const queue = createTurnQueue({
  timeoutMs: config.turnTimeoutMs,
  onDepthChange: (depth) => bus.publish({ kind: "queueDepth", depth }),
});

const app = createApp({ config, db, bus, bots, queue });

if (config.webDist !== null) {
  app.use("/*", serveStatic({ root: config.webDist }));
}

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  process.stdout.write(`howdy listening on http://${config.host}:${info.port}\n`);
});

const shutdown = async () => {
  queue.abortAll();
  await queue.drain().catch(() => undefined);
  server.close();
  db.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
