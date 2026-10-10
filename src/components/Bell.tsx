"use client";

import { useEffect, useRef, useState } from "react";
import { api, type Me } from "@/lib/store";
import { shortAgo } from "@/lib/when";
import { useT } from "@/lib/use-t";
import { ICONS, Icon } from "./Home";

type Site = { slug: string; title: string; unread: number };

const SEEN_KEY = "flash:bell-seen";
// Credits added in the last two weeks show in the list; older ones are in Settings > Usage.
const RECENT = 14 * 24 * 60 * 60 * 1000;

function seenAt(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}

/**
 * The bell in the top bar: new messages from the forms on the user's published sites, credits
 * running low, and credits added lately. The dot shows while there's something they haven't seen.
 */
export function Bell({ me, onSites, onCredits }: { me: Me; onSites: () => void; onCredits: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [seen, setSeen] = useState(Number.POSITIVE_INFINITY);
  // The time the list was last looked at, for "2h ago" and what counts as recent.
  const [now, setNow] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Known only in the browser, not while rendering on the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSeen(seenAt());
    setNow(Date.now());
    api<{ sites: Site[] }>("/api/sites")
      .then(({ sites }) => setSites(sites))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const unread = sites.filter((s) => s.unread > 0);
  const low = me.credits < 10;
  const added = now ? me.activity.filter((a) => a.amount > 0 && now - a.created_at < RECENT).slice(0, 5) : [];
  const fresh = unread.length > 0 || low || added.some((a) => a.created_at > seen);
  const empty = !unread.length && !low && !added.length;

  function toggle() {
    if (!open) {
      const now = Date.now();
      setNow(now);
      api<{ sites: Site[] }>("/api/sites")
        .then(({ sites }) => setSites(sites))
        .catch(() => {});
      try {
        localStorage.setItem(SEEN_KEY, String(now));
      } catch {
        // Storage blocked: the dot shows again next visit.
      }
      setSeen(now);
    }
    setOpen((o) => !o);
  }

  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  const row = "flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition hover:bg-white/[0.06]";

  return (
    <div ref={box} className="relative shrink-0">
      <button
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={fresh ? t("Notifications: something new") : t("Notifications")}
        title={t("Notifications")}
        className="glass relative flex h-12 w-12 items-center justify-center rounded-full text-zinc-200 shadow-none transition hover:brightness-110 hover:text-white @min-[1100px]/main:h-[52px] @min-[1100px]/main:w-[52px]"
      >
        <Icon d={ICONS.bell} className="h-[22px] w-[22px]" />
        {fresh && <span className="absolute right-3 top-3 h-2.5 w-2.5 rounded-full bg-rose-500 ring-2 ring-zinc-950" aria-hidden />}
      </button>
      {open && (
        <div role="menu" aria-label={t("Notifications")} className="absolute right-0 top-full z-30 mt-2 w-80 rounded-2xl border border-white/10 bg-zinc-900 p-1.5 shadow-2xl light:shadow-black/10">
          <p className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wider text-zinc-500">{t("Notifications")}</p>
          {empty && <p className="px-3 py-4 text-sm text-zinc-400">{t("You're all caught up.")}</p>}
          {unread.map((s) => (
            <button key={s.slug} role="menuitem" onClick={pick(onSites)} className={row}>
              <Icon d={ICONS.chat} className="mt-0.5 h-[18px] w-[18px] shrink-0 text-sky-400 light:text-sky-600" />
              <span className="min-w-0 flex-1">
                <span className="block text-zinc-100">
                  {s.unread === 1 ? t("1 new message") : t("{count} new messages", { count: s.unread.toLocaleString(t.locale) })}
                </span>
                <span className="block truncate text-xs text-zinc-500">{t("From your site {name}", { name: s.title || s.slug })}</span>
              </span>
            </button>
          ))}
          {low && (
            <button role="menuitem" onClick={pick(onCredits)} className={row}>
              <Icon d={ICONS.sparkle} className="mt-0.5 h-[18px] w-[18px] shrink-0 text-gold" />
              <span className="min-w-0 flex-1">
                <span className="block text-zinc-100">{t("You're running low on credits")}</span>
                <span className="block text-xs text-zinc-500">{t("{count} left. Top up or pick a plan.", { count: me.credits.toLocaleString(t.locale) })}</span>
              </span>
            </button>
          )}
          {added.map((a, i) => (
            <button key={`${a.created_at}-${i}`} role="menuitem" onClick={pick(onCredits)} className={row}>
              <Icon d={ICONS.plus} className="mt-0.5 h-[18px] w-[18px] shrink-0 text-emerald-500" />
              <span className="min-w-0 flex-1">
                <span className="block text-zinc-100">{t("+{count} credits", { count: a.amount.toLocaleString(t.locale) })}</span>
                <span className="block truncate text-xs text-zinc-500">{a.reason}</span>
              </span>
              <span className="shrink-0 text-xs text-zinc-500">{shortAgo(a.created_at, now, t.locale)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
