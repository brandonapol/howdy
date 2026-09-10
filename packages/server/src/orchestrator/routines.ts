import { randomUUID } from "node:crypto";
import { describeSchedule, nextRun, normaliseSchedule } from "@howdy/core";
import type { Schedule } from "@howdy/core";
import type { Db } from "../db/index.js";
import { spendToday, spendWindow } from "../db/index.js";
import type { Config } from "../config.js";
import type { EventBus } from "../events.js";
import type { Orchestrator } from "./rooms.js";

export type Routine = {
  readonly id: string;
  readonly name: string;
  readonly roomId: string;
  readonly prompt: string;
  readonly schedule: Schedule;
  readonly description: string;
  readonly enabled: boolean;
  readonly lastRunAt: number | null;
  readonly nextRunAt: number | null;
  readonly lastStatus: string | null;
};

export type CreateRoutineInput = {
  readonly name: string;
  readonly roomId: string;
  readonly prompt: string;
  readonly schedule: Schedule;
  readonly enabled?: boolean;
};

export type Routines = {
  readonly list: () => readonly Routine[];
  readonly get: (id: string) => Routine | null;
  readonly create: (input: CreateRoutineInput) => Routine;
  readonly update: (id: string, patch: Partial<CreateRoutineInput>) => Routine | null;
  readonly remove: (id: string) => boolean;
  readonly runNow: (id: string) => boolean;
  readonly tick: (now?: number) => number;
  readonly start: () => void;
  readonly stop: () => void;
};

type Row = {
  id: string; name: string; room_id: string; prompt: string; schedule: string;
  enabled: number; last_run_at: number | null; next_run_at: number | null;
  last_status: string | null;
};

const parse = (row: Row): Routine => {
  const schedule = normaliseSchedule(JSON.parse(row.schedule) as Schedule);
  return {
    id: row.id,
    name: row.name,
    roomId: row.room_id,
    prompt: row.prompt,
    schedule,
    description: describeSchedule(schedule),
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    lastStatus: row.last_status,
  };
};

export const createRoutines = (deps: {
  readonly config: Config;
  readonly db: Db;
  readonly bus: EventBus;
  readonly rooms: Orchestrator;
}): Routines => {
  const { config, db, bus, rooms } = deps;
  let timer: ReturnType<typeof setInterval> | undefined;

  const byId = (id: string): Routine | null => {
    const row = db.prepare("SELECT * FROM routines WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? null : parse(row);
  };

  const reschedule = (routine: Routine, now: number, status: string): void => {
    db.prepare(
      "UPDATE routines SET last_run_at = ?, next_run_at = ?, last_status = ? WHERE id = ?",
    ).run(now, nextRun(routine.schedule, now, now), status, routine.id);
  };

  const fire = (routine: Routine, now: number): string => {
    if (rooms.get(routine.roomId) === null) return "skipped: room is gone";

    const day = spendToday(db).tokens;
    if (day >= config.dailyTokenCeiling) return "skipped: daily ceiling";
    const week = spendWindow(db, 7).tokens;
    if (week >= config.weeklyTokenCeiling) return "skipped: weekly ceiling";

    rooms.post(routine.roomId, routine.prompt);
    bus.publish({ kind: "routineFired", routineId: routine.id, roomId: routine.roomId, name: routine.name });
    void now;
    return "ran";
  };

  const tick = (now = Date.now()): number => {
    const due = (
      db
        .prepare("SELECT * FROM routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?")
        .all(now) as Row[]
    ).map(parse);

    let fired = 0;
    for (const routine of due) {
      let status: string;
      try {
        status = fire(routine, now);
      } catch (error: unknown) {
        status = `failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (status === "ran") fired += 1;
      reschedule(routine, now, status);
    }
    return fired;
  };

  return {
    list: () =>
      (db.prepare("SELECT * FROM routines ORDER BY next_run_at").all() as Row[]).map(parse),
    get: byId,
    create: (input) => {
      const id = randomUUID();
      const now = Date.now();
      const schedule = normaliseSchedule(input.schedule);
      db.prepare(
        `INSERT INTO routines (id, name, room_id, prompt, schedule, enabled, next_run_at, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        id, input.name, input.roomId, input.prompt, JSON.stringify(schedule),
        input.enabled === false ? 0 : 1, nextRun(schedule, now, null), now,
      );
      return byId(id) as Routine;
    },
    update: (id, patch) => {
      const existing = byId(id);
      if (existing === null) return null;
      const schedule =
        patch.schedule === undefined ? existing.schedule : normaliseSchedule(patch.schedule);
      const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled;
      db.prepare(
        `UPDATE routines SET name = ?, room_id = ?, prompt = ?, schedule = ?, enabled = ?, next_run_at = ?
         WHERE id = ?`,
      ).run(
        patch.name ?? existing.name,
        patch.roomId ?? existing.roomId,
        patch.prompt ?? existing.prompt,
        JSON.stringify(schedule),
        enabled ? 1 : 0,
        enabled ? nextRun(schedule, Date.now(), existing.lastRunAt) : null,
        id,
      );
      return byId(id);
    },
    remove: (id) => db.prepare("DELETE FROM routines WHERE id = ?").run(id).changes > 0,
    runNow: (id) => {
      const routine = byId(id);
      if (routine === null) return false;
      const now = Date.now();
      const status = fire(routine, now);
      reschedule(routine, now, status);
      return status === "ran";
    },
    tick,
    start: () => {
      if (timer !== undefined) return;
      timer = setInterval(() => tick(), config.routineTickMs);
      timer.unref?.();
    },
    stop: () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
};
