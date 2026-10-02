import {
  CLOUDFLARE_DAILY_NEURONS,
  FLUX_SCHNELL_NEURONS,
  FREE_DAILY_CHATS,
  FREE_DAILY_IMAGES,
  type FreeProvider,
} from "../engines/free.ts";
import { one, run } from "./db.ts";

export const FREE_PROVIDERS: FreeProvider[] = ["groq", "openrouter", "cloudflare"];

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const dayStart = (t = Date.now()) => Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate());
// SQLite can't bind Infinity.
const cap = (n: number) => (Number.isFinite(n) ? n : 1e15);
// Room kept for one chat reply when Cloudflare is the chat provider.
const CHAT_NEURON_RESERVE = 300;

/** Takes one request from a provider's daily allowance, or returns false when it is used up. */
export async function reserveFree(provider: FreeProvider, limits: { requests: number; tokens: number }): Promise<boolean> {
  const d = day();
  await run("INSERT OR IGNORE INTO free_quota (day, provider) VALUES (?, ?)", [d, provider]);
  const r = await run(
    `UPDATE free_quota SET requests = requests + 1
     WHERE day = ? AND provider = ? AND requests < ? AND tokens < ? AND (provider != 'cloudflare' OR neurons + ? <= ?)`,
    [d, provider, cap(limits.requests), cap(limits.tokens), CHAT_NEURON_RESERVE, CLOUDFLARE_DAILY_NEURONS],
  );
  return r.rowsAffected === 1;
}

export async function recordFree(provider: FreeProvider, tokens: number, neurons: number): Promise<void> {
  await run("UPDATE free_quota SET tokens = tokens + ?, neurons = neurons + ? WHERE day = ? AND provider = ?", [
    Math.round(tokens),
    neurons,
    day(),
    provider,
  ]);
}

/** Takes one image's worth of Cloudflare's free neurons, or returns false when today's are used up. */
export async function reserveFreeImage(): Promise<boolean> {
  const d = day();
  await run("INSERT OR IGNORE INTO free_quota (day, provider) VALUES (?, 'cloudflare')", [d]);
  const r = await run(
    `UPDATE free_quota SET requests = requests + 1, neurons = neurons + ?
     WHERE day = ? AND provider = 'cloudflare' AND neurons + ? <= ?`,
    [FLUX_SCHNELL_NEURONS, d, FLUX_SCHNELL_NEURONS, CLOUDFLARE_DAILY_NEURONS],
  );
  return r.rowsAffected === 1;
}

/** Free requests this user has used today, and how many are left. */
export async function freeLeft(userId: string, kind: "chat" | "image"): Promise<number> {
  const row = await one<{ used: number }>(
    `SELECT COUNT(*) AS used FROM usage
     WHERE user_id = ? AND created_at >= ? AND ok = 1 AND provider IN ('groq', 'openrouter', 'cloudflare')
       AND ${kind === "image" ? "engine = 'image'" : "engine != 'image'"}`,
    [userId, dayStart()],
  );
  const limit = kind === "image" ? FREE_DAILY_IMAGES : FREE_DAILY_CHATS;
  return Math.max(0, limit - Number(row?.used ?? 0));
}
