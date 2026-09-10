import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { openDb } from "./db/index.js";
import { createEventBus } from "./events.js";
import type { EventBus } from "./events.js";
import { createBotStore } from "./bots/store.js";
import { createTurnQueue } from "./orchestrator/queue.js";
import { createApp } from "./http/app.js";
import type { RunTurn } from "./http/app.js";
import type { Judge } from "./agent/judge.js";

export type StartOptions = {
  readonly config?: Partial<Config>;
  readonly runTurn?: RunTurn;
  readonly judge?: Judge;
};

export type RunningServer = {
  readonly url: string;
  readonly port: number;
  readonly config: Config;
  readonly bus: EventBus;
  readonly stop: () => Promise<void>;
};

export const startServer = async (options: StartOptions = {}): Promise<RunningServer> => {
  const config: Config = { ...loadConfig(), ...options.config };
  mkdirSync(config.botsDir, { recursive: true });
  mkdirSync(config.workspacesDir, { recursive: true });

  const db = openDb(config.dbPath);
  const bus = createEventBus();
  const bots = createBotStore(db, config);
  const queue = createTurnQueue({
    timeoutMs: config.turnTimeoutMs,
    onDepthChange: (depth) => bus.publish({ kind: "queueDepth", depth }),
  });

  const disposers: (() => void)[] = [];
  const app = createApp({
    config,
    db,
    bus,
    bots,
    queue,
    onShutdown: (dispose) => disposers.push(dispose),
    ...(options.runTurn === undefined ? {} : { runTurn: options.runTurn }),
    ...(options.judge === undefined ? {} : { judge: options.judge }),
  });

  if (config.webDist !== null) app.use("/*", serveStatic({ root: config.webDist }));

  const server = await new Promise<ReturnType<typeof serve>>((ready) => {
    const s = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () =>
      ready(s),
    );
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    config,
    bus,
    stop: async () => {
      for (const dispose of disposers) dispose();
      queue.abortAll();
      await queue.drain().catch(() => undefined);
      bus.publish({ kind: "shutdown" });
      const node = server as unknown as { closeAllConnections?: () => void };
      node.closeAllConnections?.();
      await Promise.race([
        new Promise<void>((done) => server.close(() => done())),
        new Promise<void>((done) => setTimeout(done, 2000).unref()),
      ]);
      db.close();
    },
  };
};
