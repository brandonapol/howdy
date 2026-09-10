export type Schedule =
  | { readonly kind: "interval"; readonly minutes: number }
  | { readonly kind: "daily"; readonly hour: number; readonly minute: number }
  | {
      readonly kind: "weekly";
      readonly weekday: number;
      readonly hour: number;
      readonly minute: number;
    };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const clamp = (n: number, low: number, high: number): number =>
  Number.isFinite(n) ? Math.min(high, Math.max(low, Math.trunc(n))) : low;

export const normaliseSchedule = (schedule: Schedule): Schedule => {
  switch (schedule.kind) {
    case "interval":
      return { kind: "interval", minutes: clamp(schedule.minutes, 5, 60 * 24 * 7) };
    case "daily":
      return {
        kind: "daily",
        hour: clamp(schedule.hour, 0, 23),
        minute: clamp(schedule.minute, 0, 59),
      };
    case "weekly":
      return {
        kind: "weekly",
        weekday: clamp(schedule.weekday, 0, 6),
        hour: clamp(schedule.hour, 0, 23),
        minute: clamp(schedule.minute, 0, 59),
      };
  }
};

const atLocal = (from: Date, hour: number, minute: number): number => {
  const target = new Date(from);
  target.setHours(hour, minute, 0, 0);
  return target.getTime();
};

export const nextRun = (
  schedule: Schedule,
  from: number,
  lastRunAt: number | null = null,
): number => {
  const spec = normaliseSchedule(schedule);

  if (spec.kind === "interval") {
    const step = spec.minutes * MINUTE;
    const base = lastRunAt ?? from;
    const next = base + step;
    return next > from ? next : from + step;
  }

  const start = new Date(from);
  if (spec.kind === "daily") {
    const today = atLocal(start, spec.hour, spec.minute);
    return today > from ? today : today + DAY;
  }

  const todayAt = atLocal(start, spec.hour, spec.minute);
  const currentDay = start.getDay();
  let ahead = (spec.weekday - currentDay + 7) % 7;
  if (ahead === 0 && todayAt <= from) ahead = 7;
  return todayAt + ahead * DAY;
};

export const isDue = (
  schedule: Schedule,
  now: number,
  lastRunAt: number | null,
  nextRunAt: number | null,
): boolean => {
  if (nextRunAt !== null) return now >= nextRunAt;
  return now >= nextRun(schedule, now - 1, lastRunAt);
};

export const describeSchedule = (schedule: Schedule): string => {
  const spec = normaliseSchedule(schedule);
  const pad = (n: number) => String(n).padStart(2, "0");
  switch (spec.kind) {
    case "interval":
      return spec.minutes % 60 === 0
        ? `every ${spec.minutes / 60}h`
        : `every ${spec.minutes}m`;
    case "daily":
      return `daily at ${pad(spec.hour)}:${pad(spec.minute)}`;
    case "weekly": {
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      return `${days[spec.weekday] ?? "Sunday"} at ${pad(spec.hour)}:${pad(spec.minute)}`;
    }
  }
};
