/*
 * The steps from a visit to a sale (see the Visitors view in My websites & apps): sending a form,
 * signing up, starting a checkout, and the steps an app reports with flashDB.track. Each is counted
 * once a day per person, for someone matched to the visit their browser made to the app that day or
 * the day before (see visits.ts), under where that visit came from. What is kept are daily totals
 * (site_events), never who took a step, though on a quiet day or range a source's 1 form, sign-up
 * or order can point at the contact, member or order behind it (the privacy page says so). Paid
 * orders go into daily totals per source and currency (site_revenue); while a checkout is open,
 * its buyer's source waits beside it (site_checkouts), with nothing about the buyer.
 */
import { createHmac } from "node:crypto";
import { all, db, now, one, run } from "./db.ts";
import { domainsForSite } from "./domains.ts";
import { countOf, fitsWithin, takeAfter } from "./limits.ts";
import {
  dayOf,
  daysBetween,
  freePeople,
  freeSteps,
  funnelSince,
  giveSteps,
  isRobot,
  markOnce,
  pastKey,
  peopleCap,
  peoplePerDay,
  stepsNetworkOf,
  takeSteps,
  unmark,
  visitorCode,
  type Statement,
} from "./visits.ts";
import { MAX_STEP_NAMES, MAX_TRACKED, OTHER, UNMATCHED, type Touch } from "../traffic.ts";
import { SITE_URL } from "../../app/site.ts";

const DAY = 86_400_000;
const MINUTE = 60_000;

/**
 * The track route's rate limit on the free plan: app steps counted a minute from one internet
 * connection to an app (under a code made with the day's key for that app, never its address, so
 * nothing ties one connection's use of two apps together) and to an app from everyone. Steps, not
 * requests, as one request can carry 10 of them. Both are read first, for how many fit, and taken in
 * the transaction that writes the person's list of steps, only while they still fit (see count): a
 * request turned away, also by requests at the same moment, or one that loses the race for the list
 * to another of the same person's (the same step sent twice at once, on any server), writes nothing,
 * and the counts never pass the limits. Taken only for steps that count: two rows for each request
 * whose steps count, so at most for each of the free plan's 100 app steps a day. Paid plans' apps
 * aren't limited: their daily numbers stay as they are, and counting it would add those rows to each
 * of their requests.
 * The daily prune deletes them (see visits.ts).
 */
export const TRACK_STEPS_PER_CONNECTION = 10;
export const TRACK_STEPS_PER_APP = 30;

const trackLimits = (slug: string, network: string): [string, number][] => {
  const code = createHmac("sha256", network).update(`track|${slug}`).digest("hex").slice(0, 24);
  return [
    [`track-app:${slug}`, TRACK_STEPS_PER_APP],
    [`track-net:${slug}:${code}`, TRACK_STEPS_PER_CONNECTION],
  ];
};

/**
 * How many of `wanted` app steps fit under the track route's rate limit, read before anything is
 * written; the list of the person's steps takes them only while they still fit (see count). Never
 * throws: a limit not read counts none.
 */
async function trackRoom(limits: [string, number][], wanted: number): Promise<number> {
  try {
    const counts = await Promise.all(limits.map(([key]) => countOf(key)));
    return Math.max(0, Math.min(wanted, ...limits.map(([, max], i) => max - counts[i])));
  } catch (err) {
    console.error("[flash] track limit not read", err);
    return 0;
  }
}

/** A step Flash counts: a form sent, a sign-up, a checkout started, or one the app reported ("app:<name>"). */
export type Step = "form" | "signup" | "checkout" | `app:${string}`;
/**
 * Whose browser took a step: a person who visited the app that day or the day before (network is
 * their connection's code, for its app steps, see takeSteps), its owner's address and browser that
 * day, nobody Flash counted, or a robot (whose steps count nowhere, not even as not matched).
 */
export type Match =
  | { kind: "visit"; day: string; visitor: string; touch: Touch; steps: string[]; network: string }
  | { kind: "owner" }
  | { kind: "none" }
  | { kind: "robot" };

/** Where a matched person came from; null for the owner and for anyone Flash couldn't match. */
export const touchFor = (m: Match): Touch | null => (m.kind === "visit" ? m.touch : null);

const steps = (text: unknown): string[] => {
  try {
    const list = JSON.parse(String(text ?? "[]"));
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
};

/**
 * The visit this request's browser made to the app today, or else yesterday (so a form sent just
 * after midnight still finds its visit). The code is made from the request's address and browser
 * with that day's key, so the page itself can't claim a source. Reads only, and never throws.
 */
export async function matchVisit(slug: string, request: Request, at = Date.now()): Promise<Match> {
  if (isRobot(request)) return { kind: "robot" };
  try {
    const today = dayOf(at);
    const yesterday = dayOf(at - DAY);
    // A day no visit made a key for has no codes to match, so none is made here.
    const [todayKey, yesterdayKey] = await Promise.all([pastKey(today, at), pastKey(yesterday, at)]);
    const codes: [string, string][] = [];
    if (todayKey) codes.push([today, await visitorCode(slug, request, today, todayKey)]);
    if (yesterdayKey) codes.push([yesterday, await visitorCode(slug, request, yesterday, yesterdayKey)]);
    if (!codes.length) return { kind: "none" };
    const rows = (
      await (
        await db()
      ).execute({
        sql: `SELECT day, visitor, kind, source, medium, campaign, steps FROM site_people
              WHERE site_slug = ? AND (${codes.map(() => "(day = ? AND visitor = ?)").join(" OR ")})`,
        args: [slug, ...codes.flat()],
      })
    ).rows as unknown as { day: string; visitor: string; kind: string; source: string; medium: string; campaign: string; steps: string }[];
    // Today's visit wins.
    const row = rows.find((r) => r.day === today) ?? rows[0];
    if (!row) return { kind: "none" };
    if (row.kind === "owner") return { kind: "owner" };
    // Counted by the counter before this one, on the day it was replaced: in no source.
    if (row.kind === "before") return { kind: "none" };
    return {
      kind: "visit",
      day: String(row.day),
      visitor: String(row.visitor),
      touch: { source: String(row.source ?? ""), medium: String(row.medium ?? ""), campaign: String(row.campaign ?? "") },
      steps: steps(row.steps),
      network: stepsNetworkOf((todayKey ?? yesterdayKey)!, request),
    };
  } catch (err) {
    console.error("[flash] visit not matched", err);
    return { kind: "none" };
  }
}

/** One more for a step on a day, under a source. */
const countUp = (slug: string, day: string, step: string, t: Touch): Statement => ({
  sql: `INSERT INTO site_events (site_slug, day, step, source, medium, campaign, n) SELECT slug, ?, ?, ?, ?, ?, 1 FROM sites WHERE slug = ?
        ON CONFLICT DO UPDATE SET n = n + 1`,
  args: [day, step, t.source, t.medium, t.campaign, slug],
});

/**
 * Counts steps for the person a request was matched to, each once a day (a step just after midnight
 * matched to yesterday's visit counts on yesterday). A form, sign-up or checkout from someone Flash
 * couldn't match counts under "not matched", per send; an app's own step from them doesn't count.
 * So do those from the owner's address and browser that day: the owner's own, as their test orders
 * are not matched too, or someone's on the same Wi-Fi with the same browser, whose sends are never
 * lost. Never under a source. Never throws: stats must not break a form, a sign-up or a sale.
 * rateLimit is the track route's, for app steps on the free plan (see trackRoom).
 */
export async function countSteps(slug: string, match: Match, list: Step[], at = Date.now(), opts: { rateLimit?: boolean } = {}): Promise<void> {
  try {
    await count(slug, match, list, at, true, Boolean(opts.rateLimit));
  } catch (err) {
    console.error("[flash] steps not counted", err);
  }
}

async function count(slug: string, match: Match, list: Step[], at: number, retry: boolean, rateLimit: boolean): Promise<void> {
  if (match.kind === "robot") return;
  const today = dayOf(at);
  if (match.kind === "none" || match.kind === "owner") {
    const builtIn = [...new Set(list.filter((s) => !s.startsWith("app:")))];
    if (builtIn.length) await (await db()).batch(builtIn.map((s) => countUp(slug, today, s, { source: UNMATCHED, medium: "", campaign: "" })), "write");
    return;
  }
  // The person's list of steps for the day, each step once. A form, a sign-up and a checkout always
  // go on it; of the app's own names, only those counted, at most 15.
  const wanted = [...new Set(list)].filter((s) => !match.steps.includes(s));
  const tried = match.steps.filter((s) => s.startsWith("app:")).length;
  const builtIn = wanted.filter((s) => !s.startsWith("app:"));
  let app = tried < MAX_TRACKED ? wanted.filter((s) => s.startsWith("app:")).map((s) => s.slice(4)) : [];
  const writes: Statement[] = [];
  const counting: { name: string; isNew: boolean }[] = [];
  let budget = 0;
  let owner = "";
  let paid = false;
  let limits: [string, number][] = [];
  let marking = false;
  if (app.length) {
    // The gates, read before anything is written, so a name that isn't counted writes nothing: the
    // names in the app's code (see stepsInHtml), the names it reported that day (at most 10), and how
    // many app steps the owner's apps counted today, against their plan's daily number.
    const gate = await one<{ allowed: string; names: string; used: number | null; owner: string }>(
      `SELECT s.step_names AS allowed, (SELECT json_group_array(name) FROM site_step_names WHERE site_slug = ? AND day = ?) AS names,
              o.steps AS used, s.user_id AS owner
       FROM sites s LEFT JOIN owner_people o ON o.user_id = s.user_id AND o.day = ? WHERE s.slug = ?`,
      [slug, match.day, today, slug],
    );
    if (!gate) return;
    owner = gate.owner;
    // A name the app's code doesn't have isn't counted, so nobody can fill the app's day with others.
    const allowed = steps(gate.allowed || "[]");
    app = app.filter((name) => allowed.includes(name)).slice(0, MAX_TRACKED - tried);
    const names = steps(gate.names);
    const used = Number(gate.used ?? 0);
    // Always by the owner's plan (read at most every 15 minutes per server): the free plan's app steps,
    // a tenth of its people, leave too little room to count by the free number until near it.
    const plan = app.length ? await peopleCap(gate.owner, at) : { steps: freeSteps(), paid: false };
    budget = plan.steps;
    paid = plan.paid;
    let room = Math.max(0, budget - used);
    let known = names.length;
    let full = false;
    for (const name of app) {
      const isNew = !names.includes(name);
      // An 11th name of the day isn't counted.
      if (isNew && known >= MAX_STEP_NAMES) continue;
      if (!room) {
        full = true;
        break;
      }
      if (isNew) known++;
      counting.push({ name, isNew });
      room--;
    }
    // Past what this server counts from the person's connection today, the rest aren't counted.
    counting.splice(takeSteps(owner, match.network, counting.length, at, paid));
    // Nor, on the free plan, those past the track route's rate limit this minute.
    if (counting.length && rateLimit && !paid) {
      limits = trackLimits(slug, match.network);
      const room = await trackRoom(limits, counting.length);
      giveSteps(owner, match.network, counting.length - room);
      counting.splice(room);
    }
    // The note that the day's app steps stopped counting, only when these reach the day's number (not
    // when the limits above cut them short of it).
    if (full && used + counting.length >= budget) {
      const mark = markOnce(slug, "capped-app", budget, today);
      if (mark) writes.push(mark);
      marking = Boolean(mark);
    }
  }
  // This server's one note for the day, given back when this request doesn't write it, so the next
  // request past the day's number does (this one's retry, or another's).
  const giveMarkBack = () => {
    if (marking) unmark(slug, "capped-app", today);
  };
  const taken = counting.length;
  const fresh = [...builtIn, ...counting.map((x) => `app:${x.name}`)];
  const c = await db();
  if (!fresh.length) {
    if (writes.length)
      await c.batch(writes, "write").catch((err) => {
        giveMarkBack();
        throw err;
      });
    return;
  }
  // What the connection's place was taken for is given back when it isn't counted, and so is the note.
  const orGiveBack = <R>(done: Promise<R>) =>
    done.catch((err) => {
      giveSteps(owner, match.network, taken);
      giveMarkBack();
      throw err;
    });
  // Written only if nobody changed the list since it was read, so two requests can't count one step
  // twice; under the rate limit, only while its steps still fit, which are taken in the same
  // transaction. So a request that loses the race, or is turned away at the same moment, takes and
  // writes nothing, and tries once more with the list and the limit read again.
  const t = now();
  const fit = taken ? limits.map(([key, max]) => fitsWithin(key, max, taken, t)) : [];
  const [saved] = await orGiveBack(
    c.batch(
      [
        {
          sql: `UPDATE site_people SET steps = ? WHERE site_slug = ? AND day = ? AND visitor = ? AND steps = ?${fit.map((f) => ` AND ${f.sql}`).join("")} RETURNING 1`,
          args: [JSON.stringify([...match.steps, ...fresh]), slug, match.day, match.visitor, JSON.stringify(match.steps), ...fit.flatMap((f) => f.args)],
        },
        ...(fit.length ? [takeAfter(limits.map(([key]) => key), taken, MINUTE, t)] : []),
      ],
      "write",
    ),
  );
  if (!saved.rows.length) {
    giveSteps(owner, match.network, taken);
    giveMarkBack();
    const again = retry ? await matchByCode(slug, match) : null;
    if (again) await count(slug, again, list, at, false, rateLimit);
    return;
  }
  for (const s of builtIn) writes.push(countUp(slug, match.day, s, match.touch));
  if (counting.length) {
    // One transaction, in this order: the owner's count goes up by all of them, then the k-th is
    // counted only while the count before it plus k is within the budget, so requests counted at
    // the same moment, on any server, stop exactly there.
    const k = counting.length;
    writes.push({
      sql: `INSERT INTO owner_people (user_id, day, steps) SELECT user_id, ?, ? FROM sites WHERE slug = ?
            ON CONFLICT DO UPDATE SET steps = steps + excluded.steps`,
      args: [today, k, slug],
    });
    counting.forEach(({ name, isNew }, i) => {
      if (isNew) {
        writes.push({
          sql: `INSERT INTO site_step_names (site_slug, day, name) SELECT slug, ?, ? FROM sites WHERE slug = ?
                AND (SELECT COUNT(*) FROM site_step_names WHERE site_slug = ? AND day = ?) < ${MAX_STEP_NAMES}
                ON CONFLICT DO NOTHING`,
          args: [match.day, name, slug, slug, match.day],
        });
      }
      // Counted without a source, and only while the name is among the day's (it may have lost the
      // race for the 10th place).
      writes.push({
        sql: `INSERT INTO site_events (site_slug, day, step, source, medium, campaign, n) SELECT slug, ?, ?, '', '', '', 1 FROM sites WHERE slug = ?
              AND EXISTS (SELECT 1 FROM site_step_names WHERE site_slug = ? AND day = ? AND name = ?)
              AND (SELECT steps FROM owner_people WHERE user_id = sites.user_id AND day = ?) - ? <= ?
              ON CONFLICT DO UPDATE SET n = n + 1`,
        args: [match.day, `app:${name}`, slug, slug, match.day, name, today, k - i - 1, budget],
      });
    });
  }
  if (writes.length) await orGiveBack(c.batch(writes, "write"));
}

/** The same person's row read again, after another request changed their list of steps. */
async function matchByCode(slug: string, m: Extract<Match, { kind: "visit" }>): Promise<Match | null> {
  const row = await one<{ steps: string }>("SELECT steps FROM site_people WHERE site_slug = ? AND day = ? AND visitor = ? AND kind = 'visit'", [
    slug,
    m.day,
    m.visitor,
  ]);
  return row ? { ...m, steps: steps(row.steps) } : null;
}

/**
 * Keeps where a checkout's buyer came from beside its Stripe session, until its order is saved (see
 * saleBySource) or 14 days pass, as a voucher or a bank debit can be paid days later. Nothing about
 * the buyer is kept, and nothing goes to Stripe. The owner's own checkouts, and those Flash couldn't
 * match, keep nothing: their orders show as not matched. Never throws.
 */
export async function saveCheckoutTouch(slug: string, sessionId: string, match: Match, at = Date.now()): Promise<void> {
  const touch = touchFor(match);
  if (!sessionId || !touch) return;
  try {
    await run(
      `INSERT OR IGNORE INTO site_checkouts (session_id, site_slug, source, medium, campaign, created_at)
       SELECT ?, slug, ?, ?, ?, ? FROM sites WHERE slug = ?`,
      [sessionId, touch.source, touch.medium, touch.campaign, at, slug],
    );
  } catch (err) {
    console.error("[flash] checkout source not kept", err);
  }
}

/**
 * Adds a new paid order to its day's total under its buyer's source and currency, and forgets the
 * checkout's source. An order with no checkout source adds nothing here: it shows as not matched.
 */
export async function saleBySource(slug: string, sessionId: string, at: number, currency: string, amount: number): Promise<void> {
  await (
    await db()
  ).batch(
    [
      {
        sql: `INSERT INTO site_revenue (site_slug, day, source, medium, campaign, currency, orders, amount)
              SELECT ?, ?, c.source, c.medium, c.campaign, ?, 1, ? FROM site_checkouts c WHERE c.session_id = ? AND c.site_slug = ?
              ON CONFLICT (site_slug, day, source, medium, campaign, currency) DO UPDATE SET orders = orders + 1, amount = amount + excluded.amount`,
        args: [slug, dayOf(at), currency, amount, sessionId, slug],
      },
      { sql: "DELETE FROM site_checkouts WHERE session_id = ?", args: [sessionId] },
    ],
    "write",
  );
}

/** Whether a checkout of the app still waits for its order, so the funnel fetches its orders from Stripe first (see the funnel route). */
export async function checkoutWaiting(slug: string): Promise<boolean> {
  return Boolean(await one("SELECT 1 FROM site_checkouts WHERE site_slug = ? LIMIT 1", [slug]));
}

/** The ranges the funnel shows, in days; any other asks for 30. */
export const FUNNEL_RANGES = [7, 30, 90] as const;
export type FunnelRange = (typeof FUNNEL_RANGES)[number];
export const funnelRange = (days: unknown): FunnelRange => FUNNEL_RANGES.find((d) => String(d) === String(days)) ?? 30;
/** Calls to the funnel an owner may make an hour: a 90-day funnel of a full app reads about 40,000 rows. */
export const FUNNEL_CALLS = 120;
export const funnelTests = { calls: 0 };
export const funnelCalls = () => funnelTests.calls || FUNNEL_CALLS;
/**
 * Sources sent by name (the view shows the first 10 until asked for more), and campaigns per source;
 * past them, the others are added up as one row, so a link with only a few visitors still shows.
 */
const TOP_SOURCES = 100;
const TOP_CAMPAIGNS = 30;

export type Money = { currency: string; amount: number };
export type FunnelCounts = { visitors: number; form: number; signup: number; checkout: number; orders: number; revenue: Money[] };
export type FunnelSource = FunnelCounts & {
  source: string;
  campaigns: (FunnelCounts & { medium: string; campaign: string })[];
  /** The source's other campaigns added up, past its 30 busiest; null when there are none. */
  otherCampaigns: FunnelCounts | null;
};
export type FunnelStats = {
  days: FunnelRange;
  /** Today (UTC), the first day shown, and how many days that is. */
  today: string;
  from: string;
  shownDays: number;
  /** Visitors as the Visitors tile counts them; form, signup and checkout people matched to a visit; every paid order. */
  totals: FunnelCounts;
  /** The 100 sources with the most visitors ('' is Direct), busiest first, with their campaigns. */
  sources: FunnelSource[];
  /** The other sources added up, "(other)" among them; null when there are none. */
  rest: FunnelCounts | null;
  /** Sends Flash couldn't tie to a visit, and paid orders no source covers: sends and orders, never people. */
  unmatched: Omit<FunnelCounts, "visitors">;
  /** The steps the app reported, the 10 with the most people. */
  appSteps: { step: string; people: number }[];
  /** Days this app missed people at the owner's daily limit, newest first, and the limit today when it is reached now. */
  paused: { day: string; people: number }[];
  pausedToday: number | null;
  /** The same for the apps' own steps. */
  stepsPaused: { day: string; steps: number }[];
  stepsPausedToday: number | null;
  /** How many new people are counted from one connection a day, when some day in the range passed it; else null. */
  netCapped: number | null;
  /** The owner has no paid plan (known when counting is paused today, or pausedWeek is given). */
  free: boolean;
  /**
   * On the free plan, when counting paused at its daily number of people on 2 or more of the last 7
   * days (today among them) across the owner's apps: on how many, and that number, for the view's
   * upgrade offer. Null otherwise, and always on a paid plan.
   */
  pausedWeek: { days: number; people: number } | null;
  /** The app's addresses, for tagged links. */
  addresses: string[];
  /** Nothing at all in the app's longest range (90 days, or since counting began): no visitor, step or order. */
  empty: boolean;
};

const MARKS = ["capped", "capped-app", "capped-net"];
/** Days of the last 7 with counting paused, from which a free owner is offered an upgrade. */
export const PAUSED_DAYS_OFFER = 2;
const zero = (): FunnelCounts => ({ visitors: 0, form: 0, signup: 0, checkout: 0, orders: 0, revenue: [] });
const addMoney = (list: Money[], currency: string, amount: number) => {
  const known = list.find((m) => m.currency === currency);
  if (known) known.amount += amount;
  else list.push({ currency, amount });
};
const addCounts = (to: FunnelCounts, from: FunnelCounts) => {
  to.visitors += from.visitors;
  to.form += from.form;
  to.signup += from.signup;
  to.checkout += from.checkout;
  to.orders += from.orders;
  for (const m of from.revenue) addMoney(to.revenue, m.currency, m.amount);
};
const byMoney = (list: Money[]) => list.sort((a, b) => b.amount - a.amount || a.currency.localeCompare(b.currency));
const busier = (a: FunnelCounts, b: FunnelCounts) =>
  b.visitors - a.visitors || b.orders - a.orders || b.form + b.signup + b.checkout - (a.form + a.signup + a.checkout);

/**
 * The app's funnel for the last 7, 30 or 90 days, starting no earlier than the day counting began
 * (settings.funnel_since) or the app's creation day: visitors, each step, paid orders and what was
 * paid, per source. Null when the app isn't there.
 */
export async function funnelStats(slug: string, days: FunnelRange, at = Date.now()): Promise<FunnelStats | null> {
  const site = await one<{ owner: string; created_at: number }>("SELECT user_id AS owner, created_at FROM sites WHERE slug = ?", [slug]);
  if (!site) return null;
  const today = dayOf(at);
  const began = [await funnelSince(today), dayOf(Number(site.created_at))].reduce((a, b) => (b > a ? b : a));
  // The first day shown of a range: never before counting began or the app was made, nor after today.
  const firstOf = (range: number) => [dayOf(at - (range - 1) * DAY), began, today].sort()[1];
  const first = firstOf(days);
  const longest = firstOf(Math.max(...FUNNEL_RANGES));
  const shownDays = daysBetween(first, today) + 1;
  const people = await peoplePerDay(slug, first);
  const week = Array.from({ length: 7 }, (_, i) => dayOf(at - i * DAY));
  const [events, revenue, paid, owner, domains, any, pausedDays] = await Promise.all([
    // Marks stay per day; everything else is added up over the range.
    all<{ on_day: string; step: string; source: string; medium: string; campaign: string; n: number }>(
      `SELECT CASE WHEN step IN (${MARKS.map(() => "?").join(", ")}) THEN day ELSE '' END AS on_day, step, source, medium, campaign, SUM(n) AS n
       FROM site_events WHERE site_slug = ? AND day >= ? AND step <> 'visit-old'
       GROUP BY 1, step, source, medium, campaign`,
      [...MARKS, slug, first],
    ),
    all<{ source: string; medium: string; campaign: string; currency: string; orders: number; amount: number }>(
      `SELECT source, medium, campaign, currency, SUM(orders) AS orders, SUM(amount) AS amount FROM site_revenue
       WHERE site_slug = ? AND day >= ? GROUP BY source, medium, campaign, currency`,
      [slug, first],
    ),
    all<{ currency: string; orders: number; amount: number }>(
      "SELECT currency, COUNT(*) AS orders, SUM(amount) AS amount FROM site_orders WHERE site_slug = ? AND created_at >= ? GROUP BY currency",
      [slug, Date.parse(`${first}T00:00:00Z`)],
    ),
    one<{ people: number; steps: number }>("SELECT people, steps FROM owner_people WHERE user_id = ? AND day = ?", [site.owner, today]),
    domainsForSite(slug),
    // Whether the longest range holds anything, so the view knows a shorter one isn't all there is.
    one<{ any: number }>(
      `SELECT EXISTS (SELECT 1 FROM site_events WHERE site_slug = ? AND day >= ? AND step NOT IN (${MARKS.map(() => "?").join(", ")}))
           OR EXISTS (SELECT 1 FROM site_visitors WHERE site_slug = ? AND day >= ?)
           OR EXISTS (SELECT 1 FROM site_orders WHERE site_slug = ? AND created_at >= ?) AS any`,
      [slug, longest, ...MARKS, slug, longest, slug, Date.parse(`${longest}T00:00:00Z`)],
    ),
    // Days of the last 7 on which counting paused across the owner's apps: a mark on any of them at the
    // free number or more. One look-up by key per app and day.
    one<{ n: number }>(
      `SELECT COUNT(DISTINCT e.day) AS n FROM sites s JOIN site_events e
         ON e.site_slug = s.slug AND e.day IN (${week.map(() => "?").join(", ")}) AND e.step = 'capped' AND e.source = '' AND e.medium = '' AND e.campaign = ''
       WHERE s.user_id = ? AND e.n >= ?`,
      [...week, site.owner, freePeople()],
    ),
  ]);

  const totals = zero();
  totals.visitors = [...people.values()].reduce((n, v) => n + v, 0);
  const unmatched = zero();
  const sources = new Map<string, FunnelSource>();
  const sourceOf = (source: string) => {
    let s = sources.get(source);
    if (!s) sources.set(source, (s = { ...zero(), source, campaigns: [], otherCampaigns: null }));
    return s;
  };
  const campaignOf = (s: FunnelSource, medium: string, campaign: string) => {
    let c = s.campaigns.find((x) => x.medium === medium && x.campaign === campaign);
    if (!c) s.campaigns.push((c = { ...zero(), medium, campaign }));
    return c;
  };
  const appSteps = new Map<string, number>();
  const paused: FunnelStats["paused"] = [];
  const stepsPaused: FunnelStats["stepsPaused"] = [];
  let netCapped: number | null = null;
  for (const e of events) {
    const n = Number(e.n);
    if (e.step === "capped") paused.push({ day: e.on_day, people: n });
    else if (e.step === "capped-app") stepsPaused.push({ day: e.on_day, steps: n });
    else if (e.step === "capped-net") netCapped = Math.max(netCapped ?? 0, n);
    else if (e.step.startsWith("app:")) appSteps.set(e.step.slice(4), (appSteps.get(e.step.slice(4)) ?? 0) + n);
    else if (e.step === "visit" || e.step === "form" || e.step === "signup" || e.step === "checkout") {
      const key = e.step === "visit" ? "visitors" : e.step;
      if (e.source === UNMATCHED) {
        if (key !== "visitors") unmatched[key] += n;
        continue;
      }
      // Steps of matched people only (sends Flash couldn't match are sends, not people).
      if (key !== "visitors") totals[key] += n;
      const s = sourceOf(e.source);
      s[key] += n;
      if (e.medium || e.campaign) campaignOf(s, e.medium, e.campaign)[key] += n;
    }
  }
  const attributed = new Map<string, Money & { orders: number }>();
  for (const r of revenue) {
    const [orders, amount] = [Number(r.orders), Number(r.amount)];
    const s = sourceOf(r.source);
    s.orders += orders;
    addMoney(s.revenue, r.currency, amount);
    if (r.medium || r.campaign) {
      const c = campaignOf(s, r.medium, r.campaign);
      c.orders += orders;
      addMoney(c.revenue, r.currency, amount);
    }
    const a = attributed.get(r.currency) ?? { currency: r.currency, amount: 0, orders: 0 };
    attributed.set(r.currency, { ...a, amount: a.amount + amount, orders: a.orders + orders });
  }
  // Every paid order counts; those no source covers are not matched.
  for (const p of paid) {
    const [orders, amount] = [Number(p.orders), Number(p.amount)];
    totals.orders += orders;
    addMoney(totals.revenue, p.currency, amount);
    const a = attributed.get(p.currency);
    const left = { orders: Math.max(0, orders - (a?.orders ?? 0)), amount: Math.max(0, amount - (a?.amount ?? 0)) };
    unmatched.orders += left.orders;
    if (left.amount) addMoney(unmatched.revenue, p.currency, left.amount);
  }

  const ranked = [...sources.values()].sort((a, b) => busier(a, b) || a.source.localeCompare(b.source));
  const named = ranked.filter((s) => s.source !== OTHER.source).slice(0, TOP_SOURCES);
  const others = ranked.filter((s) => !named.includes(s));
  let rest: FunnelCounts | null = null;
  if (others.length) {
    rest = zero();
    for (const s of others) addCounts(rest, s);
    byMoney(rest.revenue);
  }
  for (const s of named) {
    const campaigns = s.campaigns.sort((a, b) => busier(a, b) || a.campaign.localeCompare(b.campaign));
    s.campaigns = campaigns.slice(0, TOP_CAMPAIGNS);
    if (campaigns.length > TOP_CAMPAIGNS) {
      s.otherCampaigns = zero();
      for (const c of campaigns.slice(TOP_CAMPAIGNS)) addCounts(s.otherCampaigns, c);
      byMoney(s.otherCampaigns.revenue);
    }
    byMoney(s.revenue);
    for (const c of s.campaigns) byMoney(c.revenue);
  }

  // Today's limits, from the owner's count across their apps. Their plan is read only past the free
  // numbers, or when counting paused on 2 or more of the last 7 days, and read now, not as this server
  // last read it, so a plan bought a moment ago is never offered again.
  let pausedToday: number | null = null;
  let stepsPausedToday: number | null = null;
  let free = false;
  let pausedWeek: FunnelStats["pausedWeek"] = null;
  const [counted, steps, often] = [Number(owner?.people ?? 0), Number(owner?.steps ?? 0), Number(pausedDays?.n ?? 0)];
  if (counted >= freePeople() || steps >= freeSteps() || often >= PAUSED_DAYS_OFFER) {
    const plan = await peopleCap(site.owner, at, true);
    free = !plan.paid;
    if (counted >= plan.cap) pausedToday = plan.cap;
    if (steps >= plan.steps) stepsPausedToday = plan.steps;
    if (free && often >= PAUSED_DAYS_OFFER) pausedWeek = { days: often, people: plan.cap };
  }
  const newest = <T extends { day: string }>(list: T[]) => list.sort((a, b) => b.day.localeCompare(a.day));
  const base = (process.env.FLASH_APP_URL || SITE_URL).replace(/\/+$/, "");
  return {
    days,
    today,
    from: first,
    shownDays,
    totals: { ...totals, revenue: byMoney(totals.revenue) },
    sources: named,
    rest,
    unmatched: { form: unmatched.form, signup: unmatched.signup, checkout: unmatched.checkout, orders: unmatched.orders, revenue: byMoney(unmatched.revenue) },
    appSteps: [...appSteps]
      .map(([step, n]) => ({ step, people: n }))
      .sort((a, b) => b.people - a.people || a.step.localeCompare(b.step))
      .slice(0, MAX_STEP_NAMES),
    paused: newest(paused),
    pausedToday,
    stepsPaused: newest(stepsPaused),
    stepsPausedToday,
    netCapped,
    free,
    pausedWeek,
    addresses: [`${base}/p/${slug}`, ...domains.map((d) => `https://${d}/`)],
    empty: !Number(any?.any),
  };
}
