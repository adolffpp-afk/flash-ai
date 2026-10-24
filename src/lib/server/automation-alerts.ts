/*
 * An automation's results where its owner is: each notice it adds (a result ready, a pause, a missed
 * run) as an alert on the phones and computers where they turned alerts on (push.ts), and, when they
 * ticked "Email me each result", each result by email to their own confirmed address.
 *
 * Both wait in the database, written in the same batch as the notice (noticeStatement sets pushed 0;
 * emailStatement below), so they go only for a notice that was really added. Each is claimed (a
 * compare-and-set) before it is sent, so it goes at most once: one claimed by a server that then
 * stopped isn't sent again. deliverAlerts sends them, right after a run ends (finish in
 * automation-runner.ts, from the worker that ran it) and from the tick for the rest (a notice added
 * part way through a run, by the tick, or once a worker stopped). Neither is sent late: an alert after
 * an hour, or an email after 6, stays in the Bell only.
 *
 * A run sends one email at most (plan §9.2): a later result of the same run takes the place of one
 * still waiting, and once one went the run sends no more. Its words are plain text (see
 * automationResult in email.ts), so nothing a web page puts in an answer can pass for Flash.
 *
 * Emails cost Flash a share of its email plan (EMAIL_BUDGET.automations a day for everyone, and
 * EMAILS_PER_ACCOUNT a day for each account), never credits; one that doesn't go out says why on its
 * run, and its result is in Flash.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { InStatement, InValue } from "@libsql/client";
import { SITE_URL } from "../../app/site.ts";
import { NOTICES } from "../automations.ts";
import { msg } from "../i18n.ts";
import { languageById } from "../languages.ts";
import { utcDay } from "../schedule.ts";
import { isVerified } from "./account.ts";
import { db, one, run as sql } from "./db.ts";
import { EMAILS, emailEnabled, sendEmail } from "./email.ts";
import { translatorIn, type ServerT } from "./i18n.ts";
import { DB_NOW } from "./leases.ts";
import { giveBackOne, takeOne } from "./limits.ts";
import { noticeText, type Notice } from "./notifications.ts";
import { pushPublicKey, sendPush } from "./push.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** An alert not sent this long after its notice isn't sent. */
export const ALERT_LATE_MS = HOUR;
/** An email not sent this long after its run ended isn't sent; one being sent this long ago never finished. */
export const EMAIL_LATE_MS = 6 * HOUR;
export const SENDING_MS = 15 * MINUTE;
/** Results emailed to one account a day (UTC), across its automations. */
export const EMAILS_PER_ACCOUNT = 3;
/** The most of a result an email carries (it says when there is more, in Flash). */
export const EMAIL_TEXT_CHARS = 20_000;
/** The most sources an email lists. */
export const EMAIL_SOURCES = 10;
/** How long deliverAlerts goes on claiming more: what it claimed by then is still sent. */
export const DELIVER_MS = 20_000;
// Claimed (and sent) at a time; emails two at once, so Flash's other emails always have room at the provider.
const ALERTS_AT_ONCE = 10;
const EMAILS_AT_ONCE = 2;

/**
 * What became of a run's email, as its run says (see EMAIL_LINES): limit is the account's own day
 * used up, busy Flash's, and unknown a send whose answer never came (it may have gone).
 */
export type EmailState = "queued" | "sending" | "sent" | "limit" | "busy" | "failed" | "unknown" | "off" | "expired";

export const EMAIL_WORDS = {
  subject: msg("{name}: your result for {date}"),
  button: msg("See it in Flash"),
  ai: msg("Written by AI from what your automation found: check anything important. Flash never asks for your password or card details by email."),
  more: msg("This is the start of the result. The rest is in Flash."),
  sources: msg("Sources"),
  why: msg("You get this because “Email me each result” is on for {name}."),
  stop: msg("Stop these emails"),
  paste: msg("Or paste this link into your browser:"),
  help: msg("Need help with Flash? Write to {email}."),
} as const;

/** What a run says about its email, in the reader's words (see receipt in automation-api.ts); limit's count is EMAILS_PER_ACCOUNT. */
export const EMAIL_LINES: Record<EmailState, string> = {
  queued: msg("Emailing you the result…"),
  sending: msg("Emailing you the result…"),
  sent: msg("Emailed to you"),
  limit: msg("Not emailed: you've had today's {count} emails. The result is here."),
  busy: msg("Not emailed: Flash has sent all the emails it can today. The result is here."),
  failed: msg("Flash couldn't email this result. It's here."),
  unknown: msg("Flash may not have emailed this result. It's here."),
  off: msg("Not emailed: emails were turned off."),
  expired: msg("Not emailed: it waited too long. The result is here."),
};

/** Flash's own address, for links in emails. */
const appBase = () => (process.env.FLASH_APP_URL?.trim() || SITE_URL).replace(/\/+$/, "");

const parseBlanks = (text: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(text || "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Runs work on items, at most `at` at a time, none ever throwing. */
async function eachAtOnce<T>(items: T[], at: number, work: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += at) {
    await Promise.all(items.slice(i, i + at).map((item) => work(item).catch((err) => console.error("[flash] automation alert failed", err instanceof Error ? err.name : "error"))));
  }
}

/** The translator for a language, made once per call. */
function translators() {
  const made = new Map<string, Promise<ServerT>>();
  return (language: string) => {
    if (!made.has(language)) made.set(language, translatorIn(language || "en"));
    return made.get(language)!;
  };
}

type PendingNotice = { id: string; user_id: string; phrase: string; blanks: string; link: string; read_at: number; language: string; created_at: number; seq: number };

/*
 * One account's (mine) or everyone's rows, for the outbox's statements. +user_id keeps SQLite on the
 * small index of rows that wait (notifications_unpushed, automation_emails_waiting) rather than the
 * account's whole history.
 */
const whose = (userId: string | undefined) => ({ mine: userId === undefined ? "" : " AND +user_id = ?", who: (userId === undefined ? [] : [userId]) as InValue[] });

/*
 * An email waits for its run to end: a later Notify step's result takes its place till then (a run sends
 * one), and it is late counting from that end.
 */
const RUN_ENDED = "NOT EXISTS (SELECT 1 FROM automation_runs r WHERE r.id = automation_emails.run_id AND r.finished_at = 0)";
const SINCE = "MAX(created_at, COALESCE((SELECT r.finished_at FROM automation_runs r WHERE r.id = automation_emails.run_id), 0))";

/**
 * The alert a notice makes: the automation's name, the result's first line when the notice only says
 * it's ready (else what the notice says), a tap opens the run, and the run's later alerts replace it.
 */
export function noticeAlert(n: Pick<PendingNotice, "phrase" | "blanks" | "link">, t: ServerT) {
  const view = noticeText(n, t);
  const params = new URLSearchParams(n.link);
  const runId = params.get("run");
  const automationId = params.get("automations");
  return {
    title: view.title,
    body: n.phrase === NOTICES.ready && view.body ? view.body : view.text,
    url: n.link ? `/?${n.link}` : "/",
    ...(runId ? { tag: `flash-run-${runId}` } : automationId ? { tag: `flash-automation-${automationId}` } : {}),
  };
}

/**
 * Sends notices waiting to be alerts (one account's, or everyone's), until until; returns how many it
 * sent. Alerts with one tag (a run's) replace each other where they show, so of those claimed together
 * only the newest is sent: sent at once, an older one could arrive last and stay.
 */
async function pushPending(userId: string | undefined, until: number): Promise<number> {
  const { mine, who } = whose(userId);
  // Nearly always nothing: a notice waits only for an owner with alerts on.
  if (!(await one(`SELECT 1 AS x FROM notifications WHERE pushed = 0${mine} LIMIT 1`, who))) return 0;
  await sql(`UPDATE notifications SET pushed = 2 WHERE pushed = 0 AND created_at < ${DB_NOW} - ?${mine}`, [ALERT_LATE_MS, ...who]);
  // Alerts aren't set up on this server: nothing waits for them.
  if (!pushPublicKey()) {
    await sql(`UPDATE notifications SET pushed = 1 WHERE pushed = 0${mine}`, who);
    return 0;
  }
  const t = translators();
  let sent = 0;
  while (Date.now() < until) {
    const claimed = (
      await sql(
        `UPDATE notifications SET pushed = 1
          WHERE id IN (SELECT id FROM notifications WHERE pushed = 0${mine} ORDER BY created_at, rowid LIMIT ${ALERTS_AT_ONCE}) AND pushed = 0
          RETURNING id, user_id, phrase, blanks, link, read_at, created_at, rowid AS seq, (SELECT language FROM users WHERE users.id = notifications.user_id) AS language`,
        who,
      )
    ).rows as unknown as PendingNotice[];
    if (!claimed.length) break;
    // The newest of each tag (RETURNING keeps no order).
    const newest = new Map<string, { n: PendingNotice; alert: ReturnType<typeof noticeAlert> }>();
    for (const n of claimed.sort((a, b) => Number(a.created_at) - Number(b.created_at) || Number(a.seq) - Number(b.seq))) {
      const alert = noticeAlert(n, await t(n.language ?? ""));
      newest.set(alert.tag ? `${n.user_id}|${alert.tag}` : n.id, { n, alert });
    }
    await eachAtOnce([...newest.values()], ALERTS_AT_ONCE, async ({ n, alert }) => {
      // Seen in the Bell already.
      if (Number(n.read_at) > 0) return;
      const r = await sendPush(n.user_id, alert);
      if (r.sent > 0) sent++;
    });
  }
  return sent;
}

/**
 * A result as an email carries it: up to EMAIL_TEXT_CHARS, cut where a paragraph (else a line, else a
 * word) ends, and whether it was cut.
 */
export function emailCut(text: string, max = EMAIL_TEXT_CHARS): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  let end = text.lastIndexOf("\n\n", max);
  if (end < max / 2) end = text.lastIndexOf("\n", max);
  if (end < max / 2) end = text.lastIndexOf(" ", max);
  if (end < max / 2) end = max;
  // Never half of a character written as two.
  if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
  return { text: text.slice(0, end).trimEnd(), cut: true };
}

/** The sources an email lists: web pages only, each once, up to EMAIL_SOURCES, their titles on one line. */
export function emailSources(sources: { title?: unknown; url?: unknown }[] = []): { title: string; url: string }[] {
  const seen = new Set<string>();
  const out: { title: string; url: string }[] = [];
  for (const s of sources) {
    if (out.length >= EMAIL_SOURCES) break;
    // An address with no spaces, controls or marks that turn text around in it.
    if (typeof s?.url !== "string" || s.url.length > 500 || !/^https?:\/\/[^/]/i.test(s.url) || /[\s\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(s.url) || seen.has(s.url)) continue;
    seen.add(s.url);
    const title = typeof s.title === "string" ? s.title.replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) : "";
    out.push({ title, url: s.url });
  }
  return out;
}

/**
 * The statement that queues a run's email, for the batch that adds its notice (when: the same
 * condition), only while its automation emails its results. One a run: a later result takes the place
 * of one still waiting, and a run whose email is on its way or went sends no other. text is the
 * result in full (the notice keeps a part), sources what it cites.
 */
export function emailStatement(
  o: { notice: Notice; runId: string; automationId: string; text: string; sources?: { title?: unknown; url?: unknown }[] },
  when?: { sql: string; args: InValue[] },
): InStatement & { sql: string; args: InValue[] } {
  const { text, cut } = emailCut(o.text);
  const sources = emailSources(o.sources);
  const blanks = { ...(o.notice.blanks ?? {}), text, ...(cut && { cut: true }), ...(sources.length && { sources }) };
  return {
    sql: `INSERT INTO automation_emails (id, run_id, user_id, automation_id, phrase, blanks, link, state, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, 'queued', ${DB_NOW}
           WHERE EXISTS (SELECT 1 FROM automations WHERE id = ? AND user_id = ? AND email_me = 1 AND status <> 'deleting') AND ${when?.sql ?? "1 = 1"}
          ON CONFLICT(id) DO UPDATE SET phrase = excluded.phrase, blanks = excluded.blanks, link = excluded.link WHERE automation_emails.state = 'queued'`,
    args: [o.runId, o.runId, o.notice.userId, o.automationId, o.notice.phrase, JSON.stringify(blanks), o.notice.link ?? "", o.automationId, o.notice.userId, ...(when?.args ?? [])],
  };
}

type PendingEmail = { id: string; run_id: string; user_id: string; automation_id: string; phrase: string; blanks: string; link: string; created_at: number };

/** Ends an email being sent: its state, and its result no longer kept. */
const endEmail = (id: string, state: EmailState) =>
  sql(`UPDATE automation_emails SET state = ?, blanks = '{}', sent_at = ${DB_NOW} WHERE id = ? AND state = 'sending'`, [state, id]);

/** An automation's name inside a sentence in any direction: isolated, so its own (an "(AAPL)") stays its own. */
const isolated = (name: string) => `\u2068${name}\u2069`;

/** The "stop these emails" link's token for an automation: its id and a signature with its own secret. */
export const stopEmailToken = (automationId: string, secret: string) =>
  `${automationId}.${createHmac("sha256", secret).update(`stop-email|${automationId}`).digest("base64url").slice(0, 22)}`;

const TOKEN = /^([\w-]{8,32})\.([\w-]{22})$/;

/**
 * The automation a "stop these emails" link is for, whether it emails now, and its owner's language
 * (its emails' own); null for a link that doesn't work. Reads only.
 */
export async function tokenAutomation(token: string): Promise<{ id: string; name: string; emailing: boolean; language: string } | null> {
  const parts = TOKEN.exec(token);
  if (!parts) return null;
  const a = await one<{ id: string; name: string; email_me: number; email_secret: string; language: string | null }>(
    "SELECT a.id, a.name, a.email_me, a.email_secret, u.language FROM automations a LEFT JOIN users u ON u.id = a.user_id WHERE a.id = ? AND a.status <> 'deleting'",
    [parts[1]],
  );
  if (!a || !a.email_secret) return null;
  const expected = Buffer.from(stopEmailToken(a.id, a.email_secret).slice(a.id.length + 1));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { id: a.id, name: a.name, emailing: Number(a.email_me) === 1, language: a.language ?? "" };
}

/** Stops an automation's emails with its link (its owner turns them on again in Flash), and those still waiting. false for a link that doesn't work. */
export async function stopEmails(token: string): Promise<boolean> {
  const found = await tokenAutomation(token);
  if (!found) return false;
  await (await db()).batch(
    [
      { sql: "UPDATE automations SET email_me = 0 WHERE id = ? AND email_me = 1", args: [found.id] },
      { sql: `UPDATE automation_emails SET state = 'off', blanks = '{}', sent_at = ${DB_NOW} WHERE automation_id = ? AND state = 'queued'`, args: [found.id] },
    ],
    "write",
  );
  return true;
}

/** The day a result is for, in its reader's words and its automation's time zone (UTC for one Flash doesn't know). */
function resultDay(at: number, locale: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: timeZone || "UTC" }).format(at);
  } catch {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(at);
  }
}

/** Sends one claimed email (see emailPending). */
async function deliverEmail(e: PendingEmail, t: (language: string) => Promise<ServerT>): Promise<EmailState> {
  const a = await one<{ id: string; status: string; email_me: number; email_secret: string; time_zone: string }>(
    "SELECT id, status, email_me, email_secret, time_zone FROM automations WHERE id = ? AND user_id = ?",
    [e.automation_id, e.user_id],
  );
  const user = await one<{ email: string; language: string; verified_at: number }>("SELECT email, language, verified_at FROM users WHERE id = ?", [e.user_id]);
  // Only to its owner's own confirmed address, while emails are on (Flash's and theirs).
  if (!emailEnabled() || !a || a.status === "deleting" || Number(a.email_me) !== 1 || !a.email_secret || !user?.email || !isVerified(user)) return "off";
  const key = `email-auto-user:${e.user_id}:${utcDay(Date.now())}`;
  const until = await takeOne(key, EMAILS_PER_ACCOUNT, DAY);
  if (until === null) return "limit";
  const tr = await t(user.language ?? "");
  const blanks = parseBlanks(e.blanks);
  const name = typeof blanks.name === "string" && blanks.name ? blanks.name : "Flash";
  const base = appBase();
  const link = `${base}/?${e.link}${e.link ? "&" : ""}as=${encodeURIComponent(e.user_id)}`;
  const token = stopEmailToken(a.id, a.email_secret);
  const sources = emailSources(Array.isArray(blanks.sources) ? (blanks.sources as { title?: unknown; url?: unknown }[]) : []);
  const message = EMAILS.automationResult({
    name,
    // The notice's line when it says more than that the result is ready (its checks, or cut short).
    intro: e.phrase === NOTICES.ready ? "" : noticeText({ phrase: e.phrase, blanks: e.blanks }, tr).text,
    result: typeof blanks.text === "string" ? blanks.text : "",
    cut: blanks.cut === true,
    sources,
    link,
    stop: `${base}/stop-email/${token}`,
    lang: tr.language,
    rtl: Boolean(languageById(tr.language)?.rtl),
    words: {
      // Its day in the subject, so a mail app doesn't stack each day's under the first.
      subject: tr(EMAIL_WORDS.subject, { name: isolated(name), date: resultDay(Number(e.created_at) || Date.now(), tr.locale, a.time_zone) }),
      button: tr(EMAIL_WORDS.button),
      ai: tr(EMAIL_WORDS.ai),
      more: tr(EMAIL_WORDS.more),
      sources: tr(EMAIL_WORDS.sources),
      why: tr(EMAIL_WORDS.why, { name: isolated(name) }),
      stop: tr(EMAIL_WORDS.stop),
      paste: tr(EMAIL_WORDS.paste),
      help: tr(EMAIL_WORDS.help),
    },
  });
  try {
    const headers = {
      "List-Unsubscribe": `<${base}/api/stop-email/${token}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      // Each its own conversation in Gmail.
      "X-Entity-Ref-ID": `flash-result-${e.id}`,
    };
    if (await sendEmail(user.email, message, "automation", { headers, once: `automation-email-${e.id}` })) return "sent";
    // Flash's own emails for today are used up: not the account's.
    await giveBackOne([[key, until]]);
    return "busy";
  } catch (err) {
    const said = err instanceof Error ? err.message : "";
    console.error("[flash] automation email failed", said ? said.slice(0, 120) : "error");
    const status = /^Email provider returned (\d{3})/.exec(said)?.[1];
    // No answer (a time-out, a lost connection): it may have gone, so it keeps its place.
    if (!status) return "unknown";
    await giveBackOne([[key, until]]);
    return status === "429" ? "busy" : "failed";
  }
}

/** Sends results waiting to be emailed (one account's, or everyone's), until until; returns how many went. */
async function emailPending(userId: string | undefined, until: number): Promise<number> {
  const { mine, who } = whose(userId);
  // Each with the waiting index's own condition (state IN …), which SQLite needs to use it.
  const waiting = "state IN ('queued','sending')";
  if (!(await one(`SELECT 1 AS x FROM automation_emails WHERE ${waiting}${mine} LIMIT 1`, who))) return 0;
  await (await db()).batch(
    [
      { sql: `UPDATE automation_emails SET state = 'expired', blanks = '{}' WHERE ${waiting} AND state = 'queued'${mine} AND ${RUN_ENDED} AND ${SINCE} < ${DB_NOW} - ?`, args: [...who, EMAIL_LATE_MS] },
      // Its server stopped while sending it: it may have gone, so it isn't sent again.
      { sql: `UPDATE automation_emails SET state = 'unknown', blanks = '{}' WHERE ${waiting} AND state = 'sending' AND sent_at < ${DB_NOW} - ?${mine}`, args: [SENDING_MS, ...who] },
    ],
    "write",
  );
  const t = translators();
  let sent = 0;
  while (Date.now() < until) {
    const claimed = (
      await sql(
        `UPDATE automation_emails SET state = 'sending', sent_at = ${DB_NOW}
          WHERE id IN (SELECT id FROM automation_emails WHERE ${waiting} AND state = 'queued'${mine} AND ${RUN_ENDED} ORDER BY created_at LIMIT ${EMAILS_AT_ONCE}) AND state = 'queued'
          RETURNING id, run_id, user_id, automation_id, phrase, blanks, link, created_at`,
        who,
      )
    ).rows as unknown as PendingEmail[];
    if (!claimed.length) break;
    await eachAtOnce(claimed, EMAILS_AT_ONCE, async (e) => {
      const state = await deliverEmail(e, t).catch((err) => {
        console.error("[flash] automation email failed", err instanceof Error ? err.name : "error");
        return "failed" as const;
      });
      await endEmail(e.id, state);
      if (state === "sent") sent++;
    });
  }
  return sent;
}

/**
 * Sends what waits: alerts, then emails, for one account (a run of theirs just ended) or everyone (the
 * tick). Never throws; goes on claiming more for DELIVER_MS at most.
 */
export async function deliverAlerts(userId?: string, ms = DELIVER_MS): Promise<{ alerts: number; emails: number }> {
  const until = Date.now() + ms;
  const alerts = await pushPending(userId, until).catch((err) => {
    console.error("[flash] automation alerts failed", err instanceof Error ? err.name : "error");
    return 0;
  });
  const emails = await emailPending(userId, until).catch((err) => {
    console.error("[flash] automation emails failed", err instanceof Error ? err.name : "error");
    return 0;
  });
  return { alerts, emails };
}

/** What waits for the tick (see DUE_CHECKS in automation-tick.ts): a notice's alert or an email the run's own worker didn't send. */
export const ALERT_DUE_CHECKS = [
  `SELECT 1 FROM notifications WHERE pushed = 0 AND created_at <= ${DB_NOW} - 30000 LIMIT 1`,
  `SELECT 1 FROM automation_emails WHERE state IN ('queued','sending') AND ((state = 'queued' AND created_at <= ${DB_NOW} - 30000 AND ${RUN_ENDED}) OR (state = 'sending' AND sent_at <= ${DB_NOW} - ${SENDING_MS})) LIMIT 1`,
];

/**
 * What a run's receipt says of its email (a run has one at most): the line, in the reader's words, and
 * whether it is still on its way (its receipt keeps asking until it says what became of it).
 */
export async function runEmailLine(runId: string, automationId: string, t: ServerT): Promise<{ text: string; emailing: boolean }> {
  const e = await one<{ state: EmailState }>("SELECT state FROM automation_emails WHERE automation_id = ? AND run_id = ? LIMIT 1", [automationId, runId]);
  if (!e) return { text: "", emailing: false };
  return { text: t(EMAIL_LINES[e.state] ?? EMAIL_LINES.failed, { count: EMAILS_PER_ACCOUNT.toLocaleString(t.locale) }), emailing: e.state === "queued" || e.state === "sending" };
}
