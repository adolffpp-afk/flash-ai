import type { FreeProvider } from "./engines/free.ts";
import { needsCare } from "./levels.ts";

/*
 * Which free model is asked first (see the free lane in engines/free.ts). Only the first one tried
 * depends on the request: every other provider stays a backup in the usual order, and no cap, cost
 * (there is none) or rule about who may be answered changes. Where Gemini's free tier may not
 * answer someone (see geminiFreeServes), it is skipped as before and the next one answers.
 * - Gemini leads for long inputs (a big file or a long conversation), which would use up Groq's
 *   daily tokens fastest, and for messages not in English, which it writes better.
 * - Groq leads, as it always has, for short questions, maths and code: it's the fastest. Maths and
 *   code in another language stay on Groq; a long input goes to Gemini whatever it is.
 * - With the forecast tool, the providers that take tools come first, still in that order.
 */
export type FreeFacts = {
  // More than LONG_INPUT_CHARS to read: a big file or a long conversation.
  long?: boolean;
  // The message isn't in English, or the user's answers are set to another language.
  foreign?: boolean;
  // Sums, units, money or code.
  technical?: boolean;
  // A message of at most SHORT_CHARS.
  short?: boolean;
  // The forecast tool is offered (see weather.ts).
  weather?: boolean;
};

export const LONG_INPUT_CHARS = 12_000;
export const SHORT_CHARS = 140;

/** The providers in the order they're tried for a request: base is the usual order, tools those that take tools. */
export function freeOrder(facts: FreeFacts, base: readonly FreeProvider[], tools: readonly FreeProvider[] = []): FreeProvider[] {
  const lead: FreeProvider | null = facts.long ? "gemini" : facts.technical ? "groq" : facts.foreign ? "gemini" : facts.short ? "groq" : null;
  const order = lead && base.includes(lead) ? [lead, ...base.filter((p) => p !== lead)] : [...base];
  return facts.weather ? [...order.filter((p) => tools.includes(p)), ...order.filter((p) => !tools.includes(p))] : order;
}

// Words common in English and rare in Flash's other languages that use the Latin alphabet (so not
// "in", "is", "to", "me", "was" or "will", which are words in Dutch, German, Polish or Spanish too).
const ENGLISH = new Set(
  (
    "the what what's how why when where who which whose you your you're i'm i've it it's this that these those they their there we our " +
    "she her his him them with for and from about have has had does did doesn't don't can't can could would should please thanks thank " +
    "any some every more than then because before after into only very really again here out up just like know think say said mean " +
    "meaning difference between good bad new old big small next today tomorrow yesterday weather rain cold hot write give make tell " +
    "explain show find help need want get convert solve calculate summarize summarise translate create draw recipe story joke letter " +
    "trip tips summer sky change long"
  ).split(" "),
);

/**
 * Whether a message reads as English: mostly plain Latin letters and at least one common English
 * word. Too short to tell (fewer than three words) counts as English, so the usual order holds.
 */
export function looksEnglish(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return true;
  const plain = letters.filter((c) => /[a-z]/i.test(c)).length;
  if (plain / letters.length < 0.9) return false;
  const words = text.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? [];
  if (words.length < 3) return true;
  return words.some((w) => ENGLISH.has(w));
}

/** The facts freeOrder reads, from the request: the latest message, how much there is to read, the mode and the answer language. */
export function freeFacts(request: { message: string; inputChars: number; code?: boolean; language?: string; weather?: boolean }): FreeFacts {
  const { message, inputChars, code = false, language = "", weather = false } = request;
  return {
    long: inputChars > LONG_INPUT_CHARS,
    foreign: (language !== "" && language !== "en") || !looksEnglish(message),
    technical: code || needsCare(message) || message.includes("```"),
    short: message.trim().length <= SHORT_CHARS,
    weather,
  };
}
