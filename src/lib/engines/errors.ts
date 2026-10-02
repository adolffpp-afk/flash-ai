/**
 * An error whose message was written for the user, so the chat shows it as it is. Any other
 * error may hold a provider's raw response, so the chat logs it and shows a short note instead.
 */
export class FriendlyError extends Error {}
