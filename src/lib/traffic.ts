/*
 * Where a visit to a published app came from, worked out from its address and referrer alone (see
 * server/visits.ts): the link's tags (utm_source, utm_medium, utm_campaign, or ref), an ad's click
 * ID, else the website the visitor came from. Nothing here reads or keeps anything about the
 * person, and a tag that looks like personal data is left out. Safe in the browser too.
 */

/** Where someone came from, as the owner sees it: "instagram.com", "paid", "spring-sale". */
export type Touch = { source: string; medium: string; campaign: string };
/** Typed in, bookmarked, or shared in a message. */
export const DIRECT: Touch = { source: "", medium: "", campaign: "" };
/** Past an app's 30 sources of the day, and the visits of people who weren't counted, under a source new that day. */
export const OTHER: Touch = { source: "(other)", medium: "", campaign: "" };
/** The source of a form, sign-up or order Flash couldn't tie to a visit that day or the day before. */
export const UNMATCHED = "?";

/** The parts of an address that say where someone came from (see touchOf), and Facebook's click ID. */
export const LINK_TAGS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "gclid", "gbraid", "wbraid", "msclkid", "fbclid"];

const MAX_TAG = 40;
const MAX_SOURCE = 60;
// An email address, a phone number, or a subscriber's or click's ID: a tag holding one isn't used.
const PERSONAL = /@|\d{7,}|[0-9a-f]{16,}/i;
// What people type in utm_source, as the name a referrer from there would give.
const ALIASES: Record<string, string> = {
  google: "google.com",
  fb: "facebook.com",
  facebook: "facebook.com",
  ig: "instagram.com",
  instagram: "instagram.com",
  tiktok: "tiktok.com",
  yt: "youtube.com",
  youtube: "youtube.com",
  linkedin: "linkedin.com",
  pinterest: "pinterest.com",
  reddit: "reddit.com",
  twitter: "x.com",
  x: "x.com",
  bing: "bing.com",
  duckduckgo: "duckduckgo.com",
  yahoo: "yahoo.com",
};

/**
 * A link tag's value as Flash keeps it: lowercase letters, digits, dots, - and _ in any script, at
 * most 40 characters, or "" when it is missing or looks like personal data.
 */
export function cleanTag(value: string | null | undefined): string {
  if (!value) return "";
  // Cut first, so no pattern runs on a long value.
  const cut = value.slice(0, 200);
  if (PERSONAL.test(cut)) return "";
  return cut
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}._ -]/gu, "")
    .trim()
    .replace(/ +/g, "-")
    .slice(0, MAX_TAG);
}

/** A website's name as Flash shows it: search engines and social apps by their main name (m.facebook.com is facebook.com). */
export function foldHost(host: string): string {
  const name = host.toLowerCase().replace(/^www\./, "");
  const known = name.match(/(?:^|\.)(google|bing|duckduckgo|yahoo|facebook|instagram|tiktok|youtube|linkedin|pinterest|reddit)\.[a-z.]+$/);
  if (known) return known[1] === "google" ? "google.com" : `${known[1]}.com`;
  if (name === "t.co") return "x.com";
  return name.slice(0, MAX_SOURCE);
}

/** Where a visit came from: the other website's name, or "" when typed in, bookmarked or from the site itself. */
export function visitSource(referrer: string | null, host: string | null): string {
  if (!referrer) return "";
  try {
    const from = new URL(referrer);
    if (!from.protocol.startsWith("http")) return "";
    const name = from.hostname.toLowerCase().replace(/^www\./, "");
    if (!name || name === (host ?? "").toLowerCase().split(":")[0].replace(/^www\./, "")) return "";
    return foldHost(name);
  } catch {
    return "";
  }
}

/**
 * Where a page load came from, taking the first that applies: the link's tags (utm_source, else
 * ref), a Google or Microsoft ad's click ID, else the referring website. utm_content and utm_term
 * are never read.
 */
export function touchOf(url: URL, referer: string | null, host: string | null): Touch {
  const tag = (name: string) => cleanTag(url.searchParams.get(name));
  const utm = tag("utm_source");
  const named = utm || tag("ref");
  if (named) {
    const source = ALIASES[named] ?? (named.includes(".") ? foldHost(named) : named);
    return utm ? { source, medium: tag("utm_medium"), campaign: tag("utm_campaign") } : { source, medium: "", campaign: "" };
  }
  // Facebook's fbclid is left out: Facebook adds it to links nobody paid for too.
  if (["gclid", "gbraid", "wbraid"].some((name) => url.searchParams.get(name))) return { source: "google.com", medium: "paid", campaign: "" };
  if (url.searchParams.get("msclkid")) return { source: "bing.com", medium: "paid", campaign: "" };
  return { ...DIRECT, source: visitSource(referer, host) };
}

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

/**
 * The app's address with tags saying where it was shared, cleaned as Flash will read them, so the
 * link counts under exactly the names shown. base as it is when the source is empty.
 */
export function taggedLink(base: string, tags: { source: string; campaign?: string }): string {
  const source = cleanTag(tags.source);
  if (!source) return base;
  try {
    const url = new URL(base);
    url.searchParams.set("utm_source", source);
    const campaign = cleanTag(tags.campaign);
    if (campaign) url.searchParams.set("utm_campaign", campaign);
    else url.searchParams.delete("utm_campaign");
    return url.href;
  } catch {
    return base;
  }
}

/** What a step an app reports with flashDB.track may be called: a fixed lowercase name. */
export const STEP_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** A run of 7 or more digits, or of 16 or more hex characters: a name holding one carries an ID. */
export const STEP_ID = /\d{7,}|[0-9a-f]{16,}/;
/** The steps Flash counts itself, which an app can't report. */
export const RESERVED_STEPS = ["visit", "form", "signup", "checkout", "order", "capped"];
/** Most names an app can report a day, and in one request (see the track route). */
export const MAX_STEP_NAMES = 10;
export const MAX_TRACKED = 15;

/**
 * A step name as Flash counts it, or "" when it can't be one: not a fixed lowercase name of
 * letters, digits, - and _, holding an ID, or a step Flash counts itself. The shim checks the same
 * (see flashdb-shim.ts).
 */
export function stepName(step: unknown): string {
  if (typeof step !== "string") return "";
  const name = step.trim().toLowerCase();
  return STEP_NAME.test(name) && !STEP_ID.test(name) && !RESERVED_STEPS.includes(name) ? name : "";
}

/** How many visitors took a step, as a fraction: only from 100 visitors, so a rate is never read into a handful of people. */
export const share = (n: number, base: number): number | null => (base >= 100 && n >= 0 && n <= base ? n / base : null);

/** A fraction as a percentage in the reader's own way of writing it ("2.3%", "2,3 %", "%2,3"), with one decimal under 10%. */
export const percent = (fraction: number, locale: string): string =>
  new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: fraction < 0.1 ? 1 : 0 }).format(fraction);
