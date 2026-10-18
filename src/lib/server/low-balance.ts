/*
 * Low-credit emails. A published app keeps running with no credits (its pages, its data and its shop
 * use none), but building or changing an app needs them, and so does an app's own AI. So Flash emails
 * people when that matters:
 * - When a spend takes someone's balance below the level they picked (Credits > "Email me when my
 *   credits run low", on at DEFAULT_LEVEL until they change it): once for each drop below it, again
 *   only after the balance has been back at or above it (a purchase, the monthly credits: see the
 *   credit_alerts_rearm trigger in db.ts), and at most one a week. None while their auto top-up is
 *   on and can buy (a card saved, a pack Flash still sells, this month's top-ups not used up, no
 *   disputed payment): the check tries it first (never for a visitor's spend: see credits.ts), and a
 *   try that fails turns it off and checks again (see auto-topup.ts).
 * - When the balance runs out: at or below 0, where nothing paid can run (every paid request holds at
 *   least a credit first: creditsFor in credits.ts, charge() in server/credits.ts). Flash refuses a
 *   paid request whose credits the balance doesn't cover, so with a few credits left some small ones
 *   still fit, and that isn't "run out" (the low-credit email told them). Noticed as a spend settles
 *   with the balance there, or as a request of the account holder's own is refused while it is there
 *   (a refund or a disputed payment can take it there with no spend). Once each time it runs out,
 *   again only after credits came back above 0 (a purchase, auto top-up, plan or monthly credits, a
 *   refund: see the credit_alerts_out_rearm trigger in db.ts). It is sent instead of the low-credit
 *   email, with the same opt-out, the same share of the day's emails (EMAIL_BUDGET.alerts) and none
 *   while auto top-up can buy, and never from a visitor's refused question (their app's AI has its own
 *   email, below).
 * - When an app's AI turns a visitor away because its owner is out of credits, or because it stopped
 *   at their auto top-up level (site-ai.ts): at most one a day.
 * All stop when the person turns them off, and need payments (they say to top up) and emails on. The
 * app shows the same thing in the bell and on Home, so nothing is lost when an email can't go.
 *
 * Every spend is settled (credits.ts), and settling hands the account and what it used here: one read
 * of the balance and the alert's state, after the response (afterResponse), so the spend is never
 * slowed or failed by it. An email the day's budget (EMAIL_BUDGET.alerts) or the provider held back,
 * or the weekly limit, waits: the next spend from then on sends it, while the balance is still low,
 * and so does a request refused for lack of credits (watchRefusal), which spends nothing. A refusal
 * also lets auto top-up try again, as a spend does, once its gap between top-ups has passed. An
 * email whose send never finished (the server stopped mid-send) may have gone: it counts as sent,
 * so the next one waits a week after it, as after any email.
 *
 * Accounts are deleted by hand (see /delete-account): deleteUserAlerts removes what is kept here,
 * and a spend that settles after the account is gone writes nothing back.
 */
import { SITE_URL } from "../../app/site.ts";
import { CREDIT_PACKS } from "../credits.ts";
import { translatorIn } from "./i18n.ts";
import { one, run, now } from "./db.ts";
import { EMAILS, emailEnabled, sendEmail, verificationRequired, type CreditEmailTo } from "./email.ts";
import { FREE_DAILY_CHATS, FREE_DAILY_IMAGES, freeChatConfigured, freeImageConfigured } from "../engines/free.ts";
import { countOf, overLimit } from "./limits.ts";
import { paymentsEnabled } from "./stripe.ts";
import { MAX_PER_MONTH, maybeAutoTopUp } from "./auto-topup.ts";
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
// Below this the app says credits are running low even with the emails off (and the top bar's balance turns red).
export const NEARLY_OUT = 10;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
// A charge held this long without settling counts as spent (credits.ts holds for its requests' longest run).
const HOLD_MS = 15 * 60_000;
// An email claimed this long ago and neither sent nor held back was cut off mid-send (sendEmail gives
// the provider 15 seconds): it may have gone, so it counts as sent when it was claimed.
const SENDING_MS = 15 * 60_000;
/*
 * The balance the alert goes by (two parameters: the account, and now less HOLD_MS): what is settled,
 * and holds older than HOLD_MS. A request still running holds credits that mostly come back, and a
 * visitor's hold (keeps_level) a stopped server left open comes back whole (settleLeftHolds in site-ai.ts).
 */
const SETTLED_BALANCE = `(SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE user_id = ?
    AND NOT (amount < 0 AND ref IS NULL AND settled_at = 0 AND (keeps_level > 0 OR created_at > ?)))`;
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
    outSent: await n("out-sent"),
    outBudget: await n("out-budget"),
    outFailed: await n("out-failed"),
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

/**
 * Below what balance the app says the credits are running low (the bell, Home): the level the
 * person's emails go at, so what an email says the app says too, also while an email waits for the
 * day's budget. NEARLY_OUT with the emails off, or with payments off (there are none).
 */
export async function lowCreditsLevel(userId: string): Promise<number> {
  if (!paymentsEnabled()) return NEARLY_OUT;
  const s = await alertSettings(userId);
  return s.enabled ? s.below : NEARLY_OUT;
}

/** Saves the person's choice, or null for a level that isn't on the list. */
export async function saveAlertSettings(userId: string, choice: { enabled: boolean; below: number }): Promise<AlertSettings | null> {
  if (!ALERT_LEVELS.some((l) => l === choice.below)) return null;
  await run(
    `INSERT INTO credit_alerts (user_id, enabled, below, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, below = excluded.below, updated_at = excluded.updated_at`,
    [userId, choice.enabled ? 1 : 0, choice.below, now()],
  );
  // A level at or under the balance re-arms the alert, as the balance coming back up to it does: the
  // next drop below the new level is emailed. One the balance is already under isn't emailed again.
  await run(`UPDATE credit_alerts SET alerted_at = 0, retry_at = 0 WHERE user_id = ? AND (alerted_at > 0 OR retry_at > 0) AND ${SETTLED_BALANCE} >= below`, [
    userId,
    userId,
    now() - HOLD_MS,
  ]);
  return alertSettings(userId);
}

/**
 * Deletes what is kept here for an account, for whoever deletes it (Turso's foreign keys are off, so
 * nothing cascades): after its users row, so nothing still running for it writes the row back.
 */
export async function deleteUserAlerts(userId: string): Promise<void> {
  await run("DELETE FROM credit_alerts WHERE user_id = ?", [userId]);
}

/**
 * What a check may do besides the low-credit email. topUp: try auto top-up (see checkLowBalance). Off
 * for a visitor's spend (credits.ts): a pack is bought only for what the account holder does. out:
 * send the out-of-credits email. Off for a visitor's refused question (credits.ts): what visitors are
 * refused has its own email (appAiAlert), so they never set this one off.
 */
export type CheckOptions = { topUp?: boolean; out?: boolean };

/** After the response, never waited for: its errors are logged, so the spend or refusal never fails by it. */
const later = (work: () => Promise<unknown>): void =>
  void afterResponse(() => work().catch((err: unknown) => console.error("[flash] low-credit check after the response failed", err)));

/**
 * Called once a spend is settled: account is the ledger it came from (a team member's spend is the
 * pool owner's), used what it took. Looks after the response is sent (see afterResponse).
 */
export function watchBalance(account: string, used: number, options: CheckOptions = {}): void {
  if (!(used > 0)) return;
  later(() => checkLowBalance(account, options));
}

/**
 * Called when a request is refused because no balance covers it (charge() in credits.ts): accounts
 * are the ledgers it was refused from. Nothing is settled, so an email still owed (held back by the
 * day's budget, a failed send or the week's limit, and due now) goes from here. So does auto top-up's
 * next try, as after a spend: a top-up whose credits were spent within its gap between top-ups can't
 * buy again until it has passed, and from then on requests may all be refused. And the out-of-credits
 * email, when the balance is at or below 0 and this time it ran out wasn't emailed (out): a refund or a
 * disputed payment can take it there with no spend. One read, after the response, and the full check
 * only when an email is owed, or auto top-up is on (and topUp).
 */
export function watchRefusal(accounts: string[], { topUp = true, out = true }: CheckOptions = {}): void {
  later(async () => {
    for (const account of accounts) {
      const t = now();
      const due = await one<{ due: number }>(
        `SELECT EXISTS (SELECT 1 FROM credit_alerts WHERE user_id = ? AND retry_at > 0 AND retry_at <= ?)
             OR (? AND EXISTS (SELECT 1 FROM auto_topups WHERE user_id = ? AND enabled = 1 AND payment_method IS NOT NULL))
             OR (? AND NOT EXISTS (SELECT 1 FROM credit_alerts WHERE user_id = ? AND (out_at > 0 OR out_retry_at > ?)) AND ${SETTLED_BALANCE} <= 0) AS due`,
        [account, t, topUp ? 1 : 0, account, out ? 1 : 0, account, t, account, t - HOLD_MS],
      );
      if (Number(due?.due) === 1) await checkLowBalance(account, { topUp, out });
    }
  });
}

type State = {
  email: string | null;
  name: string | null;
  verified_at: number | null;
  balance: number;
  enabled: number | null;
  below: number | null;
  alerted_at: number | null;
  sent_at: number | null;
  retry_at: number | null;
  out_at: number | null;
  out_retry_at: number | null;
  auto: number | null;
  auto_below: number | null;
};

/**
 * What a spend did to the alert: "above" (the balance is at or above the level), "off" (turned off,
 * payments or emails off, or no such account), "alerted" (this drop, or this time it ran out, was
 * emailed already, or is being emailed), "auto" (auto top-up bought, is buying or will buy credits),
 * "waiting" (held back until retry_at, or at 0 credits for a check that may send the out-of-credits
 * email), "weekly" (an email went out less than a week ago: this one waits), "budget" (the day's email
 * budget is used up: waits for a later day), "failed" (the email provider failed: waits for a later
 * day), "sent" (the low-credit email) or "out" (the out-of-credits email).
 */
export type LowBalanceOutcome = "above" | "off" | "alerted" | "auto" | "waiting" | "weekly" | "budget" | "failed" | "sent" | "out";

/** What the account can use on free models with no credits (the chat route sends them there), for the credit emails. */
const freeUse = (verifiedAt: number | null) =>
  (!verificationRequired() || Number(verifiedAt ?? 0) > 0) && freeChatConfigured()
    ? { chats: FREE_DAILY_CHATS, images: freeImageConfigured() ? FREE_DAILY_IMAGES : 0 }
    : null;

/**
 * Emails the account when its balance is below its level and this drop hasn't been emailed, or when
 * it ran out (out) and this time hasn't been emailed. One read for everything it needs; writes only
 * when something changes. The balance counts what is settled: a request still running holds credits
 * that mostly come back, and is looked at when it settles. Called after a spend, a refusal
 * (watchRefusal) and an auto top-up that failed (auto-topup.ts).
 */
export async function checkLowBalance(account: string, { topUp = true, out: outOk = true }: CheckOptions = {}): Promise<LowBalanceOutcome> {
  const t = now();
  const s = await one<State>(
    `SELECT u.email, COALESCE(NULLIF(TRIM(u.nickname), ''), u.name) AS name, u.verified_at, ${SETTLED_BALANCE} AS balance,
            a.enabled, a.below, a.alerted_at, a.sent_at, a.retry_at, a.out_at, a.out_retry_at,
            (p.enabled = 1 AND p.payment_method IS NOT NULL AND p.pack IN (${CREDIT_PACKS.map((k) => `'${k.id}'`).join(", ")})
              AND (SELECT COUNT(*) FROM credit_ledger WHERE user_id = ? AND ref LIKE 'stripe:auto:%' AND created_at >= ?) < ?
              AND NOT EXISTS (SELECT 1 FROM credit_ledger WHERE user_id = ? AND substr(ref, 1, 15) = 'stripe-dispute:')) AS auto,
            p.below AS auto_below
     FROM (SELECT 1) LEFT JOIN users u ON u.id = ? LEFT JOIN credit_alerts a ON a.user_id = ? LEFT JOIN auto_topups p ON p.user_id = ?`,
    [account, t - HOLD_MS, account, monthStart(t), MAX_PER_MONTH, account, account, account, account],
  );
  // An account deleted (by hand, see deleteUserAlerts) while a spend of it was still running: nothing to
  // email, and nothing written back for it.
  if (!s?.email) return "off";
  const balance = Number(s?.balance ?? 0);
  const below = Number(s?.below ?? DEFAULT_LEVEL);
  const alertedAt = Number(s?.alerted_at ?? 0);
  const retryAt = Number(s?.retry_at ?? 0);
  const outAt = Number(s?.out_at ?? 0);
  const outRetryAt = Number(s?.out_retry_at ?? 0);
  // Auto top-up can buy (on, a card saved, a pack Flash still sells, this month's top-ups not used up,
  // no disputed payment, as maybeAutoTopUp and TOP_UP_LEVEL in credits.ts allow). Below its own level it tries now, on every spend and refusal (connectors,
  // voice and the companion too, and a team's pool, whose ledger this is), before anything is emailed.
  // Not for a visitor's spend (topUp off): it buys on the account holder's own next spend or visit.
  // A try that fails turns it off and runs this check again (see auto-topup.ts), which emails then.
  const auto = Number(s?.auto) === 1;
  if (topUp && auto && balance < Number(s?.auto_below)) await maybeAutoTopUp(account).catch((err) => console.error("[flash] auto top-up failed", err));
  if (balance >= below) {
    // Back at or above the level: the next drop below it is emailed again, and the next time it runs out.
    if (alertedAt || retryAt || outAt || outRetryAt) {
      await run("UPDATE credit_alerts SET alerted_at = 0, retry_at = 0, out_at = 0, out_retry_at = 0 WHERE user_id = ?", [account]);
    }
    return "above";
  }
  // Run out: at or below 0, nothing paid can be held (see the top of this file). Above it again, the
  // next time it runs out is emailed, here or as credits come in (credit_alerts_out_rearm in db.ts).
  const out = balance <= 0;
  if (!out && (outAt || outRetryAt)) await run("UPDATE credit_alerts SET out_at = 0, out_retry_at = 0 WHERE user_id = ?", [account]);
  if (s?.enabled === 0 || !paymentsEnabled() || !emailEnabled()) return "off";
  const to: CreditEmailTo = { name: s.name, free: freeUse(s.verified_at) };
  if (out) {
    // The out-of-credits email in place of the low-credit one, which says the same and more. None while
    // auto top-up can buy (as below), once for each time it runs out, and never from a check that may
    // not send it (a visitor's refused question): it waits for the account holder's own spend or refusal.
    if (auto) return "auto";
    if (outAt) return "alerted";
    if (outRetryAt > t || !outOk) return "waiting";
    // Claimed in one statement, so two spends settling at once send one email. A send cut off by the
    // server stopping may have gone: it stays claimed, so it is never sent twice.
    const claim = await run(
      `INSERT INTO credit_alerts (user_id, out_at, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET out_at = excluded.out_at, out_retry_at = 0, updated_at = excluded.updated_at
       WHERE credit_alerts.out_at = 0 AND credit_alerts.out_retry_at <= ?`,
      [account, t, t, t],
    );
    if (claim.rowsAffected !== 1) return "alerted";
    const heldOut = async (what: "budget" | "failed") => {
      // Not sent, so still owed: the first spend or refusal from the next day on sends it, if the
      // balance is still out (credits that come in meanwhile clear it).
      await run("UPDATE credit_alerts SET out_at = 0, out_retry_at = ? WHERE user_id = ? AND out_at = ?", [nextDay(t), account, t]);
      await tally(`out-${what}`);
      return what;
    };
    try {
      if (!(await sendEmail(s.email, EMAILS.outOfCredits(creditsLink(account), to), "alert"))) return await heldOut("budget");
    } catch (err) {
      console.error("[flash] out-of-credits email failed", err);
      return heldOut("failed");
    }
    await tally("out-sent");
    return "out";
  }
  // This drop was emailed, or is being emailed (until retry_at, SENDING_MS after its claim): only the
  // balance back at or above the level re-arms it, here or as credits come in (credit_alerts_rearm in
  // db.ts), or a level set at or under the balance, so spends settling together, or checked one after
  // another, never email one drop twice. A send cut off goes on below: it counts as sent when claimed.
  if (alertedAt && !(retryAt > 0 && retryAt <= t)) return "alerted";
  // Auto top-up bought, is buying, or will buy at its own level (one set below this one), or on the
  // account holder's own next spend or visit after a visitor's spend.
  if (auto) return "auto";
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
  // Claimed in one statement, so two spends settling at once send one email. It counts as sent from
  // here (sent_at), so a drop after credits came in during the send waits a week like any other, and
  // until retry_at as being sent.
  const claim = await run(
    `INSERT INTO credit_alerts (user_id, alerted_at, sent_at, retry_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET alerted_at = excluded.alerted_at, sent_at = excluded.sent_at, retry_at = excluded.retry_at,
       updated_at = excluded.updated_at
     WHERE credit_alerts.alerted_at = ? AND credit_alerts.retry_at <= ? AND credit_alerts.sent_at <= ?`,
    [account, t, t, t + SENDING_MS, t, alertedAt, t, t - WEEK],
  );
  if (claim.rowsAffected !== 1) return "alerted";
  const held = async (what: "budget" | "failed") => {
    // Not sent, so still owed: the first spend from the next day on sends it, if the balance is still
    // low. The last email sent is the one before.
    await run("UPDATE credit_alerts SET alerted_at = 0, sent_at = ?, retry_at = ? WHERE user_id = ?", [sentAt, nextDay(t), account]);
    await tally(`low-${what}`);
    return what;
  };
  try {
    if (!(await sendEmail(s.email, EMAILS.lowCredits(balance, creditsLink(account), to), "alert"))) return await held("budget");
  } catch (err) {
    console.error("[flash] low-credit email failed", err);
    return held("failed");
  }
  // Sent: no longer being sent. If credits came in meanwhile (alerted_at re-armed), what a drop since set stays.
  await run("UPDATE credit_alerts SET retry_at = 0 WHERE user_id = ? AND alerted_at = ?", [account, t]);
  await tally("low-sent");
  return "sent";
}

/**
 * Called when an app's AI turns a visitor away because its owner is out of credits, or (atLevel)
 * because it stopped at their auto top-up level: marks the app (the bell shows it until the AI
 * answers again) and emails the owner, after the response.
 */
export function noteAppAiOutOfCredits(slug: string, owner: string, title: string, atLevel = false): void {
  later(async () => {
    // At most every few minutes per app, so a busy app's visitors don't each cost a look, and when
    // the reason changes.
    const level = atLevel ? 1 : 0;
    const marked = await run("UPDATE site_ai SET out_at = ?, at_level = ? WHERE site_slug = ? AND (out_at < ? OR at_level <> ?)", [
      now(),
      level,
      slug,
      now() - MARK_EVERY,
      level,
    ]);
    if (marked.rowsAffected === 1) await appAiAlert(owner, title, atLevel);
  });
}

/** What an "app's AI is out of credits" email did: "off", "daily" (one went in the last day), "budget", "failed" or "sent". */
export type AppAiOutcome = "off" | "daily" | "budget" | "failed" | "sent";

/**
 * Emails an app's owner that its AI is turning visitors away, out of credits or (atLevel) stopped at
 * their auto top-up level, at most once a day whichever it is. Visitors set these off, so they have
 * their own share of the day's emails (EMAIL_BUDGET.appAiAlerts), never the low-credit emails', and
 * each owner has a place of their own in it (EMAIL_BUDGET.appAiPerOwner), so one busy app's visitors
 * can only ever take its owner's.
 */
export async function appAiAlert(owner: string, title: string, atLevel = false): Promise<AppAiOutcome> {
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
    const email = atLevel ? EMAILS.appAiAtLevel(title, creditsLink(owner)) : EMAILS.appAiOutOfCredits(title, creditsLink(owner));
    if (!(await sendEmail(row.email, email, { appAi: owner }))) {
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

/**
 * A low-credit alert's words in the account's language, with where a tap should go, for sending it
 * another way than email. Nothing calls it yet: web push (push.ts) is in, but low-credit alerts go by
 * email and the bell only; a phone alert would call this where checkLowBalance and appAiAlert send
 * their emails. The words are the bell's.
 */
export async function alertForPush(
  userId: string,
  alert: { kind: "low-credits" } | { kind: "app-ai"; site: string; atLevel?: boolean },
): Promise<{ title: string; body: string; url: string }> {
  const user = await one<{ language: string }>("SELECT language FROM users WHERE id = ?", [userId]);
  const t = await translatorIn(user?.language || "en");
  const url = creditsLink(userId);
  return alert.kind === "low-credits"
    ? {
        title: t("Your Flash credits are running low."),
        body: t("Your apps and websites keep running, but they only get new updates while you have credits. Top up to keep them updating."),
        url,
      }
    : {
        title: alert.atLevel
          ? t("The AI in {name} stopped at your auto top-up level", { name: alert.site })
          : t("The AI in {name} is out of credits", { name: alert.site }),
        body: t("Visitors' questions aren't being answered. The rest of the app keeps working."),
        url,
      };
}
