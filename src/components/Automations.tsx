"use client";

import { useEffect, useRef } from "react";
import { useT } from "@/lib/use-t";
import { ICONS, Icon } from "./Home";

/**
 * Automations, from the sidebar. Flash can't run jobs on a schedule yet, so this says so plainly
 * and points to what does the same work in one go today.
 */
export function Automations({ onTemplates, onClose }: { onTemplates: () => void; onClose: () => void }) {
  const t = useT();
  return (
    <SoonDialog
      icon={ICONS.bolt}
      title={t("Automations")}
      text={[
        t(
          "Flash can't run jobs on a schedule yet. When Automations arrive, you'll set up a job once, like a weekly sales summary or a daily social post, and Flash will do it on time without being asked.",
        ),
        t("Until then, a template does the same work in one go whenever you need it."),
      ]}
      action={t("Browse templates")}
      onAction={onTemplates}
      onClose={onClose}
    />
  );
}

/** AI Agents, from the sidebar: not here yet, so it says so and points to project instructions, which shape answers today. */
export function AiAgents({ onChat, onClose }: { onChat: () => void; onClose: () => void }) {
  const t = useT();
  return (
    <SoonDialog
      icon={ICONS.sparkle}
      title={t("AI Agents")}
      text={[
        t("Your own AI agents are on the way: an assistant with its own instructions and files, ready in any chat."),
        t("Until then, open a chat and tap Instructions to tell Flash how to answer there."),
      ]}
      action={t("Start a chat")}
      onAction={onChat}
      onClose={onClose}
    />
  );
}

/** A feature that's coming: what it will do, and what does the job today. */
function SoonDialog({ icon, title, text, action, onAction, onClose }: { icon: string; title: string; text: string[]; action: string; onAction: () => void; onClose: () => void }) {
  const t = useT();
  const closeRef = useRef<HTMLButtonElement>(null);
  // Into the dialog once when it opens (not on every render, which would pull the cursor back).
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="soon-title"
        className="w-full max-w-md rounded-t-3xl border border-white/8 bg-zinc-950 p-6 text-zinc-100 sm:rounded-3xl sm:p-7"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-400/15 text-amber-300 ring-1 ring-inset ring-amber-300/25 light:bg-amber-50 light:text-amber-600 light:ring-amber-200">
            <Icon d={icon} className="h-6 w-6" />
          </span>
          <button ref={closeRef} onClick={onClose} className="rounded-full p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100" aria-label={t("Close")}>
            ✕
          </button>
        </div>
        <h2 id="soon-title" className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
          {title} <span className="rounded-full bg-white/[0.08] px-2.5 py-0.5 text-xs font-medium text-zinc-300">{t("Coming soon")}</span>
        </h2>
        {text.map((line, i) => (
          <p key={line} className={`${i ? "mt-3" : "mt-2"} text-sm leading-relaxed text-zinc-400`}>
            {line}
          </p>
        ))}
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-full px-4 py-2 text-sm text-zinc-400 transition hover:text-zinc-100">
            {t("Close")}
          </button>
          <button
            onClick={() => {
              onClose();
              onAction();
            }}
            className="rounded-full bg-brand px-5 py-2 text-sm font-medium text-on-brand transition hover:brightness-110"
          >
            {action}
          </button>
        </div>
      </div>
    </div>
  );
}
