"use client";

import { useEffect, useState } from "react";
import { msg } from "@/lib/i18n";
import { useT } from "@/lib/use-t";

// Short, hopeful lines shown while Flash builds or films something, so the wait isn't a blank screen.
// Proverbs and words from authors long out of copyright, and a few of Flash's own (no author line).
export const WAIT_QUOTES: { text: string; by?: string }[] = [
  { text: msg("A journey of a thousand miles begins with a single step."), by: msg("Lao Tzu") },
  { text: msg("Great things are done by a series of small things brought together."), by: msg("Vincent van Gogh") },
  { text: msg("Well begun is half done."), by: msg("Aristotle") },
  { text: msg("Little by little, one goes far."), by: msg("Spanish proverb") },
  { text: msg("The best time to plant a tree was twenty years ago. The second best time is now."), by: msg("Chinese proverb") },
  { text: msg("Fall seven times, stand up eight."), by: msg("Japanese proverb") },
  { text: msg("Do what you can, with what you have, where you are."), by: msg("Theodore Roosevelt") },
  { text: msg("Energy and persistence conquer all things."), by: msg("Benjamin Franklin") },
  { text: msg("Little strokes fell great oaks."), by: msg("Benjamin Franklin") },
  { text: msg("Slow and steady wins the race."), by: msg("Aesop") },
  { text: msg("When the wind of change blows, some build walls, others build windmills."), by: msg("Chinese proverb") },
  { text: msg("The one who moves a mountain begins by carrying away small stones."), by: msg("Chinese proverb") },
  { text: msg("If you want to go fast, go alone. If you want to go far, go together."), by: msg("African proverb") },
  { text: msg("Patience is the companion of wisdom."), by: msg("Saint Augustine") },
  { text: msg("Little by little, the bird builds its nest."), by: msg("French proverb") },
  { text: msg("Every big idea starts as a first draft.") },
  { text: msg("Your idea is taking shape, one line at a time.") },
];

// Long enough to read twice, short enough that a build of a minute or two shows several.
const SHOW_MS = 7000;
const FADE_MS = 400;

/**
 * One hopeful line at a time, fading to the next every few seconds; it starts at a random one, so a
 * second build doesn't open on the same words. Screen readers aren't told about each change: the
 * steps beside it already say what Flash is doing.
 */
export function WaitQuote({ size = "md", className = "" }: { size?: "sm" | "md"; className?: string }) {
  const t = useT();
  const [at, setAt] = useState<number | null>(null);
  const [shown, setShown] = useState(true);
  useEffect(() => {
    // Picked after the first paint, so the page drawn on the server matches the browser's first one.
    const first = Math.floor(Math.random() * WAIT_QUOTES.length);
    const start = setTimeout(() => setAt(first), 0);
    let fade: ReturnType<typeof setTimeout> | undefined;
    const turn = setInterval(() => {
      setShown(false);
      fade = setTimeout(() => {
        setAt((i) => ((i ?? first) + 1) % WAIT_QUOTES.length);
        setShown(true);
      }, FADE_MS);
    }, SHOW_MS);
    return () => {
      clearTimeout(start);
      clearTimeout(fade);
      clearInterval(turn);
    };
  }, []);
  if (at === null) return null;
  const quote = WAIT_QUOTES[at];
  const small = size === "sm";
  return (
    <figure dir="auto" className={`flex flex-col items-center justify-center text-center ${className}`}>
      <span
        aria-hidden
        className={`select-none bg-gradient-to-br from-primary to-gold bg-clip-text font-serif leading-none text-transparent ${small ? "h-5 text-3xl" : "h-7 text-5xl"}`}
      >
        “
      </span>
      <div className={`transition-opacity duration-300 motion-reduce:transition-none ${shown ? "opacity-100" : "opacity-0"}`}>
        <blockquote className={`text-balance font-medium text-zinc-200 ${small ? "text-sm leading-snug" : "text-base leading-relaxed sm:text-lg"}`}>
          {t(quote.text)}
        </blockquote>
        {quote.by && <figcaption className={`mt-1.5 font-medium tracking-wide text-gold ${small ? "text-[11px]" : "text-xs"}`}>{t(quote.by)}</figcaption>}
      </div>
    </figure>
  );
}
