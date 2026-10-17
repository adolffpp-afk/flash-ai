import { all, one, run, now } from "./db.ts";
import { randomId, sha256 } from "./ids.ts";
import { countOf, overLimit } from "./limits.ts";
import { EMAILS, emailEnabled, sendEmail } from "./email.ts";
import { domainsForSite, removeDomain, siteForDomain } from "./domains.ts";
import { deleteShare } from "./shares.ts";
import { unpublishSite } from "./sites.ts";
import { tokenContact } from "./contacts.ts";
import type { User } from "./auth.ts";
import { english, type Translate } from "../i18n.ts";
import {
  MAX_REPORT_DETAILS,
  MAX_REPORT_EMAIL,
  REPORT_KIND_NAMES,
  isReportReason,
  reasonLabel,
  reportTarget,
  type ReportKind,
  type ReportTarget,
} from "../report.ts";

/*
 * Reports of what people share or publish with Flash (see src/lib/report.ts), for Flash's admins:
 * kept here, listed in /admin > Reports, and emailed to the admins. Anyone can report, signed in or
 * not, so reports are limited per network and for everyone together, are plain text with a capped
 * length, and the same network reporting the same item for the same reason again adds to its open
 * report. Nothing is shown to the item's owner or anyone else.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Reports one network may send an hour and a day, and everyone together a day; and how many of one
// network's new reports a day the admins get an email about, so one network can't use up the day's
// report emails (EMAIL_BUDGET.reports) before anyone else reports.
export const REPORT_LIMITS = { perHour: 10, perDay: 30, allPerDay: 500, emailsPerNetwork: 2 };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KINDS: ReportKind[] = ["share", "site", "file"];

const isKind = (value: unknown): value is ReportKind => KINDS.includes(value as ReportKind);

/** Where an item is on Flash's own address. */
export const itemPath = (kind: ReportKind, id: string) => `/${kind === "share" ? "s" : kind === "site" ? "p" : "f"}/${id}`;

/**
 * What someone typed, as plain text: no control characters but line breaks and tabs, and no
 * direction overrides, which could make it read differently on the admin's screen.
 */
export const plainText = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[\p{Cc}‪-‮⁦-⁩]/gu, (c) => (c === "\n" || c === "\t" ? c : ""))
    .trim();

export type ReportItem = { kind: ReportKind; id: string; ownerId: string; title: string; via: string };

// Each kind of item as Flash has it now: whose it is, and what it's called.
const LOOKUP: Record<ReportKind, string> = {
  share: "SELECT user_id AS owner, title FROM shares WHERE id = ?",
  site: "SELECT user_id AS owner, title FROM sites WHERE slug = ?",
  file: "SELECT p.user_id AS owner, f.name AS title FROM public_files p JOIN files f ON f.id = p.file_id AND f.user_id = p.user_id WHERE p.id = ?",
};

/**
 * The item an address points at, as Flash has it now, or null. A custom domain is the app connected
 * to it, found with or without its www, and an unsubscribe link (one that works) is its app.
 */
export async function findReported(target: ReportTarget): Promise<ReportItem | null> {
  if (target.kind === "unsubscribe") {
    const contact = await tokenContact(target.token);
    return contact ? findReported({ kind: "site", id: contact.slug }) : null;
  }
  if (target.kind === "domain") {
    const bare = target.domain.replace(/^www\./, "");
    for (const domain of new Set([target.domain, bare, `www.${bare}`])) {
      const slug = await siteForDomain(domain);
      const site = slug ? await findReported({ kind: "site", id: slug }) : null;
      if (site) return { ...site, via: domain };
    }
    return null;
  }
  const row = await one<{ owner: string; title: string }>(LOOKUP[target.kind], [target.id]);
  return row ? { kind: target.kind, id: target.id, ownerId: String(row.owner), title: String(row.title ?? ""), via: "" } : null;
}

export type ReportResult = { ok: true; id: string; item: ReportItem; repeat: boolean } | { error: string; status: number };

/**
 * Saves a report: { address, reason, details?, email? }. The address must be one of Flash's pages
 * or a published app's domain, and is kept as the item it points at. ip is the reporter's network
 * (see clientIp), kept only as a hash, to collapse its repeats and count its reports.
 */
export async function submitReport(body: unknown, ip: string, t: Translate = english): Promise<ReportResult> {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const address = typeof input.address === "string" ? input.address.trim() : "";
  if (!address) return { error: t("Paste the address of the page you're reporting."), status: 400 };
  const reason = input.reason;
  if (!isReportReason(reason)) return { error: t("Pick what's wrong."), status: 400 };
  const typed = typeof input.details === "string" ? input.details : "";
  if (typed.length > MAX_REPORT_DETAILS) return { error: t("Keep the details under {max} characters.", { max: MAX_REPORT_DETAILS }), status: 413 };
  const details = plainText(typed);
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  // The length first: the pattern is slow on very long text.
  if (email && (email.length > MAX_REPORT_EMAIL || !EMAIL.test(email))) return { error: t("Enter a valid email address."), status: 400 };
  // The network as a hash, for its limits too, so its address is kept nowhere.
  const reporter = sha256(`flash-report:${ip}`).slice(0, 32);
  if (await overLimit(`report-ip:${reporter}`, REPORT_LIMITS.perHour, HOUR)) return { error: t("Too many requests. Try again in an hour."), status: 429 };
  if (await overLimit(`report-ip-day:${reporter}`, REPORT_LIMITS.perDay, DAY)) return { error: t("Too many tries today. Please try again tomorrow."), status: 429 };
  const target = reportTarget(address);
  if (!target) return { error: t("That isn't the address of a Flash page or an app made with Flash."), status: 400 };
  const item = await findReported(target);
  if (!item) return { error: t("We couldn't find that page. Check the address. It may have been taken down already."), status: 404 };
  // Only reports of something Flash has count for everyone, so addresses that point nowhere can't use them up.
  if (await overLimit("report-all", REPORT_LIMITS.allPerDay, DAY)) return { error: t("Too many tries today. Please try again tomorrow."), status: 429 };

  const at = now();
  // Reported again by the same network for the same reason while open: one report, counted again,
  // with new details added below the ones it has, and an email if it had none. Another reason is a
  // report of its own.
  const row = await one<{ id: string; repeats: number }>(
    `INSERT INTO reports (id, item_kind, item_id, owner_id, title, via, reason, details, email, reporter, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (item_kind, item_id, reporter, reason) WHERE status = 'open' DO UPDATE SET
       repeats = repeats + 1,
       updated_at = excluded.updated_at,
       details = CASE
         WHEN excluded.details = '' OR instr(details, excluded.details) > 0 THEN details
         WHEN details = '' THEN excluded.details
         ELSE substr(details || char(10) || excluded.details, 1, ?)
       END,
       email = CASE WHEN email = '' THEN excluded.email ELSE email END
     RETURNING id, repeats`,
    [randomId(), item.kind, item.id, item.ownerId, item.title.slice(0, 200), item.via, reason, details, email, reporter, at, at, MAX_REPORT_DETAILS],
  );
  return { ok: true, id: String(row!.id), item, repeat: Number(row!.repeats) > 1 };
}

/** Flash's admins, as FLASH_ADMIN_EMAILS lists them (see isAdmin). */
const adminEmails = () =>
  (process.env.FLASH_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 5);

/**
 * Emails Flash's admins about a new report, one email to them all: at most one per item an hour,
 * REPORT_LIMITS.emailsPerNetwork a day for one network's reports, and only while the day's email
 * budget lasts (EMAIL_BUDGET.reports, see email.ts). Without email set up, or admins, nothing is
 * sent; the report is in /admin > Reports either way. origin is Flash's address, for the links.
 * Returns how many admins it went to.
 */
export async function tellAdmins(reportId: string, origin: string): Promise<number> {
  const admins = adminEmails();
  if (!admins.length || !emailEnabled()) return 0;
  const report = await one<{ item_kind: ReportKind; item_id: string; title: string; via: string; reason: string; details: string; email: string; reporter: string; owner: string | null }>(
    `SELECT r.item_kind, r.item_id, r.title, r.via, r.reason, r.details, r.email, r.reporter, u.email AS owner
     FROM reports r LEFT JOIN users u ON u.id = r.owner_id WHERE r.id = ?`,
    [reportId],
  );
  if (!report) return 0;
  // The network's share is looked at first and counted last, so a network that used it up doesn't
  // take the item's hour from the next person who reports it.
  const network = `report-mail-net:${report.reporter}`;
  if ((await countOf(network)) >= REPORT_LIMITS.emailsPerNetwork) return 0;
  if (await overLimit(`report-mail:${report.item_kind}:${report.item_id}`, 1, HOUR)) return 0;
  await overLimit(network, REPORT_LIMITS.emailsPerNetwork, DAY);
  const count = await one<{ n: number }>("SELECT COUNT(*) AS n FROM reports WHERE item_kind = ? AND item_id = ?", [report.item_kind, report.item_id]);
  const message = EMAILS.report({
    what: REPORT_KIND_NAMES[report.item_kind],
    title: report.title,
    address: `${origin}${itemPath(report.item_kind, report.item_id)}${report.via ? ` (on ${report.via})` : ""}`,
    owner: report.owner ?? "",
    reason: reasonLabel(report.reason),
    count: Number(count?.n ?? 1),
    details: report.details,
    reporter: report.email,
    link: `${origin}/admin?tab=reports`,
  });
  try {
    return (await sendEmail(admins, message, "report")) ? admins.length : 0;
  } catch (err) {
    console.error("[flash] report email failed", err instanceof Error ? err.message : err);
    return 0;
  }
}

export type ReportEntry = { id: string; reason: string; details: string; email: string; repeats: number; status: string; createdAt: number; updatedAt: number };
export type ReportedItem = {
  kind: ReportKind;
  id: string;
  title: string;
  // The custom domain it was reported at, if any.
  via: string;
  path: string;
  ownerEmail: string;
  // Whether it's still up, so it can be taken down.
  live: boolean;
  canTakeDown: boolean;
  open: number;
  total: number;
  newest: number;
  status: "open" | "reviewed" | "taken_down";
  reports: ReportEntry[];
  // What an admin did last, if anything.
  last: { action: string; by: string; at: number } | null;
};

type ReportRow = {
  id: string;
  item_kind: ReportKind;
  item_id: string;
  title: string;
  via: string;
  reason: string;
  details: string;
  email: string;
  repeats: number;
  status: string;
  created_at: number;
  updated_at: number;
  owner_email: string | null;
};

/** The ids of the items of one kind that are still up, of those given. */
async function stillUp(kind: ReportKind, ids: string[]): Promise<Set<string>> {
  const up = new Set<string>();
  const [table, column] = kind === "share" ? ["shares", "id"] : kind === "site" ? ["sites", "slug"] : ["public_files", "id"];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const rows = await all<{ id: string }>(`SELECT ${column} AS id FROM ${table} WHERE ${column} IN (${chunk.map(() => "?").join(",")})`, chunk);
    for (const r of rows) up.add(String(r.id));
  }
  return up;
}

/**
 * Every reported item with its reports, items with open reports first, then the newest. Open
 * reports are read first, then the newest closed ones, up to limit reports in all, so an old open
 * report never drops off behind newer closed ones.
 */
export async function listReports(limit = 1000): Promise<ReportedItem[]> {
  const rows = await all<ReportRow>(
    `SELECT r.id, r.item_kind, r.item_id, r.title, r.via, r.reason, r.details, r.email, r.repeats, r.status, r.created_at, r.updated_at,
            u.email AS owner_email
     FROM reports r LEFT JOIN users u ON u.id = r.owner_id ORDER BY (r.status = 'open') DESC, r.created_at DESC, r.rowid DESC LIMIT ?`,
    [limit],
  );
  const items = new Map<string, ReportedItem>();
  for (const r of rows) {
    const key = `${r.item_kind}:${r.item_id}`;
    let item = items.get(key);
    if (!item) {
      item = {
        kind: r.item_kind,
        id: r.item_id,
        title: r.title,
        via: r.via,
        path: itemPath(r.item_kind, r.item_id),
        ownerEmail: r.owner_email ?? "",
        live: false,
        canTakeDown: false,
        open: 0,
        total: 0,
        newest: Number(r.created_at),
        status: "reviewed",
        reports: [],
        last: null,
      };
      items.set(key, item);
    }
    if (!item.via && r.via) item.via = r.via;
    item.total++;
    if (r.status === "open") item.open++;
    item.reports.push({
      id: r.id,
      reason: r.reason,
      details: r.details,
      email: r.email,
      repeats: Number(r.repeats),
      status: r.status,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    });
  }
  const list = [...items.values()];
  for (const kind of KINDS) {
    const ofKind = list.filter((i) => i.kind === kind);
    const up = await stillUp(kind, ofKind.map((i) => i.id));
    for (const item of ofKind) item.live = up.has(item.id);
  }
  const actions = await all<{ item_kind: string; item_id: string; action: string; admin_email: string; created_at: number }>(
    "SELECT item_kind, item_id, action, admin_email, created_at FROM report_actions ORDER BY id DESC LIMIT 2000",
  );
  for (const a of actions) {
    const item = items.get(`${a.item_kind}:${a.item_id}`);
    if (item && !item.last) item.last = { action: a.action, by: a.admin_email, at: Number(a.created_at) };
  }
  for (const item of list) {
    item.status = item.open ? "open" : item.reports.some((r) => r.status === "taken_down") ? "taken_down" : "reviewed";
    item.canTakeDown = item.live;
  }
  return list.sort((a, b) => Number(b.open > 0) - Number(a.open > 0) || b.newest - a.newest);
}

/**
 * What an admin does about an item's reports: "reviewed" closes its open reports; "take_down" also
 * takes the item down: stops the share link or the file link (the owner's chat or file stays), or
 * unpublishes the app with everything it kept and disconnects its domains, as its owner would.
 * Each is logged in report_actions.
 */
export async function actOnReport(admin: User, kind: unknown, id: unknown, action: unknown): Promise<{ ok: true } | { error: string; status: number }> {
  if (!isKind(kind) || typeof id !== "string" || !id || (action !== "reviewed" && action !== "take_down")) {
    return { error: "Say which item, and whether to mark it reviewed or take it down.", status: 400 };
  }
  if (!(await one("SELECT 1 FROM reports WHERE item_kind = ? AND item_id = ? LIMIT 1", [kind, id]))) {
    return { error: "Nobody has reported that.", status: 404 };
  }
  if (action === "take_down") {
    const found = await one<{ owner: string }>(LOOKUP[kind], [id]);
    // An app's name can be taken again once it's unpublished: never take down someone else's app
    // because of what was reported about the one that had its name before.
    const reported = await one<{ owner_id: string }>("SELECT owner_id FROM reports WHERE item_kind = ? AND item_id = ? ORDER BY created_at DESC LIMIT 1", [kind, id]);
    if (found && reported && String(found.owner) !== reported.owner_id) {
      return { error: "This has a new owner since it was reported, so it wasn't taken down. Check what's there now, then mark it reviewed.", status: 409 };
    }
    // Gone already (its owner took it down): its reports close all the same.
    if (found && kind === "share") await deleteShare(String(found.owner), id);
    // Only this link: /f/ serves a file through its own link, and the file stays in its owner's account.
    if (found && kind === "file") await run("DELETE FROM public_files WHERE id = ?", [id]);
    if (found && kind === "site") {
      // Its domains leave Vercel too, before the app and everything it kept go (as unpublishing does).
      for (const domain of await domainsForSite(id)) await removeDomain(domain);
      await unpublishSite(String(found.owner), id);
    }
    await run("UPDATE reports SET status = 'taken_down', updated_at = ? WHERE item_kind = ? AND item_id = ?", [now(), kind, id]);
  } else {
    await run("UPDATE reports SET status = 'reviewed', updated_at = ? WHERE item_kind = ? AND item_id = ? AND status = 'open'", [now(), kind, id]);
  }
  const done = action === "take_down" ? "taken_down" : "reviewed";
  await run("INSERT INTO report_actions (item_kind, item_id, action, admin_email, created_at) VALUES (?, ?, ?, ?, ?)", [kind, id, done, admin.email, now()]);
  console.info(`[flash] reports: ${admin.email} ${action === "take_down" ? "took down" : "reviewed"} ${kind} ${id}`);
  return { ok: true };
}
