"use client";

import { useEffect, useRef, useState } from "react";
import type { Me } from "@/lib/store";
import { firstName, fullName, initials } from "@/lib/names";
import { greeting } from "@/lib/when";
import { useT } from "@/lib/use-t";
import { InstallApp } from "./InstallApp";

const item = "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-zinc-200 transition hover:bg-white/[0.06]";

/**
 * The account button at the top right (or the bottom of a sidebar, placement "up"), which opens
 * the account menu like Claude's: Settings, help, plan, invite, install, learn more and log out.
 */
export function AccountMenu({
  me,
  placement = "up",
  greet = false,
  onSettings,
  onHelp,
  onPlan,
  onInvite,
  onSignOut,
}: {
  me: Me;
  placement?: "up" | "down";
  // On Home the button greets them: "Good evening," over their first name.
  greet?: boolean;
  onSettings: () => void;
  onHelp: () => void;
  onPlan: () => void;
  onInvite: () => void;
  onSignOut: () => void;
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

  return (
    <div ref={box} className={down ? "relative shrink-0" : "relative mt-3 border-t border-white/6 pt-3"}>
      {open && (
        <div
          role="menu"
          aria-label={t("Account")}
          className={`absolute z-30 rounded-xl border border-white/10 bg-zinc-900 p-1.5 shadow-2xl light:shadow-black/10 ${
            down ? "right-0 top-full mt-2 w-64" : "bottom-full left-0 right-0 mb-2"
          }`}
        >
          <p className="truncate px-3 pb-1.5 pt-1 text-xs text-zinc-500" title={me.user.email}>
            {me.user.email}
          </p>
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
            <span aria-hidden>📖</span> {t("Learn more")} <span className="ml-auto text-zinc-500">{more ? "▾" : "▸"}</span>
          </button>
          {more && (
            <div className="ml-7 flex flex-col">
              <a role="menuitem" href="/connector" className={item}>
                {t("Use Flash in Claude or ChatGPT")}
              </a>
              <a role="menuitem" href="/terms" target="_blank" rel="noreferrer" className={item}>
                {t("Terms of Service")}
              </a>
              <a role="menuitem" href="/privacy" target="_blank" rel="noreferrer" className={item}>
                {t("Privacy Policy")}
              </a>
            </div>
          )}
          <div className="my-1 border-t border-white/8" />
          <button role="menuitem" className={item} onClick={pick(onSignOut)}>
            <span aria-hidden>↪</span> {t("Log out")}
          </button>
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={
          down
            ? "glass flex h-12 items-center gap-2.5 rounded-2xl p-1 shadow-none transition hover:brightness-110 @min-[900px]/main:pr-3"
            : "flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition hover:bg-white/[0.05]"
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
        <span className={`min-w-0 text-left ${down ? "hidden @min-[900px]/main:block" : "flex-1"}`}>
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
