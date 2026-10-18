/*
 * Prints LOOKALIKES for src/lib/assistants.ts: the letters and digits that look like each Latin
 * letter, so a name like "FLꓮSH" (Lisu A) or "Flash Ꮪupport" (Cherokee S) reads as the name it
 * copies. From Unicode's list of confusable characters (UTS #39) and its list of characters:
 *   node --experimental-strip-types scripts/lookalikes.ts confusables.txt UnicodeData.txt
 * with confusables.txt from https://www.unicode.org/Public/security/latest/ and UnicodeData.txt
 * from https://www.unicode.org/Public/UCD/latest/ucd/. Every letter or digit the first maps to one
 * Latin letter, both as nameKey sees them (NFKC, lower case, no marks); every Latin letter with a
 * stroke, hook, curl or tail built in, which NFD can't take off and the first doesn't list ("ⱥ",
 * "ȴ", "ȿ": from its name, "LATIN SMALL LETTER A WITH STROKE"); and the Latin small capitals
 * ("ꜰʟᴀꜱʜ"), which it keeps as letters of their own. "i", "l" and "1" look like each other. A
 * character can look like two letters (Greek "Η" like "h", "η" like "n").
 */
import { readFileSync } from "node:fs";

const fold = (s: string) => s.normalize("NFKC").toLowerCase().normalize("NFD").replace(/\p{M}+/gu, "");
const chars = (hex: string) => String.fromCodePoint(...hex.trim().split(/\s+/).map((h) => parseInt(h, 16)));
const SMALL_CAPITALS: Record<string, number> = {
  a: 0x1d00, b: 0x0299, c: 0x1d04, d: 0x1d05, e: 0x1d07, f: 0xa730, g: 0x0262, h: 0x029c, i: 0x026a, j: 0x1d0a, k: 0x1d0b, l: 0x029f, m: 0x1d0d,
  n: 0x0274, o: 0x1d0f, p: 0x1d18, q: 0xa7af, r: 0x0280, s: 0xa731, t: 0x1d1b, u: 0x1d1c, v: 0x1d20, w: 0x1d21, y: 0x028f, z: 0x1d22,
};

// What each character, as nameKey sees it, is confused with.
const like = new Map<string, Set<string>>();
const add = (ch: string, to: string) => void (like.get(ch) ?? like.set(ch, new Set()).get(ch)!).add(to);
for (const line of readFileSync(process.argv[2], "utf8").split("\n")) {
  const [from, to] = line.replace(/#.*/, "").split(";");
  if (!to) continue;
  const key = fold(chars(from));
  // One letter or digit, and not a Latin letter already ("ſ" is "s" by NFKC).
  if ([...key].length === 1 && /^[\p{L}\p{N}]$/u.test(key) && !/^[a-z]$/.test(key)) add(key, fold(chars(to)));
}
for (const [latin, cp] of Object.entries(SMALL_CAPITALS)) add(String.fromCodePoint(cp), latin);
// Kept from the list this table replaced, which the file doesn't have: Cyrillic "ғ" for "f", "п" for "n".
add("\u0493", "f");
add("\u043f", "n");

/** The Latin letters a character looks like, through any lookalike of a lookalike (Cherokee "ꭺ" is like "ᴀ", which is like "a"). */
function latin(ch: string, seen = new Set<string>()): string[] {
  if (/^[a-z]$/.test(ch)) return [ch];
  if (seen.has(ch) || !like.has(ch)) return [];
  seen.add(ch);
  return [...like.get(ch)!].flatMap((to) => latin(to, seen));
}
const table: Record<string, Set<string>> = {};
for (const ch of like.keys()) for (const letter of latin(ch)) (table[letter] ??= new Set()).add(ch);
// "LATIN SMALL LETTER A WITH STROKE", "LATIN LETTER SMALL CAPITAL L WITH STROKE", "LATIN SMALL
// LETTER DOTLESS J WITH STROKE": that letter, if nameKey leaves something else. Not through the
// list above: what looks like "ꞓ" (c with a bar), such as "ɛ", doesn't look like a "c".
const NAMED = /^LATIN (?:SMALL |CAPITAL )?LETTER (?:SMALL CAPITAL |DOTLESS )?([A-Z]) WITH /;
for (const line of readFileSync(process.argv[3], "utf8").split("\n")) {
  const [hex, name] = line.split(";");
  const letter = name?.match(NAMED)?.[1];
  const key = letter ? fold(chars(hex)) : "";
  if ([...key].length === 1 && /^\p{L}$/u.test(key) && !/^[a-z]$/.test(key)) (table[letter!.toLowerCase()] ??= new Set()).add(key);
}
for (const ch of ["l", "1", ...(table.l ?? [])]) (table.i ??= new Set()).add(ch);
for (const ch of ["i", ...(table.i ?? [])]) if (ch !== "l") (table.l ??= new Set()).add(ch);

const escaped = (set: Set<string>) =>
  [...set]
    .sort((x, y) => x.codePointAt(0)! - y.codePointAt(0)!)
    .map((ch) => (/^[a-z0-9]$/.test(ch) ? ch : `\\u{${ch.codePointAt(0)!.toString(16)}}`))
    .join("");
console.log("const LOOKALIKES: Record<string, string> = {");
for (const letter of Object.keys(table).sort()) console.log(`  ${letter}: "${escaped(table[letter])}",`);
console.log("};");
