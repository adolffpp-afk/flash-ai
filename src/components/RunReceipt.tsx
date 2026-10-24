"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { AiStep } from "@/lib/automations";
import { VERDICT_WORDS, verdictOf, type Verdict } from "@/lib/autopilot";
import { msg } from "@/lib/i18n";
import { LEVELS } from "@/lib/levels";
import { linkHost, safeMarkdown } from "@/lib/safe-markdown";
import { useT, type T } from "@/lib/use-t";
import { at, call, creditsText, errorOf, n, primaryButton, runState, saveFile, smallButton, StateBadge, took, type AutomationView, type Failed, type Receipt } from "./automation-shared";

// Loaded with the first answer shown, as chat's.
const MarkdownView = lazy(() => import("./MarkdownView"));

/*
 * A run's receipt, as its owner sees it: how it went (its state, when it was due and started, what
 * it was charged), the answer with its sources, how it ran (each step's level, model, hold and
 * charge, its tries and pages read), its checks and whether each passed, its fingerprint, and Run
 * again or Retry with the price first. Once it ends, its verdict leads: Done, Partly done, Needs you
 * or Didn't finish (see autopilot.ts), with what to do next.
 * While it runs, a live checklist (every 5 s while the tab is shown) and Stop.
 */

const MODE_WORDS: Record<string, string> = { write: msg("Write"), research: msg("Research"), quick: msg("Quick research"), check: msg("Check") };
const levelName = (id: string) => LEVELS.find((l) => l.id === id)?.short ?? id;
/** A step's row in the live checklist, by its latest try's status. */
const TICKS: Record<string, "done" | "going" | "waiting" | "skipped" | "failed"> = { done: "done", running: "going", waited: "going", waiting: "waiting", skipped: "skipped", stopped: "skipped", failed: "failed" };
// A scheduled run started this long after its time says it started late.
const LATE_MS = 5 * 60_000;

/** What a step of the automation does, in a few words ("Research · Ascend", "A notice in Flash"). */
function stepWords(t: T, step: { do: string } | undefined) {
  if (step?.do === "ai") return `${t(MODE_WORDS[(step as AiStep).mode] ?? "")} · ${levelName((step as AiStep).level)}`;
  return step?.do === "notify" ? t("A notice in Flash") : "";
}

type Check = Receipt["steps"][number]["checks"][number];

/** What a check asked for, in the reader's words: a free check's rule and what was found, or the rule a Check step read. */
function checkWords(t: T, c: Check): string {
  if (c.k === "minWords") return t("At least {count} words (it has {got})", { count: n(t, Number(c.v)), got: n(t, c.got ?? 0) });
  if (c.k === "maxWords") return t("At most {count} words (it has {got})", { count: n(t, Number(c.v)), got: n(t, c.got ?? 0) });
  if (c.k === "mentions") return t("Mentions \u201c{text}\u201d", { text: String(c.v) });
  if (c.k === "sources") return t("At least {count} sources (it has {got})", { count: n(t, Number(c.v)), got: n(t, c.got ?? 0) });
  return String(c.v);
}

/** A run's checks, each with a tick or a cross and, for a rule a Check step read, its reason. */
function Checks({ checks, t }: { checks: Check[]; t: T }) {
  return (
    <ul className="space-y-1.5">
      {checks.map((c, i) => (
        <li key={i} className="flex gap-2.5 text-sm">
          <span
            className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold leading-none ${c.pass ? "bg-emerald-500 text-white" : "bg-red-500 text-white"}`}
            aria-hidden
          >
            {c.pass ? "\u2713" : "\u2715"}
          </span>
          <span className="min-w-0">
            <span className="sr-only">{c.pass ? t("Passed:") : t("Didn't pass:")} </span>
            <span dir="auto" className="break-words text-zinc-200">
              {checkWords(t, c)}
            </span>
            {c.why && (
              <span dir="auto" className="block break-words text-xs text-zinc-500">
                {c.why}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

const VERDICT_TONES: Record<Verdict, string> = {
  done: "border-emerald-400/25 bg-emerald-400/[0.07] light:bg-emerald-50",
  partly: "border-amber-400/30 bg-amber-400/[0.08] light:bg-amber-50",
  needs_you: "border-sky-400/25 bg-sky-400/[0.07] light:bg-sky-50",
  not_finished: "border-red-400/25 bg-red-400/[0.07] light:bg-red-50",
};
const VERDICT_MARKS: Record<Verdict, { mark: string; tone: string }> = {
  done: { mark: "\u2713", tone: "bg-emerald-500 text-white" },
  partly: { mark: "!", tone: "bg-amber-400 text-zinc-950" },
  needs_you: { mark: "\u2192", tone: "bg-sky-500 text-white" },
  not_finished: { mark: "\u2715", tone: "bg-red-500 text-white" },
};

/** What a verdict means for this run, in a sentence: what came of it and what to do next. */
function verdictLine(t: T, verdict: Verdict, outcome: string, passed: number, total: number): string {
  if (verdict === "done") {
    if (outcome === "nothing_new") return t("It finished: nothing new since last time.");
    return total ? t("Every check passed ({passed} of {total}). The result is below.", { passed: n(t, passed), total: n(t, total) }) : t("It finished. The result is below.");
  }
  if (verdict === "partly")
    return outcome === "cut_short"
      ? t("It ran out of time, so parts may be missing. Read the result before you use it.")
      : t("{passed} of {total} checks passed. Look at the ones marked \u2715 before you use the result.", { passed: n(t, passed), total: n(t, total) });
  if (verdict === "needs_you") return outcome === "stopped_by_user" ? t("You stopped it before the end.") : t("It stopped before the end and needs you: the note below says why and what to do.");
  return t("Flash couldn't finish this run. You can retry when you're ready.");
}

/** A row of the live checklist: done, going, waiting, or not yet. */
function Tick({ state }: { state: (typeof TICKS)[string] | "todo" }) {
  if (state === "going") return <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-primary/30 border-t-primary" aria-hidden />;
  const tone = { done: "bg-emerald-500 text-white", waiting: "bg-amber-400 text-zinc-950", skipped: "bg-zinc-600 text-white", failed: "bg-red-500 text-white", todo: "border border-white/20" }[state];
  const mark = { done: "✓", waiting: "…", skipped: "–", failed: "!", todo: "" }[state];
  return (
    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold leading-none ${tone}`} aria-hidden>
      {mark}
    </span>
  );
}

export function RunReceipt({
  runId,
  automation,
  onChanged,
  onOpenRun,
  onCredits,
  onEditLimits,
  onRunDone,
  onOpenChat,
}: {
  runId: string;
  // Its automation as the panel has it (null once deleted).
  automation: AutomationView | null;
  // Something about the automation changed (a run ended, was stopped or read): the panel loads it again.
  onChanged: () => void;
  // Run again and Retry start a new run: the panel shows its receipt (with the server's note, if any).
  onOpenRun: (runId: string, note?: string) => void;
  onCredits: () => void;
  onEditLimits: () => void;
  // A run this receipt watched going has ended (for the page's own notice).
  onRunDone: (name: string, ok: boolean, startedAt: number) => void;
  // Open in chat made a chat with this run's answer: the page opens it.
  onOpenChat?: (projectId: string) => void;
}) {
  const t = useT();
  const [r, setR] = useState<Receipt | null>(null);
  const [error, setError] = useState("");
  const [loadedAt, setLoadedAt] = useState(0);
  // Bumped to load it again now (after Stop).
  const [again, setAgain] = useState(0);
  const [check, setCheck] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  // The most Run again or Retry can cost, as the person sees it: the automation's price, or a new one the server gave.
  const [price, setPrice] = useState(automation?.quotedMax ?? 0);
  const read = useRef(false);
  // Whether this receipt saw the run going, so its end is news.
  const sawGoing = useRef(false);

  const finished = Boolean(r?.run.finishedAt);
  const going = r ? !r.run.finishedAt && !r.run.parked && r.run.dueAt <= loadedAt : true;

  useEffect(() => {
    let live = true;
    const get = () =>
      call<Receipt>(`/api/automations/runs/${runId}`)
        .then((got) => {
          if (!live) return;
          setR(got);
          setLoadedAt(Date.now());
          setError("");
          if (!got.run.finishedAt) sawGoing.current = true;
          else if (sawGoing.current) {
            sawGoing.current = false;
            onRunDone(got.run.name, got.run.status === "done", got.run.startedAt || got.run.createdAt);
            onChanged();
          }
          // Opening a finished receipt marks it seen, with its notices in the bell (the GET writes nothing).
          if (!read.current && got.run.finishedAt) {
            read.current = true;
            void call(`/api/automations/runs/${runId}`, { method: "POST", json: { action: "read" } })
              .then(() => live && onChanged())
              .catch(() => undefined);
          }
        })
        .catch((err) => live && setError(errorOf(err)));
    void get();
    // Followed while the tab is shown: every 5 s while it runs, every 30 s while it waits.
    const timer = finished ? undefined : setInterval(() => document.visibilityState === "visible" && void get(), going ? 5000 : 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // onRunDone and onChanged are the panel's, read when a load comes back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, finished, going, again]);

  const stop = async () => {
    setActionError("");
    try {
      await call(`/api/automations/runs/${runId}`, { method: "POST", json: { action: "stop" } });
      setAgain((x) => x + 1);
    } catch (err) {
      setActionError(errorOf(err));
    }
  };

  // Run again (a done run, as Run now) or Retry (any other end), at the price shown.
  const runAgain = async (retry: boolean) => {
    if (!automation) return;
    setBusy(true);
    setActionError("");
    try {
      const started = retry
        ? await call<{ run: { id: string }; note?: string }>(`/api/automations/runs/${runId}`, { method: "POST", json: { action: "retry", seenMax: price } })
        : await call<{ run: { id: string }; note?: string }>(`/api/automations/${automation.id}/run`, {
            method: "POST",
            json: { requestId: Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join(""), seenMax: price },
          });
      onChanged();
      onOpenRun(started.run.id, started.note);
    } catch (err) {
      const failed = err as Failed;
      // The price went up: the button shows the new one, to be pressed again.
      if (failed.code === "price_changed" && failed.estimate) setPrice(failed.estimate.worst);
      setActionError(errorOf(err));
    } finally {
      setBusy(false);
    }
  };

  // A new chat with what it was asked and its answer, to ask follow-ups (free).
  const openInChat = async () => {
    setBusy(true);
    setActionError("");
    try {
      const { project } = await call<{ project: { id: string } }>(`/api/automations/runs/${encodeURIComponent(runId)}/chat`, { method: "POST", json: {} });
      onOpenChat?.(project.id);
    } catch (err) {
      setActionError(errorOf(err));
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    try {
      const got = await call<Receipt>(`/api/automations/runs/${runId}`);
      saveFile(`receipt-${runId.replace(/[^A-Za-z0-9_-]/g, "")}.json`, JSON.stringify(got, null, 1));
    } catch (err) {
      setCheck(errorOf(err));
    }
  };

  // Each pick is checked (the same file again too), and the answer names the file it is about.
  const compare = async (file: File | undefined) => {
    if (!file) return;
    setCheck(t("Checking {file}…", { file: file.name }));
    try {
      const saved = JSON.parse(await file.text()) as unknown;
      const res = await call<{ matches: boolean; reason?: string }>(`/api/automations/runs/${runId}`, { method: "POST", json: { action: "check", receipt: saved } });
      setCheck(
        res.matches
          ? t("{file}: this receipt matches Flash's record.", { file: file.name })
          : res.reason === "unfinished"
            ? t("{file} was saved before the run ended, so it has no fingerprint to check. Download it again now.", { file: file.name })
            : t("{file}: this receipt doesn't match Flash's record.", { file: file.name }),
      );
    } catch (err) {
      setCheck(t("{file}: {error}", { file: file.name, error: errorOf(err) }));
    }
  };

  if (!r)
    return (
      <div className="space-y-4">
        <p dir="auto" role={error ? "alert" : "status"} className={`text-sm ${error ? "text-red-400" : "text-zinc-500"}`}>
          {error || t("Loading…")}
        </p>
      </div>
    );

  const { run } = r;
  const state = runState(run);
  const spec = automation?.spec ?? null;
  // The answer: the last AI step that wrote one, with its sources; else the run's summary.
  const answered = [...r.steps].reverse().find((s) => s.kind === "ai" && s.output);
  const answer = answered?.output || (finished ? run.summary : "");
  const sources = (answered?.sources ?? []).filter((s) => linkHost(s.url)).slice(0, 20);
  const late = run.scheduledAt > 0 && run.startedAt - run.scheduledAt > LATE_MS;
  const retry = run.status !== "done";
  const canAgain = finished && automation && !run.deleted && automation.status !== "paused" && automation.status !== "deleting" && price > 0;
  const lastOf = (stepId: string) => [...r.steps].reverse().find((s) => s.stepId === stepId);
  // Every check of the run, from each step's last try that has them, in the order the steps ran.
  const checks = [...new Set(r.steps.map((s) => s.stepId))].flatMap((id) => [...r.steps].reverse().find((s) => s.stepId === id && s.checks.length)?.checks ?? []);
  const checksPassed = checks.filter((c) => c.pass).length;
  const startedBy = (r.run.trigger as { type?: string } | null)?.type === "retry" ? t("Retried by you") : run.origin === "schedule" ? t("Started by its schedule") : t("Started by you");
  const verdict = verdictOf(run, checks);

  return (
    <div className="space-y-4">
      {verdict && (
        <section role="status" className={`flex items-start gap-3 rounded-2xl border p-4 ${VERDICT_TONES[verdict]}`}>
          <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold leading-none ${VERDICT_MARKS[verdict].tone}`} aria-hidden>
            {VERDICT_MARKS[verdict].mark}
          </span>
          <span className="min-w-0">
            <span className="block font-medium text-zinc-100">{t(VERDICT_WORDS[verdict])}</span>
            <span className="block text-sm text-zinc-300">{verdictLine(t, verdict, run.outcome, checksPassed, checks.length)}</span>
          </span>
        </section>
      )}
      <section className="space-y-3 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge state={state} t={t} />
          <span className="text-sm tabular-nums text-zinc-200">{t("Charged: {cost}", { cost: creditsText(t, run.credits) })}</span>
          {run.refunded > 0 && <span className="text-sm tabular-nums text-emerald-400 light:text-emerald-700">{t("Given back: {cost}", { cost: creditsText(t, run.refunded) })}</span>}
        </div>
        <div className="space-y-0.5 text-sm text-zinc-400">
          {run.startedAt > 0 ? (
            <p>
              {run.scheduledAt > 0 && !late
                ? finished
                  ? t("Scheduled {scheduled}, started {started}, took {duration}", { scheduled: at(t, run.scheduledAt), started: at(t, run.startedAt), duration: took(t, run.startedAt, run.finishedAt) })
                  : t("Scheduled {scheduled}, started {started}", { scheduled: at(t, run.scheduledAt), started: at(t, run.startedAt) })
                : finished
                  ? t("Started {started}, took {duration}", { started: at(t, run.startedAt), duration: took(t, run.startedAt, run.finishedAt) })
                  : t("Started {started}", { started: at(t, run.startedAt) })}
            </p>
          ) : (
            run.scheduledAt > 0 && <p>{t("Scheduled {scheduled}", { scheduled: at(t, run.scheduledAt) })}</p>
          )}
          {late && <p className="text-amber-300 light:text-amber-700">{t("Started late (Flash was busy)")}</p>}
          <p>{startedBy}</p>
        </div>
        {run.noteText && (
          <p dir="auto" className="w-fit max-w-full rounded-lg bg-amber-400/10 px-3 py-2 text-sm text-amber-200 light:bg-amber-50 light:text-amber-800">
            {run.noteText}
          </p>
        )}
        {run.emailText && (
          <p dir="auto" className="text-sm text-zinc-400">
            {run.emailText}
          </p>
        )}
        {run.deleted && <p className="text-sm text-zinc-400">{t("Its automation was deleted; this run goes with it.")}</p>}

        {!finished && (
          <div className="space-y-2 border-t border-white/8 pt-3">
            <ul className="space-y-1.5" aria-live="polite">
              {(spec?.steps ?? []).map((step) => {
                const row = lastOf(step.id);
                const tick = row ? (TICKS[row.status] ?? "going") : "todo";
                return (
                  <li key={step.id} className="flex items-center gap-2.5 text-sm text-zinc-200">
                    <Tick state={tick} />
                    <span>{stepWords(t, step)}</span>
                    {row?.status === "waiting" && row.noteText && <span className="text-xs text-amber-300 light:text-amber-700">{row.noteText}</span>}
                  </li>
                );
              })}
            </ul>
            {run.parked && <p className="text-sm text-amber-300 light:text-amber-700">{t("Waiting for you to resume")}</p>}
            {!run.parked && run.dueAt > loadedAt && <p className="text-sm text-zinc-400">{t("Tries again at {time}", { time: at(t, run.dueAt) })}</p>}
            {!run.deleted && (
              <button type="button" onClick={() => void stop()} disabled={run.stopRequested} className={smallButton}>
                {run.stopRequested ? t("Stopping…") : t("Stop")}
              </button>
            )}
          </div>
        )}
        {error && (
          <p role="status" dir="auto" className="text-xs text-red-400">
            {t("Not up to date: {error}", { error })}
          </p>
        )}
      </section>

      {checks.length > 0 && (
        <section className="space-y-3 rounded-2xl border border-white/8 bg-white/[0.03] p-4" aria-label={t("Checks")}>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                checksPassed === checks.length
                  ? "bg-emerald-400/10 text-emerald-300 light:bg-emerald-50 light:text-emerald-700"
                  : "bg-amber-400/15 text-amber-300 light:bg-amber-50 light:text-amber-700"
              }`}
            >
              {checksPassed === checks.length ? t("Checked") : t("Some checks didn't pass")}
            </span>
            <span className="text-sm tabular-nums text-zinc-300">{t("Checks passed: {passed} of {total}", { passed: n(t, checksPassed), total: n(t, checks.length) })}</span>
          </div>
          <Checks checks={checks} t={t} />
        </section>
      )}

      {answer && (
        <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
          <div dir="auto" className="prose prose-invert max-w-none break-words prose-p:my-2 prose-pre:bg-zinc-900">
            <Suspense fallback={<p className="whitespace-pre-wrap">{answer}</p>}>
              <MarkdownView text={answer} components={safeMarkdown} />
            </Suspense>
          </div>
          {sources.length > 0 && (
            <div className="mt-4 border-t border-white/8 pt-3">
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-zinc-500">{t("Sources")}</p>
              <ul className="space-y-1">
                {sources.map((s) => {
                  const host = linkHost(s.url);
                  return (
                    <li key={s.url} className="flex min-w-0 gap-1.5 text-sm">
                      {/* A title is the page's own words: the host it goes to always shows. */}
                      <a href={s.url} target="_blank" rel="noreferrer noopener" dir="auto" className="truncate text-primary-soft hover:underline">
                        {s.title || host}
                      </a>
                      {s.title && s.title.toLowerCase() !== host && <span className="shrink-0 text-zinc-500">· {host}</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
      )}

      {finished && (
        <div className="flex flex-wrap items-center gap-2">
          {canAgain && (
            <button type="button" onClick={() => void runAgain(retry)} disabled={busy} className={primaryButton}>
              {retry ? t("Retry (at most {credits} credits)", { credits: n(t, price) }) : t("Run again: at most {credits} credits", { credits: n(t, price) })}
            </button>
          )}
          {(run.outcome === "no_credits" || run.outcome === "topup_floor") && (
            <button type="button" onClick={onCredits} className={smallButton}>
              {run.outcome === "topup_floor" ? t("Auto top-up settings") : t("Add credits")}
            </button>
          )}
          {(run.outcome === "run_cap" || run.outcome === "month_cap") && automation && !run.deleted && (
            <button type="button" onClick={onEditLimits} className={smallButton}>
              {run.outcome === "run_cap" ? t("Raise the limit for next time") : t("Raise the limit")}
            </button>
          )}
          {answer && (
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard
                  .writeText(answer)
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  })
                  .catch(() => undefined)
              }
              className={smallButton}
            >
              {copied ? t("Copied") : t("Copy")}
            </button>
          )}
          {answered?.output && onOpenChat && !run.deleted && (
            <button type="button" onClick={() => void openInChat()} disabled={busy} className={smallButton}>
              {t("Open in chat")}
            </button>
          )}
          {r.fingerprint && (
            <>
              <button type="button" onClick={() => void download()} className={smallButton}>
                {t("Download (JSON)")}
              </button>
              {/* Its file input takes the focus: the ring goes on the label, as on the buttons. */}
              <label className={`${smallButton} cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-white`}>
                {t("Compare with a downloaded receipt")}
                <input
                  type="file"
                  accept="application/json,.json"
                  className="sr-only"
                  onClick={() => setCheck("")}
                  onChange={(e) => {
                    const file = e.currentTarget.files?.[0];
                    e.currentTarget.value = "";
                    void compare(file);
                  }}
                />
              </label>
            </>
          )}
        </div>
      )}
      {actionError && (
        <p role="alert" dir="auto" className="text-sm text-red-400">
          {actionError}
        </p>
      )}
      {check && (
        <p role="status" dir="auto" className="break-words text-sm text-zinc-300">
          {check}
        </p>
      )}

      <details className="group rounded-2xl border border-white/8 px-4 py-3">
        <summary className="cursor-pointer select-none text-sm font-medium text-zinc-300">{t("How it ran")}</summary>
        <div className="mt-3 space-y-3 text-sm">
          {r.steps.length === 0 ? (
            <p className="text-zinc-500">{t("No step has started.")}</p>
          ) : (
            <ul className="space-y-2.5">
              {r.steps.map((s, i) => {
                const spec_ = spec?.steps.find((x) => x.id === s.stepId);
                const pages = s.sources.filter((src) => linkHost(src.url));
                return (
                  <li key={`${i}:${s.stepId}:${s.attempt}`} className="space-y-1 rounded-xl border border-white/8 p-3">
                    <div className="flex flex-wrap items-center gap-2 text-zinc-200">
                      <span className="font-medium">{stepWords(t, spec_) || (s.kind === "ai" || s.kind === "check" ? levelName(s.level) : t("A notice in Flash"))}</span>
                      {s.attempt > 1 && <span className="text-zinc-500">{t("Try {count}", { count: n(t, s.attempt) })}</span>}
                      <StateBadge state={s.status === "waited" ? "waiting" : s.status} t={t} />
                    </div>
                    {(s.kind === "ai" || s.kind === "check") && (
                      <p className="break-all text-xs text-zinc-500">
                        {levelName(s.level)}
                        {s.model && ` · ${s.model}`}
                      </p>
                    )}
                    {(s.kind === "ai" || s.kind === "check") && s.waits === 0 && (
                      <p className="tabular-nums text-zinc-400">{t("{held} credits held, {charged} charged", { held: n(t, s.held), charged: n(t, s.credits) })}</p>
                    )}
                    {s.waits > 0 && (
                      <p className="text-zinc-400">
                        {s.status === "waiting"
                          ? t("Waiting for another request's credits (free)")
                          : t("Waited for another request's credits {count} times (free)", { count: n(t, s.waits) })}
                      </p>
                    )}
                    {s.noteText && s.status !== "waiting" && (
                      <p dir="auto" className="text-amber-300 light:text-amber-700">
                        {s.noteText}
                      </p>
                    )}
                    {pages.length > 0 && (
                      <details>
                        <summary className="cursor-pointer select-none text-zinc-400">{t("Pages read ({count})", { count: n(t, pages.length) })}</summary>
                        <ul className="mt-1 space-y-0.5">
                          {pages.slice(0, 30).map((src) => (
                            <li key={src.url} className="truncate">
                              <a href={src.url} target="_blank" rel="noreferrer noopener" className="text-primary-soft hover:underline">
                                {t("Read {page}", { page: linkHost(src.url) })}
                              </a>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="break-all font-mono text-xs text-zinc-500">
            {r.fingerprint ? t("Receipt fingerprint {hash}", { hash: r.fingerprint }) : finished ? t("This run has no fingerprint (it never started).") : t("Its fingerprint is made when the run ends.")}
          </p>
        </div>
      </details>
    </div>
  );
}
