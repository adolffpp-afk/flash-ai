"use client";

import { useEffect, useState, type ReactNode } from "react";
import { SHOWCASE_EXAMPLES, type ShowcaseList } from "@/lib/showcase";
import { useT } from "@/lib/use-t";
import { ShowcaseMockup } from "./ShowcaseMockups";

/*
 * The rolling strip under Home's message box and the landing page's: apps people made with Flash and
 * shared (approved, see server/showcase.ts) first, then examples of what Flash builds, each one a
 * screenshot drawn on the page and marked "Example". It slides on its own, stops while pointed at,
 * and stays still for people who ask for less motion (see .flash-roll in globals.css).
 */

// Small apps Flash builds from one sentence, drawn like the showcase's screenshots: light, like a live page.
function Converter() {
  return (
    <div className="flex h-full flex-col gap-1.5 rounded-xl bg-[#efe9df] p-3 text-[#1c1917]">
      <div className="rounded-lg bg-[#ffffff] px-3 py-2">
        <div className="text-[9px] text-[#78716c]">Amount</div>
        <div className="text-[15px] font-semibold">100 CAD</div>
      </div>
      <div className="mx-auto -my-3 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-[#d6cfc4] text-[11px]">⇅</div>
      <div className="rounded-lg bg-[#ffffff] px-3 py-2">
        <div className="text-[9px] text-[#78716c]">Converted to</div>
        <div className="text-[15px] font-semibold">68.20 EUR</div>
      </div>
      <div className="flex justify-between px-1 text-[9px] text-[#57534e]">
        <span>Rate today</span>
        <span>1 CAD = 0.682 EUR</span>
      </div>
      <div className="mt-auto rounded-md bg-[#292524] py-1.5 text-center text-[10px] font-medium text-[#ffffff]">Convert</div>
    </div>
  );
}

function Weather() {
  return (
    <div className="grid h-full grid-cols-[1fr_110px] gap-2 rounded-xl bg-[#dbeafe] p-2.5 text-[#0f172a]">
      <div className="relative overflow-hidden rounded-lg bg-[radial-gradient(circle,#93c5fd_1.2px,transparent_1.4px)] [background-size:7px_7px]">
        {[
          ["30%", "35%"],
          ["48%", "52%"],
          ["62%", "30%"],
          ["40%", "70%"],
        ].map(([left, top]) => (
          <i key={left + top} className="absolute h-2 w-2 rounded-full bg-[#1d4ed8]" style={{ left, top }} />
        ))}
        <span className="absolute bottom-2 left-2 rounded bg-[#1e293b] px-1.5 py-0.5 text-[8px] text-[#ffffff]">Toronto · 14°C, clear</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="rounded-lg bg-[#3b82f6] p-2 text-[#ffffff]">
          <div className="text-[11px] font-semibold leading-tight">Weather Explorer</div>
          <div className="text-[8px] opacity-80">Live conditions</div>
        </div>
        <div className="flex-1 space-y-1.5 rounded-lg bg-[#ffffff] p-2 text-[8px]">
          {[
            ["Humidity", 62],
            ["Wind", 35],
            ["Temperature", 55],
          ].map(([k, v]) => (
            <div key={k}>
              <div className="text-[#475569]">{k}</div>
              <div className="mt-0.5 h-1 rounded-full bg-[#e2e8f0]">
                <div className="h-full rounded-full bg-[#3b82f6]" style={{ width: `${v}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Habits() {
  const days = ["M", "T", "W", "T", "F", "S", "S"];
  const rows: [string, number[]][] = [
    ["Drink water", [1, 1, 1, 0, 1, 1, 0]],
    ["Read 20 min", [1, 0, 1, 1, 1, 0, 0]],
    ["Walk", [0, 1, 1, 1, 0, 1, 0]],
  ];
  return (
    <div className="flex h-full flex-col rounded-xl bg-[#ecfdf5] p-3 text-[#064e3b]">
      <div className="text-[13px] font-semibold">My habits</div>
      <div className="text-[9px] text-[#047857]">This week · 12 of 21 done</div>
      <div className="mt-2 space-y-1.5">
        {rows.map(([name, done]) => (
          <div key={name} className="flex items-center gap-2 rounded-md bg-[#ffffff] px-2 py-1.5 text-[9px]">
            <span className="w-16 truncate font-medium">{name}</span>
            <span className="ms-auto flex gap-1">
              {done.map((d, i) => (
                <i key={i} className={`flex h-3.5 w-3.5 items-center justify-center rounded text-[6px] not-italic ${d ? "bg-[#10b981] text-[#ffffff]" : "bg-[#d1fae5] text-[#047857]"}`}>
                  {days[i]}
                </i>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Beats() {
  return (
    <div className="grid h-full grid-cols-[1fr_120px] gap-2 rounded-xl bg-[#18181b] p-2.5 text-[#ffffff]">
      <div className="flex flex-col">
        <div className="text-[13px] font-bold leading-tight">Make your own beat</div>
        <div className="mt-auto grid grid-cols-8 gap-1">
          {Array.from({ length: 32 }, (_, i) => (
            <i key={i} className={`aspect-square rounded-full ${[0, 3, 5, 8, 10, 13, 16, 19, 21, 24, 27, 30].includes(i) ? "bg-[#f97316]" : "bg-[#3f3f46]"}`} />
          ))}
        </div>
      </div>
      <div className="flex flex-col rounded-lg bg-[#ffffff] p-2 text-[#18181b]">
        <div className="text-[8px] text-[#71717a]">Loop · 8 bars · 96 BPM</div>
        <div className="mt-1.5 grid flex-1 grid-cols-2 place-items-center gap-1">
          {["Bass", "Drums", "Keys", "Air"].map((k) => (
            <span key={k} className="flex flex-col items-center gap-0.5 text-[7px]">
              <i className="h-6 w-6 rounded-full bg-[#18181b]" />
              {k}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// A little browser game: a friendly character, the player's stars and score, and Play now.
function Game() {
  return (
    <div className="grid h-full grid-cols-[34px_1fr] overflow-hidden rounded-xl bg-[linear-gradient(135deg,#9db4f5,#b9a8f2_55%,#cbb8f7)] text-[#ffffff]">
      <div className="flex flex-col gap-1.5 bg-[#ffffff]/15 px-1.5 py-2">
        <div className="mb-1 flex h-5 w-5 items-center justify-center rounded-md bg-[#ffffff] text-[10px] font-bold text-[#4f46e5]">B</div>
        {[70, 55, 80, 50, 65].map((w) => (
          <i key={w} className="h-1 rounded-full bg-[#ffffff]/45" style={{ width: `${w}%` }} />
        ))}
      </div>
      <div className="flex flex-col p-2.5">
        <div className="flex items-center justify-between gap-2 text-[8px]">
          <span className="opacity-90">Welcome back, Sam!</span>
          <span className="flex items-center gap-1">
            <i className="relative h-1.5 w-14 overflow-hidden rounded-full bg-[#ffffff]/35">
              <i className="absolute inset-y-0 left-0 w-[70%] rounded-full bg-[#d9f99d]" />
            </i>
            7/10
          </span>
        </div>
        <div className="mt-1 grid flex-1 grid-cols-[18px_1fr_92px] items-center gap-2">
          <div className="flex flex-col items-center gap-1 rounded-lg bg-[#ffffff]/20 py-1.5">
            {["#34d399", "#93c5fd", "#d9f99d", "#fca5a5", "#c4b5fd"].map((c) => (
              <i key={c} className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />
            ))}
          </div>
          {/* The game's hero, drawn soft and round. */}
          <svg viewBox="0 0 80 100" className="mx-auto h-[128px] drop-shadow-[0_10px_14px_rgb(79_70_229/0.35)]">
            <defs>
              <linearGradient id="game-hero" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#f1f3ff" />
                <stop offset="1" stopColor="#c7cdf5" />
              </linearGradient>
            </defs>
            <ellipse cx="40" cy="96" rx="22" ry="3" fill="#6d5bd0" opacity="0.25" />
            <rect x="29" y="72" width="8" height="22" rx="4" fill="url(#game-hero)" />
            <rect x="43" y="72" width="8" height="22" rx="4" fill="url(#game-hero)" />
            <rect x="18" y="50" width="7" height="22" rx="3.5" fill="url(#game-hero)" />
            <rect x="55" y="50" width="7" height="22" rx="3.5" fill="url(#game-hero)" />
            <rect x="24" y="46" width="32" height="32" rx="12" fill="url(#game-hero)" />
            <rect x="12" y="6" width="56" height="44" rx="18" fill="url(#game-hero)" />
            <circle cx="28" cy="29" r="2.2" fill="#1e1b4b" />
            <circle cx="52" cy="29" r="2.2" fill="#1e1b4b" />
            <path d="M36 33h8" stroke="#1e1b4b" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <div className="flex flex-col gap-1.5">
            <div className="text-[10px] tracking-[0.15em] text-[#ecfccb]">
              ★★★<span className="text-[#ffffff]/45">★★</span>
            </div>
            <div className="rounded-lg bg-[#ffffff]/25 px-2 py-1">
              <div className="text-[15px] font-semibold leading-none">163</div>
              <i className="mt-1 block h-1 rounded-full bg-[#ffffff]/35">
                <i className="block h-full w-[85%] rounded-full bg-[#d9f99d]" />
              </i>
            </div>
            <div className="rounded-lg bg-[#ffffff]/25 px-2 py-1">
              <div className="text-[15px] font-semibold leading-none">12</div>
              <i className="mt-1 block h-1 rounded-full bg-[#ffffff]/35">
                <i className="block h-full w-[30%] rounded-full bg-[#fda4af]" />
              </i>
            </div>
            <div className="rounded-md bg-[#4f63d6] py-1.5 text-center text-[9px] font-medium">Play now</div>
          </div>
        </div>
      </div>
    </div>
  );
}

const EXTRA: { title: string; kind: string; width: string; draw: () => ReactNode }[] = [
  { title: "Bloop's adventure", kind: "Game", width: "w-[360px]", draw: Game },
  { title: "Currency converter", kind: "Tool", width: "w-[200px]", draw: Converter },
  { title: "Weather Explorer", kind: "Web app", width: "w-[360px]", draw: Weather },
  { title: "Habit tracker", kind: "Mobile app", width: "w-[240px]", draw: Habits },
  { title: "Beat maker", kind: "Web app", width: "w-[330px]", draw: Beats },
];

// The showcase's examples Flash builds today (not its coming-soon ones), each as wide as its screenshot needs.
const EXAMPLE_WIDTH: Record<string, string> = { booking: "w-[330px]", shop: "w-[330px]", phone: "w-[200px]", dashboard: "w-[330px]" };

function Tile({ width, label, children }: { width: string; label: ReactNode; children: ReactNode }) {
  return (
    <li className={`relative h-[208px] shrink-0 ${width}`}>
      {children}
      <span className="pointer-events-none absolute bottom-2 start-2 max-w-[90%] truncate rounded-md bg-[#0d1124]/75 px-2 py-0.5 text-[10px] text-[#ffffff] backdrop-blur-sm">{label}</span>
    </li>
  );
}

export function RollingShowcase({ className = "" }: { className?: string }) {
  const t = useT();
  const [sites, setSites] = useState<ShowcaseList["sites"]>([]);
  useEffect(() => {
    fetch("/api/showcase")
      .then((r) => (r.ok ? r.json() : null))
      .then((l: ShowcaseList | null) => setSites(l?.sites.slice(0, 8) ?? []))
      .catch(() => {});
  }, []);

  const examples = SHOWCASE_EXAMPLES.filter((e) => !e.soon);
  const extraTile = (extra: (typeof EXTRA)[number]) => (
    <Tile key={extra.title} width={extra.width} label={t("Example · {kind}", { kind: extra.kind })}>
      <div aria-hidden className="h-full select-none">
        <extra.draw />
      </div>
    </Tile>
  );
  const tiles: ReactNode[] = [
    ...sites.map((s) => (
      <Tile key={`site-${s.slug}`} width="w-[396px]" label={s.title}>
        <a href={`/p/${s.slug}`} target="_blank" rel="noopener" className="block h-full overflow-hidden rounded-xl border border-white/10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/p/${s.slug}/card`} alt={s.title} loading="lazy" className="h-full w-full object-cover" />
        </a>
      </Tile>
    )),
    ...examples.flatMap((e, i) => {
      const extra = EXTRA[i];
      return [
        <Tile key={e.id} width={EXAMPLE_WIDTH[e.id] ?? "w-[330px]"} label={t("Example · {kind}", { kind: e.kind })}>
          <ShowcaseMockup id={e.id} />
        </Tile>,
        ...(extra ? [extraTile(extra)] : []),
      ];
    }),
    // More drawn examples than showcase ones: the rest follow.
    ...EXTRA.slice(examples.length).map(extraTile),
  ];

  return (
    <section aria-label={t("Made with Flash")} className={`flash-roll-strip relative overflow-hidden ${className}`}>
      {/* The edges fade into the page, so the strip seems to roll in and out. */}
      <div dir="ltr" className="[mask-image:linear-gradient(to_right,transparent,#000_6%,#000_94%,transparent)]">
        <div className="flash-roll flex w-max gap-4 py-2" style={{ ["--roll-time" as string]: `${tiles.length * 7}s` }}>
          <ul className="flex gap-4">{tiles}</ul>
          {/* The same cards again, so the loop never shows a gap; only the first set is read out. */}
          <ul className="flex gap-4" aria-hidden inert>
            {tiles}
          </ul>
        </div>
      </div>
    </section>
  );
}
