"use client";

import { useEffect, useRef, useState } from "react";
import type { Me } from "@/lib/store";
import { fullName, initials } from "@/lib/names";
import { InstallApp } from "./InstallApp";

const item = "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-zinc-200 transition hover:bg-white/[0.06]";

/**
 * The name at the bottom of the sidebar, which opens the account menu like Claude's:
 * Settings, help, plan, invite, install, learn more and log out.
 */
export function AccountMenu({
  me,
  onSettings,
  onHelp,
  onPlan,
  onInvite,
  onSignOut,
}: {
  me: Me;
  onSettings: () => void;
  onHelp: () => void;
  onPlan: () => void;
  onInvite: () => void;
  onSignOut: () => void;
}) {
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
  const plan = me.plan ? `${me.plan.name} plan` : "Free plan";

  return (
    <div ref={box} className="relative mt-3 border-t border-white/6 pt-3">
      {open && (
        <div role="menu" aria-label="Account" className="absolute bottom-full left-0 right-0 z-30 mb-2 rounded-xl border border-white/10 bg-zinc-900 p-1.5 shadow-2xl">
          <p className="truncate px-3 pb-1.5 pt-1 text-xs text-zinc-500" title={me.user.email}>
            {me.user.email}
          </p>
          <button role="menuitem" className={item} onClick={pick(onSettings)}>
            <span aria-hidden>⚙️</span> Settings
          </button>
          <button role="menuitem" className={item} onClick={pick(onHelp)}>
            <span aria-hidden>💬</span> Get help
          </button>
          <div className="my-1 border-t border-white/8" />
          <button role="menuitem" className={item} onClick={pick(onPlan)}>
            <span aria-hidden>⚡</span> {me.plan ? "Manage plan & credits" : "Upgrade plan"}
          </button>
          <button role="menuitem" className={item} onClick={pick(onInvite)}>
            <span aria-hidden>🎁</span> Invite friends, earn credits
          </button>
          <InstallApp className={`${item} [&>svg]:h-4 [&>svg]:w-4`} />
          {me.isAdmin && (
            <a role="menuitem" href="/admin" className={item}>
              <span aria-hidden>📈</span> Owner dashboard
            </a>
          )}
          <button role="menuitem" aria-expanded={more} className={item} onClick={() => setMore((m) => !m)}>
            <span aria-hidden>📖</span> Learn more <span className="ml-auto text-zinc-500">{more ? "▾" : "▸"}</span>
          </button>
          {more && (
            <div className="ml-7 flex flex-col">
              <a role="menuitem" href="/connector" className={item}>
                Use Flash in Claude or ChatGPT
              </a>
              <a role="menuitem" href="/terms" target="_blank" rel="noreferrer" className={item}>
                Terms of Service
              </a>
              <a role="menuitem" href="/privacy" target="_blank" rel="noreferrer" className={item}>
                Privacy Policy
              </a>
            </div>
          )}
          <div className="my-1 border-t border-white/8" />
          <button role="menuitem" className={item} onClick={pick(onSignOut)}>
            <span aria-hidden>↪</span> Log out
          </button>
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition hover:bg-white/[0.05]"
        title="Account and settings"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-deep text-xs font-medium text-primary-soft">
          {initials(me.user)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-zinc-200">{fullName(me.user)}</span>
          <span className="block truncate text-xs text-zinc-500">{plan}</span>
        </span>
        <span className="text-zinc-500" aria-hidden>
          ⌃
        </span>
      </button>
    </div>
  );
}
