import {
  CLOUDFLARE_DAILY_NEURONS,
  FLUX_SCHNELL_NEURONS,
  FREE_DAILY_CHATS,
  FREE_DAILY_IMAGES,
  FREE_DAILY_TRANSCRIPTS,
  GROQ_AUDIO_DAILY_REQUESTS,
  GROQ_AUDIO_DAILY_SECONDS,
  type FreeLane,
  type FreeProvider,
} from "../engines/free.ts";
import { one, run } from "./db.ts";

export const FREE_PROVIDERS: FreeProvider[] = ["groq", "gemini", "openrouter", "cloudflare"];

/** The user's country from Vercel's location header (two letters), or "" when it's unknown. */
export const countryOf = (request: Request) => (request.headers.get("x-vercel-ip-country") ?? "").toUpperCase();

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
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

// Room kept for one recording when taking a free transcript: 3 MB is at most about 10 minutes of speech.
const AUDIO_SECONDS_RESERVE = 600;

/** Takes one transcript from Groq's free Whisper allowance, or returns false when today's is used up. */
export async function reserveFreeAudio(): Promise<boolean> {
  const d = day();
  await run("INSERT OR IGNORE INTO free_quota (day, provider) VALUES (?, 'groq-audio')", [d]);
  // For Whisper, "tokens" counts seconds of audio.
  const r = await run(
    `UPDATE free_quota SET requests = requests + 1
     WHERE day = ? AND provider = 'groq-audio' AND requests < ? AND tokens + ? <= ?`,
    [d, GROQ_AUDIO_DAILY_REQUESTS, AUDIO_SECONDS_RESERVE, GROQ_AUDIO_DAILY_SECONDS],
  );
  return r.rowsAffected === 1;
}

export async function recordFreeAudio(seconds: number): Promise<void> {
  await run("UPDATE free_quota SET tokens = tokens + ? WHERE day = ? AND provider = 'groq-audio'", [Math.ceil(seconds), day()]);
}

const userLimit = (kind: FreeLane) => (kind === "image" ? FREE_DAILY_IMAGES : kind === "transcribe" ? FREE_DAILY_TRANSCRIPTS : FREE_DAILY_CHATS);

/** Free requests this user has left today. */
export async function freeLeft(userId: string, kind: FreeLane): Promise<number> {
  const row = await one<{ used: number }>("SELECT used FROM free_user_quota WHERE day = ? AND user_id = ? AND kind = ?", [
    day(),
    userId,
    kind,
  ]);
  return Math.max(0, userLimit(kind) - Number(row?.used ?? 0));
}

/**
 * Takes one of this user's free requests for today, or returns false when they are used up.
 * Reserved in one statement, so requests sent at the same time can't pass the cap.
 */
export async function reserveFreeUser(userId: string, kind: FreeLane): Promise<boolean> {
  const d = day();
  await run("INSERT OR IGNORE INTO free_user_quota (day, user_id, kind) VALUES (?, ?, ?)", [d, userId, kind]);
  const r = await run("UPDATE free_user_quota SET used = used + 1 WHERE day = ? AND user_id = ? AND kind = ? AND used < ?", [
    d,
    userId,
    kind,
    userLimit(kind),
  ]);
  return r.rowsAffected === 1;
}

/** Gives back a reserved free request that failed. */
export async function releaseFreeUser(userId: string, kind: FreeLane): Promise<void> {
  await run("UPDATE free_user_quota SET used = used - 1 WHERE day = ? AND user_id = ? AND kind = ? AND used > 0", [
    day(),
    userId,
    kind,
  ]);
}
