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

/** Whether a project's messages, as saved, are over the limit, counted in bytes as they are sent. */
export const projectTooLarge = (json: string) => new TextEncoder().encode(json).length > MAX_PROJECT_BYTES;
