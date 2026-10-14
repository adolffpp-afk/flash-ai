import { one, run } from "./db.ts";
import { cacheGet, cacheKey, cachePut, envCount, failureNote, fetchJson, reserveDaily, SourceError, takeSlot } from "./source-fetch.ts";
import {
  asObject,
  badInput,
  cleanText,
  SEARCH_FAILED,
  SEARCH_RESULTS,
  SEARCH_USED_UP,
  webResult,
  WEB_SEARCH,
  type ClientTool,
  type ToolResult,
  type WebResult,
} from "../research.ts";
import { english, type Translate } from "../i18n.ts";

/*
 * Web search for the free models, through the owner's own SearXNG (a metasearch engine on Railway,
 * behind a password gate), so it costs Flash nothing per search. Switched on by three environment
 * variables: SEARXNG_URL (the gate's https address), SEARXNG_USERNAME and SEARXNG_PASSWORD. The
 * password goes only in the Authorization header: never in an address, a log line or an answer.
 * Each user has FLASH_FREE_DAILY_SEARCHES searches a day (20 by default), Flash as a whole
 * FLASH_SEARXNG_DAILY_REQUESTS (5,000), and the same query is answered from the cache for 10 minutes.
 */

const TIMEOUT_MS = 8000;
const MAX_BYTES = 2_000_000;
const CACHE_FOR = 10 * 60_000;
// SearXNG asks its engines in parallel for each search, so Flash sends it at most this many a second.
const PER_SECOND = 5;
const QUERY_CHARS = 200;
const LANGUAGE = /^(?:all|[a-z]{2}(?:-[A-Z]{2})?)$/;
const RECENT = ["day", "week", "month", "year"] as const;

export type SearxConfig = { base: string; authorization: string };

/**
 * Where SearXNG is and how to sign in, or null unless all three variables are set and the address
 * is https (an http address would send the password in the clear, so it's refused).
 */
export function searxngConfig(env: Record<string, string | undefined> = process.env): SearxConfig | null {
  const raw = env.SEARXNG_URL?.trim();
  const username = env.SEARXNG_USERNAME?.trim();
  const password = env.SEARXNG_PASSWORD;
  if (!raw || !username || !password || username.includes(":")) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  return { base: url.href.replace(/\/+$/, ""), authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
}

export const searxngReady = (env: Record<string, string | undefined> = process.env) => searxngConfig(env) !== null;

/** Why SEARXNG_URL can't be used, for the owner dashboard: "" when it can (or isn't set). */
export function searxngUrlProblem(env: Record<string, string | undefined> = process.env): string {
  const raw = env.SEARXNG_URL?.trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return "SEARXNG_URL must start with https://";
    if (url.username || url.password || url.search || url.hash) return "SEARXNG_URL must be the address alone, without a name, password or ?";
    return "";
  } catch {
    return "SEARXNG_URL isn't an address";
  }
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

/** Takes one of this user's free searches for today, or returns false when they're used up. */
async function reserveSearch(userId: string, at: number): Promise<boolean> {
  const d = day(at);
  await run("INSERT OR IGNORE INTO free_user_quota (day, user_id, kind) VALUES (?, ?, 'search')", [d, userId]);
  const r = await run("UPDATE free_user_quota SET used = used + 1 WHERE day = ? AND user_id = ? AND kind = 'search' AND used < ?", [
    d,
    userId,
    envCount("FLASH_FREE_DAILY_SEARCHES", 20),
  ]);
  return r.rowsAffected === 1;
}

/** Gives back a search that couldn't be done. */
async function releaseSearch(userId: string, at: number): Promise<void> {
  await run("UPDATE free_user_quota SET used = used - 1 WHERE day = ? AND user_id = ? AND kind = 'search' AND used > 0", [day(at), userId]).catch(
    (err) => console.error("[flash] giving back a search failed", err),
  );
}

/** Searches this user has done today (for tests and the dashboard). */
export async function searchesToday(userId: string, at = Date.now()): Promise<number> {
  const row = await one<{ used: number }>("SELECT used FROM free_user_quota WHERE day = ? AND user_id = ? AND kind = 'search'", [day(at), userId]);
  return Number(row?.used ?? 0);
}

type Query = { query: string; language: string; recent?: (typeof RECENT)[number] };

/** One search, from the cache or SearXNG: its results, or null when it couldn't be done. Never throws. */
export async function searxSearch(config: SearxConfig, q: Query, { signal, at = Date.now() }: { signal?: AbortSignal; at?: number } = {}): Promise<WebResult[] | null> {
  const key = cacheKey("web", q.query.toLowerCase(), q.language, q.recent ?? "");
  const cached = await cacheGet<WebResult[]>(key, at);
  if (cached) return cached;
  try {
    if (!(await reserveDaily("searxng", envCount("FLASH_SEARXNG_DAILY_REQUESTS", 5000), at))) {
      console.error("[flash] web search skipped: today's SearXNG requests are used up across Flash");
      return null;
    }
    if (!(await takeSlot("searxng", PER_SECOND, 1000))) {
      console.error("[flash] web search skipped: SearXNG is busy");
      return null;
    }
    const params = new URLSearchParams({ q: q.query, format: "json", language: q.language, safesearch: "1" });
    if (q.recent) params.set("time_range", q.recent);
    const json = asObject(
      await fetchJson(`${config.base}/search?${params}`, { headers: { Authorization: config.authorization }, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, signal }),
    );
    const raw = Array.isArray(json?.results) ? json.results : null;
    if (!raw) {
      console.error("[flash] web search failed: SearXNG sent no results list");
      return null;
    }
    const seen = new Set<string>();
    const results: WebResult[] = [];
    for (const item of raw) {
      const r = webResult(item);
      if (!r || seen.has(r.url)) continue;
      seen.add(r.url);
      results.push(r);
      if (results.length >= SEARCH_RESULTS) break;
    }
    // Nothing back while engines failed is a failed search, not an empty one.
    const unresponsive = Array.isArray(json?.unresponsive_engines) ? json.unresponsive_engines.length : 0;
    if (!results.length && unresponsive) {
      console.error(`[flash] web search failed: SearXNG's engines didn't answer (${unresponsive})`);
      return null;
    }
    if (results.length) await cachePut(key, results, CACHE_FOR, at);
    return results;
  } catch (err) {
    // What the owner can fix, said in the log: a wrong name or password, or SearXNG's JSON answers turned off.
    const hint =
      err instanceof SourceError && err.status === 401
        ? " (check SEARXNG_USERNAME and SEARXNG_PASSWORD)"
        : err instanceof SourceError && err.status === 403
          ? " (turn on SearXNG's json format: search > formats in its settings.yml)"
          : err instanceof SourceError && err.status === 429
            ? " (SearXNG's limiter: server > limiter in its settings.yml)"
            : "";
    console.error(`[flash] web search failed: ${failureNote(err)}${hint}`);
    return null;
  }
}

/** What the model asked to search for, checked, or why it can't be used. */
export function searchInput(input: unknown, language = ""): Query | string {
  const i = asObject(input);
  const query = cleanText(i?.query, QUERY_CHARS);
  if (!query) return "query must be a few words to search for";
  const asked = typeof i?.language === "string" ? i.language.trim() : "";
  const fallback = /^[a-z]{2}/.test(language) ? language.slice(0, 2) : "all";
  const recent = RECENT.find((r) => r === i?.recent);
  return { query, language: LANGUAGE.test(asked) ? asked : fallback, ...(recent && { recent }) };
}

/**
 * The web_search tool for one free reply: userId's daily searches are counted (one given back when it
 * fails), language is the user's answer language ("" for any). Null when SearXNG isn't set up.
 */
export function webSearchTool(userId: string, { language = "", t = english, at = Date.now }: { language?: string; t?: Translate; at?: () => number } = {}): ClientTool | null {
  const config = searxngConfig();
  if (!config) return null;
  return {
    ...WEB_SEARCH,
    family: "web",
    status: (input) => {
      const query = cleanText(asObject(input)?.query, 60);
      return query ? t("Searching the web for {query}…", { query }) : t("Looking…");
    },
    run: async (input, signal): Promise<ToolResult> => {
      const q = searchInput(input, language);
      if (typeof q === "string") return { text: badInput(WEB_SEARCH.name, q), isError: true, used: false };
      const now = at();
      try {
        if (!(await reserveSearch(userId, now))) return { text: SEARCH_USED_UP, isError: true, used: false };
      } catch (err) {
        console.error("[flash] counting a free search failed", err);
        return { text: SEARCH_FAILED, isError: true, used: false };
      }
      const results = await searxSearch(config, q, { signal, at: now });
      if (!results) {
        await releaseSearch(userId, now);
        return { text: SEARCH_FAILED, isError: true, used: false };
      }
      return { text: "", isError: false, used: results.length > 0, web: { query: q.query, results } };
    },
  };
}
