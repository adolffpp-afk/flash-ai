/*
 * Assistant files for the search tests (assistant-search.test.ts and its fallback twin): text that
 * reads like a real handbook, with filler made of invented words (so a test's search words appear
 * only where a test put them) around the common words every chunk has.
 */
import type { Client } from "@libsql/client";

/** The same "random" numbers every run, from integer arithmetic that stays exact (Math.imul). */
export function seeded(seed: number) {
  let s = seed;
  return () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 2147483648;
}

const SYLLABLES = ["ka", "ro", "mi", "te", "lan", "sor", "vi", "de", "pu", "ne", "shi", "tor", "al", "en", "qui", "bra", "ul", "mo", "zan", "pe"];

/** About `chars` characters of sentences in invented words, with "the", "and" and "of" in each. */
export function filler(chars: number, seed = 1, vocabulary = 4000): string {
  const rnd = seeded(seed);
  const vocab = Array.from({ length: vocabulary }, () => Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => SYLLABLES[Math.floor(rnd() * SYLLABLES.length)]).join(""));
  const word = () => vocab[Math.floor(Math.exp(rnd() * Math.log(vocab.length))) - 1];
  let text = "";
  while (text.length < chars) {
    const words = Array.from({ length: 8 + Math.floor(rnd() * 10) }, word);
    text += `The ${words.slice(0, 4).join(" ")} and ${words.slice(4).join(" ")} of the ${word()}. `;
    if (rnd() < 0.15) text = text.trimEnd() + "\n\n";
  }
  return text.trim();
}

/** A PDF's text as pdf-text.ts writes it, page by page, with given pages' own words in the middle. */
export function pdf(pages: number, own: Record<number, string>, seed = 1, pageChars = 2200): string {
  return Array.from({ length: pages }, (_, i) => {
    const n = i + 1;
    const body = own[n] ? `${filler(pageChars / 2, seed * 100 + n)}\n\n${own[n]}\n\n${filler(pageChars / 2, seed * 100 + n + 50)}` : filler(pageChars, seed * 100 + n);
    return `--- Page ${n} ---\n${body}`;
  }).join("\n\n");
}

/** A spreadsheet's text as office.ts writes it. */
export function sheet(name: string, rows: string[][]): string {
  return `--- Sheet: ${name} ---\n${rows.map((r) => r.join(",")).join("\n")}`;
}

export const REFUNDS = "Refunds: a refund is paid within 14 days to the card that paid. Refund requests need the receipt.";
export const DELIVERY = "Delivery: we deliver to the old harbour district on Tuesdays and Fridays, free over 30 euros.";
export const GLUTEN = "Gluten-free loaves are baked separately on Mondays, in their own oven, with oat and rice flour.";
// In a 14-page handbook with these on pages 3, 7 and 11: where the best match for each question is.
export const TOP_PAGES = [
  ["How do refunds work?", "3"],
  ["Do you deliver to the harbour?", "7"],
  ["gluten-free loaves", "11"],
  ["receipt card refund", "3"],
] as const;

/** Pages in use by the database (not free), from its own counts. */
export async function pagesUsed(c: Client): Promise<number> {
  const count = (await c.execute("PRAGMA page_count")).rows[0].page_count;
  const free = (await c.execute("PRAGMA freelist_count")).rows[0].freelist_count;
  return Number(count) - Number(free);
}
