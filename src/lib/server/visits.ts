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
import { isAdmin } from "./auth.ts";
import { activeSubscription } from "./subscriptions.ts";
import { OTHER, isReturnTrip, touchOf, visitSource, type Touch } from "../traffic.ts";

export { visitSource };

type Statement = { sql: string; args: InValue[] };

const DAY = 86_400_000;
const MINUTE = 60_000;
const DAYS_SHOWN = 30;
/** How many days of daily totals (views, people) are kept: today and the 99 before it. */
export const KEEP_DAYS = 100;

/*
 * How many people are counted each UTC day across all of one owner's apps, by their plan (set by
 * Flash's plans). Past it the apps work as before and views still count, but new people that day
 * aren't counted, so their forms, sign-ups and checkouts show as not matched. A team member's apps
 * count against the member's own plan.
 */
export const FREE_PEOPLE_PER_DAY = 10_000;
export const PLAN_PEOPLE: Record<string, number> = {
  lite: 20_000,
  pro: 50_000,
  power: 100_000,
  business: 150_000,
  max: 300_000,
  agency: 500_000,
};
/** New people each server counts per owner per day from one internet connection, so one stranger can't use up the owner's day. */
export const NETWORK_PEOPLE = 100;
/** Sources (each with its medium and campaign) per app per day; past them, people count under "(other)". */
export const MAX_TOUCHES = 30;
// How long a server goes by what it read of an owner's plan, and by "paused for today".
const PLAN_MEMORY = 15 * MINUTE;
// Past this many connections in memory, the older half is forgotten.
const MAX_NETWORKS = 50_000;

/** What tests change (see test/visits.test.ts): smaller limits, and a prune that fails. Flash itself never does. */
export const visitTests = { freePeople: 0, networkPeople: 0, failPrune: false };
const freePeople = () => visitTests.freePeople || FREE_PEOPLE_PER_DAY;
const networkPeople = () => visitTests.networkPeople || NETWORK_PEOPLE;
// Crawlers, link previews, uptime checkers, browsers run by scripts, and AI assistants fetching a
// page for someone aren't people looking at it.
const ROBOT =
  /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|curl|wget|python|go-http|java\/|monitor|uptime|scan|whatsapp|inspectiontool|googleother|phantom|selenium|puppeteer|playwright|httpclient|okhttp|axios|node-fetch|undici|postman|(chatgpt|perplexity|claude|mistralai)-user|externalagent|fetcher|embedly|iframely|pingdom/i;

/** The UTC day of a time, like "2026-10-04". */
export const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
/** How many days from one day to another ("2026-10-01" to "2026-10-04" is 3). */
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

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
 * yesterday's), the day counting began, whether it tried the daily prune today, owners' plans and
 * "paused for today" for 15 minutes, the marks it wrote today, and how many new people it counted
 * today per owner from each connection (under a code made with the day's key, never the address).
 */
const keys = new Map<string, Buffer>();
const noKey = new Map<string, number>();
let since: { day: string; value: string } | null = null;
let triedPrune = "";
const plans = new Map<string, { until: number; cap: number; paid: boolean }>();
const paused = new Map<string, { until: number; cap: number }>();
const marked = new Set<string>();
const networks = new Map<string, number>();
let memoryDay = "";

/** Forgets what this server remembers, as a new server would start. For tests. */
export function forgetServerMemory(): void {
  keys.clear();
  noKey.clear();
  since = null;
  triedPrune = "";
  plans.clear();
  paused.clear();
  marked.clear();
  networks.clear();
  memoryDay = "";
}

/** What this server keeps about connections, for tests to check it holds no address. */
export const networkMemory = () => [...networks.keys()];

/** Today's marks and connection counts start empty each day. */
function startDay(day: string) {
  if (day === memoryDay) return;
  memoryDay = day;
  marked.clear();
  networks.clear();
  for (const key of paused.keys()) if (!key.endsWith(`|${day}`)) paused.delete(key);
}

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
 * How many people an owner's apps may count a day, by their plan (an admin's is Agency's), and
 * whether they have a paid plan. Each server reads it at most every 15 minutes per owner, so a plan
 * bought during the day counts within 15 minutes.
 */
export async function peopleCap(ownerId: string, at = Date.now()): Promise<{ cap: number; paid: boolean }> {
  const known = plans.get(ownerId);
  if (known && known.until > at) return { cap: known.cap, paid: known.paid };
  const sub = await activeSubscription(ownerId);
  let cap = freePeople();
  let paid = false;
  if (sub && Object.hasOwn(PLAN_PEOPLE, sub.plan)) [cap, paid] = [PLAN_PEOPLE[sub.plan], true];
  else {
    const user = await one<{ email: string; verified_at: number }>("SELECT email, verified_at FROM users WHERE id = ?", [ownerId]);
    if (user && isAdmin(user)) [cap, paid] = [PLAN_PEOPLE.agency, true];
  }
  plans.set(ownerId, { until: at + PLAN_MEMORY, cap, paid });
  while (plans.size > 10_000) plans.delete(plans.keys().next().value!);
  return { cap, paid };
}

/**
 * A mark on the app's day that its numbers missed people (or app steps), with the limit reached.
 * Each server writes it once per app and day; the higher limit stays, for a plan bought that day.
 */
function markOnce(slug: string, step: string, limit: number, day: string): Statement | null {
  const key = `${slug}|${step}|${day}`;
  if (marked.has(key)) return null;
  marked.add(key);
  return {
    sql: `INSERT INTO site_events (site_slug, day, step, source, medium, campaign, n) SELECT slug, ?, ?, '', '', '', ? FROM sites WHERE slug = ?
          ON CONFLICT DO UPDATE SET n = MAX(n, excluded.n)`,
    args: [day, step, limit, slug],
  };
}

/** The touch, or "(other)" once the app has its 30 sources for the day and this isn't one of them. */
async function withinTouches(slug: string, day: string, touch: Touch): Promise<Touch> {
  const s = await one<{ touches: number; known: number }>(
    `SELECT COUNT(*) AS touches, COALESCE(MAX(source = ? AND medium = ? AND campaign = ?), 0) AS known
     FROM site_events WHERE site_slug = ? AND day = ? AND step = 'visit'`,
    [touch.source, touch.medium, touch.campaign, slug, day],
  );
  return !Number(s?.known) && Number(s?.touches ?? 0) >= MAX_TOUCHES ? OTHER : touch;
}

/** The code this server counts an owner's new people from one connection under, made with the day's key. */
const networkOf = (key: Buffer, owner: string, request: Request) =>
  createHmac("sha256", key).update(`network|${owner}|${clientIp(request)}`).digest("hex").slice(0, 24);

/**
 * Counts one load of a published app: a view, and the person once a day, under where they first
 * came from that day. viewerId is who is signed in to Flash, on /p/ only. Never throws: stats must
 * not break an app.
 */
export async function recordVisit(slug: string, request: Request, viewerId?: string | null, at = Date.now()): Promise<void> {
  if (!isPersonVisit(request) || isReturnTrip(new URL(request.url), request.headers.get("referer"))) return;
  await countVisit(slug, request, viewerId, at).catch((err) => console.error("[flash] visit not counted", err));
  await pruneDaily(at);
}

async function countVisit(slug: string, request: Request, viewerId: string | null | undefined, at: number): Promise<void> {
  const day = dayOf(at);
  startDay(day);
  const key = await dayKey(day);
  const visitor = await visitorCode(slug, request, day, key);
  // On the day this counter took over from the one before it, someone that one counted earlier in
  // the day is found by their old code, so they aren't counted twice.
  const deploy = (await funnelSince(day)) === day;
  // The app, the person's row for today, and the owner's count for today: three lookups by key.
  const row = await one<{
    owner: string;
    kind: string | null;
    source: string | null;
    medium: string | null;
    campaign: string | null;
    people: number | null;
    before?: number | null;
  }>(
    `SELECT s.user_id AS owner, p.kind, p.source, p.medium, p.campaign, o.people${deploy ? ", v.visitor IS NOT NULL AS before" : ""}
     FROM sites s
     LEFT JOIN site_people p ON p.site_slug = s.slug AND p.day = ? AND p.visitor = ?
     LEFT JOIN owner_people o ON o.user_id = s.user_id AND o.day = ?
     ${deploy ? "LEFT JOIN site_visitors v ON v.site_slug = s.slug AND v.day = ? AND v.visitor = ?" : ""}
     WHERE s.slug = ?`,
    deploy ? [day, visitor, day, day, oldCode(slug, request, day), slug] : [day, visitor, day, slug],
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
  const person = (t: Touch): Statement => ({
    sql: "INSERT OR IGNORE INTO site_people (site_slug, day, visitor, kind, source, medium, campaign) SELECT slug, ?, ?, 'visit', ?, ?, ? FROM sites WHERE slug = ?",
    args: [day, visitor, t.source, t.medium, t.campaign, slug],
  });
  // Someone counted already today keeps the source they first came from.
  let touch: Touch = row.kind
    ? { source: row.source ?? "", medium: row.medium ?? "", campaign: row.campaign ?? "" }
    : touchOf(new URL(request.url), request.headers.get("referer"), request.headers.get("host"));
  let counted = Boolean(row.kind);
  let network = "";
  if (!row.kind && row.before) {
    // Counted already today, by the counter before this one.
    touch = await withinTouches(slug, day, touch);
    writes.push(person(touch));
    counted = true;
  } else if (!row.kind) {
    const pausedFor = `${row.owner}|${day}`;
    const people = Number(row.people ?? 0);
    let pause = paused.get(pausedFor);
    if (pause && pause.until <= at) pause = undefined;
    if (!pause) {
      // The plan is read only past the free plan's number.
      const cap = people < freePeople() ? freePeople() : (await peopleCap(row.owner, at)).cap;
      if (people >= cap) {
        pause = { until: at + PLAN_MEMORY, cap };
        paused.set(pausedFor, pause);
      }
    }
    network = networkOf(key, row.owner, request);
    const overNetwork = !pause && (networks.get(network) ?? 0) >= networkPeople();
    if (pause || overNetwork) {
      // Not counted: a view only (see below), and a mark on the app's day saying why.
      const mark = pause ? markOnce(slug, "capped", pause.cap, day) : markOnce(slug, "capped-net", networkPeople(), day);
      if (mark) writes.push(mark);
      network = "";
    } else {
      touch = await withinTouches(slug, day, touch);
      // The person's day total and the owner's count go up only while the person's row isn't there
      // yet, so two servers counting the same person at once count them once.
      const fresh = "NOT EXISTS (SELECT 1 FROM site_people WHERE site_slug = ? AND day = ? AND visitor = ?)";
      writes.push(
        {
          sql: `INSERT INTO site_events (site_slug, day, step, source, medium, campaign, n)
                SELECT slug, ?, 'visit', ?, ?, ?, 1 FROM sites WHERE slug = ? AND ${fresh}
                ON CONFLICT DO UPDATE SET n = n + 1`,
          args: [day, touch.source, touch.medium, touch.campaign, slug, slug, day, visitor],
        },
        {
          sql: `INSERT INTO owner_people (user_id, day, people) SELECT user_id, ?, 1 FROM sites WHERE slug = ? AND ${fresh}
                ON CONFLICT DO UPDATE SET people = people + 1`,
          args: [day, slug, slug, day, visitor],
        },
        person(touch),
      );
      counted = true;
    }
  }
  // The view, under the person's source. A view by someone who wasn't counted never opens a new
  // source for the day: it goes under one already there, or "(other)".
  writes.push(
    counted
      ? {
          sql: `INSERT INTO site_visits (site_slug, day, source, views) SELECT slug, ?, ?, 1 FROM sites WHERE slug = ?
                ON CONFLICT (site_slug, day, source) DO UPDATE SET views = views + 1`,
          args: [day, touch.source, slug],
        }
      : {
          sql: `INSERT INTO site_visits (site_slug, day, source, views)
                SELECT slug, ?, CASE WHEN ? = '' OR EXISTS (SELECT 1 FROM site_visits WHERE site_slug = ? AND day = ? AND source = ?) THEN ? ELSE ? END, 1
                FROM sites WHERE slug = ?
                ON CONFLICT (site_slug, day, source) DO UPDATE SET views = views + 1`,
          args: [day, touch.source, slug, day, touch.source, touch.source, OTHER.source, slug],
        },
  );
  await (await db()).batch(writes, "write");
  if (network) {
    networks.set(network, (networks.get(network) ?? 0) + 1);
    if (networks.size > MAX_NETWORKS) for (const old of [...networks.keys()].slice(0, MAX_NETWORKS / 2)) networks.delete(old);
  }
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
    if (visitTests.failPrune) throw new Error("prune failed (test)");
    await c.batch(
      [
        { sql: "DELETE FROM visit_keys WHERE day < ?", args: [yesterday] },
        { sql: "DELETE FROM site_people WHERE day < ?", args: [yesterday] },
        { sql: "DELETE FROM owner_people WHERE day < ?", args: [yesterday] },
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
