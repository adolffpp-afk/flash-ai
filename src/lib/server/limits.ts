import { one, run, now } from "./db.ts";

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
 * Counts attempts against key only while they fit within max in the window, in one statement, so
 * requests at the same moment can't push it past max: one that doesn't fit writes nothing and
 * leaves the count as it was. Says whether they were counted.
 */
export async function takeWithin(key: string, max: number, windowMs: number, attempts = 1): Promise<boolean> {
  if (attempts > max) return false;
  const t = now();
  const r = await run(
    `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN reset_at < ? THEN excluded.count ELSE count + excluded.count END,
       reset_at = CASE WHEN reset_at < ? THEN excluded.reset_at ELSE reset_at END
     WHERE reset_at < ? OR count + excluded.count <= ?
     RETURNING count`,
    [key, attempts, t + windowMs, t, t, t, max],
  );
  return r.rows.length > 0;
}

/** Gives back attempts counted against key in its current window that weren't used. */
export async function giveBack(key: string, attempts: number): Promise<void> {
  if (attempts > 0) await run("UPDATE rate_limits SET count = MAX(0, count - ?) WHERE key = ? AND reset_at >= ?", [attempts, key, now()]);
}

/** How many attempts key has counted in its current window, without counting one. */
export async function countOf(key: string): Promise<number> {
  const row = await one<{ count: number }>("SELECT count FROM rate_limits WHERE key = ? AND reset_at >= ?", [key, now()]);
  return Number(row?.count ?? 0);
}

export async function clearLimit(key: string): Promise<void> {
  await run("DELETE FROM rate_limits WHERE key = ?", [key]);
}

/**
 * The client's address, from the proxy header when there is one. An IPv6 address counts by its
 * /64 network, the block one home or server is given, so rotating addresses inside it doesn't
 * get a fresh allowance.
 */
export const clientIp = (request: Request) =>
  network((request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || request.headers.get("x-real-ip") || "local");

export function network(ip: string): string {
  if (!ip.includes(":") || /^::ffff:\d/i.test(ip)) return ip;
  const [head, tail = ""] = ip.toLowerCase().replace(/%.*$/, "").split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back] : front;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
