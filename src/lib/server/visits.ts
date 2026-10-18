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
import { clientAddress, clientIp } from "./limits.ts";
import { googleFetcher, isLighthouseAgent, mayBeLighthouseComputer } from "./lighthouse.ts";
import { isAdmin } from "./auth.ts";
import { activeSubscription } from "./subscriptions.ts";
import { OTHER, isReturnTrip, touchOf, visitSource, type Touch } from "../traffic.ts";
import { FREE_PEOPLE_PER_DAY, PLAN_PEOPLE } from "../plan-limits.ts";

export { visitSource };

export type Statement = { sql: string; args: InValue[] };

const DAY = 86_400_000;
const MINUTE = 60_000;
const DAYS_SHOWN = 30;
/** How many days of daily totals (views, people) are kept: today and the 99 before it. */
export const KEEP_DAYS = 100;
/** How many days a checkout's source waits beside it for its order (see funnel.ts). */
export const CHECKOUT_DAYS = 14;

// How many people are counted each UTC day across all of one owner's apps, by their plan.
export { FREE_PEOPLE_PER_DAY, PLAN_PEOPLE };
/**
 * New people each server counts per owner per day from one internet connection, so one stranger
 * can't use up the owner's day. An IPv6 connection is its /56, the block a home is usually given.
 */
export const NETWORK_PEOPLE = 100;
/** Sources (each with its medium and campaign) per app per day; past them, people count under "(other)". */
export const MAX_TOUCHES = 30;
/**
 * New sources each server lets one internet connection add to an app's day once the day has 20, so
 * one stranger can't fill its 30, while an office whose people come from a few places never meets it.
 */
export const NETWORK_SOURCES = 3;
const GUARDED_TOUCHES = 20;
// How long a server goes by what it read of an owner's plan, and by "paused for today".
const PLAN_MEMORY = 15 * MINUTE;
// Past this many connections in memory, the older half is forgotten.
const MAX_NETWORKS = 50_000;

/** What tests change (see test/visits.test.ts): smaller limits, and a prune that fails. Flash itself never does. */
export const visitTests = { freePeople: 0, networkPeople: 0, failPrune: false };
/** The free plan's number of people a day, which is also its number of app steps (see funnel.ts). */
export const freePeople = () => visitTests.freePeople || FREE_PEOPLE_PER_DAY;
/**
 * Below this many people (or app steps) today, counting goes by the free number without reading
 * the owner's plan: nine tenths of it, so loads counted at the same moment on a paid plan never
 * reach the free number with their plan unread.
 */
export const planFrom = () => freePeople() * 0.9;
const networkPeople = () => visitTests.networkPeople || NETWORK_PEOPLE;
// Crawlers, link previews, uptime checkers, browsers run by scripts, and AI assistants fetching a
// page for someone aren't people looking at it.
const ROBOT =
  /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|curl|wget|python|go-http|java\/|monitor|uptime|scan|whatsapp|inspectiontool|googleother|phantom|selenium|puppeteer|playwright|httpclient|okhttp|axios|node-fetch|undici|postman|(chatgpt|perplexity|claude|mistralai)-user|externalagent|fetcher|embedly|iframely|pingdom/i;

/** The UTC day of a time, like "2026-10-04". */
export const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
/** How many days from one day to another ("2026-10-01" to "2026-10-04" is 3). */
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

/** Whether a request comes from a robot (or sends no browser at all), by what it says it is. */
export function isRobot(request: Request): boolean {
  const agent = request.headers.get("user-agent") ?? "";
  // Robots, and Google's page speed test by its own agents (see lighthouse.ts), aren't people.
  return !agent || ROBOT.test(agent) || isLighthouseAgent(agent);
}

/**
 * Whether a page request is a person looking at the page, not a robot or a prefetch. Browsers, and
 * the web views inside apps, always say which languages their person reads; most scripts don't.
 * It must open the page in a tab or a frame: another website fetching it as an image, a script or
 * with fetch() would count its own visitors as the app's. Browsers too old to say how a page was
 * asked for still count.
 */
export function isPersonVisit(request: Request): boolean {
  if (isRobot(request) || !request.headers.get("accept-language")) return false;
  const purpose = request.headers.get("sec-purpose") ?? request.headers.get("purpose") ?? "";
  if (/prefetch|prerender/i.test(purpose)) return false;
  const mode = request.headers.get("sec-fetch-mode");
  const dest = request.headers.get("sec-fetch-dest");
  return (mode === null || mode === "navigate") && (dest === null || dest === "document" || dest === "iframe" || dest === "frame");
}

/*
 * What each server remembers, so most loads read nothing extra: the day's keys (today's and
 * yesterday's), the day counting began, whether it tried the daily prune today, owners' plans and
 * "paused for today" for 15 minutes, the marks it wrote today, and how many new people and app steps
 * it counted today per owner from each connection and how many new sources each connection added to
 * an app's day (under a code made with the day's key, never the address).
 */
const keys = new Map<string, Buffer>();
const noKey = new Map<string, number>();
let since: { day: string; value: string } | null = null;
let triedPrune = "";
const plans = new Map<string, { until: number; cap: number; paid: boolean }>();
const paused = new Map<string, { until: number; cap: number }>();
const marked = new Set<string>();
const networks = new Map<string, number>();
const opened = new Map<string, number>();
const stepped = new Map<string, number>();
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
  opened.clear();
  stepped.clear();
  memoryDay = "";
}

/** What this server keeps about connections, for tests to check it holds no address. */
export const networkMemory = () => [...networks.keys(), ...opened.keys(), ...stepped.keys()];

/** Today's marks and connection counts start empty each day. */
function startDay(day: string) {
  if (day === memoryDay) return;
  memoryDay = day;
  marked.clear();
  networks.clear();
  opened.clear();
  stepped.clear();
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
    // Today's can still be made by the next visit, so only an earlier day's absence is remembered.
    if (day < dayOf(at)) noKey.set(day, at + 60_000);
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

/**
 * The owner's own visit to their app on one day, so they aren't counted again and their steps that
 * day don't count, also when the same browser was counted as a visitor earlier that day (on their
 * own domain, where Flash's sign-in cookie isn't sent).
 */
const ownerRow = (slug: string, day: string, visitor: string): Statement => ({
  sql: `INSERT INTO site_people (site_slug, day, visitor, kind) SELECT slug, ?, ?, 'owner' FROM sites WHERE slug = ?
        ON CONFLICT (site_slug, day, visitor) DO UPDATE SET kind = 'owner' WHERE kind <> 'owner'`,
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
export function markOnce(slug: string, step: string, limit: number, day: string): Statement | null {
  const key = `${slug}|${step}|${day}`;
  if (marked.has(key)) return null;
  marked.add(key);
  return {
    sql: `INSERT INTO site_events (site_slug, day, step, source, medium, campaign, n) SELECT slug, ?, ?, '', '', '', ? FROM sites WHERE slug = ?
          ON CONFLICT DO UPDATE SET n = MAX(n, excluded.n)`,
    args: [day, step, limit, slug],
  };
}

/**
 * The touch, or "(other)" when it would be new to the app's day and the app has its 30 sources for
 * the day, or it has 20 and the person's connection (network, when given) already added 3 of them.
 */
async function withinTouches(slug: string, day: string, touch: Touch, network = ""): Promise<Touch> {
  const s = await one<{ touches: number; known: number }>(
    `SELECT COUNT(*) AS touches, COALESCE(MAX(source = ? AND medium = ? AND campaign = ?), 0) AS known
     FROM site_events WHERE site_slug = ? AND day = ? AND step = 'visit'`,
    [touch.source, touch.medium, touch.campaign, slug, day],
  );
  if (Number(s?.known)) return touch;
  if (Number(s?.touches ?? 0) >= MAX_TOUCHES) return OTHER;
  if (network) {
    // Read and added with nothing waiting in between, so loads answered at once can't all add one.
    const key = `${network}|${slug}`;
    const added = opened.get(key) ?? 0;
    if (added >= NETWORK_SOURCES && Number(s?.touches ?? 0) >= GUARDED_TOUCHES) return OTHER;
    opened.set(key, added + 1);
    if (opened.size > MAX_NETWORKS) for (const old of [...opened.keys()].slice(0, MAX_NETWORKS / 2)) opened.delete(old);
  }
  return touch;
}

/** One internet connection: an IPv4 address, or the /56 an IPv6 address is in (clientIp gives its /64). */
export const connectionOf = (request: Request): string => {
  const ip = clientIp(request);
  const v6 = ip.match(/^([0-9a-f]+:[0-9a-f]+:[0-9a-f]+):([0-9a-f]+)::\/64$/);
  return v6 ? `${v6[1]}:${v6[2].padStart(4, "0").slice(0, 2)}00::/56` : ip;
};

/** The code this server counts an owner's new people from one connection under, made with the day's key. */
const networkOf = (key: Buffer, owner: string, request: Request) =>
  createHmac("sha256", key).update(`network|${owner}|${connectionOf(request)}`).digest("hex").slice(0, 24);

/** The code this server counts app steps from one connection under (see takeSteps), made with a day's key. */
export const stepsNetworkOf = (key: Buffer, request: Request) =>
  createHmac("sha256", key).update(`steps|${connectionOf(request)}`).digest("hex").slice(0, 24);

/**
 * Takes up to `wanted` of the app steps this server counts per owner per day from one connection,
 * as many as its new people (NETWORK_PEOPLE), so a stranger with a few connections can't use up the
 * owner's day of app steps either. Taken with nothing waiting since it was read; returns how many.
 */
export function takeSteps(owner: string, network: string, wanted: number, at: number): number {
  startDay(dayOf(at));
  const key = `${network}|${owner}`;
  const used = stepped.get(key) ?? 0;
  const n = Math.max(0, Math.min(wanted, networkPeople() - used));
  if (!n) return 0;
  stepped.set(key, used + n);
  if (stepped.size > MAX_NETWORKS) for (const old of [...stepped.keys()].slice(0, MAX_NETWORKS / 2)) stepped.delete(old);
  return n;
}

/** Gives back app steps taken with takeSteps that weren't counted. */
export function giveSteps(owner: string, network: string, n: number): void {
  const key = `${network}|${owner}`;
  if (n && stepped.has(key)) stepped.set(key, Math.max(0, stepped.get(key)! - n));
}

/**
 * Counts one load of a published app: a view, and the person once a day, under where they first
 * came from that day. viewerId is who is signed in to Flash, on /p/ only. Never throws: stats must
 * not break an app.
 */
export async function recordVisit(slug: string, request: Request, viewerId?: string | null, at = Date.now()): Promise<void> {
  if (!isPersonVisit(request) || isReturnTrip(new URL(request.url), request.headers.get("referer"))) return;
  // Nor is Google's page speed test of the app a visitor: its computer looks like any Mac's Chrome,
  // so only from Google's own addresses (see lighthouse.ts). It's never signed in to Flash, so
  // someone who is (the owner above all, see countVisit) is a person.
  const agent = request.headers.get("user-agent") ?? "";
  if (!viewerId && mayBeLighthouseComputer(agent) && (await googleFetcher(clientAddress(request)).catch(() => false))) return;
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
  // Someone counted already today keeps the source they first came from.
  let touch: Touch = row.kind
    ? { source: row.source ?? "", medium: row.medium ?? "", campaign: row.campaign ?? "" }
    : touchOf(new URL(request.url), request.headers.get("referer"), request.headers.get("host"));
  let counted = Boolean(row.kind);
  let network = "";
  try {
    if (!row.kind && row.before) {
      // Counted already today, by the counter before this one, so in no source: their views go under
      // this source, but their forms, sign-ups and checkouts count as not matched (see matchVisit).
      touch = await withinTouches(slug, day, touch);
      writes.push({
        sql: "INSERT OR IGNORE INTO site_people (site_slug, day, visitor, kind, source, medium, campaign) SELECT slug, ?, ?, 'before', ?, ?, ? FROM sites WHERE slug = ?",
        args: [day, visitor, touch.source, touch.medium, touch.campaign, slug],
      });
      counted = true;
    } else if (!row.kind) {
      const pausedFor = `${row.owner}|${day}`;
      const people = Number(row.people ?? 0);
      let pause = paused.get(pausedFor);
      if (pause && pause.until <= at) pause = undefined;
      let cap = 0;
      if (!pause) {
        cap = people < planFrom() ? freePeople() : (await peopleCap(row.owner, at)).cap;
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
        // Taken with nothing waiting since it was read, so loads this server answers at once can't
        // all pass it; given back if nothing is written.
        networks.set(network, (networks.get(network) ?? 0) + 1);
        if (networks.size > MAX_NETWORKS) for (const old of [...networks.keys()].slice(0, MAX_NETWORKS / 2)) networks.delete(old);
        touch = await withinTouches(slug, day, touch, network);
        // One transaction, in this order. The owner's count goes up for a person not counted yet
        // today (so two servers counting the same person at once count them once). Then the person
        // and their day total are written only while that count is within the owner's number, so
        // loads counted at the same moment, on any server, stop exactly there. One past it still
        // added to the owner's count, which only keeps counting paused.
        const fresh = "NOT EXISTS (SELECT 1 FROM site_people WHERE site_slug = ? AND day = ? AND visitor = ?)";
        const within = "(SELECT people FROM owner_people WHERE user_id = sites.user_id AND day = ?) <= ?";
        writes.push(
          {
            sql: `INSERT INTO owner_people (user_id, day, people) SELECT user_id, ?, 1 FROM sites WHERE slug = ? AND ${fresh}
                  ON CONFLICT DO UPDATE SET people = people + 1`,
            args: [day, slug, slug, day, visitor],
          },
          {
            sql: `INSERT INTO site_events (site_slug, day, step, source, medium, campaign, n)
                  SELECT slug, ?, 'visit', ?, ?, ?, 1 FROM sites WHERE slug = ? AND ${fresh} AND ${within}
                  ON CONFLICT DO UPDATE SET n = n + 1`,
            args: [day, touch.source, touch.medium, touch.campaign, slug, slug, day, visitor, day, cap],
          },
          {
            sql: `INSERT OR IGNORE INTO site_people (site_slug, day, visitor, kind, source, medium, campaign)
                  SELECT slug, ?, ?, 'visit', ?, ?, ? FROM sites WHERE slug = ? AND ${within}`,
            args: [day, visitor, touch.source, touch.medium, touch.campaign, slug, day, cap],
          },
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
  } catch (err) {
    // Nobody was counted, so the connection's place is given back.
    if (network && networks.has(network)) networks.set(network, Math.max(0, networks.get(network)! - 1));
    throw err;
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
        { sql: "DELETE FROM site_step_names WHERE day < ?", args: [yesterday] },
        { sql: "DELETE FROM site_visits WHERE day < ?", args: [kept] },
        { sql: "DELETE FROM site_events WHERE day < ?", args: [kept] },
        { sql: "DELETE FROM site_revenue WHERE day < ?", args: [kept] },
        // A checkout's source waits for its order at most 14 days, as a voucher or a bank debit can be
        // paid days later (see funnel.ts).
        { sql: "DELETE FROM site_checkouts WHERE created_at < ?", args: [at - CHECKOUT_DAYS * DAY] },
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
