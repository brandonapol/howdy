import { test } from "node:test";
import assert from "node:assert/strict";
import { openStream, sleep, startHowdy, usage } from "./support/harness.ts";
import type { Howdy, Script } from "./support/harness.ts";

const LINES: readonly string[] = [
  "The ingress rewrite dropped the nginx annotations the gateway API never picked up.",
  "Sync wave zero holds both the namespace and a job that assumes it already exists.",
  "Helm templates a timestamp into the checksum annotation, so every diff shows drift.",
  "Kubelet reserve was never retuned after we doubled pod density on the arm workers.",
  "Readiness fans out to three services, so one slow dependency fails the whole set.",
  "Pull secrets rotate weekly but the service account patch runs monthly.",
  "Terraform drifted after somebody widened a security group by hand during an incident.",
  "The autoscaler reads a metric the adapter caches for longer than our scrape interval.",
  "Connection pooling sits in the app rather than pgbouncer, so restarts triple sockets.",
  "Certificates renewed but nothing restarted, so the old chain stayed resident.",
  "Log volume tripled after a base image shipped with the root logger set to debug.",
  "The cronjob has no concurrency policy, so a slow run overlaps the next one.",
];

const cast = async (h: Howdy, names: readonly string[]) =>
  Promise.all(names.map((name) => h.post<{ id: string; slug: string }>("/api/bots", { name })));

const varied = (): Script => {
  let n = 0;
  return async (input) => {
    const text = LINES[n % LINES.length] ?? "another observation";
    n += 1;
    input.onText?.(text);
    await sleep(5, input.signal);
    return {
      text,
      toolCalls: [],
      usage: usage(300, 150),
      costUsd: 0.001,
      sessionId: null,
      isError: false,
      detail: null,
    };
  };
};

const agreeable = (): Script => async (input) => {
  const text = "Absolutely, I agree, that is a really strong plan.";
  input.onText?.(text);
  return {
    text,
    toolCalls: [],
    usage: usage(50, 20),
    costUsd: 0,
    sessionId: null,
    isError: false,
    detail: null,
  };
};

const party = async (h: Howdy, bots: readonly { id: string }[], over: Record<string, unknown> = {}) =>
  h.post<{ id: string; participants: string[] }>("/api/rooms", {
    name: "the party",
    kind: "party",
    participants: bots.map((b) => ({ botId: b.id, noisiness: 1, cooldownTurns: 0 })),
    ...over,
  });

test("two bots hold a conversation without a human between turns", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bots = await cast(h, ["Sre", "Dev"]);
  const room = await party(h, bots, { ceilings: { maxTurns: 6 } });

  const stream = await openStream(h.url);
  t.after(() => stream.close());
  h.setScript(varied());

  await h.post(`/api/rooms/${room.id}/messages`, { text: "why is the deploy stuck?" });
  await stream.waitFor("halted", 15_000);

  const messages = await h.get<{ speakerKind: string; botId: string | null }[]>(
    `/api/rooms/${room.id}/messages`,
  );
  const botTurns = messages.filter((m) => m.speakerKind === "bot");
  assert.ok(botTurns.length >= 4, `expected a real back and forth, saw ${botTurns.length} turns`);
  assert.equal(new Set(botTurns.map((m) => m.botId)).size, 2, "both bots must have spoken");
});

test("bots alternate rather than one bot monopolising the room", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bots = await cast(h, ["Sre", "Dev"]);
  const room = await party(h, bots, { ceilings: { maxTurns: 6 } });
  const stream = await openStream(h.url);
  t.after(() => stream.close());
  h.setScript(varied());

  await h.post(`/api/rooms/${room.id}/messages`, { text: "discuss" });
  await stream.waitFor("halted", 15_000);

  const speakers = (
    await h.get<{ speakerKind: string; botId: string | null }[]>(`/api/rooms/${room.id}/messages`)
  )
    .filter((m) => m.speakerKind === "bot")
    .map((m) => m.botId);

  for (let i = 1; i < speakers.length; i += 1) {
    assert.notEqual(speakers[i], speakers[i - 1], "no bot may speak twice in a row");
  }
});

test("the turn ceiling stops a party and says which ceiling it was", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bots = await cast(h, ["Sre", "Dev"]);
  const room = await party(h, bots, { ceilings: { maxTurns: 4 } });
  const stream = await openStream(h.url);
  t.after(() => stream.close());
  h.setScript(varied());

  await h.post(`/api/rooms/${room.id}/messages`, { text: "go" });
  const halted = await stream.waitFor("halted", 15_000);
  const reason = halted["reason"] as { kind: string; breach?: { kind: string } };
  assert.equal(reason.kind, "budget");
  assert.equal(reason.breach?.kind, "turns");

  const state = await h.get<{ status: { kind: string } }>(`/api/rooms/${room.id}`);
  assert.equal(state.status.kind, "halted");
});

test("the token ceiling stops a party that is turning cheaply but often", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bots = await cast(h, ["Sre", "Dev"]);
  const room = await party(h, bots, { ceilings: { maxTurns: 500, maxTokens: 1400 } });
  const stream = await openStream(h.url);
  t.after(() => stream.close());
  h.setScript(varied());

  await h.post(`/api/rooms/${room.id}/messages`, { text: "go" });
  const halted = await stream.waitFor("halted", 15_000);
  const reason = halted["reason"] as { kind: string; breach?: { kind: string } };
  assert.equal(reason.kind, "budget");
  assert.equal(reason.breach?.kind, "tokens");
});

test("a degenerate party is stopped by a detector well before its ceilings", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bots = await cast(h, ["Sre", "Dev"]);
  const room = await party(h, bots, { ceilings: { maxTurns: 40, maxTokens: 1_000_000 } });
  const stream = await openStream(h.url);
  t.after(() => stream.close());
  h.setScript(agreeable());

  await h.post(`/api/rooms/${room.id}/messages`, { text: "what do you think of the plan?" });
  const halted = await stream.waitFor("halted", 20_000);
  assert.equal((halted["reason"] as { kind: string }).kind, "degeneracy");

  const messages = await h.get<{ speakerKind: string }[]>(`/api/rooms/${room.id}/messages`);
  const botTurns = messages.filter((m) => m.speakerKind === "bot").length;
  assert.ok(botTurns < 20, `detector should fire early, took ${botTurns} turns`);
});

test("a lurker stays quiet until it is named", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const [loud, lurker] = await cast(h, ["Loud", "Lurker"]);
  assert.ok(loud !== undefined && lurker !== undefined);

  const room = await h.post<{ id: string }>("/api/rooms", {
    name: "quiet room",
    kind: "party",
    ceilings: { maxTurns: 4 },
    participants: [
      { botId: loud.id, noisiness: 1, cooldownTurns: 0 },
      { botId: lurker.id, noisiness: 0, cooldownTurns: 0 },
    ],
  });

  const stream = await openStream(h.url);
  t.after(() => stream.close());
  h.setScript(varied());

  await h.post(`/api/rooms/${room.id}/messages`, { text: "anyone about?" });
  await sleep(1500);
  const quiet = await h.get<{ botId: string | null; speakerKind: string }[]>(
    `/api/rooms/${room.id}/messages`,
  );
  assert.equal(
    quiet.filter((m) => m.botId === lurker.id).length,
    0,
    "a zero-noisiness bot must not speak unprompted",
  );

  await h.post(`/api/rooms/${room.id}/messages`, { text: `over to you @${lurker.slug}` });
  await sleep(1200);
  const named = await h.get<{ botId: string | null }[]>(`/api/rooms/${room.id}/messages`);
  assert.ok(
    named.some((m) => m.botId === lurker.id),
    "an @mention must override the noisiness roll",
  );
});

test("the killswitch stops a running party dead", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bots = await cast(h, ["Sre", "Dev"]);
  const room = await party(h, bots, { ceilings: { maxTurns: 100 } });
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  h.setScript(async (input) => {
    input.onText?.("thinking hard");
    await sleep(20_000, input.signal);
    throw new Error("unreachable");
  });

  await h.post(`/api/rooms/${room.id}/messages`, { text: "start" });
  await stream.waitFor("chunk", 8000);

  const started = Date.now();
  await h.post(`/api/rooms/${room.id}/halt`);
  const halted = await stream.waitFor("halted", 5000);
  assert.equal((halted["reason"] as { kind: string }).kind, "manual");
  assert.ok(Date.now() - started < 3000, "a halt must land within seconds");

  await sleep(400);
  assert.equal((await h.get<{ queueDepth: number }>("/api/health")).queueDepth, 0);
});

test("a halted party refuses to resume on a budget breach but resumes after a manual stop", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bots = await cast(h, ["Sre", "Dev"]);
  const room = await party(h, bots, { ceilings: { maxTurns: 2 } });
  const stream = await openStream(h.url);
  t.after(() => stream.close());
  h.setScript(varied());

  await h.post(`/api/rooms/${room.id}/messages`, { text: "go" });
  await stream.waitFor("halted", 15_000);

  await h.post(`/api/rooms/${room.id}/resume`);
  await sleep(400);
  const stillHalted = await h.get<{ status: { kind: string } }>(`/api/rooms/${room.id}`);
  assert.equal(stillHalted.status.kind, "halted", "a budget halt must not be resumable");

  await h.post(`/api/rooms/${room.id}/messages`, { text: "carry on, I am watching" });
  await sleep(800);
  const messages = await h.get<{ speakerKind: string }[]>(`/api/rooms/${room.id}/messages`);
  assert.ok(
    messages.filter((m) => m.speakerKind === "bot").length > 2,
    "a human speaking should reset the window and let the room continue",
  );
});

test("step mode holds every turn until it is asked for", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bots = await cast(h, ["Sre", "Dev"]);
  const room = await party(h, bots, { stepMode: true, ceilings: { maxTurns: 20 } });
  const stream = await openStream(h.url);
  t.after(() => stream.close());
  h.setScript(varied());

  await h.post(`/api/rooms/${room.id}/messages`, { text: "go" });
  await sleep(600);
  let messages = await h.get<{ speakerKind: string }[]>(`/api/rooms/${room.id}/messages`);
  assert.equal(messages.filter((m) => m.speakerKind === "bot").length, 0, "nothing runs unasked");

  const state = await h.get<{ status: { kind: string } }>(`/api/rooms/${room.id}`);
  assert.equal(state.status.kind, "awaitingTurn");

  await h.post(`/api/rooms/${room.id}/step`);
  await sleep(600);
  messages = await h.get<{ speakerKind: string }[]>(`/api/rooms/${room.id}/messages`);
  assert.equal(messages.filter((m) => m.speakerKind === "bot").length, 1, "exactly one turn per step");
});

test("the daily governor stops a party before it spawns another subprocess", async (t) => {
  const h = await startHowdy({ dailyTokenCeiling: 900 });
  t.after(() => h.cleanup());
  const bots = await cast(h, ["Sre", "Dev"]);
  const room = await party(h, bots, { ceilings: { maxTurns: 100, maxTokens: 10_000_000 } });
  const stream = await openStream(h.url);
  t.after(() => stream.close());
  h.setScript(varied());

  await h.post(`/api/rooms/${room.id}/messages`, { text: "go" });
  await stream.waitFor("halted", 15_000);

  const messages = await h.get<{ speakerKind: string; content: string }[]>(
    `/api/rooms/${room.id}/messages`,
  );
  const notice = messages.find((m) => m.speakerKind === "system");
  assert.ok(notice !== undefined, "the room should say why it stopped");
  assert.match(notice?.content ?? "", /daily ceiling/);
  assert.ok(
    messages.filter((m) => m.speakerKind === "bot").length <= 3,
    "the governor should bite quickly",
  );
});

test("the weekly governor also stops a party", async (t) => {
  const h = await startHowdy({ dailyTokenCeiling: 10_000_000, weeklyTokenCeiling: 900 });
  t.after(() => h.cleanup());
  const bots = await cast(h, ["Sre", "Dev"]);
  const room = await party(h, bots, { ceilings: { maxTurns: 100, maxTokens: 10_000_000 } });
  const stream = await openStream(h.url);
  t.after(() => stream.close());
  h.setScript(varied());

  await h.post(`/api/rooms/${room.id}/messages`, { text: "go" });
  await stream.waitFor("halted", 15_000);
  const messages = await h.get<{ speakerKind: string; content: string }[]>(
    `/api/rooms/${room.id}/messages`,
  );
  assert.match(
    messages.find((m) => m.speakerKind === "system")?.content ?? "",
    /weekly ceiling/,
  );
});

test("a party survives a restart and reports how it ended", async (t) => {
  const first = await startHowdy();
  const bots = await cast(first, ["Sre", "Dev"]);
  const room = await party(first, bots, { ceilings: { maxTurns: 4 } });
  const stream = await openStream(first.url);
  first.setScript(varied());
  await first.post(`/api/rooms/${room.id}/messages`, { text: "go" });
  await stream.waitFor("halted", 15_000);
  stream.close();
  const root = first.root;
  await first.stop();

  const second = await startHowdy({}, root);
  t.after(() => second.cleanup());
  const reloaded = await second.get<{ status: { kind: string }; participants: string[] }>(
    `/api/rooms/${room.id}`,
  );
  assert.equal(reloaded.status.kind, "halted");
  assert.equal(reloaded.participants.length, 2);

  const rooms = await second.get<{ id: string }[]>("/api/rooms");
  assert.ok(rooms.some((r) => r.id === room.id));
});

test("the same seed produces the same party twice", async (t) => {
  const run = async () => {
    const h = await startHowdy();
    const bots = await cast(h, ["Alpha", "Beta", "Gamma"]);
    const room = await h.post<{ id: string }>("/api/rooms", {
      name: "seeded",
      kind: "party",
      seed: 424242,
      ceilings: { maxTurns: 8 },
      participants: bots.map((b) => ({ botId: b.id, noisiness: 0.6, cooldownTurns: 0 })),
    });
    const stream = await openStream(h.url);
    h.setScript(varied());
    await h.post(`/api/rooms/${room.id}/messages`, { text: "go" });
    await sleep(3000);
    stream.close();
    const messages = await h.get<{ speakerKind: string; botId: string | null }[]>(
      `/api/rooms/${room.id}/messages`,
    );
    const names = await h.get<{ id: string; name: string }[]>("/api/bots");
    const order = messages
      .filter((m) => m.speakerKind === "bot")
      .map((m) => names.find((b) => b.id === m.botId)?.name ?? "?");
    await h.cleanup();
    return order;
  };

  const a = await run();
  const b = await run();
  assert.ok(a.length > 1, `expected several turns, saw ${a.length}`);
  assert.deepEqual(a, b, "a seeded party must be reproducible");
});
