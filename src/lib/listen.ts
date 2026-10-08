/*
 * The browser's own speech recognition (Chrome, Edge, Safari), shared by the mic button, voice
 * conversations and the "Hey Flash" listener. Only one of them can listen at a time, so each one
 * takes the mic before starting and whoever had it stops.
 */

export type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };

export type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

type RecognitionCtor = new () => Recognition;

function ctor(): RecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as Record<string, RecognitionCtor | undefined>;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/** Whether this browser can turn speech into text by itself (Firefox can't). */
export const hasBuiltInRecognition = () => Boolean(ctor());

export function newRecognition(): Recognition | null {
  const C = ctor();
  if (!C) return null;
  const rec = new C();
  rec.lang = navigator.language || "en-US";
  return rec;
}

/** Errors that mean the microphone isn't allowed, as opposed to silence or a hiccup. */
export const micBlocked = (error: string) => error === "not-allowed" || error === "service-not-allowed";

let holder: { owner: string; stop: () => void } | null = null;

/** Takes the microphone for owner, stopping whoever else was listening. */
export function takeMic(owner: string, stop: () => void): void {
  const previous = holder;
  holder = { owner, stop };
  if (previous && previous.owner !== owner) {
    try {
      previous.stop();
    } catch {}
  }
}

/** Gives the microphone back (only if owner still has it). */
export function releaseMic(owner: string): void {
  if (holder?.owner === owner) holder = null;
}

/** Whether someone other than owner is using the microphone. */
export const micTakenBy = (owner: string) => Boolean(holder && holder.owner !== owner);
