import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { buildSystemPrompt, buildTurnPrompt, emptyUsage } from "@howdy/core";
import type { Usage } from "@howdy/core";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { recordSpend, searchMessages, spendToday } from "../db/index.js";
import type { EventBus } from "../events.js";
import type { BotStore } from "../bots/store.js";
import type { TurnQueue } from "../orchestrator/queue.js";
import { runTurn } from "../agent/run.js";

export type AppDeps = {
  readonly config: Config;
  readonly db: Db;
  readonly bus: EventBus;
  readonly bots: BotStore;
  readonly queue: TurnQueue;
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
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    if (config.sharedSecret === null) return next();
    if (c.req.path === "/api/health") return next();
    const provided = c.req.header("x-howdy-secret");
    if (provided !== config.sharedSecret) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  app.get("/api/health", (c) =>
    c.json({ ok: true, queueDepth: queue.depth(), spend: spendToday(db) }),
  );

  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      const lastId = Number(c.req.header("last-event-id") ?? c.req.query("since") ?? 0);
      let open = true;
      const pending: string[] = [];

      const off = bus.subscribe((envelope) => {
        pending.push(JSON.stringify(envelope));
      }, Number.isFinite(lastId) ? lastId : 0);

      stream.onAbort(() => {
        open = false;
        off();
      });

      while (open) {
        const next = pending.shift();
        if (next === undefined) {
          await stream.writeSSE({ event: "ping", data: "" });
          await stream.sleep(1000);
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

  app.get("/api/rooms/:id/messages", (c) => {
    const roomId = c.req.param("id");
    ensureRoom(db, roomId, roomId);
    return c.json(listMessages(db, roomId));
  });

  app.get("/api/search", (c) => c.json(searchMessages(db, c.req.query("q") ?? "")));

  app.post("/api/rooms/:id/messages", async (c) => {
    const roomId = c.req.param("id");
    const body = (await c.req.json()) as { text?: string; botId?: string };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text === "") return c.json({ error: "text is required" }, 400);

    const bot = typeof body.botId === "string" ? bots.get(body.botId) : null;
    if (bot === null) return c.json({ error: "botId must name an existing bot" }, 400);

    ensureRoom(db, roomId, roomId);

    const spend = spendToday(db);
    if (spend.tokens >= config.dailyTokenCeiling) {
      return c.json(
        { error: "daily token ceiling reached", spend, ceiling: config.dailyTokenCeiling },
        429,
      );
    }

    const history = listMessages(db, roomId);
    const turnIndex = history.length;
    const human = insertMessage(db, roomId, "human", null, text, turnIndex);
    bus.publish({ kind: "message", roomId, message: human });

    const system = buildSystemPrompt(bot, bots.personality(bot), bots.memory(bot), {
      roomName: roomId,
      goal: null,
      participants: [],
      isParty: false,
    });

    const prompt = buildTurnPrompt(
      [...history, human].map((m) => ({
        id: m.id as never,
        roomId: m.roomId as never,
        speaker:
          m.speakerKind === "human"
            ? ({ kind: "human" } as const)
            : m.speakerKind === "system"
              ? ({ kind: "system" } as const)
              : ({ kind: "bot", botId: (m.botId ?? "") as never } as const),
        content: m.content,
        turnIndex: m.turnIndex,
        toolCallCount: m.toolCallCount,
        usage: emptyUsage,
        createdAt: m.createdAt,
      })),
      (id) => bots.get(id)?.name ?? "Bot",
    );

    queue
      .submit({
        key: `${roomId}:${bot.id}:${turnIndex}`,
        run: async (signal) => {
          bus.publish({ kind: "turnStarted", roomId, botId: String(bot.id) });
          return runTurn({
            prompt,
            systemPrompt: system.text,
            cwd: bot.workspacePath,
            model: bot.model,
            allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
            maxTurns: 12,
            signal,
            onText: (chunk) =>
              bus.publish({ kind: "chunk", roomId, botId: String(bot.id), text: chunk }),
            onToolUse: (tool) =>
              bus.publish({ kind: "toolUse", roomId, botId: String(bot.id), tool, summary: tool }),
          });
        },
      })
      .then((outcome) => {
        const stored = insertMessage(
          db, roomId, "bot", String(bot.id), outcome.text, turnIndex + 1,
          outcome.toolCalls.length, outcome.usage, outcome.costUsd,
        );
        recordSpend(
          db,
          outcome.usage.inputTokens + outcome.usage.outputTokens,
          outcome.costUsd,
        );
        bus.publish({ kind: "message", roomId, message: stored });
        bus.publish({
          kind: "turnFinished",
          roomId,
          botId: String(bot.id),
          usage: outcome.usage,
          costUsd: outcome.costUsd,
        });
        bus.publish({
          kind: "spend",
          tokensToday: spendToday(db).tokens,
          ceiling: config.dailyTokenCeiling,
        });
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        bus.publish({ kind: "announce", roomId, text: `Turn failed: ${detail}` });
      });

    return c.json({ ok: true, message: human }, 202);
  });

  app.post("/api/rooms/:id/halt", (c) => {
    const roomId = c.req.param("id");
    const stopped = queue.abortAll();
    bus.publish({ kind: "halted", roomId, reason: { kind: "manual" } });
    return c.json({ ok: true, stopped });
  });

  app.post("/api/panic", (c) => {
    const stopped = queue.abortAll();
    bus.publish({ kind: "announce", roomId: "*", text: "Panic: everything halted." });
    return c.json({ ok: true, stopped });
  });

  return app;
};
