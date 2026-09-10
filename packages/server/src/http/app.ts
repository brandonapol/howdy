import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { buildSystemPrompt, buildTurnPrompt, emptyUsage } from "@howdy/core";
import type { Usage } from "@howdy/core";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { searchMessages, spendToday, spendWindow } from "../db/index.js";
import type { EventBus } from "../events.js";
import type { BotStore } from "../bots/store.js";
import type { TurnQueue } from "../orchestrator/queue.js";
import { runTurn as defaultRunTurn } from "../agent/run.js";
import type { RunTurnInput } from "../agent/run.js";
import type { TurnOutcome } from "../agent/outcome.js";
import { createPermissionBroker } from "../agent/permissions.js";
import type { PermissionBroker } from "../agent/permissions.js";
import { createOrchestrator } from "../orchestrator/rooms.js";
import { createRoutines } from "../orchestrator/routines.js";
import type { Judge } from "../agent/judge.js";

export type RunTurn = (input: RunTurnInput) => Promise<TurnOutcome>;

export type AppDeps = {
  readonly config: Config;
  readonly db: Db;
  readonly bus: EventBus;
  readonly bots: BotStore;
  readonly queue: TurnQueue;
  readonly runTurn?: RunTurn;
  readonly broker?: PermissionBroker;
  readonly judge?: Judge;
  readonly onShutdown?: (dispose: () => void) => void;
};

type MessageRow = {
  id: string; roomId: string; speakerKind: string; botId: string | null;
  content: string; turnIndex: number; toolCallCount: number; createdAt: number;
};

const ensureRoom = (db: Db, id: string, name: string): void => {
  db.prepare(
    `INSERT INTO rooms (id, name, status, ceilings, rng_seed, started_at, created_at)
     VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
  ).run(id, name, JSON.stringify({ kind: "idle" }), "{}", 1, Date.now(), Date.now());
};

const insertMessage = (
  db: Db,
  roomId: string,
  speakerKind: string,
  botIdValue: string | null,
  content: string,
  turnIndex: number,
  toolCallCount = 0,
  usage: Usage = emptyUsage,
  costUsd = 0,
): MessageRow => {
  const id = randomUUID();
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO messages (id, room_id, speaker_kind, bot_id, content, turn_index,
      tool_call_count, input_tokens, output_tokens, cache_read_tokens,
      cache_creation_tokens, cost_usd, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, roomId, speakerKind, botIdValue, content, turnIndex, toolCallCount,
    usage.inputTokens, usage.outputTokens, usage.cacheReadTokens,
    usage.cacheCreationTokens, costUsd, createdAt,
  );
  return { id, roomId, speakerKind, botId: botIdValue, content, turnIndex, toolCallCount, createdAt };
};

const listMessages = (db: Db, roomId: string, limit = 200): readonly MessageRow[] =>
  db
    .prepare(
      `SELECT id, room_id AS roomId, speaker_kind AS speakerKind, bot_id AS botId,
              content, turn_index AS turnIndex, tool_call_count AS toolCallCount,
              created_at AS createdAt
       FROM messages WHERE room_id = ? ORDER BY created_at LIMIT ?`,
    )
    .all(roomId, limit) as never;

export const createApp = (deps: AppDeps): Hono => {
  const { config, db, bus, bots, queue } = deps;
  const runTurn = deps.runTurn ?? defaultRunTurn;
  const broker =
    deps.broker ?? createPermissionBroker(db, bus, config.permissionTimeoutMs);
  const orchestrator = createOrchestrator({
    config, db, bus, bots, queue, broker, runTurn,
    ...(deps.judge === undefined ? {} : { judge: deps.judge }),
  });
  const routines = createRoutines({ config, db, bus, rooms: orchestrator });
  routines.start();
  deps.onShutdown?.(() => routines.stop());
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    if (config.sharedSecret === null) return next();
    if (c.req.path === "/api/health") return next();
    const provided = c.req.header("x-howdy-secret") ?? c.req.query("secret");
    if (provided !== config.sharedSecret) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      queueDepth: queue.depth(),
      spend: spendToday(db),
      tokenCeiling: config.dailyTokenCeiling,
    }),
  );

  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      const lastId = Number(c.req.header("last-event-id") ?? c.req.query("since") ?? 0);
      let open = true;
      const pending: string[] = [];

      const off = bus.subscribe((envelope) => {
        if (envelope.event.kind === "shutdown") {
          open = false;
          return;
        }
        pending.push(JSON.stringify(envelope));
      }, Number.isFinite(lastId) ? lastId : 0);

      stream.onAbort(() => {
        open = false;
        off();
      });

      while (open) {
        const next = pending.shift();
        if (next === undefined) {
          try {
            await stream.writeSSE({ event: "ping", data: "" });
          } catch {
            break;
          }
          await stream.sleep(250);
          continue;
        }
        const envelope = JSON.parse(next) as { id: number };
        await stream.writeSSE({ id: String(envelope.id), event: "howdy", data: next });
      }
    }),
  );

  app.get("/api/bots", (c) => c.json(bots.list()));

  app.post("/api/bots", async (c) => {
    const body = (await c.req.json()) as { name?: string };
    if (typeof body.name !== "string" || body.name.trim() === "") {
      return c.json({ error: "name is required" }, 400);
    }
    const bot = bots.create(body as { name: string });
    return c.json(bot, 201);
  });

  app.get("/api/bots/:id", (c) => {
    const bot = bots.get(c.req.param("id"));
    if (bot === null) return c.json({ error: "not found" }, 404);
    return c.json({
      ...bot,
      personality: bots.personality(bot),
      memory: bots.memory(bot),
    });
  });

  app.patch("/api/bots/:id", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const bot = bots.update(c.req.param("id"), body);
    if (bot === null) return c.json({ error: "not found" }, 404);
    if (typeof body["personality"] === "string") {
      bots.writePersonality(bot, body["personality"]);
    }
    return c.json(bot);
  });

  app.delete("/api/bots/:id", (c) =>
    bots.remove(c.req.param("id"))
      ? c.json({ ok: true })
      : c.json({ error: "not found" }, 404),
  );

  app.get("/api/rooms", (c) => c.json(orchestrator.list()));

  app.post("/api/rooms", async (c) => {
    const body = (await c.req.json()) as {
      name?: string;
      kind?: "solo" | "party";
      goal?: string | null;
      stepMode?: boolean;
      ceilings?: Record<string, number>;
      participants?: { botId: string; noisiness?: number; cooldownTurns?: number }[];
      seed?: number;
    };
    if (typeof body.name !== "string" || body.name.trim() === "") {
      return c.json({ error: "name is required" }, 400);
    }
    const room = orchestrator.create({
      name: body.name.trim(),
      kind: body.kind ?? "party",
      goal: body.goal ?? null,
      stepMode: body.stepMode === true,
      ...(body.ceilings === undefined ? {} : { ceilings: body.ceilings }),
      participants: body.participants ?? [],
      ...(body.seed === undefined ? {} : { seed: body.seed }),
    });
    return c.json(room, 201);
  });

  app.get("/api/rooms/:id", (c) => {
    const room = orchestrator.get(c.req.param("id"));
    return room === null ? c.json({ error: "not found" }, 404) : c.json(room);
  });

  app.delete("/api/rooms/:id", (c) =>
    orchestrator.remove(c.req.param("id"))
      ? c.json({ ok: true })
      : c.json({ error: "not found" }, 404),
  );

  app.get("/api/rooms/:id/messages", (c) => {
    const roomId = c.req.param("id");
    orchestrator.ensure(roomId);
    return c.json(listMessages(db, roomId));
  });

  app.get("/api/search", (c) => c.json(searchMessages(db, c.req.query("q") ?? "")));

  app.get("/api/rooms/:id/timeline", (c) => {
    const roomId = c.req.param("id");
    if (orchestrator.get(roomId) === null) return c.json({ error: "no such room" }, 404);

    const turns = db
      .prepare(
        `SELECT t.id, t.bot_id AS botId, t.status, t.detail, t.duration_ms AS durationMs,
                t.started_at AS startedAt,
                m.content, m.tool_call_count AS toolCalls,
                m.input_tokens + m.output_tokens AS tokens, m.cost_usd AS costUsd
         FROM turns t
         LEFT JOIN messages m ON m.id = t.message_id
         WHERE t.room_id = ? ORDER BY t.started_at`,
      )
      .all(roomId) as Record<string, unknown>[];

    const notes = db
      .prepare(
        `SELECT id, content, created_at AS startedAt FROM messages
         WHERE room_id = ? AND speaker_kind = 'system' ORDER BY created_at`,
      )
      .all(roomId) as Record<string, unknown>[];

    const entries: Record<string, unknown>[] = [
      ...turns.map((t): Record<string, unknown> => ({ ...t, kind: "turn" })),
      ...notes.map((n): Record<string, unknown> => ({ ...n, kind: "note" })),
    ].sort((a, b) => Number(a["startedAt"] ?? 0) - Number(b["startedAt"] ?? 0));

    return c.json(entries);
  });

  app.post("/api/rooms/:id/messages", async (c) => {
    const roomId = c.req.param("id");
    const body = (await c.req.json()) as { text?: string; botId?: string };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text === "") return c.json({ error: "text is required" }, 400);

    if (body.botId !== undefined && bots.get(body.botId) === null) {
      return c.json({ error: "botId must name an existing bot" }, 400);
    }

    const spend = spendToday(db);
    if (spend.tokens >= config.dailyTokenCeiling) {
      return c.json(
        { error: "daily token ceiling reached", spend, ceiling: config.dailyTokenCeiling },
        429,
      );
    }
    const week = spendWindow(db, 7);
    if (week.tokens >= config.weeklyTokenCeiling) {
      return c.json(
        { error: "weekly token ceiling reached", spend: week, ceiling: config.weeklyTokenCeiling },
        429,
      );
    }

    const room = orchestrator.ensure(roomId, body.botId);
    if (room.participants.length === 0) {
      return c.json({ error: "this room has no bots in it" }, 400);
    }

    orchestrator.post(roomId, text, body.botId);
    return c.json({ ok: true }, 202);
  });

  app.post("/api/rooms/:id/resume", (c) => {
    orchestrator.resume(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/rooms/:id/step", (c) => {
    orchestrator.advance(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/api/routines", (c) => c.json(routines.list()));

  app.post("/api/routines", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const name = typeof body["name"] === "string" ? body["name"].trim() : "";
    const roomId = typeof body["roomId"] === "string" ? body["roomId"] : "";
    const prompt = typeof body["prompt"] === "string" ? body["prompt"].trim() : "";
    if (name === "" || prompt === "") return c.json({ error: "name and prompt are required" }, 400);
    if (orchestrator.get(roomId) === null) return c.json({ error: "no such room" }, 400);
    const schedule = body["schedule"];
    if (typeof schedule !== "object" || schedule === null) {
      return c.json({ error: "schedule is required" }, 400);
    }
    return c.json(
      routines.create({ name, roomId, prompt, schedule: schedule as never }),
      201,
    );
  });

  app.patch("/api/routines/:id", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const updated = routines.update(c.req.param("id"), body as never);
    return updated === null ? c.json({ error: "not found" }, 404) : c.json(updated);
  });

  app.delete("/api/routines/:id", (c) =>
    routines.remove(c.req.param("id"))
      ? c.json({ ok: true })
      : c.json({ error: "not found" }, 404),
  );

  app.post("/api/routines/:id/run", (c) => {
    const routine = routines.get(c.req.param("id"));
    if (routine === null) return c.json({ error: "not found" }, 404);
    const ran = routines.runNow(c.req.param("id"));
    return c.json({ ok: ran, status: routines.get(c.req.param("id"))?.lastStatus ?? null });
  });

  app.post("/api/routines/tick", (c) => c.json({ fired: routines.tick() }));

  app.get("/api/permissions", (c) => c.json(broker.pending()));

  app.post("/api/permissions/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      allowed?: boolean;
      always?: boolean;
    };
    const settled = broker.decide(
      c.req.param("id"),
      body.allowed === true,
      body.always === true,
    );
    return settled
      ? c.json({ ok: true })
      : c.json({ error: "no such pending request" }, 404);
  });

  app.post("/api/rooms/:id/halt", (c) => {
    const roomId = c.req.param("id");
    if (orchestrator.get(roomId) === null) return c.json({ error: "no such room" }, 404);
    const running = queue.depth();
    broker.cancelAll();
    orchestrator.halt(roomId);
    return c.json({ ok: true, stopped: Math.max(running, 1) });
  });

  app.post("/api/panic", (c) => c.json({ ok: true, stopped: orchestrator.panic() }));

  return app;
};
