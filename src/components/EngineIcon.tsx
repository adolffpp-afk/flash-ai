import type { Engine } from "@/lib/types";

// Simple line icons, one per engine, drawn on a 24-unit grid.
const PATHS: Record<Engine, string> = {
  app: "M3 5h18v14H3z M3 9h18 M9 9v10",
  slides: "M3 4h18v12H3z M12 16v4 M8 20h8 M7 12l3-3 3 2 4-4",
  text: "M4 20h4L19 9l-4-4L4 16z M14 6l4 4",
  search: "M18 11a7 7 0 1 1-14 0a7 7 0 1 1 14 0z M20 20l-4-4",
  code: "M8 8l-4 4 4 4 M16 8l4 4-4 4 M13.5 6l-3 12",
  translate: "M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0z M3 12h18 M12 3c3.5 3 3.5 15 0 18 M12 3c-3.5 3-3.5 15 0 18",
  docs: "M4 4h16v16H4z M4 10h16 M4 15h16 M10 4v16",
  image: "M4 5h16v14H4z M4 16l5-5 4 4 3-3 4 4 M16.5 9a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z",
  video: "M3 6h13v12H3z M16 10l5-3v10l-5-3",
  voice: "M4 9h4l5-4v14l-5-4H4z M17 9a4 4 0 0 1 0 6 M19.5 6.5a8 8 0 0 1 0 11",
  music: "M9 18V5l11-2v13 M9 18a3 3 0 1 1-6 0a3 3 0 1 1 6 0z M20 16a3 3 0 1 1-6 0a3 3 0 1 1 6 0z",
  transcribe: "M6 3h9l4 4v14H6z M9 11h7 M9 15h7 M9 7h3",
};

// Teal and lavender alternate, like the brand gradient; red is kept for a couple of the media engines so it stays a spark.
const TONE: Record<Engine, "teal" | "violet" | "spark"> = {
  app: "violet",
  slides: "teal",
  text: "violet",
  search: "teal",
  code: "violet",
  translate: "teal",
  docs: "violet",
  image: "teal",
  video: "spark",
  voice: "teal",
  music: "spark",
  transcribe: "violet",
};

const TONE_CLASS = {
  teal: "bg-primary/15 text-primary-soft ring-primary/30",
  violet: "bg-violet/15 text-violet-soft ring-violet/30",
  spark: "bg-spark/15 text-spark-soft ring-spark/30",
};

/** An engine's icon on a tinted tile. */
export function EngineIcon({ engine, size = "md" }: { engine: Engine; size?: "sm" | "md" }) {
  const box = size === "sm" ? "h-6 w-6 rounded-md" : "h-9 w-9 rounded-lg";
  const icon = size === "sm" ? "h-3.5 w-3.5" : "h-5 w-5";
  return (
    <span className={`inline-flex shrink-0 items-center justify-center ring-1 ring-inset ${box} ${TONE_CLASS[TONE[engine]]}`} aria-hidden>
      <svg viewBox="0 0 24 24" className={icon} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d={PATHS[engine]} />
      </svg>
    </span>
  );
}
