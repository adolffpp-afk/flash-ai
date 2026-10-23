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
import { claudeConfigured, getClient } from "../engines/claude.ts";
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
export const keyInUse = (): KeyInUse => (process.env.ANTHROPIC_AUTOMATIONS_API_KEY ? "automations" : claudeConfigured() ? "shared" : "none");

/** On chat's own key, at most this many automation runs call the model at once. */
export const AUTOMATION_SHARED_PAID = 2;

let ownClient: { key: string; client: Anthropic } | null = null;
/** The Anthropic client AI steps call (and count tokens) with: the automations key's, else chat's. */
export function automationClient(): Anthropic {
  const key = process.env.ANTHROPIC_AUTOMATIONS_API_KEY;
  if (!key) return getClient();
  // Never chat's token: this key alone.
  if (ownClient?.key !== key) ownClient = { key, client: new Anthropic({ apiKey: key, authToken: null }) };
  return ownClient.client;
}

/**
 * Runs whose next step is an AI step, Flash-wide, at once: sized to the automations workspace's rate
 * limit (see the plan's §21; about its input tokens a minute ÷ 50,000). The workspace has no limit of
 * its own, so automations share the organisation's with chat: 10 at once keeps most of it for chat
 * until AUTOMATION_MAX_PAID says otherwise.
 */
export const MAX_PAID_DEFAULT = 10;
export function maxPaid(): number {
  const set = Math.floor(Number(process.env.AUTOMATION_MAX_PAID));
  const n = set > 0 ? set : MAX_PAID_DEFAULT;
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

/** The settings row /admin's switch sets: "1" while automations are open to everyone, not only admins. */
export const OPEN_KEY = "auto:open";
/** How long a server keeps what the switch says before reading it again. */
export const OPEN_KEPT_MS = 30_000;
let openKept: { open: boolean; at: number } | null = null;

/** Whether an admin opened automations to everyone (read at most every 30 s on each server). */
export async function openToEveryone(): Promise<boolean> {
  if (openKept && Date.now() - openKept.at < OPEN_KEPT_MS) return openKept.open;
  const row = await one<{ value: string }>("SELECT value FROM settings WHERE key = ?", [OPEN_KEY]);
  openKept = { open: row?.value === "1", at: Date.now() };
  return openKept.open;
}

/**
 * Opens or closes automations to everyone (/admin's switch). Opening needs everything set up here,
 * their own Anthropic key included, so chat's key is never shared with everyone's runs; closing always
 * works. This server knows at once, the others within OPEN_KEPT_MS. Returns whether it changed.
 */
export async function setOpenToEveryone(open: boolean): Promise<boolean> {
  if (open && (!automationsServer() || missingSetup().length || keyInUse() !== "automations")) return false;
  await sql("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [OPEN_KEY, open ? "1" : "0"]);
  openKept = { open, at: Date.now() };
  return true;
}

/** Forgets what the switch said, so the next read asks the database (tests). */
export const forgetOpen = () => {
  openKept = null;
};

/**
 * Who automations are open to: admins (the burn-in on /admin), and everyone once an admin opens them
 * with /admin's switch; anyone else gets 404 from every automation route. Writes and runs also need a
 * confirmed email (gate() in automation-api.ts, and the runner).
 */
export const automationsOpenTo = async (user: Pick<User, "email" | "verified_at">): Promise<boolean> => isAdmin(user) || (await openToEveryone());

/** Whether automations can run for this user here: everything set up, and open to them. */
export async function automationsReady(user: Pick<User, "email" | "verified_at">): Promise<boolean> {
  return automationsServer() && Boolean(cronSecret()) && keyInUse() !== "none" && Boolean(process.env.FLASH_APP_URL) && (await automationsOpenTo(user));
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
