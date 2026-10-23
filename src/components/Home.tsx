"use client";

import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { BrandMark, Sparkle } from "@/app/brand";
import { api, type Me, type ProjectSummary } from "@/lib/store";
import { ENGINE_LABELS, type Engine } from "@/lib/types";
import { firstName } from "@/lib/names";
import { dateLine, greeting, shortAgo, timeAgo } from "@/lib/when";
import type { RecentChat } from "@/lib/server/recent";
import type { FeatureAction } from "@/lib/features";
import type { Level, ModelPick } from "@/lib/levels";
import type { Choice } from "./ComposerTools";
import { onSettingChange, readSetting } from "@/lib/device-settings";
import { afterSentence, msg } from "@/lib/i18n";
import { runningLow } from "@/lib/bell";
import { useT } from "@/lib/use-t";
import { EngineIcon } from "./EngineIcon";
import { Everything } from "./Everything";
import { Showcase } from "./Showcase";
import { RollingShowcase } from "./RollingShowcase";
import { StackSection } from "./StackSection";
import { GrowCards } from "./GrowCards";

// views and messages are null for apps past the 20 the list counts (see sitesWithMessages); the home
// screen shows only the first 4.
type Site = { slug: string; title: string; updated_at: number; views: number | null; messages: number | null; unread: number };

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
  columns: "M3.5 5h17v14h-17z M12 5v14",
  clock: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 7.5V12l3 2",
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

// The pastel washes on the My apps cards.
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
export function Orb({ className = "", id = "flash-orb" }: { className?: string; id?: string }) {
  return (
    <div className={`relative ${className}`} aria-hidden>
      <div className="flash-orb w-full">
        <div className="absolute inset-0 flex items-center justify-center [filter:drop-shadow(0_0_22px_rgb(94_234_212/0.45))] light:[filter:drop-shadow(0_0_18px_rgb(91_140_246/0.45))]">
          <span className="block w-[70%] [&>svg]:h-auto [&>svg]:w-full">
            <BrandMark size={256} id={id} />
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
  const t = useT();
  const now = new Date();
  const name = firstName(me.user);
  const hello = t(greeting(now));
  return (
    <div className={`min-w-0 ${className}`}>
      <h2 className="truncate text-[26px] font-semibold tracking-[-0.02em] text-white sm:text-[30px]">
        {/* firstName gives "there" when there's no name to use: a whole phrase, so it reads naturally in each language. */}
        {name === "there" ? t("{greeting}, there", { greeting: hello }) : t("{greeting}, {name}", { greeting: hello, name })}
      </h2>
      {/* On a phone the greeting stands alone, so the message box comes up sooner. */}
      <p className="mt-1 truncate text-[15px] text-zinc-400 max-sm:hidden">{dateLine(now, t.locale, t("Your workspace is ready"))}</p>
    </div>
  );
}

// A menu that opens near the bottom of the page scrolls just enough to show all of it.
function showWhole(menu: HTMLDivElement | null) {
  menu?.scrollIntoView({ block: "nearest" });
}

function ViewAll({ onClick, label }: { onClick: () => void; label?: string }) {
  const t = useT();
  return (
    <button onClick={onClick} className="inline-flex shrink-0 items-center gap-1 text-sm text-primary-soft transition hover:text-white">
      {label ?? t("View all")} <Icon d={ICONS.arrow} className="h-3.5 w-3.5" />
    </button>
  );
}

/**
 * Home, laid out like the simplest app builders: the greeting, one question with the message box
 * and what to make under it, then the user's apps, recent chats, their plan in one line, everything
 * Flash can do and the showcase. The quick tools' keys still open a tool from anywhere on it.
 * Everything on it is something Flash does today.
 */
export function Home({
  me,
  composer,
  isLive,
  projects,
  onTool,
  onIdea,
  onAttach,
  onTalk,
  onOpenChat,
  onViewChats,
  onPin,
  onRename,
  onDelete,
  onApps,
  onApp,
  onTemplates,
  onGuide,
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
  // Picks a tool and starts the sentence in the message box, for the person to finish.
  onIdea: (choice: Choice, text: string) => void;
  onAttach: () => void;
  onTalk: () => void;
  onOpenChat: (id: string) => void;
  onViewChats: () => void;
  onPin: (id: string) => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => Promise<void> | void;
  onApps: () => void;
  // Opens one app's dashboard.
  onApp: (slug: string) => void;
  onTemplates: () => void;
  // Opens Help me ask (see guide.ts).
  onGuide: () => void;
  onUsage: () => void;
  onPlans: () => void;
  // Opens a feature from "Everything Flash can do".
  onFeature: (action: FeatureAction) => void;
  level: ModelPick;
  onLevel: (level: Level) => void;
  installable: boolean;
  // Off during a voice conversation, so a key pressed then doesn't end it.
  shortcuts: boolean;
  paymentsOn: boolean;
}) {
  const t = useT();
  const [recent, setRecent] = useState<RecentChat[] | null>(null);
  const [sites, setSites] = useState<Site[] | null>(null);
  const [menu, setMenu] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ chats: RecentChat[] }>("/api/projects/recent")
      .then(({ chats }) => setRecent(chats))
      .catch(() => setRecent([]));
    api<{ sites: Site[] }>("/api/sites")
      .then(({ sites }) => setSites(sites))
      .catch(() => setSites([]));
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
  const planLabel = me.plan ? t("{plan} plan", { plan: me.plan.name }) : inTeam ? t("Team plan") : t("Free plan");
  // Packs, rewards, rollover and team credits can take the balance past the monthly amount.
  const overAllowance = me.credits > allowance;
  // Below the person's low-credit level (see low-balance.ts), what the bell and the email say.
  const lowLine = runningLow(me)
    ? [
        t("Your Flash credits are running low."),
        t("Your apps and websites keep running, but they only get new updates while you have credits. Top up to keep them updating."),
      ]
    : [t("Your AI creativity engine is running strong.")];

  // What to make, under the message box: each starts the sentence in it, with the right tool. The rest is under More.
  const chips: { label: string; d: string; hue: string; run: () => void; live: boolean }[] = [
    { label: msg("App"), d: ICONS.app, hue: "text-violet-300 light:text-violet-600", run: () => onIdea("app", t("I want an app that ")), live: isLive("app") },
    { label: msg("Website"), d: ICONS.globe, hue: "text-sky-300 light:text-sky-600", run: () => onIdea("app", t("I want a website for my ")), live: isLive("app") },
    { label: msg("Dashboard"), d: ICONS.chart, hue: "text-teal-300 light:text-teal-600", run: () => onIdea("app", t("I want a dashboard that shows ")), live: isLive("app") },
    { label: msg("Online store"), d: ICONS.card, hue: "text-rose-300 light:text-rose-600", run: () => onIdea("app", t("I want an online store that sells ")), live: isLive("app") },
    { label: msg("Picture"), d: ICONS.image, hue: "text-amber-300 light:text-amber-600", run: () => onIdea("image", t("A picture of ")), live: isLive("image") },
    { label: msg("Video"), d: ICONS.video, hue: "text-fuchsia-300 light:text-fuchsia-600", run: () => onTool("video"), live: isLive("video") },
  ];
  const more: { label: string; d: string; run: () => void; live: boolean }[] = [
    { label: msg("Chat"), d: ICONS.chat, run: () => onTool("auto"), live: true },
    { label: msg("Deep Research"), d: ICONS.search, run: () => onTool("search"), live: isLive("search") },
    { label: msg("Talk with Flash"), d: ICONS.voice, run: onTalk, live: true },
    { label: msg("Analyze File"), d: ICONS.file, run: onAttach, live: true },
    { label: msg("Make Slides"), d: ICONS.template, run: () => onTool("slides"), live: isLive("slides") },
    { label: msg("Write Code"), d: ICONS.code, run: () => onTool("code"), live: isLive("code") },
    { label: msg("Docs & Sheets"), d: ICONS.file, run: () => onTool("docs"), live: isLive("docs") },
    { label: msg("Make Music"), d: ICONS.music, run: () => onTool("music"), live: isLive("music") },
    { label: msg("Voice-over"), d: ICONS.voice, run: () => onTool("voice"), live: isLive("voice") },
    { label: msg("Transcribe"), d: ICONS.file, run: () => onTool("transcribe"), live: isLive("transcribe") },
    { label: msg("Translate"), d: ICONS.globe, run: () => onTool("translate"), live: isLive("translate") },
    { label: msg("Start from a template"), d: ICONS.template, run: onTemplates, live: true },
  ];

  // A key for each, pressed on its own on Home while not typing (see the effect below).
  const quick: { label: string; key: string; d: string; run: () => void; live: boolean }[] = [
    { label: msg("New Chat"), key: "N", d: ICONS.chat, run: () => onTool("auto"), live: true },
    { label: msg("Talk with Flash"), key: "V", d: ICONS.voice, run: onTalk, live: true },
    { label: msg("Generate Image"), key: "I", d: ICONS.image, run: () => onTool("image"), live: isLive("image") },
    { label: msg("Create Document"), key: "D", d: ICONS.file, run: () => onTool("docs"), live: isLive("docs") },
    { label: msg("Build an App"), key: "B", d: ICONS.app, run: () => onTool("app"), live: isLive("app") },
    { label: msg("Start from a Template"), key: "T", d: ICONS.template, run: onTemplates, live: true },
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
  // Under a site's name: new form messages or visits, then when it last changed, as one phrase.
  const siteLine = (s: Site) => {
    const ago = shortAgo(s.updated_at, now.getTime(), t.locale);
    if (s.unread) return s.unread === 1 ? t("1 new message · Updated {ago}", { ago }) : t("{count} new messages · Updated {ago}", { count: s.unread.toLocaleString(t.locale), ago });
    if (s.views) return s.views === 1 ? t("1 visit · Updated {ago}", { ago }) : t("{count} visits · Updated {ago}", { count: s.views.toLocaleString(t.locale), ago });
    return t("Updated {ago}", { ago });
  };

  // Apps a team uses, each a ready request: tapping one puts it in the box, to send or change first.
  // Only what Flash builds well today: a team signs in, and the server keeps each person to their part.
  const teamApps = [
    { label: msg("CRM"), prompt: msg("Build a CRM for my 12-person sales team that tracks contacts, companies, deals and follow-ups. Each rep sees their own deals; managers see everything.") },
    { label: msg("Inventory tracker"), prompt: msg("Build an inventory tracker for my shop's team: products, stock levels, low-stock warnings, and a log of what came in and went out.") },
    { label: msg("HR portal"), prompt: msg("Build an HR portal for my 20 staff: a team directory, leave requests that managers approve, and company announcements.") },
    { label: msg("Project tracker"), prompt: msg("Build a project tracker for my team with projects, tasks, owners, due dates and a board by status.") },
  ];
  const chip = "glass inline-flex h-10 shrink-0 items-center gap-2 rounded-lg px-3.5 text-[15px] text-zinc-100 shadow-none transition hover:text-white hover:brightness-110";
  const starts = [
    { title: msg("Build a website"), about: msg("Publish in one click"), d: ICONS.globe, run: () => onTool("app"), live: isLive("app") },
    { title: msg("Make slides"), about: msg("From one sentence"), d: ICONS.template, run: () => onTool("slides"), live: isLive("slides") },
    { title: msg("Create an image"), about: msg("Logos, posters and photos"), d: ICONS.image, run: () => onTool("image"), live: isLive("image") },
    { title: msg("Use a template"), about: msg("Plans, invoices, resumes"), d: ICONS.file, run: onTemplates, live: true },
  ].filter((tile) => tile.live);

  return (
    <div className="mx-auto w-full max-w-[1600px] px-4 pb-10 pt-2 sm:px-6 sm:pt-6 lg:px-8">
      {/* One question and one box, as in the simplest app builders; what Flash makes is picked under it. */}
      {/* On a phone the first screen is only this: a soft wash of Flash's colours, one line, and the box at the foot. */}
      <section className="relative z-10 mx-auto max-w-[1200px] pt-4 text-center has-[[role=menu]]:z-40 max-sm:flex max-sm:min-h-[calc(100dvh-4.5rem)] max-sm:flex-col max-sm:pb-4 sm:pt-12">
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-x-4 -top-4 bottom-0 -z-10 [mask-image:linear-gradient(to_bottom,transparent,#000_35%)] sm:hidden"
          style={{
            backgroundImage:
              "radial-gradient(90% 45% at 50% 100%, rgb(139 92 246 / 0.55), transparent 75%), radial-gradient(70% 40% at 0% 88%, rgb(47 217 189 / 0.5), transparent 75%), radial-gradient(70% 40% at 100% 82%, rgb(236 72 153 / 0.45), transparent 75%), radial-gradient(60% 30% at 50% 60%, rgb(56 189 248 / 0.25), transparent 75%)",
          }}
        />
        {/* Flash's mark in its glass orb: one on each side of the headline on a wide screen, one small one above it on a phone. */}
        <Orb className="mx-auto mb-6 hidden w-24 sm:block lg:hidden" id="flash-orb-home" />
        <div className="pointer-events-none absolute start-[2%] top-[46%] hidden w-[clamp(110px,10vw,170px)] lg:block">
          <Orb className="orb-drift" id="flash-orb-home-start" />
        </div>
        <div className="pointer-events-none absolute end-[2%] top-[54%] hidden w-[clamp(110px,10vw,170px)] lg:block">
          <Orb className="orb-drift orb-late" id="flash-orb-home-end" />
        </div>
        <p className="text-[15px] text-zinc-400 max-sm:hidden">
          {(() => {
            const name = firstName(me.user);
            const hello = t(greeting(now));
            return name === "there" ? t("{greeting}, there", { greeting: hello }) : t("{greeting}, {name}", { greeting: hello, name });
          })()}
        </p>
        {/* Big and bold, as wide as the page allows. */}
        <div className="max-sm:flex max-sm:flex-1 max-sm:items-center max-sm:justify-center">
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.03em] text-white sm:mt-3 sm:text-[clamp(38px,7.4vw,96px)] sm:font-bold sm:leading-[0.98] sm:tracking-[-0.045em]">
            {t.node("What will you {create}", { create: <span className="whitespace-nowrap text-iris">{t("create today?")}</span> })}
          </h1>
        </div>
        <p className="mx-auto mt-5 max-w-2xl text-[16px] text-zinc-300 max-sm:hidden sm:text-[19px]">{t("Chat, create, generate, analyze, and build — all in one place.")}</p>
        <div className="mx-auto mt-7 w-full max-w-[740px] text-start sm:mt-10">{composer}</div>
        {/* For people new to AI: a few taps instead of a blank box (see guide.ts). */}
        <div className="mx-auto mt-3 flex max-w-[740px] flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[15px] text-zinc-400 sm:mt-4">
          <span>{t("Not sure what to type?")}</span>
          <button
            onClick={onGuide}
            className="inline-flex items-center gap-1.5 rounded-full border border-violet-300/30 bg-violet-400/10 px-3.5 py-1.5 font-medium text-violet-100 transition hover:border-violet-300/60 hover:bg-violet-400/20 light:text-violet-700"
          >
            <Icon d={ICONS.wand} className="h-4 w-4" />
            {t("Help me ask")}
          </button>
        </div>
        <div className="mx-auto mt-6 flex max-w-[900px] flex-wrap justify-center gap-2.5 max-sm:hidden" aria-label={t("Quick starts")}>
          {chips
            .filter((c) => c.live)
            .map((c) => (
              <button key={c.label} onClick={c.run} className={chip}>
                <Icon d={c.d} className={`h-4 w-4 ${c.hue}`} />
                {t(c.label)}
              </button>
            ))}
          <div ref={menu === "more" ? menuRef : undefined} className="relative shrink-0">
            <button onClick={() => setMenu(menu === "more" ? "" : "more")} aria-expanded={menu === "more"} aria-haspopup="menu" className={chip}>
              {t("More")} <Icon d={ICONS.down} className="h-3.5 w-3.5 text-zinc-400" />
            </button>
            {menu === "more" && (
              <div ref={showWhole} role="menu" aria-label={t("More tools")} className="absolute right-0 top-full z-30 mt-2 w-56 rounded-2xl border border-white/10 bg-zinc-900 p-1.5 text-start shadow-2xl light:shadow-black/10">
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
                      {t(m.label)}
                    </button>
                  ))}
              </div>
            )}
          </div>
        </div>
        {isLive("app") && (
          <div className="mx-auto mt-4 flex max-w-[900px] items-center gap-2 overflow-x-auto px-1 pb-1 max-sm:-mx-4 max-sm:px-4 sm:flex-wrap sm:justify-center" aria-label={t("Try it")}>
            <span className="inline-flex shrink-0 items-center gap-1.5 text-sm text-zinc-400">
              {t("Try it")} <Icon d="M5 12h14 M13 6l6 6-6 6" className="h-4 w-4 rtl:-scale-x-100" />
            </span>
            {teamApps.map((app) => (
              <button
                key={app.label}
                onClick={() => onIdea("app", t(app.prompt))}
                className="shrink-0 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-sm text-zinc-200 transition hover:border-primary/50 hover:text-white"
              >
                {t(app.label)}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* What Flash builds, rolling by under the box. */}
      <RollingShowcase className="-mx-4 mt-10 sm:-mx-6 sm:mt-14 lg:-mx-8" />

      <StackSection className="mt-14 !px-0 sm:mt-20" />

      <GrowCards className="mt-14 !px-0 sm:mt-20" onOpen={(card) => (card === "social" ? onFeature({ open: "template:social-pack" }) : onApps())} />

      <div className="mx-auto mt-10 max-w-[1100px] space-y-8 sm:mt-14">
        {/* Your apps, as cards; with fewer than four, ways to start one fill the row. */}
        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-[17px] font-semibold tracking-tight text-white">{t("My apps")}</h2>
            {sites && sites.length > 0 && <ViewAll onClick={onApps} label={t("See all")} />}
          </div>
          {!sites ? (
            <p className="py-6 text-center text-sm text-zinc-500">{t("Loading…")}</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {sites.slice(0, 4).map((s, i) => (
                <div key={s.slug} className="relative min-w-0 has-[[role=menu]]:z-20">
                  <button onClick={() => onApp(s.slug)} className="glass flex h-full w-full min-w-0 flex-col overflow-hidden rounded-2xl text-left transition hover:brightness-110">
                    <span className={`flex h-20 w-full items-center justify-center bg-gradient-to-br sm:h-24 ${TILES[i % TILES.length]}`}>
                      <Icon d={ICONS.globe} className="h-6 w-6 text-sky-300 light:text-sky-600" />
                    </span>
                    <span className="w-full min-w-0 px-3 py-2.5">
                      <span className="block truncate text-sm font-semibold text-zinc-100">{s.title || s.slug}</span>
                      <span className="block truncate text-xs text-zinc-400">{siteLine(s)}</span>
                    </span>
                  </button>
                  <div ref={menu === `site:${s.slug}` ? menuRef : undefined} className="absolute right-1.5 top-1.5">
                    <button
                      onClick={() => setMenu(menu === `site:${s.slug}` ? "" : `site:${s.slug}`)}
                      aria-label={t("More for {name}", { name: s.title || s.slug })}
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
                          {t("Visit site")}
                        </a>
                        <button
                          role="menuitem"
                          onClick={() => {
                            setMenu("");
                            onApp(s.slug);
                          }}
                          className="block w-full rounded-lg px-3 py-1.5 text-left text-sm text-zinc-200 transition hover:bg-white/[0.06]"
                        >
                          {t("Dashboard")}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {sites.length < 4 &&
                starts.slice(0, 4 - sites.length).map((tile, i) => (
                  <button
                    key={tile.title}
                    onClick={tile.run}
                    className={`flex min-w-0 flex-col items-start gap-3 rounded-2xl border border-dashed border-white/15 bg-gradient-to-br p-3.5 text-left transition hover:brightness-110 ${TILES[(sites.length + i) % TILES.length]}`}
                  >
                    <Icon d={tile.d} className="h-5 w-5 text-violet-300 light:text-violet-600" />
                    <span className="w-full min-w-0">
                      <span className="block truncate text-sm font-semibold text-zinc-100">{t(tile.title)}</span>
                      <span className="block truncate text-xs text-zinc-400">{t(tile.about)}</span>
                    </span>
                  </button>
                ))}
            </div>
          )}
        </section>

        {/* Recent chats: on a phone only once there is one. */}
        <section className={recent && !chats.length ? "max-sm:hidden" : ""}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-[17px] font-semibold tracking-tight text-white">{t("Recent chats")}</h2>
            {chats.length > 0 && <ViewAll onClick={onViewChats} label={t("See all")} />}
          </div>
          <div className="glass relative rounded-2xl px-3 py-1 has-[[role=menu]]:z-20">
            {!recent ? (
              <p className="py-6 text-center text-sm text-zinc-500">{t("Loading…")}</p>
            ) : !chats.length ? (
              <p className="py-6 text-center text-sm text-zinc-400">{t("Your chats will show here. Ask Flash anything above to start one.")}</p>
            ) : (
              <ul className="divide-y divide-white/[0.06]">
                {chats.slice(0, 5).map((c) => (
                  <li key={c.id} className="relative flex items-center gap-1">
                    <button onClick={() => onOpenChat(c.id)} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-1 py-2.5 text-left transition hover:bg-white/[0.04]">
                      {c.engine && c.engine in ENGINE_LABELS ? <EngineIcon engine={c.engine as Engine} /> : <Tile d={ICONS.chat} hue="blue" size="sm" />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-medium text-zinc-100">{c.name === "New project" ? t("New project") : c.name}</span>
                        {c.preview && <span className="block truncate text-[13px] text-zinc-500">{c.preview}</span>}
                      </span>
                      <span className="hidden shrink-0 text-xs text-zinc-400 sm:block">{timeAgo(c.updatedAt, now.getTime(), t.locale)}</span>
                    </button>
                    <div ref={menu === c.id ? menuRef : undefined} className="relative">
                      <button
                        onClick={() => setMenu(menu === c.id ? "" : c.id)}
                        aria-label={t("More for {name}", { name: c.name })}
                        aria-expanded={menu === c.id}
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
                      >
                        <Icon d={ICONS.dots} className="h-5 w-5" strokeWidth={2.6} />
                      </button>
                      {menu === c.id && (
                        <div ref={showWhole} role="menu" className="absolute right-0 top-full z-30 mt-1 w-40 rounded-xl border border-white/10 bg-zinc-900 p-1 shadow-xl">
                          {[
                            [c.pinned ? msg("Unpin") : msg("Pin to the top"), () => onPin(c.id)],
                            [msg("Rename"), () => onRename(c.id)],
                            [msg("Delete"), () => onDelete(c.id)],
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
                              {t(label as string)}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* The plan in one line: what's left, where the usage is, and the upgrade when there's one to buy. */}
        <section className="glass flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl px-4 py-3.5" aria-label={t("Usage & Plan")}>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-gold/15 px-2.5 py-1 text-xs font-medium text-gold-soft light:bg-amber-50">
            <span aria-hidden>👑</span> {planLabel}
          </span>
          <p className="min-w-0 flex-[1_1_14rem] text-sm text-zinc-400">
            {lowLine.length > 1 && lowLine.map((sentence) => sentence + afterSentence(sentence)).join("")}
            <span className="tabular-nums text-zinc-200">
              {overAllowance
                ? t("{count} credits left.", { count: me.credits.toLocaleString(t.locale) })
                : t("{count} of {total} credits left.", { count: me.credits.toLocaleString(t.locale), total: allowance.toLocaleString(t.locale) })}
            </span>
          </p>
          <div className="flex shrink-0 items-center gap-3">
            <button onClick={onUsage} className="text-sm text-primary-soft transition hover:text-white">
              {t("See all usage")}
            </button>
            {free && paymentsOn && (
              <button onClick={onPlans} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-brand px-4 text-sm font-semibold text-on-brand transition hover:brightness-110">
                {t("Upgrade Now")}
              </button>
            )}
          </div>
        </section>

        <Everything me={me} isLive={isLive} level={level} onLevel={onLevel} onFeature={onFeature} installable={installable} />
      </div>

      {/* What people made with Flash, as on the landing page; its button starts an app. */}
      <Showcase embedded onStart={() => onTool("app")} />
    </div>
  );
}
