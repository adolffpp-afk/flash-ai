/*
 * How big a project's saved chat may be. Vercel refuses requests (and answers) over 4.5 MB before
 * Flash sees them, so saving stops a little under that, with room for the rest of the request and
 * for opening the project again, and says why rather than failing with no explanation.
 */

import { msg } from "./i18n.ts";

export const MAX_PROJECT_BYTES = 4_400_000;

export const PROJECT_TOO_LARGE = msg(
  "This project is too big to save (the limit is 4.4 MB). New messages in it won't be kept after you reload, so download the chat to keep them, then carry on in a new project.",
);

// A chat near the limit gets no more messages: each one, and its answer, is saved with it.
export const PROJECT_FULL = msg(
  "This project is too big for more messages (the limit is 4.4 MB). Download the chat to keep it, then carry on in a new project.",
);

/** Whether a project's messages, as saved, are over the limit, counted in bytes as they are sent. */
export const projectTooLarge = (json: string) => new TextEncoder().encode(json).length > MAX_PROJECT_BYTES;

// Room kept for the reply a request saves into its chat: a whole app at the longest is well under this.
export const REPLY_ROOM_BYTES = 600_000;

/**
 * Whether a chat whose saved messages take savedBytes has room for one more turn: this message and
 * its reply, so the chat stays small enough to open and save. A change to an app saves the whole app
 * again, so app is the latest app's code, if any. Asked before a request runs, so a request is never
 * run or charged when its answer couldn't be kept.
 */
export function roomForTurn(savedBytes: number, message: unknown, app = ""): boolean {
  const bytes = (value: string) => new TextEncoder().encode(value).length;
  return savedBytes + bytes(JSON.stringify(message)) + bytes(JSON.stringify(app)) + REPLY_ROOM_BYTES <= MAX_PROJECT_BYTES;
}
