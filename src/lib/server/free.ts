import {
  CLOUDFLARE_DAILY_NEURONS,
  FLUX_SCHNELL_NEURONS,
  FREE_DAILY_CHATS,
  FREE_DAILY_IMAGES,
  FREE_DAILY_TRANSCRIPTS,
  FREE_DAILY_VOICE_TURNS,
  GROQ_AUDIO_DAILY_REQUESTS,
  GROQ_AUDIO_DAILY_SECONDS,
  FreeRefused,
  type FreeLane,
  type FreeProvider,
} from "../engines/free.ts";
import { one, run } from "./db.ts";

export const FREE_PROVIDERS: FreeProvider[] = ["groq", "gemini", "openrouter", "cloudflare", "mistral"];

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

/**
 * Takes one transcript and reserve seconds of audio (the recording's measured length, see
 * audio-length.ts) from Groq's free Whisper allowance, or returns false when today's is used up. Both are taken in one statement, so requests sent at the same
 * time can't all fit in the room left for one. recordFreeAudio settles the seconds Groq counted.
 */
export async function reserveFreeAudio(reserve: number): Promise<boolean> {
  const d = day();
  const seconds = Math.ceil(reserve);
  await run("INSERT OR IGNORE INTO free_quota (day, provider) VALUES (?, 'groq-audio')", [d]);
  // For Whisper, "tokens" counts seconds of audio.
  const r = await run(
    `UPDATE free_quota SET requests = requests + 1, tokens = tokens + ?
     WHERE day = ? AND provider = 'groq-audio' AND requests < ? AND tokens + ? <= ?`,
    [seconds, d, GROQ_AUDIO_DAILY_REQUESTS, seconds, GROQ_AUDIO_DAILY_SECONDS],
  );
  return r.rowsAffected === 1;
}

/** Replaces the seconds reserved for a free transcript with the seconds Groq counted. */
export async function recordFreeAudio(seconds: number, reserved = 0): Promise<void> {
  await run("UPDATE free_quota SET tokens = MAX(0, tokens + ?) WHERE day = ? AND provider = 'groq-audio'", [
    Math.ceil(seconds) - Math.ceil(reserved),
    day(),
  ]);
}

/**
 * After a free transcript failed. When Groq answered with an error it never transcribed the file,
 * so the request and seconds it held go back to the allowance every user shares; when it may have
 * (it timed out, or the connection broke), they stay used. The user's own free turn goes back only
 * when Groq itself failed (a 5xx or a 429), not when it refused the file, so nobody can send bad
 * files over and over for free.
 */
export async function freeAudioFailed(userId: string, kind: FreeLane, reserved: number, err: unknown): Promise<void> {
  const status = err instanceof FreeRefused ? err.status : 0;
  if (status) {
    await run("UPDATE free_quota SET requests = MAX(0, requests - 1), tokens = MAX(0, tokens - ?) WHERE day = ? AND provider = 'groq-audio'", [
      Math.ceil(reserved),
      day(),
    ]);
  }
  if (status >= 500 || status === 429) await releaseFreeUser(userId, kind);
}

const USER_LIMITS: Record<FreeLane, number> = {
  chat: FREE_DAILY_CHATS,
  image: FREE_DAILY_IMAGES,
  transcribe: FREE_DAILY_TRANSCRIPTS,
  voice: FREE_DAILY_VOICE_TURNS,
};
const userLimit = (kind: FreeLane) => USER_LIMITS[kind];

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
