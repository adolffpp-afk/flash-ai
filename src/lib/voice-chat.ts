/*
 * Talking with Flash: the "Hey Flash" wake phrase, short spoken answers (yes, no, goodbye), what
 * Flash says back after a request, and the note that makes the writing engines answer like a person
 * talking. The browser does the listening and speaking (see VoiceMode.tsx and WakeWord.tsx).
 */
import { speakable } from "./speech.ts";
import type { Engine } from "./types.ts";
import type { UIMessage } from "./store.ts";

// "Hey Flash", "OK Flash", "Hi, Flash!" … but not "flashlight" or "flash sale" said on its own.
const WAKE = /\b(?:hey|hay|hi|hello|ok|okay)[\s,.!-]+flash\b[\s,.!?:;-]*/i;

/** Whether the words heard start a conversation, and what was said after "Hey Flash" if anything. */
export function wakeMatch(heard: string): { rest: string } | null {
  const m = WAKE.exec(heard);
  if (!m) return null;
  return { rest: heard.slice(m.index + m[0].length).trim() };
}

// Words only, lowercase, so "Yes!" and "yes." read the same.
const plain = (text: string) =>
  text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const YES = /^(?:yes|yeah|yep|yup|sure|ok|okay|alright|all right|go ahead|do it|please do|of course|absolutely|let's do it)\b/;
const NO = /^(?:no|nope|nah|cancel|don't|do not|never mind|nevermind|not now|skip it|skip)\b/;
const BYE =
  /^(?:(?:ok|okay|thanks|thank you|great)\s+)*(?:bye(?: bye)?|goodbye|good bye|stop listening|that's all|that is all|that's it|end (?:the )?(?:call|conversation|chat)|hang up)(?:\s+(?:flash|for now|thanks|thank you))*$/;

/** A short "yes" to a question Flash asked (like going ahead with a costly request). */
export const isYes = (heard: string) => {
  const p = plain(heard);
  return YES.test(p) && !/\b(?:no|not|don't)\b/.test(p) && p.split(" ").length <= 6;
};
export const isNo = (heard: string) => NO.test(plain(heard));
/** "Bye", "that's all", "stop listening": ends the conversation. */
export const isGoodbye = (heard: string) => BYE.test(plain(heard));

/**
 * Splits what Flash says into pieces short enough for the browser's voice: Chrome stops reading
 * long utterances part way, so each piece is a sentence or two.
 */
export function speechChunks(text: string, max = 200): string[] {
  const out: string[] = [];
  let current = "";
  const push = (piece: string) => {
    if (!piece) return;
    if (current && current.length + 1 + piece.length > max) {
      out.push(current);
      current = "";
    }
    current = current ? `${current} ${piece}` : piece;
  };
  for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
    if (sentence.length <= max) {
      push(sentence);
      continue;
    }
    // A long sentence breaks at commas, then at spaces.
    for (const part of sentence.split(/(?<=[,;:])\s+/)) {
      if (part.length <= max) push(part);
      else for (const word of part.split(/\s+/)) push(word);
    }
  }
  if (current) out.push(current);
  return out;
}

// Flash reads about this much of an answer aloud; the rest stays on screen.
export const MAX_SPOKEN_CHARS = 600;

/** Cuts text at a sentence end (or a space) before max characters. */
function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > max / 3 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

export type VoiceMessage = Pick<UIMessage, "content" | "after" | "error" | "errorCode" | "stopped" | "images" | "videos" | "audio" | "app">;

/** What made things are called when Flash tells the user they're ready. */
function madeNote(m: VoiceMessage): string {
  if (m.app) return "Your app is ready. It's on your screen.";
  if (m.videos?.length) return m.videos.length > 1 ? "Your videos are ready. They're on your screen." : "Your video is ready. It's on your screen.";
  if (m.images?.length) return m.images.length > 1 ? "Your pictures are ready. They're on your screen." : "Your picture is ready. It's on your screen.";
  if (m.audio) return "It's ready. Press play on your screen to listen.";
  return "";
}

/**
 * What Flash says after a request in a voice conversation. confirm is true when Flash asked
 * whether to go ahead with a costly request, so a "yes" next runs it.
 */
export function voiceReply(m: VoiceMessage): { say: string; confirm: boolean } {
  if (m.error && m.errorCode === "confirm_cost") return { say: `${m.error} Say yes to go ahead, or no to skip it.`, confirm: true };
  if (m.error) return { say: m.error, confirm: false };
  if (m.stopped) return { say: "Stopped.", confirm: false };
  const written = [m.content, m.after].filter(Boolean).join("\n\n");
  // Code and tables don't read well aloud; they stay on screen.
  const hidden = /```|^\s*\|.*\|\s*$/m.test(written);
  const text = speakable(written.replace(/^\s*\|.*\|\s*$/gm, " "));
  if (!text) return { say: madeNote(m) || "Done. It's on your screen.", confirm: false };
  const short = shorten(text, MAX_SPOKEN_CHARS);
  const more = short.length < text.length ? " The rest is on your screen." : hidden ? " The details are on your screen." : "";
  return { say: short + more, confirm: false };
}

// The engines that answer in their own words; the others make things (apps, pictures, files)
// whose instructions mustn't change.
const SPOKEN_ENGINES: readonly Engine[] = ["text", "translate", "search"];

export const VOICE_STYLE =
  "This message was spoken in a live voice conversation with Flash, and the reply will be read aloud. " +
  "Answer the way a person talks: usually one to three short sentences, with no lists, tables, headings, " +
  "links, code or emoji, unless the user asks for more detail.";

/** Adds the spoken-answer note to a voice request for the engines that write the answer themselves. */
export function withVoiceStyle(preferences: string, engine: Engine, voice: unknown): string {
  if (voice !== true || !SPOKEN_ENGINES.includes(engine)) return preferences;
  return preferences.trim() ? `${preferences.trim()}\n\n${VOICE_STYLE}` : VOICE_STYLE;
}
