/*
 * Talking with Flash: the "Hey Flash" wake phrase, short spoken answers (yes, no, goodbye, say that
 * again), where a recorded turn ends, what Flash says back after a request (starting before it's all
 * written), and the note that makes the writing engines answer like a person talking. The browser
 * does the listening and speaking (see VoiceMode.tsx and WakeWord.tsx).
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

const YES =
  /^(?:yes|yeah|yep|yup|sure|ok|okay|alright|all right|go ahead|do it|please do|of course|absolutely|let's do it|go for it|let's go$|proceed|sounds good|do that|confirm(?:ed)?|definitely|certainly|mm+ ?hmm+|uh ?huh|please$)\b/;
// Thinking out loud while Flash waits for a yes or no.
const UNSURE = /^(?:h+m+|u+m+|u+h+|e+r+m*|wait|hold on|one sec(?:ond)?|let me think|i don't know|not sure|i'm not sure|maybe|how much(?: is it| does it cost)?|what does it cost)$/;
const NO = /^(?:no|nope|nah|cancel|don't|do not|never mind|nevermind|not now|skip it|skip)\b/;
const BYE =
  /^(?:(?:ok|okay|thanks|thank you|great)\s+)*(?:bye(?: bye)?|goodbye|good bye|stop listening|that's all|that is all|that's it|end (?:the )?(?:call|conversation|chat)|hang up)(?:\s+(?:flash|for now|thanks|thank you))*$/;
const AGAIN = /^(?:sorry|pardon|what|huh|come again|what did you say|(?:(?:can|could) you )?(?:please )?(?:say|repeat) (?:that|it|this)(?: again)?(?: please)?|repeat(?: that)?(?: please)?)$/;
// Sounds people make before answering: "hmm, okay", "um, no".
const FILLER = /^(?:(?:h+m+|u+m+|u+h+|e+r+m*|a+h+|o+h+|well|so) )+/;
// What was said, and the same without the sounds before it.
const withoutFiller = (said: string) => [said, said.replace(FILLER, "")];

// Sounds a transcript marks instead of words: "(laughs)", "[music]", "(background noise)".
const SOUND_TAGS = /\([^()]{1,40}\)|\[[^[\]]{1,40}\]/g;

/** The words of a heard turn without sound tags; "" when only sounds were heard. */
export function heardWords(transcript: string): string {
  const words = transcript.replace(SOUND_TAGS, " ").replace(/\s+/g, " ").trim();
  return /[\p{L}\p{N}]/u.test(words) ? words : "";
}

/*
 * Yes, no, goodbye, "not sure" and "say that again" in the language Flash is shown in, as lists of
 * words split by commas. They're heard as well as the English ones: pass t(YES_WORDS) and so on to
 * isYes, isNo, isGoodbye, isUnsure and isRepeat.
 */
export const YES_WORDS = msg("yes, yeah, sure, okay, go ahead, do it");
export const NO_WORDS = msg("no, cancel, not now, skip it");
export const GOODBYE_WORDS = msg("bye, goodbye, that's all, stop listening");
export const UNSURE_WORDS = msg("hmm, um, wait, hold on, let me think, I'm not sure, maybe, how much is it");
export const REPEAT_WORDS = msg("say that again, repeat that, sorry, pardon, what did you say");

// A translated list's words, as plain words. Commas of other scripts (，、،) split it too.
const wordList = (list: string) => list.split(/[,，、،]/).map(plain).filter(Boolean);
// Whether what was said starts with one of the words, as a whole word or phrase.
const startsWithOne = (said: string, list: string) => wordList(list).some((w) => said === w || said.startsWith(`${w} `));
// Whether what was said is one of the words and nothing more.
const isOne = (said: string, list: string) => wordList(list).includes(said);

// Chinese, Japanese and Thai are written without spaces, so there a short answer is a few letters.
const UNSPACED = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}]/u;
const isShort = (said: string) => said.split(" ").length <= 6 && (!UNSPACED.test(said) || said.replace(/ /g, "").length <= 15);

/**
 * A short "yes" to a question Flash asked (like going ahead with a costly request). words: more
 * ways to say yes, as a translated list (see YES_WORDS).
 */
export const isYes = (heard: string, words = "") => {
  const p = plain(heard);
  return withoutFiller(p).some((s) => YES.test(s) || startsWithOne(s, words)) && !/\b(?:no|not|don't)\b/.test(p) && isShort(p);
};
/** A short "no"; words: more ways to say it (see NO_WORDS). */
export const isNo = (heard: string, words = "") => withoutFiller(plain(heard)).some((s) => NO.test(s) || startsWithOne(s, words));
/**
 * "Hmm", "wait", "how much?": neither yes nor no, so Flash asks again instead of dropping its
 * question. words: more ways to say it, said on their own (see UNSURE_WORDS).
 */
export const isUnsure = (heard: string, words = "") => {
  const p = plain(heard);
  return UNSURE.test(p) || isOne(p, words);
};
/**
 * "Say that again", "Sorry?", "What did you say?": Flash says its last answer again, without
 * asking the chat. words: more ways to say it, said on their own (see REPEAT_WORDS).
 */
export const isRepeat = (heard: string, words = "") => {
  const p = plain(heard);
  return AGAIN.test(p) || isOne(p, words);
};
/**
 * "Bye", "that's all", "stop listening": ends the conversation. "That's it?" is a question, not a
 * goodbye. words: more ways to say it, said on their own (see GOODBYE_WORDS).
 */
export const isGoodbye = (heard: string, words = "") => {
  if (/[?？؟]\s*$/.test(heard)) return false;
  const p = plain(heard);
  return BYE.test(p) || wordList(words).some((w) => p === w || p === `${w} flash`);
};

/**
 * What a reply to Flash's "Say yes to go ahead, or no to skip it" means: "yes", "no", or "unsure"
 * (thinking out loud, so Flash asks again and the costly request keeps waiting). null is anything
 * else: a new request. words: the translated lists, t(YES_WORDS), t(NO_WORDS) and t(UNSURE_WORDS).
 */
export function confirmReply(heard: string, words: { yes?: string; no?: string; unsure?: string } = {}): "yes" | "no" | "unsure" | null {
  // "Euh, oui": a sound of thinking before the answer, in the language Flash is shown in as in English.
  const said = plain(heard);
  const lead = wordList(words.unsure ?? "").find((w) => said.startsWith(`${w} `));
  const answers = lead ? [heard, said.slice(lead.length + 1)] : [heard];
  if (answers.some((a) => isYes(a, words.yes))) return "yes";
  if (answers.some((a) => isNo(a, words.no))) return "no";
  if (isUnsure(heard, words.unsure)) return "unsure";
  return null;
}

// Recording a turn (browsers that can't recognise speech themselves): the microphone's loudness is
// read every TURN_TICK_MS. A turn ends after END_SILENCE_MS of silence, gives up when nobody speaks
// for NO_SPEECH_MS, and never runs longer than MAX_TURN_MS. A voice is louder than MIN_LEVEL (RMS)
// and three times the room for two ticks in a row; a turn needs MIN_SPEECH_MS of it, so a short
// "yes" counts and a click doesn't.
export const TURN_TICK_MS = 40;
const MIN_LEVEL = 0.02;
const MIN_SPEECH_MS = 120;
const END_SILENCE_MS = 1200;
const NO_SPEECH_MS = 12_000;
const MAX_TURN_MS = 30_000;

/** Hears where one recorded turn ends, from the microphone's loudness a tick at a time. */
export class TurnEnd {
  // How loud the room is (RMS), learnt from quiet moments and passed from one turn to the next.
  floor: number;
  private started: number;
  private speechAt = 0;
  private lastVoice = 0;
  // How long the voice has been loud this turn, and for how many ticks in a row.
  private voiced = 0;
  private streak = 0;

  /** started: when listening began. floor: the room's level from the turn before (0 when unknown). */
  constructor(started: number, floor = 0) {
    this.started = started;
    this.floor = floor;
  }

  /** The level (RMS) heard at now: "spoke" ends the turn with words to hear, "silent" with none; null listens on. */
  tick(level: number, now: number): "spoke" | "silent" | null {
    // The room's level follows quiet moments quickly and loud ones slowly (barely while someone
    // talks), so words said straight away are never taken for the room.
    this.floor = !this.floor
      ? Math.min(level, 0.01)
      : this.floor + (level - this.floor) * (level < this.floor ? 0.3 : this.speechAt ? 0.001 : 0.02);
    this.streak = level > Math.max(MIN_LEVEL, this.floor * 3) ? this.streak + 1 : 0;
    // Two loud ticks in a row is a voice; one is a click.
    if (this.streak >= 2) {
      if (!this.speechAt) this.speechAt = now - TURN_TICK_MS;
      this.voiced += this.streak === 2 ? 2 * TURN_TICK_MS : TURN_TICK_MS;
      this.lastVoice = now;
    }
    if (this.speechAt && now - this.lastVoice > END_SILENCE_MS) {
      if (this.voiced >= MIN_SPEECH_MS) return "spoke";
      // A click or a knock: keep listening.
      this.speechAt = 0;
      this.voiced = 0;
    } else if (!this.speechAt && now - this.started > NO_SPEECH_MS) return "silent";
    else if (this.speechAt && now - this.speechAt > MAX_TURN_MS) return "spoke";
    return null;
  }
}

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

/**
 * Markdown as a voice should say it, in the language t speaks: each line or list item its own
 * sentence (so the voice pauses between them), and links and emoji left on screen rather than spelt out.
 */
export function sayable(markdown: string, t: Translate = english): string {
  const link = t("the link on your screen");
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\n+/)
    .map((line) =>
      speakable(line)
        .replace(/<?(?:\bhttps?:\/\/|\bwww\.)[^\s>]*>?/gi, () => link)
        .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "")
        .trim(),
    )
    .filter(Boolean)
    .map((line) => (/[.!?…:;,]$/.test(line) ? line : `${line}.`))
    .join(" ");
}

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
  const text = sayable(written.replace(/^\s*\|.*\|\s*$/gm, " "), t);
  if (!text) return { say: madeNote(m, t) || t("Done. It's on your screen."), confirm: false };
  const short = shorten(text, MAX_SPOKEN_CHARS);
  if (short.length < text.length) return { say: t("{answer} The rest is on your screen.", { answer: short }), confirm: false };
  if (hidden) return { say: t("{answer} The details are on your screen.", { answer: short }), confirm: false };
  return { say: short, confirm: false };
}

/**
 * The finished sentences at the start of a reply that is still being written, up to max
 * characters: what Flash can start saying before the reply is done, in the language t speaks.
 * Empty for code, tables and things Flash makes, which voiceReply describes instead.
 */
export function sayFirst(m: VoiceMessage, t: Translate = english, max = 200): string {
  if (m.error || m.stopped || m.app || m.images?.length || m.videos?.length || m.audio || /```|^\s*\|/m.test(m.content)) return "";
  const text = sayable(m.content, t);
  let end = 0;
  for (const match of text.matchAll(/[.!?…](?=\s)/g)) {
    if (match.index + 1 > max) break;
    end = match.index + 1;
  }
  return text.slice(0, end);
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
