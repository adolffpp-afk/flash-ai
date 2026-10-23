"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formFromChat, formFromSpec, type AutomationForm, type AutomationTemplate } from "@/lib/automation-form";
import { plainLine, zoneName, type AiStep, type Spec } from "@/lib/automations";
import { msg } from "@/lib/i18n";
import type { Me } from "@/lib/store";
import { useT, type T } from "@/lib/use-t";
import { AutomationEditor, liveTemplates, type Saved } from "./AutomationEditor";
import { ICONS, Icon } from "./Home";
import { RunReceipt } from "./RunReceipt";
import {
  at,
  browserZone,
  call,
  creditsText,
  errorOf,
  fieldBox,
  n,
  primaryButton,
  quietButton,
  runState,
  saveFile,
  smallButton,
  StateBadge,
  Switch,
  type AutomationView,
  type Failed,
  type Priced,
  type RunListItem,
} from "./automation-shared";

/*
 * Automations, for everyone once /admin opens them: the person's automations with when each runs
 * next, its last result and this month's credits, an on/off switch, and for each its runs and their
 * receipts. A new one starts from a few words ("Describe it", which Flash fills in for the price it
 * shows first), a template or scratch, in the editor, which shows the price first. A paused one says
 * why, with its one-tap fix. Opened from the menu, from a notice (?automations=<id>&run=<runId>), which
 * opens that automation or run, or from "Automate this" under a chat answer, which opens the editor
 * filled in from it. A run's answer opens in a new chat (Open in chat).
 */

type List = { automations: AutomationView[]; topupFloor: number; economy: boolean; draftCredits: number };
type Drafted = { spec: Spec; name: string; timeZone: string; credits: number };
type Runs = { runs: RunListItem[]; cursor: string | null; total: number };
type View =
  | { kind: "list" }
  // filled: a form Flash filled in (n tells one apart from the last).
  | { kind: "new"; template: AutomationTemplate | null; filled?: AutomationForm; n?: number }
  | { kind: "edit"; id: string; limits?: boolean }
  | { kind: "detail"; id: string }
  | { kind: "run"; id: string; runId: string };

// The cheaper way a paused automation offers, in the same words as its notice (see OFFERS in notifications.ts).
const OFFER_WORDS = { quick: msg("Use Quick research instead (up to {credits} credits)"), sonic: msg("Use Sonic instead (up to {credits} credits)") };
// Why it is paused, in the same words as its notice (see NOTICES in automations.ts).
const WAITING_CREDITS = msg("Waiting for credits: the next run needs up to {credits} credits. It starts again by itself once you have them.");
const MONTH_CAP = msg("Paused until {date}: this month's {credits} credits are used");
const PRICE_UP = msg("Paused: a run now needs up to {credits} credits, more than its limit of {cap}.");
const FAILING = msg("Paused after 3 failed runs");
const UNCONFIRMED = msg("Confirm your email to use automations.");
const ONCE_PASSED = msg("This automation's time has passed. Choose a new time to turn it on again.");
// The last run's result in a row of the list, by its automation's last status.
const LAST_WORDS: Record<string, string> = {
  done: msg("Done"),
  nothing_new: msg("Nothing new"),
  failed: msg("Failed"),
  interrupted: msg("Interrupted"),
  stopped: msg("Stopped"),
  stopped_by_user: msg("Stopped"),
  run_cap: msg("Stopped at your limit"),
  cut_short: msg("Cut short"),
  missed: msg("Missed"),
  overlap: msg("Skipped"),
  capacity: msg("Skipped"),
  no_credits: msg("Not enough credits"),
  topup_floor: msg("Skipped"),
  month_cap: msg("Skipped"),
  price_up: msg("Skipped"),
};

const ZONE_KEPT = (userId: string) => `flash:automations-zone-kept:${userId}`;
const requestId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");

/** An automation's state as its row shows it: Waiting for credits and Paused until say more than Paused. */
function stateLine(t: T, a: AutomationView): { badge: string; words?: string } {
  if (a.status !== "paused") return { badge: a.status };
  if (a.pausedReason === "credits") return { badge: "waiting", words: t("Waiting for credits") };
  if ((a.pausedReason === "month_cap" || a.pausedReason === "day_cap") && a.resumeAt) return { badge: "paused", words: t("Paused until {date}", { date: at(t, a.resumeAt) }) };
  return { badge: "paused" };
}

/** Whether its switch shows: a schedule that is on, paused or a draft (not finished, and not a one-off whose time has passed). */
const canSwitch = (a: AutomationView) => a.spec?.trigger.type === "schedule" && (a.status === "on" || ((a.status === "paused" || a.status === "draft") && !a.timePassed));

/** The automation's one AI step, when it has one this panel can offer a cheaper way for. */
const aiStepOf = (spec: Spec | null) => (spec?.steps.filter((s) => s.do === "ai").length === 1 ? (spec.steps.find((s) => s.do === "ai") as AiStep) : null);

export default function AutomationsPanel({
  me,
  start,
  isLive,
  onClose,
  onCredits,
  onRunDone,
  draft,
  review,
  onOpenChat,
  onSpent,
}: {
  me: Me;
  // Opened from a notice: that automation, and that run's receipt.
  start: { automation: string; run?: string } | null;
  // Opened from "Automate this": what was asked, and whether its answer searched the web.
  draft?: { asked: string; engine: "text" | "search" } | null;
  // Opened from "Review automation" in chat: the question, filled in by Flash as the panel opens, for the price the card showed.
  review?: { text: string; price: number } | null;
  // A run's answer was opened in a new chat: the page shows it.
  onOpenChat: (projectId: string) => void;
  // Credits were spent here (a description filled in): the page's balance loads again.
  onSpent: () => void;
  isLive: (e: "text" | "search") => boolean;
  onClose: () => void;
  onCredits: () => void;
  onRunDone: (name: string, ok: boolean, startedAt: number) => void;
}) {
  const t = useT();
  const [list, setList] = useState<List | null>(null);
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState<View>(() =>
    start
      ? start.run
        ? { kind: "run", id: start.automation, runId: start.run }
        : { kind: "detail", id: start.automation }
      : draft
        ? { kind: "new", template: null, filled: formFromChat(draft.asked, draft.engine, browserZone()), n: 0 }
        : { kind: "list" },
  );
  const [runs, setRuns] = useState<(Runs & { id: string }) | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  // A price the server gave when the one shown was out of date, per automation (Turn on, Run now).
  const [prices, setPrices] = useState<Record<string, number>>({});
  // A cheaper way for an automation waiting for credits, priced by the server.
  const [offer, setOffer] = useState<{ id: string; kind: "quick" | "sonic"; spec: Spec; worst: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [zoneKept, setZoneKept] = useState(true);
  // Describe it: the words typed, the price when the server gave a newer one, and why it didn't work.
  const [described, setDescribed] = useState(review?.text ?? "");
  const [draftPrice, setDraftPrice] = useState<number | null>(null);
  const [describeError, setDescribeError] = useState<{ text: string; credits: boolean } | null>(null);
  const filledCount = useRef(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const here = browserZone();

  const load = useCallback(async () => {
    try {
      setList(await call<List>("/api/automations"));
      setLoadError("");
    } catch (err) {
      setLoadError(errorOf(err));
    }
  }, []);
  const loadRuns = useCallback(async (id: string, cursor?: string | null) => {
    try {
      const got = await call<Runs>(`/api/automations/${encodeURIComponent(id)}/runs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      setRuns((was) => (cursor && was?.id === id ? { ...got, id, runs: [...was.runs, ...got.runs] } : { ...got, id }));
    } catch (err) {
      setError(errorOf(err));
    }
  }, []);

  useEffect(() => {
    closeRef.current?.focus();
    // Loaded from the server when it opens (its answer sets the list).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    try {
      setZoneKept(localStorage.getItem(ZONE_KEPT(me.user.id)) === here);
    } catch {
      setZoneKept(false);
    }
  }, [load, me.user.id, here]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && view.kind !== "new" && view.kind !== "edit" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, view.kind]);

  // An automation's runs load when it opens, and again when it changes.
  const shownId = view.kind === "detail" || view.kind === "run" || view.kind === "edit" ? view.id : "";
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (shownId) void loadRuns(shownId);
  }, [shownId, loadRuns]);

  const automation = list?.automations.find((a) => a.id === shownId) ?? null;
  const go = (next: View) => {
    setView(next);
    setError("");
    setConfirmDelete(false);
  };
  const changed = () => {
    void load();
    if (shownId) void loadRuns(shownId);
  };

  /** A change to an automation (on, paused, a zone, limits), at the price it was shown at. */
  async function patch(a: AutomationView, body: Record<string, unknown>, o: { priced?: number } = {}): Promise<boolean> {
    setBusy(a.id);
    setError("");
    try {
      await call(`/api/automations/${encodeURIComponent(a.id)}`, { method: "PATCH", json: { ...body, ...(o.priced !== undefined && { seenMax: o.priced }) } });
      setPrices((p) => Object.fromEntries(Object.entries(p).filter(([id]) => id !== a.id)));
      await load();
      return true;
    } catch (err) {
      const failed = err as Failed;
      if (failed.code === "price_changed" && failed.estimate) setPrices((p) => ({ ...p, [a.id]: failed.estimate!.worst }));
      setError(errorOf(err));
      return false;
    } finally {
      setBusy("");
    }
  }
  const priceOf = (a: AutomationView) => prices[a.id] ?? a.quotedMax;
  const turnOn = (a: AutomationView) => patch(a, { status: "on" }, { priced: priceOf(a) });
  const turn = (a: AutomationView, on: boolean) => void (on ? turnOn(a) : patch(a, { status: "paused" }));

  async function runNow(a: AutomationView) {
    setBusy(a.id);
    setError("");
    try {
      const started = await call<{ run: { id: string }; note?: string }>(`/api/automations/${encodeURIComponent(a.id)}/run`, { method: "POST", json: { requestId: requestId(), seenMax: priceOf(a) } });
      setNote(started.note ?? "");
      changed();
      go({ kind: "run", id: a.id, runId: started.run.id });
    } catch (err) {
      const failed = err as Failed;
      if (failed.code === "price_changed" && failed.estimate) setPrices((p) => ({ ...p, [a.id]: failed.estimate!.worst }));
      setError(errorOf(err));
    } finally {
      setBusy("");
    }
  }

  async function remove(a: AutomationView) {
    setBusy(a.id);
    try {
      await call(`/api/automations/${encodeURIComponent(a.id)}`, { method: "DELETE" });
      await load();
      go({ kind: "list" });
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setBusy("");
    }
  }

  /** Describe it: the words become the editor's form, filled in by Flash for the price shown. */
  async function describe(price: number, words = described) {
    const text = words.trim();
    if (!text || busy) return;
    setBusy("describe");
    setDescribeError(null);
    try {
      const got = await call<Drafted>("/api/automations/draft", { method: "POST", json: { text, timeZone: here, acceptedCredits: price } });
      onSpent();
      const filled = formFromSpec(got.spec, got.name, got.timeZone);
      if (!filled) throw new Error(t("Flash couldn't turn that into steps. Try again in other words."));
      setDescribed("");
      go({ kind: "new", template: null, filled, n: ++filledCount.current });
    } catch (err) {
      const failed = err as Failed;
      if (failed.code === "price_changed" && failed.credits) setDraftPrice(failed.credits);
      // What didn't work may still have used the credits it says.
      if (failed.status === 502) onSpent();
      setDescribeError({ text: errorOf(err), credits: failed.code === "out_of_credits" });
    } finally {
      setBusy("");
    }
  }

  // Review automation: filled in once, as the panel opens (the ref keeps the effect running twice in
  // development from asking, and paying, twice). The box shows the words and its progress meanwhile.
  const reviewed = useRef(false);
  useEffect(() => {
    if (!review || reviewed.current) return;
    reviewed.current = true;
    void describe(review.price, review.text);
    // Once, with what the panel opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function downloadReceipts(a: AutomationView) {
    try {
      const file = await call<unknown>(`/api/automations/${encodeURIComponent(a.id)}/runs?format=receipts`);
      saveFile(`receipts-${a.id.replace(/[^A-Za-z0-9_-]/g, "")}.json`, JSON.stringify(file, null, 1));
    } catch (err) {
      setError(errorOf(err));
    }
  }

  // A paused-for-credits automation's cheaper way, priced by the server once its page opens.
  useEffect(() => {
    const step = aiStepOf(automation?.spec ?? null);
    if (!automation || automation.status !== "paused" || automation.pausedReason !== "credits" || !step) return;
    const kind = step.mode === "research" ? "quick" : step.mode === "write" && step.level !== "sonic" ? "sonic" : null;
    if (!kind) return;
    const spec: Spec = { ...automation.spec!, steps: automation.spec!.steps.map((s) => (s.do === "ai" ? (kind === "quick" ? { ...s, mode: "quick" } : { ...s, level: "sonic" }) : s)) };
    let live = true;
    call<Priced>("/api/automations/estimate", { method: "POST", json: { spec, name: automation.name, timeZone: automation.timeZone } })
      .then((got) => live && got.estimate.worst < automation.quotedMax && setOffer({ id: automation.id, kind, spec, worst: got.estimate.worst }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [automation]);

  // Automations set in another zone than the browser's now (a trip, a move): offered once per zone.
  const away = (list?.automations ?? []).filter((a) => a.timeZone !== here && a.status !== "finished");
  const awayZone = away[0]?.timeZone ?? "";
  const keepZone = () => {
    try {
      localStorage.setItem(ZONE_KEPT(me.user.id), here);
    } catch {
      // Not kept: it asks again next time.
    }
    setZoneKept(true);
  };
  async function moveZone() {
    for (const a of away.filter((x) => x.timeZone === awayZone)) {
      if (!(await patch(a, { timeZone: here }, { priced: priceOf(a) }))) return;
    }
    keepZone();
  }

  const title =
    view.kind === "new" ? t("New automation") : view.kind === "edit" ? t("Edit automation") : view.kind === "list" || !automation ? t("Automations") : automation.name;
  const templates = list ? liveTemplates(isLive, list.economy) : [];

  const header = (
    <div className="flex items-center gap-3 border-b border-white/6 px-5 py-4">
      {view.kind !== "list" && (
        <button
          type="button"
          onClick={() => go(view.kind === "run" || view.kind === "edit" ? { kind: "detail", id: view.id } : { kind: "list" })}
          className="text-sm text-zinc-400 hover:text-zinc-100"
          aria-label={t("Back")}
        >
          <span className="inline-block rtl:-scale-x-100" aria-hidden>
            ←
          </span>
        </button>
      )}
      <h2 dir="auto" className="min-w-0 flex-1 truncate text-lg font-medium tracking-tight">
        {title}
      </h2>
      {view.kind === "list" && list && list.automations.length > 0 && (
        <button type="button" onClick={() => go({ kind: "new", template: null })} className={`${primaryButton} px-3.5 py-1.5`}>
          {t("New automation")}
        </button>
      )}
      <button ref={closeRef} type="button" onClick={onClose} className="rounded-full p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100" aria-label={t("Close")}>
        ✕
      </button>
    </div>
  );

  const errorLine = error && (
    <p role="alert" dir="auto" className="text-sm text-red-400">
      {error}
    </p>
  );

  function body() {
    if (!list)
      return (
        <p role={loadError ? "alert" : "status"} className={`text-sm ${loadError ? "text-red-400" : "text-zinc-500"}`}>
          {loadError || t("Loading…")}
        </p>
      );

    if (view.kind === "edit" && !automation) return <p className="text-sm text-zinc-500">{t("This automation was deleted.")}</p>;
    if (view.kind === "new" || view.kind === "edit")
      return (
        <AutomationEditor
          key={view.kind === "edit" ? view.id : view.filled ? `filled:${view.n}` : (view.template?.id ?? "blank")}
          automation={view.kind === "edit" ? automation : null}
          template={view.kind === "new" ? view.template : null}
          filled={view.kind === "new" ? view.filled : null}
          economy={list.economy}
          topupFloor={list.topupFloor}
          focusLimits={view.kind === "edit" && view.limits}
          lastRuns={runs && runs.id === shownId ? runs.runs.filter((r) => r.status === "done").map((r) => r.credits) : []}
          onSaved={(s: Saved) => {
            setNote(s.note ?? "");
            void load();
            go(s.runId ? { kind: "run", id: s.automation.id, runId: s.runId } : { kind: "detail", id: s.automation.id });
          }}
          onCancel={() => go(view.kind === "edit" ? { kind: "detail", id: view.id } : { kind: "list" })}
        />
      );

    if (view.kind === "run")
      return (
        <div className="space-y-3">
          {note && (
            <p role="status" dir="auto" className="rounded-xl bg-white/[0.04] px-3 py-2 text-sm text-zinc-300">
              {note}
            </p>
          )}
          <RunReceipt
            key={view.runId}
            runId={view.runId}
            automation={automation}
            onChanged={changed}
            onOpenRun={(runId, said) => {
              setNote(said ?? "");
              go({ kind: "run", id: view.id, runId });
            }}
            onCredits={onCredits}
            onEditLimits={() => go({ kind: "edit", id: view.id, limits: true })}
            onRunDone={onRunDone}
            onOpenChat={onOpenChat}
          />
        </div>
      );

    if (view.kind === "detail") {
      if (!automation) return <p className="text-sm text-zinc-500">{t("This automation was deleted.")}</p>;
      return detail(automation);
    }

    return listView();
  }

  function listView() {
    const all = list!.automations;
    // Paused and finished ones at the bottom, each group as the server orders them (latest change first).
    const rank = (a: AutomationView) => (a.status === "on" ? 0 : a.status === "draft" ? 1 : a.status === "paused" ? 2 : 3);
    const sorted = [...all].sort((a, b) => rank(a) - rank(b));
    return (
      <div className="space-y-5">
        {!zoneKept && awayZone && (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-sky-400/20 bg-sky-400/[0.06] px-4 py-3 text-sm text-zinc-200 light:bg-sky-50">
            <p className="min-w-0 flex-1">
              {t("You're in {here} now, but your automations run on {zone}. Change?", { here: zoneName(here, t.locale), zone: zoneName(awayZone, t.locale) })}
            </p>
            <button type="button" onClick={() => void moveZone()} disabled={Boolean(busy)} className={smallButton}>
              {t("Change to {zone}", { zone: zoneName(here, t.locale) })}
            </button>
            <button type="button" onClick={keepZone} className="text-sm text-zinc-400 hover:text-zinc-100">
              {t("Keep")}
            </button>
          </div>
        )}
        {errorLine}

        {all.length === 0 ? (
          <div className="space-y-6">
            <div className="flex flex-col items-center gap-3 px-2 pt-4 text-center">
              <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/25">
                <Icon d={ICONS.bolt} className="h-6 w-6" />
              </span>
              <p className="text-lg font-medium text-zinc-100">{t("Tasks Flash runs for you on a schedule")}</p>
              <p className="max-w-md text-sm leading-relaxed text-zinc-400">
                {t("Pick a template or start from scratch. You see the price before anything runs, and every run gets a receipt.")}
              </p>
            </div>
            {describeBox()}
            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-white/8" />
              <button type="button" onClick={() => go({ kind: "new", template: null })} className={quietButton}>
                {t("New automation")}
              </button>
              <span className="h-px flex-1 bg-white/8" />
            </div>
            {templateGrid()}
          </div>
        ) : (
          <>
            {describeBox()}
            <ul className="space-y-2.5">
              {sorted.map((a) => {
                const state = stateLine(t, a);
                const last = a.lastStatus ? LAST_WORDS[a.lastStatus] : "";
                const switchable = canSwitch(a);
                return (
                  <li key={a.id} className="group relative rounded-2xl border border-white/8 bg-white/[0.02] transition hover:border-white/15 hover:bg-white/[0.04]">
                    <button type="button" onClick={() => go({ kind: "detail", id: a.id })} className="block w-full px-4 py-3.5 pe-20 text-start">
                      <span className="flex flex-wrap items-center gap-2">
                        <span dir="auto" className="min-w-0 truncate font-medium text-zinc-100">
                          {a.name}
                        </span>
                        <StateBadge state={state.badge} t={t} />
                        {a.unseen > 0 && (
                          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
                            {t("{count} new", { count: a.unseen >= 100 ? "99+" : n(t, a.unseen) })}
                          </span>
                        )}
                      </span>
                      <span className="mt-1 block text-sm text-zinc-400">
                        {a.schedule ? a.schedule.sentence : t("Only when you run it")}
                        {a.schedule && a.timeZone !== here && <span className="text-zinc-500"> · {zoneName(a.timeZone, t.locale)}</span>}
                      </span>
                      {state.words && <span className="mt-0.5 block text-sm text-amber-300 light:text-amber-700">{state.words}</span>}
                      {a.next && a.status === "on" && <span className="mt-0.5 block text-sm text-zinc-400">{a.next}</span>}
                      <span className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs tabular-nums text-zinc-500">
                        {last && a.lastEndedAt > 0 && (
                          <span>{t("Last run: {result} {date}, {cost}", { result: t(last), date: at(t, a.lastEndedAt), cost: creditsText(t, a.lastCredits) })}</span>
                        )}
                        <span>{t("This month: {used} of {cap} credits", { used: n(t, a.spentThisMonth), cap: n(t, a.capMonth) })}</span>
                      </span>
                    </button>
                    {switchable && (
                      <span className="absolute end-4 top-4">
                        <Switch on={a.status === "on"} disabled={busy === a.id} onChange={(on) => turn(a, on)} label={t("{name} on", { name: a.name })} />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {templates.length > 0 && (
              <div className="space-y-2.5 pt-2">
                <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">{t("Templates")}</p>
                {templateGrid()}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  function describeBox() {
    const price = draftPrice ?? list!.draftCredits;
    const working = busy === "describe";
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void describe(price);
        }}
        className="space-y-3 rounded-2xl border border-primary/25 bg-primary/[0.05] p-4"
      >
        <label htmlFor="automation-describe" className="block text-sm font-medium text-zinc-100">
          {t("Describe what Flash should do, and when")}
        </label>
        <textarea
          id="automation-describe"
          value={described}
          maxLength={2000}
          rows={2}
          dir="auto"
          onChange={(e) => setDescribed(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, as in chat; Shift+Enter starts a new line.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void describe(price);
            }
          }}
          placeholder={t("Every Monday at 8:00, research news about electric cars and sum it up in 5 points")}
          className={`${fieldBox} resize-y leading-relaxed`}
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="min-w-0 flex-1 text-xs tabular-nums text-zinc-400">
            {t("Turning this into steps costs {cost}. You check it before anything is saved.", { cost: creditsText(t, price) })}
          </p>
          <button type="submit" disabled={!described.trim() || Boolean(busy)} className={primaryButton}>
            {working ? t("Filling it in…") : t("Fill it in")}
          </button>
        </div>
        {describeError && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" dir="auto" className="min-w-0 flex-1 text-sm text-red-400">
              {describeError.text}
            </p>
            {describeError.credits && (
              <button type="button" onClick={onCredits} className={smallButton}>
                {t("Add credits")}
              </button>
            )}
          </div>
        )}
      </form>
    );
  }

  function templateGrid() {
    return (
      // Three across when there are three (or six), else two: no card left alone in a row.
      <div className={`grid gap-2.5 ${templates.length % 3 === 0 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
        {templates.map((x) => (
          <button
            key={x.id}
            type="button"
            onClick={() => go({ kind: "new", template: x })}
            className="flex flex-col rounded-2xl border border-white/8 bg-white/[0.02] p-4 text-start transition hover:border-primary/40 hover:bg-white/[0.04]"
          >
            <span className="block font-medium text-zinc-100">{t(x.title)}</span>
            <span className="mt-1 block text-sm leading-snug text-zinc-400">{t(x.about)}</span>
          </button>
        ))}
      </div>
    );
  }

  function pauseFix(a: AutomationView) {
    if (a.status === "finished") return { text: t("This automation finished. It won't run again."), fixes: [] };
    if (a.timePassed) return { text: t(ONCE_PASSED), fixes: [{ label: t("Choose a new time"), run: () => go({ kind: "edit", id: a.id }) }] };
    if (a.status !== "paused") return null;
    const resume = { label: t("Resume"), run: () => void turnOn(a) };
    switch (a.pausedReason) {
      case "credits":
        return {
          text: t(WAITING_CREDITS, { credits: n(t, a.needCredits) }),
          fixes: [
            { label: t("Add credits"), run: onCredits },
            ...(offer?.id === a.id
              ? [{ label: t(OFFER_WORDS[offer.kind], { credits: n(t, offer.worst) }), run: () => void patch(a, { spec: offer.spec, status: "on" }, { priced: offer.worst }).then((ok) => ok && setOffer(null)) }]
              : []),
          ],
        };
      case "month_cap":
        return { text: t(MONTH_CAP, { date: at(t, a.resumeAt), credits: n(t, a.capMonth) }), fixes: [{ label: t("Raise the limit"), run: () => go({ kind: "edit", id: a.id, limits: true }) }] };
      case "day_cap":
        return { text: t("Paused until {date}", { date: at(t, a.resumeAt) }), fixes: [] };
      case "price_up": {
        const need = Math.max(a.needCredits, prices[a.id] ?? 0);
        return {
          text: t(PRICE_UP, { credits: n(t, a.needCredits), cap: n(t, a.capRun) }),
          fixes: [
            {
              label: t("Accept {credits}", { credits: n(t, need) }),
              run: () => void patch(a, { status: "on", capRun: Math.max(a.capRun, need), capMonth: Math.max(a.capMonth, need) }, { priced: need }),
            },
            { label: t("Choose a lower level"), run: () => go({ kind: "edit", id: a.id }) },
          ],
        };
      }
      case "failing":
        return { text: t(FAILING), fixes: [{ label: t("Try again"), run: () => void turnOn(a) }] };
      case "unconfirmed":
        return { text: t(UNCONFIRMED), fixes: [resume] };
      default:
        return { text: "", fixes: [resume] };
    }
  }

  function detail(a: AutomationView) {
    const fix = pauseFix(a);
    const step = aiStepOf(a.spec);
    const editable = Boolean(a.spec && formFromSpec(a.spec, a.name, a.timeZone));
    const canRun = a.status !== "paused";
    const switchable = canSwitch(a);
    const state = stateLine(t, a);
    return (
      <div className="space-y-5">
        <section className="space-y-3 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              <StateBadge state={state.badge} t={t} />
              <p className="text-sm text-zinc-300">
                {a.schedule ? a.schedule.sentence : t("Only when you run it")}
                {a.schedule && <span className="text-zinc-500"> · {zoneName(a.timeZone, t.locale)}</span>}
              </p>
              {a.next && a.status === "on" && <p className="text-sm text-zinc-400">{a.next}</p>}
              <p className="text-xs tabular-nums text-zinc-500">
                {t("This month: {used} of {cap} credits", { used: n(t, a.spentThisMonth), cap: n(t, a.capMonth) })} · {t("At most {credits} credits a run", { credits: n(t, a.capRun) })}
              </p>
            </div>
            {switchable && <Switch on={a.status === "on"} disabled={busy === a.id} onChange={(on) => turn(a, on)} label={t("{name} on", { name: a.name })} />}
          </div>
          {step && (
            <p dir="auto" className="line-clamp-4 whitespace-pre-wrap rounded-xl bg-white/[0.03] px-3 py-2 text-sm leading-relaxed text-zinc-300">
              {step.prompt}
            </p>
          )}
          {fix && (fix.text || fix.fixes.length > 0) && (
            <div className="space-y-2 rounded-xl bg-amber-400/10 px-3 py-2.5 light:bg-amber-50">
              {fix.text && (
                <p dir="auto" className="text-sm text-amber-200 light:text-amber-800">
                  {fix.text}
                </p>
              )}
              {fix.fixes.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {fix.fixes.map((f) => (
                    <button key={f.label} type="button" onClick={f.run} disabled={busy === a.id} className={smallButton}>
                      {f.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {note && (
            <p role="status" dir="auto" className="text-sm text-zinc-300">
              {note}
            </p>
          )}
          {errorLine}
          <div className="flex flex-wrap items-center gap-2">
            {canRun && (
              <button type="button" onClick={() => void runNow(a)} disabled={busy === a.id} className={primaryButton}>
                {t("Run now: at most {credits} credits", { credits: n(t, priceOf(a)) })}
              </button>
            )}
            {editable && (
              <button type="button" onClick={() => go({ kind: "edit", id: a.id })} className={quietButton}>
                {t("Edit")}
              </button>
            )}
            <button type="button" onClick={() => setConfirmDelete(true)} className="rounded-full px-4 py-2 text-sm text-zinc-400 transition hover:text-red-400">
              {t("Delete")}
            </button>
          </div>
          {confirmDelete && (
            <div role="alertdialog" aria-label={t("Delete")} className="space-y-2.5 rounded-xl border border-red-400/25 bg-red-400/[0.06] p-3">
              <p dir="auto" className="text-sm text-zinc-200">
                {t('Delete "{name}" and its {count} receipts? Credits already spent stay spent.', { name: a.name, count: n(t, runs?.id === a.id ? runs.total : 0) })}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => void remove(a)} disabled={busy === a.id} className="rounded-full bg-red-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-600 disabled:opacity-50">
                  {t("Delete")}
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)} className={quietButton}>
                  {t("Cancel")}
                </button>
                {runs?.id === a.id && runs.total > 0 && (
                  <button type="button" onClick={() => void downloadReceipts(a)} className="text-sm text-primary-soft hover:underline">
                    {t("Download receipts")}
                  </button>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">{t("Runs")}</p>
          {!runs || runs.id !== a.id ? (
            <p className="text-sm text-zinc-500">{t("Loading…")}</p>
          ) : runs.runs.length === 0 ? (
            <p className="text-sm text-zinc-500">{t("No runs yet. Its first run and each one after get a receipt here.")}</p>
          ) : (
            <ul className="divide-y divide-white/6 overflow-hidden rounded-2xl border border-white/8">
              {runs.runs.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => go({ kind: "run", id: a.id, runId: r.id })} className="flex w-full items-center gap-3 px-4 py-3 text-start transition hover:bg-white/[0.04]">
                    {!r.seen && r.finishedAt > 0 && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-label={t("New")} />}
                    <StateBadge state={runState(r)} t={t} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-zinc-200">{at(t, r.finishedAt || r.startedAt || r.createdAt)}</span>
                      {r.summary && (
                        <span dir="auto" className="block truncate text-xs text-zinc-500">
                          {plainLine(r.summary)}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-zinc-400">{creditsText(t, r.credits)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {runs?.id === a.id && runs.cursor && (
            <button type="button" onClick={() => void loadRuns(a.id, runs.cursor)} className={smallButton}>
              {t("Load more")}
            </button>
          )}
        </section>
      </div>
    );
  }

  return (
    // A tap outside leaves it, but not while the editor has a form open.
    <div className="fixed inset-0 z-40 flex items-stretch justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-6" onClick={() => view.kind !== "new" && view.kind !== "edit" && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("Automations")}
        className="flex h-full w-full max-w-3xl flex-col bg-zinc-950 text-zinc-100 sm:h-[80vh] sm:rounded-2xl sm:border sm:border-white/8"
        onClick={(e) => e.stopPropagation()}
      >
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{body()}</div>
      </div>
    </div>
  );
}
