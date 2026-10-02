/**
 * An error whose message was written for the user, so the chat shows it as it is. Any other
 * error may hold a provider's raw response, so the chat logs it and shows a short note instead.
 */
export class FriendlyError extends Error {}

/**
 * A media job that ended without a result: Flash stopped waiting (so the request ends inside
 * the server's time limit) or couldn't fetch the file. billed says the provider had already
 * started or finished it, so it charges for it anyway.
 */
export class JobAbandoned extends FriendlyError {
  readonly billed: boolean;
  constructor(message: string, billed: boolean) {
    super(message);
    this.billed = billed;
  }
}

// How long a media job may take in all. Requests stop at 300 seconds (maxDuration in the chat
// route), so this leaves time for the prompt rewrite, saving the file and settling credits.
export const MEDIA_WAIT_MS = 240_000;
