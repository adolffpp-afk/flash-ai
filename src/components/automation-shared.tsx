"use client";

import { msg } from "@/lib/i18n";
import { api } from "@/lib/store";
import type { T } from "@/lib/use-t";
import type { automationView, receipt } from "@/lib/server/automation-api.ts";
import type { Estimate } from "@/lib/server/automation-estimate.ts";

/*
 * What the Automations panel, its editor and its receipts share: the shapes the routes answer with,
 * the API call that keeps a new price on a refusal, and a few small pieces of the page.
 */

export type AutomationView = Awaited<ReturnType<typeof automationView>>;
export type RunListItem = {
  id: string;
  status: string;
  outcome: string;
  origin: string;
  credits: number;
  refunded: number;
  summary: string;
  scheduledAt: number;
  startedAt: number;
  finishedAt: number;
  createdAt: number;
  seen: boolean;
};
export type Receipt = NonNullable<Awaited<ReturnType<typeof receipt>>>;
export type Priced = { estimate: Estimate; schedule: { sentence: string; zone: string } | null; next: string };

export type Failed = Error & { status?: number; code?: string; estimate?: Estimate; credits?: number };

/**
 * A call to Flash's API (GET without json). A refusal throws with its code and, for price_changed, the
 * new estimate (or, for a description, the new price in credits).
 */
export async function call<R>(path: string, init?: { method?: string; json?: unknown }): Promise<R> {
  try {
    return await api<R>(path, init);
  } catch (err) {
    const data = (err as { data?: { estimate?: Estimate; credits?: unknown } }).data;
    throw Object.assign(err as Failed, { estimate: data?.estimate, credits: typeof data?.credits === "number" ? data.credits : undefined });
  }
}

export const errorOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The browser's time zone, or UTC when it can't say. */
export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** A run's or automation's state in the reader's words. */
export const STATUS_WORDS: Record<string, string> = {
  on: msg("On"),
  paused: msg("Paused"),
  draft: msg("Draft"),
  finished: msg("Finished"),
  done: msg("Done"),
  running: msg("Running"),
  queued: msg("Queued"),
  waiting: msg("Waiting"),
  failed: msg("Failed"),
  interrupted: msg("Interrupted"),
  stopped: msg("Stopped"),
  skipped: msg("Skipped"),
  nothing_new: msg("Nothing new"),
};

/** What a run shows as its state: "Nothing new" for a run that found nothing, else its status. */
export const runState = (r: { status: string; outcome: string }) => (r.status === "done" && r.outcome === "nothing_new" ? "nothing_new" : r.status);

const TONES: Record<string, string> = {
  on: "bg-emerald-400/10 text-emerald-300 light:bg-emerald-50 light:text-emerald-700",
  done: "bg-emerald-400/10 text-emerald-300 light:bg-emerald-50 light:text-emerald-700",
  failed: "bg-red-400/10 text-red-300 light:bg-red-50 light:text-red-700",
  interrupted: "bg-red-400/10 text-red-300 light:bg-red-50 light:text-red-700",
  running: "bg-sky-400/10 text-sky-300 light:bg-sky-50 light:text-sky-700",
  queued: "bg-sky-400/10 text-sky-300 light:bg-sky-50 light:text-sky-700",
  waiting: "bg-amber-400/15 text-amber-300 light:bg-amber-50 light:text-amber-700",
  paused: "bg-amber-400/15 text-amber-300 light:bg-amber-50 light:text-amber-700",
};

/** A state as a small badge: green on or done, blue going, amber waiting or paused, red failed, grey the rest. */
export function StateBadge({ state, t }: { state: string; t: T }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${TONES[state] ?? "bg-white/[0.07] text-zinc-400"}`}>
      {STATUS_WORDS[state] ? t(STATUS_WORDS[state]) : state}
    </span>
  );
}

/** An on/off switch with its name for screen readers. */
/** A switch; describedBy names the words that say more about it, and busy keeps it (and the focus) while its change goes through. */
export function Switch({
  on,
  onChange,
  label,
  disabled,
  describedBy,
  busy,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  disabled?: boolean;
  describedBy?: string;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-describedby={describedBy}
      aria-disabled={busy || undefined}
      disabled={disabled}
      onClick={() => !busy && onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 aria-disabled:opacity-50 ${on ? "bg-primary" : "bg-zinc-700"}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-paper shadow transition-all ${on ? "start-[22px]" : "start-0.5"}`} />
    </button>
  );
}

/** A number of credits in the reader's digits. */
export const n = (t: T, value: number) => value.toLocaleString(t.locale);

/** "1 credit" or "4 credits", in the reader's language. */
export const creditsText = (t: T, value: number) => (value === 1 ? t("1 credit") : t("{count} credits", { count: n(t, value) }));

/** A moment in the reader's language, in a zone ("Mon, Oct 20, 8:00 AM"). */
export function at(t: T, ms: number, timeZone?: string) {
  if (!ms) return "";
  try {
    return new Intl.DateTimeFormat(t.locale, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...(timeZone && { timeZone }) }).format(ms);
  } catch {
    return new Date(ms).toLocaleString();
  }
}

/** How long something took, in the reader's words ("1 min 40 s"). */
export function took(t: T, from: number, to: number) {
  if (!from || !to || to < from) return "";
  // A run quicker than a second still took one: never an empty duration.
  const s = Math.max(1, Math.round((to - from) / 1000));
  try {
    const parts = s < 60 ? { seconds: s } : { minutes: Math.floor(s / 60), seconds: s % 60 };
    // DurationFormat where the browser has it; else minutes and seconds with their units.
    const DF = (Intl as unknown as { DurationFormat?: new (l: string, o: object) => { format: (d: object) => string } }).DurationFormat;
    if (DF) return new DF(t.locale, { style: "short" }).format(parts);
  } catch {
    // Falls through to the plain form.
  }
  const unit = (value: number, u: "minute" | "second") => new Intl.NumberFormat(t.locale, { style: "unit", unit: u, unitDisplay: "short" }).format(value);
  return s < 60 ? unit(s, "second") : `${unit(Math.floor(s / 60), "minute")} ${unit(s % 60, "second")}`;
}

/** Saves text as a file the browser downloads. */
export function saveFile(name: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const primaryButton = "rounded-full bg-brand px-4 py-2 text-sm font-medium text-on-brand transition hover:brightness-110 disabled:opacity-50";
export const quietButton = "rounded-full border border-white/10 px-4 py-2 text-sm text-zinc-200 transition hover:bg-white/[0.06] disabled:opacity-50";
export const smallButton = "rounded-full border border-white/10 px-3 py-1.5 text-xs text-zinc-200 transition hover:bg-white/[0.06] disabled:opacity-50";
export const fieldBox = "block w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-primary/60";
