import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSchedule, isDue, nextRun, normaliseSchedule } from "../dist/index.js";
import type { Schedule } from "../dist/index.js";

const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number): string => new Date(ms).toISOString();

test("an interval runs one step after the last run", () => {
  const from = at("2026-09-10T08:00:00Z");
  const last = at("2026-09-10T07:45:00Z");
  assert.equal(
    nextRun({ kind: "interval", minutes: 30 }, from, last),
    at("2026-09-10T08:15:00Z"),
  );
});

test("an interval whose slot has already passed schedules from now, not the past", () => {
  const from = at("2026-09-10T09:00:00Z");
  const last = at("2026-09-10T06:00:00Z");
  const next = nextRun({ kind: "interval", minutes: 30 }, from, last);
  assert.ok(next > from, "must never schedule into the past");
  assert.equal(next, at("2026-09-10T09:30:00Z"));
});

test("an interval with no history starts one step from now", () => {
  const from = at("2026-09-10T09:00:00Z");
  assert.equal(
    nextRun({ kind: "interval", minutes: 60 }, from, null),
    at("2026-09-10T10:00:00Z"),
  );
});

test("a daily schedule picks today when it is still ahead, tomorrow otherwise", () => {
  const morning = nextRun({ kind: "daily", hour: 8, minute: 30 }, at("2026-09-10T05:00:00Z"));
  assert.match(iso(morning), /2026-09-10T08:30/);

  const evening = nextRun({ kind: "daily", hour: 8, minute: 30 }, at("2026-09-10T12:00:00Z"));
  assert.match(iso(evening), /2026-09-11T08:30/);
});

test("a daily schedule exactly at the boundary waits for tomorrow", () => {
  const exact = at("2026-09-10T08:30:00Z");
  assert.ok(nextRun({ kind: "daily", hour: 8, minute: 30 }, exact) > exact);
});

test("a weekly schedule finds the right weekday", () => {
  const thursday = at("2026-09-10T05:00:00Z");
  assert.equal(new Date(thursday).getUTCDay(), 4);

  const monday = nextRun({ kind: "weekly", weekday: 1, hour: 9, minute: 0 }, thursday);
  assert.equal(new Date(monday).getUTCDay(), 1);
  assert.match(iso(monday), /2026-09-14T09:00/);

  const laterToday = nextRun({ kind: "weekly", weekday: 4, hour: 9, minute: 0 }, thursday);
  assert.match(iso(laterToday), /2026-09-10T09:00/);

  const nextWeek = nextRun(
    { kind: "weekly", weekday: 4, hour: 4, minute: 0 },
    thursday,
  );
  assert.match(iso(nextWeek), /2026-09-17T04:00/);
});

test("nonsense is clamped rather than trusted", () => {
  assert.deepEqual(normaliseSchedule({ kind: "interval", minutes: 0 }), {
    kind: "interval", minutes: 5,
  });
  assert.deepEqual(normaliseSchedule({ kind: "interval", minutes: Number.NaN }), {
    kind: "interval", minutes: 5,
  });
  assert.deepEqual(normaliseSchedule({ kind: "daily", hour: 99, minute: -4 }), {
    kind: "daily", hour: 23, minute: 0,
  });
  assert.deepEqual(normaliseSchedule({ kind: "weekly", weekday: 12, hour: 1, minute: 1 }), {
    kind: "weekly", weekday: 6, hour: 1, minute: 1,
  });
});

test("a five minute floor stops a routine becoming a busy loop", () => {
  for (const minutes of [0, 1, 4, -30]) {
    assert.deepEqual(
      normaliseSchedule({ kind: "interval", minutes }),
      { kind: "interval", minutes: 5 },
      `${minutes} should be raised to the five minute floor`,
    );
  }
  assert.deepEqual(normaliseSchedule({ kind: "interval", minutes: 6 }), {
    kind: "interval", minutes: 6,
  });
});

test("due-ness follows the stored next run when there is one", () => {
  const schedule: Schedule = { kind: "daily", hour: 8, minute: 0 };
  const soon = at("2026-09-10T08:00:00Z");
  assert.equal(isDue(schedule, soon - 1000, null, soon), false);
  assert.equal(isDue(schedule, soon, null, soon), true);
  assert.equal(isDue(schedule, soon + 60_000, null, soon), true);
});

test("descriptions read like something a human wrote", () => {
  assert.equal(describeSchedule({ kind: "interval", minutes: 30 }), "every 30m");
  assert.equal(describeSchedule({ kind: "interval", minutes: 120 }), "every 2h");
  assert.equal(describeSchedule({ kind: "daily", hour: 8, minute: 5 }), "daily at 08:05");
  assert.equal(
    describeSchedule({ kind: "weekly", weekday: 1, hour: 17, minute: 0 }),
    "Monday at 17:00",
  );
});
