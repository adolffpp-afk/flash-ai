"use client";

import { useEffect, useRef, useState } from "react";
import type { AccountSummary, Me } from "@/lib/store";
import { MAX_ACCOUNTS } from "@/lib/accounts";
import { firstName, fullName, initials } from "@/lib/names";
import { greeting } from "@/lib/when";
import { useT } from "@/lib/use-t";
import { isolate } from "@/lib/account-pin";
import { InstallApp } from "./InstallApp";

const item = "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-start text-sm text-zinc-200 transition hover:bg-white/[0.06]";

/** An account's round badge with its initials: the gradient one for the account shown, a quiet one for the others. */
export function AccountBadge({ account, current = false, size = "md" }: { account: AccountSummary; current?: boolean; size?: "md" | "sm" }) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full font-medium ${size === "md" ? "h-9 w-9 text-sm" : "h-8 w-8 text-xs"} ${
        current ? "bg-[linear-gradient(140deg,#3ee0c3,#7c6cf0_70%,#c084fc)] text-night" : "bg-primary-deep text-primary-soft"
      }`}
    >
      {initials(account)}
    </span>
  );
}

/**
 * The account button at the top right (or the bottom of a sidebar, placement "up"), which opens
 * the account menu like Claude's and Google's: the account this tab shows, the others signed in to
 * this browser to switch to, adding another, then Settings, help, plan, invite, install, learn more
 * and log out (of this account, or of all of them).
 */
export function AccountMenu({
  me,
  placement = "up",
  greet = false,
  switching = null,
  onSettings,
  onHelp,
  onPlan,
  onInvite,
  onSwitch,
  onAdd,
  onSignOut,
  onSignOutAll,
}: {
  me: Me;
  placement?: "up" | "down";
  // On Home the button greets them: "Good evening," over their first name.
  greet?: boolean;
  // The account a switch is under way to, if any.
  switching?: string | null;
  onSettings: () => void;
  onHelp: () => void;
  onPlan: () => void;
  onInvite: () => void;
  onSwitch: (id: string) => void;
  onAdd: () => void;
  onSignOut: () => void;
  onSignOutAll: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) {
        setOpen(false);
        setMore(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  // Runs a menu item and closes the menu.
  const pick = (fn: () => void) => () => {
    setOpen(false);
    setMore(false);
    fn();
  };
  const plan = me.plan ? t("{plan} plan", { plan: me.plan.name }) : t("Free plan");
  // firstName gives "there" when there's no name to use.
  const called = firstName(me.user);
  const down = placement === "down";
  const shown: AccountSummary = { id: me.user.id, email: me.user.email, name: me.user.name, nickname: me.user.nickname ?? "" };
  const others = (me.accounts ?? []).filter((a) => a.id !== me.user.id);
  const several = others.length > 0;
  const full = others.length + 1 >= MAX_ACCOUNTS;

  return (
    <div ref={box} className={down ? "relative shrink-0" : "relative mt-3 border-t border-white/6 pt-3"}>
      {open && (
        <div
          role="menu"
          aria-label={t("Account")}
          className={`absolute z-30 overflow-y-auto overscroll-contain rounded-xl border border-white/10 bg-zinc-900 p-1.5 shadow-2xl light:shadow-black/10 ${
            down ? "end-0 top-full mt-2 max-h-[calc(100dvh-5rem)] w-[min(18rem,calc(100vw-2rem))]" : "bottom-full start-0 end-0 mb-2 max-h-[calc(100dvh-6rem)]"
          }`}
        >
          <div aria-current="true" className="flex min-h-11 items-center gap-3 px-3 py-1.5">
            <AccountBadge account={shown} current />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-zinc-100">{fullName(me.user)}</span>
              <bdi className="block truncate text-xs text-zinc-500 rtl:text-right" title={me.user.email}>
                {me.user.email}
              </bdi>
            </span>
            {several && (
              <span aria-hidden className="text-primary">
                ✓
              </span>
            )}
          </div>
          {several && (
            <div role="group" aria-label={t("Switch account")} className="mt-1 border-t border-white/8 pt-1">
              <p className="px-3 pb-1 pt-1.5 text-xs text-zinc-500">{t("Switch account")}</p>
              {others.map((a) => {
                const going = switching === a.id;
                return (
                  <button
                    key={a.id}
                    role="menuitemradio"
                    aria-checked="false"
                    aria-label={t("Switch to {email}", { email: isolate(a.email) })}
                    aria-busy={going || undefined}
                    disabled={Boolean(switching)}
                    className={`${item} min-h-11 py-1.5 disabled:cursor-default disabled:hover:bg-transparent ${switching && !going ? "opacity-50" : ""}`}
                    onClick={() => {
                      if (switching) return;
                      onSwitch(a.id);
                    }}
                  >
                    <AccountBadge account={a} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-zinc-200">{fullName(a)}</span>
                      <bdi className="block truncate text-xs text-zinc-500 rtl:text-right" title={a.email}>
                        {going ? t("Switching…") : a.email}
                      </bdi>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {full ? (
            <p className="px-3 py-2 text-xs leading-relaxed text-zinc-500">{t("You're signed in to 5 accounts. Log out of one to add another.")}</p>
          ) : (
            <button role="menuitem" className={`${item} min-h-11`} disabled={Boolean(switching)} onClick={pick(onAdd)}>
              <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-white/15 text-base text-zinc-400">
                +
              </span>
              {t("Add another account")}
            </button>
          )}
          <div className="my-1 border-t border-white/8" />
          <button role="menuitem" className={item} onClick={pick(onSettings)}>
            <span aria-hidden>⚙️</span> {t("Settings")}
          </button>
          <button role="menuitem" className={item} onClick={pick(onHelp)}>
            <span aria-hidden>💬</span> {t("Get help")}
          </button>
          <div className="my-1 border-t border-white/8" />
          <button role="menuitem" className={item} onClick={pick(onPlan)}>
            <span aria-hidden>⚡</span> {me.plan ? t("Manage plan & credits") : t("Upgrade plan")}
          </button>
          <button role="menuitem" className={item} onClick={pick(onInvite)}>
            <span aria-hidden>🎁</span> {t("Invite friends, earn credits")}
          </button>
          <InstallApp className={`${item} [&>svg]:h-4 [&>svg]:w-4`} />
          {me.isAdmin && (
            <a role="menuitem" href="/admin" className={item}>
              <span aria-hidden>📈</span> {t("Owner dashboard")}
            </a>
          )}
          <button role="menuitem" aria-expanded={more} className={item} onClick={() => setMore((m) => !m)}>
            <span aria-hidden>📖</span> {t("Learn more")} <span className="ms-auto text-zinc-500 rtl:-scale-x-100">{more ? "▾" : "▸"}</span>
          </button>
          {more && (
            <div className="ms-7 flex flex-col">
              <a role="menuitem" href="/connector" className={item}>
                {t("Use Flash in Claude or ChatGPT")}
              </a>
              <a role="menuitem" href="/terms" target="_blank" rel="noreferrer" className={item}>
                {t("Terms of Service")}
              </a>
              <a role="menuitem" href="/privacy" target="_blank" rel="noreferrer" className={item}>
                {t("Privacy Policy")}
              </a>
              <a role="menuitem" href="/report" target="_blank" rel="noreferrer" className={item}>
                {t("Report content")}
              </a>
            </div>
          )}
          <div className="my-1 border-t border-white/8" />
          <button role="menuitem" className={item} onClick={pick(onSignOut)}>
            <span aria-hidden className="rtl:-scale-x-100">↪</span> {several ? t("Log out of this account") : t("Log out")}
          </button>
          {several && (
            <button role="menuitem" className={item} onClick={pick(onSignOutAll)}>
              <span aria-hidden className="rtl:-scale-x-100">⇤</span> {t("Log out of all accounts")}
            </button>
          )}
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={
          down
            ? "glass flex h-12 items-center gap-2.5 rounded-2xl p-1 shadow-none transition hover:brightness-110 @min-[900px]/main:pr-3"
            : "flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-start transition hover:bg-white/[0.05]"
        }
        title={t("Account and settings")}
      >
        <span
          className={`flex shrink-0 items-center justify-center rounded-full font-medium ${
            down ? "h-10 w-10 bg-[linear-gradient(140deg,#3ee0c3,#7c6cf0_70%,#c084fc)] text-sm text-night" : "h-8 w-8 bg-primary-deep text-xs text-primary-soft"
          }`}
        >
          {initials(me.user)}
        </span>
        {/* In the top bar the name shows when there's room beside the search (see Flash.tsx's main container). */}
        <span className={`min-w-0 text-start ${down ? "hidden @min-[900px]/main:block" : "flex-1"}`}>
          {greet ? (
            <>
              {called === "there" ? (
                // No name to use: the greeting on its own reads naturally in every language.
                <span className="block max-w-[10rem] truncate text-[15px] font-semibold leading-tight text-zinc-100">{t(greeting(new Date()))}</span>
              ) : (
                <>
                  <span className="block truncate text-xs text-zinc-400">{t(greeting(new Date()))},</span>
                  <span className="block max-w-[10rem] truncate text-[15px] font-semibold leading-tight text-zinc-100">{called}</span>
                </>
              )}
            </>
          ) : (
            <>
              <span className="block max-w-[10rem] truncate text-sm font-medium text-zinc-100">{fullName(me.user)}</span>
              <span className="block truncate text-xs text-zinc-500">{plan}</span>
            </>
          )}
        </span>
        <span className={`text-zinc-500 ${down ? "hidden @min-[900px]/main:block" : ""}`} aria-hidden>
          {down ? "⌄" : "⌃"}
        </span>
      </button>
    </div>
  );
}
