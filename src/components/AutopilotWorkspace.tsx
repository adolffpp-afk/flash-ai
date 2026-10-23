"use client";

import { useEffect, useRef, useState } from "react";
import { isCheck, rulesOf, type AiStep, type CheckStep, type Expect, type Spec } from "@/lib/automations";
import { msg } from "@/lib/i18n";
import { LEVELS } from "@/lib/levels";
import { useT, type T } from "@/lib/use-t";
import { ICONS, Icon } from "./Home";
import { call, creditsText, errorOf, fieldBox, n, primaryButton, quietButton, smallButton, type AutomationView, type Failed, type Priced } from "./automation-shared";

/*
 * The Autopilot (Universal Autopilot A2): a goal in the person's words, the few questions Flash needs
 * answered (at most 3, once), and a plan of up to 3 steps with the checks each result must pass, priced
 * first. Nothing runs until Approve, which saves the plan as an automation that runs when its owner
 * starts it and runs it once at the price shown; its receipt then follows the run, and its verdict
 * (Done, Partly done, Needs you, Didn't finish) says what came of it. Admins only, like Automations.
 */

type Planned = { spec: Spec; name: string; cannot: string; timeZone: string; credits: number };
type Asked = { questions: string[]; credits: number };
type Stage = { kind: "goal" } | { kind: "questions"; questions: string[]; answers: string[] } | { kind: "review"; plan: Planned };

const MODE_WORDS: Record<string, string> = { write: msg("Write"), research: msg("Research"), quick: msg("Quick research") };
const STAGES = [msg("Goal"), msg("Questions"), msg("Plan"), msg("Run")];
const levelName = (id: string) => LEVELS.find((l) => l.id === id)?.short ?? id;
const requestId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");

/** What a step's free checks ask for, in the reader's words. */
function expectWords(t: T, e: Expect): string[] {
  return [
    ...(e.minWords ? [t("At least {count} words", { count: n(t, e.minWords) })] : []),
    ...(e.maxWords ? [t("At most {count} words", { count: n(t, e.maxWords) })] : []),
    ...(e.mentions ?? []).map((m) => t("Mentions “{text}”", { text: m })),
    ...(e.sources ? [t("At least {count} sources", { count: n(t, e.sources) })] : []),
  ];
}

export function AutopilotWorkspace({
  planCredits,
  timeZone,
  onSpent,
  onCredits,
  onStarted,
}: {
  // The most one planning call costs, as the list gave it.
  planCredits: number;
  timeZone: string;
  // Credits were spent (a plan or its questions): the page's balance loads again.
  onSpent: () => void;
  onCredits: () => void;
  // Approved: saved and started (or saved, with why it couldn't start).
  onStarted: (automation: AutomationView, runId: string | null, note?: string) => void;
}) {
  const t = useT();
  const [goal, setGoal] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "goal" });
  const [price, setPrice] = useState(planCredits);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<{ text: string; credits: boolean } | null>(null);
  // The plan's price: the most one run of it can cost and what it usually costs, from the estimate (a newer one when the server gave it).
  const [priced, setPriced] = useState<{ worst: number; typical: number } | null>(null);
  const worst = priced?.worst ?? null;
  const [name, setName] = useState("");
  const goalRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (stage.kind === "goal") goalRef.current?.focus();
  }, [stage.kind]);

  // The plan is priced as soon as it shows, as the editor prices a draft.
  const reviewed = stage.kind === "review" ? stage.plan : null;
  useEffect(() => {
    if (!reviewed) return;
    let live = true;
    call<Priced>("/api/automations/estimate", { method: "POST", json: { spec: reviewed.spec, name: reviewed.name, timeZone: reviewed.timeZone } })
      .then((got) => live && setPriced(got.estimate))
      .catch((err) => live && setError({ text: errorOf(err), credits: false }));
    return () => {
      live = false;
    };
  }, [reviewed]);

  /** Asks the planner: its questions, or with the answers (even none), the plan. */
  async function plan(answers?: { question: string; answer: string }[]) {
    const text = goal.trim();
    if (!text || busy) return;
    setBusy("plan");
    setError(null);
    try {
      const got = await call<Asked | Planned>("/api/automations/plan", { method: "POST", json: { goal: text, timeZone, acceptedCredits: price, ...(answers && { answers }) } });
      onSpent();
      if ("questions" in got) setStage({ kind: "questions", questions: got.questions, answers: got.questions.map(() => "") });
      else {
        setPriced(null);
        setName(got.name);
        setStage({ kind: "review", plan: got });
      }
    } catch (err) {
      const failed = err as Failed;
      if (failed.code === "price_changed" && failed.credits) setPrice(failed.credits);
      // What didn't work may still have used the credits it says.
      if (failed.status === 502) onSpent();
      setError({ text: errorOf(err), credits: failed.code === "out_of_credits" });
    } finally {
      setBusy("");
    }
  }

  /** Approve: saved as an automation its owner starts, and run once now, at the price shown. */
  async function approve(p: Planned, most: number) {
    if (busy) return;
    setBusy("approve");
    setError(null);
    const fields = { spec: p.spec, name: name.trim() || p.name, timeZone: p.timeZone, seenMax: most };
    try {
      const { automation } = await call<{ automation: AutomationView }>("/api/automations", { method: "POST", json: { ...fields, status: "on" } });
      try {
        const started = await call<{ run: { id: string }; note?: string }>(`/api/automations/${encodeURIComponent(automation.id)}/run`, { method: "POST", json: { requestId: requestId(), seenMax: most } });
        onStarted(automation, started.run.id, started.note);
      } catch (err) {
        // Saved, but it couldn't run now (credits, a limit): its page says why.
        onStarted(automation, null, errorOf(err));
      }
    } catch (err) {
      const failed = err as Failed;
      // The price went up since it was shown: the new one shows, to be pressed again.
      if (failed.code === "price_changed" && failed.estimate) setPriced(failed.estimate);
      setError({ text: errorOf(err), credits: false });
    } finally {
      setBusy("");
    }
  }

  const at = stage.kind === "goal" ? 0 : stage.kind === "questions" ? 1 : 2;
  const errorLine = error && (
    <div className="flex flex-wrap items-center gap-2">
      <p role="alert" dir="auto" className="min-w-0 flex-1 text-sm text-red-400">
        {error.text}
      </p>
      {error.credits && (
        <button type="button" onClick={onCredits} className={smallButton}>
          {t("Add credits")}
        </button>
      )}
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/25">
          <Icon d={ICONS.wand} className="h-5 w-5" />
        </span>
        <div className="min-w-0 space-y-1">
          <p className="text-lg font-medium text-zinc-100">{t("Give Flash a goal")}</p>
          <p className="text-sm leading-relaxed text-zinc-400">
            {t("Flash asks what it needs, plans the steps with a check on each result, and runs them once you approve. You see the price first.")}
          </p>
        </div>
      </div>

      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" aria-label={t("Steps")}>
        {STAGES.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            {i > 0 && <span className="h-px w-4 bg-white/15" aria-hidden />}
            <span
              aria-current={i === at ? "step" : undefined}
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${
                i === at ? "bg-primary/15 text-primary" : i < at ? "text-zinc-300" : "text-zinc-500"
              }`}
            >
              <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${i < at ? "bg-emerald-500 text-white" : i === at ? "bg-primary text-on-brand" : "border border-white/20"}`} aria-hidden>
                {i < at ? "✓" : n(t, i + 1)}
              </span>
              {t(s)}
            </span>
          </li>
        ))}
      </ol>

      {stage.kind === "goal" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void plan();
          }}
          className="space-y-3 rounded-2xl border border-primary/25 bg-primary/[0.05] p-4"
        >
          <label htmlFor="autopilot-goal" className="block text-sm font-medium text-zinc-100">
            {t("What do you want done?")}
          </label>
          <textarea
            ref={goalRef}
            id="autopilot-goal"
            value={goal}
            maxLength={2000}
            rows={4}
            dir="auto"
            onChange={(e) => setGoal(e.target.value)}
            placeholder={t("Find the three best-rated family dentists in Ottawa that are open on Saturdays, and write me a short comparison with prices and phone numbers")}
            className={`${fieldBox} resize-y leading-relaxed`}
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="min-w-0 flex-1 text-xs tabular-nums text-zinc-400">{t("Planning costs at most {cost}. Nothing runs until you approve the plan.", { cost: creditsText(t, price) })}</p>
            <button type="submit" disabled={!goal.trim() || Boolean(busy)} className={primaryButton}>
              {busy === "plan" ? t("Planning…") : t("Plan it")}
            </button>
          </div>
          {errorLine}
        </form>
      )}

      {stage.kind === "questions" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void plan(stage.questions.map((question, i) => ({ question, answer: stage.answers[i] ?? "" })));
          }}
          className="space-y-4 rounded-2xl border border-white/8 bg-white/[0.03] p-4"
        >
          <p className="text-sm text-zinc-300">{t("A few questions so the plan fits. Leave any blank and Flash makes a sensible choice.")}</p>
          {stage.questions.map((q, i) => (
            <div key={i} className="space-y-1.5">
              <label htmlFor={`autopilot-q${i}`} dir="auto" className="block text-sm font-medium text-zinc-100">
                {q}
              </label>
              <input
                id={`autopilot-q${i}`}
                value={stage.answers[i] ?? ""}
                maxLength={500}
                dir="auto"
                autoFocus={i === 0}
                onChange={(e) => setStage({ ...stage, answers: stage.answers.map((a, j) => (j === i ? e.target.value : a)) })}
                className={fieldBox}
              />
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="min-w-0 flex-1 text-xs tabular-nums text-zinc-400">{t("Making the plan costs at most {cost}.", { cost: creditsText(t, price) })}</p>
            <button type="button" onClick={() => setStage({ kind: "goal" })} disabled={Boolean(busy)} className={quietButton}>
              {t("Back")}
            </button>
            <button type="submit" disabled={Boolean(busy)} className={primaryButton}>
              {busy === "plan" ? t("Planning…") : t("Make the plan")}
            </button>
          </div>
          {errorLine}
        </form>
      )}

      {stage.kind === "review" && review(stage.plan)}
    </div>
  );

  function review(p: Planned) {
    const work = p.spec.steps.filter((s): s is AiStep => s.do === "ai" && !isCheck(s));
    const checkOf = (id: string) => p.spec.steps.find((s): s is CheckStep => isCheck(s) && s.of === id);
    const rulesFor = (id: string) => {
      const check = checkOf(id);
      return check ? rulesOf(check) : [];
    };
    const total = work.reduce((sum, s) => sum + expectWords(t, s.expect ?? {}).length + rulesFor(s.id).length, 0);
    return (
      <div className="space-y-4">
        <section className="space-y-3 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
          <label htmlFor="autopilot-name" className="block text-xs font-medium uppercase tracking-wider text-zinc-500">
            {t("Name")}
          </label>
          <input id="autopilot-name" value={name} maxLength={80} dir="auto" onChange={(e) => setName(e.target.value)} className={fieldBox} />
          <p dir="auto" className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-400">
            <span className="text-zinc-500">{t("Your goal:")}</span> {goal.trim()}
          </p>
        </section>

        {p.cannot && (
          <p dir="auto" className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.08] px-4 py-3 text-sm text-amber-200 light:bg-amber-50 light:text-amber-800">
            <span className="font-medium">{t("Your part:")}</span> {p.cannot}
          </p>
        )}

        <ol className="space-y-3">
          {work.map((s, i) => {
            const free = expectWords(t, s.expect ?? {});
            const rules = rulesFor(s.id);
            const from = (s.uses ?? []).map((id) => work.findIndex((w) => w.id === id) + 1).filter((x) => x > 0);
            return (
              <li key={s.id} className="space-y-3 rounded-2xl border border-white/8 bg-white/[0.02] p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">{n(t, i + 1)}</span>
                  <span className="text-sm font-medium text-zinc-100">
                    {t(MODE_WORDS[s.mode] ?? "")} · {levelName(s.level)}
                  </span>
                  {from.length > 0 && (
                    <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-zinc-400">
                      {t("Works from step {steps}", { steps: new Intl.ListFormat(t.locale, { type: "conjunction" }).format(from.map((x) => n(t, x))) })}
                    </span>
                  )}
                </div>
                <p dir="auto" className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">
                  {s.prompt}
                </p>
                {(free.length > 0 || rules.length > 0) && (
                  <div className="space-y-1.5 border-t border-white/8 pt-3">
                    <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">{t("Checks on its result")}</p>
                    <ul className="space-y-1">
                      {[...free, ...rules].map((c, j) => (
                        <li key={j} className="flex gap-2 text-sm text-zinc-300">
                          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" aria-hidden />
                          <span dir="auto" className="min-w-0 break-words">
                            {c}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {rules.length > 0 && <p className="text-xs text-zinc-500">{t("A Sonic check reads the result against the rules in plain words.")}</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ol>

        <section className="space-y-3 rounded-2xl border border-primary/25 bg-primary/[0.05] p-4">
          {priced && (
            <p className="text-sm font-medium tabular-nums text-zinc-100">
              {t("Each run: never more than {credits} credits, usually about {typical} (estimate)", { credits: n(t, priced.worst), typical: n(t, priced.typical) })}
            </p>
          )}
          <p className="text-sm text-zinc-300">
            {total > 0
              ? t("When it ends you get a receipt: what each step did and cost, and whether each of its {count} checks passed.", { count: n(t, total) })
              : t("When it ends you get a receipt: what each step did and cost.")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => worst !== null && void approve(p, worst)} disabled={worst === null || Boolean(busy)} className={primaryButton}>
              {worst === null ? t("Pricing…") : busy === "approve" ? t("Starting…") : t("Approve and run: at most {credits} credits", { credits: n(t, worst) })}
            </button>
            <button type="button" onClick={() => setStage({ kind: "goal" })} disabled={Boolean(busy)} className={quietButton}>
              {t("Change the goal")}
            </button>
          </div>
          <p className="text-xs text-zinc-500">{t("It's saved with your automations, so you can run it again later.")}</p>
          {errorLine}
        </section>
      </div>
    );
  }
}
