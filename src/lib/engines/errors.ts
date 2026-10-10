import { fill, type Blanks, type Translate } from "../i18n.ts";

/**
 * An error whose message was written for the user, so the chat shows it as it is, in the user's
 * language (err.in(t)). Any other error may hold a provider's raw response, so the chat logs it
 * and shows a short note instead. The phrase is marked msg("…") where it's thrown; err.message is
 * the English, for logs and the connector.
 */
export class FriendlyError extends Error {
  /** The message as written, with {blanks} for the words that change. */
  readonly phrase: string;
  readonly blanks?: Blanks;
  constructor(phrase: string, blanks?: Blanks) {
    super(fill(phrase, blanks));
    this.phrase = phrase;
    this.blanks = blanks;
  }

  /** The message in the language t speaks. */
  in(t: Translate): string {
    return t(this.phrase, this.blanks);
  }
}

/**
 * A media job that ended without a result: Flash stopped waiting (so the request ends inside
 * the server's time limit) or couldn't fetch the file. billed says the provider had already
 * started or finished it, so it charges for it anyway.
 */
export class JobAbandoned extends FriendlyError {
  readonly billed: boolean;
  constructor(phrase: string, billed: boolean, blanks?: Blanks) {
    super(phrase, blanks);
    this.billed = billed;
  }
}

// How long a media job may take in all. Requests stop at 800 seconds (maxDuration in the chat
// route), and a post pack makes pictures and then a video, so this leaves time for each job, the
// prompt rewrite, saving the files and settling credits.
export const MEDIA_WAIT_MS = 240_000;
