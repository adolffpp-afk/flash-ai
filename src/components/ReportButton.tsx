"use client";

import { useEffect, useRef, useState } from "react";
import { ReportForm } from "@/components/ReportForm";
import { textDirection, useBrowserT } from "@/lib/use-t";

/** A small flag, for Report links. */
export function FlagIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4.5 17.5v-14M4.5 3.5h9l-2 3.5 2 3.5h-9" />
    </svg>
  );
}

/**
 * "Report this chat" at the foot of a shared chat, which opens the Report form for it. The shared
 * page is in English; the form follows the browser's language, so it sets its own lang and dir.
 */
export function ReportButton({ address }: { address: string }) {
  const t = useBrowserT();
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dir = textDirection(t.language);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        lang={t.language}
        dir={dir}
        className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs text-zinc-500 transition hover:text-zinc-200"
      >
        <FlagIcon />
        {t("Report this chat")}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-4"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("Report this chat")}
            lang={t.language}
            dir={dir}
            className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-white/8 bg-zinc-950 p-5 text-start text-zinc-100 shadow-2xl sm:rounded-2xl sm:p-7"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-start justify-between gap-3">
              <h2 className="text-lg font-medium tracking-tight">{t("Report this chat")}</h2>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setOpen(false)}
                className="-me-2 -mt-1 rounded-full p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100"
                aria-label={t("Close")}
              >
                ✕
              </button>
            </div>
            <p className="mb-5 text-sm text-zinc-400">
              {t("Tell the Flash team what's wrong with this chat.")} {t("Reports go only to the Flash team, never to the person who made it.")}
            </p>
            <ReportForm
              t={t}
              address={address}
              onCancel={() => setOpen(false)}
              after={
                <div className="mt-5 flex justify-end">
                  <button type="button" onClick={() => setOpen(false)} className="h-10 rounded-full bg-brand px-5 text-sm font-medium text-on-brand hover:brightness-110">
                    {t("Close")}
                  </button>
                </div>
              }
            />
            <p className="mt-5 border-t border-white/6 pt-4 text-xs text-zinc-500">
              <a href="/report" className="text-primary-soft underline-offset-2 hover:underline">
                {t("Report an app or another page")}
              </a>
            </p>
          </div>
        </div>
      )}
    </>
  );
}
