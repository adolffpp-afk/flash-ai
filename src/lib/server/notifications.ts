/*
 * Notices for the Bell (PR 1b shows them): a run is ready, an automation paused, a run was missed or
 * interrupted. Each is stored as an English phrase with its blanks and translated when it is read, in
 * the reader's language, so a notice written by the tick reads right in every language Flash offers. A blank
 * named date holds a UTC time in ms and is written out in the reader's own way when read.
 *
 * ref is a "tell once" key (for example paused:<id>:<month>): a second notice with the same ref is
 * dropped, so a storm of failures makes one notice.
 */
import type { InStatement, InValue } from "@libsql/client";
import { plainLine } from "../automations.ts";
import { msg, type Translate } from "../i18n.ts";
import { run as sql } from "./db.ts";
import { randomId } from "./ids.ts";
import { DB_NOW } from "./leases.ts";

export type NoticeKind = "run_done" | "paused" | "credits" | "missed" | "interrupted" | "stopped";

/** Most of a run's text a notice keeps. */
export const NOTICE_TEXT_CHARS = 2000;

export type Notice = {
  userId: string;
  kind: NoticeKind;
  phrase: string;
  blanks?: Record<string, string | number>;
  link?: string;
  ref?: string;
};

/**
 * The statement that adds a notice, once per ref, for a batch; when is SQL (with its args) that must
 * hold for it to be added, such as the run's lease still being this worker's. It is added to be sent
 * as an alert (pushed 0, see automation-alerts.ts) when its owner turned alerts on somewhere, else as
 * sent (1), so only those notices wait for it.
 */
export function noticeStatement(o: Notice, when?: { sql: string; args: InValue[] }): InStatement & { sql: string; args: InValue[] } {
  return {
    sql: `INSERT INTO notifications (id, user_id, kind, phrase, blanks, link, ref, created_at, pushed)
          SELECT ?, ?, ?, ?, ?, ?, ?, ${DB_NOW}, CASE WHEN EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id = ?) THEN 0 ELSE 1 END WHERE ${when?.sql ?? "1 = 1"}
          ON CONFLICT(user_id, ref) WHERE ref <> '' DO NOTHING`,
    args: [randomId(), o.userId, o.kind, o.phrase, JSON.stringify(o.blanks ?? {}), o.link ?? "", o.ref ?? "", o.userId, ...(when?.args ?? [])],
  };
}

/** Adds a notice for a user, once per ref. Returns whether it was added. */
export async function notify(o: Notice): Promise<boolean> {
  const st = noticeStatement(o);
  const r = await sql(st.sql, st.args);
  return r.rowsAffected === 1;
}

/** The in-app link a notice about an automation (and one of its runs) opens. */
export const automationLink = (automationId: string, runId?: string) =>
  `automations=${encodeURIComponent(automationId)}${runId ? `&run=${encodeURIComponent(runId)}` : ""}`;

/** The cheaper way a "waiting for credits" notice offers (see cheaperOffer in automation-steps.ts). */
export const OFFERS = {
  quick: msg("Use Quick research instead (up to {credits} credits)"),
  sonic: msg("Use Sonic instead (up to {credits} credits)"),
} as const;

/**
 * A stored notice in the reader's words: its title (the automation's name), its line, the run's
 * answer when it carries one (as written, never translated, as one plain line), and the cheaper way
 * it offers.
 */
export function noticeText(n: { phrase: string; blanks: string }, t: Translate & { locale: string }) {
  let blanks: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(n.blanks || "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) blanks = parsed as Record<string, unknown>;
  } catch {
    // Nothing to fill.
  }
  const filled: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(blanks)) {
    if (key === "date" && typeof value === "number") filled.date = new Intl.DateTimeFormat(t.locale, { dateStyle: "long", timeZone: "UTC" }).format(value);
    else if (typeof value === "number") filled[key] = value.toLocaleString(t.locale);
    else if (typeof value === "string") filled[key] = value;
  }
  const offer = blanks.offer === "quick" || blanks.offer === "sonic" ? blanks.offer : null;
  return {
    title: typeof blanks.name === "string" ? blanks.name : "",
    text: t(n.phrase, filled),
    ...(typeof blanks.text === "string" && blanks.text && { body: plainLine(blanks.text) }),
    ...(offer && { offer: { kind: offer, text: t(OFFERS[offer], { credits: Number(blanks.offerCredits ?? 0).toLocaleString(t.locale) }) } }),
  };
}
