"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AccountSummary } from "@/lib/store";
import { MAX_ACCOUNTS } from "@/lib/accounts";
import { fullName } from "@/lib/names";
import { useT } from "@/lib/use-t";
import { isolate } from "@/lib/account-pin";
import { AccountBadge, accountTone } from "./AccountMenu";

/**
 * A dialog that must be answered: a sheet from the bottom on a phone, a card in the middle on a
 * computer. Tab stays inside it. It opens with the dialog itself focused, not its first button, so
 * no account looks already chosen. It sits above everything else on the page, an app in full
 * screen too (in a portal, one layer up), so what it asks is never hidden behind what it guards.
 */
function Sheet({ label, onEscape, children }: { label: string; onEscape?: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const focusable = () => [...el.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]")];
    el.focus();
    const keep = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onEscape) {
        e.preventDefault();
        onEscape();
        return;
      }
      if (e.key !== "Tab") return;
      const all = focusable();
      if (!all.length) return;
      const first = all[0];
      const last = all[all.length - 1];
      const outside = document.activeElement === el || !el.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keep);
    return () => document.removeEventListener("keydown", keep);
  }, [onEscape]);
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-4">
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="max-h-[calc(100dvh-2rem)] w-full overflow-y-auto overscroll-contain rounded-t-2xl outline-none border border-white/8 bg-zinc-950 px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-5 text-zinc-100 sm:max-w-sm sm:rounded-2xl sm:p-6"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Choose an account to keep going: shown when the account this tab showed was logged out on this
 * browser (in another tab, say), or when a link was for an account that isn't signed in here. The
 * tab never moves to another account on its own; the person picks one, or signs in to another.
 */
export function AccountChooser({
  title,
  accounts,
  switching,
  onChoose,
  onAdd,
}: {
  // What happened, in the person's language: the account that was logged out, or the link's.
  title: string;
  accounts: AccountSummary[];
  switching: string | null;
  onChoose: (id: string) => void;
  onAdd: () => void;
}) {
  const t = useT();
  const ask = t("Choose an account to keep going.");
  return (
    <Sheet label={title}>
      <h2 className="break-words text-lg font-medium tracking-tight text-balance">{title}</h2>
      {ask !== title && <p className="mt-1 text-sm text-zinc-400">{ask}</p>}
      <div className="mt-4 grid gap-1">
        {accounts.map((a) => {
          const going = switching === a.id;
          return (
            <button
              key={a.id}
              aria-label={t("Switch to {name} ({email})", { name: isolate(fullName(a)), email: isolate(a.email) })}
              aria-busy={going || undefined}
              disabled={Boolean(switching)}
              onClick={() => onChoose(a.id)}
              className={`flex min-h-12 w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-start transition hover:bg-white/[0.06] focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-default disabled:hover:bg-transparent ${
                switching && !going ? "opacity-50" : ""
              }`}
            >
              <AccountBadge account={a} tone={accountTone(accounts, a.id)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-zinc-100">{fullName(a)}</span>
                <bdi className="block truncate text-xs text-zinc-500 rtl:text-right" title={a.email}>
                  {going ? t("Switching…") : a.email}
                </bdi>
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-3 border-t border-white/8 pt-3">
        {accounts.length < MAX_ACCOUNTS ? (
          <button
            onClick={onAdd}
            disabled={Boolean(switching)}
            className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-start text-sm text-zinc-200 transition hover:bg-white/[0.06] disabled:opacity-50"
          >
            <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-dashed border-white/15 text-base text-zinc-400">
              +
            </span>
            {t("Use another account")}
          </button>
        ) : (
          // Nothing here logs out: the profile menu of the account chosen does.
          <p className="px-3 py-2 text-xs leading-relaxed text-zinc-500">
            {t("You're signed in to 5 accounts. To add another, choose one you no longer need and log out of it from the profile menu.")}
          </p>
        )}
      </div>
    </Sheet>
  );
}

/** Before switching away from changes that didn't save: switch anyway, or stay. */
export function SwitchAnyway({ onSwitch, onCancel }: { onSwitch: () => void; onCancel: () => void }) {
  const t = useT();
  const question = t("Some changes in this chat haven't saved yet. Switch anyway?");
  return (
    <Sheet label={question} onEscape={onCancel}>
      <p className="text-sm leading-relaxed text-zinc-200">{question}</p>
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button onClick={onCancel} className="h-11 rounded-lg border border-white/10 px-4 text-sm text-zinc-200 transition hover:bg-white/[0.05] sm:h-10">
          {t("Cancel")}
        </button>
        <button onClick={onSwitch} className="h-11 rounded-lg bg-brand px-4 text-sm font-medium text-on-brand transition hover:brightness-110 sm:h-10">
          {t("Switch anyway")}
        </button>
      </div>
    </Sheet>
  );
}
