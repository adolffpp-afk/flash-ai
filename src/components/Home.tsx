"use client";

import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { BrandMark, Sparkle } from "@/app/brand";
import { api, type Me, type ProjectSummary } from "@/lib/store";
import { ENGINE_LABELS, type Engine } from "@/lib/types";
import { firstName } from "@/lib/names";
import { dateLine, greeting, shortAgo, timeAgo } from "@/lib/when";
import type { RecentChat } from "@/lib/server/recent";
import type { FeatureAction } from "@/lib/features";
import type { Level } from "@/lib/levels";
import type { Choice } from "./ComposerTools";
import { onSettingChange, readSetting } from "@/lib/device-settings";
import { EngineIcon } from "./EngineIcon";
import { Everything } from "./Everything";

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
  library: "M3.5 6.5a1 1 0 0 1 1-1h5l2 2.5h8a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z",
  bell: "M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15z M10 20.5a2 2 0 0 0 4 0",
  bolt: "M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z",
  pen: "M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z M13.5 6.5l4 4",
  translate: "M4 5h9 M8.5 3v2 M6 5c.8 3.4 3.2 6 6 7.5 M11 5c-.8 3.4-3.2 6-6 7.5 M13 21l4-9 4 9 M14.5 18h5",
  wand: "M5 19 16 8 M14 6l2 2 M18 3v3 M16.5 4.5h3 M8 4v2 M7 5h2 M19 13v2 M18 14h2",
  layers: "M12 3.5 3 8.5l9 5 9-5z M3 12.5l9 5 9-5 M3 16.5l9 5 9-5",
  scissors: "M9 6a3 3 0 1 1-6 0a3 3 0 1 1 6 0z M9 18a3 3 0 1 1-6 0a3 3 0 1 1 6 0z M8.5 7.8 20 17 M8.5 16.2 20 7",
  expand: "M15 3h6v6 M9 21H3v-6 M21 3l-7 7 M3 21l7-7",
  film: "M3.5 4.5h17v15h-17z M7.5 4.5v15 M16.5 4.5v15 M3.5 9h4 M3.5 15h4 M16.5 9h4 M16.5 15h4",
  music: "M9 18V5l11-2v13 M9 18a3 3 0 1 1-6 0a3 3 0 1 1 6 0z M20 16a3 3 0 1 1-6 0a3 3 0 1 1 6 0z",
  megaphone: "M3.5 10v4a1 1 0 0 0 1 1H7l7 4V5L7 9H4.5a1 1 0 0 0-1 1z M17.5 9a4 4 0 0 1 0 6 M7 15l1.5 5",
  slides: "M3.5 4.5h17v11h-17z M12 15.5v4 M8 20h8 M7.5 12l3-3 2 2 3.5-3.5",
  inbox: "M3.5 13.5 6 5h12l2.5 8.5v5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5",
  chart: "M5 20v-6 M10 20V9 M15 20V4 M20 20v-9",
  link: "M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1 M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1",
  card: "M3 6h18v12H3z M3 10h18 M7 15h3",
  users: "M9 11a3.5 3.5 0 1 0 0-7a3.5 3.5 0 0 0 0 7z M2.5 20a6.5 6.5 0 0 1 13 0 M16 4.3a3.5 3.5 0 0 1 0 6.4 M18 14.2a6.5 6.5 0 0 1 3.5 5.8",
  scan: "M4 8V5a1 1 0 0 1 1-1h3 M16 4h3a1 1 0 0 1 1 1v3 M20 16v3a1 1 0 0 1-1 1h-3 M8 20H5a1 1 0 0 1-1-1v-3 M8 9h8 M8 12h8 M8 15h5",
  download: "M12 4v11 M7 10l5 5 5-5 M4.5 19.5h15",
  radio: "M12 12h.01 M8.5 8.5a5 5 0 0 0 0 7 M15.5 8.5a5 5 0 0 1 0 7 M5.6 5.6a9 9 0 0 0 0 12.8 M18.4 5.6a9 9 0 0 1 0 12.8",
  speaker: "M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z M15.5 9a4 4 0 0 1 0 6 M18 6.5a7.5 7.5 0 0 1 0 11",
  lines: "M4 6h16 M4 10h16 M4 14h10 M4 18h7",
  headphones: "M4 15v-3a8 8 0 0 1 16 0v3 M4 15a2 2 0 0 1 2-2h1v7H6a2 2 0 0 1-2-2z M20 15a2 2 0 0 0-2-2h-1v7h1a2 2 0 0 0 2-2z",
  bookmark: "M6 4h12v16l-6-4-6 4z",
  share: "M12 15V3 M7 8l5-5 5 5 M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7",
  plug: "M9 2.5v5 M15 2.5v5 M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0z M12 16v5.5",
  install: "M4 4.5h16v11H4z M12 7.5v5 M9.5 10l2.5 2.5 2.5-2.5 M8 19.5h8",
  star: "M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 15.6 7.1 18.2 8 12.7 4 8.8l5.5-.8z",
  gift: "M4 10h16v10H4z M3 6.5h18V10H3z M12 6.5V20 M12 6.5C10.5 3 7 3 7 5s3 1.5 5 1.5c2 0 5 .5 5-1.5s-3.5-2-5 1.5",
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
export type Hue = keyof typeof HUES;

// The bars in Usage & Plan, and their icons' colours: blue words, teal pictures, rose sound, violet files.
const BARS = ["bg-sky-400 light:bg-blue-500", "bg-teal-400 light:bg-emerald-500", "bg-rose-400 light:bg-rose-500", "bg-violet-400 light:bg-violet-500"];
const ROW_ICONS = ["text-sky-400 light:text-blue-500", "text-teal-400 light:text-emerald-500", "text-rose-400 light:text-rose-500", "text-violet-400 light:text-violet-500"];

// The pastel washes on the Your workspace tiles.
const TILES = [
  "from-sky-400/15 to-violet-400/10 light:from-sky-100 light:to-violet-100",
  "from-violet-400/15 to-fuchsia-400/10 light:from-violet-100 light:to-fuchsia-100",
  "from-teal-400/15 to-sky-400/10 light:from-teal-50 light:to-sky-100",
  "from-orange-400/15 to-rose-400/10 light:from-orange-50 light:to-rose-100",
];

export function Tile({ d, hue, size = "md" }: { d: string; hue: Hue; size?: "sm" | "md" }) {
  const box = size === "sm" ? "h-9 w-9 rounded-xl" : "h-12 w-12 rounded-2xl";
  return (
    <span className={`inline-flex shrink-0 items-center justify-center ring-1 ring-inset ${box} ${HUES[hue]}`} aria-hidden>
      <Icon d={d} className={size === "sm" ? "h-[18px] w-[18px]" : "h-6 w-6"} />
    </span>
  );
}

/** The F-bolt floating in an iridescent glass sphere, with a few sparkles around it (see .flash-orb in globals.css). */
export function Orb({ className = "" }: { className?: string }) {
  return (
    <div className={`relative ${className}`} aria-hidden>
      <div className="flash-orb w-full">
        <div className="absolute inset-0 flex items-center justify-center [filter:drop-shadow(0_0_22px_rgb(94_234_212/0.45))] light:[filter:drop-shadow(0_0_18px_rgb(91_140_246/0.45))]">
          <span className="block w-[70%] [&>svg]:h-auto [&>svg]:w-full">
            <BrandMark size={256} id="flash-orb" ring={false} vivid />
          </span>
        </div>
      </div>
      <Sparkle className="absolute -left-1 top-[12%] h-5 w-5 text-white/80 light:text-paper light:[filter:drop-shadow(0_0_5px_rgb(139_92_246/0.9))]" />
      <Sparkle className="absolute right-[2%] top-[4%] h-3 w-3 text-teal-200/80 light:text-sky-300" />
      <Sparkle className="absolute bottom-[4%] left-[8%] h-4 w-4 text-violet-200/80 light:text-pink-300" />
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
  onFeature,
  level,
  onLevel,
  installable,
  shortcuts,
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
  // Opens a feature from "Everything Flash can do".
  onFeature: (action: FeatureAction) => void;
  level: Level;
  onLevel: (level: Level) => void;
  installable: boolean;
  // Off during a voice conversation, so a key pressed then doesn't end it.
  shortcuts: boolean;
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
    { label: "Deep Research", d: ICONS.search, hue: "text-violet-300 light:text-violet-600", run: () => onTool("search"), live: isLive("search") },
    { label: "Create Image", d: ICONS.image, hue: "text-teal-300 light:text-teal-600", run: () => onTool("image"), live: isLive("image") },
    { label: "Generate Video", d: ICONS.video, hue: "text-rose-300 light:text-rose-600", run: () => onTool("video"), live: isLive("video") },
    { label: "Analyze File", d: ICONS.file, hue: "text-sky-300 light:text-sky-600", run: onAttach, live: true },
  ];
  // Everything else Flash makes, under More.
  const more: { label: string; d: string; run: () => void; live: boolean }[] = [
    { label: "Build an App", d: ICONS.app, run: () => onTool("app"), live: isLive("app") },
    { label: "Make Slides", d: ICONS.template, run: () => onTool("slides"), live: isLive("slides") },
    { label: "Write Code", d: ICONS.code, run: () => onTool("code"), live: isLive("code") },
    { label: "Docs & Sheets", d: ICONS.file, run: () => onTool("docs"), live: isLive("docs") },
    { label: "Make Music", d: ICONS.voice, run: () => onTool("music"), live: isLive("music") },
    { label: "Voice-over", d: ICONS.voice, run: () => onTool("voice"), live: isLive("voice") },
    { label: "Transcribe", d: ICONS.file, run: () => onTool("transcribe"), live: isLive("transcribe") },
    { label: "Translate", d: ICONS.globe, run: () => onTool("translate"), live: isLive("translate") },
    { label: "Start from a template", d: ICONS.template, run: onTemplates, live: true },
  ];

  const tools: { title: string; about: string; d: string; hue: Hue; run: () => void; live: boolean }[] = [
    { title: "AI Chat", about: "Get instant answers and deep insights", d: ICONS.chat, hue: "blue", run: () => onTool("auto"), live: true },
    { title: "Voice", about: "Talk, transcribe and create with voice", d: ICONS.voice, hue: "teal", run: onTalk, live: true },
    { title: "Image", about: "Generate and edit stunning visuals", d: ICONS.image, hue: "orange", run: () => onTool("image"), live: isLive("image") },
    { title: "Code", about: "Build, debug and ship faster", d: ICONS.code, hue: "violet", run: () => onTool("code"), live: isLive("code") },
    { title: "Research", about: "Deep research and credible sources", d: ICONS.search, hue: "pink", run: () => onTool("search"), live: isLive("search") },
  ];

  // Each with a key that opens it on Home, pressed on its own while not typing (see the effect below).
  const quick: { label: string; key: string; d: string; run: () => void; live: boolean }[] = [
    { label: "New Chat", key: "N", d: ICONS.chat, run: () => onTool("auto"), live: true },
    { label: "Talk with Flash", key: "V", d: ICONS.voice, run: onTalk, live: true },
    { label: "Generate Image", key: "I", d: ICONS.image, run: () => onTool("image"), live: isLive("image") },
    { label: "Create Document", key: "D", d: ICONS.file, run: () => onTool("docs"), live: isLive("docs") },
    { label: "Build an App", key: "B", d: ICONS.app, run: () => onTool("app"), live: isLive("app") },
    { label: "Start from a Template", key: "T", d: ICONS.template, run: onTemplates, live: true },
  ];
  // The keys can be turned off in Settings > General > Keyboard.
  const keysOff = useSyncExternalStore(onSettingChange, () => readSetting("homeKeysOff") === "1", () => false);
  const pressed = useEffectEvent((e: KeyboardEvent) => {
    if (!shortcuts || keysOff) return;
    const tool = quick.find((q) => q.live && q.key === e.key.toUpperCase());
    if (!tool) return;
    e.preventDefault();
    tool.run();
  });
  // Quick Tools' keys: a letter on its own, never while typing, with a menu or a modal dialog open, or
  // with Ctrl, ⌘ or Alt held, so the browser's own shortcuts and typing in the message box are untouched.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.defaultPrevented) return;
      const at = e.target instanceof Element ? e.target : null;
      if (at?.closest("input, textarea, select, [contenteditable]") || document.querySelector('[aria-modal="true"], [role="menu"]')) return;
      pressed(e);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Renamed chats show their new name, and deleted ones go.
  const chats = (recent ?? []).flatMap((c) => {
    const p = projects.find((x) => x.id === c.id);
    return p ? [{ ...c, name: p.name, pinned: Boolean(p.pinned) }] : [];
  });
  // This month's credits by kind of work: words (chats, research, code, apps), pictures and video, sound, and files and docs.
  const kindOf = (engine: string) =>
    ["image", "video"].includes(engine) ? "visual" : ["voice", "music", "transcribe"].includes(engine) ? "audio" : engine === "docs" ? "files" : "words";
  const spent = (kind: string) => (usage?.tools ?? []).filter((t) => kindOf(t.engine) === kind).reduce((sum, t) => sum + t.credits, 0);
  const rows = [
    { label: "AI Messages", d: ICONS.chat, credits: spent("words") },
    { label: "Images & Video", d: ICONS.image, credits: spent("visual") },
    { label: "Voice & Audio", d: ICONS.voice, credits: spent("audio") },
    { label: "Files & Docs", d: ICONS.file, credits: spent("files") },
  ];

  return (
    <div className="mx-auto w-full max-w-[1600px] px-4 pb-10 pt-4 sm:px-6 sm:pt-6 lg:px-8">
      {/* When there's room, the greeting sits in the account button in the top bar instead (see AccountMenu.tsx). */}
      <Greeting me={me} className="mb-5 sm:mb-6 @min-[900px]/main:hidden" />

      {/* Sized by the space beside the sidebar (and the companion, when it's open), not the screen. */}
      <div className="grid gap-5 @min-[1100px]/main:grid-cols-[minmax(0,1fr)_300px] @min-[1180px]/main:grid-cols-[minmax(0,1fr)_320px] @min-[1500px]/main:grid-cols-[minmax(0,1fr)_360px]">
        <div className="@container/left min-w-0 space-y-5">
          {/* Hero: the orb beside the question, and the message box under both, as wide as it can be. */}
          <section className="@container/hero glass-raised relative z-10 rounded-[28px] has-[[role=menu]]:z-40">
            <div className="pointer-events-none absolute inset-0 rounded-[28px] bg-iris-wash" />
            <div className="relative grid items-center gap-x-6 gap-y-5 p-4 sm:p-8 @min-[640px]/hero:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] @min-[640px]/hero:gap-y-6 @min-[640px]/hero:px-9 @min-[640px]/hero:pb-6 @min-[640px]/hero:pt-12">
              <Orb className="mx-auto w-28 sm:w-36 @min-[640px]/hero:row-span-2 @min-[640px]/hero:w-[86%] @min-[640px]/hero:max-w-[260px] @min-[640px]/hero:-translate-y-3" />
              <div className="min-w-0">
                <p className="text-[13px] font-semibold uppercase tracking-[0.34em] text-zinc-300">Flash AI</p>
                {/* Two lines whatever the width: the type scales with the hero, and each phrase stays whole. */}
                <h1 className="mt-3 text-[clamp(32px,9.5cqw,48px)] font-bold leading-[1] tracking-[-0.035em] text-white @min-[640px]/hero:text-[clamp(40px,6.5cqw,66px)]">
                  <span className="whitespace-nowrap">What will you</span> <span className="whitespace-nowrap text-iris">create today?</span>
                </h1>
                <p className="mt-4 text-[15px] text-zinc-400 sm:text-[17px]">Chat, create, generate, analyze, and build — all in one place.</p>
              </div>
              <div className="relative z-10 min-w-0 @min-[640px]/hero:col-start-2 @min-[760px]/hero:-ml-[20%]">
                {composer}
                <div
                  className="mt-3 flex flex-wrap gap-2 @min-[640px]/hero:gap-2.5 @min-[640px]/hero:px-1"
                  aria-label="Quick starts"
                >
                  {chips
                    .filter((c) => c.live)
                    .map((c) => (
                      <button
                        key={c.label}
                        onClick={c.run}
                        className="glass inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-zinc-200 shadow-none transition hover:text-white hover:brightness-110"
                      >
                        <Icon d={c.d} className={`h-4 w-4 ${c.hue}`} />
                        {c.label}
                      </button>
                    ))}
                  <div ref={menu === "more" ? menuRef : undefined} className="relative shrink-0">
                    <button
                      onClick={() => setMenu(menu === "more" ? "" : "more")}
                      aria-expanded={menu === "more"}
                      aria-haspopup="menu"
                      className="glass inline-flex h-[34px] items-center gap-1.5 rounded-full px-3 text-[12.5px] text-zinc-200 shadow-none transition hover:text-white hover:brightness-110"
                    >
                      More <Icon d={ICONS.down} className="h-3.5 w-3.5 text-zinc-400" />
                    </button>
                    {menu === "more" && (
                      <div ref={showWhole} role="menu" aria-label="More tools" className="absolute right-0 top-full z-30 mt-2 w-56 rounded-2xl border border-white/10 bg-zinc-900 p-1.5 shadow-2xl light:shadow-black/10">
                        {more
                          .filter((m) => m.live)
                          .map((m) => (
                            <button
                              key={m.label}
                              role="menuitem"
                              onClick={() => {
                                setMenu("");
                                m.run();
                              }}
                              className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-zinc-200 transition hover:bg-white/[0.06]"
                            >
                              <Icon d={m.d} className="h-[18px] w-[18px] text-zinc-400" />
                              {m.label}
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
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
                  <span className="flex w-full min-w-0 items-center gap-1.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[17px] font-semibold tracking-tight text-white">{t.title}</span>
                      <span className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-zinc-400">{t.about}</span>
                    </span>
                    {/* Only when the cards are wide enough to keep their names whole beside it. */}
                    <Icon d={ICONS.chevron} className="hidden h-4 w-4 shrink-0 text-zinc-500 transition group-hover:translate-x-0.5 group-hover:text-zinc-200 @max-[519px]/left:block @min-[860px]/left:block" />
                  </span>
                </button>
              ))}
          </div>

          <div className="grid gap-5 @min-[700px]/left:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <Card title="Recent Conversations" action={chats.length ? <ViewAll onClick={onViewChats} /> : undefined}>
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

            <Card title="Your Workspace" action={sites?.length ? <ViewAll onClick={onApps} /> : undefined}>
              {!sites ? (
                <p className="py-6 text-center text-sm text-zinc-500">Loading…</p>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {sites.slice(0, 4).map((s, i) => (
                    <div key={s.slug} className="relative min-w-0 has-[[role=menu]]:z-20">
                      <button
                        onClick={onApps}
                        className={`flex h-full w-full min-w-0 flex-col items-start gap-3 rounded-2xl border border-white/[0.08] bg-gradient-to-br p-3.5 text-left transition hover:brightness-110 ${TILES[i % TILES.length]}`}
                      >
                        <Icon d={ICONS.globe} className="h-5 w-5 text-sky-300 light:text-sky-600" />
                        <span className="w-full min-w-0">
                          <span className="block truncate text-sm font-semibold text-zinc-100">{s.title || s.slug}</span>
                          <span className="block truncate text-xs text-zinc-400">
                            {s.unread
                              ? `${s.unread} new ${s.unread === 1 ? "message" : "messages"} · `
                              : s.views
                                ? `${s.views.toLocaleString()} ${s.views === 1 ? "visit" : "visits"} · `
                                : ""}
                            Updated {shortAgo(s.updated_at, now.getTime())}
                          </span>
                        </span>
                      </button>
                      <div ref={menu === `site:${s.slug}` ? menuRef : undefined} className="absolute right-1.5 top-1.5">
                        <button
                          onClick={() => setMenu(menu === `site:${s.slug}` ? "" : `site:${s.slug}`)}
                          aria-label={`More for ${s.title || s.slug}`}
                          aria-expanded={menu === `site:${s.slug}`}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white/[0.08] hover:text-zinc-200"
                        >
                          <Icon d={ICONS.dots} className="h-5 w-5" strokeWidth={2.6} />
                        </button>
                        {menu === `site:${s.slug}` && (
                          <div ref={showWhole} role="menu" className="absolute right-0 top-full z-30 mt-1 w-48 rounded-xl border border-white/10 bg-zinc-900 p-1 shadow-xl">
                            <a
                              role="menuitem"
                              href={`/p/${s.slug}`}
                              target="_blank"
                              rel="noreferrer"
                              onClick={() => setMenu("")}
                              className="block w-full rounded-lg px-3 py-1.5 text-left text-sm text-zinc-200 transition hover:bg-white/[0.06]"
                            >
                              Visit site
                            </a>
                            <button
                              role="menuitem"
                              onClick={() => {
                                setMenu("");
                                onApps();
                              }}
                              className="block w-full rounded-lg px-3 py-1.5 text-left text-sm text-zinc-200 transition hover:bg-white/[0.06]"
                            >
                              Open My websites
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {sites.length < 4 &&
                    [
                      { title: "Build a website", about: "Publish in one click", d: ICONS.globe, run: () => onTool("app"), live: isLive("app") },
                      { title: "Make slides", about: "From one sentence", d: ICONS.template, run: () => onTool("slides"), live: isLive("slides") },
                      { title: "Create an image", about: "Logos, posters and photos", d: ICONS.image, run: () => onTool("image"), live: isLive("image") },
                      { title: "Use a template", about: "Plans, invoices, resumes", d: ICONS.file, run: onTemplates, live: true },
                    ]
                      .filter((t) => t.live)
                      .slice(0, 4 - sites.length)
                      .map((t, i) => (
                        <button
                          key={t.title}
                          onClick={t.run}
                          className={`flex min-w-0 flex-col items-start gap-3 rounded-2xl border border-dashed border-white/15 bg-gradient-to-br p-3.5 text-left transition hover:brightness-110 ${TILES[(sites.length + i) % TILES.length]}`}
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
              {me.credits < 10 ? "You're running low on credits." : "Your AI creativity engine is running strong."}{" "}
              <span className="tabular-nums text-zinc-200">
                {me.credits.toLocaleString()}
                {!overAllowance && ` of ${allowance.toLocaleString()}`} credits left.
              </span>
            </p>
            <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-500">Used this month</p>
            <ul className="space-y-4">
              {rows.map((r, i) => (
                <li key={r.label}>
                  <div className="flex items-center gap-2.5 text-sm">
                    <Icon d={r.d} className={`h-[18px] w-[18px] shrink-0 ${ROW_ICONS[i]}`} />
                    <span className="min-w-0 flex-1 truncate text-zinc-200">{r.label}</span>
                    <span className="shrink-0 tabular-nums text-zinc-400">{usage ? `${r.credits.toLocaleString()} credits` : "…"}</span>
                  </div>
                  <div className="ml-7 mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
                    {r.credits > 0 && (
                      <div className={`h-full rounded-full ${BARS[i]}`} style={{ width: `${Math.min(100, Math.max(3, (r.credits / Math.max(1, allowance)) * 100))}%` }} />
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <button onClick={onUsage} className="mt-4 inline-flex items-center gap-1 text-sm text-primary-soft transition hover:text-white">
              See all usage <Icon d={ICONS.arrow} className="h-3.5 w-3.5" />
            </button>
          </Card>

          {free && paymentsOn && (
            <section className="glass relative overflow-hidden rounded-3xl p-5">
              <div className="pointer-events-none absolute inset-0 bg-iris-wash opacity-90" />
              <div className="relative">
                <h3 className="flex items-center gap-2 text-[17px] font-semibold tracking-tight text-white">
                  <span aria-hidden>🌟</span> Unlock More with Flash Pro
                </h3>
                <p className="mt-1.5 text-sm text-zinc-300">3,000 credits a month for apps, slides, research and more. Unused credits carry over.</p>
                <button onClick={onPlans} className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-semibold text-on-brand transition hover:brightness-110">
                  Upgrade Now <Icon d={ICONS.arrow} className="h-4 w-4" />
                </button>
              </div>
            </section>
          )}

          <Card title="Quick Tools" action={<Icon d={ICONS.sliders} className="h-5 w-5 text-zinc-500" />}>
            {!keysOff && <p className="-mt-1 mb-2 hidden text-xs text-zinc-500 pointer-fine:block">Press a key on Home to open a tool.</p>}
            <ul className="-mx-1">
              {quick
                .filter((q) => q.live)
                .map((q) => (
                  <li key={q.label}>
                    <button
                      onClick={q.run}
                      aria-keyshortcuts={keysOff ? undefined : q.key}
                      className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left text-[15px] text-zinc-200 transition hover:bg-white/[0.05] hover:text-white"
                    >
                      <Icon d={q.d} className="h-5 w-5 text-zinc-400" />
                      <span className="flex-1">{q.label}</span>
                      {/* The key on computers; a phone has none, so it gets the arrow. */}
                      {keysOff ? (
                        <Icon d={ICONS.chevron} className="h-4 w-4 text-zinc-600" />
                      ) : (
                        <>
                          <kbd className="hidden h-6 min-w-6 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] px-1.5 font-sans text-[11.5px] text-zinc-400 pointer-fine:inline-flex">
                            {q.key}
                          </kbd>
                          <Icon d={ICONS.chevron} className="h-4 w-4 text-zinc-600 pointer-fine:hidden" />
                        </>
                      )}
                    </button>
                  </li>
                ))}
            </ul>
          </Card>
        </aside>
      </div>

      <div className="mt-5">
        <Everything me={me} isLive={isLive} level={level} onLevel={onLevel} onFeature={onFeature} installable={installable} />
      </div>
    </div>
  );
}
