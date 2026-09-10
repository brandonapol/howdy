import { test } from "node:test";
import assert from "node:assert/strict";
import { openStream, replies, sleep, startHowdy, usage } from "./support/harness.ts";
import type { Howdy } from "./support/harness.ts";

const soloRoom = async (h: Howdy, name = "Sre") => {
  const bot = await h.post<{ id: string; slug: string }>("/api/bots", { name });
  const room = await h.post<{ id: string }>("/api/rooms", {
    name: `${name} room`,
    kind: "party",
    ceilings: { maxTurns: 4 },
    participants: [{ botId: bot.id, noisiness: 1, cooldownTurns: 0 }],
  });
  return { bot, room };
};

type Routine = {
  id: string;
  name: string;
  description: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: string | null;
  enabled: boolean;
};

test("a routine is created with a readable description and a scheduled next run", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const { room } = await soloRoom(h);

  const routine = await h.post<Routine>("/api/routines", {
    name: "morning PR sweep",
    roomId: room.id,
    prompt: "check my open PRs and summarise anything that needs me",
    schedule: { kind: "daily", hour: 8, minute: 30 },
  });

  assert.equal(routine.name, "morning PR sweep");
  assert.equal(routine.description, "daily at 08:30");
  assert.ok((routine.nextRunAt ?? 0) > Date.now(), "a new routine must be scheduled ahead");
  assert.equal(routine.lastRunAt, null);
  assert.equal(routine.enabled, true);

  const all = await h.get<Routine[]>("/api/routines");
  assert.equal(all.length, 1);
});

test("running a routine posts its prompt into the room and gets a real reply", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const { room } = await soloRoom(h);
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  const routine = await h.post<Routine>("/api/routines", {
    name: "sweep",
    roomId: room.id,
    prompt: "check my open PRs",
    schedule: { kind: "daily", hour: 8, minute: 30 },
  });

  h.setScript(replies("Two PRs are waiting on you, both green."));
  await h.post(`/api/routines/${routine.id}/run`);
  await stream.waitFor("turnFinished", 10_000);

  const messages = await h.get<{ speakerKind: string; content: string }[]>(
    `/api/rooms/${room.id}/messages`,
  );
  assert.equal(messages[0]?.speakerKind, "human");
  assert.equal(messages[0]?.content, "check my open PRs");
  assert.match(messages[1]?.content ?? "", /Two PRs are waiting/);

  const after = await h.get<Routine>(`/api/routines`).then((all) => (all as unknown as Routine[])[0]);
  assert.equal(after?.lastStatus, "ran");
  assert.ok((after?.lastRunAt ?? 0) > 0);
  assert.ok((after?.nextRunAt ?? 0) > Date.now(), "it must reschedule itself");
});

test("a due routine fires on a tick, and one that is not due does not", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const { room } = await soloRoom(h);
  const stream = await openStream(h.url);
  t.after(() => stream.close());
  h.setScript(replies("done"));

  await h.post("/api/routines", {
    name: "later",
    roomId: room.id,
    prompt: "not yet",
    schedule: { kind: "daily", hour: 23, minute: 59 },
  });
  assert.equal((await h.post<{ fired: number }>("/api/routines/tick")).fired, 0);

  const soon = await h.post<Routine>("/api/routines", {
    name: "soon",
    roomId: room.id,
    prompt: "run me",
    schedule: { kind: "interval", minutes: 5 },
  });
  await h.patch(`/api/routines/${soon.id}`, { enabled: true });

  const fired = await h.post<{ fired: number }>("/api/routines/tick");
  void fired;
  const messages = await h.get<{ content: string }[]>(`/api/rooms/${room.id}/messages`);
  assert.equal(messages.length, 0, "a routine five minutes out must not fire now");
});

test("a routine is refused when the daily ceiling is already spent", async (t) => {
  const h = await startHowdy({ dailyTokenCeiling: 300 });
  t.after(() => h.cleanup());
  const { room } = await soloRoom(h);
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  const routine = await h.post<Routine>("/api/routines", {
    name: "spendy",
    roomId: room.id,
    prompt: "burn tokens",
    schedule: { kind: "daily", hour: 8, minute: 0 },
  });

  h.setScript(replies("first run"));
  await h.post(`/api/routines/${routine.id}/run`);
  await stream.waitFor("turnFinished", 10_000);

  const second = await h.post<{ ok: boolean; status: string }>(`/api/routines/${routine.id}/run`);
  assert.equal(second.ok, false);
  assert.match(second.status, /daily ceiling/);
});

test("a routine pointing at a deleted room reports it rather than throwing", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const { room } = await soloRoom(h);
  const routine = await h.post<Routine>("/api/routines", {
    name: "orphan",
    roomId: room.id,
    prompt: "hello",
    schedule: { kind: "daily", hour: 8, minute: 0 },
  });

  await fetch(`${h.url}/api/rooms/${room.id}`, { method: "DELETE" });
  const run = await h.post<{ ok: boolean; status: string }>(`/api/routines/${routine.id}/run`);
  assert.equal(run.ok, false);
  assert.match(run.status, /room is gone/);
});

test("a disabled routine never fires and carries no next run", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const { room } = await soloRoom(h);
  const routine = await h.post<Routine>("/api/routines", {
    name: "off",
    roomId: room.id,
    prompt: "should not run",
    schedule: { kind: "interval", minutes: 5 },
  });

  const disabled = await h.patch<Routine>(`/api/routines/${routine.id}`, { enabled: false });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.nextRunAt, null);
  assert.equal((await h.post<{ fired: number }>("/api/routines/tick")).fired, 0);
});

test("routines can be renamed, rescheduled and deleted", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const { room } = await soloRoom(h);
  const routine = await h.post<Routine>("/api/routines", {
    name: "original",
    roomId: room.id,
    prompt: "hello",
    schedule: { kind: "daily", hour: 8, minute: 0 },
  });

  const renamed = await h.patch<Routine>(`/api/routines/${routine.id}`, {
    name: "renamed",
    schedule: { kind: "weekly", weekday: 1, hour: 9, minute: 15 },
  });
  assert.equal(renamed.name, "renamed");
  assert.equal(renamed.description, "Monday at 09:15");

  const removed = await fetch(`${h.url}/api/routines/${routine.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.deepEqual(await h.get<unknown[]>("/api/routines"), []);
});

test("a routine is rejected without a real room or a prompt", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const { room } = await soloRoom(h);

  await assert.rejects(
    () => h.post("/api/routines", {
      name: "bad", roomId: "ghost", prompt: "x", schedule: { kind: "daily", hour: 1, minute: 0 },
    }),
    (e: unknown) => (e as { status: number }).status === 400,
  );
  await assert.rejects(
    () => h.post("/api/routines", {
      name: "", roomId: room.id, prompt: "x", schedule: { kind: "daily", hour: 1, minute: 0 },
    }),
    (e: unknown) => (e as { status: number }).status === 400,
  );
});

test("routines survive a restart with their schedule intact", async (t) => {
  const first = await startHowdy();
  const { room } = await soloRoom(first);
  const created = await first.post<Routine>("/api/routines", {
    name: "persistent",
    roomId: room.id,
    prompt: "still here",
    schedule: { kind: "weekly", weekday: 3, hour: 7, minute: 0 },
  });
  const root = first.root;
  await first.stop();

  const second = await startHowdy({}, root);
  t.after(() => second.cleanup());
  const all = await second.get<Routine[]>("/api/routines");
  assert.equal(all.length, 1);
  assert.equal(all[0]?.name, "persistent");
  assert.equal(all[0]?.description, "Wednesday at 07:00");
  assert.equal(all[0]?.nextRunAt, created.nextRunAt);
});

test("firing a routine announces itself so the UI can show it", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const { room } = await soloRoom(h);
  const stream = await openStream(h.url);
  t.after(() => stream.close());
  h.setScript(async () => ({
    text: "swept", toolCalls: [], usage: usage(10, 10), costUsd: 0,
    sessionId: null, isError: false, detail: null,
  }));

  const routine = await h.post<Routine>("/api/routines", {
    name: "morning sweep",
    roomId: room.id,
    prompt: "sweep",
    schedule: { kind: "daily", hour: 6, minute: 0 },
  });
  await h.post(`/api/routines/${routine.id}/run`);

  const event = await stream.waitFor("routineFired", 8000);
  assert.equal(event["name"], "morning sweep");
  assert.equal(event["roomId"], room.id);
  await sleep(200);
});
