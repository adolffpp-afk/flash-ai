import { BlockList, isIP } from "node:net";
import { clientAddress } from "./limits.ts";
import { cacheGet, cachePut, fetchJson } from "./source-fetch.ts";

/*
 * Google's page speed test (PageSpeed Insights, which runs Lighthouse) opening a published app, told
 * apart from people, so it never spends the app's AI (see the ai route) and isn't counted as a visitor
 * (see visits.ts), whoever started it and whenever. Only what Google's test was seen sending and
 * Lighthouse's own agents are taken for it, so a visitor is answered and counted as always while Google
 * tests the app; a browser made to pass for Lighthouse's phone (Chrome DevTools' Moto G Power device)
 * is taken for it too. What it rests on, from other sites' logs, Lighthouse's code and Google's own
 * pages (no request of Google's to Flash was seen):
 * - Google's servers end the user agent with "Chrome-Lighthouse", on the phone and on the computer.
 *   The Lighthouse team said so in September 2025, and logs show it on page loads from November 2025
 *   (the computer's to February 2026, the phone's to September 2026). No browser people use says it.
 * - Without it, a request may still carry Lighthouse's own agents (core/config/constants.js), as
 *   Google's report records them. Its phone, an Android 11 moto g power (2022), counts with Chrome 110
 *   or later, as Lighthouse 11.4 and later send it (Chrome 119 or later): Chrome on a real phone has
 *   named no model since 110. Lighthouse 10 to 11.3 sent Chrome 109, as that phone's own Chrome 101 to
 *   109 did, so that one doesn't count. Its computer is any Mac's Chrome, so it counts only from an
 *   address on Google's list of its user-triggered fetchers, where every address of Google's test in
 *   those logs is (googleFetcher).
 * Whether an app's own requests, such as its AI's, carry the word as page loads do wasn't seen.
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// Chrome-Lighthouse: what Google's servers add, and what Lighthouse itself said up to version 9.
const TOKEN = /Chrome-Lighthouse/i;
/** Lighthouse's phone as version 10 on sends it, with nothing after Safari (which Chrome counts: isLighthouseAgent). */
const PHONE = /^Mozilla\/5\.0 \(Linux; Android 11; moto g power \(2022\)\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/(\d+)\.0\.0\.0 Mobile Safari\/537\.36$/;
/** Lighthouse's computer from version 10 on: Chrome on a Mac, as every Mac's Chrome says it. */
const COMPUTER = /^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X 10_15_7\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/;

/** Whether a user agent is Google's test whenever it's seen: Chrome-Lighthouse, or Lighthouse's phone with Chrome 110 or later. */
export const isLighthouseAgent = (agent: string) => TOKEN.test(agent) || Number(PHONE.exec(agent)?.[1] ?? 0) >= 110;

/** Whether a user agent could be Lighthouse's computer: then it's Google's test only from Google's own addresses. */
export const mayBeLighthouseComputer = (agent: string) => COMPUTER.test(agent);

/**
 * Google's list of the addresses its user-triggered fetchers send from (google-proxy-….google.com),
 * which it makes again every day. It names no product: anything else Google runs from them with a
 * Mac's agent is taken for its test too.
 */
export const FETCHERS_URL = "https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers-google.json";
/** The list as last read (in source_cache), kept a week so a day Google's page can't be read keeps it. */
const FETCHERS = "google-fetchers";
/** Set while the list was asked for lately: it's asked for at most every 10 minutes. */
const FETCHERS_ASKED = "google-fetchers:asked";
const MAX_PREFIXES = 5000;

type KeptList = { at: number; prefixes: string[] };

/** A prefix of the list as BlockList takes it, or null. Never one wide enough to take in a whole network of people. */
function subnet(prefix: string): [string, number, "ipv4" | "ipv6"] | null {
  const [address = "", bits = "", ...rest] = prefix.split("/");
  const kind = isIP(address);
  const n = Number(bits);
  if (rest.length || !kind || !/^\d{1,3}$/.test(bits)) return null;
  return (kind === 4 ? n >= 16 && n <= 32 : n >= 32 && n <= 128) ? [address, n, kind === 4 ? "ipv4" : "ipv6"] : null;
}

/** The prefixes in Google's list (its ipv4Prefix and ipv6Prefix entries), or null when it isn't one. */
export function fetcherPrefixes(json: unknown): string[] | null {
  const list = (json as { prefixes?: unknown } | null)?.prefixes;
  if (!Array.isArray(list) || list.length > MAX_PREFIXES) return null;
  const prefixes = list.flatMap((entry) => {
    const e = entry as { ipv4Prefix?: unknown; ipv6Prefix?: unknown } | null;
    const prefix = e?.ipv4Prefix ?? e?.ipv6Prefix;
    return typeof prefix === "string" && subnet(prefix) ? [prefix] : [];
  });
  return prefixes.length ? prefixes : null;
}

let held: { until: number; list: BlockList | null } | null = null;
let reading: Promise<BlockList | null> | null = null;

/**
 * Google's fetchers' addresses, or null while there's no list. The one kept is used for a day, then
 * Google's page is read again (by one request at a time on each server); kept in memory for 10 minutes.
 */
async function fetcherList(at = Date.now()): Promise<BlockList | null> {
  if (held && held.until > at) return held.list;
  reading ??= (async () => {
    let kept = await cacheGet<KeptList>(FETCHERS, at);
    if ((!kept || at - kept.at >= DAY) && !(await cacheGet<number>(FETCHERS_ASKED, at))) {
      await cachePut(FETCHERS_ASKED, 1, 10 * MINUTE, at);
      const prefixes = await fetchJson(FETCHERS_URL, { timeoutMs: 5000, maxBytes: 1024 * 1024 }).then(fetcherPrefixes, () => null);
      if (prefixes) {
        kept = { at, prefixes };
        await cachePut(FETCHERS, kept, 7 * DAY, at);
      } else console.error("[flash] Google's list of its fetchers' addresses couldn't be read");
    }
    const prefixes = Array.isArray(kept?.prefixes) ? kept.prefixes : [];
    const list = prefixes.length ? new BlockList() : null;
    for (const prefix of prefixes) {
      const s = typeof prefix === "string" ? subnet(prefix) : null;
      if (s) list!.addSubnet(...s);
    }
    held = { until: at + 10 * MINUTE, list };
    return list;
  })().finally(() => (reading = null));
  return reading;
}

/** Whether an address is on Google's list of its user-triggered fetchers'. */
export async function googleFetcher(address: string): Promise<boolean> {
  const ip = address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  const kind = isIP(ip);
  if (!kind) return false;
  return (await fetcherList())?.check(ip, kind === 4 ? "ipv4" : "ipv6") ?? false;
}

/** Whether a request is Google's page speed test, as far as it can be told from a person's. */
export async function isGoogleTest(request: Request): Promise<boolean> {
  const agent = request.headers.get("user-agent") ?? "";
  return isLighthouseAgent(agent) || (mayBeLighthouseComputer(agent) && (await googleFetcher(clientAddress(request))));
}
