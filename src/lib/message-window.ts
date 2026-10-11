// The part of a message that the checks run before the credit check read: routing, the level, the
// free order and the model picked. A request sits at the start or the end of a message ("summarise
// this: …", "… translate that into French"), so a long message is read as its first 2,000 and last
// 1,000 characters. However a pattern is written, one long message then can't hold a server.
// Pure, no imports.

export const WINDOW_HEAD = 2000;
export const WINDOW_TAIL = 1000;

// A cut never splits a letter written as two UTF-16 units (an emoji, say).
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The message, or its first 2,000 and last 1,000 characters when it's longer than 3,000. */
export function messageWindow(message: string): string {
  if (message.length <= WINDOW_HEAD + WINDOW_TAIL) return message;
  let head = WINDOW_HEAD;
  if (isLowSurrogate(message.charCodeAt(head))) head--;
  let tail = message.length - WINDOW_TAIL;
  if (isLowSurrogate(message.charCodeAt(tail))) tail++;
  return `${message.slice(0, head)}\n…\n${message.slice(tail)}`;
}
