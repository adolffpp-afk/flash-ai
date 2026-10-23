/*
 * What the automation routes do (src/app/api/automations/**, api/notifications, api/admin/automations),
 * kept here so each route is a few lines and the tests can reach it.
 *
 * Every route: signed in (401), and open to this account (automationsOpenTo: admins, and everyone once
 * /admin's switch opens them; anyone else gets 404); writes also come from Flash's own page with a confirmed email (403), and
 * each route counts against its own limit (429). Ownership is automations.user_id. No GET writes
 * anything but its own rate-limit row. Foreign keys are off, so every delete names each table.
 *
 * Money: what an automation says it costs at most (its estimate's worst case) is what the user saw
 * (seenMax); saving, turning on, running by hand and retrying price it again and answer 409
 * price_changed with the new price if it went up, saving nothing. Nothing here charges credits: only
 * a run's steps do (automation-steps.ts).
 */
import { after } from "next/server";
import { engineOf, FINISHED, isPaid, MAX_NAME_CHARS, MAX_ON, MAX_SUB_DAILY, MONTH_LEFT, NO_CHANGE, NO_CREDITS, NO_RESULT, NOTICES, ONCE_PASSED, parseSpec, PRICE_CHANGED, QUEUED, runnerFor, SPEC_INVALID, TOO_MANY_ON, TOO_MANY_SUB_DAILY, describeNext, describeWhen, type Spec } from "../automations.ts";
import { validTimeZone } from "../context-note.ts";
import { LEVELS } from "../levels.ts";
import { monthStart, nextFire, nextFires, nextMonthStart, ONCE_MAX_AHEAD_MS, ONCE_MIN_AHEAD_MS, subDaily, type When } from "../schedule.ts";
import { isVerified } from "./account.ts";
import { fromOwnPage, getUser, unauthorized, type User } from "./auth.ts";
import { draftMostCredits } from "./automation-draft.ts";
import { estimateSpec, type Estimate } from "./automation-estimate.ts";
import { advanceRun, checksOf, finish, LIMIT_OUTCOMES, savedReceipt, SELF_ENDING, sourcesOf, triesOf, verifyReceipt, versionSpec, type CompactReceipt, type SavedReceipt } from "./automation-runner.ts";
import { outputText, type AutoRow, type RunRow } from "./automation-steps.ts";
import { deleteAutomationNow } from "./automation-tick.ts";
import { liveHealth } from "./automation-admin.ts";
import { AUTOMATION_SHARED_PAID, automationsOpenTo, automationsServer, claimLimits, keyInUse, missingSetup, openToEveryone } from "./automations.ts";
import { heldElsewhere } from "./credit-holds.ts";
import { automationSpent, balance, ensureMonthlyCredits, topUpFloor } from "./credits.ts";
import { all, db, one, run as sql } from "./db.ts";
import { translatorFor, type ServerT } from "./i18n.ts";
import { randomId, sha256 } from "./ids.ts";
import { fredReady } from "./fred.ts";
import { canonicalJson } from "./mcp-client.ts";
import { DB_NOW, insertOwnerRun } from "./leases.ts";
import { overLimit } from "./limits.ts";
import type { UIMessage } from "../store.ts";
import { automationLink, noticeText } from "./notifications.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A run started by hand moves on in its own request for this long (its route's maxDuration is 800 s). */
export const OWNER_RUN_MS = 760_000;

/**
 * Each route's limit: [most, per window in ms]. Stop has its own (nothing else may use it up), and so
 * do marking runs and notices seen, and the /admin card's GET, which polls every 5 s while a run goes
 * on (its buttons keep admin's 60).
 */
export const LIMITS = {
  list: [300, 10 * MINUTE],
  create: [30, HOUR],
  estimate: [300, HOUR],
  edit: [120, 10 * MINUTE],
  runAutomation: [10, HOUR],
  runUser: [30, HOUR],
  read: [300, 10 * MINUTE],
  act: [60, 10 * MINUTE],
  stop: [300, 10 * MINUTE],
  seen: [300, 10 * MINUTE],
  admin: [60, 10 * MINUTE],
  card: [300, 10 * MINUTE],
  draft: [30, HOUR],
  chat: [30, HOUR],
} as const satisfies Record<string, readonly [number, number]>;

/** deadline: when a run this request moves on must be done by, OWNER_RUN_MS after the request came. */
export type Gate = { user: User; t: ServerT; deadline: number };
const json = (body: unknown, status = 200) => Response.json(body, { status });
const n = (v: unknown) => Number(v ?? 0);

/**
 * Who may call an automation route (see the top of this file). limit names the route's limit; key
 * makes it per automation as well as per account.
 */
export async function gate(request: Request, o: { write?: boolean; limit: keyof typeof LIMITS; key?: string }): Promise<Gate | Response> {
  const deadline = Date.now() + OWNER_RUN_MS;
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (!(await automationsOpenTo(user))) return json({ error: t("Not found") }, 404);
  if (o.write) {
    if (!fromOwnPage(request)) return json({ error: t("Please use Flash's own page.") }, 403);
    if (!isVerified(user)) return json({ error: t(NOTICES.unconfirmed) }, 403);
  }
  const [max, windowMs] = LIMITS[o.limit];
  if (await overLimit(`auto:${o.limit}:${o.key ?? user.id}`, max, windowMs)) {
    return json({ error: windowMs >= HOUR ? t("Too many requests. Try again in an hour.") : t("Too many tries. Please wait a few minutes.") }, 429);
  }
  return { user, t, deadline };
}

/**
 * 429 when a run started by hand (Run now, Retry, and the /admin card's Run once now) is over Run now's
 * limits: 10 an hour per automation of this account (so another account's tries never use it up) and 30
 * an hour per account. account: false when the route's gate counted the account's already.
 */
export async function overRunLimits(g: Gate, automationId: string | null, o: { account?: boolean } = {}): Promise<Response | null> {
  const over = (name: "runUser" | "runAutomation", key: string) => overLimit(`auto:${name}:${key}`, LIMITS[name][0], LIMITS[name][1]);
  if ((o.account !== false && (await over("runUser", g.user.id))) || (automationId !== null && (await over("runAutomation", `${g.user.id}:${automationId}`)))) {
    return json({ error: g.t("Too many requests. Try again in an hour.") }, 429);
  }
  return null;
}

/** The request's JSON body, or {} when there is none or it isn't an object. */
export async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  const body = (await request.json().catch(() => null)) as unknown;
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

type Row = AutoRow & { version: number; quoted_max: number; paused_reason: string; paused_at: number; resume_at: number; need_credits: number; last_run_at: number; last_status: string; created_at: number; updated_at: number };

/** An automation of this user, never one being deleted. */
export const ownAutomation = (user: User, id: string) =>
  one<Row>("SELECT * FROM automations WHERE id = ? AND user_id = ? AND status <> 'deleting'", [id, user.id]);

/** A run of this user's, of an automation not being deleted (to read: also of one being deleted, until its rows go). */
export const ownRun = (user: User, runId: string, o: { deleting?: boolean } = {}) =>
  one<RunRow & { trigger_json: string; receipt: string; receipt_hash: string; seen_at: number; summary: string; due_at: number; parked: number }>(
    `SELECT r.* FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE r.id = ? AND r.user_id = ? AND a.user_id = ?${o.deleting ? "" : " AND a.status <> 'deleting'"}`,
    [runId, user.id, user.id],
  );

/**
 * What an automation (or an account's automations) was charged since a moment, settled, and what its
 * open holds keep now (settled at most at that, often less). Limits count both (automationSpent).
 */
async function chargedAndHeld(where: { sql: string; args: (string | number)[] }, since: number) {
  const row = await one<{ charged: number; held: number }>(
    `SELECT COALESCE(-SUM(CASE WHEN settled_at > 0 THEN amount ELSE 0 END), 0) AS charged, COALESCE(-SUM(CASE WHEN settled_at = 0 THEN amount ELSE 0 END), 0) AS held
       FROM credit_ledger WHERE ${where.sql} AND automation_id <> '' AND amount < 0 AND created_at >= ?`,
    [...where.args, since],
  );
  return { charged: n(row?.charged), held: n(row?.held) };
}

/** Whether a one-off's saved time is gone, so it can't be turned on as it is (a new time is 2 minutes ahead at least). */
const oncePassed = (when: When, timeZone: string) => !nextFire(when, timeZone, Date.now());
/** Whether an automation has a scheduled run not finished: a one-off paused part way, whose run goes on when it's turned on. */
const scheduledRunOpen = async (id: string) =>
  Boolean(await one("SELECT 1 AS x FROM automation_runs WHERE automation_id = ? AND origin = 'schedule' AND finished_at = 0 LIMIT 1", [id]));

/** The most runs an automation's unseen count counts (a list shows more as "99+"). */
export const UNSEEN_MAX = 100;

/** An automation as the routes return it, in the reader's language. */
export async function automationView(a: Row, t: ServerT) {
  const spec = await versionSpec(a.id, Number(a.version));
  const when = spec?.trigger.type === "schedule" ? spec.trigger.when : null;
  // A one-off paused (or a draft) whose time has passed can't be turned on as it is: it needs a new time.
  const timePassed = when?.kind === "once" && (a.status === "paused" || a.status === "draft") && oncePassed(when, a.time_zone) && !(await scheduledRunOpen(a.id));
  const schedule = when ? describeWhen(when, a.time_zone, t, t.locale) : null;
  const upcoming = when && a.status === "on" ? nextFires(when, a.time_zone, Date.now(), 3) : [];
  // Runs ended and not opened yet, up to UNSEEN_MAX, read through those runs only (automation_runs_unseen).
  const unseen = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM automation_runs WHERE automation_id = ? AND finished_at > 0 AND seen_at = 0 LIMIT ${UNSEEN_MAX})`,
    [a.id],
  );
  // The last run that ended, for the list's "Done Oct 13, 12 credits".
  const last = await one<{ credits: number; finished_at: number }>("SELECT credits, finished_at FROM automation_runs WHERE automation_id = ? AND finished_at > 0 ORDER BY created_at DESC LIMIT 1", [a.id]);
  return {
    id: a.id,
    name: a.name,
    status: a.status,
    pausedReason: a.paused_reason,
    resumeAt: Number(a.resume_at),
    needCredits: Number(a.need_credits),
    version: Number(a.version),
    spec,
    timeZone: a.time_zone,
    schedule,
    nextAt: Number(a.next_at),
    timePassed,
    next: upcoming.length ? describeNext(upcoming, a.time_zone, t, t.locale) : "",
    capRun: Number(a.cap_run),
    capMonth: Number(a.cap_month),
    quotedMax: Number(a.quoted_max),
    ...(await (async () => {
      const m = await chargedAndHeld({ sql: "automation_id = ?", args: [a.id] }, monthStart(Date.now()));
      return { spentThisMonth: m.charged, heldNow: m.held };
    })()),
    lastStatus: a.last_status,
    lastRunAt: Number(a.last_run_at),
    lastCredits: Number(last?.credits ?? 0),
    lastEndedAt: Number(last?.finished_at ?? 0),
    unseen: Number(unseen?.n ?? 0),
    createdAt: Number(a.created_at),
    updatedAt: Number(a.updated_at),
  };
}

/**
 * The account's automations, with what the panel shows around them: the auto top-up level automations
 * keep (topupFloor, 0 without auto top-up), and whether the economy numbers (FRED) can be used here.
 */
export async function listAutomations(g: Gate) {
  const rows = await all<Row>("SELECT * FROM automations WHERE user_id = ? AND status <> 'deleting' ORDER BY updated_at DESC LIMIT 100", [g.user.id]);
  return {
    automations: await Promise.all(rows.map((a) => automationView(a, g.t))),
    topupFloor: await topUpFloor(g.user.id),
    economy: fredReady(),
    draftCredits: draftMostCredits(),
  };
}

type Fields = { spec: Spec; name: string; timeZone: string };

/**
 * The fields of a create or an edit, checked: a refusal answers 400 in the reader's words. once: a
 * one-off's time is checked (on create, a new spec or time zone, or turning it on; a pause or a rename
 * of a one-off whose time has come goes through).
 */
function fieldsOf(body: Record<string, unknown>, t: ServerT, was?: Row & { spec: Spec | null }, once = true): Fields | Response {
  const parsed = body.spec === undefined && was?.spec ? { spec: was.spec } : parseSpec(body.spec);
  if ("error" in parsed) return json({ error: t(parsed.error, parsed.blanks) }, 400);
  const name = body.name === undefined && was ? was.name : typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim() : "";
  const timeZone = body.timeZone === undefined && was ? was.time_zone : validTimeZone(body.timeZone);
  if (!name || name.length > MAX_NAME_CHARS || !timeZone) return json({ error: t(SPEC_INVALID) }, 400);
  // A one-off between 2 minutes and a year ahead (a time already gone has no slot); turned on as it is,
  // its saved time only needs to be still ahead.
  const when = parsed.spec.trigger.type === "schedule" ? parsed.spec.trigger.when : null;
  if (when?.kind === "once" && once) {
    const slot = nextFire(when, timeZone, Date.now());
    const least = body.spec === undefined && timeZone === was?.time_zone ? 0 : ONCE_MIN_AHEAD_MS;
    // Its saved time gone (turning it on as it is, or in another zone): it needs a new time, which says so.
    if (body.spec === undefined && (!slot || slot < Date.now() + least)) return json({ error: t(ONCE_PASSED), code: "once_passed" }, 409);
    if (!slot || slot < Date.now() + least || slot > Date.now() + ONCE_MAX_AHEAD_MS) return json({ error: t(SPEC_INVALID) }, 400);
  }
  return { spec: parsed.spec, name, timeZone };
}

/** A limit from the body (whole credits, 1 to 100,000), or the default. */
function capOf(v: unknown, fallback: number): number | null {
  if (v === undefined || v === null) return fallback;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 100_000 ? v : null;
}

/**
 * 409 month_cap, in words, when what's left of the automation's month limit is less than its first AI
 * step needs to start: the run would only be skipped at the limit, so it doesn't start. Its other runs'
 * open holds count as nothing here: a run they are in the way of waits for them (see runAiStep).
 */
async function monthLeftRefusal(t: ServerT, a: Row, estimate: Estimate): Promise<Response | null> {
  const now = Date.now();
  const [spent, other] = await Promise.all([automationSpent(a.id, monthStart(now)), heldElsewhere(a.pay_account, a.id)]);
  if (Number(a.cap_month) - spent + other.automation >= estimate.least) return null;
  const said = noticeText({ phrase: MONTH_LEFT, blanks: JSON.stringify({ credits: Number(a.cap_month), date: nextMonthStart(now) }) }, t).text;
  return json({ error: said, code: "month_cap" }, 409);
}

/**
 * 409 no_credits, in words, when the balance above the auto top-up level can't hold its first AI step
 * (after any monthly credits due are given, as a run does): the run would only be skipped, so it doesn't
 * start. Other runs' open holds count as nothing here, as in monthLeftRefusal.
 */
async function creditsRefusal(t: ServerT, a: Row, estimate: Estimate): Promise<Response | null> {
  await ensureMonthlyCredits(a.pay_account);
  const [held, floor, other] = await Promise.all([balance(a.pay_account), topUpFloor(a.pay_account), heldElsewhere(a.pay_account, a.id)]);
  const have = held + other.account;
  if (have - floor >= estimate.least) return null;
  // Numbers in the reader's digits, as noticeText writes them.
  const credits = (floor > 0 && have >= estimate.least ? floor : estimate.least).toLocaleString(t.locale);
  const said = t(floor > 0 && have >= estimate.least ? NOTICES.topupFloor : NO_CREDITS, { credits });
  return json({ error: said, code: "no_credits" }, 409);
}

/** 409 price_changed: the worst case went up since the user saw it (or they never saw one). */
const priceChanged = (t: ServerT, estimate: Estimate) => json({ error: t(PRICE_CHANGED), code: "price_changed", estimate }, 409);
const seenEnough = (seenMax: unknown, estimate: Estimate) => typeof seenMax === "number" && Number.isFinite(seenMax) && estimate.worst <= seenMax;

/** Whether one more automation may be on: at most 25, and at most 3 that run more than once a day. */
async function onRefusal(user: User, spec: Spec, t: ServerT, except = ""): Promise<Response | null> {
  const on = await all<{ id: string; spec: string }>(
    "SELECT a.id, v.spec FROM automations a JOIN automation_versions v ON v.automation_id = a.id AND v.version = a.version WHERE a.user_id = ? AND a.status = 'on' AND a.id <> ?",
    [user.id, except],
  );
  if (on.length >= MAX_ON) return json({ error: t(TOO_MANY_ON, { count: MAX_ON.toLocaleString(t.locale) }) }, 409);
  const often = (s: Spec | null) => s?.trigger.type === "schedule" && subDaily(s.trigger.when);
  if (often(spec)) {
    const others = on.filter((a) => {
      try {
        const p = parseSpec(JSON.parse(a.spec));
        return "spec" in p && often(p.spec);
      } catch {
        return false;
      }
    });
    if (others.length >= MAX_SUB_DAILY) return json({ error: t(TOO_MANY_SUB_DAILY) }, 409);
  }
  return null;
}

/** The next slot of a schedule from now (0 for one its owner starts). */
const nextSlot = (spec: Spec, timeZone: string) => (spec.trigger.type === "schedule" ? nextFire(spec.trigger.when, timeZone, Date.now()) : 0);

/**
 * Prices a draft, saving nothing; with its schedule in the reader's words and its next 3 run times
 * ("Next: …"), worked out here so the editor shows what the server will do.
 */
export async function estimate(g: Gate, body: Record<string, unknown>) {
  const f = fieldsOf({ name: "Estimate", timeZone: "UTC", ...body }, g.t);
  if (f instanceof Response) return f;
  const when = f.spec.trigger.type === "schedule" ? f.spec.trigger.when : null;
  const upcoming = when ? nextFires(when, f.timeZone, Date.now(), 3) : [];
  return json({
    estimate: await estimateSpec(f.spec, g.user, { name: f.name, time_zone: f.timeZone, where_json: "{}", language: g.user.language ?? "" }),
    schedule: when ? describeWhen(when, f.timeZone, g.t, g.t.locale) : null,
    next: upcoming.length ? describeNext(upcoming, f.timeZone, g.t, g.t.locale) : "",
  });
}

/** Creates an automation, on (or a draft), at the price the user saw. */
export async function createAutomation(g: Gate, body: Record<string, unknown>) {
  const f = fieldsOf(body, g.t);
  if (f instanceof Response) return f;
  const status = body.status === "draft" ? "draft" : "on";
  if (status === "on") {
    const refused = await onRefusal(g.user, f.spec, g.t);
    if (refused) return refused;
  }
  const est = await estimateSpec(f.spec, g.user, { name: f.name, time_zone: f.timeZone, where_json: "{}", language: g.user.language ?? "" });
  if (!seenEnough(body.seenMax, est)) return priceChanged(g.t, est);
  const capRun = capOf(body.capRun, est.limits.capRun);
  const capMonth = capOf(body.capMonth, est.limits.capMonth);
  if (!capRun || !capMonth || capMonth < capRun) return json({ error: g.t(SPEC_INVALID) }, 400);
  const id = randomId();
  const t = Date.now();
  await (await db()).batch(
    [
      {
        sql: `INSERT INTO automations (id, user_id, pay_account, name, status, version, trigger_kind, time_zone, language, next_at, cap_run, cap_month, quoted_max, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, g.user.id, g.user.id, f.name, status, f.spec.trigger.type, f.timeZone, g.user.language ?? "", status === "on" ? nextSlot(f.spec, f.timeZone) : 0, capRun, capMonth, est.worst, t, t],
      },
      {
        sql: "INSERT INTO automation_versions (automation_id, version, user_id, spec, runner, created_at) VALUES (?, 1, ?, ?, ?, ?)",
        args: [id, g.user.id, JSON.stringify(f.spec), runnerFor(f.spec), t],
      },
    ],
    "write",
  );
  const row = (await ownAutomation(g.user, id))!;
  return json({ automation: await automationView(row, g.t), estimate: est }, 201);
}

/**
 * Edits an automation: { status: "on" | "paused" }, { spec, name } (a new version), { timeZone },
 * { capRun, capMonth }, any together. Turning it on and edits that raise its price need seenMax.
 */
export async function editAutomation(g: Gate, id: string, body: Record<string, unknown>) {
  const a = await ownAutomation(g.user, id);
  if (!a) return json({ error: g.t("Not found") }, 404);
  const spec = await versionSpec(a.id, Number(a.version));
  const edited = body.spec !== undefined || body.name !== undefined || body.timeZone !== undefined;
  const status = body.status === "on" || body.status === "paused" ? body.status : a.status;
  const turningOn = status === "on" && a.status !== "on";
  if (status === "on" && a.status === "finished" && !edited) return json({ error: g.t(FINISHED) }, 409);
  // A one-off paused while its run was going: turned on as it is, that run goes on (its time, taken, isn't
  // checked again). Not once it was moved while paused: it has a new slot then (next_at), which it keeps.
  const runGoesOn =
    turningOn &&
    body.spec === undefined &&
    body.timeZone === undefined &&
    Number(a.next_at) === 0 &&
    spec?.trigger.type === "schedule" &&
    spec.trigger.when.kind === "once" &&
    (await scheduledRunOpen(a.id));
  const f = fieldsOf(body, g.t, { ...a, spec }, !runGoesOn && (body.spec !== undefined || body.timeZone !== undefined || turningOn));
  if (f instanceof Response) return f;
  if (turningOn || (status === "on" && edited)) {
    const refused = await onRefusal(g.user, f.spec, g.t, a.id);
    if (refused) return refused;
  }
  // Priced again for what changes the price or turns it on; a higher worst case needs the user's yes.
  const est = edited || turningOn ? await estimateSpec(f.spec, g.user, { name: f.name, time_zone: f.timeZone, where_json: a.where_json, language: a.language }) : null;
  if (est && (turningOn || est.worst > Number(a.quoted_max)) && !seenEnough(body.seenMax, est)) return priceChanged(g.t, est);
  const capRun = capOf(body.capRun, Number(a.cap_run));
  const capMonth = capOf(body.capMonth, Number(a.cap_month));
  if (!capRun || !capMonth || capMonth < capRun) return json({ error: g.t(SPEC_INVALID) }, 400);
  const version = body.spec !== undefined ? Number(a.version) + 1 : Number(a.version);
  // Worked out again only when it is turned on or its schedule or zone changes (paused too, so the pause
  // ends at its new time): a rename or a new instruction keeps a slot that is due and not yet taken by the
  // tick (an automation that is on has a next slot unless it is run by hand or a one-off whose slot was
  // taken, and those have none to work out).
  // Kept, the column is left as it is, not written back as read: the tick may take that slot meanwhile
  // (next_at 0, its run made), and writing it back would bring a taken slot back.
  const moved = JSON.stringify(f.spec.trigger) !== JSON.stringify(spec?.trigger) || f.timeZone !== a.time_zone;
  const keepsNext = !runGoesOn && !((status === "on" && (turningOn || moved)) || (status === "paused" && moved));
  const nextAt = runGoesOn ? 0 : keepsNext ? Number(a.next_at) : nextSlot(f.spec, f.timeZone);
  // A pause that ends by itself, moved, is looked at again as its run's end would have set it: a wait for
  // credits at the new next slot, and a one-off's at its new time whatever paused it (see resumePaused).
  const once = f.spec.trigger.type === "schedule" && f.spec.trigger.when.kind === "once";
  const resumeAt = status === "paused" && moved && SELF_ENDING.has(a.paused_reason) && (once || a.paused_reason === "credits") ? nextAt || Date.now() + 86_400_000 : Number(a.resume_at);
  // A pause by its owner never ends by itself; turned on, every pause is over.
  const pause =
    status === a.status
      ? { reason: a.paused_reason, at: Number(a.paused_at), resumeAt, need: Number(a.need_credits) }
      : status === "paused"
        ? { reason: "user", at: Date.now(), resumeAt: 0, need: 0 }
        : { reason: "", at: 0, resumeAt: 0, need: 0 };
  const t = Date.now();
  const rs = await (await db()).batch(
    [
      {
        // Only over the automation as it was read: a run pausing it meanwhile, or another edit, wins.
        sql: `UPDATE automations SET name = ?, time_zone = ?, version = ?, trigger_kind = ?, status = ?, next_at = CASE WHEN ? = 1 THEN next_at ELSE ? END, cap_run = ?, cap_month = ?, quoted_max = ?,
                     paused_reason = ?, paused_at = ?, resume_at = ?, need_credits = ?, fail_streak = CASE WHEN ? = 1 THEN 0 ELSE fail_streak END, updated_at = ${DB_NOW}
               WHERE id = ? AND user_id = ? AND version = ? AND status = ?`,
        args: [
          f.name,
          f.timeZone,
          version,
          f.spec.trigger.type,
          status,
          keepsNext ? 1 : 0,
          nextAt,
          capRun,
          capMonth,
          est ? est.worst : Number(a.quoted_max),
          pause.reason,
          pause.at,
          pause.resumeAt,
          pause.need,
          turningOn ? 1 : 0,
          a.id,
          g.user.id,
          a.version,
          a.status,
        ],
      },
      ...(version !== Number(a.version)
        ? [
            {
              sql: `INSERT INTO automation_versions (automation_id, version, user_id, spec, runner, created_at)
                    SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM automations WHERE id = ? AND version = ?)`,
              args: [a.id, version, g.user.id, JSON.stringify(f.spec), runnerFor(f.spec), t, a.id, version],
            },
          ]
        : []),
      // Paused, its runs that haven't started wait with it (one under way is parked by the runner after
      // its step); turned on, every parked run goes on, part way or not.
      status === "paused"
        ? {
            sql: `UPDATE automation_runs SET parked = 1, updated_at = ${DB_NOW}
                   WHERE automation_id = ? AND finished_at = 0 AND parked = 0 AND status IN ('queued','waiting') AND lease_until < ${DB_NOW}
                     AND EXISTS (SELECT 1 FROM automations WHERE id = ? AND status = 'paused')`,
            args: [a.id, a.id],
          }
        : {
            sql: `UPDATE automation_runs SET parked = 0, updated_at = ${DB_NOW}
                   WHERE automation_id = ? AND finished_at = 0 AND parked = 1 AND EXISTS (SELECT 1 FROM automations WHERE id = ? AND status = ?)`,
            args: [a.id, a.id, status],
          },
    ],
    "write",
  );
  if (rs[0].rowsAffected !== 1) return json({ error: g.t("Something went wrong. Please try again.") }, 409);
  const row = await ownAutomation(g.user, a.id);
  return json({ automation: row ? await automationView(row, g.t) : null, ...(est && { estimate: est }) });
}

/**
 * Deletes an automation: its runs not started end now, a step in flight settles first (Stop, then
 * the runner ends it as deleted), and once nothing of it runs every row goes (now, or the daily job).
 * Credits already spent stay spent: the ledger and holds are kept.
 */
export async function deleteAutomation(g: Gate, id: string) {
  const a = await ownAutomation(g.user, id);
  if (!a) return json({ error: g.t("Not found") }, 404);
  await sql(`UPDATE automations SET status = 'deleting', next_at = 0, updated_at = ${DB_NOW} WHERE id = ? AND user_id = ?`, [a.id, g.user.id]);
  await sql(`UPDATE automation_runs SET stop_requested = 1, updated_at = ${DB_NOW} WHERE automation_id = ? AND finished_at = 0`, [a.id]);
  const idle = await all<RunRow>("SELECT * FROM automation_runs WHERE automation_id = ? AND finished_at = 0 AND lease_owner = ''", [a.id]);
  for (const r of idle) await finish(r, "stopped", "deleted", { me: "" });
  const deleted = await deleteAutomationNow({ id: a.id, user_id: g.user.id });
  return json({ ok: true, deleted });
}

/** Run now (and Run once now for a draft): through the account's and Flash's limits, else queued for the tick. */
export async function runNow(g: Gate, id: string, body: Record<string, unknown>) {
  if (!automationsServer() || missingSetup().length) return json({ error: g.t("Something went wrong. Please try again."), missing: missingSetup() }, 503);
  const a = await ownAutomation(g.user, id);
  if (!a) return json({ error: g.t("Not found") }, 404);
  if (a.status === "paused") return json({ error: g.t(NOTICES.paused, { name: a.name }) }, 409);
  const requestId = typeof body.requestId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.requestId) ? body.requestId : "";
  if (!requestId) return json({ error: g.t(SPEC_INVALID) }, 400);
  const spec = await versionSpec(a.id, Number(a.version));
  if (!spec) return json({ error: g.t(SPEC_INVALID) }, 409);
  const est = await estimateSpec(spec, g.user, a);
  if (!seenEnough(body.seenMax, est)) return priceChanged(g.t, est);
  const used = (await monthLeftRefusal(g.t, a, est)) ?? (await creditsRefusal(g.t, a, est));
  if (used) return used;
  return startOwnerRun(g, a, spec, `manual:${requestId}`, { type: "owner" });
}

async function startOwnerRun(g: Gate, a: Row, spec: Spec, runKey: string, trigger: Record<string, unknown>) {
  const limits = await claimLimits();
  const run = await insertOwnerRun({
    id: randomId(),
    automationId: a.id,
    userId: g.user.id,
    runKey,
    worker: `n${randomId(6)}`,
    firstPaid: isPaid(spec.steps[0]),
    limits,
    triggerJson: JSON.stringify(trigger),
  });
  if (!run) return json({ error: g.t("Not found") }, 404);
  // Leased to this request: it moves the run on after answering, within this route's time (timed from
  // the request, so pricing it first takes nothing from the steps).
  if (run.owner) {
    const { id, owner } = run;
    after(() => advanceRun(id, owner, g.deadline).catch((err) => console.error("[flash] automation run failed", err instanceof Error ? err.name : "error")));
  }
  return json({ run: { id: run.id, status: run.status }, ...(run.status === "queued" && { note: g.t(QUEUED) }) }, run.existing ? 200 : 202);
}

/** The most receipts "Download receipts" saves at once, newest first. */
export const RECEIPTS_MAX = 1000;

/**
 * An automation's fingerprinted receipts, newest first (at most RECEIPTS_MAX), as one file: what
 * Delete offers to keep before the runs go. Runs that haven't ended have none yet.
 */
export async function receiptsFile(g: Gate, id: string) {
  const a = await ownAutomation(g.user, id);
  if (!a) return json({ error: g.t("Not found") }, 404);
  const rows = await all<{ receipt: string; receipt_hash: string }>(
    `SELECT receipt, receipt_hash FROM automation_runs WHERE automation_id = ? AND user_id = ? AND finished_at > 0 AND receipt <> '' ORDER BY created_at DESC LIMIT ${RECEIPTS_MAX}`,
    [a.id, g.user.id],
  );
  // Each as Compare takes it ({ prev, receipt, hash }).
  const receipts = rows.map(savedReceipt).filter(Boolean);
  return new Response(JSON.stringify({ automation: { id: a.id, name: a.name }, receipts }, null, 1), {
    headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="receipts-${a.id.replace(/[^A-Za-z0-9_-]/g, "")}.json"` },
  });
}

/** An automation's runs, newest first, 20 a page (cursor: the last one's created_at), and how many it has in all (total). */
export async function listRuns(g: Gate, id: string, cursor: string | null) {
  const a = await ownAutomation(g.user, id);
  if (!a) return json({ error: g.t("Not found") }, 404);
  const total = await one<{ n: number }>("SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id = ? AND user_id = ?", [a.id, g.user.id]);
  const before = Number(cursor) > 0 ? Number(cursor) : Number.MAX_SAFE_INTEGER;
  const rows = await all<RunRow & { summary: string; seen_at: number }>(
    `SELECT id, status, outcome, origin, credits, refunded, summary, scheduled_at, started_at, finished_at, created_at, seen_at FROM automation_runs
      WHERE automation_id = ? AND user_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 21`,
    [a.id, g.user.id, before],
  );
  const page = rows.slice(0, 20);
  return json({
    runs: page.map((r) => ({
      id: r.id,
      status: r.status,
      outcome: r.outcome,
      origin: r.origin,
      credits: Number(r.credits),
      refunded: Number(r.refunded),
      summary: r.summary,
      scheduledAt: Number(r.scheduled_at),
      startedAt: Number(r.started_at),
      finishedAt: Number(r.finished_at),
      createdAt: Number(r.created_at),
      seen: Number(r.seen_at) > 0,
    })),
    cursor: rows.length > 20 ? String(page.at(-1)!.created_at) : null,
    total: Number(total?.n ?? 0),
  });
}

/** What a step's note says, in the reader's words, where it has one. */
const NOTE_PHRASES: Record<string, string> = { cut_short: NOTICES.cutShort, interrupted: NOTICES.interrupted, missed: NOTICES.missed, overlap: NOTICES.overlap, waiting: NOTICES.waitingHold };
/** What a run's outcome says, in the reader's words, where Flash has a phrase for it. */
const RUN_NOTES: Record<string, string> = {
  missed: NOTICES.missed,
  overlap: NOTICES.overlap,
  interrupted: NOTICES.interrupted,
  capacity: NOTICES.capacity,
  unconfirmed: NOTICES.unconfirmed,
  run_cap: NOTICES.runCap,
  month_cap: MONTH_LEFT,
  no_credits: NOTICES.noCredits,
  topup_floor: NOTICES.topupFloor,
  failed: NOTICES.failed,
  cut_short: NOTICES.cutShort,
};
/**
 * The credits a run's note names: the limit it stopped at (the run's, the month's, or the auto top-up
 * level) as its fingerprinted receipt keeps it, never as the automation or auto top-up is set now, else
 * what it was charged.
 */
const noteCredits = (outcome: string, run: { credits: number }, saved: SavedReceipt | null) =>
  Number(LIMIT_OUTCOMES.has(outcome) ? (saved?.receipt.limit ?? 0) : run.credits);

/**
 * A run's receipt: what started it, each try of each step with its hold (a step's waits for other runs'
 * holds in a row shown once, with how many, never as tries), and its fingerprint. Reads only.
 */
export async function receipt(g: Gate, runId: string) {
  const r = await ownRun(g.user, runId, { deleting: true });
  if (!r) return null;
  const steps = await all<{ step_id: string; attempt: number; kind: string; status: string; input: string; output: Uint8Array | null; note: string; hold_ref: string; held: number; credits: number; level: string; model: string; started_at: number; finished_at: number }>(
    "SELECT * FROM automation_run_steps WHERE run_id = ? ORDER BY started_at, attempt",
    [r.id],
  );
  const holds = await all<{ ref: string; held: number; credits: number; model: string; started: number; done: number; settled_at: number; created_at: number }>(
    "SELECT ref, held, credits, model, started, done, settled_at, created_at FROM credit_holds WHERE run_id = ? ORDER BY created_at",
    [r.id],
  );
  const a = await one<{ name: string; status: string }>("SELECT name, status FROM automations WHERE id = ?", [r.automation_id]);
  const saved = savedReceipt(r);
  // A step under way shows what its hold keeps (its row gets its own held when it settles), and a step
  // whose call was sent the model its hold names (its row gets its own when it settles).
  const holdOf = new Map(holds.map((h) => [h.ref, h]));
  const view = (s: (typeof steps)[number], attempt: number) => ({
    stepId: s.step_id,
    // Its try (waits aren't tries); 0 for waits, which say how many in a row (waits).
    attempt,
    waits: 0,
    kind: s.kind,
    status: s.status,
    level: s.level,
    model: s.model || (Number(holdOf.get(s.hold_ref)?.started) ? (holdOf.get(s.hold_ref)?.model ?? "") : ""),
    held: Number(s.held) || (s.status === "running" ? Number(holdOf.get(s.hold_ref)?.held ?? 0) : 0),
    credits: Number(s.credits),
    note: s.note,
    noteText: NOTE_PHRASES[s.note] ? g.t(NOTE_PHRASES[s.note], { credits: Number(s.credits).toLocaleString(g.t.locale) }) : "",
    input: s.input,
    output: outputText(s.output),
    sources: sourcesOf(s.output),
    // What it was checked against, and whether each passed (see runAiStep).
    checks: checksOf(s.output),
    holdRef: s.hold_ref,
    startedAt: Number(s.started_at),
    finishedAt: Number(s.finished_at),
  });
  const tryOf = new Map(triesOf(steps).tries.map((s) => [`${s.step_id}:${s.attempt}`, s.try]));
  const shown: ReturnType<typeof view>[] = [];
  for (const s of steps) {
    const last = shown.at(-1);
    if (s.note !== "waiting") shown.push(view(s, tryOf.get(`${s.step_id}:${s.attempt}`) ?? 0));
    else if (last?.note === "waiting" && last.stepId === s.step_id) Object.assign(last, { waits: last.waits + 1, held: Math.max(last.held, Number(s.held)), finishedAt: Number(s.finished_at) });
    else shown.push({ ...view(s, 0), status: "waiting", waits: 1 });
  }
  // Only the run's last row, while it goes on and isn't parked (waiting for Resume), waits now and says
  // why; earlier waits, and one before a pause, were waited.
  for (const [i, s] of shown.entries()) {
    if (s.waits > 0 && (i < shown.length - 1 || Number(r.finished_at) || Number(r.parked) === 1)) Object.assign(s, { status: "waited", noteText: "" });
  }
  return {
    run: {
      id: r.id,
      automationId: r.automation_id,
      // Once it ended, the name it ran under (fingerprinted), else its automation's.
      name: saved?.receipt.name ?? a?.name ?? "",
      version: Number(r.version),
      origin: r.origin,
      trigger: JSON.parse(r.trigger_json || "{}") as unknown,
      status: r.status,
      outcome: r.outcome,
      credits: Number(r.credits),
      // What Flash gave back, the run having failed because of Flash (credits is then 0).
      refunded: Number(r.refunded),
      // How many of its checks passed and failed so far.
      checks: { passed: Number(r.checks_passed ?? 0), failed: Number(r.checks_failed ?? 0) },
      summary: r.summary,
      scheduledAt: Number(r.scheduled_at),
      startedAt: Number(r.started_at),
      finishedAt: Number(r.finished_at),
      createdAt: Number(r.created_at),
      stopRequested: Number(r.stop_requested) > 0,
      parked: Number(r.parked) === 1,
      dueAt: Number(r.due_at),
      // Its step waits for another request's hold (a run's or a chat reply's), to try again at dueAt.
      waiting: !Number(r.finished_at) && steps.at(-1)?.note === "waiting",
      deleted: a?.status === "deleting",
      // Why it ended this way, in the reader's words, where Flash says so.
      noteText: RUN_NOTES[r.outcome]
        ? noticeText({ phrase: RUN_NOTES[r.outcome], blanks: JSON.stringify({ credits: noteCredits(r.outcome, r, saved), date: nextMonthStart(Number(r.created_at)) }) }, g.t).text
        : "",
    },
    steps: shown,
    holds: holds.map((h) => ({ ref: h.ref, held: Number(h.held), credits: Number(h.credits), started: Number(h.started) > 0, done: Number(h.done) > 0, settledAt: Number(h.settled_at), createdAt: Number(h.created_at) })),
    // The fingerprint and the compact receipt it was made from (empty until the run ends).
    fingerprint: r.receipt_hash,
    receipt: saved,
  };
}

/**
 * Open in chat (POST /api/automations/runs/[runId]/chat): a new chat with the run's instruction as the
 * user's message and its answer, with its sources, as Flash's, to ask follow-ups. Free: nothing is sent
 * to the AI until the user writes. 404 when the run has no answer kept (it failed, or its answer was
 * compacted away).
 */
export async function openInChat(g: Gate, runId: string) {
  const r = await ownRun(g.user, runId);
  if (!r) return json({ error: g.t("Not found") }, 404);
  const step = await one<{ step_id: string; input: string; output: Uint8Array | null }>(
    "SELECT step_id, input, output FROM automation_run_steps WHERE run_id = ? AND kind = 'ai' AND status = 'done' AND output IS NOT NULL ORDER BY started_at DESC, attempt DESC LIMIT 1",
    [r.id],
  );
  const lines = outputText(step?.output).split("\n");
  // "Only if changed" answers NO_CHANGE on its first line, then a sentence saying so.
  const answer = (lines[0]?.trim() === NO_CHANGE ? lines.slice(1) : lines).join("\n").trim();
  if (!step || !answer) return json({ error: g.t(NO_RESULT) }, 404);
  const spec = await versionSpec(r.automation_id, Number(r.version));
  const ai = spec?.steps.find((s) => s.id === step.step_id);
  const a = await one<{ name: string }>("SELECT name FROM automations WHERE id = ?", [r.automation_id]);
  const name = (savedReceipt(r)?.receipt.name || a?.name || "").slice(0, 80) || "New project";
  const at = Date.now();
  const messages: UIMessage[] = [
    { id: randomId(), role: "user", content: ai && isPaid(ai) ? ai.prompt : name },
    { id: randomId(), role: "assistant", content: answer, engine: ai && isPaid(ai) ? engineOf(ai) : "text", sources: sourcesOf(step.output) },
  ];
  const project = { id: randomId(), name, updated_at: at };
  await sql("INSERT INTO projects (id, user_id, name, messages, updated_at) VALUES (?, ?, ?, ?, ?)", [project.id, g.user.id, name, JSON.stringify(messages), at]);
  return json({ project });
}

type Shown = NonNullable<Awaited<ReturnType<typeof receipt>>>;
type Line = Record<string, unknown>;

/**
 * Whether a downloaded receipt (receipt() as it was then) says what Flash's record says now and what its
 * fingerprinted compact receipt says:
 * - every line (its run, each try and wait, its holds, its fingerprint) is Flash's, its automation
 *   deleted since aside. What Flash compacted away since (what a step sent, wrote and cited) is the
 *   file's if it is what was fingerprinted, so a line left empty matches only where Flash's is empty too;
 * - each try's kind, status, level, model, note, hold and charge, and the SHA-256 of what it sent, wrote
 *   and cited, are the fingerprint's, as are the run's name, version, trigger, charge, refund, status,
 *   outcome and summary, and its wait lines add up to the waits it counts.
 * A file with only the compact receipt has nothing more to check. (The words of its notes are Flash's in
 * the reader's language, as receipt() gives them.)
 */
function readableMatches(file: Line, compact: CompactReceipt, mine: Shown): boolean {
  if (file.run === undefined && file.steps === undefined) return true;
  const run = file.run as Line | null;
  const rows = Array.isArray(file.steps) ? (file.steps as unknown[]) : null;
  if (!run || typeof run !== "object" || !rows || !rows.every((x) => Boolean(x) && typeof x === "object")) return false;
  const steps = rows as Line[];
  if (steps.length !== mine.steps.length) return false;
  const tryOf = (s: { stepId: unknown; attempt: unknown; waits: unknown }) => (Number(s.waits) === 0 ? compact.steps.find((c) => c.id === s.stepId && c.attempt === s.attempt) : undefined);
  const fits = (x: unknown, hash: string) => typeof x === "string" && x !== "" && sha256(x) === hash;
  // Flash's record, with what it compacted since taken from the file where the fingerprint says it is so.
  const expected = structuredClone(mine) as unknown as { run: Line; steps: Line[] };
  delete expected.run.deleted;
  // A receipt downloaded before Flash had checks has no checks lines: none are expected where there are none.
  const noChecks = (x: unknown) => !x || (typeof x === "object" && !Number((x as { passed?: unknown }).passed) && !Number((x as { failed?: unknown }).failed));
  if (!("checks" in run) && noChecks(expected.run.checks)) delete expected.run.checks;
  for (const [i, s] of expected.steps.entries()) {
    const c = tryOf(s as Shown["steps"][number]);
    const f = steps[i];
    if (!("checks" in f) && Array.isArray(s.checks) && !s.checks.length) delete s.checks;
    if (!c) continue;
    if (s.input === "" && fits(f.input, c.input)) s.input = f.input;
    if (s.output === "" && fits(f.output, c.output)) s.output = f.output;
    if (Array.isArray(s.sources) && !s.sources.length && Array.isArray(f.sources) && f.sources.length && sha256(canonicalJson(f.sources)) === c.sources) s.sources = f.sources;
    if (Array.isArray(s.checks) && !s.checks.length && Array.isArray(f.checks) && f.checks.length && c.checks && sha256(canonicalJson(f.checks)) === c.checks) s.checks = f.checks;
  }
  const shownRun = { ...run };
  delete shownRun.deleted;
  if (canonicalJson({ ...file, run: shownRun }) !== canonicalJson(expected)) return false;
  // The fingerprint says the same.
  const waits = steps.filter((x) => Number(x.waits) > 0);
  if (waits.reduce((n, x) => n + Number(x.waits), 0) !== (compact.waited ?? 0) || !waits.every((x) => x.credits === 0 && x.status === "waited")) return false;
  const tries = steps.filter((x) => Number(x.waits) === 0);
  if (tries.length !== compact.steps.length) return false;
  if (run.id !== compact.run || run.automationId !== compact.automation || run.name !== compact.name || run.version !== compact.version) return false;
  if (run.origin !== compact.trigger.origin || run.scheduledAt !== compact.trigger.at || sha256(String(run.summary)) !== compact.summary) return false;
  if (run.credits !== compact.credits || run.refunded !== (compact.refunded ?? 0) || run.status !== compact.status || run.outcome !== compact.outcome) return false;
  const runChecks = run.checks as { passed?: unknown; failed?: unknown } | undefined;
  if (Number(runChecks?.passed ?? 0) !== (compact.checks?.passed ?? 0) || Number(runChecks?.failed ?? 0) !== (compact.checks?.failed ?? 0)) return false;
  return tries.every((s) => {
    const c = tryOf(s as Shown["steps"][number]);
    if (!c || s.kind !== c.kind || s.status !== c.status || s.level !== c.level || s.model !== c.model || s.note !== c.note || s.held !== c.held || s.credits !== c.credits) return false;
    // Empty where Flash's record is empty too (above): compacted (the fingerprint has what it was), or nothing there.
    const text = (x: unknown, hash: string) => x === "" || fits(x, hash);
    const checks = Array.isArray(s.checks) ? s.checks : [];
    const checksFit = checks.length ? sha256(canonicalJson(checks)) === c.checks : true;
    return text(s.input, c.input) && text(s.output, c.output) && Array.isArray(s.sources) && (!s.sources.length || sha256(canonicalJson(s.sources)) === c.sources) && checksFit;
  });
}

/**
 * Checks a receipt the user saved earlier: its fingerprint is in the automation's chain (see
 * verifyReceipt), it is this run's, and what it shows in words is Flash's record and what was fingerprinted.
 * A file with no fingerprinted receipt (saved before the run ended) says so (unfinished).
 */
export async function checkReceipt(g: Gate, runId: string, body: Record<string, unknown>) {
  // Reads only: also a run of an automation being deleted, as its receipt is.
  const r = await ownRun(g.user, runId, { deleting: true });
  if (!r) return json({ error: g.t("Not found") }, 404);
  const file = body.receipt as Record<string, unknown> | undefined;
  // The whole download, or just its { prev, receipt, hash }.
  const saved = (!file || typeof file !== "object" ? null : "hash" in file && "prev" in file ? file : file.receipt) as SavedReceipt | null;
  if (!saved && file && typeof file === "object" && (file.run as { id?: unknown } | null)?.id === r.id && !file.fingerprint) return json({ matches: false, reason: "unfinished" });
  if (!saved || typeof saved !== "object" || saved.receipt?.run !== r.id) return json({ matches: false });
  if (!(await verifyReceipt(r.automation_id, saved).catch(() => false))) return json({ matches: false });
  const mine = await receipt(g, r.id);
  return json({ matches: Boolean(mine) && readableMatches(file!, saved.receipt, mine!) });
}

/** Stop, Retry (a new run, its price confirmed) and read (seen) on a run; only read on one of an automation being deleted. */
export async function actOnRun(g: Gate, runId: string, body: Record<string, unknown>) {
  const r = await ownRun(g.user, runId, { deleting: body.action === "read" });
  if (!r) return json({ error: g.t("Not found") }, 404);
  if (body.action === "stop") {
    if (Number(r.finished_at)) return json({ ok: true, status: r.status });
    await sql(`UPDATE automation_runs SET stop_requested = 1, updated_at = ${DB_NOW} WHERE id = ? AND finished_at = 0`, [r.id]);
    // Not started, or waiting between calls: it ends now, for nothing; one under way stops within 5 s.
    if (!r.lease_owner) await finish(r, "stopped", "stopped_by_user", { me: "" });
    const now = await one<{ status: string }>("SELECT status FROM automation_runs WHERE id = ?", [r.id]);
    return json({ ok: true, status: now?.status ?? r.status });
  }
  if (body.action === "read") {
    await sql(`UPDATE automation_runs SET seen_at = ${DB_NOW} WHERE id = ? AND seen_at = 0`, [r.id]);
    const link = automationLink(r.automation_id, r.id);
    await sql(`UPDATE notifications SET read_at = ${DB_NOW} WHERE user_id = ? AND link = ? AND read_at = 0`, [g.user.id, link]);
    return json({ ok: true });
  }
  if (body.action === "retry") {
    if (!Number(r.finished_at) || r.status === "done") return json({ error: g.t(SPEC_INVALID) }, 409);
    if (!automationsServer() || missingSetup().length) return json({ error: g.t("Something went wrong. Please try again."), missing: missingSetup() }, 503);
    const a = await ownAutomation(g.user, r.automation_id);
    if (!a || a.status === "paused") return json({ error: g.t(a ? NOTICES.paused : "Not found", { name: a?.name ?? "" }) }, a ? 409 : 404);
    // A retried run starts a run as Run now does, so it counts against Run now's limits too.
    const limited = await overRunLimits(g, a.id);
    if (limited) return limited;
    const spec = await versionSpec(a.id, Number(a.version));
    if (!spec) return json({ error: g.t(SPEC_INVALID) }, 409);
    const est = await estimateSpec(spec, g.user, a);
    if (!seenEnough(body.seenMax, est)) return priceChanged(g.t, est);
    const used = (await monthLeftRefusal(g.t, a, est)) ?? (await creditsRefusal(g.t, a, est));
    if (used) return used;
    return startOwnerRun(g, a, spec, `retry:${r.id}`, { type: "retry", of: r.id });
  }
  return json({ error: g.t(SPEC_INVALID) }, 400);
}

/** The Bell's automation notices, newest first, in the reader's words; and how many are unread. */
export async function listNotices(g: Gate) {
  const rows = await all<{ id: string; kind: string; phrase: string; blanks: string; link: string; created_at: number; read_at: number }>(
    "SELECT id, kind, phrase, blanks, link, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
    [g.user.id],
  );
  const unread = await one<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at = 0", [g.user.id]);
  return {
    notices: rows.map((n) => ({ id: n.id, kind: n.kind, ...noticeText(n, g.t), link: n.link, createdAt: Number(n.created_at), read: Number(n.read_at) > 0 })),
    unread: Number(unread?.n ?? 0),
    language: g.t.language,
  };
}

/** Marks notices read (at most 100 ids at once). */
export async function readNotices(g: Gate, body: Record<string, unknown>) {
  const ids = Array.isArray(body.read) ? body.read.filter((x): x is string => typeof x === "string" && x.length <= 64).slice(0, 100) : [];
  if (ids.length) {
    await sql(`UPDATE notifications SET read_at = ${DB_NOW} WHERE user_id = ? AND read_at = 0 AND id IN (${ids.map(() => "?").join(", ")})`, [g.user.id, ...ids]);
  }
  return { ok: true };
}

/** The burn-in card: the admin's own automations, their latest runs with holds, and the notices they made. */
export async function burnIn(g: Gate) {
  const rows = await all<Parameters<typeof automationView>[0]>(
    "SELECT * FROM automations WHERE user_id = ? AND status <> 'deleting' ORDER BY updated_at DESC LIMIT 20",
    [g.user.id],
  );
  // Runs of automations being deleted stay listed (marked) until their rows go, so a delete mid-run can be checked.
  // held: the largest hold of the run (its steps' holds come one after another, never together).
  // Worked out for the 20 runs shown only, each through its own holds (credit_holds_by_run).
  // waiting: its latest step row waits for another request's hold, a run's or a chat reply's (read through that run's own steps).
  const runs = await all<{ id: string; automation_id: string; name: string; deleting: number; status: string; outcome: string; origin: string; credits: number; refunded: number; scheduled_at: number; started_at: number; finished_at: number; created_at: number; parked: number; due_at: number; held: number; holds: number; open: number; waiting: number }>(
    `SELECT latest.id, latest.automation_id, a.name, a.status = 'deleting' AS deleting, latest.status, latest.outcome, latest.origin, latest.credits,
            latest.refunded, latest.scheduled_at,
            latest.started_at, latest.finished_at, latest.created_at, latest.parked, latest.due_at,
            COALESCE(MAX(h.held), 0) AS held, COUNT(h.ref) AS holds, COALESCE(SUM(CASE WHEN h.settled_at = 0 THEN 1 ELSE 0 END), 0) AS open,
            latest.finished_at = 0 AND (SELECT s.note FROM automation_run_steps s WHERE s.run_id = latest.id ORDER BY s.started_at DESC, s.attempt DESC LIMIT 1) = 'waiting' AS waiting
       FROM (SELECT * FROM automation_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20) latest
       JOIN automations a ON a.id = latest.automation_id
       LEFT JOIN credit_holds h ON h.run_id = latest.id
      GROUP BY latest.id ORDER BY latest.created_at DESC`,
    [g.user.id],
  );
  const month = await chargedAndHeld({ sql: "user_id = ?", args: [g.user.id] }, monthStart(Date.now()));
  return {
    automations: await Promise.all(rows.map((a) => automationView(a, g.t))),
    runs: runs.map((r) => ({
      id: r.id,
      automationId: r.automation_id,
      name: r.name,
      status: r.status,
      outcome: r.outcome,
      origin: r.origin,
      deleted: n(r.deleting) === 1,
      credits: n(r.credits),
      // Credits paid back because the run failed through Flash's fault (credits is what stays charged).
      refunded: n(r.refunded),
      held: n(r.held),
      holds: n(r.holds),
      openHolds: n(r.open),
      scheduledAt: n(r.scheduled_at),
      startedAt: n(r.started_at),
      finishedAt: n(r.finished_at),
      createdAt: n(r.created_at),
      // Not finished: parked (its automation paused, it waits for Resume), or due again at dueAt (a try later).
      parked: n(r.parked) === 1,
      dueAt: n(r.due_at),
      waiting: n(r.waiting) === 1,
    })),
    spentThisMonth: month.charged,
    heldNow: month.held,
    notices: (await listNotices(g)).notices.slice(0, 10),
    noticeLanguage: g.t.language,
    // The notices' language as Intl formats it (its digits too), for their times.
    noticeLocale: g.t.locale,
    // The live cron health lines only: the week's lag and peak spend come with /admin's lines (see cronHealth).
    health: await liveHealth(),
    setup: { server: automationsServer(), key: keyInUse(), missing: missingSetup(), sharedPaid: AUTOMATION_SHARED_PAID, open: await openToEveryone() },
  };
}

/** How a burn-in name says a step's mode. */
const MODE_NAMES = { write: "Write", research: "Research", quick: "Quick research" } as const;

/**
 * The test automations the burn-in card makes: a one-off 3 minutes ahead, a daily one, and one run by
 * hand. Each is named with its level, its mode and the start of its instruction, so they tell apart.
 */
export function burnInSpec(kind: "once" | "daily" | "manual", timeZone: string, prompt: string, level: "sonic" | "ascend" | "vision" | "ultra", mode: "write" | "research" | "quick"): { spec: Spec; name: string } {
  const step = { id: "a1", do: "ai" as const, mode, level, prompt };
  const notify = { id: "n1", do: "notify" as const };
  // The instruction goes between the kind and the level, so the name starts and ends with letters
  // and keeps its order inside right-to-left notices.
  const named = (base: string) => {
    const tail = `${LEVELS.find((l) => l.id === level)!.short} ${MODE_NAMES[mode]}`;
    const words = prompt.replace(/\s+/g, " ").trim();
    const room = MAX_NAME_CHARS - base.length - tail.length - 8;
    if (!words || room < 8) return `${base} · ${tail}`;
    return `${base} · "${words.length > room ? `${words.slice(0, room - 1).trimEnd()}…` : words}" · ${tail}`;
  };
  if (kind === "manual") return { name: named("Burn-in: run by hand"), spec: { v: 1, trigger: { type: "manual" }, steps: [step, notify] } };
  const local = (ms: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        .formatToParts(ms)
        .map((p) => [p.type, p.value]),
    );
    return { date: `${parts.year}-${parts.month}-${parts.day}`, at: `${parts.hour}:${parts.minute}` };
  };
  if (kind === "once") {
    const at = local(Date.now() + 3 * 60_000 + 30_000);
    return { name: named("Burn-in: one-off in 3 minutes"), spec: { v: 1, trigger: { type: "schedule", when: { kind: "once", date: at.date, at: at.at } }, steps: [step, notify] } };
  }
  const at = local(Date.now() + 5 * 60_000);
  return { name: named("Burn-in: every day"), spec: { v: 1, trigger: { type: "schedule", when: { kind: "daily", at: at.at } }, steps: [step, notify] } };
}

