/*
 * The server side of automations that isn't the engine itself: where they may run, the cron
 * secret, the Anthropic key their AI steps use, the limits the tick claims runs with, and the
 * account a run is for. The engine is in automation-tick.ts (the per-minute tick), automation-runner.ts
 * (a run's steps) and automation-steps.ts (an AI step and a notice).
 *
 * Runs happen only on production (VERCEL_ENV), or on a laptop with AUTOMATIONS_DEV=1, so a preview
 * deployment never ticks, works or starts a run even if it shares the production database.
 */
import Anthropic from "@anthropic-ai/sdk";
import { createHash, timingSafeEqual } from "node:crypto";
import { RUNNER_VERSION } from "../automations.ts";
import { claudeConfigured, getClient, LEVEL_MODELS } from "../engines/claude.ts";
import { isAdmin, type User } from "./auth.ts";
import { one, run as sql } from "./db.ts";
import { BACKOFF_KEY, DB_NOW, type ClaimLimits } from "./leases.ts";
import { overLimit } from "./limits.ts";

/** Whether this deployment runs automations: production, or a laptop that asked to (never a Vercel preview). */
export const automationsServer = () => process.env.VERCEL_ENV === "production" || (!process.env.VERCEL && process.env.AUTOMATIONS_DEV === "1");

/** The cron secret, when it is long enough to be one (Vercel sends it as the tick's bearer token). */
export function cronSecret(): string {
  const secret = process.env.CRON_SECRET ?? "";
  return secret.length >= 32 ? secret : "";
}

/** CRON_SECRET is set but too short to be used: /admin says so, rather than that it's missing. */
export const cronSecretTooShort = () => Boolean(process.env.CRON_SECRET) && !cronSecret();

/** Compares two strings in constant time, whatever their lengths (their SHA-256s are compared). */
export function sameSecret(a: string, b: string): boolean {
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(a), hash(b));
}

/**
 * The checks every cron call passes first (the tick and the work call): 404 off production, 503 until
 * CRON_SECRET is set (/admin lists it under missing setup), 401 without its bearer token. null: go on.
 */
export function cronRefusal(request: Request): Response | null {
  if (!automationsServer()) return new Response(null, { status: 404 });
  const secret = cronSecret();
  if (!secret) return new Response(null, { status: 503 });
  if (!sameSecret(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) return new Response(null, { status: 401 });
  return null;
}

/**
 * Which Anthropic key AI steps use: their own (ANTHROPIC_AUTOMATIONS_API_KEY, a workspace with lower
 * rate limits, so automations can never use up chat's), or until it is set, chat's own key with at
 * most AUTOMATION_SHARED_PAID runs calling the model at once. /admin says which.
 */
export type KeyInUse = "automations" | "shared" | "none";

/**
 * The automations key as pasted into Vercel, without what a paste can bring along: spaces and line
 * breaks (anywhere: a key has none), invisible characters, and quotes around it.
 */
export const automationsKey = (env: Record<string, string | undefined> = process.env) =>
  (env.ANTHROPIC_AUTOMATIONS_API_KEY ?? "").replace(/[\s\p{Cf}]+/gu, "").replace(/^["'\u2018\u2019\u201c\u201d]+|["'\u2018\u2019\u201c\u201d]+$/g, "");

export const keyInUse = (): KeyInUse => (automationsKey() ? "automations" : claudeConfigured() ? "shared" : "none");

/**
 * What a failed call to Anthropic means for the owner: the key (pasted wrong, so it never reached
 * Anthropic or was refused), its permissions, a model the workspace can't use, Anthropic busy or not
 * reached (it passes), or anything else (what was said tells).
 */
export type ProblemKind = "key" | "permission" | "model" | "busy" | "other";
export function problemKind(err: unknown): ProblemKind {
  const e = err as { status?: number; error?: { error?: { type?: string } } };
  // A key with a character a header can't carry fails before anything is sent.
  if (err instanceof TypeError && /header|ByteString/i.test(err.message)) return "key";
  if (e?.status === 401) return "key";
  if (e?.status === 403) return "permission";
  if (e?.status === 404 || e?.error?.error?.type === "not_found_error") return "model";
  if (err instanceof Anthropic.APIConnectionError || e?.status === 408 || e?.status === 429 || (e?.status ?? 0) >= 500) return "busy";
  return "other";
}

/** Anthropic's keys as set in Vercel, and each piece of one pasted across lines, longest first (for blanking). */
function keysSet(): string[] {
  const set = ["ANTHROPIC_AUTOMATIONS_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].map((name) => process.env[name] ?? "");
  const pieces = [...set, automationsKey(), ...set.flatMap((v) => v.split(/[\s\p{Cf}"'\u2018\u2019\u201c\u201d]+/u))];
  return [...new Set(pieces.filter((p) => p.length >= 8))].sort((a, b) => b.length - a.length);
}

/**
 * What Anthropic said about an error, for /admin and the logs: its status, its type and its words, never
 * a key (the keys set, anything shaped like one, and a header value a key broke are blanked), at most
 * 200 characters.
 */
export function anthropicProblem(err: unknown): string {
  const e = err as { status?: number; type?: string | null; error?: { error?: { type?: string; message?: string } }; name?: string; message?: string; cause?: { message?: string } };
  const type =
    e?.type ||
    e?.error?.error?.type ||
    (err instanceof Anthropic.APIConnectionTimeoutError ? "timeout" : err instanceof Anthropic.APIConnectionError ? "connection_error" : e?.name) ||
    "Error";
  // A key that broke a header is said in Flash's words: the error's own quote the whole header value.
  if (err instanceof TypeError && /header|ByteString/i.test(err.message)) return "TypeError: the key holds a line break or another character a header can't carry";
  // The body's own words (an API error's message repeats its status and the whole body); a connection error's cause.
  const said = e?.error?.error?.message ?? e?.message ?? String(err);
  let words = `${said}${e?.cause?.message ? ` (${e.cause.message})` : ""}`;
  for (const key of keysSet()) words = words.split(key).join("[key]");
  words = words.replace(/(Headers\.\w+: )"[\s\S]*?"( is an invalid header value)/g, "$1[key]$2").replace(/sk-ant-[^\s"']*/g, "[key]");
  return `${e?.status ? `${e.status} ` : ""}${type}: ${words}`.slice(0, 200);
}

/** The levels' models the key is checked with, each once (Research at Sonic runs at Ascend, so these are all of them). */
const CHECKED_LEVELS = ["sonic", "ascend", "vision", "ultra"] as const;
/** How long a key check is kept on each server, and a shorter time when Anthropic was busy or not reached. */
export const KEY_CHECK_KEPT_MS = 60_000;
export const KEY_CHECK_BUSY_KEPT_MS = 10_000;
let keyChecked: { key: string; at: number; kept: number; result: KeyCheck } | null = null;
export type KeyCheck = { ok: boolean; problems: { level: (typeof CHECKED_LEVELS)[number]; model: string; problem: string; kind: ProblemKind }[] };

/**
 * Asks Anthropic to count a word with the automations key at each level's model (counting is free),
 * so /admin can say whether the key works, and if not, what Anthropic said and what it means (see
 * problemKind). Kept a minute (10 seconds when Anthropic was busy); null without a key of their own.
 */
export async function checkAutomationsKey(client?: Anthropic): Promise<KeyCheck | null> {
  const key = automationsKey();
  if (!key) return null;
  if (!client && keyChecked?.key === key && Date.now() - keyChecked.at < keyChecked.kept) return keyChecked.result;
  const counting = (client ?? automationClient()).withOptions({ timeout: 15_000, maxRetries: 0 });
  const models = [...new Map(CHECKED_LEVELS.map((level) => [LEVEL_MODELS[level], level])).entries()];
  const problems: KeyCheck["problems"] = [];
  await Promise.all(
    models.map(async ([model, level]) => {
      try {
        await counting.beta.messages.countTokens({ model, messages: [{ role: "user", content: "Hi" }] });
      } catch (err) {
        problems.push({ level, model, problem: anthropicProblem(err), kind: problemKind(err) });
      }
    }),
  );
  const result = { ok: problems.length === 0, problems: problems.sort((a, b) => CHECKED_LEVELS.indexOf(a.level) - CHECKED_LEVELS.indexOf(b.level)) };
  const kept = problems.some((p) => p.kind === "busy") ? KEY_CHECK_BUSY_KEPT_MS : KEY_CHECK_KEPT_MS;
  if (!client) keyChecked = { key, at: Date.now(), kept, result };
  return result;
}

/** On chat's own key, at most this many automation runs call the model at once. */
export const AUTOMATION_SHARED_PAID = 2;

let ownClient: { key: string; client: Anthropic } | null = null;
/** The Anthropic client AI steps call (and count tokens) with: the automations key's, else chat's. */
export function automationClient(): Anthropic {
  const key = automationsKey();
  if (!key) return getClient();
  // Never chat's token: this key alone.
  if (ownClient?.key !== key) ownClient = { key, client: new Anthropic({ apiKey: key, authToken: null }) };
  return ownClient.client;
}

/** Runs whose next step is an AI step, Flash-wide, at once: sized to the automations workspace's rate limit (see the plan's §21). */
export function maxPaid(): number {
  const set = Math.floor(Number(process.env.AUTOMATION_MAX_PAID));
  const n = set > 0 ? set : 30;
  return keyInUse() === "shared" ? Math.min(AUTOMATION_SHARED_PAID, n) : n;
}

/** How long paid claims wait after a 429 from Anthropic, Flash-wide. */
export const BACKOFF_MS = 60_000;

/** The 429s of the last hour, counted for /admin's cron health (a rate_limits row, pruned by the daily job). */
export const RATE_LIMITED_KEY = "auto:429s";

/** Any 429 stops paid claims Flash-wide for a minute (never shortening a wait already set), and is counted. */
export async function backOff(): Promise<void> {
  await sql(
    `INSERT INTO settings (key, value) VALUES (?, CAST(${DB_NOW} + ? AS TEXT))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(settings.value AS INTEGER) < CAST(excluded.value AS INTEGER)`,
    [BACKOFF_KEY, BACKOFF_MS],
  );
  await overLimit(RATE_LIMITED_KEY, Number.MAX_SAFE_INTEGER, 3_600_000);
}

/** Whether paid claims are open now: no 429 in the last minute. */
export async function paidOpen(): Promise<0 | 1> {
  const row = await one<{ open: number }>(`SELECT CAST(value AS INTEGER) <= ${DB_NOW} AS open FROM settings WHERE key = ?`, [BACKOFF_KEY]);
  return !row || Number(row.open) ? 1 : 0;
}

/** The limits the tick (and Run now) claim runs with; see claimRuns in leases.ts. */
export async function claimLimits(): Promise<ClaimLimits> {
  const other = Math.floor(Number(process.env.AUTOMATION_MAX_OTHER));
  return { perUser: 3, maxPaid: maxPaid(), maxOther: other > 0 ? other : 100, paidOpen: await paidOpen(), perTick: 30, runnerVersion: RUNNER_VERSION };
}

/**
 * Who automations are open to: in PR 1a only admins (the burn-in on /admin), so everyone else gets
 * 404 from every automation route; from PR 1b everyone with a confirmed email.
 */
export const automationsOpenTo = (user: Pick<User, "email" | "verified_at">): boolean => isAdmin(user);

/** Whether automations can run for this user here: everything set up, and open to them. */
export function automationsReady(user: Pick<User, "email" | "verified_at">): boolean {
  return automationsServer() && Boolean(cronSecret()) && keyInUse() !== "none" && Boolean(process.env.FLASH_APP_URL) && automationsOpenTo(user);
}

/** What /admin lists as missing before automations can run (environment variable names only, never values). */
export function missingSetup(): string[] {
  const missing: string[] = [];
  if (!cronSecret()) missing.push("CRON_SECRET");
  if (keyInUse() === "none") missing.push("ANTHROPIC_AUTOMATIONS_API_KEY");
  if (!process.env.FLASH_APP_URL) missing.push("FLASH_APP_URL");
  return missing;
}

/** The account an automation runs for, with the columns a signed-in request has (see userForSession). */
export async function userById(id: string): Promise<User | null> {
  return one<User>("SELECT id, email, name, nickname, work, language, preferences, created_at, last_free_grant, verified_at FROM users WHERE id = ?", [id]);
}
