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

// Sounds a transcript marks instead of words: "(laughs)", "[music]", "(background noise)".
const SOUND_TAGS = /\([^()]{1,40}\)|\[[^[\]]{1,40}\]/g;

/** The words of a heard turn without sound tags; "" when only sounds were heard. */
export function heardWords(transcript: string): string {
  const words = transcript.replace(SOUND_TAGS, " ").replace(/\s+/g, " ").trim();
  return /[\p{L}\p{N}]/u.test(words) ? words : "";
}

// Words only, lowercase, so "Yes!" and "yes." read the same.
const plain = (text: string) =>
  text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^\p{L}\p{M}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

// A whole word: not part of a longer one.
const word = (source: string) => new RegExp(`(?<![\\p{L}\\p{M}\\p{N}'])(?:${source})(?![\\p{L}\\p{M}\\p{N}'])`, "gu");
// Sounds written however long they were held ("hmmm", "ummm", "Mm-hmm"), as one spelling each.
const SOUND_SPELLINGS: [RegExp, string][] = [
  [word("m+ ?h+m+"), "mm hmm"],
  [word("u+h+ ?h+u+h+"), "uh huh"],
  [word("h+m+"), "hmm"],
  [word("m{2,}"), "mm"],
  [word("u+h*m+"), "um"],
  [word("u+h+"), "uh"],
  [word("e+r+m*"), "er"],
  [word("a+h+"), "ah"],
  [word("o+h+"), "oh"],
];
/** What was said, as plain words with the sounds of thinking spelt one way. */
const spoken = (text: string) => SOUND_SPELLINGS.reduce((said, [sound, spelling]) => said.replace(sound, spelling), plain(text));

// A list of words split by commas, as plain words. Commas of other scripts (，、،) split it too.
const wordList = (list = "") => list.split(/[,，、،]/).map(spoken).filter(Boolean);

/*
 * The short answers Flash understands in English, whatever language it's shown in. Each kind of
 * answer is also heard in that language, from the translated lists below.
 */
const EN = {
  yes: wordList(
    "yes, yeah, yep, yup, ya, yea, sure, sure thing, ok, okay, alright, all right, go ahead, go on, go for it, do it, do that, please do, of course, " +
      "absolutely, let's do it, let's do that, let's do this, proceed, sounds good, that's fine, fine, confirm, confirmed, definitely, certainly, " +
      "mm hmm, uh huh, no problem, not a problem, no worries, why not, i agree, agreed, you bet, carry on, continue, that works",
  ),
  // Yes only with nothing but courtesy after it: "Let's go!", but not "let's go to the beach".
  alone: wordList("let's go, go"),
  // Courtesy that's also a yes when said on its own: "Perfect.", "Great, go ahead", but "cool, what's the weather?" is a new request.
  praise: wordList("perfect, great, cool, good, nice, awesome, excellent"),
  no: wordList(
    "no, nope, nah, no no, cancel, don't, do not, don't do it, never mind, nevermind, not now, not yet, not today, skip, skip it, stop, " +
      "no thanks, no thank you, forget it, maybe later, maybe not, no way, pass, i'll pass, leave it",
  ),
  unsure: wordList(
    "wait, hold on, hang on, one sec, one second, just a sec, just a second, a moment, just a moment, one moment, let me think, let me see, " +
      "let me check, i'm not sure, i am not sure, not sure, i don't know, don't know, dunno, no idea, i have no idea, maybe, perhaps, i guess, " +
      "i think so, how much, how much is it, how much does it cost, how much will it cost, what does it cost, what's the price, what is the price, " +
      "how many credits, too expensive, too much, expensive, that's expensive, that's a lot, cheaper, later",
  ),
  sounds: wordList("hmm, mm, um, uh, er, ah, oh, well, so"),
  // Courtesy around an answer.
  polite: wordList("please, thanks, thank you, flash, now, then, right away"),
  // The little words Chinese, Japanese and Thai end a sentence with (not their question words: 吗, 呢, か, ไหม, คะ).
  particles: wordList("吧, 啊, 呀, 啦, 哦, 喔, 了, ね, よ, です, ครับ, ค่ะ, นะ, จ้ะ, จ้า"),
  bye: wordList("bye, bye bye, goodbye, good bye, stop listening, end the call, end call, end the conversation, end conversation, end the chat, end chat, hang up"),
  // "That's it" ends a conversation, or asks "That's it?": a goodbye only with a closer or a full stop.
  ending: wordList("that's all, that is all, that's it, that'll be all"),
  closers: wordList("thanks, thank you, for now, flash"),
  acks: wordList("ok, okay, great, alright, all right, so"),
};

/*
 * Yes, no, goodbye, "not sure" and "say that again" in the language Flash is shown in, as lists of
 * words split by commas. They're heard as well as the English ones: pass t(YES_WORDS) and so on to
 * confirmReply, isGoodbye and isRepeat.
 */
export const YES_WORDS = msg("yes, yeah, sure, okay, go ahead, do it");
export const NO_WORDS = msg("no, cancel, not now, skip it");
export const GOODBYE_WORDS = msg("bye, goodbye, that's all, stop listening");
// Goodbyes that can also be asked ("That's it?"), so they end the conversation only with a closer or a full stop.
export const ENDING_WORDS = msg("that's all, that's it");
// Thinking out loud while Flash waits for a yes or no.
export const UNSURE_WORDS = msg("wait, hold on, let me think, I'm not sure, maybe, how much is it");
// Sounds people make while they think, which are no answer by themselves.
export const SOUND_WORDS = msg("hmm, um, uh");
// Courtesy said with an answer: "yes please", "go ahead, thanks".
export const POLITE_WORDS = msg("please, thanks, thank you");
export const REPEAT_WORDS = msg("say that again, repeat that, sorry, pardon, what did you say");

// Chinese, Japanese and Thai are written without spaces between words.
const UNSPACED = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}]/u;
const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;

/** The words of what was said: split at spaces, and where there are none by the browser's dictionary. */
function wordsOf(said: string): { word: string; at: number }[] {
  if (!segmenter || !UNSPACED.test(said)) {
    let at = 0;
    return said.split(" ").map((w) => ({ word: w, at: (at += w.length + 1) - w.length - 1 }));
  }
  return [...segmenter.segment(said)].filter((s) => s.segment.trim()).map((s) => ({ word: s.segment, at: s.index }));
}

type Kind = "yes" | "alone" | "no" | "unsure" | "sound" | "polite" | "bye" | "ending" | "closer" | "ack" | "again";
type Phrase = { text: string; kind: Kind };

/** The phrases to listen for, longest first, and the more careful kind first when one is listed twice. */
function phraseBook(kinds: [Kind, string[]][]): Phrase[] {
  const order: Kind[] = ["no", "unsure", "sound", "yes", "alone", "polite", "bye", "ending", "closer", "ack", "again"];
  return kinds
    .flatMap(([kind, list]) => list.map((text) => ({ text, kind })))
    .sort((a, b) => b.text.length - a.text.length || order.indexOf(a.kind) - order.indexOf(b.kind));
}

/**
 * What was said, read as listed phrases from the start: each must end where a word does, so "oui"
 * isn't heard in "ouille" nor 对 (yes) in 对不起 (sorry). Where words aren't spaced, a phrase may also
 * end where another listed one starts (好的好的). Stops at the first words that aren't listed: rest
 * is what's left, "" when every word was read.
 */
function readPhrases(said: string, book: Phrase[]): { phrases: Phrase[]; rest: string } {
  const words = wordsOf(said);
  const edges = new Set([said.length, ...words.flatMap((w) => [w.at, w.at + w.word.length])]);
  const unspaced = (at: number) => UNSPACED.test(said[at - 1] ?? "") && UNSPACED.test(said[at] ?? "");
  // A listed phrase starting at at, ending at a word's end or, without spaces, where another one starts.
  const reads = new Map<number, Phrase | null>();
  const phraseAt = (at: number): Phrase | null => {
    if (reads.has(at)) return reads.get(at)!;
    reads.set(at, null);
    const found =
      book.find((p) => {
        if (!said.startsWith(p.text, at)) return false;
        const end = at + p.text.length;
        return edges.has(end) || (unspaced(end) && phraseAt(end) !== null);
      }) ?? null;
    reads.set(at, found);
    return found;
  };
  const phrases: Phrase[] = [];
  let at = 0;
  while (at < said.length) {
    const p = phraseAt(at);
    if (!p) break;
    phrases.push(p);
    at += p.text.length;
    if (said[at] === " ") at++;
  }
  return { phrases, rest: said.slice(at) };
}

// A reply this short with more than an answer in it is about the question; a longer one is a new request.
const SHORT_WORDS = 10;

export type AnswerWords = { yes?: string; no?: string; unsure?: string; sounds?: string; polite?: string };

/**
 * What a reply to Flash's "Say yes to go ahead, or no to skip it" means: "yes", "no", or "unsure"
 * (thinking out loud, so Flash asks again and the costly request keeps waiting). null is anything
 * else: a new request. A reply is "yes" only when every word of it is consent, courtesy or a sound
 * of thinking before it: "sure, but cheaper", "do it later" and "okay, wait" are unsure, since a
 * wrong yes spends the user's credits. words: the translated lists, t(YES_WORDS), t(NO_WORDS),
 * t(UNSURE_WORDS), t(SOUND_WORDS) and t(POLITE_WORDS).
 */
export function confirmReply(heard: string, words: AnswerWords = {}): "yes" | "no" | "unsure" | null {
  const said = spoken(heard);
  if (!said) return null;
  const book = phraseBook([
    ["yes", [...EN.yes, ...wordList(words.yes)]],
    ["alone", EN.alone],
    ["no", [...EN.no, ...wordList(words.no)]],
    ["unsure", [...EN.unsure, ...wordList(words.unsure)]],
    ["sound", [...EN.sounds, ...wordList(words.sounds)]],
    ["polite", [...EN.polite, ...EN.particles, ...EN.praise, ...wordList(words.polite)]],
  ]);
  const { phrases, rest } = readPhrases(said, book);
  // Sounds and courtesy before the answer: "um, yes", "oh no", "please, go ahead".
  const answer = phrases.findIndex((p) => p.kind !== "sound" && p.kind !== "polite");
  const first = phrases[answer];
  // Neither yes nor no in it: a new request, unless it's short and thinks out loud somewhere.
  if (!first && rest) return hesitates(said, book) ? "unsure" : null;
  if (first?.kind === "no") return "no";
  if (first?.kind === "unsure") return "unsure";
  // After the yes, only more yes and courtesy, and no sound after the last of it ("okay, um" is still thinking).
  const after = phrases.slice(answer < 0 ? 0 : answer + 1);
  const consent = !rest && after.every((p) => p.kind === "yes" || p.kind === "alone" || p.kind === "polite" || p.kind === "sound");
  const last = phrases.filter((p) => p.kind !== "polite").at(-1);
  if (first?.kind === "alone" && !(consent && after.every((p) => p.kind === "polite"))) return hesitates(said, book) ? "unsure" : null;
  if (!first) {
    // Courtesy alone: "please" and "perfect" are a yes, "thanks" or "hmm" no answer yet.
    return phrases.some((p) => p.text === "please" || EN.praise.includes(p.text)) && phrases.at(-1)?.kind !== "sound" ? "yes" : "unsure";
  }
  if (consent && last?.kind !== "sound") return "yes";
  // A yes with more said ("sure, but cheaper", "do it later"): asked again, unless it's a new request.
  return wordsOf(said).length <= SHORT_WORDS ? "unsure" : null;
}

/** Whether a short reply that isn't an answer thinks out loud somewhere: "Make it cheaper, maybe?" */
function hesitates(said: string, book: Phrase[]): boolean {
  const words = wordsOf(said);
  return words.length <= SHORT_WORDS && words.some((w) => readPhrases(said.slice(w.at), book).phrases[0]?.kind === "unsure");
}

/** A "yes" to a question Flash asked (see confirmReply). words: more ways to say yes (see YES_WORDS), or every list. */
export const isYes = (heard: string, words: string | AnswerWords = "") => confirmReply(heard, typeof words === "string" ? { yes: words } : words) === "yes";
/** A "no" (see confirmReply). words: more ways to say it (see NO_WORDS), or every list. */
export const isNo = (heard: string, words: string | AnswerWords = "") => confirmReply(heard, typeof words === "string" ? { no: words } : words) === "no";

/** Nothing but sounds of thinking ("Um."), which are no request: Flash listens on. sounds: t(SOUND_WORDS). */
export function onlySounds(heard: string, sounds = ""): boolean {
  const said = spoken(heard);
  // Read with the yes words too, so "mm-hmm" is heard as the yes it is.
  const { phrases, rest } = readPhrases(said, phraseBook([["sound", [...EN.sounds, ...wordList(sounds)]], ["yes", ["mm hmm", "uh huh"]]]));
  return Boolean(said) && !rest && phrases.every((p) => p.kind === "sound");
}

/**
 * A word or two that trails off before a pause ("What…", "So, um,", "I want—"), as a transcript
 * writes it: the request is still coming. Chrome writes no punctuation, so there it's never so.
 */
export function trailsOff(heard: string): boolean {
  return /(?:\.{2,}|…|[,،，、]|-+|—)\s*$/.test(heard.trim()) && wordsOf(spoken(heard)).length <= 2;
}

/**
 * What a turn heard is before it goes to the chat: "hold" when it trails off ("What…") while Flash
 * isn't waiting for a yes or no, as more is coming; "again" when it asks for the last answer again
 * ("What?", "Say that again"); null to ask. again: t(REPEAT_WORDS); more: t(SOUND_WORDS) and t(POLITE_WORDS).
 */
export function beforeAsking(
  heard: string,
  { confirming, last, again = "", sounds, polite }: { confirming: boolean; last: string; again?: string; sounds?: string; polite?: string },
): "hold" | "again" | null {
  if (!confirming && trailsOff(heard)) return "hold";
  return last && isRepeat(heard, again, { sounds, polite }) ? "again" : null;
}

// "Say that again", "Can you repeat that please", "Sorry?".
const AGAIN = /^(?:sorry|pardon|what|huh|come again|what did you say|(?:(?:can|could) you )?(?:please )?(?:say|repeat) (?:that|it|this)(?: again)?(?: please)?|repeat(?: that)?(?: please)?)$/;

/**
 * "Say that again", "Sorry?", "What did you say?": Flash says its last answer again, without
 * asking the chat. words: more ways to say it, said on their own or with courtesy (see
 * REPEAT_WORDS); more: t(SOUND_WORDS) and t(POLITE_WORDS).
 */
export function isRepeat(heard: string, words = "", more: { sounds?: string; polite?: string } = {}): boolean {
  const said = spoken(heard);
  if (AGAIN.test(said)) return true;
  const { phrases, rest } = readPhrases(
    said,
    phraseBook([
      ["again", wordList(words)],
      ["sound", [...EN.sounds, ...wordList(more.sounds)]],
      ["polite", [...EN.polite, ...EN.particles, ...wordList(more.polite)]],
    ]),
  );
  return !rest && phrases.some((p) => p.kind === "again");
}

/**
 * "Bye", "stop listening", "that's all, thanks": ends the conversation. "That's it?" is a question,
 * not a goodbye, and so is "that's it" heard with no punctuation (Chrome writes none): a goodbye
 * that can be asked counts only with a closer ("thanks", "bye") or a full stop. words: more ways to
 * say goodbye (see GOODBYE_WORDS); more: t(ENDING_WORDS), the ones that can be asked, and
 * t(POLITE_WORDS) and t(SOUND_WORDS).
 */
export function isGoodbye(heard: string, words = "", more: { ending?: string; polite?: string; sounds?: string } = {}): boolean {
  if (/[?？؟]\s*$/.test(heard)) return false;
  const said = spoken(heard);
  const ending = [...EN.ending, ...wordList(more.ending)];
  const { phrases, rest } = readPhrases(
    said,
    phraseBook([
      ["bye", [...EN.bye, ...wordList(words).filter((w) => !ending.includes(w))]],
      ["ending", ending],
      ["closer", [...EN.closers, ...wordList(more.polite)]],
      ["ack", [...EN.acks, ...EN.particles, ...EN.sounds, ...wordList(more.sounds)]],
    ]),
  );
  if (rest || !said) return false;
  if (phrases.some((p) => p.kind === "bye")) return true;
  return phrases.some((p) => p.kind === "ending") && (phrases.some((p) => p.kind === "closer") || /[.!。！]\s*$/.test(heard));
}

// Recording a turn (browsers that can't recognise speech themselves): the microphone's loudness is
// read every TURN_TICK_MS. A turn ends after END_SILENCE_MS of silence, gives up when nobody speaks
// for NO_SPEECH_MS, and never runs longer than MAX_TURN_MS. A voice is louder than MIN_LEVEL (RMS),
// three times the quiet room, and ROOM_MARGIN times the talking in the room (a television) for two
// ticks in a row; a turn needs MIN_SPEECH_MS of it, so a short "yes" counts and a click doesn't.
export const TURN_TICK_MS = 40;
const MIN_LEVEL = 0.02;
const MIN_SPEECH_MS = 120;
const END_SILENCE_MS = 1200;
// After a word or a sound ("um…"), someone who isn't answering yes or no may still be finding their words.
const SHORT_SPEECH_MS = 500;
const THINKING_SILENCE_MS = 2000;
const NO_SPEECH_MS = 12_000;
const MAX_TURN_MS = 30_000;
// The talking in the room is the loud end (ROOM_SHARE) of what was heard outside a turn in the last
// ROOM_WINDOW_MS, so a knock is forgotten and a television isn't.
const ROOM_WINDOW_MS = 2500;
const ROOM_SHARE = 0.9;
const ROOM_MARGIN = 1.5;
// In a turn, a moment this much quieter than the turn's own voice is a pause, whatever else is heard,
// when there is other talking in the room or nothing is known of it yet. In a room known to be quiet
// a voice may drop (someone turning their head) and still be heard.
const PAUSE_SHARE = 0.4;
// How long the room must be heard before what's heard is known as the room.
const ROOM_KNOWN_MS = 400;

/** The value a share of the way up the sorted values (0.5: the median). */
const shareOf = (values: number[], share: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] : 0;
};

/** Hears where one recorded turn ends, from the microphone's loudness a tick at a time. */
export class TurnEnd {
  // How loud the room is (RMS), learnt from quiet moments and passed from one turn to the next.
  floor: number;
  // How loud other talking in the room is (a television), passed from one turn to the next.
  room: number;
  private started: number;
  private patient: boolean;
  // Whether the room's talking was measured, here or in a turn before (room above 0).
  private known: boolean;
  private speechAt = 0;
  private lastVoice = 0;
  // How long the voice has been loud this turn, and for how many ticks in a row.
  private voiced = 0;
  private streak = 0;
  // What was heard outside a turn lately, and how loud the voice was in this one.
  private around: number[] = [];
  private voice: number[] = [];

  /**
   * started: when listening began. floor and room: the room's levels from the turn before (0 when
   * unknown). patient: wait longer after only a word or a sound, as when Flash isn't waiting for a yes or no.
   */
  constructor(started: number, floor = 0, { room = 0, patient = false }: { room?: number; patient?: boolean } = {}) {
    this.started = started;
    this.floor = floor;
    this.room = room;
    this.patient = patient;
    this.known = room > 0;
  }

  /** The level (RMS) heard at now: "spoke" ends the turn with words to hear, "silent" with none; null listens on. */
  tick(level: number, now: number): "spoke" | "silent" | null {
    // The room's level follows quiet moments quickly and loud ones slowly (barely while someone
    // talks), so words said straight away are never taken for the room.
    this.floor = !this.floor
      ? Math.min(level, 0.01)
      : this.floor + (level - this.floor) * (level < this.floor ? 0.3 : this.speechAt ? 0.001 : 0.02);
    const pause = this.speechAt && (!this.known || this.room * ROOM_MARGIN > MIN_LEVEL) ? PAUSE_SHARE * shareOf(this.voice, 0.5) : 0;
    const loud = level > Math.max(MIN_LEVEL, this.floor * 3, this.room * ROOM_MARGIN, pause);
    this.streak = loud ? this.streak + 1 : 0;
    if (!this.speechAt && !loud) {
      // Outside a turn, what's heard is the room: a television's talking raises the bar for a voice.
      this.around.push(level);
      if (this.around.length > ROOM_WINDOW_MS / TURN_TICK_MS) this.around.shift();
      const heard = shareOf(this.around, ROOM_SHARE);
      // Until a moment of the room has been heard, the level from the turn before still counts.
      if (this.around.length * TURN_TICK_MS >= ROOM_KNOWN_MS) this.known = true;
      this.room = this.around.length * TURN_TICK_MS >= ROOM_KNOWN_MS ? heard : Math.max(this.room, heard);
    }
    // Two loud ticks in a row is a voice; one is a click.
    if (this.streak >= 2) {
      if (!this.speechAt) this.speechAt = now - TURN_TICK_MS;
      this.voiced += this.streak === 2 ? 2 * TURN_TICK_MS : TURN_TICK_MS;
      this.lastVoice = now;
      this.voice.push(level);
    }
    const wait = this.patient && this.voiced < SHORT_SPEECH_MS ? THINKING_SILENCE_MS : END_SILENCE_MS;
    if (this.speechAt && now - this.lastVoice > wait) {
      if (this.voiced >= MIN_SPEECH_MS) return "spoke";
      // A click or a knock: keep listening.
      this.speechAt = 0;
      this.voiced = 0;
      this.voice = [];
    } else if (!this.speechAt && now - this.started > NO_SPEECH_MS) return "silent";
    else if (this.speechAt && now - this.speechAt > MAX_TURN_MS) {
      // Talking that never pauses is more often a television than a person: the next turn must be louder than it.
      this.room = Math.max(this.room, shareOf(this.voice, 0.5));
      return "spoke";
    }
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
export function voiceReply(m: VoiceMessage, t: Translate = english): { say: string; confirm: boolean; stopped?: boolean } {
  // The price question is written by the server.
  if (m.error && m.errorCode === "confirm_cost") return { say: t("{cost} Say yes to go ahead, or no to skip it.", { cost: m.error }), confirm: true };
  if (m.error) return { say: m.error, confirm: false };
  if (m.stopped) return { say: t("Stopped."), confirm: false, stopped: true };
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
