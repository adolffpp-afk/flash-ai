"use client";

import { useEffect, useRef } from "react";
import { COMING_SOON } from "@/lib/coming-soon";
import { useT } from "@/lib/use-t";
import { ICONS, Tile, type Hue } from "./Home";

const HUES: Hue[] = ["violet", "blue", "teal", "pink", "orange"];

/** The list of what's coming, from the menu. Nothing on it works yet, so it says so and opens nothing. */
export function ComingSoonList({ onClose }: { onClose: () => void }) {
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
        aria-labelledby="coming-soon-title"
        className="flex max-h-[92dvh] w-full max-w-2xl flex-col rounded-t-3xl border border-white/8 bg-zinc-950 text-zinc-100 sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-6 pb-2 pt-6 sm:px-7">
          <div className="min-w-0">
            <h2 id="coming-soon-title" className="text-xl font-semibold tracking-tight">
              {t("Coming soon")}
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-zinc-400">{t("What Flash is building next. None of these work yet.")}</p>
          </div>
          <button ref={closeRef} onClick={onClose} className="rounded-full p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100" aria-label={t("Close")}>
            ✕
          </button>
        </div>
        <ul className="grid min-h-0 grid-cols-1 gap-3 overflow-y-auto px-6 pb-6 pt-3 sm:grid-cols-2 sm:px-7">
          {COMING_SOON.map((item, i) => (
            <li
              key={item.title}
              // An odd last card spans both columns, so it doesn't sit alone beside an empty space.
              className={`flex min-w-0 flex-col gap-3 rounded-2xl bg-white/[0.03] p-4 ring-1 ring-inset ring-white/10 light:bg-black/[0.02] light:ring-black/10 ${
                i === COMING_SOON.length - 1 && i % 2 === 0 ? "sm:col-span-2" : ""
              }`}
            >
              <div className="flex items-center gap-3">
                <Tile d={ICONS[item.icon]} hue={HUES[i % HUES.length]} size="sm" />
                <h3 className="min-w-0 flex-1 text-[15px] font-semibold leading-snug text-white">{t(item.title)}</h3>
                <span className="shrink-0 rounded-full bg-white/[0.07] px-2 py-0.5 text-[11px] font-medium text-zinc-400">{t("Coming soon")}</span>
              </div>
              <p className="text-[13.5px] leading-relaxed text-zinc-400">{t(item.about)}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
