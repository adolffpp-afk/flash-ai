"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { linkHost } from "@/lib/safe-markdown";
import { api as appApi } from "@/lib/store";
import { textDirection } from "@/lib/use-t";
import type { burnIn, receipt } from "@/lib/server/automation-api.ts";
import type { Estimate } from "@/lib/server/automation-estimate.ts";

/*
 * The burn-in card on /admin's Automations tab: the admin makes test automations on their own
 * account (a one-off 3 minutes ahead, a daily one, one run by hand), at chat's prices, and watches
 * them run: each run's steps, holds, charge and receipt (its JSON and fingerprint), and the notices
 * they made. In English, like the rest of the dashboard; the notices and schedule sentences come in
 * the admin's own language (they are what users will see), with its own direction.
 *
 * It asks for the price first: each button shows what a run can cost at most, and a test
 * automation is saved only at that price (the server answers 409 when it went up).
 */

type Card = Awaited<ReturnType<typeof burnIn>>;
type Receipt = NonNullable<Awaited<ReturnType<typeof receipt>>>;
type Kind = "once" | "daily" | "manual";
type Prices = Record<Kind, Estimate>;

const LEVELS = [
  { id: "sonic", label: "Sonic" },
  { id: "ascend", label: "Ascend" },
  { id: "vision", label: "Vision" },
  { id: "ultra", label: "Summit" },
] as const;
const MODES = [
  { id: "write", label: "Write" },
  { id: "research", label: "Research" },
  { id: "quick", label: "Quick research" },
] as const;
const STEP_KINDS: Record<string, string> = { ai: "AI step", notify: "Notice" };
const KINDS: { id: Kind; label: string }[] = [
  { id: "once", label: "One-off in 3 minutes" },
  { id: "daily", label: "Every day" },
  { id: "manual", label: "Run once now" },
];
const DEFAULT_PROMPT = "Write two sentences about today's date and one thing that happened on this day in history.";

const num = (v: number) => v.toLocaleString("en-US");
const credits = (v: number) => `${num(v)} ${v === 1 ? "credit" : "credits"}`;
const when = (t: number) =>
  t ? new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }) : "–";
/** A notice's time as its user sees it, in their language as Flash formats it (its digits too). */
const whenIn = (t: number, locale: string) => {
  try {
    return new Date(t).toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return when(t);
  }
};
const took = (from: number, to: number) => {
  if (!from || !to || to < from) return "–";
  const s = Math.round((to - from) / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};
const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};
const errorOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

type RunState = { finishedAt: number; parked: boolean; dueAt: number; waiting: boolean };
/**
 * What a run not finished waits for, if anything: Resume (parked with its automation), or its next try
 * (and why, when it waits for another request's hold: a run's, or a chat reply's, on the same account).
 */
const waitNote = (r: RunState, now: number) =>
  r.finishedAt
    ? ""
    : r.parked
      ? "Waiting for you to resume"
      : r.dueAt > now
        ? `${r.waiting ? "Waiting for another request's hold (a run or a chat reply): tries" : "Tries"} again at ${when(r.dueAt)}`
        : "";
/** A step's waits in a row: going on now (its last row while the run waits), or over. */
const waitsLabel = (status: string, waits: number) =>
  status === "waiting" ? (waits === 1 ? " · waiting" : ` · waiting (${waits} times so far)`) : waits === 1 ? " · waited" : ` · waited ${waits} times`;
/** A run under way or due now (not one that waits): the card and its receipt follow it every 5 s. */
const goingNow = (r: RunState, now: number) => !r.finishedAt && !r.parked && r.dueAt <= now;

type Failed = Error & { status?: number; code?: string; estimate?: Estimate };
/**
 * A call to Flash's API through the app's own (store's api, so it names the tab's account as the rest
 * of /admin does): GET without json, else that method with a JSON body. A refusal throws with its code
 * and, for price_changed, the new estimate.
 */
async function api<T>(path: string, init?: { method?: string; json?: unknown }): Promise<T> {
  try {
    return await appApi<T>(path, init);
  } catch (err) {
    const data = (err as { data?: { estimate?: Estimate } }).data;
    throw Object.assign(err as Failed, { estimate: data?.estimate });
  }
}

const button = "rounded-lg border border-white/10 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/[0.05] disabled:opacity-50";
const field = "rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600";

/** A run's or automation's state as a small pill: green done, amber waiting or paused, red failed, grey the rest. */
function Pill({ status, outcome }: { status: string; outcome?: string }) {
  const style =
    status === "done" || status === "on"
      ? "bg-emerald-400/10 text-emerald-300"
      : status === "failed" || status === "interrupted"
        ? "bg-red-400/10 text-red-300"
        : status === "running" || status === "queued" || status === "waiting" || status === "paused"
          ? "bg-amber-400/15 text-amber-300"
          : "bg-white/[0.06] text-zinc-400";
  return (
    <span className={`inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium break-all ${style}`}>
      {status}
      {outcome && outcome !== status && <span className="font-normal opacity-80">· {outcome}</span>}
    </span>
  );
}

function Section({ title, note, children, right }: { title: string; note?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-800 p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium text-zinc-200">{title}</h2>
          {note && <p className="mt-0.5 text-xs text-zinc-500">{note}</p>}
        </div>
        {right}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Text in the admin's own language (what a user would see), laid out in its direction. */
function Theirs({ language, className, children }: { language: string; className?: string; children: React.ReactNode }) {
  return (
    <div lang={language} dir={textDirection(language)} className={className}>
      {children}
    </div>
  );
}

/**
 * The switch that opens automations to everyone with a confirmed email (after the burn-in), or closes
 * them to all but admins again. Each way asks first, on the card itself. ready: the setup above is
 * complete with automations' own key, which opening needs (the server checks it too).
 */
function OpenSwitch({ open, ready, onChange }: { open: boolean; ready: boolean; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const set = async (next: boolean) => {
    setBusy(true);
    setError("");
    try {
      await api("/api/admin/automations", { method: "POST", json: { action: "open", open: next } });
      setConfirming(false);
      onChange();
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 text-sm">
      <p className={open ? "text-emerald-300" : "text-zinc-300"}>
        {open
          ? "Open: everyone with a confirmed email has the Automations panel (Home, the menu and the bell) and pays for runs with their own credits."
          : "Only admins can use automations now. Open them once the burn-in has gone well for a few days."}
      </p>
      {!confirming ? (
        <button onClick={() => setConfirming(true)} disabled={busy || (!open && !ready)} className={button}>
          {open ? "Close to everyone but admins" : "Open to everyone"}
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
          <span>
            {open
              ? "Close it? Everyone else's automations stop at their next run, for nothing, and pause. Their runs and receipts stay."
              : "Open Automations to everyone with a confirmed email? They can make automations and run them on their own credits."}
          </span>
          <button
            onClick={() => void set(!open)}
            disabled={busy}
            className={`rounded-lg px-3 py-1.5 text-sm disabled:opacity-50 ${open ? "bg-red-400/10 text-red-300" : "bg-emerald-400/10 text-emerald-300"}`}
          >
            {busy ? "Working…" : open ? "Close" : "Open"}
          </button>
          <button onClick={() => setConfirming(false)} disabled={busy} className={button}>
            Cancel
          </button>
        </div>
      )}
      {!open && !ready && <p className="text-xs text-zinc-500">It can open once the setup above is complete, with automations&apos; own key (ANTHROPIC_AUTOMATIONS_API_KEY).</p>}
      {error && (
        <p dir="auto" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

/** The make-a-test-automation form: instruction, level and mode, and three buttons with their prices. */
function MakeTest({ ready, onMade }: { ready: boolean; onMade: () => void }) {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [level, setLevel] = useState<(typeof LEVELS)[number]["id"]>("sonic");
  const [mode, setMode] = useState<(typeof MODES)[number]["id"]>("write");
  // The prices shown, for the instruction, level and mode they were asked for (none while those change).
  const [priced, setPriced] = useState<{ key: string; prices: Prices } | null>(null);
  const [busy, setBusy] = useState<Kind | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const key = JSON.stringify([prompt, level, mode]);
  // A blank instruction is never priced or made (the server refuses it too).
  const blank = !prompt.trim();
  const prices = priced?.key === key && !blank ? priced.prices : null;

  // Priced after an 800 ms pause in changing the instruction, level or mode; a button is pressed only at the price shown.
  useEffect(() => {
    if (!prompt.trim()) return;
    let live = true;
    const timer = setTimeout(() => {
      api<{ prices: Prices }>("/api/admin/automations", { method: "POST", json: { action: "price", prompt, level, mode, timeZone: browserZone() } })
        .then((res) => live && (setPriced({ key: JSON.stringify([prompt, level, mode]), prices: res.prices }), setError("")))
        .catch((err) => live && setError(errorOf(err)));
    }, 800);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [prompt, level, mode]);

  const make = async (kind: Kind) => {
    if (!prices) return;
    setBusy(kind);
    setError("");
    setNote("");
    try {
      const res = await api<{ run?: { status: string }; note?: string }>("/api/admin/automations", {
        method: "POST",
        json: { action: "make", kind, prompt, level, mode, timeZone: browserZone(), seenMax: prices[kind].worst, run: kind === "manual" },
      });
      setNote(res.note ?? (kind === "manual" ? "Started. Its run is below." : "Made. It runs on its schedule; its runs show below."));
      onMade();
    } catch (err) {
      setError(errorOf(err));
      // The price went up since it was shown: the new one is shown before it can be pressed again.
      const est = (err as Failed).estimate;
      if (est && priced) setPriced({ key: priced.key, prices: { ...priced.prices, [kind]: est } });
    } finally {
      setBusy(null);
    }
  };

  const counted = prices ? Object.values(prices).every((p) => p.counted) : true;
  return (
    <div className="space-y-3 text-sm">
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        maxLength={4000}
        rows={3}
        aria-label="Instruction"
        className={`${field} block w-full resize-y`}
      />
      <div className="flex flex-wrap gap-2">
        <select value={level} onChange={(e) => setLevel(e.target.value as typeof level)} aria-label="Level" className={field}>
          {LEVELS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} aria-label="How" className={field}>
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {KINDS.map((k) => {
          const p = prices?.[k.id];
          return (
            <button
              key={k.id}
              onClick={() => make(k.id)}
              disabled={!ready || !p || busy !== null}
              className="flex flex-col justify-start rounded-lg border border-white/10 px-3 py-2 text-start hover:bg-white/[0.05] disabled:opacity-50"
            >
              <div className="font-medium text-zinc-100">{busy === k.id ? "Working…" : k.label}</div>
              <div className="mt-0.5 text-xs text-zinc-400">
                {blank
                  ? "Not priced"
                  : !p
                    ? "Pricing…"
                    : k.id === "daily"
                      ? `At most ${num(p.worst)} credits a run, usually about ${num(p.typical)}. About ${num(p.month)} a month.`
                      : `At most ${num(p.worst)} credits, usually about ${num(p.typical)}.`}
              </div>
            </button>
          );
        })}
      </div>
      {blank && <p className="text-xs text-amber-300">Write an instruction first.</p>}
      {!counted && <p className="text-xs text-amber-300">Counting the words failed, so these are the most the text could cost.</p>}
      {!ready && <p className="text-xs text-zinc-500">Test automations can be made once the setup above is complete.</p>}
      {note && (
        <p dir="auto" className="text-xs text-emerald-300">
          {note}
        </p>
      )}
      {error && (
        <p dir="auto" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

/** One of the admin's test automations: its schedule and spend, and Run now, Pause or Resume, Delete. */
function TestAutomation({ a, language, ready, onChange }: { a: Card["automations"][number]; language: string; ready: boolean; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  // What the server said back, such as "Queued: Flash is busy" (in the admin's language).
  const [note, setNote] = useState("");
  // The price shown on Run now and Resume: what it was saved at, or the new one the server answered with.
  const [seen, setSeen] = useState(a.quotedMax);

  const send = async (path: string, init: { method: string; json?: unknown }) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const res = await api<{ note?: string }>(path, init);
      setNote(res.note ?? "");
      setConfirming(false);
      onChange();
    } catch (err) {
      setError(errorOf(err));
      const est = (err as Failed).estimate;
      if (est) setSeen(est.worst);
    } finally {
      setBusy(false);
    }
  };
  const runNow = () => send(`/api/automations/${a.id}/run`, { method: "POST", json: { requestId: crypto.randomUUID(), seenMax: seen } });
  const pause = () => send(`/api/automations/${a.id}`, { method: "PATCH", json: { status: "paused" } });
  const resume = () => send(`/api/automations/${a.id}`, { method: "PATCH", json: { status: "on", seenMax: seen } });
  const remove = () => send(`/api/automations/${a.id}`, { method: "DELETE", json: {} });

  return (
    <li className="border-b border-zinc-900 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 font-medium break-words text-zinc-100">{a.name}</span>
        {/* A finished one-off says how its run ended, so one skipped doesn't read like one that delivered. */}
        <Pill status={a.status} outcome={a.pausedReason || (a.status === "finished" && a.lastStatus && a.lastStatus !== "done" ? a.lastStatus : undefined)} />
      </div>
      {(a.schedule || a.next) && (
        <Theirs language={language} className="mt-1 w-fit max-w-full text-xs text-zinc-400">
          {a.schedule && (
            <div>
              {a.schedule.sentence} · {a.schedule.zone}
            </div>
          )}
          {a.next && <div>{a.next}</div>}
        </Theirs>
      )}
      {a.timePassed && <div className="mt-1 text-xs text-amber-300">Its time has passed, so it can&apos;t be turned on again. Make a new one-off to test again.</div>}
      {a.status === "paused" && a.resumeAt > 0 && !a.timePassed && (
        <div className="mt-1 text-xs text-amber-300">
          {a.pausedReason === "credits" ? `Tries again by itself on ${when(a.resumeAt)} if the credits are there.` : `Turns back on by itself on ${when(a.resumeAt)}.`}
        </div>
      )}
      <div className="mt-1 text-xs text-zinc-500">
        At most {num(a.quotedMax)} credits a run · limits {num(a.capRun)} a run, {num(a.capMonth)} a month · {num(a.spentThisMonth)} charged this month
        {a.heldNow > 0 && ` · ${num(a.heldNow)} held now`}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {a.status !== "paused" && (
          <button onClick={runNow} disabled={busy || !ready} className={button}>
            Run once now · at most {num(seen)}
          </button>
        )}
        {a.status === "on" && (
          <button onClick={pause} disabled={busy} className={button}>
            Pause
          </button>
        )}
        {a.status === "paused" && !a.timePassed && (
          <button onClick={resume} disabled={busy} className={button}>
            Resume · at most {num(seen)}
          </button>
        )}
        {!confirming ? (
          <button onClick={() => setConfirming(true)} disabled={busy} className={`${button} hover:text-red-400`}>
            Delete
          </button>
        ) : (
          <span className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
            Delete it and its runs? Credits already spent stay spent.
            <button onClick={remove} disabled={busy} className="rounded-lg bg-red-400/10 px-3 py-1.5 text-sm text-red-300 disabled:opacity-50">
              Delete
            </button>
            <button onClick={() => setConfirming(false)} disabled={busy} className={button}>
              Keep
            </button>
          </span>
        )}
      </div>
      {/* The server's words come in the admin's own language, so they take its direction. */}
      {note && (
        <p dir="auto" className="mt-2 text-xs text-zinc-300">
          {note}
        </p>
      )}
      {error && (
        <p dir="auto" className="mt-2 text-xs text-red-400">
          {error}
        </p>
      )}
    </li>
  );
}

/** A run's receipt: how it ran, each step's attempts with their holds and output, the holds, the fingerprint and the receipt JSON. */
function RunReceipt({ runId, language, onChange }: { runId: string; language: string; onChange: () => void }) {
  const [r, setR] = useState<Receipt | null>(null);
  const [error, setError] = useState("");
  const [check, setCheck] = useState("");
  const read = useRef(false);
  // Bumped to load it again now (after Stop).
  const [again, setAgain] = useState(0);
  // When it last loaded (what "tries again at" is compared with).
  const [loadedAt, setLoadedAt] = useState(0);

  const finished = Boolean(r?.run.finishedAt);
  const going = r ? goingNow(r.run, loadedAt) : true;
  useEffect(() => {
    let live = true;
    const get = () =>
      api<Receipt>(`/api/automations/runs/${runId}`)
        .then((got) => {
          if (!live) return;
          setR(got);
          setLoadedAt(Date.now());
          setError("");
          // Opening a receipt marks it seen (the GET itself writes nothing).
          if (!read.current && got.run.finishedAt) {
            read.current = true;
            void api(`/api/automations/runs/${runId}`, { method: "POST", json: { action: "read" } }).catch(() => undefined);
          }
        })
        .catch((err) => live && setError(errorOf(err)));
    void get();
    // Polled while the tab is shown: every 5 s while the run goes on, every 30 s while it waits.
    const timer = finished ? undefined : setInterval(() => document.visibilityState === "visible" && void get(), going ? 5000 : 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [runId, finished, going, again]);

  // Fetched through the app's api (so it names the tab's account) and saved as the route's ?format=json writes it.
  const download = async () => {
    try {
      const got = await api<Receipt>(`/api/automations/runs/${runId}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(got, null, 1)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `receipt-${runId.replace(/[^A-Za-z0-9_-]/g, "")}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setCheck(errorOf(err));
    }
  };
  // Each pick is checked, the same file picked again too (the input is emptied after each), and the
  // answer names the file it is about; nothing is shown while a check is under way.
  const compare = async (file: File | undefined) => {
    if (!file) return;
    setCheck(`Checking ${file.name}…`);
    try {
      const saved = JSON.parse(await file.text()) as unknown;
      const res = await api<{ matches: boolean; reason?: string }>(`/api/automations/runs/${runId}`, { method: "POST", json: { action: "check", receipt: saved } });
      setCheck(
        res.matches
          ? `${file.name}: this receipt matches Flash's record.`
          : res.reason === "unfinished"
            ? `${file.name} was saved before the run ended, so it has no fingerprint to check. Download it again now.`
            : `${file.name}: this receipt doesn't match Flash's record.`,
      );
    } catch (err) {
      setCheck(`${file.name}: ${errorOf(err)}`);
    }
  };
  const stop = async () => {
    try {
      await api(`/api/automations/runs/${runId}`, { method: "POST", json: { action: "stop" } });
      setAgain((n) => n + 1);
      onChange();
    } catch (err) {
      setError(errorOf(err));
    }
  };

  if (error && !r) return <p className="mt-2 text-xs text-red-400">{error}</p>;
  if (!r) return <p className="mt-2 text-xs text-zinc-500">Loading the receipt…</p>;
  const { run } = r;
  const waits = waitNote(run, loadedAt);
  // A run's steps hold one after another, never together: its largest hold is the most it held at once.
  const held = Math.max(0, ...r.holds.map((h) => h.held));
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs">
      {error && (
        <p role="status" className="text-red-400">
          Not up to date (loaded {when(loadedAt)}): {error}
        </p>
      )}
      <div className="grid gap-x-4 gap-y-1 text-zinc-400 sm:grid-cols-2">
        <div>Started by: {run.origin === "schedule" ? "its schedule" : run.origin === "owner" ? "you" : run.origin}</div>
        <div>Version {run.version}</div>
        {run.scheduledAt > 0 && <div>Scheduled {when(run.scheduledAt)}</div>}
        <div>
          Started {when(run.startedAt)}
          {run.scheduledAt > 0 && run.startedAt > 0 && <span className="text-zinc-500"> ({took(run.scheduledAt, run.startedAt)} late)</span>}
        </div>
        <div>Finished {when(run.finishedAt)}</div>
        <div>Took {took(run.startedAt, run.finishedAt)}</div>
        <div className="text-zinc-200">
          Largest hold {credits(held)}
          {r.holds.length > 1 && <span className="text-zinc-400"> (of {r.holds.length}, one at a time)</span>}, {num(run.credits)} charged
          {run.refunded > 0 && <span className="text-emerald-300">, {num(run.refunded)} refunded</span>}
        </div>
        {run.refunded > 0 && (
          <div className="text-zinc-400 sm:col-span-2">
            It failed on Flash&apos;s side, so Flash gave back all {credits(run.refunded)}. The steps and holds below show what each one used.
          </div>
        )}
        {run.deleted && <div className="text-zinc-400">Its automation was deleted; this run goes with it.</div>}
        {waits && <div className="text-amber-300 sm:col-span-2">{waits}</div>}
        {/* Delete already asked a run of an automation being deleted to stop. */}
        {!run.finishedAt && !run.deleted && (
          <div>
            <button onClick={stop} disabled={run.stopRequested} className={button}>
              {run.stopRequested ? "Stopping…" : "Stop"}
            </button>
          </div>
        )}
      </div>

      {run.noteText && (
        <Theirs language={language} className="w-fit max-w-full text-amber-300">
          {run.noteText}
        </Theirs>
      )}

      <div>
        <div className="mb-1 font-medium text-zinc-300">Steps</div>
        {r.steps.length === 0 ? (
          <p className="text-zinc-500">No step has started.</p>
        ) : (
          <ul className="space-y-2">
            {r.steps.map((s, i) => (
              <li key={`${i}:${s.stepId}:${s.attempt}`} className="rounded-lg border border-zinc-800 p-2">
                <div className="flex flex-wrap items-center gap-2 text-zinc-300">
                  <span className="font-mono">{s.stepId}</span>
                  <span>
                    {STEP_KINDS[s.kind] ?? s.kind}
                    {/* Waits for other requests' holds in a row come as one line; they aren't tries. */}
                    {s.waits > 0 ? waitsLabel(s.status, s.waits) : s.attempt > 1 ? ` · attempt ${s.attempt}` : ""}
                  </span>
                  <Pill status={s.status} outcome={s.waits > 0 ? undefined : s.note || undefined} />
                  {s.kind === "ai" && (
                    <span className="break-all text-zinc-500">
                      {LEVELS.find((l) => l.id === s.level)?.label ?? s.level}
                      {s.model && ` · ${s.model}`} · {num(s.held)} held · {num(s.credits)} charged
                    </span>
                  )}
                </div>
                {s.input && (
                  <details className="mt-1 text-zinc-400">
                    <summary className="cursor-pointer select-none">What it sent</summary>
                    <div dir="auto" className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded border border-zinc-800 bg-zinc-950 p-2 text-zinc-300">
                      {s.input}
                    </div>
                  </details>
                )}
                {s.noteText && <Theirs language={language} className="mt-1 w-fit max-w-full text-amber-300">{s.noteText}</Theirs>}
                {s.status === "waited" && (
                  <p className="mt-1 text-zinc-500">
                    It waited for other requests&apos; holds on this account (runs or chat replies): waits are free, and aren&apos;t tries.
                  </p>
                )}
                {s.output && (
                  <div dir="auto" className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-zinc-300">
                    {s.output}
                  </div>
                )}
                {/* Only web links, each showing the host it goes to: a title is the page's own words (as chat's sources, see safe-markdown.ts). */}
                {s.sources.some((src) => linkHost(src.url)) && (
                  <ul className="mt-1 space-y-0.5">
                    {s.sources
                      .filter((src) => linkHost(src.url))
                      .slice(0, 10)
                      .map((src) => {
                        const host = linkHost(src.url);
                        return (
                          <li key={src.url} className="flex min-w-0 gap-1">
                            <a href={src.url} target="_blank" rel="noreferrer noopener" dir="auto" className="truncate text-primary-soft hover:underline">
                              {src.title || host}
                            </a>
                            {src.title && src.title.toLowerCase() !== host && <span className="shrink-0 text-zinc-500">· {host}</span>}
                          </li>
                        );
                      })}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="mb-1 font-medium text-zinc-300">Holds</div>
        {r.holds.length === 0 ? (
          <p className="text-zinc-500">
            {r.steps.some((s) => s.kind === "ai" && s.status === "skipped")
              ? "None: the step didn't fit, so nothing was held."
              : r.steps.some((s) => s.waits > 0)
                ? run.finishedAt
                  ? "None: its step waited for other requests' holds (runs or chat replies) and never held."
                  : run.parked
                    ? "None yet: it waits for you to resume."
                    : "None yet: its step waits for another request's hold (a run or a chat reply)."
                : "None: no AI step has priced its call."}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {r.holds.map((h) => (
              <li key={h.ref} className="rounded-lg border border-zinc-800 px-2 py-1.5">
                <div className="font-mono break-all text-zinc-400">{h.ref}</div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-zinc-300">
                  <span>{credits(h.held)} held</span>
                  <span>{credits(h.credits)} charged</span>
                  <span>{h.started ? "called" : "not called"}</span>
                  {h.started && <span>{h.done ? "ended" : "not ended"}</span>}
                  <span className={h.settledAt ? "" : "text-amber-300"}>{h.settledAt ? `settled ${when(h.settledAt)}` : "open"}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="mb-1 font-medium text-zinc-300">Receipt</div>
        {r.fingerprint ? (
          <p className="font-mono break-all text-zinc-400">Fingerprint {r.fingerprint}</p>
        ) : (
          <p className="text-zinc-500">{run.finishedAt ? "This run has no fingerprint (it never started)." : "Its fingerprint is made when the run ends."}</p>
        )}
        {r.receipt && (
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] leading-relaxed text-zinc-300">
            {JSON.stringify(r.receipt, null, 1)}
          </pre>
        )}
        {/* Only once it has a fingerprint: a copy saved before would have nothing to check. */}
        {r.fingerprint && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button onClick={() => void download()} className={button}>
              Download receipt JSON
            </button>
            {/* Its file input takes the focus: the ring goes on the label, as on the buttons. */}
            <label className={`${button} cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-white`}>
              Compare with a downloaded receipt
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
          </div>
        )}
        {check && (
          <p role="status" className="mt-1 break-words text-zinc-300">
            {check}
          </p>
        )}
      </div>
    </div>
  );
}

export type Health = Card["health"];

/**
 * The burn-in card. ready: automations can run here (production, with its setup complete). onHealth
 * gets the cron health lines with each load, and onRunEnded is called when a run it shows ends, so
 * the tab's other lines can follow.
 */
export function AutomationBurnIn({ onHealth, onRunEnded }: { onHealth?: (health: Health) => void; onRunEnded?: () => void } = {}) {
  const [card, setCard] = useState<Card | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  // When the card last loaded: shown when a load fails, and what "tries again at" is compared with.
  const [loadedAt, setLoadedAt] = useState(0);

  // Bumped to load the card again now (after a change).
  const [again, setAgain] = useState(0);
  const load = useCallback(() => setAgain((n) => n + 1), []);
  // The runs that had ended at the last load (null before the first).
  const ended = useRef<Set<string> | null>(null);
  const callbacks = useRef({ onHealth, onRunEnded });
  useEffect(() => {
    callbacks.current = { onHealth, onRunEnded };
  });

  const going = card?.runs.some((r) => goingNow(r, loadedAt)) ?? false;
  useEffect(() => {
    let live = true;
    const got = (c: Card) => {
      setCard(c);
      setLoadedAt(Date.now());
      setError("");
      callbacks.current.onHealth?.(c.health);
      const now = new Set(c.runs.filter((r) => r.finishedAt).map((r) => r.id));
      if (ended.current && [...now].some((id) => !ended.current!.has(id))) callbacks.current.onRunEnded?.();
      ended.current = now;
    };
    const get = () =>
      api<Card>("/api/admin/automations")
        .then((c) => live && got(c))
        .catch((err) => live && setError(errorOf(err)));
    void get();
    // Every 5 s while a run goes on, else every 30 s (a scheduled run may start, or one waiting tries again), only while the tab is shown.
    const timer = setInterval(() => document.visibilityState === "visible" && void get(), going ? 5000 : 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [going, again]);

  if (error && !card) return <p className="text-sm text-red-400">{error}</p>;
  if (!card) return <p className="text-sm text-zinc-500">Loading the burn-in…</p>;
  const ready = card.setup.server && card.setup.missing.length === 0;
  const language = card.noticeLanguage;
  const charged = `${credits(card.spentThisMonth)} charged on automations this month`;
  return (
    <div className="space-y-4">
      <Section title="Automations for everyone" note="Every server sees this switch within 30 seconds.">
        <OpenSwitch key={String(card.setup.open)} open={card.setup.open} ready={ready && card.setup.key === "automations"} onChange={load} />
      </Section>

      <Section
        title="Burn-in: make a test automation"
        note={card.setup.open ? "On your own account, at chat's prices." : "On your own account, at chat's prices. Nobody else can use automations yet."}
      >
        <MakeTest ready={ready} onMade={load} />
      </Section>

      <Section title="Your test automations" note={card.heldNow > 0 ? `${charged}, and ${credits(card.heldNow)} held now by steps under way` : charged}>
        {card.automations.length === 0 ? (
          <p className="text-sm text-zinc-500">None yet.</p>
        ) : (
          <ul className="text-sm">
            {card.automations.map((a) => (
              <TestAutomation key={`${a.id}:${a.status}:${a.quotedMax}`} a={a} language={language} ready={ready} onChange={load} />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Runs"
        note="The last 20. Open one for its steps, holds and receipt."
        right={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {error && (
              <span role="status" className="text-xs text-red-400">
                Not up to date (loaded {when(loadedAt)}): {error}
              </span>
            )}
            <button onClick={load} className={button}>
              Refresh
            </button>
          </div>
        }
      >
        {card.runs.length === 0 ? (
          <p className="text-sm text-zinc-500">No runs yet.</p>
        ) : (
          <ul className="text-sm">
            {card.runs.map((r) => (
              <li key={r.id} className="border-b border-zinc-900 py-2 last:border-b-0">
                <button onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-start">
                  <span className="min-w-0 break-words text-zinc-100">{r.name}</span>
                  <Pill status={r.status} outcome={r.outcome || undefined} />
                  {waitNote(r, loadedAt) && <span className="text-xs text-amber-300">{waitNote(r, loadedAt)}</span>}
                  {r.deleted && <span className="text-xs text-zinc-500">automation deleted</span>}
                  <span className="text-xs text-zinc-500">{when(r.startedAt || r.scheduledAt || r.createdAt)}</span>
                  <span className="ms-auto text-xs tabular-nums text-zinc-300">
                    largest hold {num(r.held)} · {num(r.credits)} charged
                    {r.refunded > 0 && <span className="text-emerald-300"> · {num(r.refunded)} refunded</span>}
                    {r.openHolds > 0 && <span className="text-amber-300"> · {r.openHolds} open</span>}
                  </span>
                </button>
                {open === r.id && <RunReceipt runId={r.id} language={language} onChange={load} />}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Notices" note="What the runs told you, as a user will see it (in your language)">
        {card.notices.length === 0 ? (
          <p className="text-sm text-zinc-500">None yet.</p>
        ) : (
          <Theirs language={language}>
            <ul className="space-y-2 text-sm">
              {card.notices.map((n) => (
                <li key={n.id} className="rounded-lg border border-zinc-800 p-3">
                  <div className="flex flex-wrap items-start gap-x-2 gap-y-1 sm:flex-nowrap">
                    {!n.read && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-hidden />}
                    <div className="min-w-0 flex-1">
                      <div className="font-medium break-words text-zinc-100">{n.title}</div>
                      <div className="mt-0.5 text-zinc-300">{n.text}</div>
                      {n.body && <div dir="auto" className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-xs text-zinc-400">{n.body}</div>}
                      {n.offer && <div className="mt-1 text-xs text-primary-soft">{n.offer.text}</div>}
                    </div>
                    <span className={`basis-full text-[11px] text-zinc-500 sm:basis-auto sm:shrink-0 sm:ps-0 ${n.read ? "" : "ps-4"}`}>
                      {whenIn(n.createdAt, card.noticeLocale)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Theirs>
        )}
      </Section>
    </div>
  );
}
