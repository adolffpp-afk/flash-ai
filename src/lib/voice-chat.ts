/*
 * Talking with Flash: the "Hey Flash" wake phrase, short spoken answers (yes, no, goodbye), what
 * Flash says back after a request, and the note that makes the writing engines answer like a person
 * talking. The browser does the listening and speaking (see VoiceMode.tsx and WakeWord.tsx).
 */
import { english, msg, type Translate } from "./i18n.ts";
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
    .replace(/[^\p{L}\p{M}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const YES = /^(?:yes|yeah|yep|yup|sure|ok|okay|alright|all right|go ahead|do it|please do|of course|absolutely|let's do it)\b/;
const NO = /^(?:no|nope|nah|cancel|don't|do not|never mind|nevermind|not now|skip it|skip)\b/;
const BYE =
  /^(?:(?:ok|okay|thanks|thank you|great)\s+)*(?:bye(?: bye)?|goodbye|good bye|stop listening|that's all|that is all|that's it|end (?:the )?(?:call|conversation|chat)|hang up)(?:\s+(?:flash|for now|thanks|thank you))*$/;

/*
 * Yes, no and goodbye in the language Flash is shown in, as lists of words split by commas. They're
 * heard as well as the English ones: pass t(YES_WORDS) and so on to isYes, isNo and isGoodbye.
 */
export const YES_WORDS = msg("yes, yeah, sure, okay, go ahead, do it");
export const NO_WORDS = msg("no, cancel, not now, skip it");
export const GOODBYE_WORDS = msg("bye, goodbye, that's all, stop listening");

// A translated list's words, as plain words. Commas of other scripts (，、،) split it too.
const wordList = (list: string) => list.split(/[,，、،]/).map(plain).filter(Boolean);
// Whether what was said starts with one of the words, as a whole word or phrase.
const startsWithOne = (said: string, list: string) => wordList(list).some((w) => said === w || said.startsWith(`${w} `));

// Chinese, Japanese and Thai are written without spaces, so there a short answer is a few letters.
const UNSPACED = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}]/u;
const isShort = (said: string) => said.split(" ").length <= 6 && (!UNSPACED.test(said) || said.replace(/ /g, "").length <= 15);

/**
 * A short "yes" to a question Flash asked (like going ahead with a costly request). words: more
 * ways to say yes, as a translated list (see YES_WORDS).
 */
export const isYes = (heard: string, words = "") => {
  const p = plain(heard);
  return (YES.test(p) || startsWithOne(p, words)) && !/\b(?:no|not|don't)\b/.test(p) && isShort(p);
};
/** A short "no"; words: more ways to say it (see NO_WORDS). */
export const isNo = (heard: string, words = "") => {
  const p = plain(heard);
  return NO.test(p) || startsWithOne(p, words);
};
/** "Bye", "that's all", "stop listening": ends the conversation. words: more ways to say it, said on their own (see GOODBYE_WORDS). */
export const isGoodbye = (heard: string, words = "") => {
  const p = plain(heard);
  return BYE.test(p) || wordList(words).some((w) => p === w || p === `${w} flash`);
};

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
function madeNote(m: VoiceMessage, t: Translate): string {
  if (m.app) return t("Your app is ready. It's on your screen.");
  if (m.videos?.length) return m.videos.length > 1 ? t("Your videos are ready. They're on your screen.") : t("Your video is ready. It's on your screen.");
  if (m.images?.length) return m.images.length > 1 ? t("Your pictures are ready. They're on your screen.") : t("Your picture is ready. It's on your screen.");
  if (m.audio) return t("It's ready. Press play on your screen to listen.");
  return "";
}

/**
 * What Flash says after a request in a voice conversation, in the language t speaks. confirm is
 * true when Flash asked whether to go ahead with a costly request, so a "yes" next runs it.
 */
export function voiceReply(m: VoiceMessage, t: Translate = english): { say: string; confirm: boolean } {
  // The price question is written by the server.
  if (m.error && m.errorCode === "confirm_cost") return { say: t("{cost} Say yes to go ahead, or no to skip it.", { cost: m.error }), confirm: true };
  if (m.error) return { say: m.error, confirm: false };
  if (m.stopped) return { say: t("Stopped."), confirm: false };
  const written = [m.content, m.after].filter(Boolean).join("\n\n");
  // Code and tables don't read well aloud; they stay on screen.
  const hidden = /```|^\s*\|.*\|\s*$/m.test(written);
  const text = speakable(written.replace(/^\s*\|.*\|\s*$/gm, " "));
  if (!text) return { say: madeNote(m, t) || t("Done. It's on your screen."), confirm: false };
  const short = shorten(text, MAX_SPOKEN_CHARS);
  if (short.length < text.length) return { say: t("{answer} The rest is on your screen.", { answer: short }), confirm: false };
  if (hidden) return { say: t("{answer} The details are on your screen.", { answer: short }), confirm: false };
  return { say: short, confirm: false };
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
