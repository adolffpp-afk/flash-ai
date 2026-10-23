"use client";

import { useEffect, useRef, useState } from "react";
import type { Engine } from "@/lib/types";
import { useT } from "@/lib/use-t";
import { ANSWER_CHARS, AUDIENCES, GUIDE_GOALS, NOTE_CHARS, NO_ANSWERS, STYLES, stepsFor, writeRequest, type GuideAnswers, type GuideGoal, type GuideStep } from "@/lib/guide";
import { ICONS, Icon } from "./Home";
import type { Choice } from "./ComposerTools";

// Each goal's colour, as on Home's quick starts.
const HUES: Record<string, string> = {
  website: "text-sky-300 light:text-sky-600 bg-sky-400/10",
  app: "text-violet-300 light:text-violet-600 bg-violet-400/10",
  store: "text-rose-300 light:text-rose-600 bg-rose-400/10",
  picture: "text-amber-300 light:text-amber-600 bg-amber-400/10",
  slides: "text-teal-300 light:text-teal-600 bg-teal-400/10",
  document: "text-emerald-300 light:text-emerald-600 bg-emerald-400/10",
  advice: "text-fuchsia-300 light:text-fuchsia-600 bg-fuchsia-400/10",
};

const chip = (on: boolean) =>
  `inline-flex min-h-10 items-center gap-1.5 rounded-full border px-4 py-2 text-[15px] transition ${
    on ? "border-primary/70 bg-primary/15 text-white light:text-violet-700" : "border-white/10 bg-white/[0.03] text-zinc-200 hover:border-primary/50 hover:text-white"
  }`;
const field =
  "block w-full rounded-xl border border-white/10 bg-zinc-900 px-3.5 py-2.5 text-[15px] text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-primary/60";

/**
 * Help me ask (see guide.ts): what to make, then a few questions answered by tapping, then the
 * request Flash wrote from them, to change and put in the message box.
 */
export function GuideMe({ isLive, onUse, onClose }: { isLive: (e: Engine) => boolean; onUse: (choice: Choice, text: string) => void; onClose: () => void }) {
  const t = useT();
  const [goal, setGoal] = useState<GuideGoal | null>(null);
  const [answers, setAnswers] = useState<GuideAnswers>(NO_ANSWERS);
  // Where they are among the goal's questions; past the last one, the written request.
  const [at, setAt] = useState(0);
  const [request, setRequest] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const goals = GUIDE_GOALS.filter((g) => g.engine === "auto" || isLive(g.engine));
  const steps = goal ? stepsFor(goal) : [];
  const step: GuideStep | "done" | null = goal ? ((steps[at] as GuideStep | undefined) ?? "done") : null;
  // The goal counts as the first step, and the written request as the last; before a goal is
  // picked, as many as most goals ask.
  const count = (goal ? steps.length : 5) + 2;
  const number = goal ? at + 2 : 1;

  function go(next: number, now: GuideAnswers = answers) {
    if (goal && next >= steps.length) setRequest(writeRequest(goal, now, t));
    setAt(next);
  }
  function back() {
    if (at === 0) {
      setGoal(null);
      setAnswers(NO_ANSWERS);
    } else go(at - 1);
  }
  // A single answer: picking one moves on at once, and picking it again clears it.
  function pick(key: "subject" | "audience" | "style", value: string) {
    const now = { ...answers, [key]: answers[key] === value ? "" : value };
    setAnswers(now);
    if (now[key]) go(at + 1, now);
  }

  const title: Record<GuideStep, string> = {
    subject: goal ? t(goal.ask) : "",
    extras: t("What should it have? Pick as many as you like."),
    audience: t("Who is it for?"),
    style: t("What style do you like?"),
    note: t("Anything else Flash should know?"),
  };

  // The answers for a single-answer question, with a box to type their own.
  const single = (key: "subject" | "audience" | "style", list: string[]) => {
    const typed = list.includes(answers[key]) ? "" : answers[key];
    return (
      <>
        <div className="flex flex-wrap gap-2">
          {list.map((value) => (
            <button key={value} type="button" onClick={() => pick(key, value)} aria-pressed={answers[key] === value} className={chip(answers[key] === value)}>
              {t(value)}
            </button>
          ))}
        </div>
        <label className="mt-5 block text-sm text-zinc-400">
          {t("Or type your own answer")}
          <input
            className={`${field} mt-1.5`}
            value={typed}
            maxLength={ANSWER_CHARS}
            onChange={(e) => setAnswers({ ...answers, [key]: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && typed.trim() && go(at + 1)}
          />
        </label>
      </>
    );
  };

  return (
    <div className="fixed inset-0 z-40 flex items-stretch justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("Help me ask")}
        className="flex h-full w-full max-w-2xl flex-col bg-zinc-950 text-zinc-100 sm:h-auto sm:max-h-[85vh] sm:rounded-2xl sm:border sm:border-white/8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 pb-2 pt-4">
          {goal && (
            <button onClick={back} className="rounded-full p-1.5 text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100" aria-label={t("Back")}>
              <Icon d="M19 12H5 M11 6l-6 6 6 6" className="h-5 w-5 rtl:-scale-x-100" />
            </button>
          )}
          <h2 className="flex min-w-0 flex-1 items-center gap-2 truncate text-lg font-semibold tracking-tight">
            <Icon d={ICONS.wand} className="h-5 w-5 shrink-0 text-violet-300 light:text-violet-600" />
            {t("Help me ask")}
          </h2>
          <span className="shrink-0 text-xs text-zinc-500">{t("Step {step} of {count}", { step: String(number), count: String(count) })}</span>
          <button ref={closeRef} onClick={onClose} className="rounded-full p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100" aria-label={t("Close")}>
            ✕
          </button>
        </div>
        {/* How far along they are. */}
        <div className="mx-5 h-1 overflow-hidden rounded-full bg-white/[0.06]" aria-hidden>
          <div className="h-full rounded-full bg-brand transition-all duration-300" style={{ width: `${(number / count) * 100}%` }} />
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-5 pt-6">
          {!goal ? (
            <>
              <h3 className="text-[22px] font-semibold tracking-tight text-white">{t("What would you like to make?")}</h3>
              <p className="mt-1.5 text-[15px] text-zinc-400">{t("Answer a few easy questions and Flash writes the request for you. No AI words needed.")}</p>
              <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {goals.map((g) => (
                  <button
                    key={g.id}
                    onClick={() => {
                      setGoal(g);
                      setAnswers(NO_ANSWERS);
                      setAt(0);
                    }}
                    className="glass flex items-center gap-3 rounded-2xl p-3.5 text-start transition hover:brightness-110"
                  >
                    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${HUES[g.id]}`}>
                      <Icon d={ICONS[g.icon]} className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 text-[15px] font-medium text-zinc-100">{t(g.label)}</span>
                  </button>
                ))}
              </div>
            </>
          ) : step === "done" ? (
            <>
              <h3 className="text-[22px] font-semibold tracking-tight text-white">{t("Here's your request")}</h3>
              <p className="mt-1.5 text-[15px] text-zinc-400">{t("Change anything you like, then put it in the message box and send it.")}</p>
              <textarea dir="auto" className={`${field} mt-5 min-h-40 leading-relaxed`} value={request} maxLength={2000} onChange={(e) => setRequest(e.target.value)} aria-label={t("Here's your request")} />
              <p className="mt-3 flex items-start gap-2 text-sm text-zinc-400">
                <Icon d={ICONS.sparkle} className="mt-0.5 h-4 w-4 shrink-0 text-violet-300 light:text-violet-600" />
                {t("Want it even stronger? Tap Prompt Helper in the message box.")}
              </p>
            </>
          ) : (
            <>
              <h3 className="text-[22px] font-semibold tracking-tight text-white">{step && title[step]}</h3>
              <div className="mt-5">
                {step === "subject" && single("subject", goal.subjects)}
                {step === "audience" && single("audience", AUDIENCES)}
                {step === "style" && single("style", STYLES)}
                {step === "extras" && (
                  <div className="flex flex-wrap gap-2">
                    {goal.extras.map((value) => {
                      const on = answers.extras.includes(value);
                      return (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={on}
                          onClick={() => setAnswers({ ...answers, extras: on ? answers.extras.filter((e) => e !== value) : [...answers.extras, value] })}
                          className={chip(on)}
                        >
                          {on && <Icon d="M5 12.5l4.5 4.5L19 7.5" className="h-4 w-4" strokeWidth={2.2} />}
                          {t(value)}
                        </button>
                      );
                    })}
                  </div>
                )}
                {step === "note" && (
                  <textarea
                    dir="auto"
                    autoFocus
                    className={`${field} min-h-28`}
                    value={answers.note}
                    maxLength={NOTE_CHARS}
                    placeholder={t("Its name, your city, colours, prices… Leave it empty if you like.")}
                    onChange={(e) => setAnswers({ ...answers, note: e.target.value })}
                    aria-label={t("Anything else Flash should know?")}
                  />
                )}
              </div>
            </>
          )}
        </div>

        {goal && (
          <div className="flex items-center justify-end gap-2 border-t border-white/6 px-5 py-3">
            {step === "done" ? (
              <button
                onClick={() => request.trim() && onUse(goal.engine, request.trim())}
                disabled={!request.trim()}
                className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-on-brand transition hover:brightness-110 disabled:opacity-60"
              >
                {t("Put it in the message box")}
              </button>
            ) : (
              <>
                {step !== "subject" && (
                  <button onClick={() => go(at + 1)} className="rounded-full px-4 py-2.5 text-sm text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100">
                    {t("Skip")}
                  </button>
                )}
                <button
                  onClick={() => go(at + 1)}
                  disabled={step === "subject" && !answers.subject.trim()}
                  className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-on-brand transition hover:brightness-110 disabled:opacity-50"
                >
                  {t("Continue")}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
