"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { BrandMark, Sparkle } from "@/app/brand";
import { api, type Me, type ProjectSummary } from "@/lib/store";
import { ENGINE_LABELS, type Engine } from "@/lib/types";
import { firstName } from "@/lib/names";
import { dateLine, greeting, shortAgo, timeAgo } from "@/lib/when";
import type { RecentChat } from "@/lib/server/recent";
import type { Choice } from "./ComposerTools";
import { EngineIcon } from "./EngineIcon";

type Site = { slug: string; title: string; updated_at: number; views: number; messages: number; unread: number };
type Usage = { tools: { engine: string; credits: number; requests: number }[]; total: number };

/** Line icons on a 24-unit grid, in the style of the sidebar's. */
export const ICONS = {
  home: "M3.5 10.5 12 3.5l8.5 7V20a1 1 0 0 1-1 1H15v-6H9v6H4.5a1 1 0 0 1-1-1z",
  chat: "M20.5 12a8.5 8.5 0 0 1-12.4 7.5L3.5 20.5l1-4.4A8.5 8.5 0 1 1 20.5 12z M8.5 12h.01 M12 12h.01 M15.5 12h.01",
  create: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z",
  voice: "M4 10v4 M8 7v10 M12 4v16 M16 7v10 M20 10v4",
  images: "M4 5h16v14H4z M4 16l4.5-4.5 3.5 3.5 2.5-2.5L20 18 M16 9.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z",
  workspace: "M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z",
  brand: "M3.5 12.6V4.5a1 1 0 0 1 1-1h8.1l8 8a1.4 1.4 0 0 1 0 2l-7.1 7.1a1.4 1.4 0 0 1-2 0z M8.5 8.5h.01",
  settings:
    "M12 15a3 3 0 1 0 0-6a3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  search: "M18 11a7 7 0 1 1-14 0a7 7 0 1 1 14 0z M20.5 20.5l-4.5-4.5",
  code: "M8 8l-4 4 4 4 M16 8l4 4-4 4 M13.5 5.5l-3 13",
  image: "M4 5h16v14H4z M4 16l4.5-4.5 3.5 3.5 2.5-2.5L20 18 M16 9.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z",
  video: "M3.5 6.5h12v11h-12z M15.5 10.5l5-3v9l-5-3",
  file: "M7 3h7l5 5v13H7z M14 3v5h5 M10 13h6 M10 17h4",
  app: "M3 5h18v14H3z M3 9h18 M6 7h.01 M8.5 7h.01",
  globe: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M3 12h18 M12 3c2.4 2.6 3.6 5.6 3.6 9s-1.2 6.4-3.6 9c-2.4-2.6-3.6-5.6-3.6-9S9.6 5.6 12 3z",
  template: "M5 3.5h14v17H5z M8.5 8h7 M8.5 12h7 M8.5 16h4",
  plus: "M12 5v14 M5 12h14",
  chevron: "M9 6l6 6-6 6",
  down: "M7 10l5 5 5-5",
  arrow: "M5 12h14 M13 6l6 6-6 6",
  dots: "M6 12h.01 M12 12h.01 M18 12h.01",
  sliders: "M4 7h10 M18 7h2 M4 17h4 M12 17h8 M16 5v4 M10 15v4",
  sparkle: "M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z",
  paperclip: "M20.5 11.5l-8.2 8.2a5.3 5.3 0 0 1-7.5-7.5l8.2-8.2a3.5 3.5 0 0 1 5 5l-8.2 8.2a1.8 1.8 0 0 1-2.5-2.5l7.6-7.6",
} as const;

export function Icon({ d, className = "h-5 w-5", strokeWidth = 1.7 }: { d: string; className?: string; strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

// The tinted tiles behind each tool's icon: blue chat, teal voice, orange pictures, violet code, pink research.
const HUES = {
  blue: "bg-sky-400/15 text-sky-300 ring-sky-300/20 light:bg-sky-100 light:text-sky-600 light:ring-sky-200",
  teal: "bg-teal-400/15 text-teal-300 ring-teal-300/20 light:bg-teal-100 light:text-teal-600 light:ring-teal-200",
  orange: "bg-orange-400/15 text-orange-300 ring-orange-300/20 light:bg-orange-100 light:text-orange-600 light:ring-orange-200",
  violet: "bg-violet-400/15 text-violet-300 ring-violet-300/20 light:bg-violet-100 light:text-violet-600 light:ring-violet-200",
  pink: "bg-fuchsia-400/15 text-fuchsia-300 ring-fuchsia-300/20 light:bg-fuchsia-100 light:text-fuchsia-600 light:ring-fuchsia-200",
  rose: "bg-rose-400/15 text-rose-300 ring-rose-300/20 light:bg-rose-100 light:text-rose-600 light:ring-rose-200",
} as const;
type Hue = keyof typeof HUES;

// The bars in Usage & Plan, in the same order of colours.
const BARS = ["bg-sky-400 light:bg-sky-500", "bg-teal-400 light:bg-teal-500", "bg-rose-400 light:bg-rose-500", "bg-violet-400 light:bg-violet-500"];

// The pastel washes on the Your workspace tiles.
const TILES = [
  "from-sky-400/15 to-violet-400/10 light:from-sky-100 light:to-violet-100",
  "from-violet-400/15 to-fuchsia-400/10 light:from-violet-100 light:to-fuchsia-100",
  "from-teal-400/15 to-sky-400/10 light:from-teal-50 light:to-sky-100",
  "from-orange-400/15 to-rose-400/10 light:from-orange-50 light:to-rose-100",
];

function Tile({ d, hue, size = "md" }: { d: string; hue: Hue; size?: "sm" | "md" }) {
  const box = size === "sm" ? "h-9 w-9 rounded-xl" : "h-12 w-12 rounded-2xl";
  return (
    <span className={`inline-flex shrink-0 items-center justify-center ring-1 ring-inset ${box} ${HUES[hue]}`} aria-hidden>
      <Icon d={d} className={size === "sm" ? "h-[18px] w-[18px]" : "h-6 w-6"} />
    </span>
  );
}

/** The F-bolt floating in an iridescent glass sphere, with a few sparkles around it (see .flash-orb in globals.css). */
function Orb({ className = "" }: { className?: string }) {
  return (
    <div className={`relative ${className}`} aria-hidden>
      <div className="flash-orb w-full">
        <div className="absolute inset-0 flex items-center justify-center [filter:drop-shadow(0_0_22px_rgb(94_234_212/0.45))] light:[filter:drop-shadow(0_10px_18px_rgb(16_22_48/0.28))]">
          <span className="block w-[62%] [&>svg]:h-auto [&>svg]:w-full">
            <BrandMark size={256} id="flash-orb" ring={false} />
          </span>
        </div>
      </div>
      <Sparkle className="absolute -left-1 top-[12%] h-5 w-5 text-white/80 light:text-violet-300" />
      <Sparkle className="absolute right-[2%] top-[4%] h-3 w-3 text-teal-200/80 light:text-sky-300" />
      <Sparkle className="absolute bottom-[10%] right-[-2%] h-4 w-4 text-violet-200/80 light:text-pink-300" />
    </div>
  );
}

/** "Good afternoon, Adolff" over "Friday • Oct 9, 2026 • Your workspace is ready". */
export function Greeting({ me, className = "" }: { me: Me; className?: string }) {
  const now = new Date();
  return (
    <div className={`min-w-0 ${className}`}>
      <h2 className="truncate text-[26px] font-semibold tracking-[-0.02em] text-white sm:text-[30px]">
        {greeting(now)}, {firstName(me.user)}
      </h2>
      <p className="mt-1 truncate text-[15px] text-zinc-400">{dateLine(now)}</p>
    </div>
  );
}

// A menu that opens near the bottom of the page scrolls just enough to show all of it.
function showWhole(menu: HTMLDivElement | null) {
  menu?.scrollIntoView({ block: "nearest" });
}

function Card({ title, action, children, className = "" }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`glass relative min-w-0 rounded-3xl p-4 sm:p-5 has-[[role=menu]]:z-20 ${className}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-[17px] font-semibold tracking-tight text-white">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function ViewAll({ onClick, label = "View all" }: { onClick: () => void; label?: string }) {
  return (
    <button onClick={onClick} className="inline-flex shrink-0 items-center gap-1 text-sm text-primary-soft transition hover:text-white">
      {label} <Icon d={ICONS.arrow} className="h-3.5 w-3.5" />
    </button>
  );
}

/**
 * Home: the greeting, the "What will you create today?" hero with the message box, a tool for each
 * kind of work, recent chats, the user's published sites, their usage and plan, and quick tools.
 * Everything on it is something Flash does today.
 */
export function Home({
  me,
  composer,
  isLive,
  projects,
  onTool,
  onAttach,
  onTalk,
  onOpenChat,
  onViewChats,
  onPin,
  onRename,
  onDelete,
  onApps,
  onTemplates,
  onUsage,
  onPlans,
  paymentsOn,
}: {
  me: Me;
  // The message box, shown in the hero.
  composer: ReactNode;
  isLive: (e: Engine) => boolean;
  // The chats as the sidebar has them, so a rename or delete shows here at once.
  projects: ProjectSummary[];
  // Picks a tool in the message box and puts the cursor there.
  onTool: (choice: Choice) => void;
  onAttach: () => void;
  onTalk: () => void;
  onOpenChat: (id: string) => void;
  onViewChats: () => void;
  onPin: (id: string) => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => Promise<void> | void;
  onApps: () => void;
  onTemplates: () => void;
  onUsage: () => void;
  onPlans: () => void;
  paymentsOn: boolean;
}) {
  const [recent, setRecent] = useState<RecentChat[] | null>(null);
  const [sites, setSites] = useState<Site[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [menu, setMenu] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ chats: RecentChat[] }>("/api/projects/recent")
      .then(({ chats }) => setRecent(chats))
      .catch(() => setRecent([]));
    api<{ sites: Site[] }>("/api/sites")
      .then(({ sites }) => setSites(sites))
      .catch(() => setSites([]));
    api<Usage>("/api/me/usage")
      .then(setUsage)
      .catch(() => setUsage({ tools: [], total: 0 }));
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menuRef.current?.contains(e.target as Node)) setMenu("");
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menu]);

  const now = new Date();
  // A team member spends the team's credits, so they see neither "Free plan" nor the upgrade offer.
  const inTeam = me.teamCredits !== null;
  const free = !me.plan && !inTeam;
  const allowance = me.plan?.credits ?? me.freeMonthly;
  const planLabel = me.plan ? `${me.plan.name} plan` : inTeam ? "Team plan" : "Free plan";
  // Packs, rewards, rollover and team credits can take the balance past the monthly amount.
  const overAllowance = me.credits > allowance;

  const chips: { label: string; d: string; hue: string; run: () => void; live: boolean }[] = [
    { label: "Research", d: ICONS.search, hue: "text-violet-300 light:text-violet-600", run: () => onTool("search"), live: isLive("search") },
    { label: "Create Image", d: ICONS.image, hue: "text-teal-300 light:text-teal-600", run: () => onTool("image"), live: isLive("image") },
    { label: "Generate Video", d: ICONS.video, hue: "text-rose-300 light:text-rose-600", run: () => onTool("video"), live: isLive("video") },
    { label: "Analyze File", d: ICONS.file, hue: "text-sky-300 light:text-sky-600", run: onAttach, live: true },
    { label: "Build an App", d: ICONS.app, hue: "text-orange-300 light:text-orange-600", run: () => onTool("app"), live: isLive("app") },
  ];

  const tools: { title: string; about: string; d: string; hue: Hue; run: () => void; live: boolean }[] = [
    { title: "AI Chat", about: "Instant answers and insights", d: ICONS.chat, hue: "blue", run: () => onTool("auto"), live: true },
    { title: "Voice", about: "Talk and transcribe", d: ICONS.voice, hue: "teal", run: onTalk, live: true },
    { title: "Image", about: "Generate and edit visuals", d: ICONS.image, hue: "orange", run: () => onTool("image"), live: isLive("image") },
    { title: "Code", about: "Build, debug and ship", d: ICONS.code, hue: "violet", run: () => onTool("code"), live: isLive("code") },
    { title: "Research", about: "Up-to-date answers with sources", d: ICONS.search, hue: "pink", run: () => onTool("search"), live: isLive("search") },
  ];

  const quick: { label: string; d: string; run: () => void; live: boolean }[] = [
    { label: "New chat", d: ICONS.chat, run: () => onTool("auto"), live: true },
    { label: "Talk with Flash", d: ICONS.voice, run: onTalk, live: true },
    { label: "Generate image", d: ICONS.image, run: () => onTool("image"), live: isLive("image") },
    { label: "Create document", d: ICONS.file, run: () => onTool("docs"), live: isLive("docs") },
    { label: "Build an app", d: ICONS.app, run: () => onTool("app"), live: isLive("app") },
    { label: "Start from a template", d: ICONS.template, run: onTemplates, live: true },
  ];

  // Renamed chats show their new name, and deleted ones go.
  const chats = (recent ?? []).flatMap((c) => {
    const p = projects.find((x) => x.id === c.id);
    return p ? [{ ...c, name: p.name, pinned: Boolean(p.pinned) }] : [];
  });
  const used = usage ? [...usage.tools].sort((a, b) => b.credits - a.credits).slice(0, 3) : [];

  return (
    <div className="mx-auto w-full max-w-[1600px] px-4 pb-10 pt-4 sm:px-6 sm:pt-6 lg:px-8">
      {/* When there's room, the greeting sits in the top bar instead (see Flash.tsx). */}
      <Greeting me={me} className="mb-5 sm:mb-6 @min-[1100px]/main:hidden" />

      {/* Sized by the space beside the sidebar (and the companion, when it's open), not the screen. */}
      <div className="grid gap-5 @min-[1100px]/main:grid-cols-[minmax(0,1fr)_300px] @min-[1180px]/main:grid-cols-[minmax(0,1fr)_320px] @min-[1500px]/main:grid-cols-[minmax(0,1fr)_360px]">
        <div className="@container/left min-w-0 space-y-5">
          {/* Hero: the orb beside the question, and the message box under both, as wide as it can be. */}
          <section className="@container/hero glass-raised relative z-10 rounded-[28px] has-[[role=menu]]:z-40">
            <div className="pointer-events-none absolute inset-0 rounded-[28px] bg-iris-wash" />
            <div className="relative grid items-center gap-x-6 gap-y-5 p-4 sm:p-8 @min-[640px]/hero:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)] @min-[640px]/hero:gap-y-6 lg:px-9 lg:pt-9">
              <Orb className="mx-auto w-28 sm:w-36 @min-[640px]/hero:w-full @min-[640px]/hero:max-w-[230px]" />
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.34em] text-zinc-300">Flash AI</p>
                {/* Two lines whatever the width: the type scales with the hero, and each phrase stays whole. */}
                <h1 className="mt-3 text-[clamp(32px,9.5cqw,48px)] font-bold leading-[1.04] tracking-[-0.035em] text-white @min-[640px]/hero:text-[clamp(40px,6.8cqw,58px)]">
                  <span className="whitespace-nowrap">What will you</span> <span className="whitespace-nowrap text-iris">create today?</span>
                </h1>
                <p className="mt-3 text-[15px] text-zinc-400 sm:text-lg">Chat, create, generate, analyze and build: all in one place.</p>
              </div>
              <div className="min-w-0 @min-[640px]/hero:col-span-2 @min-[760px]/hero:pl-[10%] @min-[1100px]/hero:pl-[16%]">
                {composer}
                <div
                  className="mt-3 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] @min-[640px]/hero:flex-wrap @min-[640px]/hero:overflow-visible"
                  aria-label="Quick starts"
                >
                  {chips
                    .filter((c) => c.live)
                    .map((c) => (
                      <button
                        key={c.label}
                        onClick={c.run}
                        className="glass inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] text-zinc-200 shadow-none transition hover:text-white hover:brightness-110"
                      >
                        <Icon d={c.d} className={`h-3.5 w-3.5 ${c.hue}`} />
                        {c.label}
                      </button>
                    ))}
                </div>
              </div>
            </div>
          </section>

          {/* A tool for each kind of work */}
          {/* On a phone a lone last card takes the whole row. */}
          <div className="grid grid-cols-2 gap-3 @min-[520px]/left:grid-cols-3 @min-[680px]/left:grid-cols-5 @max-[520px]/left:[&>:last-child:nth-child(odd)]:col-span-2">
            {tools
              .filter((t) => t.live)
              .map((t) => (
                <button
                  key={t.title}
                  onClick={t.run}
                  className="glass group flex min-w-0 flex-col items-start gap-3 rounded-3xl p-3.5 text-left transition hover:-translate-y-0.5 hover:brightness-110 sm:p-4"
                >
                  <Tile d={t.d} hue={t.hue} />
                  <span className="block w-full min-w-0">
                    <span className="flex items-center gap-1">
                      <span className="min-w-0 flex-1 truncate text-[17px] font-semibold tracking-tight text-white">{t.title}</span>
                      <Icon d={ICONS.chevron} className="h-4 w-4 shrink-0 text-zinc-500 transition group-hover:translate-x-0.5 group-hover:text-zinc-200" />
                    </span>
                    <span className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-zinc-400">{t.about}</span>
                  </span>
                </button>
              ))}
          </div>

          <div className="grid gap-5 @min-[700px]/left:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <Card title="Recent conversations" action={chats.length ? <ViewAll onClick={onViewChats} /> : undefined}>
              {!recent ? (
                <p className="py-6 text-center text-sm text-zinc-500">Loading…</p>
              ) : !chats.length ? (
                <p className="py-6 text-center text-sm text-zinc-400">Your chats will show here. Ask Flash anything above to start one.</p>
              ) : (
                <ul className="-mx-1 divide-y divide-white/[0.06]">
                  {chats.slice(0, 5).map((c) => (
                    <li key={c.id} className="relative flex items-center gap-1">
                      <button onClick={() => onOpenChat(c.id)} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-1 py-2.5 text-left transition hover:bg-white/[0.04]">
                        {c.engine && c.engine in ENGINE_LABELS ? (
                          <EngineIcon engine={c.engine as Engine} />
                        ) : (
                          <Tile d={ICONS.chat} hue="blue" size="sm" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[15px] font-medium text-zinc-100">{c.name}</span>
                          {c.preview && <span className="block truncate text-[13px] text-zinc-500">{c.preview}</span>}
                        </span>
                        <span className="hidden shrink-0 text-xs text-zinc-400 sm:block">{timeAgo(c.updatedAt, now.getTime())}</span>
                      </button>
                      <div ref={menu === c.id ? menuRef : undefined} className="relative">
                        <button
                          onClick={() => setMenu(menu === c.id ? "" : c.id)}
                          aria-label={`More for ${c.name}`}
                          aria-expanded={menu === c.id}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
                        >
                          <Icon d={ICONS.dots} className="h-5 w-5" strokeWidth={2.6} />
                        </button>
                        {menu === c.id && (
                          <div ref={showWhole} role="menu" className="absolute right-0 top-full z-30 mt-1 w-40 rounded-xl border border-white/10 bg-zinc-900 p-1 shadow-xl">
                            {[
                              [c.pinned ? "Unpin" : "Pin to the top", () => onPin(c.id)],
                              ["Rename", () => onRename(c.id)],
                              ["Delete", () => onDelete(c.id)],
                            ].map(([label, run]) => (
                              <button
                                key={label as string}
                                role="menuitem"
                                onClick={() => {
                                  setMenu("");
                                  (run as () => void)();
                                }}
                                className={`block w-full rounded-lg px-3 py-1.5 text-left text-sm transition hover:bg-white/[0.06] ${label === "Delete" ? "text-red-400" : "text-zinc-200"}`}
                              >
                                {label as string}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Your workspace" action={sites?.length ? <ViewAll onClick={onApps} /> : undefined}>
              {!sites ? (
                <p className="py-6 text-center text-sm text-zinc-500">Loading…</p>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {sites.slice(0, 4).map((s, i) => (
                    <button
                      key={s.slug}
                      onClick={onApps}
                      className={`flex min-w-0 flex-col items-start gap-3 rounded-2xl border border-white/[0.08] bg-gradient-to-br p-3.5 text-left transition hover:brightness-110 ${TILES[i % TILES.length]}`}
                    >
                      <Icon d={ICONS.globe} className="h-5 w-5 text-sky-300 light:text-sky-600" />
                      <span className="w-full min-w-0">
                        <span className="block truncate text-sm font-semibold text-zinc-100">{s.title || s.slug}</span>
                        {(s.unread > 0 || s.views > 0) && (
                          <span className="block truncate text-xs text-zinc-400">
                            {s.unread ? `${s.unread} new ${s.unread === 1 ? "message" : "messages"}` : `${s.views.toLocaleString()} ${s.views === 1 ? "visit" : "visits"}`}
                          </span>
                        )}
                        <span className="block truncate text-xs text-zinc-400">Updated {shortAgo(s.updated_at, now.getTime())}</span>
                      </span>
                    </button>
                  ))}
                  {sites.length < 2 &&
                    [
                      { title: "Build a website", about: "Publish in one click", d: ICONS.globe, run: () => onTool("app"), live: isLive("app") },
                      { title: "Make slides", about: "From one sentence", d: ICONS.template, run: () => onTool("slides"), live: isLive("slides") },
                    ]
                      .filter((t) => t.live)
                      .slice(0, 2 - sites.length)
                      .map((t, i) => (
                        <button
                          key={t.title}
                          onClick={t.run}
                          className={`flex min-w-0 flex-col items-start gap-3 rounded-2xl border border-dashed border-white/15 bg-gradient-to-br p-3.5 text-left transition hover:brightness-110 ${TILES[(i + 1) % TILES.length]}`}
                        >
                          <Icon d={t.d} className="h-5 w-5 text-violet-300 light:text-violet-600" />
                          <span className="w-full min-w-0">
                            <span className="block truncate text-sm font-semibold text-zinc-100">{t.title}</span>
                            <span className="block truncate text-xs text-zinc-400">{t.about}</span>
                          </span>
                        </button>
                      ))}
                </div>
              )}
            </Card>
          </div>
        </div>

        {/* Beside the main column when there's room; below it, side by side, when there isn't. */}
        <aside
          className="grid min-w-0 content-start gap-5 grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] @min-[1100px]/main:grid-cols-1"
          aria-label="Your plan and quick tools"
        >
          <Card
            title="Usage & Plan"
            action={
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-gold/15 px-2.5 py-1 text-xs font-medium text-gold-soft light:bg-amber-50">
                <span aria-hidden>👑</span> {planLabel}
              </span>
            }
          >
            <p className="-mt-1 mb-4 text-sm text-zinc-400">
              {me.credits < 10 ? "You're running low on credits." : "Your AI creativity engine is running strong."}
            </p>
            <ul className="space-y-4">
              <li>
                <div className="flex items-center gap-2.5 text-sm">
                  <Icon d={ICONS.sparkle} className="h-[18px] w-[18px] text-gold" />
                  <span className="flex-1 text-zinc-200">Credits left</span>
                  <span className="tabular-nums text-zinc-400">
                    {me.credits.toLocaleString()}
                    {!overAllowance && ` / ${allowance.toLocaleString()}`}
                  </span>
                </div>
                <div className="ml-7 mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
                  <div className="h-full rounded-full bg-gradient-to-r from-teal-400 to-violet-400 light:from-sky-500 light:to-violet-500" style={{ width: `${Math.min(100, Math.max(3, (me.credits / Math.max(1, allowance)) * 100))}%` }} />
                </div>
              </li>
              {used.map((t, i) => (
                <li key={t.engine}>
                  <div className="flex items-center gap-2.5 text-sm">
                    <span className="w-[18px] shrink-0 text-center text-zinc-400">
                      {t.engine in ENGINE_LABELS ? <EngineGlyph engine={t.engine as Engine} /> : <Icon d={ICONS.chat} className="h-[18px] w-[18px]" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-zinc-200">{t.engine === "companion" ? "Ask Flash" : (ENGINE_LABELS[t.engine as Engine] ?? t.engine)}</span>
                    <span className="shrink-0 tabular-nums text-zinc-400">{t.credits.toLocaleString()} credits</span>
                  </div>
                  <div className="ml-7 mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
                    <div className={`h-full rounded-full ${BARS[(i + 1) % BARS.length]}`} style={{ width: `${Math.min(100, Math.max(3, (t.credits / Math.max(1, allowance)) * 100))}%` }} />
                  </div>
                </li>
              ))}
            </ul>
            {usage && !used.length && <p className="mt-4 text-sm text-zinc-500">Nothing used yet this month.</p>}
            <button onClick={onUsage} className="mt-4 inline-flex items-center gap-1 text-sm text-primary-soft transition hover:text-white">
              See all usage <Icon d={ICONS.arrow} className="h-3.5 w-3.5" />
            </button>
          </Card>

          {free && paymentsOn && (
            <section className="glass relative overflow-hidden rounded-3xl p-5">
              <div className="pointer-events-none absolute inset-0 bg-iris-wash opacity-90" />
              <div className="relative">
                <h3 className="flex items-center gap-2 text-[17px] font-semibold tracking-tight text-white">
                  <span aria-hidden>🌟</span> Unlock more with Flash Pro
                </h3>
                <p className="mt-1.5 text-sm text-zinc-300">3,000 credits a month for apps, slides, research and more. Unused credits carry over.</p>
                <button onClick={onPlans} className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-semibold text-on-brand transition hover:brightness-110">
                  Upgrade now <Icon d={ICONS.arrow} className="h-4 w-4" />
                </button>
              </div>
            </section>
          )}

          <Card title="Quick tools" action={<Icon d={ICONS.sliders} className="h-5 w-5 text-zinc-500" />}>
            <ul className="-mx-1">
              {quick
                .filter((q) => q.live)
                .map((q) => (
                  <li key={q.label}>
                    <button onClick={q.run} className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left text-[15px] text-zinc-200 transition hover:bg-white/[0.05] hover:text-white">
                      <Icon d={q.d} className="h-5 w-5 text-zinc-400" />
                      <span className="flex-1">{q.label}</span>
                      <Icon d={ICONS.chevron} className="h-4 w-4 text-zinc-600" />
                    </button>
                  </li>
                ))}
            </ul>
          </Card>
        </aside>
      </div>
    </div>
  );
}

/** An engine's icon alone, without its tile, for the usage list. */
function EngineGlyph({ engine }: { engine: Engine }) {
  const d: Partial<Record<Engine, string>> = {
    text: ICONS.chat,
    search: ICONS.search,
    code: ICONS.code,
    image: ICONS.image,
    video: ICONS.video,
    voice: ICONS.voice,
    app: ICONS.app,
    docs: ICONS.file,
    slides: ICONS.template,
    music: ICONS.voice,
    transcribe: ICONS.file,
    translate: ICONS.globe,
  };
  return <Icon d={d[engine] ?? ICONS.chat} className="inline h-[18px] w-[18px]" />;
}
