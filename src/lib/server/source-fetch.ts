import { createHash } from "node:crypto";
import { one, run } from "./db.ts";

/*
 * What the data tools (server/searxng.ts, server/sec.ts, server/fred.ts) share to fetch safely and
 * kindly: a JSON fetch with a timeout and a size cap that never follows a redirect, a limit on
 * requests per second shared by every server (in rate_limits), a daily cap for each source across
 * Flash (in free_quota, as for MET Norway's forecasts), and a short cache shared by every user (in
 * source_cache). A failure never carries the address it was fetching: FRED's key is in its query.
 */

/** Why a fetch failed, in words safe to log: never the address, a header or a key. */
export type SourceFailure = "timeout" | "network" | "status" | "too_big" | "bad_json" | "busy";

export class SourceError extends Error {
  readonly reason: SourceFailure;
  readonly status: number;
  constructor(reason: SourceFailure, status = 0) {
    super(`source request failed: ${reason}${status ? ` ${status}` : ""}`);
    this.name = "SourceError";
    this.reason = reason;
    this.status = status;
  }
}

export type FetchOptions = {
  headers?: Record<string, string>;
  /** The most the whole request may take, reading included. */
  timeoutMs: number;
  /** The most the body may be, in bytes. */
  maxBytes: number;
  /** The reply's own signal: a request stopped by the user stops this too. */
  signal?: AbortSignal;
};

/** Reads a body up to maxBytes, or throws as soon as it's longer. */
async function readCapped(res: Response, maxBytes: number, timeout: AbortSignal): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new SourceError("too_big");
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof SourceError) throw err;
    throw new SourceError(timeout.aborted ? "timeout" : "network");
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * GETs JSON from a source. Only a 200 counts: a redirect, an error or anything else throws a
 * SourceError (with the status), as do a timeout, a body over maxBytes and a body that isn't JSON.
 */
export async function fetchJson(url: string, options: FetchOptions): Promise<unknown> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", ...options.headers },
      cache: "no-store",
      redirect: "manual",
      signal,
    });
  } catch {
    throw new SourceError(timeout.aborted ? "timeout" : "network");
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    throw new SourceError("status", res.status);
  }
  if (Number(res.headers.get("content-length")) > options.maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new SourceError("too_big");
  }
  const text = await readCapped(res, options.maxBytes, timeout);
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError("bad_json");
  }
}

/** A failure as the server log reads it: what went wrong, never where. */
export const failureNote = (err: unknown) => (err instanceof SourceError ? err.message : "source request failed: unexpected error");

// ---------------------------------------------------------------------------------------------
// Requests per second, shared by every server

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const SLOT_PREFIX = "source:";
const PRUNE_SLOTS_EVERY = 10 * 60_000;
let slotsPrunedAt = 0;

export type SlotOptions = { waitMs?: number; now?: () => number; wait?: (ms: number) => Promise<void> };

/**
 * Takes one of a source's requests in the current window (perWindow per windowMs, counted in
 * rate_limits so every server shares them), waiting for the next window while this one is full, up
 * to waitMs. False when none came free in time: the caller fails as busy, it never goes over.
 */
export async function takeSlot(source: string, perWindow: number, windowMs: number, { waitMs = 3000, now = Date.now, wait = sleep }: SlotOptions = {}): Promise<boolean> {
  const start = now();
  if (start - slotsPrunedAt >= PRUNE_SLOTS_EVERY) {
    slotsPrunedAt = start;
    // Only this file's keys: they sort between "source:" and "source;".
    await run("DELETE FROM rate_limits WHERE key >= ? AND key < ? AND reset_at < ?", [SLOT_PREFIX, "source;", start - 60_000]).catch((err) =>
      console.error("[flash] pruning source rate limits failed", err),
    );
  }
  for (;;) {
    const t = now();
    const window = Math.floor(t / windowMs);
    const r = await run(
      `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET count = count + 1 WHERE count < ?`,
      [`${SLOT_PREFIX}${source}:${window}`, (window + 1) * windowMs, perWindow],
    );
    if (r.rowsAffected === 1) return true;
    const next = (window + 1) * windowMs;
    if (next - start > waitMs) return false;
    // A little later than the window's start, spread out so waiting requests don't all arrive at once.
    await wait(next - t + 5 + Math.floor(Math.random() * 40));
  }
}

// ---------------------------------------------------------------------------------------------
// A daily cap for each source, across Flash

/** Takes one request from a source's daily allowance across Flash (in free_quota), or returns false when it's used up. */
export async function reserveDaily(source: string, cap: number, at = Date.now()): Promise<boolean> {
  const day = new Date(at).toISOString().slice(0, 10);
  await run("INSERT OR IGNORE INTO free_quota (day, provider) VALUES (?, ?)", [day, source]);
  const r = await run("UPDATE free_quota SET requests = requests + 1 WHERE day = ? AND provider = ? AND requests < ?", [day, source, cap]);
  return r.rowsAffected === 1;
}

/**
 * A stand-in's address for a source, from the environment variable name, for checking a build on a
 * computer: https only, and never on Vercel (VERCEL_ENV is always set there), so a deployment always
 * talks to the real source. Null when unset or unusable.
 */
export function testBase(name: string): string | null {
  const raw = process.env[name]?.trim();
  if (!raw || process.env.VERCEL_ENV) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && !url.search ? url.href.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

/** A whole number from the environment, or the default when it's unset or not a positive number. */
export function envCount(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------------------------
// The shared cache

/** The most one cached value may be, in characters: values are kept already trimmed, so far less. */
const MAX_CACHED = 200_000;
const PRUNE_CACHE_EVERY = 60 * 60_000;
let cachePrunedAt = 0;

/** A cache key from parts a user or a model wrote: a fingerprint, so the words themselves aren't stored as a key. */
export const cacheKey = (kind: string, ...parts: string[]) => `${kind}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 40)}`;

async function pruneCache(at: number) {
  if (at - cachePrunedAt < PRUNE_CACHE_EVERY) return;
  cachePrunedAt = at;
  await run("DELETE FROM source_cache WHERE expires_at < ?", [at]).catch((err) => console.error("[flash] pruning source_cache failed", err));
}

/** A cached value that hasn't expired, or null (also when the cache can't be read: the source is asked instead). */
export async function cacheGet<T>(key: string, at = Date.now()): Promise<T | null> {
  await pruneCache(at);
  const row = await one<{ value: string; expires_at: number }>("SELECT value, expires_at FROM source_cache WHERE key = ?", [key]).catch(
    (err) => (console.error("[flash] reading source_cache failed", err), null),
  );
  if (!row || Number(row.expires_at) <= at) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

/** Keeps a value for ttlMs. A failure to save only means the next ask fetches again. */
export async function cachePut(key: string, value: unknown, ttlMs: number, at = Date.now()): Promise<void> {
  const text = JSON.stringify(value);
  if (text.length > MAX_CACHED) return;
  await run(
    `INSERT INTO source_cache (key, value, expires_at, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, fetched_at = excluded.fetched_at`,
    [key, text, at + ttlMs, at],
  ).catch((err) => console.error("[flash] saving to source_cache failed", err));
}
