/*
 * When an automation's schedule runs (see automations.ts), worked out from the time zone's own rules
 * through Intl, with no package and no clock of its own: every function takes the moment to count from.
 *
 * A local time is turned into UTC the way Temporal calls "compatible": a time that doesn't exist (the
 * hour skipped when clocks spring forward) runs later by the gap, so 02:30 runs at 03:30; a time that
 * happens twice (clocks fall back) runs once, at the first. Day 31 in a shorter month is that month's
 * last day. Hourly windows are counted in local time.
 */

export type When =
  | { kind: "once"; date: string; at: string }
  | { kind: "daily"; at: string; weekdays?: true }
  | { kind: "weekly"; days: number[]; at: string }
  | { kind: "monthly"; day: number | "last"; at: string }
  | { kind: "hourly"; every: number; from: string; to: string };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** At least this long between two runs of one automation, and at most this many runs a day. */
export const MIN_GAP_MS = HOUR;
export const MAX_RUNS_A_DAY = 24;
/** A one-off run is set at least this far ahead, and at most a year. */
export const ONCE_MIN_AHEAD_MS = 2 * MINUTE;
export const ONCE_MAX_AHEAD_MS = 366 * DAY;

/** "HH:MM" as minutes after midnight, or null. */
export function clockMinutes(at: unknown): number | null {
  if (typeof at !== "string") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** "YYYY-MM-DD" as [year, month, day], or null when it isn't a real date. */
export function calendarDate(date: unknown): [number, number, number] | null {
  if (typeof date !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return null;
  return [y, mo, d];
}

/** Days in a month (1-12) of a year. */
export const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

const formats = new Map<string, Intl.DateTimeFormat>();
function partsFormat(timeZone: string): Intl.DateTimeFormat {
  let f = formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formats.set(timeZone, f);
  }
  return f;
}

/** The wall clock in a zone at a moment: year, month (1-12), day, hour, minute, and the ISO weekday (1 Monday … 7 Sunday). */
export function wallClock(utcMs: number, timeZone: string) {
  const parts: Record<string, number> = {};
  for (const p of partsFormat(timeZone).formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const { year, month, day, hour, minute, second } = parts as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
  const weekday = ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
  return { year, month, day, hour: hour % 24, minute, second, weekday };
}

/** How far a zone's clock is ahead of UTC at a moment, in ms (whole seconds, as zones are). */
function offsetAt(utcMs: number, timeZone: string): number {
  const w = wallClock(utcMs, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The moment a local date and time happens in a zone ("compatible"): the first of two when clocks fall
 * back, and later by the gap when they spring forward over it.
 */
export function localToUtc(year: number, month: number, day: number, minutes: number, timeZone: string): number {
  return localTimes(year, month, day, minutes, timeZone)[0];
}

/** Each moment a local date and time happens in a zone, in order: two when clocks fall back over it. */
function localTimes(year: number, month: number, day: number, minutes: number, timeZone: string): number[] {
  const wall = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  // The offsets a day either side of it: one of them is in force at that local time, or both are (twice).
  const before = wall - offsetAt(wall - DAY, timeZone);
  const after = wall - offsetAt(wall + DAY, timeZone);
  const fits = (t: number) => t + offsetAt(t, timeZone) === wall;
  const found = [...new Set([before, after].filter(fits))].sort((a, b) => a - b);
  // In the gap: with the offset from before it, the clock reads the same time plus the gap.
  return found.length ? found : [before];
}

/** A local date (a wall clock's), moved by some days, as [year, month, day]. */
function localDate(w: { year: number; month: number; day: number }, addDays = 0): [number, number, number] {
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day + addDays));
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

const isoWeekday = (y: number, m: number, d: number) => ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;

/** The local times an hourly window runs at, in minutes after midnight. */
export function hourlySlots(when: { every: number; from: string; to: string }): number[] {
  const from = clockMinutes(when.from);
  const to = clockMinutes(when.to);
  if (from === null || to === null || to < from || !(when.every >= 1)) return [];
  const slots: number[] = [];
  for (let m = from; m <= to && slots.length < MAX_RUNS_A_DAY; m += when.every * 60) slots.push(m);
  return slots;
}

/** Every run time of a schedule on one local date, in UTC, in order and without repeats. */
function onDate(when: When, timeZone: string, [y, m, d]: [number, number, number]): number[] {
  const at = when.kind === "hourly" ? null : clockMinutes(when.at);
  let times: number[] = [];
  if (when.kind === "daily") {
    if (!when.weekdays || isoWeekday(y, m, d) <= 5) times = [at!];
  } else if (when.kind === "weekly") {
    if (when.days.includes(isoWeekday(y, m, d))) times = [at!];
  } else if (when.kind === "monthly") {
    const last = daysIn(y, m);
    const target = when.day === "last" ? last : Math.min(when.day, last);
    if (d === target) times = [at!];
  } else if (when.kind === "hourly") {
    times = hourlySlots(when);
  } else if (when.kind === "once") {
    const date = calendarDate(when.date);
    if (date && date[0] === y && date[1] === m && date[2] === d) times = [at!];
  }
  const utc = [...new Set(times.filter((t) => t !== null).map((t) => localToUtc(y, m, d, t, timeZone)))].sort((a, b) => a - b);
  if (when.kind !== "hourly") return utc;
  // When the clocks spring forward between two hourly slots, they can land on one moment, or closer
  // than MIN_GAP_MS (Lord Howe moves by 30 minutes): the later one is left out.
  const kept: number[] = [];
  for (const t of utc) if (!kept.length || t - kept.at(-1)! >= MIN_GAP_MS) kept.push(t);
  return kept;
}

/** How many local days to look ahead for a schedule's next run. */
const horizon = (when: When) => (when.kind === "monthly" ? 400 : when.kind === "once" ? 0 : 9);

/**
 * The first moment after afterUtc that a schedule runs, in UTC ms, or 0 when it never runs again
 * (a one-off that is past). Worked out again after every run and every edit.
 */
export function nextFire(when: When, timeZone: string, afterUtc: number): number {
  return nextFireIn(when, timeZone, afterUtc, new Map());
}

/** nextFire, with each local date's run times kept in days, so a chain of calls works each date out once. */
function nextFireIn(when: When, timeZone: string, afterUtc: number, days: Map<number, number[]>): number {
  if (when.kind === "once") {
    const date = calendarDate(when.date);
    const at = clockMinutes(when.at);
    if (!date || at === null) return 0;
    // A time that happens twice (clocks falling back) is the first still ahead: one saved in the
    // repeated hour runs in it. It still runs once (see nextFires and firesBetween).
    return localTimes(date[0], date[1], date[2], at, timeZone).find((t) => t > afterUtc) ?? 0;
  }
  // From the day before (a zone behind UTC may still be on it), until one is found.
  const today = wallClock(afterUtc, timeZone);
  for (let i = -1; i <= horizon(when); i++) {
    const date = localDate(today, i);
    const key = date[0] * 10_000 + date[1] * 100 + date[2];
    let times = days.get(key);
    if (!times) days.set(key, (times = onDate(when, timeZone, date)));
    for (const t of times) if (t > afterUtc) return t;
  }
  return 0;
}

/** The next few run times after a moment (at most count), for "Next:" and the month's estimate. */
export function nextFires(when: When, timeZone: string, afterUtc: number, count: number): number[] {
  const out: number[] = [];
  const days = new Map<number, number[]>();
  let t = afterUtc;
  while (out.length < (when.kind === "once" ? Math.min(count, 1) : count)) {
    t = nextFireIn(when, timeZone, t, days);
    if (!t) break;
    out.push(t);
  }
  return out;
}

/** How many times a schedule runs between two moments (at most 24 a day; each local date is worked out once). */
export function firesBetween(when: When, timeZone: string, fromUtc: number, toUtc: number): number {
  if (when.kind === "once") {
    const t = nextFire(when, timeZone, fromUtc);
    return t && t <= toUtc ? 1 : 0;
  }
  let n = 0;
  const days = new Map<number, number[]>();
  for (let t = nextFireIn(when, timeZone, fromUtc, days); t && t <= toUtc; t = nextFireIn(when, timeZone, t, days)) n++;
  return n;
}

/** How long after its slot a run may still start before it counts as missed (for free). */
export function graceFor(when: When): number {
  if (when.kind === "hourly") return 15 * MINUTE;
  if (when.kind === "once") return DAY;
  return 3 * HOUR;
}

/** Whether a schedule runs more often than once a day (at most 3 such automations per account). */
export const subDaily = (when: When) => when.kind === "hourly" && hourlySlots(when).length > 1;

/** 00:00 UTC on the first of the month after a moment: when month limits start again. */
export function nextMonthStart(utcMs: number): number {
  const d = new Date(utcMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** 00:00 UTC on the first of a moment's own month. */
export function monthStart(utcMs: number): number {
  const d = new Date(utcMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** The UTC day of a moment, as YYYY-MM-DD. */
export const utcDay = (utcMs: number) => new Date(utcMs).toISOString().slice(0, 10);
