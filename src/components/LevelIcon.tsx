import { LEVELS, type Level } from "@/lib/levels";

/*
 * Each level's sign, from Flash's levels picture: a bolt for Auto, a speedometer for Sonic, a brain
 * for Ascend, an eye for Vision and infinity for Summit, each in its own colour.
 */
const SHAPES: Record<Level, string> = {
  auto: "M13.5 2.5 5 13.5h6l-1 8 8.5-11h-6z",
  sonic: "M4.2 16.5a8.5 8.5 0 1 1 15.6 0 M12 14.5l4.2-5 M12 14.5h.01 M7 9.5l1 .8 M12 6.5v1.3 M17 9.5l-1 .8",
  ascend:
    "M11.4 4.6a2.9 2.9 0 0 0-5 1.1 3 3 0 0 0-2.2 4.3 3.1 3.1 0 0 0 .5 5.1 3 3 0 0 0 3.2 3.6 2.7 2.7 0 0 0 3.5 1.1z M12.6 4.6a2.9 2.9 0 0 1 5 1.1 3 3 0 0 1 2.2 4.3 3.1 3.1 0 0 1-.5 5.1 3 3 0 0 1-3.2 3.6 2.7 2.7 0 0 1-3.5 1.1z M7.6 9.6c1.3-.1 2.2.7 2.3 2 M16.4 9.6c-1.3-.1-2.2.7-2.3 2 M7.4 15c1 .2 1.9-.3 2.3-1.1 M16.6 15c-1 .2-1.9-.3-2.3-1.1",
  vision: "M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z M15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0z M12 12h.01",
  ultra: "M12 12c-2-2.7-3.6-4-5.5-4a4 4 0 0 0 0 8c1.9 0 3.5-1.3 5.5-4zm0 0c2 2.7 3.6 4 5.5 4a4 4 0 0 0 0-8c-1.9 0-3.5 1.3-5.5 4z",
};

/** Each level's colour, as in the picture: blue, teal, violet, orange and gold. */
export const LEVEL_HUES: Record<Level, { text: string; tile: string }> = {
  auto: {
    text: "text-sky-400 light:text-blue-600",
    tile: "bg-sky-400/15 text-sky-300 ring-sky-400/30 light:bg-blue-50 light:text-blue-600 light:ring-blue-200",
  },
  sonic: {
    text: "text-teal-300 light:text-teal-600",
    tile: "bg-teal-400/15 text-teal-300 ring-teal-400/30 light:bg-teal-50 light:text-teal-600 light:ring-teal-200",
  },
  ascend: {
    text: "text-violet-400 light:text-violet-600",
    tile: "bg-violet-400/15 text-violet-300 ring-violet-400/30 light:bg-violet-50 light:text-violet-600 light:ring-violet-200",
  },
  vision: {
    text: "text-orange-400 light:text-orange-600",
    tile: "bg-orange-400/15 text-orange-300 ring-orange-400/30 light:bg-orange-50 light:text-orange-600 light:ring-orange-200",
  },
  ultra: {
    text: "text-amber-300 light:text-amber-600",
    tile: "bg-amber-300/15 text-amber-300 ring-amber-300/30 light:bg-amber-50 light:text-amber-600 light:ring-amber-200",
  },
};

export function LevelIcon({ level, className = "h-4 w-4" }: { level: Level; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={SHAPES[level]} />
    </svg>
  );
}

/** The sign for the level an answer names ("Flash Ascend"), or nothing for a model that isn't a level. */
export function LevelSign({ name, className = "h-4 w-4" }: { name: string; className?: string }) {
  const level = LEVELS.find((l) => l.name === name)?.id;
  return level ? <LevelIcon level={level} className={`${className} ${LEVEL_HUES[level].text}`} /> : null;
}
