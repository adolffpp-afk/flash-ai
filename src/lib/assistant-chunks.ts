/*
 * How an assistant's files are cut into chunks and searched (see server/assistant-search.ts).
 * Pure, and the same for the browser and the server.
 *
 * Chunks don't overlap: in order, they are the file's text. Every word goes into one search index
 * shared by every assistant, tagged with its assistant (tagOf), so a search reads only that
 * assistant's words and can't match anyone else's, and which words count is decided by how many of
 * that assistant's own chunks have them (tells). How the matches are ordered is BM25 (rankChunks).
 */
import { CHUNK_CHARS } from "./assistants.ts";

/**
 * A chunk of a file. Its label says where in the file it is: "4" for page 4, "Slide 3" or "Sheet:
 * Prices", from the markers the file readers write, or "part n" before any marker. A chunk that
 * runs from one page, slide or sheet into the next is labelled with its first and last, on two
 * lines ("4\n6"): see labelEnds.
 */
export type Chunk = { seq: number; label: string; body: string };

// The markers the file readers write (see pdf-text.ts and office.ts). A longer line is not one: a
// label is a heading, never a copy of the file's text (Excel keeps sheet names to 31 characters).
const MARKER = /^--- (?:Page (\d{1,6})|Slide (\d{1,6})|Sheet: (.{1,100}?)) ---$/gm;

/** The first and last page, slide or sheet of a chunk's label (see Chunk). */
export function labelEnds(label: string): [string, string] {
  const [first, last = first] = label.split("\n");
  return [first, last];
}

const sentences = new Intl.Segmenter("en", { granularity: "sentence" });
const low = (c: string | undefined) => c !== undefined && /[\uDC00-\uDFFF]/.test(c);

/**
 * Where the chunk that starts at `start` ends: at `marker`, the start of the last page, slide or
 * sheet before `start + size`, if there is one, else at a paragraph, line, sentence or word break
 * when one is near enough.
 */
function cutAt(text: string, start: number, size: number, marker: number | undefined): number {
  const end = start + size;
  const window = text.slice(start, end);
  const last = (re: RegExp, from: number) => {
    let found = -1;
    for (const m of window.matchAll(re)) if (m.index + m[0].length >= from) found = m.index + m[0].length;
    return found;
  };
  if (marker !== undefined) return marker;
  const half = Math.ceil(size / 2);
  for (const re of [/\n[^\S\n]*\n\s*/g, /\n\s*/g]) {
    const at = last(re, half);
    if (at > 0) return start + at;
  }
  let sentence = -1;
  for (const s of sentences.segment(window)) if (s.index >= half && s.index > 0) sentence = s.index;
  if (sentence > 0) return start + sentence;
  const word = last(/\s+/g, half);
  if (word > 0) return start + word;
  // One long run with no break: cut, but not inside a character, and not before a mark that
  // belongs to the letter before it, unless the marks run on for half a chunk.
  const mark = (at: number) => low(text[at]) || /\p{M}/u.test(text[at]);
  let at = end;
  while (at > start + half && mark(at)) at--;
  if (!mark(at)) return at;
  return low(text[end]) ? end - 1 : end;
}

/**
 * The text in chunks of at most `size` characters, cut where a page, slide or sheet starts, or at a
 * paragraph, line, sentence or word break where it can be. Joined in order, the chunks give back
 * the text exactly. Short pages share a chunk, labelled with its first and last page.
 */
export function chunkText(text: string, size = CHUNK_CHARS): Chunk[] {
  const marks = [...text.matchAll(MARKER)].map((m) => ({
    at: m.index,
    label: m[1] ?? (m[2] ? `Slide ${m[2]}` : `Sheet: ${m[3]}`),
  }));
  /** The last marker that starts before `at`, or -1. */
  const before = (at: number) => {
    let lo = 0;
    let hi = marks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (marks[mid].at < at) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  };
  const chunks: Chunk[] = [];
  for (let start = 0; start < text.length; ) {
    let end = text.length;
    if (text.length - start > size) {
      const m = marks[before(start + size)];
      end = cutAt(text, start, size, m && m.at > start ? m.at : undefined);
    }
    const body = text.slice(start, end);
    const first = before(start + Math.max(0, body.search(/\S/)) + 1);
    const last = before(start + Math.max(0, body.search(/\S\s*$/)) + 1);
    const label = first < 0 ? `part ${chunks.length + 1}` : last > first ? `${marks[first].label}\n${marks[last].label}` : marks[first].label;
    chunks.push({ seq: chunks.length, label, body });
    start = end;
  }
  return chunks;
}

const segments = new Intl.Segmenter("en", { granularity: "word" });
// Longer runs (a key, a long number, base64) are never what someone asks about.
const MAX_WORD = 64;

// Latin accents, Hebrew points, and Arabic vowel marks, hamzas and tatweel: words are written with
// and without them, and typed without.
const MARKS = /[̀-֑ͯ-ׇؐ-ؚـً-ٰٟۖ-ۭ]/g;
// Letters Arabic and Persian write two ways, as one: Persian yeh "ی" and alef maqsura "ى" as yeh
// "ي", keheh "ک" as kaf "ك", teh marbuta "ة" and heh with yeh above "ۀ" as heh "ه".
const LETTERS: Record<string, string> = { "ی": "ي", "ى": "ي", "ک": "ك", "ة": "ه", "ۀ": "ه" };
const VARIANTS = /[ةىکۀی]/g;
// Latin letters with a stroke or a slash, and those written as two, which have no accent to take
// off but are typed without it: "płatność" is "platnosc", "đơn" "don", "købe" "kobe", "fiyatı"
// "fiyati", "Größe" "grosse", "cœur" "coeur".
const STROKES: Record<string, string> = { ł: "l", đ: "d", ð: "d", ø: "o", ı: "i", ħ: "h", ŧ: "t", ƀ: "b", ɨ: "i", ß: "ss", æ: "ae", œ: "oe" };
const STROKED = /[łđðøıħŧƀɨßæœ]/g;
// Digits of other scripts as the 0-9 spreadsheets and most PDFs write: a Persian keyboard types
// "۳۰۷۰۷", an Arabic one "٣٠٧٠٧", and both are "30707", as are "३०७०७" and "๓๐๗๐๗".
const DIGITS = /[^\P{Nd}0-9]/gu;
const DIGIT = /\p{Nd}/u;
/** A digit's value: Unicode keeps each script's digits together, 0 to 9 in order, and where two scripts' digits meet, each still starts at 0. */
function digit(d: string): string {
  const at = d.codePointAt(0)!;
  let zero = at;
  while (DIGIT.test(String.fromCodePoint(zero - 1))) zero--;
  return String((at - zero) % 10);
}
// Everything but Thai and Lao goes to NFKC before the split, so "CO₂" is "co2" and "m²" "m2". Not
// those two: NFKC cuts Thai and Lao "ำ" in two and writes Lao "ໜ" as two letters, which the
// splitter doesn't expect ("สินค้า" would come out as "สิน" and "ค้า").
const NFKC_FIRST = /[^\p{Script=Thai}\p{Script=Lao}]+/gu;
// For the same reason, what's written that way goes back to one letter before the split: Thai and
// Lao "ำ" as its two halves (as many Thai PDFs give it, a tone mark before or between them), Lao
// "ໜ" and "ໝ" as two letters, and Malayalam's chillus as consonant, virama and joiner (the older
// way, which "നിങ്ങൾ" is still often written).
const ONE_LETTER: Record<string, string> = { "ຫນ": "ໜ", "ຫມ": "ໝ", "ണ്\u200D": "ൺ", "ന്\u200D": "ൻ", "ര്\u200D": "ർ", "ല്\u200D": "ൽ", "ള്\u200D": "ൾ", "ക്\u200D": "ൿ" };
const TWO_LETTERS = /ຫ[ນມ]|[ണനരലളക]്\u200D/g;
const AM = /\u0E4D([\u0E48-\u0E4B]?)\u0E32/g;
const LAO_AM = /\u0ECD([\u0EC8-\u0ECB]?)\u0EB2/g;
// A half-space (ZWNJ) or a joiner inside a word, which Persian writes in plurals and after "می"
// ("کتاب‌ها", "می‌توانیم") and Sinhala and Devanagari in some letters, and which many people
// type without: the word is kept split there and joined ("كتاب", "ها", "كتابها").
const JOINER = /[\u200C\u200D]/;
const JOINERS = /[\u200C\u200D]/g;
const ASCII = /^[\x00-\x7f]*$/;
// What a word is split again at: anything that isn't a letter, digit or mark.
const APART = /[^\p{L}\p{N}\p{M}]+/u;
// Digits written small. In "CO₂" or "m²" they belong to the word, as typed ("co2", "m2"); in a
// footnote's "fee²" they don't ("fee"). Which it is can't be told, so a word with them is kept
// both ways: "co2" and "co", "fee2" and "fee", "سعر2" and "سعر". Not in Chinese, Japanese, Thai, Lao,
// Khmer or Burmese, which have no spaces, so a run of their letters is a whole clause ("减少CO₂排放"
// keeps "CO₂" both ways, and each of its other words once), nor in Korean: the splitter cuts a digit
// from a Chinese, Japanese or Korean word, and from a Thai, Lao, Khmer or Burmese one it's kept
// apart (GLUED), so "ราคา¹" is "ราคา" and "1".
const SMALL = /[⁰¹²³⁴-⁹₀-₉]/u;
const SMALLS = /[⁰¹²³⁴-⁹₀-₉]/gu;
const RUN = /(?:(?![\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}])[\p{L}\p{M}\p{N}])+/gu;
const GLUED = /([\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}])(?=[⁰¹²³⁴-⁹₀-₉])/gu;
// Symbols NFKC writes with Latin letters or digits ("™" is "TM", "№" "No", "㎏" "kg", "①" "1") are
// words of their own, not the end of the word they're written onto: "Visa™" is "visa" and "tm".
// Not a radical NFKC writes as a Chinese character, which belongs to its word.
const SYMBOL = /[\p{So}\p{No}]/gu;
const LATIN = /[A-Za-z0-9]/;
function apart(c: string): string {
  const k = c.normalize("NFKC");
  return SMALL.test(c) || !LATIN.test(k) ? c : ` ${k} `;
}

/**
 * The words of a text, as the search index keeps them: in NFKC but for Thai and Lao (see
 * NFKC_FIRST), lower case, split the way Intl.Segmenter splits words, so Japanese, Chinese and Thai
 * split into words too; then split again at anything that isn't a letter, digit or mark, so an
 * apostrophe ("l'été") leaves two words, each of which gets its assistant's tag; and without
 * accents or vowel marks, with one form of the Arabic and Persian letters written two ways, the
 * Latin letters with a stroke as the letter without it, and every script's digits as 0-9 ("Café"
 * is "cafe", "يُرجى" is "يرجي", "أولًا" is "اولا", "کالا" is "كالا", "łódź" is "lodz", "۱۲" is "12").
 * Letters written two ways are split as one (see ONE_LETTER). A word with digits written small, or
 * with a half-space or a joiner in it, is kept both ways, and "™" and the like are words apart
 * (see SMALL, JOINER and SYMBOL).
 */
export function words(text: string): string[] {
  const out: string[] = [];
  let spaced = text.normalize("NFC").replace(AM, "$1\u0E33").replace(LAO_AM, "$1\u0EB3").replace(TWO_LETTERS, (l) => ONE_LETTER[l]);
  if (SMALL.test(spaced)) spaced = spaced.replace(GLUED, "$1 ").replace(RUN, (w) => (SMALL.test(w) ? `${w} ${w.replace(SMALLS, " ")}` : w));
  const folded = spaced
    .replace(SYMBOL, apart)
    .replace(NFKC_FIRST, (s) => s.normalize("NFKC"))
    .toLowerCase()
    .replace(VARIANTS, (c) => LETTERS[c]);
  for (const s of segments.segment(folded)) {
    if (!s.isWordLike) continue;
    const ascii = ASCII.test(s.segment);
    // NFKD, and NFC once the marks are gone: NFKC, which Thai and Lao only get now that they're
    // split. Lower case again, as NFKD can make capitals.
    const segment = ascii ? s.segment : s.segment.normalize("NFKD").toLowerCase();
    const pieces = segment.split(APART);
    if (JOINER.test(segment)) {
      // Looked up in a set: one segment can be a whole message ("a\u200Cb." again and again is one
      // word to the splitter).
      const split = new Set(pieces);
      for (const p of segment.replace(JOINERS, "").split(APART)) if (!split.has(p)) pieces.push(p);
    }
    for (const piece of pieces) {
      const word = ascii ? piece : piece.replace(MARKS, "").normalize("NFC").replace(STROKED, (c) => STROKES[c]).replace(DIGITS, digit);
      if (word && word.length <= MAX_WORD && /[\p{L}\p{N}]/u.test(word)) out.push(word);
    }
  }
  return out;
}

/** The tag an assistant's words carry in the shared index: "a", the first 16 hex digits of its id, "x". */
export function tagOf(assistantId: string): string {
  const head = assistantId.slice(0, 16);
  if (!/^[0-9a-f]{16}$/.test(head)) throw new Error("An assistant's id starts with 16 hex digits.");
  return `a${head}x`;
}

/** What the index stores for a chunk: each of its words, tagged with its assistant. */
export const tagged = (tag: string, text: string) => words(text).map((w) => tag + w).join(" ");

export type Term = { word: string; prefix: boolean };

// A message this short ("and the price?") is searched with the person's message before it.
const SHORT_MESSAGE = 40;
const MAX_TERMS = 16;
// Words this long also find longer ones ("refund" finds "refunds" and "refunded").
const PREFIX_FROM = 5;
// Korean writes a particle onto the word it follows ("환불은", "환불을": refund + a particle).
const HANGUL = /^\p{Script=Hangul}{2,}$/u;
const PARTICLE = /(?:에서|에게|으로|까지|부터|은|는|이|가|을|를|의|에|도|와|과|로|만)$/u;

/**
 * A word as searched: from 5 letters on, a prefix, and without a plural s ("refunds" finds
 * "refund"). A Korean word of two syllables or more loses one particle, if two syllables are left,
 * and is always a prefix: "기간은" is searched as "기간", which finds "기간이" and "기간은".
 */
function termOf(word: string): Term {
  if (HANGUL.test(word)) {
    const stem = word.replace(PARTICLE, "");
    return { word: stem.length >= 2 ? stem : word, prefix: true };
  }
  if ([...word].length < PREFIX_FROM) return { word, prefix: false };
  return { word: /^[a-z]{4,}s$/.test(word) && !word.endsWith("ss") ? word.slice(0, -1) : word, prefix: true };
}

/**
 * The words a message is searched with: its own, longest first, then those of the person's
 * message before it when it's short, up to 16 different words.
 */
export function queryTerms(message: string, earlier = ""): Term[] {
  const pick = (text: string) => [...new Set(words(text))].sort((a, b) => b.length - a.length);
  const chosen = [...new Set([...pick(message), ...(message.trim().length < SHORT_MESSAGE ? pick(earlier) : [])])].slice(0, MAX_TERMS).map(termOf);
  return chosen.filter((t, i) => chosen.findIndex((u) => u.word === t.word && u.prefix === t.prefix) === i);
}

/** One term of a full-text query: the tagged word quoted, any quote in it doubled, and "*" for a prefix. */
export const phraseOf = (tag: string, t: Term) => `"${(tag + t.word).replaceAll('"', '""')}"${t.prefix ? " *" : ""}`;

/**
 * The full-text query for these terms: each as a quoted string with its assistant's tag, joined
 * with OR. Whatever is typed stays inside the quotes, so it can't add an operator, a column or
 * another assistant's words. "" for no terms.
 */
export function matchTerms(tag: string, terms: Term[]): string {
  if (!/^a[0-9a-f]{16}x$/.test(tag)) throw new Error("Not an assistant's tag.");
  return terms.map((t) => phraseOf(tag, t)).join(" OR ");
}

/** The full-text query for a message (see queryTerms and matchTerms). */
export const matchQuery = (tag: string, message: string, earlier = "") => matchTerms(tag, queryTerms(message, earlier));

/*
 * A word in half or more of an assistant's chunks says nothing about which one to read (BM25
 * gives it no weight), like "the": it's left out, so "thanks for the help" matches nothing.
 * Not with fewer chunks than this, where half of them is one or two.
 */
export const COMMON_FROM = 6;

/** Whether a word found in `found` of an assistant's `total` chunks helps choose between them. */
export const tells = (found: number, total: number) => found > 0 && (total < COMMON_FROM || 2 * found < total);

/**
 * The chunks that hold any of the terms that tell (see tells), best first, ranked with BM25 as the
 * full-text index ranks them (k1 1.2, b 0.75, a prefix term counting every word it starts), with
 * the number and average length of this assistant's chunks. Used when the database has no
 * full-text index, over all of one assistant's chunks. Both find the same chunks, but not always in
 * the same order: the index takes that number and length from every assistant's chunks, so the
 * more other chunks it holds, the less a word being rare in this assistant's files counts against
 * a chunk having a word many times.
 */
export function rankChunks<T extends { body: string }>(chunks: T[], terms: Term[]): T[] {
  if (!chunks.length || !terms.length) return [];
  const docs = chunks.map((c) => words(c.body));
  const avg = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1;
  const hits = terms
    .map((t) => docs.map((d) => d.filter((w) => (t.prefix ? w.startsWith(t.word) : w === t.word)).length))
    .filter((perDoc) => tells(perDoc.filter(Boolean).length, docs.length));
  const scores = docs.map((d, i) =>
    hits.reduce((sum, perDoc) => {
      const f = perDoc[i];
      if (!f) return sum;
      const n = perDoc.filter(Boolean).length;
      const idf = Math.max(Math.log((docs.length - n + 0.5) / (n + 0.5)), 1e-6);
      return sum + (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * d.length) / avg));
    }, 0),
  );
  return chunks
    .map((c, i) => ({ c, score: scores[i], i }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.c);
}
