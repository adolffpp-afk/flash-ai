import { all } from "./db.ts";
import { freeLeft } from "./free.ts";
import type { FreeLane } from "../engines/free.ts";

/** The first moment of this calendar month (UTC), when free credits refill. */
export const monthStart = (t = new Date()) => Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1);
/** The first moment of next month (UTC). */
export const nextMonthStart = (t = new Date()) => Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1);

export type UsageSummary = {
  since: number;
  refill: number;
  // Credits spent this month on each tool, most first.
  tools: { engine: string; credits: number; requests: number }[];
  total: number;
  // Free requests left today, for when credits run out.
  freeLeft: Partial<Record<FreeLane, number>>;
};

/** What the user spent this month, by tool, for Settings > Usage. */
export async function usageSummary(userId: string, at = new Date()): Promise<UsageSummary> {
  const since = monthStart(at);
  const rows = await all<{ engine: string; credits: number; requests: number }>(
    `SELECT engine, COALESCE(SUM(credits), 0) AS credits, COUNT(*) AS requests
     FROM usage WHERE user_id = ? AND created_at >= ? AND part = 0 GROUP BY engine ORDER BY credits DESC, requests DESC`,
    [userId, since],
  );
  const tools = rows.map((r) => ({ engine: r.engine, credits: Number(r.credits), requests: Number(r.requests) }));
  const kinds: FreeLane[] = ["chat", "image", "transcribe"];
  const left = await Promise.all(kinds.map((k) => freeLeft(userId, k)));
  return {
    since,
    refill: nextMonthStart(at),
    tools,
    total: tools.reduce((sum, t) => sum + t.credits, 0),
    freeLeft: Object.fromEntries(kinds.map((k, i) => [k, left[i]])),
  };
}
