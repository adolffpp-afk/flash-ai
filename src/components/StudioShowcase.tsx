"use client";

import { useEffect, useState } from "react";
import { keepIdea } from "@/lib/idea-keep";
import type { StoryLook } from "@/lib/story-studio";

/*
 * The landing page's advert for Infinity AI Studio's Story mode, shown once the Studio is open to
 * everyone (FLASH_STUDIO_OPEN). Visitors pick a look and the example scene redraws in it, play a short
 * example storyboard with its lines, and type a story idea that waits for them while they sign up.
 * Everything here is drawn in the page: no AI runs for a visitor, and the pictures are labelled as an
 * example, not as a film the Studio made.
 */

type Look = Exclude<StoryLook, "auto">;

/** Each look's colours, and what's laid over the scene (bars, blinds, fog, sparkles). */
type Palette = {
  sky: [string, string];
  ground: string;
  light: string;
  skin: [string, string];
  cloth: [string, string];
  hair: string;
  line?: string;
  filter?: string;
  over?: "bars" | "blinds" | "fog" | "sparkle" | "grain";
};

const LOOKS: { id: Look; label: string; icon: string; p: Palette }[] = [
  { id: "realistic", label: "Realistic", icon: "📷", p: { sky: ["#1c2433", "#46506a"], ground: "#2b2a2e", light: "#ffd9a0", skin: ["#8d5a3b", "#6b4329"], cloth: ["#c2603f", "#3d5a80"], hair: "#1d1512", over: "grain" } },
  { id: "hollywood", label: "Hollywood cinematic", icon: "🎬", p: { sky: ["#062c36", "#0f5964"], ground: "#13262b", light: "#ffae5c", skin: ["#c98552", "#9a5e35"], cloth: ["#e07a2e", "#11443f"], hair: "#21130b", over: "bars" } },
  { id: "fantasy", label: "Epic fantasy", icon: "🐉", p: { sky: ["#1b0f3d", "#5b2a86"], ground: "#24163f", light: "#ffd66b", skin: ["#d9a27a", "#a86f4c"], cloth: ["#b38b2d", "#6b2d8f"], hair: "#f1e3c2", over: "sparkle" } },
  { id: "anime", label: "Anime", icon: "🌸", p: { sky: ["#3a6fd8", "#f59ac0"], ground: "#4a3f78", light: "#fff4b0", skin: ["#ffd9c4", "#f2b9a0"], cloth: ["#ff5f8f", "#3e8ef7"], hair: "#2b2d6e" } },
  { id: "animated", label: "3D animation", icon: "🧸", p: { sky: ["#5aa4ff", "#b8e1ff"], ground: "#5d8f5a", light: "#fff6cf", skin: ["#f5c29a", "#d99b70"], cloth: ["#ff8a3d", "#5d6bff"], hair: "#6b3d1f" } },
  { id: "cartoon", label: "Cartoon", icon: "🖍️", p: { sky: ["#ffd23f", "#ff9f1c"], ground: "#2ec4b6", light: "#ffffff", skin: ["#ffcf99", "#f4a261"], cloth: ["#e71d36", "#011627"], hair: "#011627", line: "#111111" } },
  { id: "noir", label: "Film noir", icon: "🕵️", p: { sky: ["#0e0e0e", "#4a4a4a"], ground: "#1a1a1a", light: "#f2f2f2", skin: ["#bdbdbd", "#8a8a8a"], cloth: ["#555555", "#2a2a2a"], hair: "#111111", filter: "grayscale(1) contrast(1.25)", over: "blinds" } },
  { id: "thriller", label: "Thriller", icon: "🌑", p: { sky: ["#0b1418", "#24363a"], ground: "#111b1d", light: "#9fd0c8", skin: ["#a98a78", "#7d6355"], cloth: ["#3b4a4f", "#5a2e2e"], hair: "#0c0c0c", filter: "saturate(0.6)", over: "fog" } },
];

/** A short example story: a wide shot, a close-up of each character with their line, and the ending. */
const SCENES: { shot: "wide" | "ama" | "kofi" | "bus"; who?: string; line: string }[] = [
  { shot: "wide", line: "Midnight. The last bus is late." },
  { shot: "ama", who: "Ama", line: "You've been following me since the market." },
  { shot: "kofi", who: "Kofi", line: "I came to give you this. It was your father's." },
  { shot: "bus", who: "Ama", line: "Then get on. We have a story to finish." },
];

const SCENE_MS = 3200;

const IDEAS = [
  "A taxi driver in Lagos finds a phone that shows tomorrow's news…",
  "Two rival chefs fall in love during a cooking contest…",
  "A princess hides a dragon egg from her own army…",
  "A detective's only witness is a parrot…",
];

/** One example scene, drawn in a look. */
function Scene({ shot, p, id }: { shot: (typeof SCENES)[number]["shot"]; p: Palette; id: string }) {
  const stroke = p.line ? { stroke: p.line, strokeWidth: 3 } : {};
  // A character: head, hair and body, at x, with a size and which of the two they are.
  const person = (x: number, y: number, s: number, who: 0 | 1, key: string) => (
    <g key={key} transform={`translate(${x} ${y}) scale(${s})`}>
      <path d="M-34 120 Q-36 40 0 36 Q36 40 34 120 Z" fill={p.cloth[who]} {...stroke} />
      <circle cx="0" cy="0" r="26" fill={p.skin[who]} {...stroke} />
      {who === 0 ? (
        <path d="M-28 4 Q-32 -34 0 -30 Q32 -34 28 4 Q30 -14 14 -18 Q0 -10 -16 -18 Q-28 -14 -28 4 Z" fill={p.hair} />
      ) : (
        <path d="M-25 -6 Q-24 -30 0 -29 Q24 -30 25 -6 Q14 -18 0 -17 Q-14 -18 -25 -6 Z" fill={p.hair} />
      )}
      <circle cx="-9" cy="2" r="2.6" fill="#1a1a1a" />
      <circle cx="9" cy="2" r="2.6" fill="#1a1a1a" />
      <path d="M-7 13 Q0 17 7 13" fill="none" stroke="#1a1a1a" strokeWidth="2" strokeLinecap="round" />
    </g>
  );
  return (
    <svg viewBox="0 0 270 480" className="h-full w-full" style={{ filter: p.filter }} aria-hidden>
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={p.sky[0]} />
          <stop offset="1" stopColor={p.sky[1]} />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={p.light} stopOpacity="0.85" />
          <stop offset="1" stopColor={p.light} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="270" height="480" fill={`url(#${id}-sky)`} />
      {/* The city behind them. */}
      <g fill={p.ground} opacity="0.75">
        <rect x="0" y="200" width="46" height="140" />
        <rect x="52" y="168" width="38" height="172" />
        <rect x="186" y="186" width="40" height="154" />
        <rect x="230" y="150" width="40" height="190" />
      </g>
      <g fill={p.light} opacity="0.5">
        {[214, 236, 258, 280].map((y) => (
          <rect key={y} x="62" y={y} width="6" height="8" />
        ))}
        {[200, 226, 252].map((y) => (
          <rect key={y} x="242" y={y} width="6" height="8" />
        ))}
      </g>
      <rect y="340" width="270" height="140" fill={p.ground} />
      {shot === "wide" && (
        <>
          <circle cx="135" cy="150" r="90" fill={`url(#${id}-glow)`} />
          <rect x="132" y="150" width="6" height="190" fill={p.hair} />
          <rect x="112" y="140" width="46" height="12" rx="4" fill={p.hair} />
          {person(78, 270, 0.85, 0, "a")}
          {person(200, 276, 0.8, 1, "k")}
        </>
      )}
      {shot === "ama" && (
        <>
          <circle cx="135" cy="210" r="140" fill={`url(#${id}-glow)`} />
          {person(135, 250, 2.1, 0, "a")}
        </>
      )}
      {shot === "kofi" && (
        <>
          <circle cx="135" cy="210" r="140" fill={`url(#${id}-glow)`} />
          {person(135, 250, 2.1, 1, "k")}
          <rect x="176" y="380" width="34" height="22" rx="4" fill={p.light} opacity="0.9" {...stroke} />
        </>
      )}
      {shot === "bus" && (
        <>
          <rect x="20" y="230" width="230" height="120" rx="18" fill={p.cloth[1]} {...stroke} />
          <rect x="40" y="250" width="190" height="44" rx="8" fill={p.sky[1]} opacity="0.8" />
          <circle cx="54" cy="322" r="11" fill={p.light} />
          <circle cx="216" cy="322" r="11" fill={p.light} />
          <circle cx="54" cy="322" r="60" fill={`url(#${id}-glow)`} />
          <circle cx="216" cy="322" r="60" fill={`url(#${id}-glow)`} />
          {person(95, 380, 0.7, 0, "a")}
          {person(175, 384, 0.66, 1, "k")}
        </>
      )}
      {p.over === "bars" && (
        <g fill="#000">
          <rect width="270" height="38" />
          <rect y="442" width="270" height="38" />
        </g>
      )}
      {p.over === "blinds" && (
        <g fill="#000" opacity="0.35">
          {[40, 90, 140, 190, 240, 290].map((y) => (
            <rect key={y} y={y} width="270" height="18" transform="skewY(-12)" />
          ))}
        </g>
      )}
      {p.over === "fog" && <rect y="300" width="270" height="180" fill={p.light} opacity="0.12" />}
      {p.over === "sparkle" && (
        <g fill={p.light}>
          {[
            [30, 60],
            [220, 40],
            [180, 110],
            [60, 130],
            [240, 170],
            [120, 70],
          ].map(([x, y]) => (
            <path key={`${x}-${y}`} d={`M${x} ${y - 6} L${x + 2} ${y} L${x} ${y + 6} L${x - 2} ${y} Z M${x - 6} ${y} L${x} ${y + 2} L${x + 6} ${y} L${x} ${y - 2} Z`} />
          ))}
        </g>
      )}
      {p.over === "grain" && <rect width="270" height="480" fill="#fff" opacity="0.04" />}
    </svg>
  );
}

const FEATURES: [string, string][] = [
  ["Same faces in every part", "Each character gets their own pictures, so they look the same from scene to scene and part to part."],
  ["Characters who talk", "They speak their lines with lip-sync, in the voice the story gives them."],
  ["See it before you film", "A storyboard comes first: the script, the cast and each scene's first picture."],
  ["Made for TikTok, Reels and YouTube", "Parts of 30 seconds to 2 minutes, vertical, square or wide, in 1080p, with a poster for the series."],
];

export function StudioShowcase({ onStart, className = "" }: { onStart: (mode: "signup" | "login") => void; className?: string }) {
  const [look, setLook] = useState<Look>("hollywood");
  const [scene, setScene] = useState(0);
  // It runs by itself: each look plays its scenes, then the next look starts. A click takes over.
  const [auto, setAuto] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [idea, setIdea] = useState("");
  const [hint, setHint] = useState(0);
  const p = LOOKS.find((l) => l.id === look)!.p;

  // Playing steps through the scenes.
  useEffect(() => {
    // Nothing moves on its own for visitors who asked their device for less motion; Play still plays.
    if (!playing || (auto && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)) return;
    if (scene >= SCENES.length - 1) {
      // Running by itself, the next look starts from its first scene; played by hand, it stops.
      const done = setTimeout(() => {
        if (!auto) return setPlaying(false);
        setLook((l) => LOOKS[(LOOKS.findIndex((x) => x.id === l) + 1) % LOOKS.length].id);
        setScene(0);
      }, SCENE_MS);
      return () => clearTimeout(done);
    }
    const next = setTimeout(() => setScene((s) => s + 1), SCENE_MS);
    return () => clearTimeout(next);
  }, [playing, scene, auto]);


  useEffect(() => {
    const id = setInterval(() => setHint((h) => (h + 1) % IDEAS.length), 4000);
    return () => clearInterval(id);
  }, []);

  const play = () => {
    setAuto(false);
    setScene(0);
    setPlaying(true);
  };
  const now = SCENES[scene];
  const start = () => {
    const story = idea.trim();
    const name = LOOKS.find((l) => l.id === look)!.label;
    if (story) keepIdea({ text: `A drama series in a ${name} look: ${story}`, choice: "auto" });
    onStart("signup");
  };

  return (
    <section id="studio" aria-labelledby="studio-title" className={`scroll-mt-16 px-4 sm:px-6 ${className}`}>
      <div className="glass-raised relative mx-auto grid max-w-6xl items-center gap-8 overflow-hidden rounded-[28px] p-5 sm:p-8 grid-cols-1 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-14 lg:p-12">
        <div className="pointer-events-none absolute -end-24 -top-24 h-72 w-72 rounded-full bg-brand/20 blur-3xl" />

        {/* The example screen: the scene in the picked look, its line, and the parts' progress. */}
        <div className="relative mx-auto w-full max-w-[290px]">
          <div className="relative aspect-[9/16] overflow-hidden rounded-[26px] bg-black shadow-2xl ring-1 ring-white/10">
            <div key={`${look}-${scene}`} className="studio-scene absolute inset-0">
              <Scene shot={now.shot} p={p} id={`studio-${look}-${scene}`} />
            </div>
            <div className="absolute inset-x-3 top-3 flex gap-1" aria-hidden>
              {SCENES.map((s, i) => (
                <span key={s.line} className="h-1 flex-1 overflow-hidden rounded-full bg-paper/25">
                  <span
                    className={`block h-full rounded-full bg-paper ${playing && i === scene ? "studio-bar" : ""}`}
                    style={{ width: i < scene || (!playing && i === scene) ? "100%" : playing && i === scene ? undefined : "0%", animationDuration: `${SCENE_MS}ms` }}
                  />
                </span>
              ))}
            </div>
            <span className="absolute start-3 top-6 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-medium text-paper backdrop-blur">Example illustration</span>
            <div className="absolute inset-x-3 bottom-14 rounded-2xl bg-black/60 px-3.5 py-2.5 text-paper backdrop-blur" aria-live="polite">
              {now.who && <p className="text-[11px] font-semibold uppercase tracking-wide text-gold">{now.who}</p>}
              <p className={`text-[14px] leading-snug ${now.who ? "" : "italic text-paper/80"}`}>{now.line}</p>
            </div>
            <div className="absolute inset-x-3 bottom-3 flex items-center justify-between">
              <button
                type="button"
                onClick={
                  playing
                    ? () => {
                        setAuto(false);
                        setPlaying(false);
                      }
                    : play
                }
                className="flex h-9 items-center gap-1.5 rounded-full bg-paper px-3.5 text-[13px] font-semibold text-night transition hover:brightness-95"
              >
                {playing ? "❚❚ Pause" : "▶ Play example"}
              </button>
              <div className="flex gap-1">
                {SCENES.map((s, i) => (
                  <button
                    key={s.line}
                    type="button"
                    onClick={() => {
                      setAuto(false);
                      setPlaying(false);
                      setScene(i);
                    }}
                    aria-label={`Scene ${i + 1}`}
                    aria-pressed={scene === i}
                    className={`h-7 w-7 rounded-full text-[11px] font-semibold transition ${scene === i ? "bg-paper text-night" : "bg-black/50 text-paper hover:bg-black/70"}`}
                  >
                    {i + 1}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <p className="mt-3 text-center text-xs leading-relaxed text-zinc-500">
            Drawn to show the idea. Studio films are made from your story, with AI pictures, voices and video.
          </p>
        </div>

        <div className="relative">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand/15 px-3 py-1 text-xs font-semibold text-iris ring-1 ring-inset ring-brand/30">
            New · Infinity AI Studio
          </span>
          <h2 id="studio-title" className="mt-4 text-[clamp(28px,4vw,44px)] font-bold leading-[1.05] tracking-[-0.035em] text-white">
            Your story, filmed as a series.
          </h2>
          <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-zinc-300 sm:text-[16px]">
            Write an idea in a few words. Flash writes the scenes and the dialogue, creates the cast, and films each part with the characters speaking. Make Part 2 and the story goes on.
          </p>

          <p className="mt-6 text-xs font-semibold uppercase tracking-wide text-zinc-400">Pick a look</p>
          <div className="mt-2 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible">
            {LOOKS.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => {
                  // Picking a look plays its scenes from the start, and the looks stop changing by themselves.
                  setAuto(false);
                  setLook(l.id);
                  setScene(0);
                  setPlaying(true);
                }}
                aria-pressed={look === l.id}
                className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition ${
                  look === l.id ? "bg-white text-zinc-950" : "bg-white/[0.06] text-zinc-200 ring-1 ring-inset ring-white/10 hover:bg-white/[0.1]"
                }`}
              >
                <span aria-hidden>{l.icon}</span>
                {l.label}
              </button>
            ))}
          </div>

          <ul className="mt-6 grid gap-x-6 gap-y-4 sm:grid-cols-2">
            {FEATURES.map(([title, text]) => (
              <li key={title}>
                <p className="flex items-center gap-2 text-[14px] font-semibold text-white">
                  <span className="text-gold" aria-hidden>
                    ✦
                  </span>
                  {title}
                </p>
                <p className="mt-1 text-[13px] leading-relaxed text-zinc-400">{text}</p>
              </li>
            ))}
          </ul>

          {/* Their idea waits while they sign up, then fills Flash's own box. */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              start();
            }}
            className="mt-7 flex flex-col gap-2 rounded-2xl bg-black/20 p-2 ring-1 ring-inset ring-white/10 light:bg-paper sm:flex-row"
          >
            <input
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              maxLength={1000}
              placeholder={IDEAS[hint]}
              aria-label="Your story idea"
              className="h-11 min-w-0 flex-1 bg-transparent px-3 text-[15px] text-zinc-100 outline-none placeholder:text-zinc-500"
            />
            <button type="submit" className="h-11 shrink-0 rounded-xl bg-brand px-5 text-[15px] font-semibold text-on-brand transition hover:brightness-110">
              Make my series
            </button>
          </form>
          <p className="mt-2 text-xs text-zinc-500">Free to sign up. Filming uses credits, and Flash shows you the price before it starts.</p>
        </div>
      </div>
    </section>
  );
}
