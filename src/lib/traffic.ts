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

/** The most characters of a tag Flash keeps (the link maker takes no more). */
export const MAX_TAG = 40;
const MAX_SOURCE = 60;
// An email address, a phone number (in any digits), or a subscriber's or click's ID: a tag holding one isn't used.
const PERSONAL = /@|\p{Nd}{7,}|[0-9a-f]{16,}/iu;
// A date written with separators (2026-10-18, 18.10.2026, 10_18_2026), which isn't a phone number's digits.
const DATE = /(?<!\d)(?:(?:19|20)\d\d[-_.](?:0?[1-9]|1[0-2])[-_.](?:0?[1-9]|[12]\d|3[01])|(?:0?[1-9]|[12]\d|3[01])[-_.](?:0?[1-9]|[12]\d|3[01])[-_.](?:19|20)\d\d)(?!\d)/g;
// Characters that draw nothing (variation selectors, Hangul fillers, joiners), so a tag can't pass for another.
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;
// What people type in utm_source, as the name a referrer from there would give. Looked up only by
// its own names, so a tag like "constructor" is a name like any other.
const ALIASES: Readonly<Record<string, string>> = {
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
 * Whether a tag's text holds an email address, a phone number or an ID: looked for as it is, and
 * with dots, dashes and underscores taken out too (dates aside), which joins what they and other
 * characters kept apart: (415) 555-0123, +44 7911 123456, a UUID.
 */
function personal(text: string): boolean {
  const joined = text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}._ -]/gu, "")
    .replace(/ +/g, "-")
    .replace(DATE, "")
    .replace(/[._ -]/g, "");
  return PERSONAL.test(text) || PERSONAL.test(joined);
}

/**
 * Whether a tag is a code a machine made, like an ID (a ULID, a nanoid, Stripe's or Firebase's),
 * rather than a name. Such codes switch between small letters, capitals and digits at random: a
 * small letter runs into a capital that starts no word (rF and eU in NffrFeUf), and digits sit
 * between letters (the 8 in AP8TK). A tag is one when that happens 3 times in a run of 14 or more
 * letters and digits, or a small letter runs into such a capital 3 times in all. Names people
 * write, like InstagramStory, SpringSale2026, iPhoneLaunch or FY26Q4Launch, don't do it that often.
 */
function machineCode(text: string): boolean {
  let humps = 0;
  for (const run of text.match(/[A-Za-z0-9]+/g) ?? []) {
    const intoCapital = run.match(/[a-z](?=[A-Z](?![a-z]{2}))/g)?.length ?? 0;
    const betweenLetters = run.match(/(?<=[A-Za-z])\d+(?=[A-Za-z])/g)?.length ?? 0;
    if (run.length >= 14 && intoCapital + betweenLetters >= 3) return true;
    humps += intoCapital;
  }
  return humps >= 3;
}

/** A tag's text read as base64, when it is that and holds only plain text (as an email address would), else "". */
function base64Text(text: string): string {
  // A + in a link's address reads as a space.
  const code = text.trim().replace(/ /g, "+");
  if (!/^[A-Za-z0-9+/_-]{8,}={0,2}$/.test(code)) return "";
  try {
    const plain = atob(code.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, ""));
    return /^[\x20-\x7e]+$/.test(plain) ? plain : "";
  } catch {
    return "";
  }
}

/**
 * A link tag's value as Flash keeps it: lowercase letters, digits, dots, - and _ in any script, at
 * most 40 characters, or "" when it is missing, shows nothing, or looks like personal data or an ID.
 */
export function cleanTag(value: string | null | undefined): string {
  if (!value) return "";
  // Cut first, so no pattern runs on a long value; then written one way (ｉｇ is ig, ＠ is @), without
  // the characters that draw nothing.
  const cut = value.slice(0, 200).normalize("NFKC").replace(INVISIBLE, "");
  const clean = cut
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}._ -]/gu, "")
    // A mark (an accent, a vowel sign) only on a letter.
    .replace(/(?<![\p{L}\p{M}])\p{M}+/gu, "")
    .trim()
    .replace(/ +/g, "-");
  if (!/[\p{L}\p{N}]/u.test(clean) || personal(cut) || machineCode(cut) || personal(base64Text(cut))) return "";
  // A name cut in the middle doesn't end in a dot or a dash.
  return clean.length > MAX_TAG ? clean.slice(0, MAX_TAG).replace(/[._-]+$/, "") : clean;
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
    const source = Object.hasOwn(ALIASES, named) ? ALIASES[named] : named.includes(".") ? foldHost(named) : named;
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
 * Where a link will be shared, as typed in the link maker, as Flash will read it: a web address
 * (https://mybakeryblog.com/autumn-post, facebook.com/groups/bakers) as its site's name.
 */
export function shareSource(typed: string): string {
  const text = typed.trim();
  if (text.includes("/")) {
    const site = text
      .replace(/^[a-z][a-z\d+.-]*:\/\//i, "")
      .split(/[/?#]/, 1)[0]
      .replace(/:\d*$/, "");
    if (/\S\.\S/.test(site) && !/\s/.test(site)) return site.includes("@") ? "" : cleanTag(foldHost(site));
  }
  return cleanTag(text);
}

/**
 * The app's address with tags saying where it was shared, cleaned as Flash will read them, so the
 * link counts under exactly the names shown. base as it is when the source is empty.
 */
export function taggedLink(base: string, tags: { source: string; campaign?: string }): string {
  const source = shareSource(tags.source);
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

/**
 * The step names an app's code reports, written out in its flashDB.track("name") calls (also as
 * flashDB?.track?.("name")): the only names Flash counts for the app (kept with it when it is
 * published), at most 10.
 */
export function stepsInHtml(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/\bflashDB\s*\??\.\s*track\s*(?:\?\.)?\s*\(\s*(["'`])([^"'`\n]{1,40})\1/g)) {
    const name = stepName(m[2]);
    if (name) found.add(name);
    if (found.size >= MAX_STEP_NAMES) break;
  }
  return [...found];
}

/** How many visitors took a step, as a fraction: only from 100 visitors, so a rate is never read into a handful of people. */
export const share = (n: number, base: number): number | null => (base >= 100 && n >= 0 && n <= base ? n / base : null);

/** A fraction as a percentage in the reader's own way of writing it ("2.3%", "2,3 %", "%2,3"), with one decimal under 10%. */
export const percent = (fraction: number, locale: string): string =>
  new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: fraction < 0.1 ? 1 : 0 }).format(fraction);
