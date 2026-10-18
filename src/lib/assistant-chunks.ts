/*
 * How an assistant's files are cut into chunks and searched (see server/assistant-search.ts).
 * Pure, and the same for the browser and the server.
 *
 * Chunks don't overlap: in order, they are the file's text. Every word goes into one search index
 * shared by every assistant, tagged with its assistant (tagOf), so a search reads only that
 * assistant's words, ranks by that assistant's own word counts, and can't match anyone else's.
 */
import { CHUNK_CHARS } from "./assistants.ts";

export type Chunk = { seq: number; label: string; body: string };

// The markers the file readers write (see pdf-text.ts and office.ts): a chunk's label is the one
// it starts under, "4" for page 4, "Slide 3" or "Sheet: Prices"; with none, "part n".
const MARKER = /^--- (?:Page (\d+)|Slide (\d+)|Sheet: (.*?)) ---$/gm;

const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

/** Where the chunk that starts at `start` ends: at a page, paragraph, line, sentence or word break when one is near enough. */
function cutAt(text: string, start: number, size: number, markers: number[]): number {
  const end = start + size;
  const window = text.slice(start, end);
  const last = (re: RegExp, from: number) => {
    let found = -1;
    for (const m of window.matchAll(re)) if (m.index + m[0].length >= from) found = m.index + m[0].length;
    return found;
  };
  // A new page, slide or sheet starts the next chunk, so a chunk never starts under one label and
  // runs on into the next page.
  const marker = markers.filter((at) => at > start && at < end).at(-1);
  if (marker !== undefined) return marker;
  const half = size / 2;
  for (const re of [/\n[^\S\n]*\n\s*/g, /\n\s*/g]) {
    const at = last(re, half);
    if (at > 0) return start + at;
  }
  let sentence = -1;
  for (const s of sentences.segment(window)) if (s.index >= half && s.index > 0) sentence = s.index;
  if (sentence > 0) return start + sentence;
  const word = last(/\s+/g, half);
  if (word > 0) return start + word;
  // One long run with no break: cut, but not inside a character or before a mark that belongs to it.
  let at = end;
  while (at > start + 1 && (/[\uDC00-\uDFFF]/.test(text[at]) || /\p{M}/u.test(text[at]))) at--;
  return at;
}

/**
 * The text in chunks of at most `size` characters, cut at a page, paragraph, line, sentence or
 * word break where it can be. Joined in order, the chunks give back the text exactly.
 */
export function chunkText(text: string, size = CHUNK_CHARS): Chunk[] {
  const marks = [...text.matchAll(MARKER)].map((m) => ({
    at: m.index,
    label: m[1] ?? (m[2] ? `Slide ${m[2]}` : `Sheet: ${m[3]}`),
  }));
  const chunks: Chunk[] = [];
  for (let start = 0; start < text.length; ) {
    const end = text.length - start <= size ? text.length : cutAt(text, start, size, marks.map((m) => m.at));
    const body = text.slice(start, end);
    const first = start + body.search(/\S|$/);
    const label = marks.filter((m) => m.at <= first).at(-1)?.label ?? `part ${chunks.length + 1}`;
    chunks.push({ seq: chunks.length, label, body });
    start = end;
  }
  return chunks;
}

const segments = new Intl.Segmenter("en", { granularity: "word" });
// Longer runs (a key, a long number, base64) are never what someone asks about.
const MAX_WORD = 64;

/**
 * The words of a text, as the search index keeps them: NFKC, lower case and without Latin accents
 * ("Café" is "cafe"), split the way Intl.Segmenter splits words, so Japanese, Chinese and Thai
 * split into words too, then at anything that isn't a letter, digit or mark, so an apostrophe
 * ("l'été") leaves two words, each of which gets its assistant's tag.
 */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const s of segments.segment(text.normalize("NFKC").toLowerCase())) {
    if (!s.isWordLike) continue;
    for (const piece of s.segment.split(/[^\p{L}\p{N}\p{M}]+/u)) {
      const word = /^[\x00-\x7f]*$/.test(piece) ? piece : piece.normalize("NFD").replace(/[\u0300-\u036f]/g, "").normalize("NFC");
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

/** A word as searched: from 5 letters on, a prefix, and without a plural s ("refunds" finds "refund"). */
function termOf(word: string): Term {
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
 * full-text index ranks them (k1 1.2, b 0.75, a prefix term counting every word it starts; the
 * index also counts other assistants' chunks in its totals, which can reorder close results).
 * Used when the database has no full-text index, over all of one assistant's chunks.
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
