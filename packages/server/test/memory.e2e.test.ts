import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStream, sleep, startHowdy, usage } from "./support/harness.ts";
import type { Howdy } from "./support/harness.ts";
import { compactBotMemory, recallFor, rememberFor } from "../dist/agent/memory.js";

const memoryPath = (h: Howdy, slug: string) => join(h.root, "bots", slug, "memory.md");

const done = (text: string) => ({
  text,
  toolCalls: [],
  usage: usage(10, 10),
  costUsd: 0,
  sessionId: null,
  isError: false,
  detail: null,
});

test("a bot can write a fact to its own memory file", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bot = await h.post<{ id: string; slug: string }>("/api/bots", { name: "Sre" });
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  h.setScript(async (input) => {
    const server = input.mcpServers?.["howdy-memory"] as
      | { instance: { _registeredTools: Record<string, unknown> } }
      | undefined;
    assert.ok(server !== undefined, "every turn must be given the memory server");
    assert.deepEqual(
      Object.keys(server.instance._registeredTools).sort(),
      ["recall", "remember"],
      "both memory tools must be offered",
    );
    h.remember("sre", "The prod cluster is prod-eu", ["infra"]);
    return done("noted");
  });

  await h.post("/api/rooms/general/messages", { text: "the prod cluster is prod-eu", botId: bot.id });
  await stream.waitFor("turnFinished");

  const written = readFileSync(memoryPath(h, bot.slug), "utf8");
  assert.match(written, /The prod cluster is prod-eu/);
  assert.match(written, /#infra/);

  const remembered = await stream.waitFor("remembered");
  assert.equal(remembered["fact"], "The prod cluster is prod-eu");
  assert.equal(remembered["total"], 1);
});

test("a remembered fact reaches the next turn's system prompt, in another room", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bot = await h.post<{ id: string; slug: string }>("/api/bots", { name: "Sre" });
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  h.setScript(async () => {
    h.remember("sre", "Brandon deploys with argocd, never kubectl apply");
    return done("noted");
  });
  await h.post("/api/rooms/room-a/messages", { text: "remember how I deploy", botId: bot.id });
  await stream.waitFor("turnFinished");

  let seen = "";
  h.setScript(async (input) => {
    seen = input.systemPrompt;
    return done("recalled");
  });
  await h.post("/api/rooms/room-b/messages", { text: "how do I deploy?", botId: bot.id });
  await sleep(500);

  assert.match(seen, /argocd, never kubectl apply/, "memory must cross rooms");
});

test("recall finds a fact from memory and from past transcripts", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bot = await h.post<{ id: string; slug: string }>("/api/bots", { name: "Sre" });
  writeFileSync(
    memoryPath(h, bot.slug),
    "- (2026-09-01) The prod cluster is prod-eu and runs argo\n",
  );

  const stream = await openStream(h.url);
  t.after(() => stream.close());
  h.setScript(async () => done("The autoscaler adapter caches for sixty seconds."));
  await h.post("/api/rooms/general/messages", { text: "why is scaling laggy?", botId: bot.id });
  await stream.waitFor("turnFinished");

  const recalled = `${h.recall("sre", "prod cluster argo")}\n${h.recall("sre", "autoscaler adapter")}`;

  assert.match(recalled, /prod-eu/, "should recall from memory.md");
  assert.match(recalled, /sixty seconds/, "should recall from the transcript index");
});

test("recall reports a miss honestly rather than inventing context", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bot = await h.post<{ id: string; slug: string }>("/api/bots", { name: "Sre" });

  void bot;
  assert.match(h.recall("sre", "the colour of my bicycle"), /Nothing in memory/);
});

test("memory compaction dedupes and archives without losing a fact", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bot = await h.post<{ id: string; slug: string; botDir: string }>("/api/bots", { name: "Sre" });

  const lines = [
    "- (2026-09-01) The prod cluster is prod-eu",
    "- (2026-09-02) the prod cluster is prod-eu!",
    "- (2026-09-03) Brandon prefers functional TypeScript",
  ].join("\n");
  writeFileSync(memoryPath(h, bot.slug), lines + "\n");

  const result = compactBotMemory(h.bot("sre"), 100);
  assert.equal(result.reason, "duplicates");
  assert.equal(result.kept, 2);

  const kept = readFileSync(memoryPath(h, bot.slug), "utf8");
  assert.match(kept, /prod-eu/);
  assert.match(kept, /functional TypeScript/);
  assert.equal((kept.match(/prod-eu/g) ?? []).length, 1);

  const archive = join(h.root, "bots", bot.slug, "memory.archive.md");
  assert.ok(existsSync(archive), "dropped entries must be archived, never deleted");
  assert.match(readFileSync(archive, "utf8"), /prod-eu/);
});

test("memory tools are never gated behind a permission prompt", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bot = await h.post<{ id: string }>("/api/bots", { name: "Sre" });
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  h.setScript(async (input) => {
    const decision = await input.canUseTool?.(
      "mcp__howdy-memory__remember",
      { fact: "something" },
      { signal: input.signal },
    );
    return done(`behaviour=${decision?.behavior ?? "none"}`);
  });
  await h.post("/api/rooms/general/messages", { text: "go", botId: bot.id });
  await stream.waitFor("turnFinished");

  assert.equal(stream.kinds().includes("permissionRequest"), false);
  const messages = await h.get<{ content: string }[]>("/api/rooms/general/messages");
  assert.equal(messages.at(-1)?.content, "behaviour=allow");
});
