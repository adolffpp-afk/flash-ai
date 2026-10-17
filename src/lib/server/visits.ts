/*
 * Visitor stats for published apps: how many page loads and people each day, and where they came
 * from. No cookies, nothing kept on the visitor's device, and nothing sent to other companies. A
 * person is a code made from their address and browser with a random key that changes every day
 * (visit_keys). The key and the codes made with it are deleted after 2 days, so a person counts once
 * a day and can't be recognised on another day or in another app. What stays are daily totals.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { InValue } from "@libsql/client";
import { all, db, one, run } from "./db.ts";
import { sha256 } from "./ids.ts";
import { clientIp } from "./limits.ts";
import { isReturnTrip } from "../traffic.ts";

type Statement = { sql: string; args: InValue[] };

const DAY = 86_400_000;
const DAYS_SHOWN = 30;
/** How many days of daily totals (views, people) are kept: today and the 99 before it. */
export const KEEP_DAYS = 100;
const MAX_SOURCE = 60;
// Crawlers, link previews, uptime checkers, browsers run by scripts, and AI assistants fetching a
// page for someone aren't people looking at it.
const ROBOT =
  /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|curl|wget|python|go-http|java\/|monitor|uptime|scan|whatsapp|inspectiontool|googleother|phantom|selenium|puppeteer|playwright|httpclient|okhttp|axios|node-fetch|undici|postman|(chatgpt|perplexity|claude|mistralai)-user|externalagent|fetcher|embedly|iframely|pingdom/i;

/** The UTC day of a time, like "2026-10-04". */
export const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
/** How many days from one day to another ("2026-10-01" to "2026-10-04" is 3). */
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

/** Where a visit came from: the other website's name, or "" when typed in, bookmarked or from the site itself. */
export function visitSource(referrer: string | null, host: string | null): string {
  if (!referrer) return "";
  try {
    const from = new URL(referrer);
    if (!from.protocol.startsWith("http")) return "";
    const name = from.hostname.toLowerCase().replace(/^www\./, "");
    if (!name || name === (host ?? "").toLowerCase().split(":")[0].replace(/^www\./, "")) return "";
    // Search engines and social apps send many subdomains (m.facebook.com, l.instagram.com).
    const known = name.match(/(?:^|\.)(google|bing|duckduckgo|yahoo|facebook|instagram|tiktok|youtube|linkedin|pinterest|reddit)\.[a-z.]+$/);
    if (known) return known[1] === "google" ? "google.com" : `${known[1]}.com`;
    if (name === "t.co") return "x.com";
    return name.slice(0, MAX_SOURCE);
  } catch {
    return "";
  }
}

/**
 * Whether a page request is a person looking at the page, not a robot or a prefetch. Browsers, and
 * the web views inside apps, always say which languages their person reads; most scripts don't.
 */
export function isPersonVisit(request: Request): boolean {
  const agent = request.headers.get("user-agent") ?? "";
  if (!agent || ROBOT.test(agent) || !request.headers.get("accept-language")) return false;
  const purpose = request.headers.get("sec-purpose") ?? request.headers.get("purpose") ?? "";
  return !/prefetch|prerender/i.test(purpose);
}

/*
 * What each server remembers, so most loads read nothing extra: the day's keys (today's and
 * yesterday's), the day counting began, and whether it tried the daily prune today.
 */
const keys = new Map<string, Buffer>();
const noKey = new Map<string, number>();
let since: { day: string; value: string } | null = null;
let triedPrune = "";

/** Forgets what this server remembers, as a new server would start. For tests. */
export function forgetServerMemory(): void {
  keys.clear();
  noKey.clear();
  since = null;
  triedPrune = "";
}

/** Tests make the daily prune fail with this (see test/visits.test.ts); Flash itself never sets it. */
export const pruneTests = { fail: false };

function keep(day: string, key: Buffer) {
  keys.set(day, key);
  // Only today's and yesterday's are ever used.
  while (keys.size > 2) keys.delete(keys.keys().next().value!);
}

/** A day's key, made by the first server that needs it; every server agrees on the one kept. */
async function dayKey(day: string): Promise<Buffer> {
  const known = keys.get(day);
  if (known) return known;
  const [, read] = await (
    await db()
  ).batch(
    [
      { sql: "INSERT OR IGNORE INTO visit_keys (day, secret) VALUES (?, ?)", args: [day, randomBytes(32).toString("hex")] },
      { sql: "SELECT secret FROM visit_keys WHERE day = ?", args: [day] },
    ],
    "write",
  );
  const key = Buffer.from(String(read.rows[0].secret), "hex");
  keep(day, key);
  return key;
}

/**
 * A day's key when some visit made one, else null: matching a step never makes a key, as one no
 * code was made with matches nothing. A missing key is remembered for a minute.
 */
export async function pastKey(day: string, at = Date.now()): Promise<Buffer | null> {
  const known = keys.get(day);
  if (known) return known;
  if ((noKey.get(day) ?? 0) > at) return null;
  const row = await one<{ secret: string }>("SELECT secret FROM visit_keys WHERE day = ?", [day]);
  if (!row) {
    noKey.set(day, at + 60_000);
    while (noKey.size > 4) noKey.delete(noKey.keys().next().value!);
    return null;
  }
  const key = Buffer.from(String(row.secret), "hex");
  keep(day, key);
  return key;
}

/** The code that stands for this browser on this app on one day, made with that day's key. */
export async function visitorCode(slug: string, request: Request, day: string, key?: Buffer): Promise<string> {
  return createHmac("sha256", key ?? (await dayKey(day)))
    .update(`${slug}|${clientIp(request)}|${request.headers.get("user-agent") ?? ""}`)
    .digest("hex")
    .slice(0, 24);
}

/** The code the counter before site_people made, without a key: who it counted on the day it was replaced. */
const oldCode = (slug: string, request: Request, day: string) =>
  sha256(`${day}|${slug}|${clientIp(request)}|${request.headers.get("user-agent")}`).slice(0, 24);

/**
 * The day people started being counted as they are now (settings.funnel_since, set by the first
 * daily prune), read once per server per day. Before the first prune, that is today.
 */
export async function funnelSince(today: string): Promise<string> {
  if (since?.day === today) return since.value;
  const row = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'funnel_since'");
  since = { day: today, value: row?.value || today };
  return since.value;
}

/** The owner's own visit to their app on one day, so they aren't counted and their steps that day don't count. */
const ownerRow = (slug: string, day: string, visitor: string): Statement => ({
  sql: "INSERT OR IGNORE INTO site_people (site_slug, day, visitor, kind) SELECT slug, ?, ?, 'owner' FROM sites WHERE slug = ?",
  args: [day, visitor, slug],
});

/**
 * Notes the app's owner opening it with a working Open as owner code, on /p/ or on its own domain:
 * they aren't a visitor that day, and their steps don't count. Never throws.
 */
export async function recordOwnerVisit(slug: string, request: Request, at = Date.now()): Promise<void> {
  if (!isPersonVisit(request)) return;
  try {
    const day = dayOf(at);
    const s = ownerRow(slug, day, await visitorCode(slug, request, day));
    await run(s.sql, s.args);
  } catch (err) {
    console.error("[flash] owner visit not noted", err);
  }
}

/**
 * Counts one load of a published app: a view, and the person once a day. viewerId is who is signed
 * in to Flash, on /p/ only. Never throws: stats must not break an app.
 */
export async function recordVisit(slug: string, request: Request, viewerId?: string | null, at = Date.now()): Promise<void> {
  if (!isPersonVisit(request) || isReturnTrip(new URL(request.url), request.headers.get("referer"))) return;
  await countVisit(slug, request, viewerId, at).catch((err) => console.error("[flash] visit not counted", err));
  await pruneDaily(at);
}

async function countVisit(slug: string, request: Request, viewerId: string | null | undefined, at: number): Promise<void> {
  const day = dayOf(at);
  const visitor = await visitorCode(slug, request, day);
  // On the day this counter took over from the one before it, someone that one counted earlier in
  // the day is found by their old code, so they aren't counted twice.
  const deploy = (await funnelSince(day)) === day;
  const row = await one<{ owner: string; kind: string | null; before?: number | null }>(
    `SELECT s.user_id AS owner, p.kind${deploy ? ", v.visitor IS NOT NULL AS before" : ""}
     FROM sites s
     LEFT JOIN site_people p ON p.site_slug = s.slug AND p.day = ? AND p.visitor = ?
     ${deploy ? "LEFT JOIN site_visitors v ON v.site_slug = s.slug AND v.day = ? AND v.visitor = ?" : ""}
     WHERE s.slug = ?`,
    deploy ? [day, visitor, day, oldCode(slug, request, day), slug] : [day, visitor, slug],
  );
  // The app was just unpublished.
  if (!row) return;
  // The owner checking their own app isn't a visitor.
  if (viewerId && viewerId === row.owner) {
    const s = ownerRow(slug, day, visitor);
    await run(s.sql, s.args);
    return;
  }
  if (row.kind === "owner") return;
  const writes: Statement[] = [];
  if (!row.kind) {
    const person: Statement = {
      sql: "INSERT OR IGNORE INTO site_people (site_slug, day, visitor, kind) SELECT slug, ?, ?, 'visit' FROM sites WHERE slug = ?",
      args: [day, visitor, slug],
    };
    // Counted already today, by the counter before this one.
    if (row.before) writes.push(person);
    else
      writes.push(
        // Counted only while the person's row isn't there yet, so two servers counting the same
        // person at once count them once.
        {
          sql: `INSERT INTO site_events (site_slug, day, step, source, medium, campaign, n)
                SELECT slug, ?, 'visit', '', '', '', 1 FROM sites WHERE slug = ?
                  AND NOT EXISTS (SELECT 1 FROM site_people WHERE site_slug = ? AND day = ? AND visitor = ?)
                ON CONFLICT DO UPDATE SET n = n + 1`,
          args: [day, slug, slug, day, visitor],
        },
        person,
      );
  }
  // INSERT … SELECT so a visit to a site that was just unpublished writes nothing.
  writes.push({
    sql: `INSERT INTO site_visits (site_slug, day, source, views) SELECT slug, ?, ?, 1 FROM sites WHERE slug = ?
          ON CONFLICT (site_slug, day, source) DO UPDATE SET views = views + 1`,
    args: [day, visitSource(request.headers.get("referer"), request.headers.get("host")), slug],
  });
  await (await db()).batch(writes, "write");
}

/**
 * Forgets what is past keeping, once a day, Flash-wide: the first server to claim the day does it,
 * inside a visit's after(), so nobody waits on it. Each delete reads its whole table once, far less
 * than looking on every load did. True when this server did it. Never throws.
 */
export async function pruneDaily(at = Date.now()): Promise<boolean> {
  const today = dayOf(at);
  if (triedPrune === today) return false;
  triedPrune = today;
  let before = "";
  try {
    await run("INSERT OR IGNORE INTO settings (key, value) VALUES ('visits_pruned', '')");
    before = String((await one<{ value: string }>("SELECT value FROM settings WHERE key = 'visits_pruned'"))?.value ?? "");
    const claim = await run("UPDATE settings SET value = ? WHERE key = 'visits_pruned' AND value = ? AND value < ?", [today, before, today]);
    if (!claim.rowsAffected) return false;
  } catch (err) {
    console.error("[flash] daily prune not started", err);
    return false;
  }
  const yesterday = dayOf(at - DAY);
  const kept = dayOf(at - (KEEP_DAYS - 1) * DAY);
  try {
    const c = await db();
    // People counted before site_people, with codes made without a key, become daily totals, and
    // their codes go. Only days before today: today's are still looked up (see recordVisit), and go
    // tomorrow. One transaction, so a reader sees each of them counted once (see peoplePerDay).
    await c.batch(
      [
        { sql: "INSERT OR IGNORE INTO settings (key, value) VALUES ('funnel_since', ?)", args: [today] },
        {
          sql: `INSERT INTO site_events (site_slug, day, step, source, medium, campaign, n)
                SELECT site_slug, day, 'visit-old', '', '', '', COUNT(*) FROM site_visitors WHERE day < ? GROUP BY site_slug, day
                ON CONFLICT DO UPDATE SET n = n + excluded.n`,
          args: [today],
        },
        { sql: "DELETE FROM site_visitors WHERE day < ?", args: [today] },
      ],
      "write",
    );
    if (pruneTests.fail) throw new Error("prune failed (test)");
    await c.batch(
      [
        { sql: "DELETE FROM visit_keys WHERE day < ?", args: [yesterday] },
        { sql: "DELETE FROM site_people WHERE day < ?", args: [yesterday] },
        { sql: "DELETE FROM site_visits WHERE day < ?", args: [kept] },
        { sql: "DELETE FROM site_events WHERE day < ?", args: [kept] },
      ],
      "write",
    );
    return true;
  } catch (err) {
    // Another server can claim the day then; this one doesn't try again today.
    console.error("[flash] daily prune failed", err);
    await run("UPDATE settings SET value = ? WHERE key = 'visits_pruned' AND value = ?", [before, today]).catch(() => {});
    return false;
  }
}

/**
 * People per day on an app from one day on: the 'visit' totals, the totals of people counted before
 * site_people ('visit-old'), and those not rolled up into them yet (site_visitors). The Visitors
 * tile and the funnel both use it, so they always agree.
 */
export async function peoplePerDay(slug: string, from: string): Promise<Map<string, number>> {
  const rows = await all<{ day: string; n: number }>(
    `SELECT day, SUM(n) AS n FROM (
       SELECT day, n FROM site_events WHERE site_slug = ? AND day >= ? AND step IN ('visit', 'visit-old')
       UNION ALL
       SELECT day, COUNT(*) AS n FROM site_visitors WHERE site_slug = ? AND day >= ? GROUP BY day
     ) GROUP BY day`,
    [slug, from, slug, from],
  );
  return new Map(rows.map((r) => [r.day, Number(r.n)]));
}

export type VisitStats = {
  days: { day: string; views: number; visitors: number }[];
  views: number;
  visitors: number;
  sources: { source: string; views: number }[];
};

/**
 * The last 30 days of a site's visits, oldest first, with days without visits as zero. Days before
 * the app existed aren't shown at all.
 */
export async function visitStats(slug: string, at = Date.now()): Promise<VisitStats> {
  const today = dayOf(at);
  const created = await one<{ created_at: number }>("SELECT created_at FROM sites WHERE slug = ?", [slug]);
  const age = created ? daysBetween(dayOf(Number(created.created_at)), today) + 1 : DAYS_SHOWN;
  const shown = Math.max(1, Math.min(DAYS_SHOWN, age));
  const first = dayOf(at - (shown - 1) * DAY);
  const views = await all<{ day: string; n: number }>(
    "SELECT day, SUM(views) AS n FROM site_visits WHERE site_slug = ? AND day >= ? GROUP BY day",
    [slug, first],
  );
  const people = await peoplePerDay(slug, first);
  const sources = await all<{ source: string; n: number }>(
    "SELECT source, SUM(views) AS n FROM site_visits WHERE site_slug = ? AND day >= ? GROUP BY source ORDER BY n DESC LIMIT 8",
    [slug, first],
  );
  const viewsOn = new Map(views.map((r) => [r.day, Number(r.n)]));
  const days = Array.from({ length: shown }, (_, i) => {
    const day = dayOf(at - (shown - 1 - i) * DAY);
    return { day, views: viewsOn.get(day) ?? 0, visitors: people.get(day) ?? 0 };
  });
  return {
    days,
    views: days.reduce((n, d) => n + d.views, 0),
    // People counted once a day, so someone who came on two days counts twice.
    visitors: days.reduce((n, d) => n + d.visitors, 0),
    sources: sources.map((r) => ({ source: r.source, views: Number(r.n) })),
  };
}
