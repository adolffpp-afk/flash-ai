"use client";

import { useEffect, useRef, useState } from "react";
import { hasBuiltInRecognition, micBlocked, micTakenBy, newRecognition, releaseMic, takeMic, type Recognition } from "@/lib/listen";
import { wakeMatch } from "@/lib/voice-chat";

export type WakeState = "off" | "listening" | "blocked";

/**
 * Listens for "Hey Flash" while Flash is open, with the browser's own speech recognition (Chrome,
 * Edge, Safari), and calls onWake with whatever was said after it. It steps aside whenever the mic
 * button or a voice conversation is listening, and starts again when enabled turns back on.
 */
export function useWakeWord(enabled: boolean, onWake: (rest: string) => void): WakeState {
  const [state, setState] = useState<WakeState>("off");
  // Bumped when the tab comes back into view, to start again after the browser stopped listening.
  const [attempt, setAttempt] = useState(0);
  const wake = useRef(onWake);
  useEffect(() => {
    wake.current = onWake;
  });

  useEffect(() => {
    const again = () => document.visibilityState === "visible" && setAttempt((a) => a + 1);
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, []);

  useEffect(() => {
    if (!enabled || !hasBuiltInRecognition()) {
      const timer = setTimeout(() => setState("off"));
      return () => clearTimeout(timer);
    }
    let stopped = false;
    let rec: Recognition | null = null;
    let startedAt = 0;
    let quickEnds = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const start = () => {
      // The mic button or a conversation has the mic; this starts again once they're done.
      if (stopped || micTakenBy("wake")) return;
      const r = newRecognition();
      if (!r) return;
      rec = r;
      r.continuous = true;
      r.interimResults = false;
      r.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (!e.results[i].isFinal) continue;
          const hit = wakeMatch(e.results[i][0].transcript);
          if (!hit) continue;
          stopped = true;
          r.abort();
          releaseMic("wake");
          wake.current(hit.rest);
          return;
        }
      };
      r.onerror = (e) => {
        if (micBlocked(e.error)) {
          stopped = true;
          setState("blocked");
        }
      };
      r.onend = () => {
        releaseMic("wake");
        if (stopped) return;
        // Browsers end listening every so often; start again, slower if it keeps ending at once.
        quickEnds = Date.now() - startedAt < 2000 ? quickEnds + 1 : 0;
        if (quickEnds >= 5) return setState("off");
        timer = setTimeout(start, quickEnds ? 1000 * quickEnds : 250);
      };
      takeMic("wake", () => r.abort());
      startedAt = Date.now();
      try {
        r.start();
        setState("listening");
      } catch {
        releaseMic("wake");
        setState("off");
      }
    };
    timer = setTimeout(start);
    return () => {
      stopped = true;
      clearTimeout(timer);
      try {
        rec?.abort();
      } catch {}
      releaseMic("wake");
    };
  }, [enabled, attempt]);

  return state;
}
