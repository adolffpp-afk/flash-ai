import type { InValue } from "@libsql/client";
import { one, run, now } from "./db.ts";

type Statement = { sql: string; args: InValue[] };

/**
 * Counts an attempt (or several at once, like a batch of calls) against key and says whether it
 * is over max within the window. Stored in the database so every server instance shares the count.
 */
export async function overLimit(key: string, max: number, windowMs: number, attempts = 1): Promise<boolean> {
  const t = now();
  await run(
    `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN reset_at < ? THEN ? ELSE count + ? END,
       reset_at = CASE WHEN reset_at < ? THEN ? ELSE reset_at END`,
    [key, attempts, t + windowMs, t, attempts, attempts, t, t + windowMs],
  );
  const row = await one<{ count: number }>("SELECT count FROM rate_limits WHERE key = ?", [key]);
  return Number(row?.count ?? 0) > max;
}

/**
 * Takes one of key's max in its window in one statement, so requests at the same moment can't both
 * take the last one: null, changing nothing, once they're all used. Otherwise when the window it
 * took from ends (its reset_at), for giveBackOne. With max 1 it holds key until clearLimit or the
 * window ends.
 */
export async function takeOne(key: string, max: number, windowMs: number): Promise<number | null> {
  const t = now();
  const r = await run(
    `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN reset_at < ? THEN 1 ELSE count + 1 END,
       reset_at = CASE WHEN reset_at < ? THEN excluded.reset_at ELSE reset_at END
     WHERE reset_at < ? OR count < ?
     RETURNING reset_at`,
    [key, t + windowMs, t, t, t, max],
  );
  return r.rows.length ? Number(r.rows[0].reset_at) : null;
}

/**
 * Gives back one count of each key taken with takeOne, into the window it was taken from (until, as
 * takeOne said), in one statement: once that window has ended and another begun, nothing, so a count
 * taken just before a window ends is never handed to the next one.
 */
export async function giveBackOne(taken: [key: string, until: number][]): Promise<void> {
  if (!taken.length) return;
  await run(`UPDATE rate_limits SET count = count - 1 WHERE (${taken.map(() => "(key = ? AND reset_at = ?)").join(" OR ")}) AND count > 0`, taken.flat());
}

/**
 * A condition that is true while `attempts` more fit within max on key in its current window, for a
 * statement whose writes take them with takeAfter in the same transaction, so requests at the same
 * moment can't push it past max.
 */
export const fitsWithin = (key: string, max: number, attempts: number, t = now()): Statement => ({
  sql: "COALESCE((SELECT count FROM rate_limits WHERE key = ? AND reset_at >= ?), 0) + ? <= ?",
  args: [key, t, attempts, max],
});

/**
 * Counts attempts against each key in its window, as the next statement of a batch after the one it
 * is for, and only when that one changed a row (one conditioned on fitsWithin, say): a statement
 * that changed nothing takes nothing.
 */
export const takeAfter = (keys: string[], attempts: number, windowMs: number, t = now()): Statement => ({
  sql: `INSERT INTO rate_limits (key, count, reset_at) SELECT column1, ?, ? FROM (VALUES ${keys.map(() => "(?)").join(", ")}) WHERE changes() > 0
        ON CONFLICT(key) DO UPDATE SET
          count = CASE WHEN reset_at < ? THEN excluded.count ELSE count + excluded.count END,
          reset_at = CASE WHEN reset_at < ? THEN excluded.reset_at ELSE reset_at END`,
  args: [attempts, t + windowMs, ...keys, t, t],
});

/** How many attempts key has counted in its current window, without counting one. */
export async function countOf(key: string): Promise<number> {
  const row = await one<{ count: number }>("SELECT count FROM rate_limits WHERE key = ? AND reset_at >= ?", [key, now()]);
  return Number(row?.count ?? 0);
}

export async function clearLimit(key: string): Promise<void> {
  await run("DELETE FROM rate_limits WHERE key = ?", [key]);
}

/** The client's own address, from the proxy header when there is one, or "" when there's none. */
export const clientAddress = (request: Request) => (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || request.headers.get("x-real-ip") || "";

/**
 * The client's address, from the proxy header when there is one. An IPv6 address counts by its
 * /64 network, the block one home or server is given, so rotating addresses inside it doesn't
 * get a fresh allowance.
 */
export const clientIp = (request: Request) => network(clientAddress(request) || "local");

export function network(ip: string): string {
  if (!ip.includes(":") || /^::ffff:\d/i.test(ip)) return ip;
  const [head, tail = ""] = ip.toLowerCase().replace(/%.*$/, "").split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back] : front;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
