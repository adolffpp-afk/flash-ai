/*
 * Low-credit emails. A published app keeps running with no credits (its pages, its data and its shop
 * use none), but building or changing an app needs them, and so does an app's own AI. So Flash emails
 * people when that matters:
 * - When a spend takes someone's balance below the level they picked (Credits > "Email me when my
 *   credits run low", on at DEFAULT_LEVEL until they change it): once for each drop below it, again
 *   only after the balance has been back at or above it (a purchase, the monthly credits), and at
 *   most one a week. None while their auto top-up is on and working (its last try didn't fail).
 * - When an app's AI turns a visitor away because its owner is out of credits: at most one a day.
 * Both stop when the person turns them off, and need payments (they say to top up) and emails on. The
 * app shows the same thing in the bell and on Home, so nothing is lost when an email can't go.
 *
 * Every spend is settled (credits.ts), and settling hands the account and what it used here: one read
 * of the balance and the alert's state, after the response (afterResponse), so the spend is never
 * slowed or failed by it. An email the day's budget (EMAIL_BUDGET.alerts) or the provider held back,
 * or the weekly limit, waits: the next spend from then on sends it, while the balance is still low.
 *
 * Accounts are deleted by hand (see /delete-account): deleteUserAlerts removes what is kept here.
 */
import { SITE_URL } from "../../app/site.ts";
import { one, run, now } from "./db.ts";
import { EMAILS, emailEnabled, sendEmail } from "./email.ts";
import { countOf, overLimit } from "./limits.ts";
import { paymentsEnabled } from "./stripe.ts";
import { MAX_PER_MONTH } from "./auto-topup.ts";
import { afterResponse } from "./after-response.ts";

// The levels a person can pick: auto top-up's three (auto-topup.ts) and a lower one.
export const ALERT_LEVELS = [50, 100, 300, 1000] as const;
/*
 * 100 credits: about what one app change costs (TYPICAL_CREDITS.app is 120), so the email comes while
 * small edits still work but before the next update can't be paid for. It matches auto top-up's
 * lowest level, so the two read alike. On the free plan's 200 a month it comes after about half, at
 * most once a month (only the monthly credits bring the balance back above it). The bell's own line
 * (under 10) is for "nearly nothing left".
 */
export const DEFAULT_LEVEL = 100;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
// A charge held this long without settling counts as spent (credits.ts holds for its requests' longest run).
const HOLD_MS = 15 * 60_000;
// How often an app's AI marks a refusal (and looks at its owner's email), at most.
const MARK_EVERY = 10 * 60_000;

export type AlertSettings = { enabled: boolean; below: number; levels: readonly number[] };

/** The start of the next day (UTC), when the day's email budget starts again. */
const nextDay = (t: number) => (Math.floor(t / DAY) + 1) * DAY;
/** The start of t's month (UTC), as auto top-up counts its monthly top-ups. */
const monthStart = (t: number) => Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), 1);

/** Where the emails' button goes: Credits, in the account they're about (see account-pin.ts). */
export const creditsLink = (userId: string) =>
  `${(process.env.FLASH_APP_URL?.trim() || SITE_URL).replace(/\/+$/, "")}/?credits=1&as=${encodeURIComponent(userId)}`;

/** Counts one alert email for today's line in /admin. */
const tally = (what: string) => overLimit(`alert-stat:${new Date(now()).toISOString().slice(0, 10)}:${what}`, Infinity, DAY);

/** Today's alert emails for /admin: sent, and held back (the day's budget, the week's one, a failed send). */
export async function alertEmailsToday() {
  const day = new Date(now()).toISOString().slice(0, 10);
  const n = (what: string) => countOf(`alert-stat:${day}:${what}`);
  return {
    lowSent: await n("low-sent"),
    lowBudget: await n("low-budget"),
    lowWeekly: await n("low-weekly"),
    lowFailed: await n("low-failed"),
    appAiSent: await n("ai-sent"),
    appAiBudget: await n("ai-budget"),
    appAiFailed: await n("ai-failed"),
  };
}

/** What the person set, for Credits. */
export async function alertSettings(userId: string): Promise<AlertSettings> {
  const row = await one<{ enabled: number; below: number }>("SELECT enabled, below FROM credit_alerts WHERE user_id = ?", [userId]);
  return { enabled: row ? Boolean(row.enabled) : true, below: Number(row?.below ?? DEFAULT_LEVEL), levels: ALERT_LEVELS };
}

/** Saves the person's choice, or null for a level that isn't on the list. */
export async function saveAlertSettings(userId: string, choice: { enabled: boolean; below: number }): Promise<AlertSettings | null> {
  if (!ALERT_LEVELS.some((l) => l === choice.below)) return null;
  await run(
    `INSERT INTO credit_alerts (user_id, enabled, below, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, below = excluded.below, updated_at = excluded.updated_at`,
    [userId, choice.enabled ? 1 : 0, choice.below, now()],
  );
  return alertSettings(userId);
}

/** Deletes what is kept here for an account, for whoever deletes it (Turso's foreign keys are off, so nothing cascades). */
export async function deleteUserAlerts(userId: string): Promise<void> {
  await run("DELETE FROM credit_alerts WHERE user_id = ?", [userId]);
}

/**
 * Called once a spend is settled: account is the ledger it came from (a team member's spend is the
 * pool owner's), used what it took. Looks after the response is sent (see afterResponse).
 */
export function watchBalance(account: string, used: number): void {
  if (!(used > 0)) return;
  afterResponse(() => checkLowBalance(account, used));
}

type State = {
  balance: number;
  enabled: number | null;
  below: number | null;
  alerted_at: number | null;
  sent_at: number | null;
  retry_at: number | null;
  auto: number | null;
};

/**
 * What a spend did to the alert: "above" (the balance is at or above the level), "off" (turned off,
 * payments or emails off, or no such account), "alerted" (this drop was emailed already), "auto" (auto top-up
 * will buy credits), "waiting" (held back until retry_at), "weekly" (an email went out less than a
 * week ago: this one waits), "budget" (the day's email budget is used up: waits for a later day),
 * "failed" (the email provider failed: waits for a later day) or "sent".
 */
export type LowBalanceOutcome = "above" | "off" | "alerted" | "auto" | "waiting" | "weekly" | "budget" | "failed" | "sent";

/**
 * Emails the account when its balance is below its level and this drop hasn't been emailed. One read
 * for everything it needs; writes only when something changes. The balance counts what is settled:
 * a request still running holds credits that mostly come back, and is looked at when it settles.
 */
export async function checkLowBalance(account: string, used: number): Promise<LowBalanceOutcome> {
  const t = now();
  const s = await one<State>(
    `SELECT (SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE user_id = ?
               AND NOT (amount < 0 AND ref IS NULL AND settled_at = 0 AND created_at > ?)) AS balance,
            a.enabled, a.below, a.alerted_at, a.sent_at, a.retry_at,
            (p.enabled = 1 AND p.payment_method IS NOT NULL
              AND (SELECT COUNT(*) FROM credit_ledger WHERE user_id = ? AND ref LIKE 'stripe:auto:%' AND created_at >= ?) < ?) AS auto
     FROM (SELECT 1) LEFT JOIN credit_alerts a ON a.user_id = ? LEFT JOIN auto_topups p ON p.user_id = ?`,
    [account, t - HOLD_MS, account, monthStart(t), MAX_PER_MONTH, account, account],
  );
  const balance = Number(s?.balance ?? 0);
  const below = Number(s?.below ?? DEFAULT_LEVEL);
  const alertedAt = Number(s?.alerted_at ?? 0);
  const retryAt = Number(s?.retry_at ?? 0);
  if (balance >= below) {
    // Back at or above the level: the next drop below it is emailed again.
    if (alertedAt || retryAt) await run("UPDATE credit_alerts SET alerted_at = 0, retry_at = 0 WHERE user_id = ?", [account]);
    return "above";
  }
  if (s?.enabled === 0 || !paymentsEnabled() || !emailEnabled()) return "off";
  // This spend took it from the level to below it: a new drop, even if the balance went back up
  // since the last email without a spend to see it (a purchase, then one big reply).
  const fresh = balance + used >= below;
  if (alertedAt && !fresh) return "alerted";
  // Auto top-up buys credits while it's on (a try that fails turns it off, see auto-topup.ts) and
  // this month's top-ups aren't used up.
  if (Number(s?.auto)) return "auto";
  if (retryAt > t) return "waiting";
  const sentAt = Number(s?.sent_at ?? 0);
  if (sentAt > t - WEEK) {
    // One a week at most: this drop's email waits until a week after the last.
    await run(
      `INSERT INTO credit_alerts (user_id, alerted_at, retry_at, updated_at) VALUES (?, 0, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET alerted_at = 0, retry_at = excluded.retry_at, updated_at = excluded.updated_at`,
      [account, sentAt + WEEK, t],
    );
    await tally("low-weekly");
    return "weekly";
  }
  // Claimed in one statement, so two spends settling at once send one email.
  const claim = await run(
    `INSERT INTO credit_alerts (user_id, alerted_at, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET alerted_at = excluded.alerted_at, updated_at = excluded.updated_at
     WHERE credit_alerts.alerted_at = ? AND credit_alerts.retry_at <= ? AND credit_alerts.sent_at <= ?`,
    [account, t, t, alertedAt, t, t - WEEK],
  );
  if (claim.rowsAffected !== 1) return "alerted";
  const user = await one<{ email: string }>("SELECT email FROM users WHERE id = ?", [account]);
  if (!user) return "off";
  const held = async (what: "budget" | "failed") => {
    // Still owed: the first spend from the next day on sends it, if the balance is still low.
    await run("UPDATE credit_alerts SET alerted_at = 0, retry_at = ? WHERE user_id = ?", [nextDay(t), account]);
    await tally(`low-${what}`);
    return what;
  };
  try {
    if (!(await sendEmail(user.email, EMAILS.lowCredits(balance, creditsLink(account)), "alert"))) return held("budget");
  } catch (err) {
    console.error("[flash] low-credit email failed", err);
    return held("failed");
  }
  await run("UPDATE credit_alerts SET sent_at = ?, retry_at = 0 WHERE user_id = ?", [t, account]);
  await tally("low-sent");
  return "sent";
}

/**
 * Called when an app's AI turns a visitor away because its owner is out of credits: marks the app
 * (the bell shows it until the AI answers again) and emails the owner, after the response.
 */
export function noteAppAiOutOfCredits(slug: string, owner: string, title: string): void {
  afterResponse(async () => {
    // At most every few minutes per app, so a busy app's visitors don't each cost a look.
    const marked = await run("UPDATE site_ai SET out_at = ? WHERE site_slug = ? AND out_at < ?", [now(), slug, now() - MARK_EVERY]);
    if (marked.rowsAffected === 1) await appAiAlert(owner, title);
  });
}

/** What an "app's AI is out of credits" email did: "off", "daily" (one went in the last day), "budget", "failed" or "sent". */
export type AppAiOutcome = "off" | "daily" | "budget" | "failed" | "sent";

/** Emails an app's owner that its AI is turning visitors away, at most once a day. */
export async function appAiAlert(owner: string, title: string): Promise<AppAiOutcome> {
  if (!paymentsEnabled() || !emailEnabled()) return "off";
  const t = now();
  const row = await one<{ email: string; enabled: number | null; app_ai_at: number | null }>(
    "SELECT u.email, a.enabled, a.app_ai_at FROM users u LEFT JOIN credit_alerts a ON a.user_id = u.id WHERE u.id = ?",
    [owner],
  );
  if (!row || row.enabled === 0) return "off";
  const last = Number(row.app_ai_at ?? 0);
  if (last > t - DAY) return "daily";
  // Claimed first, so two refusals at once send one email. One held back (the day's budget, a failed
  // send) keeps the claim, so it waits a day too: the next refusal after that tries again.
  const claim = await run(
    `INSERT INTO credit_alerts (user_id, app_ai_at, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET app_ai_at = excluded.app_ai_at, updated_at = excluded.updated_at WHERE credit_alerts.app_ai_at = ?`,
    [owner, t, t, last],
  );
  if (claim.rowsAffected !== 1) return "daily";
  try {
    if (!(await sendEmail(row.email, EMAILS.appAiOutOfCredits(title, creditsLink(owner)), "alert"))) {
      await tally("ai-budget");
      return "budget";
    }
  } catch (err) {
    console.error("[flash] app AI email failed", err);
    await tally("ai-failed");
    return "failed";
  }
  await tally("ai-sent");
  return "sent";
}
