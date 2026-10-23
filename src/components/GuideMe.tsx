"use client";

import { useEffect, useRef, useState } from "react";
import type { Engine } from "@/lib/types";
import { useT } from "@/lib/use-t";
import { ANSWER_CHARS, AUDIENCES, GUIDE_GOALS, NO_ANSWERS, STYLES, writeRequest, type GuideAnswers, type GuideGoal } from "@/lib/guide";
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

const small = (on: boolean) =>
  `inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-sm transition ${
    on ? "border-primary/70 bg-primary/15 text-white light:text-violet-700" : "border-white/10 bg-white/[0.03] text-zinc-300 hover:border-primary/50 hover:text-white"
  }`;
const chip = (on: boolean) =>
  `inline-flex min-h-10 items-center gap-1.5 rounded-full border px-4 py-2 text-[15px] transition ${
    on ? "border-primary/70 bg-primary/15 text-white light:text-violet-700" : "border-white/10 bg-white/[0.03] text-zinc-200 hover:border-primary/50 hover:text-white"
  }`;
const field =
  "block w-full rounded-xl border border-white/10 bg-zinc-900 px-3.5 py-2.5 text-[15px] text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-primary/60";

/**
 * Help me ask (see guide.ts): what to make, what it's about, then the request Flash wrote with the
 * rest guessed, to change by tapping or typing and put in the message box. Two taps, no quiz.
 */
export function GuideMe({ isLive, onUse, onClose }: { isLive: (e: Engine) => boolean; onUse: (choice: Choice, text: string) => void; onClose: () => void }) {
  const t = useT();
  const [goal, setGoal] = useState<GuideGoal | null>(null);
  const [answers, setAnswers] = useState<GuideAnswers>(NO_ANSWERS);
  const [written, setWritten] = useState(false);
  const [request, setRequest] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const goals = GUIDE_GOALS.filter((g) => g.engine === "auto" || isLive(g.engine));
  const number = !goal ? 1 : written ? 3 : 2;

  // Writes the request again from the taps, keeping anything they typed after it.
  function rewrite(now: GuideAnswers) {
    if (!goal) return;
    const before = writeRequest(goal, answers, t);
    const added = request.startsWith(before) ? request.slice(before.length) : "";
    setAnswers(now);
    setRequest(writeRequest(goal, now, t) + added);
  }
  function write(subject: string) {
    if (!goal || !subject.trim()) return;
    const now = { ...NO_ANSWERS, subject };
    setAnswers(now);
    setRequest(writeRequest(goal, now, t));
    setWritten(true);
  }
  function back() {
    if (written) setWritten(false);
    else {
      setGoal(null);
      setAnswers(NO_ANSWERS);
    }
  }

  // A row of optional answers on the written request: one to pick, tapped again to clear.
  const row = (label: string, key: "audience" | "style", list: string[]) => (
    <div>
      <span className="text-xs font-medium text-zinc-400">{label}</span>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {list.map((value) => {
          const on = answers[key] === value;
          return (
            <button key={value} type="button" aria-pressed={on} onClick={() => rewrite({ ...answers, [key]: on ? "" : value })} className={small(on)}>
              {t(value)}
            </button>
          );
        })}
      </div>
    </div>
  );
  const typed = goal && !goal.subjects.includes(answers.subject) ? answers.subject : "";

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
          <span className="shrink-0 text-xs text-zinc-500">{t("Step {step} of {count}", { step: String(number), count: "3" })}</span>
          <button ref={closeRef} onClick={onClose} className="rounded-full p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100" aria-label={t("Close")}>
            ✕
          </button>
        </div>
        {/* How far along they are. */}
        <div className="mx-5 h-1 overflow-hidden rounded-full bg-white/[0.06]" aria-hidden>
          <div className="h-full rounded-full bg-brand transition-all duration-300" style={{ width: `${(number / 3) * 100}%` }} />
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-5 pt-6">
          {!goal ? (
            <>
              <h3 className="text-[22px] font-semibold tracking-tight text-white">{t("What would you like to make?")}</h3>
              <p className="mt-1.5 text-[15px] text-zinc-400">{t("Two taps and Flash writes the request for you. No AI words needed.")}</p>
              <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {goals.map((g) => (
                  <button
                    key={g.id}
                    onClick={() => {
                      setGoal(g);
                      setAnswers(NO_ANSWERS);
                      setWritten(false);
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
          ) : written ? (
            <>
              <h3 className="text-[22px] font-semibold tracking-tight text-white">{t("Here's your request")}</h3>
              <p className="mt-1.5 text-[15px] text-zinc-400">{t("Flash filled in the rest. Tap below to change it, or edit the text.")}</p>
              <textarea dir="auto" className={`${field} mt-5 min-h-32 leading-relaxed`} value={request} maxLength={2000} onChange={(e) => setRequest(e.target.value)} aria-label={t("Here's your request")} />
              <div className="mt-4 space-y-3">
                <div>
                  <span className="text-xs font-medium text-zinc-400">{t("What should it have? Pick as many as you like.")}</span>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {goal.extras.map((value) => {
                      const on = answers.extras.includes(value);
                      return (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={on}
                          onClick={() => rewrite({ ...answers, extras: on ? answers.extras.filter((e) => e !== value) : [...answers.extras, value] })}
                          className={small(on)}
                        >
                          {on && <Icon d="M5 12.5l4.5 4.5L19 7.5" className="h-3.5 w-3.5" strokeWidth={2.2} />}
                          {t(value)}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {goal.audience && row(t("Who is it for?"), "audience", AUDIENCES)}
                {goal.style && row(t("What style do you like?"), "style", STYLES)}
              </div>
              <p className="mt-4 flex items-start gap-2 text-sm text-zinc-400">
                <Icon d={ICONS.sparkle} className="mt-0.5 h-4 w-4 shrink-0 text-violet-300 light:text-violet-600" />
                {t("Want it even stronger? Tap Help me ask under the message box.")}
              </p>
            </>
          ) : (
            <>
              <h3 className="text-[22px] font-semibold tracking-tight text-white">{t(goal.ask)}</h3>
              <div className="mt-5 flex flex-wrap gap-2">
                {goal.subjects.map((value) => (
                  <button key={value} type="button" onClick={() => write(value)} className={chip(answers.subject === value)}>
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
                  onChange={(e) => setAnswers({ ...answers, subject: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && write(typed)}
                />
              </label>
            </>
          )}
        </div>

        {goal && (
          <div className="flex items-center justify-end gap-2 border-t border-white/6 px-5 py-3">
            {written ? (
              <button
                onClick={() => request.trim() && onUse(goal.engine, request.trim())}
                disabled={!request.trim()}
                className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-on-brand transition hover:brightness-110 disabled:opacity-60"
              >
                {t("Put it in the message box")}
              </button>
            ) : (
              <button
                onClick={() => write(typed)}
                disabled={!typed.trim()}
                className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-on-brand transition hover:brightness-110 disabled:opacity-50"
              >
                {t("Write my request")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
