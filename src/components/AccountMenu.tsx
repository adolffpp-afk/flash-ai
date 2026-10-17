"use client";

import { useEffect, useRef, useState } from "react";
import type { AccountSummary, Me } from "@/lib/store";
import { MAX_ACCOUNTS } from "@/lib/accounts";
import { firstName, fullName, initials } from "@/lib/names";
import { greeting } from "@/lib/when";
import { useT } from "@/lib/use-t";
import { isolate } from "@/lib/account-pin";
import { accountTones } from "@/lib/account-tones";
import { InstallApp } from "./InstallApp";

const item = "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-start text-sm text-zinc-200 transition hover:bg-white/[0.06]";

/*
 * Each account signed in to a browser has its own badge colour, kept for as long as it stays
 * signed in here (see account-tones.ts; on a browser that never held two, the one keeps Flash's
 * own), so tabs on two accounts tell apart at a glance, even with the same name and on a phone,
 * where the top bar shows only the badge. A browser holds at most 5 accounts.
 */
const TONES = [
  "bg-[linear-gradient(140deg,#3ee0c3,#7c6cf0_70%,#c084fc)]",
  "bg-[linear-gradient(140deg,#fde68a,#fb923c_70%,#f472b6)]",
  "bg-[linear-gradient(140deg,#d9f99d,#4ade80_70%,#2dd4bf)]",
  "bg-[linear-gradient(140deg,#fecdd3,#fb7185_70%,#e879f9)]",
  "bg-[linear-gradient(140deg,#a5f3fc,#60a5fa_70%,#818cf8)]",
] as const;

/** An account's colour among the browser's accounts, kept when the others log out (see accountTones). */
export function accountTone(accounts: { id: string }[] | undefined, id: string): string {
  const at = accounts?.length ? accountTones(accounts.map((a) => a.id), TONES.length).get(id) : 0;
  return TONES[at ?? 0];
}

/**
 * An account's round badge with its initials: in its colour (tone, see accountTone), or else the
 * gradient one for the account shown and a quiet one for the others.
 */
export function AccountBadge({ account, current = false, size = "md", tone }: { account: AccountSummary; current?: boolean; size?: "md" | "sm"; tone?: string }) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full font-medium ${size === "md" ? "h-9 w-9 text-sm" : "h-8 w-8 text-xs"} ${
        tone ? `${tone} text-night` : current ? `${TONES[0]} text-night` : "bg-primary-deep text-primary-soft"
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
  // Resolves false when the tab stays on its account (it asks first, or says why it couldn't switch).
  onSwitch: (id: string) => Promise<boolean>;
  onAdd: () => void;
  // Each resolves true once the tab leaves the account (it reloads, or is signed out), false when it stays.
  onSignOut: () => Promise<boolean>;
  onSignOutAll: () => Promise<boolean>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  // A log out under way, which first saves what it can (up to 3 seconds): the menu stays open and says so.
  const [out, setOut] = useState<"one" | "all" | null>(null);
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

  const close = () => {
    setOpen(false);
    setMore(false);
  };
  // Runs a menu item and closes the menu.
  const pick = (fn: () => void) => () => {
    close();
    fn();
  };
  // Logs out, once, with "Logging out…" on the item until the page changes; when the tab stays on
  // its account instead, the menu closes, so what Flash says next is in view.
  const logOut = (which: "one" | "all", fn: () => Promise<boolean>) => () => {
    if (out) return;
    setOut(which);
    const stay = () => {
      setOut(null);
      close();
    };
    // Still here a few seconds after leaving: the browser's "Leave site?" kept the page.
    void fn().then((left) => (left ? window.setTimeout(() => setOut(null), 3000) : stay()), stay);
  };
  const outItem = (which: "one" | "all") => ({
    "aria-busy": out === which || undefined,
    disabled: Boolean(out) && out !== which,
    className: `${item} disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent`,
    onClick: logOut(which, which === "one" ? onSignOut : onSignOutAll),
  });
  const plan = me.plan ? t("{plan} plan", { plan: me.plan.name }) : t("Free plan");
  // firstName gives "there" when there's no name to use.
  const called = firstName(me.user);
  const down = placement === "down";
  const shown: AccountSummary = { id: me.user.id, email: me.user.email, name: me.user.name, nickname: me.user.nickname ?? "" };
  const others = (me.accounts ?? []).filter((a) => a.id !== me.user.id);
  const several = others.length > 0;
  const full = others.length + 1 >= MAX_ACCOUNTS;
  const tone = accountTone(me.accounts, me.user.id);
  // The account this tab shows, at the top of the menu.
  const current = (
    <>
      <AccountBadge account={shown} current tone={tone} />
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
    </>
  );

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
          {several ? (
            // The account shown is the checked one of the accounts to switch to; choosing it stays on it.
            <div role="group" aria-label={t("Switch account")}>
              <button role="menuitemradio" aria-checked="true" className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-1.5 text-start" onClick={pick(() => {})}>
                {current}
              </button>
              <div className="mt-1 border-t border-white/8 pt-1">
                <p aria-hidden className="px-3 pb-1 pt-1.5 text-xs text-zinc-500">
                  {t("Switch account")}
                </p>
                {others.map((a) => {
                  const going = switching === a.id;
                  return (
                    <button
                      key={a.id}
                      role="menuitemradio"
                      aria-checked="false"
                      // The name and email shown, after what choosing it does.
                      aria-label={t("Switch to {name} ({email})", { name: isolate(fullName(a)), email: isolate(a.email) })}
                      aria-busy={going || undefined}
                      disabled={Boolean(switching || out)}
                      className={`${item} min-h-11 py-1.5 disabled:cursor-default disabled:hover:bg-transparent ${(switching && !going) || out ? "opacity-50" : ""}`}
                      // The menu stays open, saying "Switching…", while the tab reloads as that account. When
                      // it stays instead, the menu closes, so what Flash says (or asks) next is in view.
                      onClick={() => {
                        if (switching) return;
                        void onSwitch(a.id).then((reloading) => reloading || close());
                      }}
                    >
                      <AccountBadge account={a} size="sm" tone={accountTone(me.accounts, a.id)} />
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
            </div>
          ) : (
            <div aria-current="true" className="flex min-h-11 items-center gap-3 px-3 py-1.5">
              {current}
            </div>
          )}
          {full ? (
            <p className="px-3 py-2 text-xs leading-relaxed text-zinc-500">{t("You're signed in to 5 accounts. Log out of one to add another.")}</p>
          ) : (
            <button role="menuitem" className={`${item} min-h-11 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent`} disabled={Boolean(switching || out)} onClick={pick(onAdd)}>
              <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-white/15 text-base text-zinc-400">
                +
              </span>
              {t("Add another account")}
            </button>
          )}
          {/* With several accounts, the log-outs come right after them (on a small phone the menu scrolls, and Learn more below can hide what's under it). */}
          {several && (
            <>
              <button role="menuitem" {...outItem("one")}>
                <span aria-hidden className="rtl:-scale-x-100">↪</span> {out === "one" ? t("Logging out…") : t("Log out of this account")}
              </button>
              <button role="menuitem" {...outItem("all")}>
                <span aria-hidden className="rtl:-scale-x-100">⇤</span> {out === "all" ? t("Logging out…") : t("Log out of all accounts")}
              </button>
            </>
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
          {!several && (
            <>
              <div className="my-1 border-t border-white/8" />
              <button role="menuitem" {...outItem("one")}>
                <span aria-hidden className="rtl:-scale-x-100">↪</span> {out === "one" ? t("Logging out…") : t("Log out")}
              </button>
            </>
          )}
        </div>
      )}
      <button
        data-account-menu
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
            down ? `h-10 w-10 ${tone} text-sm text-night` : several ? `h-8 w-8 ${tone} text-xs text-night` : "h-8 w-8 bg-primary-deep text-xs text-primary-soft"
          }`}
        >
          {initials(me.user)}
        </span>
        {/* In the top bar the name shows when there's room beside the search (see Flash.tsx's main container). */}
        <span className={`min-w-0 text-start ${down ? "hidden @min-[900px]/main:block" : "flex-1"}`}>
          {several ? (
            // Several accounts here: which one this tab is on, under the name (the same name can be on two).
            <>
              <span className="block max-w-[12rem] truncate text-[15px] font-semibold leading-tight text-zinc-100">{greet && called !== "there" ? called : fullName(me.user)}</span>
              <bdi aria-hidden className="block max-w-[12rem] truncate text-xs text-zinc-400 rtl:text-right">
                {me.user.email}
              </bdi>
            </>
          ) : greet ? (
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
        {/* Its name is what it shows, then whose account it is, which on a phone shows only as initials. */}
        <span className="sr-only">{t("Account and settings for {email}", { email: isolate(me.user.email) })}</span>
        <span className={`text-zinc-500 ${down ? "hidden @min-[900px]/main:block" : ""}`} aria-hidden>
          {down ? "⌄" : "⌃"}
        </span>
      </button>
    </div>
  );
}
