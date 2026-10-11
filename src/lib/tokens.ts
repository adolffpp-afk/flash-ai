/**
 * Tokens a text can take at most, without asking Claude: about 2.5 English characters a token,
 * and a whole token for every byte of anything else (Chinese or Arabic text, emoji), since a
 * token never covers less than a byte. Used when counting fails, and for tool answers.
 */
export function tokensAtMost(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x80) ascii++;
    else other += code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return Math.ceil(ascii / 2.5) + other;
}
