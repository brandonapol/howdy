import { test } from "node:test";
import assert from "node:assert/strict";
import { openStream, sleep, startHowdy, usage } from "./support/harness.ts";
import type { Howdy } from "./support/harness.ts";
import { parseVerdict } from "../dist/agent/judge.js";

const LINES = [
  "Sync wave zero holds both the namespace and a job that assumes it exists.",
  "Helm templates a timestamp into the checksum, so every diff shows drift.",
  "Kubelet reserve was never retuned after we doubled pod density.",
  "The autoscaler reads a metric the adapter caches past our scrape interval.",
  "Pull secrets rotate weekly but the service account patch runs monthly.",
  "Terraform drifted when a security group was widened by hand.",
  "Readiness fans out to three services, so one slow dependency fails the set.",
  "Certificates renewed but nothing restarted, so the old chain stayed resident.",
];

const varied = () => {
  let n = 0;
  return async (input: { onText?: (t: string) => void; signal: AbortSignal }) => {
    const text = LINES[n % LINES.length] ?? "another point";
    n += 1;
    input.onText?.(text);
    await sleep(5, input.signal);
    return {
      text, toolCalls: [], usage: usage(200, 100), costUsd: 0,
      sessionId: null, isError: false, detail: null,
    };
  };
};

const party = async (h: Howdy, goal: string | null, over: Record<string, unknown> = {}) => {
  const bots = await Promise.all([
    h.post<{ id: string }>("/api/bots", { name: "Sre" }),
    h.post<{ id: string }>("/api/bots", { name: "Dev" }),
  ]);
  return h.post<{ id: string }>("/api/rooms", {
    name: "the party",
    kind: "party",
    goal,
    ceilings: { maxTurns: 30, maxTokens: 1_000_000 },
    participants: bots.map((b) => ({ botId: b.id, noisiness: 1, cooldownTurns: 0 })),
    ...over,
  });
};

test("parsing the judge's reply handles all three verdicts and junk", () => {
  assert.deepEqual(parseVerdict("DONE: the wrapper never execs"), {
    kind: "done", summary: "the wrapper never execs",
  });
  assert.deepEqual(parseVerdict("STUCK: they need the cluster name"), {
    kind: "stuck", summary: "they need the cluster name",
  });
  assert.deepEqual(parseVerdict("CONTINUE"), { kind: "continue" });
  assert.deepEqual(parseVerdict("  \n\ndone: lowercase works\n"), {
    kind: "done", summary: "lowercase works",
  });
  assert.deepEqual(parseVerdict("I think they are probably finished"), { kind: "continue" });
  assert.deepEqual(parseVerdict(""), { kind: "continue" });
});

test("a party that reaches its goal stops early and says what was concluded", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const room = await party(h, "work out why the argo sync wedged");
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  h.setScript(varied());
  let asked = 0;
  h.setJudge(() => {
    asked += 1;
    return asked >= 2
      ? { kind: "done", summary: "the presync hook never execs, so the job hangs" }
      : { kind: "continue" };
  });

  await h.post(`/api/rooms/${room.id}/messages`, { text: "why did it wedge?" });
  const halted = await stream.waitFor("halted", 20_000);
  const reason = halted["reason"] as { kind: string; summary?: string };
  assert.equal(reason.kind, "complete");
  assert.match(reason.summary ?? "", /never execs/);

  const messages = await h.get<{ speakerKind: string; content: string }[]>(
    `/api/rooms/${room.id}/messages`,
  );
  assert.match(
    messages.find((m) => m.speakerKind === "system")?.content ?? "",
    /Goal reached: the presync hook never execs/,
  );
  assert.ok(
    messages.filter((m) => m.speakerKind === "bot").length < 12,
    "finishing should beat running to the ceiling",
  );
});

test("a stuck party is stopped and says what it is missing", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const room = await party(h, "decide whether to roll back");
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  h.setScript(varied());
  h.setJudge(() => ({ kind: "stuck", summary: "they need a human to confirm the blast radius" }));

  await h.post(`/api/rooms/${room.id}/messages`, { text: "should we roll back?" });
  const halted = await stream.waitFor("halted", 20_000);
  assert.equal((halted["reason"] as { kind: string }).kind, "complete");

  const messages = await h.get<{ speakerKind: string; content: string }[]>(
    `/api/rooms/${room.id}/messages`,
  );
  assert.match(
    messages.find((m) => m.speakerKind === "system")?.content ?? "",
    /Stuck: they need a human to confirm/,
  );
});

test("a room with no goal is never judged", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const room = await party(h, null, { ceilings: { maxTurns: 4, maxTokens: 1_000_000 } });
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  h.setScript(varied());
  let asked = 0;
  h.setJudge(() => {
    asked += 1;
    return { kind: "done", summary: "should never be consulted" };
  });

  await h.post(`/api/rooms/${room.id}/messages`, { text: "chat away" });
  const halted = await stream.waitFor("halted", 20_000);
  assert.equal(asked, 0, "no goal means no judge call, and no cost");
  assert.equal((halted["reason"] as { kind: string }).kind, "budget");
});

test("a continuing verdict leaves the party alone until a ceiling stops it", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const room = await party(h, "keep going forever", { ceilings: { maxTurns: 4, maxTokens: 1_000_000 } });
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  h.setScript(varied());
  h.setJudge(() => ({ kind: "continue" }));

  await h.post(`/api/rooms/${room.id}/messages`, { text: "go" });
  const halted = await stream.waitFor("halted", 20_000);
  assert.equal((halted["reason"] as { kind: string }).kind, "budget");
});

test("the judge is consulted on a cadence rather than every single turn", async (t) => {
  const h = await startHowdy({ goalCheckEvery: 3 });
  t.after(() => h.cleanup());
  const room = await party(h, "a goal", { ceilings: { maxTurns: 7, maxTokens: 1_000_000 } });
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  h.setScript(varied());
  let asked = 0;
  h.setJudge(() => {
    asked += 1;
    return { kind: "continue" };
  });

  await h.post(`/api/rooms/${room.id}/messages`, { text: "go" });
  await stream.waitFor("halted", 20_000);
  await sleep(200);
  assert.ok(asked >= 1, "the judge must run at least once");
  assert.ok(asked <= 3, `expected roughly every third turn, saw ${asked} calls over 7 turns`);
});

test("a judge that throws never takes the room down with it", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const room = await party(h, "a goal", { ceilings: { maxTurns: 4, maxTokens: 1_000_000 } });
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  h.setScript(varied());
  h.setJudge(() => {
    throw new Error("the judge fell over");
  });

  await h.post(`/api/rooms/${room.id}/messages`, { text: "go" });
  const halted = await stream.waitFor("halted", 20_000);
  assert.equal((halted["reason"] as { kind: string }).kind, "budget", "the party should still run");
});

test("a completed room cannot be resumed, only restarted by speaking", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const room = await party(h, "settle one question");
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  h.setScript(varied());
  h.setJudge(() => ({ kind: "done", summary: "settled" }));
  await h.post(`/api/rooms/${room.id}/messages`, { text: "go" });
  await stream.waitFor("halted", 20_000);

  h.setJudge(() => ({ kind: "continue" }));
  await h.post(`/api/rooms/${room.id}/resume`);
  await sleep(400);
  assert.equal(
    (await h.get<{ status: { kind: string } }>(`/api/rooms/${room.id}`)).status.kind,
    "halted",
  );

  await h.post(`/api/rooms/${room.id}/messages`, { text: "actually, one more thing" });
  await sleep(700);
  const messages = await h.get<{ speakerKind: string }[]>(`/api/rooms/${room.id}/messages`);
  assert.ok(messages.filter((m) => m.speakerKind === "bot").length > 1);
});
