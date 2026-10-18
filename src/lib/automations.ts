/*
 * Automations: tasks Flash runs by itself, on a schedule or when its owner taps Run now. This file is
 * the spec every automation is saved as, shared by the page and the server: its types, the checks a
 * spec must pass (parseSpec, which rebuilds it from checked fields only), the runner version that
 * knows each step, and the sentences that say a schedule in the reader's language.
 *
 * PR 1a has two kinds of step: an AI step (Write, Research or Quick research at a level, priced exactly
 * as chat) and a notice in Flash. Every personal automation has an AI step for now, so no run is free
 * work on a cron. The engine is in server/automation-*.ts.
 */
import { msg, type Translate } from "./i18n.ts";
import { calendarDate, clockMinutes, hourlySlots, type When } from "./schedule.ts";

export type { When } from "./schedule.ts";

export type Trigger = { type: "schedule"; when: When } | { type: "manual" };

export type AiMode = "write" | "research" | "quick";
export type AiLevel = "sonic" | "ascend" | "vision" | "ultra";

type Base = { id: string; next?: string };
export type AiStep = Base & {
  do: "ai";
  mode: AiMode;
  level: AiLevel;
  prompt: string;
  data?: { filings?: true; economy?: true };
  onlyIfChanged?: true;
};
export type NotifyStep = Base & { do: "notify"; text?: string };
export type Step = AiStep | NotifyStep;

export type Spec = { v: 1; trigger: Trigger; steps: Step[] };

/** Raised whenever a PR adds a step kind or a trigger type, so an older deployment never runs a spec it doesn't know. */
export const RUNNER_VERSION = 1;
const STEP_RUNNER: Record<Step["do"], number> = { ai: 1, notify: 1 };
const TRIGGER_RUNNER: Record<Trigger["type"], number> = { schedule: 1, manual: 1 };

/** The oldest runner that knows every step and the trigger of a spec. */
export const runnerFor = (spec: Spec): number => Math.max(TRIGGER_RUNNER[spec.trigger.type], ...spec.steps.map((s) => STEP_RUNNER[s.do]));

export const MAX_SPEC_BYTES = 16_384;
export const MAX_STEPS = 12;
export const MAX_AI_STEPS = 3;
export const MAX_PROMPT_CHARS = 4000;
export const MAX_NOTIFY_CHARS = 2000;
export const MAX_NAME_CHARS = 80;
/** Ceilings per account, not plan features: automations on at once, and how many of them run more often than daily. */
export const MAX_ON = 25;
export const MAX_SUB_DAILY = 3;

/** How long a step may take; a step starts only when the work call has this much time left. */
export const STEP_BUDGET_MS: Record<AiMode | "notify", number> = { write: 180_000, research: 420_000, quick: 420_000, notify: 5_000 };
export const budgetOf = (step: Step) => STEP_BUDGET_MS[step.do === "ai" ? step.mode : step.do];
export const isPaid = (step: Step): step is AiStep => step.do === "ai";

/** The chat engine an AI step runs on: Write on text, Research and Quick research on search. */
export const engineOf = (step: AiStep) => (step.mode === "write" ? "text" : "search") as "text" | "search";

/** What an AI step answers with when "only if changed" is on and nothing important changed. */
export const NO_CHANGE = "NO_CHANGE";

// What parseSpec refuses with. Each is shown with t().
export const SPEC_INVALID = msg("Check this automation's steps and schedule, then try again.");
export const SPEC_NEEDS_AI = msg("Personal automations need an AI step for now.");
export const SPEC_HOURLY = msg("Automations can run at most once an hour.");
export const TOO_MANY_ON = msg("You have {count} automations on, the most for now.");
export const TOO_MANY_SUB_DAILY = msg("At most 3 automations can run more often than once a day.");
export const PRICE_CHANGED = msg("The price changed. Check the new price and try again.");
export const FINISHED = msg("This automation finished. It won't run again.");
export const ONCE_PASSED = msg("This automation's time has passed. Choose a new time to turn it on again.");
export const MONTH_LEFT = msg("Not enough of this month's limit ({credits} credits) is left for a run. It can run again on {date}.");
export const NO_CREDITS = msg("Not enough credits to start it: a run needs at least {credits} credits.");
export const QUEUED = msg("Queued: Flash is busy. It starts soon.");

/**
 * Flash's notices about runs: stored with their blanks and translated when read (see notifications.ts),
 * and the receipt's notes on a step or a run.
 */
export const NOTICES = {
  // The notice's title is the automation's name, so its line doesn't say it again.
  ready: msg("The latest result is ready"),
  nothingNew: msg("{name} found nothing new"),
  paused: msg("{name} is paused"),
  waitingCredits: msg("Waiting for credits: the next run needs up to {credits} credits. It starts again by itself once you have them."),
  topupFloor: msg("Skipped: this run would take you under your auto top-up level ({credits} credits). Automations never buy credits for you."),
  monthCap: msg("Paused until {date}: this month's {credits} credits are used"),
  priceUp: msg("Paused: a run now needs up to {credits} credits, more than its limit of {cap}."),
  interrupted: msg("Interrupted: Flash's server stopped part way. Charged {credits} credits for the work done."),
  missed: msg("Missed: Flash couldn't start it in time. Nothing was charged."),
  overlap: msg("Skipped: the previous run was still going."),
  runCap: msg("Stopped at this automation's limit of {credits} credits"),
  cutShort: msg("Cut short: it ran out of time"),
  failing: msg("Paused after 3 failed runs"),
  unconfirmed: msg("Confirm your email to use automations."),
  capacity: msg("Skipped: Flash's automation capacity for this month is reached. It runs again on {date}."),
  noCredits: msg("Not enough credits: the step that didn't fit wasn't run, and nothing was charged for it."),
  onceSkipped: msg("Skipped: it was over its limits when it was due, so it didn't run."),
} as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
/** Only these keys, so an unknown field (or one from a later PR) is refused, not dropped quietly. */
const onlyKeys = (o: Obj, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
const STEP_ID = /^[A-Za-z0-9_-]{1,12}$/;
const LEVELS: readonly AiLevel[] = ["sonic", "ascend", "vision", "ultra"];
const MODES: readonly AiMode[] = ["write", "research", "quick"];

export type Refusal = { error: string; blanks?: Record<string, string | number> };

function parseWhen(w: unknown): When | Refusal {
  const bad = { error: SPEC_INVALID };
  if (!isObj(w)) return bad;
  const at = (v: unknown) => (clockMinutes(v) === null ? null : (v as string));
  switch (w.kind) {
    case "once": {
      if (!onlyKeys(w, ["kind", "date", "at"]) || !calendarDate(w.date) || !at(w.at)) return bad;
      return { kind: "once", date: w.date as string, at: w.at as string };
    }
    case "daily": {
      if (!onlyKeys(w, ["kind", "at", "weekdays"]) || !at(w.at) || (w.weekdays !== undefined && w.weekdays !== true)) return bad;
      return { kind: "daily", at: w.at as string, ...(w.weekdays === true && { weekdays: true as const }) };
    }
    case "weekly": {
      if (!onlyKeys(w, ["kind", "days", "at"]) || !at(w.at) || !Array.isArray(w.days) || !w.days.length) return bad;
      const days = [...new Set(w.days)];
      if (days.length !== w.days.length || !days.every((d) => Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 7)) return bad;
      return { kind: "weekly", days: (days as number[]).sort((a, b) => a - b), at: w.at as string };
    }
    case "monthly": {
      if (!onlyKeys(w, ["kind", "day", "at"]) || !at(w.at)) return bad;
      if (w.day !== "last" && !(Number.isInteger(w.day) && (w.day as number) >= 1 && (w.day as number) <= 31)) return bad;
      return { kind: "monthly", day: w.day as number | "last", at: w.at as string };
    }
    case "hourly": {
      if (!onlyKeys(w, ["kind", "every", "from", "to"]) || !at(w.from) || !at(w.to)) return bad;
      if (typeof w.every !== "number" || !Number.isFinite(w.every)) return bad;
      // More often than hourly isn't offered.
      if (w.every < 1 || !Number.isInteger(w.every)) return { error: SPEC_HOURLY };
      if (w.every > 12 || clockMinutes(w.to)! < clockMinutes(w.from)!) return bad;
      const when = { kind: "hourly" as const, every: w.every, from: w.from as string, to: w.to as string };
      return hourlySlots(when).length ? when : bad;
    }
    default:
      return bad;
  }
}

/** The fields a template may fill: today's date, and in a notice, an earlier AI step's answer. */
const TEMPLATE = /\{\{\s*([^{}]*?)\s*\}\}/g;
function templatesOk(text: string, earlierAi: Set<string>, steps: boolean): boolean {
  for (const m of text.matchAll(TEMPLATE)) {
    const field = m[1];
    if (field === "today") continue;
    const step = /^steps\.([A-Za-z0-9_-]{1,12})\.text$/.exec(field);
    if (steps && step && earlierAi.has(step[1])) continue;
    return false;
  }
  // A lone brace pair that isn't a field is refused too, so nothing renders unexpectedly.
  return !/\{\{|\}\}/.test(text.replace(TEMPLATE, ""));
}

/** Fills a template's fields; an unknown field renders as nothing. */
export function fillTemplate(text: string, fields: { today: string; steps: Record<string, string> }): string {
  return text.replace(TEMPLATE, (_, field: string) => {
    if (field === "today") return fields.today;
    const step = /^steps\.([A-Za-z0-9_-]{1,12})\.text$/.exec(field);
    return step ? (fields.steps[step[1]] ?? "") : "";
  });
}

function parseStep(s: unknown, earlierAi: Set<string>): Step | Refusal {
  const bad = { error: SPEC_INVALID };
  if (!isObj(s) || typeof s.id !== "string" || !STEP_ID.test(s.id)) return bad;
  if (s.next !== undefined && typeof s.next !== "string") return bad;
  const base: Base = { id: s.id, ...(typeof s.next === "string" && { next: s.next }) };
  if (s.do === "ai") {
    if (!onlyKeys(s, ["id", "next", "do", "mode", "level", "prompt", "data", "onlyIfChanged"])) return bad;
    if (!MODES.includes(s.mode as AiMode) || !LEVELS.includes(s.level as AiLevel)) return bad;
    const prompt = typeof s.prompt === "string" ? s.prompt.trim() : "";
    if (!prompt || prompt.length > MAX_PROMPT_CHARS || !templatesOk(prompt, earlierAi, false)) return bad;
    let data: AiStep["data"];
    if (s.data !== undefined) {
      if (!isObj(s.data) || !onlyKeys(s.data, ["filings", "economy"])) return bad;
      if ((s.data.filings !== undefined && s.data.filings !== true) || (s.data.economy !== undefined && s.data.economy !== true)) return bad;
      data = { ...(s.data.filings === true && { filings: true as const }), ...(s.data.economy === true && { economy: true as const }) };
      if (!Object.keys(data).length) data = undefined;
    }
    if (s.onlyIfChanged !== undefined && s.onlyIfChanged !== true) return bad;
    return {
      ...base,
      do: "ai",
      mode: s.mode as AiMode,
      level: s.level as AiLevel,
      prompt,
      ...(data && { data }),
      ...(s.onlyIfChanged === true && { onlyIfChanged: true as const }),
    };
  }
  if (s.do === "notify") {
    if (!onlyKeys(s, ["id", "next", "do", "text"])) return bad;
    if (s.text !== undefined && typeof s.text !== "string") return bad;
    const text = typeof s.text === "string" ? s.text.trim() : "";
    if (text.length > MAX_NOTIFY_CHARS || !templatesOk(text, earlierAi, true)) return bad;
    return { ...base, do: "notify", ...(text && { text }) };
  }
  // Every other kind of step comes with a later PR.
  return bad;
}

/**
 * Checks a spec from the page (or a stored one) and rebuilds it from checked fields only. Refuses
 * unknown types and keys, kinds of steps and triggers that come in later PRs, a spec over 16 KB, more
 * than 12 steps or 3 AI steps, text over its limit, a next step that isn't later in the list (so every
 * run ends), a template field that doesn't exist, and a personal automation with no AI step.
 */
export function parseSpec(input: unknown): { spec: Spec } | Refusal {
  const bad = { error: SPEC_INVALID };
  if (!isObj(input) || input.v !== 1 || !onlyKeys(input, ["v", "trigger", "steps"])) return bad;
  if (new TextEncoder().encode(JSON.stringify(input)).length > MAX_SPEC_BYTES) return bad;
  const tr = input.trigger;
  let trigger: Trigger;
  if (isObj(tr) && tr.type === "manual" && onlyKeys(tr, ["type"])) trigger = { type: "manual" };
  else if (isObj(tr) && tr.type === "schedule" && onlyKeys(tr, ["type", "when"])) {
    const when = parseWhen(tr.when);
    if ("error" in when) return when;
    trigger = { type: "schedule", when };
  } else return bad;
  if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > MAX_STEPS) return bad;
  const steps: Step[] = [];
  const earlierAi = new Set<string>();
  for (const raw of input.steps) {
    const step = parseStep(raw, earlierAi);
    if ("error" in step) return step;
    if (steps.some((s) => s.id === step.id)) return bad;
    steps.push(step);
    if (step.do === "ai") earlierAi.add(step.id);
  }
  // A next step must come later in the list, so a run can't loop and always ends.
  for (const [i, s] of steps.entries()) {
    if (s.next !== undefined && !steps.slice(i + 1).some((later) => later.id === s.next)) return bad;
  }
  const ai = steps.filter(isPaid).length;
  if (ai === 0) return { error: SPEC_NEEDS_AI };
  if (ai > MAX_AI_STEPS) return bad;
  return { spec: { v: 1, trigger, steps } };
}

/** Where a run is once its last step is done: not a step id (those are letters, digits, _ and -). */
export const END_STEP = ".";

/** The step a run is at: its id, the first step for "", or null at the end. */
export const stepAt = (spec: Spec, id: string): Step | null => (id === "" ? (spec.steps[0] ?? null) : (spec.steps.find((s) => s.id === id) ?? null));

/** The step after one: its next, or the one below it in the list (END_STEP after the last). */
export function nextStepId(spec: Spec, step: Step): string {
  if (step.next) return step.next;
  const i = spec.steps.findIndex((s) => s.id === step.id);
  return spec.steps[i + 1]?.id ?? END_STEP;
}

// The sentences that say when a schedule runs.
const WHEN_WORDS = {
  once: msg("Once, on {date} at {time}"),
  daily: msg("Every day at {time}"),
  weekdays: msg("Weekdays at {time}"),
  weekly: msg("Every {days} at {time}"),
  monthly: msg("On day {day} of every month at {time}"),
  last: msg("On the last day of every month at {time}"),
  hourly: msg("Every {hours} hours from {from} to {to}"),
  everyHour: msg("Every hour from {from} to {to}"),
  next: msg("Next: {dates}"),
  around: msg("around {time}"),
};

/** A local "HH:MM" as the reader's language writes a time of day. */
export function clockText(at: string, locale: string): string {
  const m = clockMinutes(at) ?? 0;
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(Date.UTC(2000, 0, 1, Math.floor(m / 60), m % 60));
}

/** An ISO weekday (1 Monday … 7 Sunday) as the reader's language names it. */
const weekdayName = (day: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(Date.UTC(2024, 0, day));

/** A zone's name in the reader's language ("Eastern Time"), never a Latin city id inside other scripts. */
export function zoneName(timeZone: string, locale: string, at = Date.now()): string {
  try {
    const part = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "longGeneric" }).formatToParts(at).find((p) => p.type === "timeZoneName");
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** When a schedule runs, in the reader's language, with the zone it runs on. */
export function describeWhen(when: When, timeZone: string, t: Translate, locale: string): { sentence: string; zone: string } {
  const time = when.kind === "hourly" ? "" : clockText(when.at, locale);
  let sentence: string;
  if (when.kind === "once") {
    const [y, m, d] = calendarDate(when.date) ?? [2000, 1, 1];
    const date = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(Date.UTC(y, m - 1, d));
    sentence = t(WHEN_WORDS.once, { date, time });
  } else if (when.kind === "daily") {
    sentence = t(when.weekdays ? WHEN_WORDS.weekdays : WHEN_WORDS.daily, { time });
  } else if (when.kind === "weekly") {
    const days = new Intl.ListFormat(locale, { type: "conjunction" }).format(when.days.map((d) => weekdayName(d, locale)));
    sentence = t(WHEN_WORDS.weekly, { days, time });
  } else if (when.kind === "monthly") {
    sentence = when.day === "last" ? t(WHEN_WORDS.last, { time }) : t(WHEN_WORDS.monthly, { day: when.day, time });
  } else {
    const from = clockText(when.from, locale);
    const to = clockText(when.to, locale);
    sentence = when.every === 1 ? t(WHEN_WORDS.everyHour, { from, to }) : t(WHEN_WORDS.hourly, { hours: when.every, from, to });
  }
  return { sentence, zone: zoneName(timeZone, locale) };
}

/** A run time in the reader's language and the automation's zone ("Mon, Oct 20, 8:00 AM"). */
export const runTimeText = (utcMs: number, timeZone: string, locale: string) =>
  new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(utcMs);

/** "Next: …" for the next few run times. */
export function describeNext(times: number[], timeZone: string, t: Translate, locale: string): string {
  // Each time has commas of its own ("Tue, Oct 20, 8:00 AM"), so they are set apart with a middle dot.
  const dates = times.map((x) => runTimeText(x, timeZone, locale)).join(" · ");
  return t(WHEN_WORDS.next, { dates });
}

/** "around 8:00 AM": a run starts in its minute or the next, as Vercel Cron is best effort. */
export const aroundText = (utcMs: number, timeZone: string, t: Translate, locale: string) =>
  t(WHEN_WORDS.around, { time: new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }).format(utcMs) });
