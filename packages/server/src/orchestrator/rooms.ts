import { randomUUID } from "node:crypto";
import {
  botId as toBotId,
  buildSystemPrompt,
  buildTurnPrompt,
  createBudget,
  defaultCeilings,
  emptyUsage,
  extractMentions,
  roomId as toRoomId,
  seedFrom,
  step,
} from "@howdy/core";
import type {
  BotId,
  Ceilings,
  Effect,
  HaltReason,
  ParticipantState,
  RoomEvent,
  RoomMessage,
  RoomState,
  Usage,
} from "@howdy/core";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { recordSpend, spendToday, spendWindow } from "../db/index.js";
import type { EventBus } from "../events.js";
import type { BotStore } from "../bots/store.js";
import type { TurnQueue } from "./queue.js";
import type { PermissionBroker } from "../agent/permissions.js";
import type { RunTurn } from "../http/app.js";
import { createMemoryServer } from "../agent/memory.js";
import { createJudge } from "../agent/judge.js";
import { createRoomServer } from "../agent/roomtools.js";
import type { Judge } from "../agent/judge.js";

export type RoomRecord = {
  readonly id: string;
  readonly name: string;
  readonly kind: "solo" | "party";
  readonly goal: string | null;
  readonly stepMode: boolean;
  readonly ceilings: Ceilings;
  readonly participants: readonly string[];
  readonly status: RoomState["status"];
  readonly budget: RoomState["budget"];
};

export type CreateRoomInput = {
  readonly id?: string;
  readonly name: string;
  readonly kind?: "solo" | "party";
  readonly goal?: string | null;
  readonly stepMode?: boolean;
  readonly ceilings?: Partial<Ceilings>;
  readonly participants?: readonly { botId: string; noisiness?: number; cooldownTurns?: number }[];
  readonly seed?: number;
};

export type Orchestrator = {
  readonly create: (input: CreateRoomInput) => RoomRecord;
  readonly list: () => readonly RoomRecord[];
  readonly get: (id: string) => RoomRecord | null;
  readonly ensure: (id: string, botId?: string) => RoomRecord;
  readonly post: (id: string, text: string, botId?: string) => void;
  readonly halt: (id: string) => void;
  readonly resume: (id: string) => void;
  readonly advance: (id: string) => void;
  readonly panic: () => number;
  readonly remove: (id: string) => boolean;
};

type Deps = {
  readonly config: Config;
  readonly db: Db;
  readonly bus: EventBus;
  readonly bots: BotStore;
  readonly queue: TurnQueue;
  readonly broker: PermissionBroker;
  readonly runTurn: RunTurn;
  readonly judge?: Judge;
};

const rowToCeilings = (raw: string): Ceilings => {
  try {
    return { ...defaultCeilings, ...(JSON.parse(raw) as Partial<Ceilings>) };
  } catch {
    return defaultCeilings;
  }
};

export const createOrchestrator = (deps: Deps): Orchestrator => {
  const { config, db, bus, bots, queue, broker, runTurn } = deps;
  const judge = deps.judge ?? createJudge();
  const states = new Map<string, RoomState>();
  const judging = new Set<string>();

  const loadState = (id: string): RoomState | null => {
    const row = db.prepare("SELECT * FROM rooms WHERE id = ?").get(id) as
      | Record<string, string | number>
      | undefined;
    if (row === undefined) return null;

    const participants = (
      db.prepare("SELECT * FROM room_participants WHERE room_id = ? ORDER BY rowid").all(id) as {
        bot_id: string; noisiness: number; base_noisiness: number;
        cooldown_turns: number; last_spoke_at_turn: number | null;
      }[]
    ).map<ParticipantState>((p) => ({
      botId: toBotId(p.bot_id),
      noisiness: p.noisiness,
      baseNoisiness: p.base_noisiness,
      cooldownTurns: p.cooldown_turns,
      lastSpokeAtTurn: p.last_spoke_at_turn,
    }));

    const ceilings = rowToCeilings(String(row["ceilings"] ?? "{}"));
    const startedAt = Number(row["started_at"] ?? Date.now());

    return {
      roomId: toRoomId(id),
      participants,
      status: JSON.parse(String(row["status"] ?? '{"kind":"idle"}')) as RoomState["status"],
      budget: {
        ...createBudget(ceilings, startedAt),
        turnsUsed: Number(row["turns_used"] ?? 0),
        tokensUsed: Number(row["tokens_used"] ?? 0),
        now: Date.now(),
      },
      turnIndex: Number(row["turn_index"] ?? 0),
      recent: recentMessages(id),
      pendingMentions: (JSON.parse(String(row["pending_mentions"] ?? "[]")) as string[]).map(toBotId),
      stepMode: Number(row["step_mode"] ?? 0) === 1,
      decayCount: Number(row["decay_count"] ?? 0),
      rngState: Number(row["rng_seed"] ?? seedFrom(id)),
    };
  };

  const recentMessages = (roomId: string): readonly RoomMessage[] =>
    (
      db
        .prepare(
          `SELECT id, room_id AS roomId, speaker_kind AS speakerKind, bot_id AS botId,
                  content, turn_index AS turnIndex, tool_call_count AS toolCallCount,
                  created_at AS createdAt
           FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT 50`,
        )
        .all(roomId) as {
        id: string; roomId: string; speakerKind: string; botId: string | null;
        content: string; turnIndex: number; toolCallCount: number; createdAt: number;
      }[]
    )
      .reverse()
      .map((m) => ({
        id: m.id as never,
        roomId: m.roomId as never,
        speaker:
          m.speakerKind === "human"
            ? ({ kind: "human" } as const)
            : m.speakerKind === "system"
              ? ({ kind: "system" } as const)
              : ({ kind: "bot", botId: toBotId(m.botId ?? "") } as const),
        content: m.content,
        turnIndex: m.turnIndex,
        toolCallCount: m.toolCallCount,
        usage: emptyUsage,
        createdAt: m.createdAt,
      }));

  const stateOf = (id: string): RoomState | null => {
    const cached = states.get(id);
    if (cached !== undefined) return cached;
    const loaded = loadState(id);
    if (loaded !== null) states.set(id, loaded);
    return loaded;
  };

  const persist = (state: RoomState): void => {
    db.prepare(
      `UPDATE rooms SET status = ?, turn_index = ?, tokens_used = ?, turns_used = ?,
       started_at = ?, decay_count = ?, pending_mentions = ?, rng_seed = ? WHERE id = ?`,
    ).run(
      JSON.stringify(state.status), state.turnIndex, state.budget.tokensUsed,
      state.budget.turnsUsed, state.budget.startedAt, state.decayCount,
      JSON.stringify(state.pendingMentions.map(String)), state.rngState,
      String(state.roomId),
    );
    const update = db.prepare(
      "UPDATE room_participants SET noisiness = ?, last_spoke_at_turn = ? WHERE room_id = ? AND bot_id = ?",
    );
    for (const p of state.participants) {
      update.run(p.noisiness, p.lastSpokeAtTurn, String(state.roomId), String(p.botId));
    }
  };

  const saveMessage = (
    roomId: string,
    speakerKind: "human" | "bot" | "system",
    botIdValue: string | null,
    content: string,
    turnIndex: number,
    toolCallCount = 0,
    usage: Usage = emptyUsage,
    costUsd = 0,
  ): RoomMessage => {
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
    const message: RoomMessage = {
      id: id as never,
      roomId: roomId as never,
      speaker:
        speakerKind === "human"
          ? { kind: "human" }
          : speakerKind === "system"
            ? { kind: "system" }
            : { kind: "bot", botId: toBotId(botIdValue ?? "") },
      content, turnIndex, toolCallCount, usage, createdAt,
    };
    bus.publish({
      kind: "message",
      roomId,
      message: { id, roomId, speakerKind, botId: botIdValue, content, turnIndex, toolCallCount, createdAt },
    });
    return message;
  };

  const governorBlock = (): string | null => {
    const day = spendToday(db).tokens;
    if (day >= config.dailyTokenCeiling) {
      return `daily ceiling reached (${day.toLocaleString()}/${config.dailyTokenCeiling.toLocaleString()} tokens)`;
    }
    const week = spendWindow(db, 7).tokens;
    if (week >= config.weeklyTokenCeiling) {
      return `weekly ceiling reached (${week.toLocaleString()}/${config.weeklyTokenCeiling.toLocaleString()} tokens)`;
    }
    return null;
  };

  const dispatch = (roomId: string, event: RoomEvent): void => {
    const current = stateOf(roomId);
    if (current === null) return;
    const [next, effects] = step(current, event);
    states.set(roomId, next);
    persist(next);
    bus.publish({
      kind: "roomStatus",
      roomId,
      status: next.status,
      turnsUsed: next.budget.turnsUsed,
      tokensUsed: next.budget.tokensUsed,
      ceilings: {
        maxTurns: next.budget.ceilings.maxTurns,
        maxTokens: next.budget.ceilings.maxTokens,
      },
    });
    for (const effect of effects) execute(roomId, effect);
  };

  const execute = (roomId: string, effect: Effect): void => {
    switch (effect.kind) {
      case "announce":
        saveMessage(roomId, "system", null, effect.text, stateOf(roomId)?.turnIndex ?? 0);
        bus.publish({ kind: "announce", roomId, text: effect.text });
        return;

      case "halted":
        bus.publish({ kind: "halted", roomId, reason: effect.reason });
        broker.cancelAll();
        return;

      case "abortTurn":
        queue.abort(`${roomId}:${String(effect.speaker)}`);
        return;

      case "runTurn":
        launch(roomId, effect.speaker);
        return;
    }
  };

  const stop = (roomId: string, reason: HaltReason, text: string): void => {
    const current = stateOf(roomId);
    if (current === null) return;
    states.set(roomId, { ...current, status: { kind: "halted", reason } });
    persist({ ...current, status: { kind: "halted", reason } });
    saveMessage(roomId, "system", null, text, current.turnIndex);
    bus.publish({ kind: "announce", roomId, text });
    bus.publish({ kind: "halted", roomId, reason });
  };

  const launch = (roomId: string, speaker: BotId): void => {
    const blocked = governorBlock();
    if (blocked !== null) {
      stop(roomId, { kind: "budget", breach: { kind: "tokens", used: 0, ceiling: 0 } }, `Stopped: ${blocked}`);
      return;
    }

    const bot = bots.get(String(speaker));
    if (bot === null) {
      dispatch(roomId, { kind: "turnFailed", speaker, detail: "bot no longer exists" });
      return;
    }

    const room = get(roomId);
    const cast = (room?.participants ?? [])
      .filter((id) => id !== String(speaker))
      .map((id) => bots.get(id))
      .filter((b): b is NonNullable<typeof b> => b !== null);
    const others = cast.map((b) => b.name);

    const system = buildSystemPrompt(bot, bots.personality(bot), bots.memory(bot), {
      roomName: room?.name ?? roomId,
      goal: room?.goal ?? null,
      participants: others,
      isParty: (room?.participants.length ?? 1) > 1,
    });

    const prompt = buildTurnPrompt(recentMessages(roomId), (id) => bots.get(id)?.name ?? "Bot");

    bus.publish({ kind: "turnStarted", roomId, botId: String(speaker) });

    const turnId = randomUUID();
    const startedAt = Date.now();
    db.prepare(
      `INSERT INTO turns (id, room_id, bot_id, status, started_at) VALUES (?,?,?,'running',?)`,
    ).run(turnId, roomId, String(speaker), startedAt);

    const finish = (
      status: "ok" | "failed",
      detail: string | null,
      sessionId: string | null,
      messageId: string | null = null,
    ) => {
      db.prepare(
        `UPDATE turns SET status = ?, detail = ?, session_id = ?, message_id = ?,
         duration_ms = ?, finished_at = ? WHERE id = ?`,
      ).run(status, detail, sessionId, messageId, Date.now() - startedAt, Date.now(), turnId);
    };

    queue
      .submit({
        key: `${roomId}:${String(speaker)}`,
        run: (signal) =>
          runTurn({
            prompt,
            systemPrompt: system.text,
            cwd: bot.workspacePath,
            model: bot.model,
            allowedTools: [
              "Bash", "Read", "Write", "Edit", "Glob", "Grep",
              "mcp__howdy-memory__remember", "mcp__howdy-memory__recall",
              ...(cast.length > 0 ? ["mcp__howdy-room__handoff"] : []),
            ],
            maxTurns: 12,
            signal,
            canUseTool: broker.gateFor(bot, roomId),
            mcpServers: {
              "howdy-memory": createMemoryServer(bot, roomId, { db, bus, bots }),
              ...(cast.length === 0
                ? {}
                : {
                    "howdy-room": createRoomServer({
                      roomId,
                      speaker: bot,
                      others: cast,
                      handoff: (toBotId, reason) => {
                        const before = stateOf(roomId)?.pendingMentions.length ?? 0;
                        dispatch(roomId, { kind: "handoff", to: toBotId as never, reason });
                        const after = stateOf(roomId)?.pendingMentions.length ?? 0;
                        return after > before;
                      },
                    }),
                  }),
            },
            onText: (text) => bus.publish({ kind: "chunk", roomId, botId: String(speaker), text }),
            onToolUse: (tool) =>
              bus.publish({ kind: "toolUse", roomId, botId: String(speaker), tool, summary: tool }),
          }),
      })
      .then((outcome) => {
        const current = stateOf(roomId);
        const message = saveMessage(
          roomId, "bot", String(speaker), outcome.text,
          (current?.turnIndex ?? 0) + 1, outcome.toolCalls.length, outcome.usage, outcome.costUsd,
        );
        finish(
          outcome.isError ? "failed" : "ok",
          outcome.detail,
          outcome.sessionId,
          String(message.id),
        );
        recordSpend(db, outcome.usage.inputTokens + outcome.usage.outputTokens, outcome.costUsd);
        bus.publish({
          kind: "turnFinished", roomId, botId: String(speaker),
          usage: outcome.usage, costUsd: outcome.costUsd,
        });
        bus.publish({
          kind: "spend",
          tokensToday: spendToday(db).tokens,
          ceiling: config.dailyTokenCeiling,
        });
        dispatch(roomId, { kind: "turnCompleted", message });
        void assess(roomId);
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        finish("failed", detail, null);
        dispatch(roomId, { kind: "turnFailed", speaker, detail });
      });
  };

  const assess = async (roomId: string): Promise<void> => {
    const room = get(roomId);
    const goal = room?.goal ?? null;
    if (goal === null || goal.trim() === "") return;

    const state = stateOf(roomId);
    if (state === null || state.status.kind === "halted") return;
    if (state.budget.turnsUsed % config.goalCheckEvery !== 0) return;
    if (judging.has(roomId)) return;

    judging.add(roomId);
    try {
      const verdict = await judge(goal, recentMessages(roomId), new AbortController().signal);
      const current = stateOf(roomId);
      if (current === null || current.status.kind === "halted") return;
      if (verdict.kind === "done") {
        saveMessage(roomId, "system", null, `Goal reached: ${verdict.summary}`, current.turnIndex);
        dispatch(roomId, { kind: "goalReached", summary: verdict.summary });
      } else if (verdict.kind === "stuck") {
        saveMessage(roomId, "system", null, `Stuck: ${verdict.summary}`, current.turnIndex);
        dispatch(roomId, { kind: "goalReached", summary: `stuck — ${verdict.summary}` });
      }
    } catch {
      return;
    } finally {
      judging.delete(roomId);
    }
  };

  const get = (id: string): RoomRecord | null => {
    const row = db.prepare("SELECT * FROM rooms WHERE id = ?").get(id) as
      | Record<string, string | number>
      | undefined;
    if (row === undefined) return null;
    const state = stateOf(id);
    return {
      id,
      name: String(row["name"] ?? id),
      kind: (row["kind"] === "party" ? "party" : "solo"),
      goal: row["goal"] === null || row["goal"] === undefined ? null : String(row["goal"]),
      stepMode: Number(row["step_mode"] ?? 0) === 1,
      ceilings: rowToCeilings(String(row["ceilings"] ?? "{}")),
      participants: (
        db.prepare("SELECT bot_id AS botId FROM room_participants WHERE room_id = ? ORDER BY rowid").all(id) as
          { botId: string }[]
      ).map((p) => p.botId),
      status: state?.status ?? { kind: "idle" },
      budget: state?.budget ?? createBudget(defaultCeilings, Date.now()),
    };
  };

  const create = (input: CreateRoomInput): RoomRecord => {
    const id = input.id ?? randomUUID();
    const ceilings = { ...defaultCeilings, ...input.ceilings };
    const now = Date.now();
    db.prepare(
      `INSERT INTO rooms (id, name, kind, goal, status, ceilings, step_mode, rng_seed,
        turn_index, tokens_used, turns_used, started_at, created_at, decay_count, pending_mentions)
       VALUES (?,?,?,?,?,?,?,?,0,0,0,?,?,0,'[]')
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind,
         goal = excluded.goal, ceilings = excluded.ceilings, step_mode = excluded.step_mode`,
    ).run(
      id, input.name, input.kind ?? "solo", input.goal ?? null,
      JSON.stringify({ kind: "idle" }), JSON.stringify(ceilings),
      input.stepMode === true ? 1 : 0, input.seed ?? seedFrom(id), now, now,
    );

    db.prepare("DELETE FROM room_participants WHERE room_id = ?").run(id);
    const add = db.prepare(
      `INSERT INTO room_participants (room_id, bot_id, noisiness, base_noisiness, cooldown_turns, last_spoke_at_turn)
       VALUES (?,?,?,?,?,NULL)`,
    );
    for (const p of input.participants ?? []) {
      const bot = bots.get(p.botId);
      if (bot === null) continue;
      const noisiness = p.noisiness ?? bot.noisiness;
      add.run(id, p.botId, noisiness, noisiness, p.cooldownTurns ?? bot.cooldownTurns);
    }
    states.delete(id);
    return get(id) as RoomRecord;
  };

  const ensure = (id: string, botIdValue?: string): RoomRecord => {
    const existing = get(id);
    if (existing !== null) {
      if (botIdValue !== undefined && !existing.participants.includes(botIdValue)) {
        const bot = bots.get(botIdValue);
        if (bot !== null) {
          db.prepare(
            `INSERT INTO room_participants (room_id, bot_id, noisiness, base_noisiness, cooldown_turns, last_spoke_at_turn)
             VALUES (?,?,?,?,?,NULL) ON CONFLICT(room_id, bot_id) DO NOTHING`,
          ).run(id, botIdValue, bot.noisiness, bot.noisiness, bot.cooldownTurns);
          states.delete(id);
        }
      }
      return get(id) as RoomRecord;
    }
    return create({
      id,
      name: id,
      kind: "solo",
      ceilings: { maxTurns: 200, maxWallClockMs: 60 * 60 * 1000 },
      participants: botIdValue === undefined ? [] : [{ botId: botIdValue }],
    });
  };

  return {
    create,
    list: () =>
      (db.prepare("SELECT id FROM rooms ORDER BY created_at DESC").all() as { id: string }[])
        .map((r) => get(r.id))
        .filter((r): r is RoomRecord => r !== null),
    get,
    ensure,
    post: (id, text, botIdValue) => {
      const room = ensure(id, botIdValue);
      const state = stateOf(id);
      const slugs = new Map(
        room.participants
          .map((p) => bots.get(p))
          .filter((b): b is NonNullable<typeof b> => b !== null)
          .map((b) => [b.slug, String(b.id)] as const),
      );
      const mentions = botIdValue !== undefined
        ? [toBotId(botIdValue)]
        : extractMentions(text, slugs).map(toBotId);

      const message = saveMessage(id, "human", null, text, (state?.turnIndex ?? 0) + 1);
      dispatch(id, { kind: "humanMessage", message, mentions });
    },
    halt: (id) => dispatch(id, { kind: "haltRequested" }),
    resume: (id) => dispatch(id, { kind: "resumeRequested" }),
    advance: (id) => dispatch(id, { kind: "stepRequested" }),
    panic: () => {
      broker.cancelAll();
      const stopped = queue.abortAll();
      for (const id of states.keys()) dispatch(id, { kind: "haltRequested" });
      bus.publish({ kind: "announce", roomId: "*", text: "Panic: everything halted." });
      return stopped;
    },
    remove: (id) => {
      states.delete(id);
      return db.prepare("DELETE FROM rooms WHERE id = ?").run(id).changes > 0;
    },
  };
};
