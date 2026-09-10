import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { compactMemory, parseMemory, renderMemory, searchMemory } from "@howdy/core";
import type { Bot } from "@howdy/core";
import type { Db } from "../db/index.js";
import { searchMessages } from "../db/index.js";
import type { EventBus } from "../events.js";
import type { BotStore } from "../bots/store.js";

export const MEMORY_LIMIT = 200;

const text = (body: string) => ({
  content: [{ type: "text" as const, text: body }],
});

export const compactBotMemory = (
  bot: Bot,
  limit = MEMORY_LIMIT,
): { readonly kept: number; readonly dropped: number; readonly reason: string } => {
  const path = join(bot.botDir, "memory.md");
  if (!existsSync(path)) return { kept: 0, dropped: 0, reason: "none" };
  const entries = parseMemory(readFileSync(path, "utf8"));
  const result = compactMemory(entries, limit);
  if (result.reason === "none") {
    return { kept: result.kept.length, dropped: 0, reason: "none" };
  }
  const archive = join(bot.botDir, "memory.archive.md");
  const existing = existsSync(archive) ? readFileSync(archive, "utf8") : "";
  writeFileSync(archive, existing + renderMemory(result.dropped));
  writeFileSync(path, renderMemory(result.kept));
  return { kept: result.kept.length, dropped: result.dropped.length, reason: result.reason };
};

export type MemoryDeps = {
  readonly db: Db;
  readonly bus: EventBus;
  readonly bots: BotStore;
};

export const rememberFor =
  (bot: Bot, roomId: string, deps: MemoryDeps) =>
  (fact: string, tags: readonly string[] = []): string => {
    const cleaned = tags
      .map((t) => t.replace(/[^a-z0-9_-]/gi, ""))
      .filter((t) => t !== "");
    const tagged = cleaned.length === 0 ? fact : `${fact} ${cleaned.map((t) => `#${t}`).join(" ")}`;
    deps.bots.remember(bot, tagged);
    const after = compactBotMemory(bot);
    deps.bus.publish({
      kind: "remembered",
      roomId,
      botId: String(bot.id),
      fact,
      total: after.kept,
    });
    return `Remembered. You now hold ${after.kept} facts.`;
  };

export const recallFor =
  (bot: Bot, deps: MemoryDeps) =>
  (query: string): string => {
    const entries = searchMemory(parseMemory(deps.bots.memory(bot)), query);
    const transcripts = searchMessages(deps.db, query, 5);

    if (entries.length === 0 && transcripts.length === 0) {
      return `Nothing in memory about "${query}".`;
    }

    return [
      ...(entries.length === 0
        ? []
        : ["From your memory:", ...entries.map((e) => `- (${e.date}) ${e.text}`)]),
      ...(transcripts.length === 0
        ? []
        : ["", "From earlier conversations:", ...transcripts.map((m) => `- ${m.content.slice(0, 300)}`)]),
    ].join("\n");
  };

export const createMemoryServer = (
  bot: Bot,
  roomId: string,
  deps: MemoryDeps,
): McpSdkServerConfigWithInstance => {
  const remember = rememberFor(bot, roomId, deps);
  const recall = recallFor(bot, deps);

  return createSdkMcpServer({
    name: "howdy-memory",
    version: "1.0.0",
    instructions:
      "Your long-term memory. Use remember for durable facts about the user, the " +
      "infrastructure, or decisions that should outlive this conversation. Do not " +
      "record chit-chat or anything already in your personality file. Use recall " +
      "before asking the user something you may already have been told.",
    tools: [
      tool(
        "remember",
        "Store a durable fact in your long-term memory. One fact per call, stated plainly.",
        {
          fact: z.string().min(3).describe("The fact, in one sentence."),
          tags: z.array(z.string()).optional().describe("Optional short tags, e.g. infra, style."),
        },
        async ({ fact, tags }) => text(remember(fact, tags ?? [])),
      ),
      tool(
        "recall",
        "Search your long-term memory and past conversations for something you were told before.",
        { query: z.string().min(2).describe("What you are trying to remember.") },
        async ({ query }) => text(recall(query)),
      ),
    ],
  });
};
