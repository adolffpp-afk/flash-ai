import { one, run, now } from "./db.ts";

/**
 * Counts an attempt against key and says whether it is over max within the window. Stored in
 * the database so every server instance shares the count.
 */
export async function overLimit(key: string, max: number, windowMs: number): Promise<boolean> {
  const t = now();
  await run(
    `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN reset_at < ? THEN 1 ELSE count + 1 END,
       reset_at = CASE WHEN reset_at < ? THEN ? ELSE reset_at END`,
    [key, t + windowMs, t, t, t + windowMs],
  );
  const row = await one<{ count: number }>("SELECT count FROM rate_limits WHERE key = ?", [key]);
  return Number(row?.count ?? 0) > max;
}

export async function clearLimit(key: string): Promise<void> {
  await run("DELETE FROM rate_limits WHERE key = ?", [key]);
}

/** The client's address, from the proxy header when there is one. */
export const clientIp = (request: Request) =>
  (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || request.headers.get("x-real-ip") || "local";
