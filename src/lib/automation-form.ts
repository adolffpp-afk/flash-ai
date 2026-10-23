/*
 * The Automations editor's form and the spec it saves, both ways, and the templates the empty panel
 * offers. Pure, shared by the page and the tests: the server checks every spec again (parseSpec).
 *
 * A personal automation is one AI step (Write, Research or Quick research at a level) and a notice in
 * Flash with its result, on a schedule or run by hand. Later PRs add more kinds of steps; a spec this
 * form can't show (formFromSpec answers null) is never rewritten by it.
 */
import { MAX_NAME_CHARS, MAX_PROMPT_CHARS, type AiLevel, type AiMode, type Spec } from "./automations.ts";
import { msg } from "./i18n.ts";
import { wallClock, type When } from "./schedule.ts";

/** How often it runs, as the form's first choice: once, on a repeat, every few hours, or only when its owner runs it. */
export type Repeat = "once" | "daily" | "weekdays" | "weekly" | "monthly" | "hourly" | "manual";

export type AutomationForm = {
  name: string;
  prompt: string;
  mode: AiMode;
  level: AiLevel;
  // Company filings (SEC) and, where Flash has them, economic data (FRED), as chat uses them.
  data: boolean;
  onlyIfChanged: boolean;
  repeat: Repeat;
  // A one-off's day, "YYYY-MM-DD", in the automation's zone.
  date: string;
  // The local time it runs at, "HH:MM" (not for every few hours).
  at: string;
  // Weekly: ISO weekdays, 1 Monday … 7 Sunday.
  days: number[];
  // Monthly: the day of the month, or the last day.
  day: number | "last";
  // Every few hours: how many hours apart, from and to (local "HH:MM").
  every: number;
  from: string;
  to: string;
  timeZone: string;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** A new automation's form: every day at 8:00 in the browser's zone, Write at Ascend; a one-off is set to tomorrow. */
export function blankForm(timeZone: string, now = Date.now()): AutomationForm {
  const tomorrow = wallClock(now + 86_400_000, timeZone);
  return {
    name: "",
    prompt: "",
    mode: "write",
    level: "ascend",
    data: false,
    onlyIfChanged: false,
    repeat: "daily",
    date: `${tomorrow.year}-${pad(tomorrow.month)}-${pad(tomorrow.day)}`,
    at: "08:00",
    days: [tomorrow.weekday],
    day: 1,
    every: 4,
    from: "08:00",
    to: "20:00",
    timeZone,
  };
}

// A name made from someone's words is at most this long, cut at a word.
const WORDS_NAME_CHARS = 48;

/**
 * A name from someone's own words: their first sentence without its end mark ("What changed this week
 * in home solar"), on one line, cut at a word with "…" when it is long. A "." ends a sentence only
 * before a space, so "example.com" and "3.5" stay whole.
 */
export function nameFromWords(words: string) {
  const line = words.replace(/\s+/g, " ").trim();
  const first = line.split(/(?<=[.!?؟])\s+|(?<=[。！？])/u)[0].replace(/[\s.!?؟。！？]+$/u, "") || line;
  if (first.length <= WORDS_NAME_CHARS) return first;
  const cut = first.slice(0, WORDS_NAME_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > WORDS_NAME_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[\s,،:;]+$/u, "")}…`;
}

/**
 * "Automate this" under a chat answer: what was asked becomes what Flash does every day (Research when
 * the answer searched the web, else Write), for its owner to check before saving. Nothing is sent to
 * the AI to fill it in.
 */
export function formFromChat(asked: string, engine: "text" | "search", timeZone: string, now = Date.now()): AutomationForm {
  return { ...blankForm(timeZone, now), name: nameFromWords(asked), prompt: asked.trim().slice(0, MAX_PROMPT_CHARS), mode: engine === "search" ? "research" : "write" };
}

/** When the form says it runs, as a spec's schedule (null when its owner runs it). */
export function whenOfForm(f: AutomationForm): When | null {
  switch (f.repeat) {
    case "once":
      return { kind: "once", date: f.date, at: f.at };
    case "daily":
      return { kind: "daily", at: f.at };
    case "weekdays":
      return { kind: "daily", at: f.at, weekdays: true };
    case "weekly":
      return { kind: "weekly", days: [...new Set(f.days)].sort((a, b) => a - b), at: f.at };
    case "monthly":
      return { kind: "monthly", day: f.day, at: f.at };
    case "hourly":
      return { kind: "hourly", every: f.every, from: f.from, to: f.to };
    default:
      return null;
  }
}

/**
 * The spec a form saves: its AI step, then a notice in Flash with the result. economy: whether
 * economic data can be used here (FRED); filings always can.
 */
export function specFromForm(f: AutomationForm, o: { economy: boolean }): Spec {
  const when = whenOfForm(f);
  return {
    v: 1,
    trigger: when ? { type: "schedule", when } : { type: "manual" },
    steps: [
      {
        id: "a1",
        do: "ai",
        mode: f.mode,
        level: f.level,
        prompt: f.prompt.trim().slice(0, MAX_PROMPT_CHARS),
        ...(f.data && { data: { filings: true as const, ...(o.economy && { economy: true as const }) } }),
        ...(f.onlyIfChanged && { onlyIfChanged: true as const }),
      },
      { id: "n1", do: "notify" },
    ],
  };
}

/**
 * A saved automation as the form shows it, or null when it has steps this form doesn't edit (one AI
 * step and notices only), so the editor never saves it as something else.
 */
export function formFromSpec(spec: Spec, name: string, timeZone: string, now = Date.now()): AutomationForm | null {
  const ai = spec.steps.filter((s) => s.do === "ai");
  if (ai.length !== 1 || spec.steps.some((s) => s.do === "notify" && s.text)) return null;
  const step = ai[0];
  const f: AutomationForm = {
    ...blankForm(timeZone, now),
    name,
    prompt: step.prompt,
    mode: step.mode,
    level: step.level,
    data: Boolean(step.data),
    onlyIfChanged: Boolean(step.onlyIfChanged),
  };
  if (spec.trigger.type === "manual") return { ...f, repeat: "manual" };
  const w = spec.trigger.when;
  switch (w.kind) {
    case "once":
      return { ...f, repeat: "once", date: w.date, at: w.at };
    case "daily":
      return { ...f, repeat: w.weekdays ? "weekdays" : "daily", at: w.at };
    case "weekly":
      return { ...f, repeat: "weekly", days: [...w.days], at: w.at };
    case "monthly":
      return { ...f, repeat: "monthly", day: w.day, at: w.at };
    case "hourly":
      return { ...f, repeat: "hourly", every: w.every, from: w.from, to: w.to };
  }
}

/** Why a form can't be saved yet, as a phrase for t(), or "" when it can. */
export const NEEDS_NAME = msg("Give it a name.");
export const NEEDS_PROMPT = msg("Say what Flash should do.");
export const NEEDS_DAYS = msg("Choose at least one day.");
export const HOURS_ORDER = msg("The last run has to come after the first.");
export function formProblem(f: AutomationForm): string {
  if (!f.name.trim() || f.name.trim().length > MAX_NAME_CHARS) return NEEDS_NAME;
  if (!f.prompt.trim()) return NEEDS_PROMPT;
  if (f.repeat === "weekly" && !f.days.length) return NEEDS_DAYS;
  if (f.repeat === "hourly" && f.to < f.from) return HOURS_ORDER;
  return "";
}

/** A template the empty panel offers: what it fills in, and what it needs to work here. */
export type AutomationTemplate = {
  id: string;
  title: string;
  about: string;
  prompt: string;
  fill: Partial<AutomationForm>;
  // The tool it runs on (shown only while it is live), and economic data (FRED) for the economy one.
  needs: "text" | "search";
  economy?: true;
};

/** Templates that work today; each instruction has a part in brackets for the owner to fill in. */
export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: "weekly-research",
    title: msg("Weekly research summary"),
    about: msg("Every Monday, what changed this week on a topic, with sources"),
    prompt: msg("Research the most important news and developments of the past week about [your topic]. Summarize them in 5 short points, each with its source."),
    fill: { mode: "research", level: "ascend", repeat: "weekly", days: [1], at: "08:00" },
    needs: "search",
  },
  {
    id: "daily-news",
    title: msg("Daily news on a topic"),
    about: msg("Every morning, the day's top news in a few lines"),
    prompt: msg("Give me today's top news about [your topic] in 3 to 5 short points, with sources."),
    fill: { mode: "quick", level: "ascend", repeat: "daily", at: "07:30" },
    needs: "search",
  },
  {
    id: "page-watch",
    title: msg("Check a page and tell me what's new"),
    about: msg("Looks at a page every day and tells you only when it changed"),
    prompt: msg("Check [page address] and tell me what's new there since the last check."),
    fill: { mode: "quick", level: "ascend", repeat: "daily", at: "09:00", onlyIfChanged: true },
    needs: "search",
  },
  {
    id: "economy",
    title: msg("Monthly economy numbers"),
    about: msg("On the 1st, the latest inflation, jobs and interest rate numbers"),
    prompt: msg("Summarize the latest US economic numbers (inflation, unemployment, interest rates and GDP growth), what changed since last month, and what it may mean for [your business or savings]."),
    fill: { mode: "research", level: "ascend", repeat: "monthly", day: 1, at: "09:00", data: true },
    needs: "search",
    economy: true,
  },
];
