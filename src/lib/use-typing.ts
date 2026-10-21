"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/*
 * A placeholder that types itself: each example request is typed out letter by letter, held for a
 * moment, wiped and followed by the next, as if someone were asking Flash for it. Only while on (the
 * box is empty and not being typed in), and never for people who ask for less motion: they see the
 * first example whole.
 */
const TYPE_MS = 45;
const WIPE_MS = 18;
const HOLD_MS = 1800;
const GAP_MS = 400;

const LESS_MOTION = "(prefers-reduced-motion: reduce)";
const onMotionChange = (change: () => void) => {
  const list = window.matchMedia(LESS_MOTION);
  list.addEventListener("change", change);
  return () => list.removeEventListener("change", change);
};

export function useTypingPlaceholder(examples: string[], on: boolean): string {
  const [shown, setShown] = useState("");
  const still = useSyncExternalStore(onMotionChange, () => window.matchMedia(LESS_MOTION).matches, () => false);
  const key = examples.join("\n");
  useEffect(() => {
    const list = key.split("\n");
    if (!on || still || !list[0]) return;
    let which = 0;
    let at = 0;
    let wiping = false;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      const text = list[which];
      if (!wiping) {
        at++;
        setShown(text.slice(0, at));
        if (at >= text.length) {
          wiping = true;
          timer = setTimeout(step, HOLD_MS);
          return;
        }
        timer = setTimeout(step, TYPE_MS);
      } else {
        at = Math.max(0, at - 3);
        setShown(text.slice(0, at));
        if (at === 0) {
          wiping = false;
          which = (which + 1) % list.length;
          timer = setTimeout(step, GAP_MS);
          return;
        }
        timer = setTimeout(step, WIPE_MS);
      }
    };
    timer = setTimeout(step, GAP_MS);
    return () => clearTimeout(timer);
  }, [key, on, still]);
  return !on ? "" : still ? examples[0] ?? "" : shown;
}
