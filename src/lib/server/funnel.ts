/*
 * The steps from a visit to a sale (see the Visitors view in My websites & apps): sending a form,
 * signing up, starting a checkout, and the steps an app reports with flashDB.track. Each is counted
 * once a day per person, for someone matched to the visit their browser made to the app that day or
 * the day before (see visits.ts), under where that visit came from. What is kept are daily totals
 * (site_events), never who took a step. Paid orders go into daily totals per source and currency
 * (site_revenue); while a checkout is open, its buyer's source waits beside it (site_checkouts),
 * with nothing about the buyer.
 */
import { db, one, run } from "./db.ts";
import { dayOf, freePeople, isRobot, markOnce, pastKey, peopleCap, visitorCode, type Statement } from "./visits.ts";
import { MAX_STEP_NAMES, MAX_TRACKED, UNMATCHED, type Touch } from "../traffic.ts";

const DAY = 86_400_000;

/** A step Flash counts: a form sent, a sign-up, a checkout started, or one the app reported ("app:<name>"). */
export type Step = "form" | "signup" | "checkout" | `app:${string}`;
/**
 * Whose browser took a step: a person who visited the app that day or the day before, its owner,
 * nobody Flash counted, or a robot (whose steps count nowhere, not even as not matched).
 */
export type Match =
  | { kind: "visit"; day: string; visitor: string; touch: Touch; steps: string[] }
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
    return {
      kind: "visit",
      day: String(row.day),
      visitor: String(row.visitor),
      touch: { source: String(row.source ?? ""), medium: String(row.medium ?? ""), campaign: String(row.campaign ?? "") },
      steps: steps(row.steps),
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
 * The owner's steps never count. Never throws: stats must not break a form, a sign-up or a sale.
 */
export async function countSteps(slug: string, match: Match, list: Step[], at = Date.now()): Promise<void> {
  try {
    await count(slug, match, list, at, true);
  } catch (err) {
    console.error("[flash] steps not counted", err);
  }
}

async function count(slug: string, match: Match, list: Step[], at: number, retry: boolean): Promise<void> {
  if (match.kind === "owner" || match.kind === "robot") return;
  const today = dayOf(at);
  if (match.kind === "none") {
    const builtIn = [...new Set(list.filter((s) => !s.startsWith("app:")))];
    if (builtIn.length) await (await db()).batch(builtIn.map((s) => countUp(slug, today, s, { source: UNMATCHED, medium: "", campaign: "" })), "write");
    return;
  }
  // The person's list of steps for the day: each step once, at most 15 tries in all, counted or not.
  const fresh = [...new Set(list)].filter((s) => !match.steps.includes(s)).slice(0, Math.max(0, MAX_TRACKED - match.steps.length));
  if (!fresh.length) return;
  const c = await db();
  // Written only if nobody changed the list since it was read, so two requests can't count one step twice.
  const saved = await c.execute({
    sql: "UPDATE site_people SET steps = ? WHERE site_slug = ? AND day = ? AND visitor = ? AND steps = ? RETURNING 1",
    args: [JSON.stringify([...match.steps, ...fresh]), slug, match.day, match.visitor, JSON.stringify(match.steps)],
  });
  if (!saved.rows.length) {
    if (!retry) return;
    const again = await matchByCode(slug, match);
    if (again) await count(slug, again, list, at, false);
    return;
  }
  const writes: Statement[] = [];
  for (const s of fresh) if (!s.startsWith("app:")) writes.push(countUp(slug, match.day, s, match.touch));
  const app = fresh.filter((s) => s.startsWith("app:")).map((s) => s.slice(4));
  if (app.length) {
    // Two gates, read in one statement: the names the app reported that day (at most 10), and how
    // many app steps the owner's apps counted today, against their plan's daily number.
    const gate = await one<{ names: string; used: number | null; owner: string }>(
      `SELECT (SELECT json_group_array(name) FROM site_step_names WHERE site_slug = ? AND day = ?) AS names,
              o.steps AS used, s.user_id AS owner
       FROM sites s LEFT JOIN owner_people o ON o.user_id = s.user_id AND o.day = ? WHERE s.slug = ?`,
      [slug, match.day, today, slug],
    );
    if (!gate) return;
    const names = steps(gate.names);
    const used = Number(gate.used ?? 0);
    const budget = used < freePeople() ? freePeople() : (await peopleCap(gate.owner, at)).cap;
    let room = Math.max(0, budget - used);
    let known = names.length;
    let counted = 0;
    for (const name of app) {
      const isNew = !names.includes(name);
      // An 11th name of the day isn't counted.
      if (isNew && known >= MAX_STEP_NAMES) continue;
      if (!room) {
        const mark = markOnce(slug, "capped-app", budget, today);
        if (mark) writes.push(mark);
        break;
      }
      if (isNew) {
        known++;
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
              ON CONFLICT DO UPDATE SET n = n + 1`,
        args: [match.day, `app:${name}`, slug, slug, match.day, name],
      });
      room--;
      counted++;
    }
    if (counted) {
      writes.push({
        sql: `INSERT INTO owner_people (user_id, day, steps) SELECT user_id, ?, ? FROM sites WHERE slug = ?
              ON CONFLICT DO UPDATE SET steps = steps + excluded.steps`,
        args: [today, counted, slug],
      });
    }
  }
  if (writes.length) await c.batch(writes, "write");
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
 * saleBySource) or 3 days pass. Nothing about the buyer is kept, and nothing goes to Stripe. The
 * owner's own checkouts, and those Flash couldn't match, keep nothing: their orders show as not
 * matched. Never throws.
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
