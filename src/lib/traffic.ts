/*
 * Where a visit to a published app came from, worked out from its address and referrer alone (see
 * server/visits.ts). Nothing here reads or keeps anything about the person. Safe in the browser too.
 */

/**
 * Whether a page load is the same person coming back in the middle of something, not a new visit:
 * from a Stripe checkout (paid, or cancelled), or after signing up or in to the app.
 */
export function isReturnTrip(url: URL, referer: string | null): boolean {
  if (url.searchParams.has("flash_paid") || url.searchParams.has("flash_auth")) return true;
  try {
    return referer ? new URL(referer).hostname.toLowerCase() === "checkout.stripe.com" : false;
  } catch {
    return false;
  }
}
