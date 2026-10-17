import { cacheGet, cachePut, envCount, failureNote, fetchJsonPaths, reserveDaily, SourceError, takeSlot, testBase } from "./source-fetch.ts";
import type { JsonPath } from "./json-pick.ts";

/*
 * Google PageSpeed Insights for a published app, through Google's free API: speed, accessibility,
 * best practices and SEO scores from a real browser, on a phone and on a computer. It only ever tests
 * an address Flash makes itself, the app's /p/ address or a domain connected to it (see the pagespeed
 * route), never one a user typed. PAGESPEED_API_KEY is optional: without it Google often refuses, as
 * every keyless caller shares one quota that can be 0. The key goes in a header, never the address,
 * and a failure is logged by what went wrong alone. Google refusing (429) stops every check for a
 * while (REFUSED), so Flash doesn't keep asking.
 */

const BASE = "https://www.googleapis.com";
const PATH = "/pagespeedonline/v5/runPagespeed";
const CATEGORIES = ["PERFORMANCE", "ACCESSIBILITY", "BEST_PRACTICES", "SEO"];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Google's API keys: AIza and 35 more letters, digits, _ or -. */
const KEY = /^AIza[\w-]{35}$/;
// Google refusing the key itself (wrong, restricted elsewhere, or the API not switched on for it).
const KEY_REFUSED = /API_KEY_INVALID|API key not valid|API_KEY_SERVICE_BLOCKED|SERVICE_DISABLED|PERMISSION_DENIED/;
const TIMEOUT_MS = 85_000;
// Google's answer holds screenshots too: only the parts in PATHS are kept as it comes in.
const MAX_BYTES = 32 * 1024 * 1024;
const ERROR_BYTES = 4000;

/** Set while Google refuses Flash's checks: none is sent until it expires. */
export const REFUSED = "pagespeed:refused";
// Held while Google checks an app: one check at a time, and its AI says no meanwhile (see lighthouse.ts).
export { runLock } from "./lighthouse.ts";

const AUDITS = ["largest-contentful-paint", "cumulative-layout-shift", "total-blocking-time", "first-contentful-paint"] as const;
const PATHS: JsonPath[] = [
  ["lighthouseResult", "categories"],
  ["lighthouseResult", "runtimeError"],
  ["loadingExperience"],
  ...AUDITS.map((a) => ["lighthouseResult", "audits", a]),
];

export type Rating = "good" | "needs" | "poor";
export type Metric = { p75: number; rating: Rating };
export type PageSpeedScores = { performance: number | null; accessibility: number | null; bestPractices: number | null; seo: number | null };
/** Google's own test: the main content's time to show (LCP), layout shift (CLS), blocking time (TBT), first content (FCP). */
export type Lab = { lcpMs?: number; cls?: number; tbtMs?: number; fcpMs?: number };
/** What real Chrome visitors got over 28 days, at the 75th percentile: only for this page, never the whole site's. */
export type Field = { lcp?: Metric; inp?: Metric; cls?: Metric };
export type PageSpeedError = "quota" | "slow" | "unreachable" | "busy";
/** One strategy's check. at: when Google ran it (not in checks saved before it was kept). */
export type PageSpeedRun = { ok: true; at?: number; scores: PageSpeedScores; lab: Lab; field: Field | null } | { ok: false; error: PageSpeedError };
/**
 * One check of one address, as kept in sites.pagespeed. for: the version of the app it tested
 * (sites.updated_at); at: when its older half was run, so a half kept from an earlier check is never
 * answered as fresh for longer than a day.
 */
export type PageSpeedRecord = { v: 1; at: number; for: number; url: string; mobile: PageSpeedRun; desktop: PageSpeedRun };

/** The key, or null when it isn't set or isn't a Google API key: then Flash asks without one. */
const pagespeedKey = (env: Record<string, string | undefined> = process.env) => {
  const key = env.PAGESPEED_API_KEY?.trim() ?? "";
  return KEY.test(key) ? key : null;
};

/** Why PAGESPEED_API_KEY can't be used, for the owner dashboard: "" when it can (or isn't set). */
export const pagespeedKeyProblem = (env: Record<string, string | undefined> = process.env) =>
  env.PAGESPEED_API_KEY?.trim() && !pagespeedKey(env) ? "PAGESPEED_API_KEY must be the 39-character key Google Cloud shows (it starts with AIza)" : "";

/** Whether Google is taking checks now (it hasn't refused one lately). */
export const pagespeedAvailable = async () => !(await cacheGet<number>(REFUSED));

/** A saved check, or null when there's none or it can't be read. */
export function parseRecord(text: string | null | undefined): PageSpeedRecord | null {
  if (!text) return null;
  try {
    const record = JSON.parse(text) as PageSpeedRecord;
    return record && record.v === 1 && typeof record.url === "string" && record.mobile && record.desktop ? record : null;
  } catch {
    return null;
  }
}

const asObject = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** A category's score out of 100, or null when Google gave none. */
function score(category: unknown): number | null {
  const s = asObject(category)?.score;
  return typeof s === "number" && s >= 0 && s <= 1 ? Math.round(s * 100) : null;
}

const numeric = (audit: unknown) => {
  const n = asObject(audit)?.numericValue;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
};

const RATINGS: Record<string, Rating> = { FAST: "good", AVERAGE: "needs", SLOW: "poor" };

function metric(raw: unknown, scale = 1): Metric | undefined {
  const m = asObject(raw);
  const p = m?.percentile;
  const rating = typeof m?.category === "string" ? RATINGS[m.category] : undefined;
  return typeof p === "number" && Number.isFinite(p) && p >= 0 && rating ? { p75: p / scale, rating } : undefined;
}

/**
 * Real visitors' numbers, only when Google has them for this page: its numbers for the whole origin
 * (origin_fallback) would be all of Flash's address, not this app.
 */
function field(loading: unknown): Field | null {
  const le = asObject(loading);
  const metrics = asObject(le?.metrics);
  if (!le || le.origin_fallback === true || !metrics) return null;
  const found: Field = {
    lcp: metric(metrics.LARGEST_CONTENTFUL_PAINT_MS),
    inp: metric(metrics.INTERACTION_TO_NEXT_PAINT),
    cls: metric(metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE, 100),
  };
  const kept = Object.fromEntries(Object.entries(found).filter(([, v]) => v)) as Field;
  return Object.keys(kept).length ? kept : null;
}

/** What a failed request means for the owner. Google refusing stops the checks for a while. */
async function failure(err: unknown, keyed: boolean): Promise<PageSpeedError> {
  if (!(err instanceof SourceError)) return "unreachable";
  if (err.reason === "busy") return "busy";
  if (err.reason === "timeout") return "slow";
  const refused = err.reason === "status" && (err.status === 429 || err.status === 401 || err.status === 403 || (err.status === 400 && KEY_REFUSED.test(err.body)));
  if (!refused) return "unreachable";
  // With a key, a short pause (it's usually a burst); without, Google's shared quota is gone for hours.
  await cachePut(REFUSED, 1, keyed ? 10 * MINUTE : 6 * HOUR);
  return "quota";
}

export type RunOptions = { timeoutMs?: number; maxBytes?: number };

/** One check of an address on a phone or a computer. Never throws. */
export async function runPageSpeed(target: string, strategy: "mobile" | "desktop", opts: RunOptions = {}): Promise<PageSpeedRun> {
  const key = pagespeedKey();
  try {
    // A few a second across Flash, and a daily allowance (each check of an app is 2).
    if (!(await takeSlot("pagespeed", 3, 1000, { waitMs: 5000 }))) throw new SourceError("busy");
    if (!(await reserveDaily("pagespeed", envCount("FLASH_PAGESPEED_DAILY_REQUESTS", key ? 5000 : 200)))) throw new SourceError("busy");
    const query = new URLSearchParams({ url: target, strategy: strategy.toUpperCase() });
    for (const c of CATEGORIES) query.append("category", c);
    const [categories, runtimeError, loading, ...audits] = await fetchJsonPaths(
      `${testBase("FLASH_TEST_PAGESPEED_URL") ?? BASE}${PATH}?${query}`,
      { headers: key ? { "X-goog-api-key": key } : {}, timeoutMs: opts.timeoutMs ?? TIMEOUT_MS, maxBytes: opts.maxBytes ?? MAX_BYTES, errorBytes: ERROR_BYTES },
      PATHS,
      (value) => value,
    );
    // Google couldn't load the page (no first paint, a page that never answered): its numbers mean nothing.
    if (runtimeError || !categories) return { ok: false, error: "unreachable" };
    const [lcp, cls, tbt, fcp] = audits.map(numeric);
    const lab: Lab = { ...(lcp !== undefined && { lcpMs: lcp }), ...(cls !== undefined && { cls }), ...(tbt !== undefined && { tbtMs: tbt }), ...(fcp !== undefined && { fcpMs: fcp }) };
    const c = asObject(categories);
    return {
      ok: true,
      scores: { performance: score(c?.performance), accessibility: score(c?.accessibility), bestPractices: score(c?.["best-practices"]), seo: score(c?.seo) },
      lab,
      field: field(loading),
    };
  } catch (err) {
    const error = await failure(err, key !== null);
    if (error !== "busy") console.error("[flash] PageSpeed Insights check failed:", failureNote(err));
    return { ok: false, error };
  }
}
