import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEnvelope, applyEvent, initialState, mergeMessage, seedRoom } from "../dist-tsc/state.js";
import type { Message } from "../dist-tsc/types.js";

const message = (over: Partial<Message> = {}): Message => ({
  id: "m1",
  roomId: "general",
  speakerKind: "bot",
  botId: "b1",
  content: "howdy",
  turnIndex: 1,
  toolCallCount: 0,
  createdAt: 1000,
  ...over,
});

test("chunks accumulate into a per-bot streaming buffer", () => {
  let s = initialState;
  s = applyEvent(s, { kind: "chunk", roomId: "general", botId: "b1", text: "How" });
  s = applyEvent(s, { kind: "chunk", roomId: "general", botId: "b1", text: "dy" });
  assert.equal(s.rooms["general"]?.streaming["b1"], "Howdy");
});

test("two bots stream independently", () => {
  let s = initialState;
  s = applyEvent(s, { kind: "chunk", roomId: "general", botId: "b1", text: "one" });
  s = applyEvent(s, { kind: "chunk", roomId: "general", botId: "b2", text: "two" });
  assert.equal(s.rooms["general"]?.streaming["b1"], "one");
  assert.equal(s.rooms["general"]?.streaming["b2"], "two");
});

test("the final message clears that bot's stream and leaves others alone", () => {
  let s = initialState;
  s = applyEvent(s, { kind: "chunk", roomId: "general", botId: "b1", text: "partial" });
  s = applyEvent(s, { kind: "chunk", roomId: "general", botId: "b2", text: "other" });
  s = applyEvent(s, { kind: "message", roomId: "general", message: message() });
  assert.equal(s.rooms["general"]?.streaming["b1"], undefined);
  assert.equal(s.rooms["general"]?.streaming["b2"], "other");
  assert.equal(s.rooms["general"]?.messages.length, 1);
});

test("a replayed message updates in place rather than duplicating", () => {
  let s = initialState;
  s = applyEvent(s, { kind: "message", roomId: "general", message: message() });
  s = applyEvent(s, {
    kind: "message",
    roomId: "general",
    message: message({ content: "howdy, revised" }),
  });
  assert.equal(s.rooms["general"]?.messages.length, 1);
  assert.equal(s.rooms["general"]?.messages[0]?.content, "howdy, revised");
});

test("messages sort by creation time regardless of arrival order", () => {
  const sorted = mergeMessage(
    mergeMessage([], message({ id: "b", createdAt: 2000 })),
    message({ id: "a", createdAt: 1000 }),
  );
  assert.deepEqual(sorted.map((m) => m.id), ["a", "b"]);
});

test("messages with identical timestamps fall back to turn order", () => {
  const sorted = mergeMessage(
    mergeMessage([], message({ id: "second", createdAt: 5, turnIndex: 2 })),
    message({ id: "first", createdAt: 5, turnIndex: 1 }),
  );
  assert.deepEqual(sorted.map((m) => m.id), ["first", "second"]);
});

test("envelopes at or below the last seen id are ignored", () => {
  let s = initialState;
  s = applyEnvelope(s, { id: 5, event: { kind: "queueDepth", depth: 3 } });
  assert.equal(s.lastEventId, 5);
  s = applyEnvelope(s, { id: 5, event: { kind: "queueDepth", depth: 99 } });
  s = applyEnvelope(s, { id: 2, event: { kind: "queueDepth", depth: 77 } });
  assert.equal(s.queueDepth, 3);
  assert.equal(s.lastEventId, 5);
});

test("a reconnect that replays the same events is idempotent", () => {
  const envelopes = [
    { id: 1, event: { kind: "chunk", roomId: "general", botId: "b1", text: "hi " } },
    { id: 2, event: { kind: "chunk", roomId: "general", botId: "b1", text: "there" } },
    { id: 3, event: { kind: "message", roomId: "general", message: message() } },
  ] as const;
  const once = envelopes.reduce(applyEnvelope, initialState);
  const twice = envelopes.reduce(applyEnvelope, once);
  assert.deepEqual(twice.rooms["general"]?.messages, once.rooms["general"]?.messages);
  assert.equal(twice.lastEventId, 3);
});

test("turn start and finish track the active bot and reset tool chatter", () => {
  let s = initialState;
  s = applyEvent(s, { kind: "turnStarted", roomId: "general", botId: "b1" });
  s = applyEvent(s, { kind: "toolUse", roomId: "general", botId: "b1", tool: "Bash", summary: "gh pr list" });
  assert.equal(s.rooms["general"]?.activeBot, "b1");
  assert.deepEqual(s.rooms["general"]?.tools, ["gh pr list"]);
  s = applyEvent(s, {
    kind: "turnFinished",
    roomId: "general",
    botId: "b1",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    costUsd: 0.01,
  });
  assert.equal(s.rooms["general"]?.activeBot, null);
});

test("a halt clears streaming state and raises an alert", () => {
  let s = initialState;
  s = applyEvent(s, { kind: "chunk", roomId: "general", botId: "b1", text: "half a thou" });
  s = applyEvent(s, { kind: "turnStarted", roomId: "general", botId: "b1" });
  s = applyEvent(s, { kind: "halted", roomId: "general", reason: { kind: "manual" } });
  assert.deepEqual(s.rooms["general"]?.streaming, {});
  assert.equal(s.rooms["general"]?.activeBot, null);
  assert.equal(s.notices.at(-1)?.tone, "alert");
});

test("notices are capped so a chatty party cannot grow the list forever", () => {
  let s = initialState;
  for (let i = 0; i < 20; i += 1) {
    s = applyEvent(s, { kind: "announce", roomId: "general", text: `note ${i}` });
  }
  assert.equal(s.notices.length, 6);
  assert.match(s.notices.at(-1)?.text ?? "", /note 19/);
});

test("a permission request is queued and clears when resolved", () => {
  let s = initialState;
  s = applyEvent(s, {
    kind: "permissionRequest",
    id: "p1", roomId: "general", botId: "b1", tool: "Bash", detail: "terraform apply",
  });
  assert.equal(s.permissions.length, 1);
  assert.equal(s.permissions[0]?.detail, "terraform apply");
  s = applyEvent(s, { kind: "permissionResolved", id: "p1", allowed: true });
  assert.equal(s.permissions.length, 0);
});

test("a replayed permission request does not queue twice", () => {
  const event = {
    kind: "permissionRequest" as const,
    id: "p1", roomId: "general", botId: "b1", tool: "Bash", detail: "terraform apply",
  };
  const s = applyEvent(applyEvent(initialState, event), event);
  assert.equal(s.permissions.length, 1);
});

test("several prompts queue in arrival order", () => {
  let s = initialState;
  for (const id of ["p1", "p2", "p3"]) {
    s = applyEvent(s, {
      kind: "permissionRequest",
      id, roomId: "general", botId: "b1", tool: "Bash", detail: id,
    });
  }
  assert.deepEqual(s.permissions.map((p) => p.id), ["p1", "p2", "p3"]);
  s = applyEvent(s, { kind: "permissionResolved", id: "p2", allowed: false });
  assert.deepEqual(s.permissions.map((p) => p.id), ["p1", "p3"]);
});

test("halting a room clears its pending prompts but not another room's", () => {
  let s = initialState;
  s = applyEvent(s, { kind: "permissionRequest", id: "p1", roomId: "general", botId: "b1", tool: "Bash", detail: "x" });
  s = applyEvent(s, { kind: "permissionRequest", id: "p2", roomId: "other", botId: "b1", tool: "Bash", detail: "y" });
  s = applyEvent(s, { kind: "halted", roomId: "general", reason: { kind: "manual" } });
  assert.deepEqual(s.permissions.map((p) => p.id), ["p2"]);
});

test("a bot writing to memory shows up as a notice", () => {
  const s = applyEvent(initialState, {
    kind: "remembered",
    roomId: "general",
    botId: "b1",
    fact: "the prod cluster is prod-eu",
    total: 4,
  });
  assert.equal(s.notices.length, 1);
  assert.match(s.notices[0]?.text ?? "", /Remembered: the prod cluster is prod-eu/);
  assert.equal(s.notices[0]?.tone, "info");
});

test("spend and queue depth flow into the meters", () => {
  let s = initialState;
  s = applyEvent(s, { kind: "spend", tokensToday: 1234, ceiling: 5000 });
  s = applyEvent(s, { kind: "queueDepth", depth: 2 });
  assert.equal(s.tokensToday, 1234);
  assert.equal(s.tokenCeiling, 5000);
  assert.equal(s.queueDepth, 2);
});

test("seeding a room from history does not disturb live streaming", () => {
  let s = initialState;
  s = applyEvent(s, { kind: "chunk", roomId: "general", botId: "b1", text: "live" });
  s = seedRoom(s, "general", [message({ id: "old", createdAt: 1 })]);
  assert.equal(s.rooms["general"]?.messages.length, 1);
  assert.equal(s.rooms["general"]?.streaming["b1"], "live");
});

test("rooms stay isolated from one another", () => {
  let s = initialState;
  s = applyEvent(s, { kind: "chunk", roomId: "a", botId: "b1", text: "in a" });
  s = applyEvent(s, { kind: "chunk", roomId: "b", botId: "b1", text: "in b" });
  assert.equal(s.rooms["a"]?.streaming["b1"], "in a");
  assert.equal(s.rooms["b"]?.streaming["b1"], "in b");
});
