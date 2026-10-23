"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/store";
import { useT } from "@/lib/use-t";
import { MIN_IDEA_CHARS } from "@/lib/prompt-helper";
import { STUDIO_ANSWER_CHARS, STUDIO_IDEAS, STUDIO_QUESTIONS, writeBrief, type StudioKind } from "@/lib/studio-guide";
import { ICONS, Icon } from "./Home";

const pill = (on: boolean) =>
  `rounded-full px-3 py-1.5 text-sm ring-1 ring-inset transition ${
    on ? "bg-primary/15 text-white ring-primary/60 light:text-violet-700" : "bg-white/[0.03] text-zinc-300 ring-white/10 hover:ring-white/25 light:bg-black/[0.02] light:ring-black/10"
  }`;

/**
 * Help for a story or ad brief, above the Studio's box (see studio-guide.ts): a few details to
 * tap, ready ideas, and Prompt Helper growing a short idea into a full brief, with Undo.
 */
export function StudioGuide({ kind, brief, onBrief, disabled }: { kind: StudioKind; brief: string; onBrief: (brief: string) => void; disabled: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // The brief goes in the Studio's box, which is brought into view to read and change.
  const write = (next: string) => {
    onBrief(next);
    requestAnimationFrame(() => rootRef.current?.parentElement?.querySelector("textarea")?.focus());
  };
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  // What Prompt Helper replaced, and what it cost, until the brief changes again.
  const [helped, setHelped] = useState<{ before: string; after: string; credits: number; free: boolean } | null>(null);
  const questions = STUDIO_QUESTIONS[kind];
  const answered = questions.some((q) => answers[q.key]?.trim());
  const helpedNow = helped && helped.after === brief ? helped : null;

  async function grow() {
    setError("");
    if (brief.trim().length < MIN_IDEA_CHARS) return setError(t("Type a few words of your idea first."));
    setWorking(true);
    try {
      const out = await api<{ prompt: string; credits: number; free?: boolean }>("/api/prompt-helper", { method: "POST", json: { idea: brief, tool: kind } });
      setHelped({ before: brief, after: out.prompt, credits: out.credits, free: Boolean(out.free) });
      onBrief(out.prompt);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Prompt Helper couldn't rewrite that. Try again in a moment."));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div ref={rootRef} className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className={pill(open)}>
          <span className="inline-flex items-center gap-1.5">
            <Icon d={ICONS.chat} className="h-4 w-4" />
            {t("Pick a few details")}
          </span>
        </button>
        <button
          type="button"
          onClick={() => void grow()}
          disabled={disabled || working}
          aria-busy={working}
          className={`${pill(false)} disabled:opacity-60 ${working ? "animate-pulse" : ""}`}
        >
          <span className="inline-flex items-center gap-1.5">
            <Icon d={ICONS.wand} className="h-4 w-4 text-violet-300 light:text-violet-600" />
            {kind === "story" ? t("Make it a great story") : t("Make it a great ad")}
          </span>
        </button>
      </div>
      {error && (
        <p role="status" className="text-xs text-red-400">
          {error}
        </p>
      )}
      {helpedNow && (
        <p className="flex items-start gap-2 rounded-xl bg-violet-400/10 px-3 py-2 text-xs text-violet-100 light:text-violet-700">
          <span className="min-w-0 flex-1">
            ✨{" "}
            {helpedNow.free
              ? t("Prompt Helper wrote this, as one of today's free messages. Change anything, then send.")
              : t("Prompt Helper wrote this ({cost}). Change anything, then send.", {
                  cost: helpedNow.credits === 1 ? t("1 credit") : t("{count} credits", { count: helpedNow.credits.toLocaleString(t.locale) }),
                })}
          </span>
          <button type="button" onClick={() => onBrief(helpedNow.before)} className="shrink-0 font-medium underline-offset-2 hover:underline">
            {t("Undo")}
          </button>
        </p>
      )}

      {open && (
        <div className="space-y-4 rounded-2xl bg-white/[0.03] p-4 ring-1 ring-inset ring-white/10 light:bg-black/[0.02] light:ring-black/10">
          {questions.map((q) => {
            const value = answers[q.key] ?? "";
            const typed = q.answers.includes(value) ? "" : value;
            const set = (next: string) => setAnswers((all) => ({ ...all, [q.key]: next }));
            return (
              <fieldset key={q.key}>
                <legend className="text-sm font-medium text-zinc-200">{t(q.ask)}</legend>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {q.answers.map((a) => (
                    <button key={a} type="button" onClick={() => set(value === a ? "" : a)} aria-pressed={value === a} className={pill(value === a)}>
                      {t(a)}
                    </button>
                  ))}
                  <input
                    value={typed}
                    maxLength={STUDIO_ANSWER_CHARS}
                    onChange={(e) => set(e.target.value)}
                    placeholder={t("Or type your own answer")}
                    aria-label={`${t(q.ask)} ${t("Or type your own answer")}`}
                    className="min-w-40 flex-1 rounded-full bg-transparent px-3 py-1.5 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 placeholder:text-zinc-500 focus:outline-none focus:ring-primary/60 light:ring-black/10"
                  />
                </div>
              </fieldset>
            );
          })}
          <button
            type="button"
            disabled={!answered}
            onClick={() => {
              write(writeBrief(kind, answers, t));
              setOpen(false);
            }}
            className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-on-brand transition hover:brightness-110 disabled:opacity-50"
          >
            {kind === "story" ? t("Write my story idea") : t("Write my ad idea")}
          </button>
        </div>
      )}

      {!brief.trim() && !open && (
        <div>
          <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">{t("Or start from an idea")}</span>
          <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
            {STUDIO_IDEAS[kind].map((idea) => (
              <button
                key={idea}
                type="button"
                onClick={() => write(t(idea))}
                className="rounded-xl bg-white/[0.03] px-3 py-2 text-start text-xs leading-snug text-zinc-300 ring-1 ring-inset ring-white/10 transition hover:ring-primary/50 light:bg-black/[0.02] light:ring-black/10"
              >
                <span className="line-clamp-3">{t(idea)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
