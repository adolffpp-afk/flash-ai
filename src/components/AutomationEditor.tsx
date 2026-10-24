"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AUTOMATION_TEMPLATES,
  blankForm,
  formFromSpec,
  formProblem,
  specFromForm,
  type AutomationForm,
  type AutomationTemplate,
  type Repeat,
} from "@/lib/automation-form";
import { zoneName, type AiLevel, type AiMode } from "@/lib/automations";
import { msg } from "@/lib/i18n";
import { LEVELS } from "@/lib/levels";
import { pushStatus, turnOffPush, turnOnPush, type PushStatus } from "@/lib/push";
import { useT } from "@/lib/use-t";
import { LevelIcon } from "./LevelIcon";
import { browserZone, call, errorOf, fieldBox, n, primaryButton, quietButton, Switch, type AutomationView, type Failed, type Priced } from "./automation-shared";

/*
 * The Automations editor: a form, free to use. What Flash should do, when, how (Write, Research or
 * Quick research at a level, with company filings and economic data when useful, and "only tell me
 * when something changed"), the limits, and the price the server works out for it before anything is
 * saved. Turn on, Run once now and Save send the price the person saw (seenMax): when it went up
 * since, the server answers price_changed with the new one, which shows here to be pressed again.
 * Where results go: always Automations and the bell, and as alerts on this device (the account's
 * switch in Settings, see push.ts) and by email when asked ("Email me each result", see
 * automation-alerts.ts).
 */

const REPEATS: { id: Repeat; label: string }[] = [
  { id: "once", label: msg("Once") },
  { id: "daily", label: msg("Every day") },
  { id: "weekdays", label: msg("Weekdays") },
  { id: "weekly", label: msg("Every week") },
  { id: "monthly", label: msg("Every month") },
  { id: "hourly", label: msg("Every few hours") },
  { id: "manual", label: msg("Only when I run it") },
];
const MODES: { id: AiMode; label: string; about: string }[] = [
  { id: "write", label: msg("Write"), about: msg("Writes from what it knows, without searching") },
  { id: "research", label: msg("Research"), about: msg("Searches the web and reads pages, with sources") },
  { id: "quick", label: msg("Quick research"), about: msg("A few searches, for short answers") },
];
const MODEL_LEVELS = LEVELS.filter((l) => l.id !== "auto") as unknown as { id: AiLevel; short: string; blurb: string }[];

/** Every time zone the browser knows, named in the reader's language with its city ("Eastern Time · Toronto"). */
function zoneOptions(locale: string, keep: string[]): { id: string; label: string }[] {
  let ids: string[] = [];
  try {
    ids = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    ids = [];
  }
  const all = [...new Set([...ids, ...keep, "UTC"])];
  return all
    .map((id) => {
      const city = id.includes("/") ? id.split("/").pop()!.replace(/_/g, " ") : "";
      const name = zoneName(id, locale);
      return { id, label: city && city !== name ? `${name} · ${city}` : name };
    })
    .sort((a, b) => a.label.localeCompare(b.label, locale));
}

/** A weekday's name, short, in the reader's language (1 Monday … 7 Sunday). */
const dayName = (day: number, locale: string) => new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(Date.UTC(2024, 0, day));

const requestId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");

export type Saved = { automation: AutomationView; runId?: string; note?: string };

export function AutomationEditor({
  automation,
  template,
  filled = null,
  economy,
  topupFloor,
  lastRuns,
  email,
  userId,
  verified,
  focusLimits = false,
  onSaved,
  onCancel,
}: {
  automation: AutomationView | null;
  template: AutomationTemplate | null;
  // A new one Flash filled in, from a description ("Describe it") or a chat answer ("Automate this").
  filled?: AutomationForm | null;
  // Whether economic data (FRED) can be used here.
  economy: boolean;
  // The auto top-up level automations keep (0 without auto top-up).
  topupFloor: number;
  // Credits of the latest finished runs, newest first (an edit shows the last 3).
  lastRuns: number[];
  // Where "Email me each result" sends and how many a day, or null when Flash can't email this account.
  email: { to: string; perDay: number } | null;
  userId: string;
  // Whether the account's email is confirmed: alerts wait for it, as in Settings.
  verified: boolean;
  // Opened to raise a limit: the run's limit takes the focus once the price shows.
  focusLimits?: boolean;
  onSaved: (s: Saved) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const editing = Boolean(automation);
  const [form, setForm] = useState<AutomationForm>(() => {
    const zone = browserZone();
    if (automation?.spec) return formFromSpec(automation.spec, automation.name, automation.timeZone) ?? blankForm(automation.timeZone);
    if (filled) return filled;
    const base = blankForm(zone);
    return template ? { ...base, ...template.fill, name: t(template.title), prompt: t(template.prompt) } : base;
  });
  // The limits as typed; null keeps the one the price gives a new automation.
  const [capRun, setCapRun] = useState<number | null>(automation ? automation.capRun : null);
  const [capMonth, setCapMonth] = useState<number | null>(automation ? automation.capMonth : null);
  const [priced, setPriced] = useState<(Priced & { key: string }) | null>(null);
  const [pricing, setPricing] = useState(false);
  const [priceError, setPriceError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [emailMe, setEmailMe] = useState(automation ? automation.emailMe : Boolean(filled?.emailMe));
  // This device's alerts (null until known, or when Flash's server has no push keys).
  const [alerts, setAlerts] = useState<PushStatus | null>(null);
  const [alertsBusy, setAlertsBusy] = useState(false);
  const [alertsError, setAlertsError] = useState("");
  const asked = useRef(0);
  const nameRef = useRef<HTMLInputElement>(null);
  const limitFocused = useRef(false);

  const set = <K extends keyof AutomationForm>(key: K, value: AutomationForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const zones = useMemo(() => zoneOptions(t.locale, [form.timeZone, browserZone()]), [t.locale, form.timeZone]);
  const problem = formProblem(form);
  const spec = useMemo(() => specFromForm(form, { economy }), [form, economy]);
  const manual = form.repeat === "manual";
  const est = priced?.estimate;
  // What the price is for: saving waits for a price of the form as it is now.
  const key = JSON.stringify([spec, form.name.trim(), form.timeZone]);
  const run = capRun ?? est?.limits.capRun ?? 0;
  const month = capMonth ?? est?.limits.capMonth ?? 0;
  const capsOk = run >= 1 && month >= run;
  // Saved only at a price shown for the form as it is now.
  const ready = !busy && !pricing && priced?.key === key && !problem && !priceError && capsOk;

  useEffect(() => {
    if (!focusLimits) nameRef.current?.focus();
  }, [focusLimits]);

  useEffect(() => {
    let live = true;
    pushStatus()
      .then((s) => live && setAlerts(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // The same switch as Settings' "Alerts when Flash is closed": every alert Flash sends this account.
  async function toggleAlerts(on: boolean) {
    if (!alerts?.key || alertsBusy) return;
    setAlertsBusy(true);
    setAlertsError("");
    try {
      if (on) await turnOnPush(userId, alerts.key);
      else await turnOffPush(userId);
      setAlerts((s) => s && { ...s, on });
    } catch (e) {
      // In English, translated where it shows (see push.ts).
      setAlertsError(e instanceof Error ? e.message : msg("Something went wrong. Please try again."));
    } finally {
      setAlertsBusy(false);
    }
  }

  // Priced by the server whenever the form can be saved, a moment after the last change.
  useEffect(() => {
    if (problem) return;
    const ask = ++asked.current;
    const timer = setTimeout(() => {
      setPricing(true);
      call<Priced>("/api/automations/estimate", { method: "POST", json: { spec, name: form.name.trim(), timeZone: form.timeZone } })
        .then((got) => {
          if (ask !== asked.current) return;
          setPriced({ ...got, key });
          setPriceError("");
        })
        .catch((err) => ask === asked.current && setPriceError(errorOf(err)))
        .finally(() => ask === asked.current && setPricing(false));
    }, 500);
    return () => clearTimeout(timer);
  }, [spec, form.name, form.timeZone, problem, key]);

  async function save(kind: "on" | "draft" | "save" | "run") {
    if (!est || !ready) return;
    setBusy(true);
    setError("");
    const fields = {
      spec,
      name: form.name.trim(),
      timeZone: form.timeZone,
      seenMax: est.worst,
      ...(capRun !== null && { capRun }),
      ...(capMonth !== null && { capMonth }),
      // Left as it is when Flash can't email this account now.
      ...(email && { emailMe }),
    };
    try {
      let saved: AutomationView;
      if (automation) {
        const got = await call<{ automation: AutomationView }>(`/api/automations/${automation.id}`, { method: "PATCH", json: { ...fields, ...(kind === "on" && { status: "on" }) } });
        saved = got.automation;
      } else {
        // Run once now saves a scheduled one as a draft (it runs once, and turns on only when asked).
        const status = kind === "on" || (manual && kind !== "draft") ? "on" : "draft";
        const got = await call<{ automation: AutomationView }>("/api/automations", { method: "POST", json: { ...fields, status } });
        saved = got.automation;
      }
      if (kind !== "run") return onSaved({ automation: saved });
      try {
        const started = await call<{ run: { id: string }; note?: string }>(`/api/automations/${saved.id}/run`, { method: "POST", json: { requestId: requestId(), seenMax: est.worst } });
        onSaved({ automation: saved, runId: started.run.id, note: started.note });
      } catch (err) {
        // Saved, but it couldn't run now (credits, a limit): its page says why.
        onSaved({ automation: saved, note: errorOf(err) });
      }
    } catch (err) {
      const failed = err as Failed;
      // The price went up since it was shown: the new one shows, to be pressed again.
      if (failed.code === "price_changed" && failed.estimate && priced) setPriced({ ...priced, estimate: failed.estimate, key });
      setError(errorOf(err));
    } finally {
      setBusy(false);
    }
  }

  // Alerts carry what the account does, so they wait for a confirmed email, as in Settings.
  const alertsWaiting = !verified && !alerts?.on;
  const alertsAbout =
    alerts?.support === "home-screen"
      ? t("On iPhone and iPad, add Flash to your Home Screen first, then turn on alerts in the app you added.")
      : alerts?.support === "update"
        ? t("Alerts need iOS or iPadOS 16.4 or later. If this iPhone or iPad can run it, update it to get them.")
        : alerts?.support === "no"
          ? t("This browser can't get alerts when Flash is closed.")
          : alertsWaiting
            ? t("Confirm your email to turn on alerts.")
            : t("Flash can alert this phone or computer when something you asked for is ready, even with Flash closed. Alerts stop when you log out here.");

  const label = "mb-1.5 block text-[13px] font-medium text-zinc-300";
  const section = "space-y-2.5 rounded-2xl border border-white/8 bg-white/[0.02] p-4";
  const pill = (on: boolean) =>
    `rounded-full border px-3 py-1.5 text-sm transition ${on ? "border-primary/60 bg-primary/10 text-zinc-100" : "border-white/10 text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"}`;
  const time = (value: string, change: (v: string) => void, name: string) => (
    <input type="time" value={value} onChange={(e) => e.target.value && change(e.target.value)} aria-label={name} className={`${fieldBox} inline-block w-auto py-1.5`} />
  );
  const credits = (value: number, change: (v: number) => void, name: string, first = false) => (
    <input
      ref={
        first && focusLimits
          ? (el) => {
              if (!el || limitFocused.current) return;
              limitFocused.current = true;
              el.focus();
              el.scrollIntoView({ block: "center" });
            }
          : undefined
      }
      type="number"
      inputMode="numeric"
      min={1}
      max={100_000}
      value={value || ""}
      onChange={(e) => change(Math.max(0, Math.min(100_000, Math.floor(Number(e.target.value) || 0))))}
      aria-label={name}
      className={`${fieldBox} mx-1 inline-block w-24 py-1 tabular-nums`}
    />
  );

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save(editing ? "save" : manual ? "save" : "on");
      }}
    >
      {filled && !editing && (
        <p role="status" className="rounded-xl border border-primary/25 bg-primary/10 px-3.5 py-2.5 text-sm text-zinc-200">
          {t("Flash filled this in. Check it, then save.")}
        </p>
      )}
      <div className={section}>
        <label className="block">
          <span className={label}>{t("Name")}</span>
          <input ref={nameRef} value={form.name} maxLength={80} onChange={(e) => set("name", e.target.value)} dir="auto" placeholder={t("Weekly research summary")} className={fieldBox} />
        </label>
        <label className="block">
          <span className={label}>{t("What should Flash do?")}</span>
          <textarea
            value={form.prompt}
            maxLength={4000}
            rows={5}
            onChange={(e) => set("prompt", e.target.value)}
            dir="auto"
            placeholder={t("Give me today's top news about [your topic] in 3 to 5 short points, with sources.")}
            className={`${fieldBox} resize-y leading-relaxed`}
          />
        </label>
      </div>

      <div className={section}>
        <span className={label}>{t("When")}</span>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("When")}>
          {REPEATS.map((r) => (
            <button key={r.id} type="button" role="radio" aria-checked={form.repeat === r.id} onClick={() => set("repeat", r.id)} className={pill(form.repeat === r.id)}>
              {t(r.label)}
            </button>
          ))}
        </div>
        {form.repeat === "weekly" && (
          <div className="flex flex-wrap gap-1.5">
            {[1, 2, 3, 4, 5, 6, 7].map((d) => {
              const on = form.days.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set("days", on ? form.days.filter((x) => x !== d) : [...form.days, d])}
                  className={`min-w-11 ${pill(on)}`}
                >
                  {dayName(d, t.locale)}
                </button>
              );
            })}
          </div>
        )}
        {!manual && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-zinc-300">
            {form.repeat === "once" && <input type="date" value={form.date} onChange={(e) => e.target.value && set("date", e.target.value)} aria-label={t("Date")} className={`${fieldBox} w-auto py-1.5`} />}
            {form.repeat === "monthly" && (
              <select value={String(form.day)} onChange={(e) => set("day", e.target.value === "last" ? "last" : Number(e.target.value))} aria-label={t("Day of the month")} className={`${fieldBox} w-auto py-1.5`}>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {t("Day {day}", { day: d.toLocaleString(t.locale) })}
                  </option>
                ))}
                <option value="last">{t("The last day")}</option>
              </select>
            )}
            {form.repeat === "hourly" ? (
              <span className="flex flex-wrap items-center gap-1.5">
                {/* Each control where the translation puts its blank. */}
                {t.node("Every {hours} hours from {from} to {to}", {
                  hours: (
                    <select value={form.every} onChange={(e) => set("every", Number(e.target.value))} aria-label={t("Hours apart")} className={`${fieldBox} mx-1 inline-block w-auto py-1.5`}>
                      {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
                        <option key={h} value={h}>
                          {h.toLocaleString(t.locale)}
                        </option>
                      ))}
                    </select>
                  ),
                  from: <span className="mx-1 inline-block">{time(form.from, (v) => set("from", v), t("First run of the day"))}</span>,
                  to: <span className="mx-1 inline-block">{time(form.to, (v) => set("to", v), t("Last run of the day"))}</span>,
                })}
              </span>
            ) : (
              time(form.at, (v) => set("at", v), t("Time"))
            )}
            <select value={form.timeZone} onChange={(e) => set("timeZone", e.target.value)} aria-label={t("Time zone")} className={`${fieldBox} w-auto max-w-full py-1.5`}>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {!manual && priced?.schedule && !problem && (
          <p className="text-[13px] text-zinc-400" dir="auto">
            {priced.schedule.sentence} · {priced.schedule.zone}
            {priced.next && <span className="block text-zinc-500">{priced.next}</span>}
          </p>
        )}
      </div>

      <div className={section}>
        <span className={label}>{t("How")}</span>
        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t("How")}>
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={form.mode === m.id}
              onClick={() => set("mode", m.id)}
              className={`rounded-xl border px-3 py-2.5 text-start transition ${form.mode === m.id ? "border-primary/60 bg-primary/10" : "border-white/10 hover:bg-white/[0.04]"}`}
            >
              <span className="block text-sm font-medium text-zinc-100">{t(m.label)}</span>
              <span className="mt-0.5 block text-xs leading-snug text-zinc-500">{t(m.about)}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("Level")}>
          {MODEL_LEVELS.map((l) => (
            <button key={l.id} type="button" role="radio" aria-checked={form.level === l.id} title={t(l.blurb)} onClick={() => set("level", l.id)} className={`flex items-center gap-1.5 ${pill(form.level === l.id)}`}>
              <LevelIcon level={l.id} />
              {l.short}
            </button>
          ))}
        </div>
        {form.mode !== "write" && form.level === "sonic" && <p className="text-xs text-zinc-500">{t("Research uses Ascend or above")}</p>}
        <label className="flex items-center justify-between gap-3 pt-1 text-sm text-zinc-300">
          <span>{t("Use company filings and economic data when useful")}</span>
          <Switch on={form.data} onChange={(on) => set("data", on)} label={t("Use company filings and economic data when useful")} />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm text-zinc-300">
          <span>{t("Only tell me when something changed")}</span>
          <Switch on={form.onlyIfChanged} onChange={(on) => set("onlyIfChanged", on)} label={t("Only tell me when something changed")} />
        </label>
      </div>

      <div className={section}>
        <span className={label}>{t("Results: in Automations and the bell")}</span>
        {alerts?.key && (
          <div className="flex items-center justify-between gap-3 text-sm text-zinc-300">
            <span className="min-w-0">
              <span className="block">{t("Alerts when Flash is closed")}</span>
              <span className="mt-0.5 block text-xs leading-snug text-zinc-500">{alertsAbout}</span>
            </span>
            {alerts.support === "update" ? null : alerts.support !== "yes" ? (
              <span className="shrink-0 text-xs text-zinc-500">{t("Not in this browser")}</span>
            ) : alertsWaiting ? null : (
              <Switch on={alerts.on} disabled={alertsBusy} onChange={(on) => void toggleAlerts(on)} label={t("Send alerts to this device")} />
            )}
          </div>
        )}
        {alertsError && (
          <p role="status" dir="auto" className="text-xs text-red-400">
            {t(alertsError)}
          </p>
        )}
        {email && (
          <label className="flex items-center justify-between gap-3 text-sm text-zinc-300">
            <span className="min-w-0">
              <span className="block">{t("Email me each result")}</span>
              <span className="mt-0.5 block break-words text-xs leading-snug text-zinc-500">
                {t.node("Sent to {email}. Up to {count} emails a day, across all your automations.", {
                  email: <bdi dir="ltr">{email.to}</bdi>,
                  count: n(t, email.perDay),
                })}
              </span>
            </span>
            <Switch on={emailMe} onChange={setEmailMe} label={t("Email me each result")} />
          </label>
        )}
        {!alerts?.on && !(email && emailMe) && <p className="text-xs text-zinc-500">{t("You'll see results when you open Flash")}</p>}
      </div>

      <div className={section} aria-live="polite">
        {problem ? (
          <p className="text-sm text-zinc-400">{t(problem)}</p>
        ) : priceError ? (
          <p className="text-sm text-red-400" dir="auto">
            {priceError}
          </p>
        ) : !est ? (
          <p className="text-sm text-zinc-400">{t("Checking the price…")}</p>
        ) : (
          <div className={`space-y-1.5 text-sm ${pricing ? "opacity-60" : ""}`}>
            <p className="font-medium text-zinc-100">{t("Each run: never more than {credits} credits, usually about {typical} (estimate)", { credits: n(t, est.worst), typical: n(t, est.typical) })}</p>
            {est.runs > 0 && <p className="text-zinc-300">{t("About {credits} a month ({runs} runs)", { credits: n(t, est.month), runs: n(t, est.runs) })}</p>}
            {lastRuns.length >= 3 && (
              <p className="text-zinc-400">
                {t("Last {count} runs: {list} credits", { count: n(t, 3), list: new Intl.ListFormat(t.locale, { type: "unit", style: "narrow" }).format(lastRuns.slice(0, 3).map((c) => n(t, c))) })}
              </p>
            )}
            <p className="text-zinc-500">{t("A run costs credits even when there's nothing new.")}</p>
            {topupFloor > 0 && <p className="text-zinc-500">{t("Automations keep your {credits} credits for auto top-up, so they never buy credits for you.", { credits: n(t, topupFloor) })}</p>}
            <div className="flex flex-col gap-1.5 pt-1.5 text-zinc-300">
              <span>
                {t.node("At most {credits} credits a run", { credits: credits(run, setCapRun, t("Credits a run"), true) })}
              </span>
              <span>
                {t.node("At most {credits} credits a month", { credits: credits(month, setCapMonth, t("Credits a month")) })}
              </span>
              {!capsOk && <span className="text-xs text-amber-300">{t("A month's limit can't be less than a run's.")}</span>}
              {capsOk && run < est.worst && <span className="text-xs text-zinc-500">{t("A run that reaches its limit stops there and keeps what it did.")}</span>}
            </div>
          </div>
        )}
      </div>

      {error && (
        <p role="alert" dir="auto" className="text-sm text-red-400">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 pb-1">
        {editing ? (
          <>
            <button type="submit" disabled={!ready} className={primaryButton}>
              {t("Save")}
            </button>
            {automation?.status === "draft" && !manual && (
              <button type="button" onClick={() => void save("on")} disabled={!ready} className={quietButton}>
                {t("Turn on")}
              </button>
            )}
          </>
        ) : (
          <>
            <button type="submit" disabled={!ready} className={primaryButton}>
              {manual ? t("Save") : t("Turn on")}
            </button>
            <button type="button" onClick={() => void save("run")} disabled={!ready} className={quietButton}>
              {est ? t("Run once now: at most {credits} credits", { credits: n(t, est.worst) }) : t("Run once now")}
            </button>
            {!manual && (
              <button type="button" onClick={() => void save("draft")} disabled={!ready} className={quietButton}>
                {t("Save as draft")}
              </button>
            )}
          </>
        )}
        <button type="button" onClick={onCancel} disabled={busy} className="rounded-full px-4 py-2 text-sm text-zinc-400 transition hover:text-zinc-100">
          {t("Cancel")}
        </button>
      </div>
    </form>
  );
}

/** The templates that work here: each one's tool is live, and the economy one only with economic data. */
export const liveTemplates = (isLive: (e: "text" | "search") => boolean, economy: boolean) => AUTOMATION_TEMPLATES.filter((x) => isLive(x.needs) && (!x.economy || economy));
