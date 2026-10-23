"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Me } from "@/lib/store";
import { bellState, type BellSite } from "@/lib/bell";
import { shortAgo } from "@/lib/when";
import { useT } from "@/lib/use-t";
import { ICONS, Icon } from "./Home";

// When the list was last looked at, per account (a browser can be signed in to several).
const SEEN_KEY = "flash:bell-seen";
const seenKey = (userId: string) => `${SEEN_KEY}:${userId}`;
// Whether the list was opened since the balance went below the low-credit level (see bell.ts).
const lowSeenKey = (userId: string) => `flash:bell-low-seen:${userId}`;

function readLowSeen(userId: string): boolean {
  try {
    return localStorage.getItem(lowSeenKey(userId)) === "1";
  } catch {
    return false;
  }
}

function seenAt(userId: string): number {
  try {
    // Kept for everyone before it was kept per account: the first account to read it takes it over.
    const kept = localStorage.getItem(seenKey(userId)) ?? localStorage.getItem(SEEN_KEY);
    if (localStorage.getItem(SEEN_KEY) !== null) {
      localStorage.setItem(seenKey(userId), kept ?? "0");
      localStorage.removeItem(SEEN_KEY);
    }
    return Number(kept) || 0;
  } catch {
    return 0;
  }
}

/** An automation's notice, in the reader's words (see listNotices). */
type Notice = { id: string; kind: string; title: string; text: string; body?: string; offer?: { kind: string; text: string }; link: string; createdAt: number; read: boolean };
// How often the bell asks for new automation notices while the tab is shown.
const NOTICES_EVERY = 60_000;

/** The automation (and run) a notice's link opens: "automations=<id>&run=<runId>". */
function automationOf(link: string): { automation: string; run?: string } | null {
  const params = new URLSearchParams(link);
  const automation = params.get("automations");
  return automation ? { automation, run: params.get("run") ?? undefined } : null;
}

/**
 * The bell in the top bar: what the user's automations did (once they have Automations), new
 * messages from the forms on their published sites, credits running low, an app's AI turning
 * visitors away for lack of credits, and credits added lately (see bell.ts). The dot shows while
 * there's something they haven't seen.
 */
export function Bell({
  me,
  onSites,
  onCredits,
  onAutomation,
  onNews,
}: {
  me: Me;
  onSites: () => void;
  onCredits: () => void;
  onAutomation?: (at: { automation: string; run?: string }) => void;
  // A new automation notice came in (a run ended, so the balance may have changed).
  onNews?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [sites, setSites] = useState<BellSite[]>([]);
  const [seen, setSeen] = useState(Number.POSITIVE_INFINITY);
  // Whether the list was opened since the balance went below the low-credit level.
  const [lowSeen, setLowSeen] = useState(true);
  // The time the list was last looked at, for "2h ago" and what counts as recent.
  const [now, setNow] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [unreadNotices, setUnreadNotices] = useState(0);
  const lastUnread = useRef<number | null>(null);
  const automations = Boolean(me.automationsEnabled);
  // The page's own, read when notices come back (so a new one each render doesn't restart the asking).
  const news = useRef(onNews);
  useEffect(() => {
    news.current = onNews;
  });

  const loadNotices = useCallback(() => {
    if (!automations) return;
    api<{ notices: Notice[]; unread: number }>("/api/notifications")
      .then((got) => {
        setNotices(got.notices);
        setUnreadNotices(got.unread);
        if (lastUnread.current !== null && got.unread > lastUnread.current) news.current?.();
        lastUnread.current = got.unread;
      })
      .catch(() => {});
  }, [automations]);

  // Asked when the page opens, every minute while the tab is shown, and when the tab comes back.
  useEffect(() => {
    if (!automations) return;
    loadNotices();
    const timer = setInterval(() => document.visibilityState === "visible" && loadNotices(), NOTICES_EVERY);
    const back = () => document.visibilityState === "visible" && loadNotices();
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [automations, loadNotices, me.user.id]);

  useEffect(() => {
    // Known only in the browser, not while rendering on the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSeen(seenAt(me.user.id));
    setLowSeen(readLowSeen(me.user.id));
    setNow(Date.now());
    api<{ sites: BellSite[] }>("/api/sites")
      .then(({ sites }) => setSites(sites))
      .catch(() => {});
  }, [me.user.id]);

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

  const state = bellState(me, sites, now, seen, lowSeen);
  const { unread, low, added, aiOut } = state;
  const fresh = state.fresh || unreadNotices > 0;
  const empty = state.empty && notices.length === 0;

  // Back above the level: the next time it goes below, the dot shows again.
  useEffect(() => {
    if (low) return;
    try {
      localStorage.removeItem(lowSeenKey(me.user.id));
    } catch {
      // Storage blocked: nothing was kept.
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLowSeen(false);
  }, [low, me.user.id]);

  function toggle() {
    if (!open) {
      const now = Date.now();
      setNow(now);
      api<{ sites: BellSite[] }>("/api/sites")
        .then(({ sites }) => setSites(sites))
        .catch(() => {});
      loadNotices();
      try {
        localStorage.setItem(seenKey(me.user.id), String(now));
        if (low) localStorage.setItem(lowSeenKey(me.user.id), "1");
      } catch {
        // Storage blocked: the dot shows again next visit.
      }
      setSeen(now);
      if (low) setLowSeen(true);
    }
    setOpen((o) => !o);
  }

  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  // A notice opens its automation or run; opening it reads it (a run's receipt reads its notices too).
  const openNotice = (n: Notice) => () => {
    setOpen(false);
    const at = automationOf(n.link);
    if (at) onAutomation?.(at);
    if (n.read) return;
    setNotices((all) => all.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    setUnreadNotices((u) => Math.max(0, u - 1));
    lastUnread.current = Math.max(0, (lastUnread.current ?? 1) - 1);
    api("/api/notifications", { method: "POST", json: { read: [n.id] } }).catch(() => {});
  };
  const TONES: Record<string, string> = {
    run_done: "text-emerald-500",
    paused: "text-amber-400 light:text-amber-600",
    credits: "text-amber-400 light:text-amber-600",
    stopped: "text-amber-400 light:text-amber-600",
    missed: "text-zinc-400",
    interrupted: "text-red-400",
  };
  const row = "flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-start text-sm transition hover:bg-white/[0.06]";

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
        <div
          role="menu"
          aria-label={t("Notifications")}
          // On a phone the list spans the screen under the top bar (the bell sits too far in for a list
          // pinned to it to fit); wider, it opens from the bell toward the page, in either direction.
          className="fixed inset-x-4 top-16 z-30 rounded-2xl border border-white/10 bg-zinc-900 p-1.5 shadow-2xl light:shadow-black/10 sm:absolute sm:inset-x-auto sm:end-0 sm:top-full sm:mt-2 sm:w-80"
        >
          <p className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wider text-zinc-500">{t("Notifications")}</p>
          {empty && <p className="px-3 py-4 text-sm text-zinc-400">{t("You're all caught up.")}</p>}
          {/* The newest automation notices, unread first in weight: at most 8 here, the rest in Automations. */}
          {notices.slice(0, 8).map((n) => (
            <button key={n.id} role="menuitem" onClick={openNotice(n)} className={row}>
              <Icon d={ICONS.bolt} className={`mt-0.5 h-[18px] w-[18px] shrink-0 ${TONES[n.kind] ?? "text-zinc-400"}`} />
              <span className="min-w-0 flex-1">
                {n.title && (
                  <span dir="auto" className={`block truncate ${n.read ? "text-zinc-300" : "font-medium text-zinc-100"}`}>
                    {n.title}
                  </span>
                )}
                <span className={`block text-xs ${n.title ? "text-zinc-500" : n.read ? "text-zinc-300" : "text-zinc-100"}`}>{n.text}</span>
                {n.body && (
                  <span dir="auto" className="mt-0.5 line-clamp-2 block text-xs text-zinc-400">
                    {n.body}
                  </span>
                )}
                {n.offer && <span className="mt-0.5 block text-xs text-primary-soft">{n.offer.text}</span>}
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                <span className="text-xs text-zinc-500">{shortAgo(n.createdAt, now, t.locale)}</span>
                {!n.read && <span className="h-2 w-2 rounded-full bg-primary" aria-label={t("New")} />}
              </span>
            </button>
          ))}
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
                <span className="block text-zinc-100">{t("Your Flash credits are running low.")}</span>
                <span className="block text-xs text-zinc-500">
                  {t("Your apps and websites keep running, but they only get new updates while you have credits. Top up to keep them updating.")}
                </span>
                <span className="mt-0.5 block text-xs tabular-nums text-zinc-400">{t("{count} credits left.", { count: me.credits.toLocaleString(t.locale) })}</span>
              </span>
            </button>
          )}
          {aiOut.map((s) => (
            <button key={`ai-${s.slug}`} role="menuitem" onClick={pick(onCredits)} className={row}>
              <Icon d={ICONS.sparkle} className="mt-0.5 h-[18px] w-[18px] shrink-0 text-amber-400 light:text-amber-600" />
              <span className="min-w-0 flex-1">
                <span className="block text-zinc-100">
                  {s.aiAtLevel
                    ? t("The AI in {name} stopped at your auto top-up level", { name: s.title || s.slug })
                    : t("The AI in {name} is out of credits", { name: s.title || s.slug })}
                </span>
                <span className="block text-xs text-zinc-500">{t("Visitors' questions aren't being answered. The rest of the app keeps working.")}</span>
              </span>
              <span className="shrink-0 text-xs text-zinc-500">{shortAgo(s.aiOutOfCredits ?? 0, now, t.locale)}</span>
            </button>
          ))}
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
