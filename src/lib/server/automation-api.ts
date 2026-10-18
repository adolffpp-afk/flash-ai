/*
 * What the automation routes do (src/app/api/automations/**, api/notifications, api/admin/automations),
 * kept here so each route is a few lines and the tests can reach it.
 *
 * Every route: signed in (401), and open to this account (automationsOpenTo: in PR 1a admins only, so
 * everyone else gets 404); writes also come from Flash's own page with a confirmed email (403), and
 * each route counts against its own limit (429). Ownership is automations.user_id. No GET writes
 * anything but its own rate-limit row. Foreign keys are off, so every delete names each table.
 *
 * Money: what an automation says it costs at most (its estimate's worst case) is what the user saw
 * (seenMax); saving, turning on, running by hand and retrying price it again and answer 409
 * price_changed with the new price if it went up, saving nothing. Nothing here charges credits: only
 * a run's steps do (automation-steps.ts).
 */
import { after } from "next/server";
import { gunzipSync } from "node:zlib";
import { FINISHED, isPaid, MAX_NAME_CHARS, MAX_ON, MAX_SUB_DAILY, NOTICES, parseSpec, PRICE_CHANGED, QUEUED, runnerFor, SPEC_INVALID, TOO_MANY_ON, TOO_MANY_SUB_DAILY, describeNext, describeWhen, type Spec } from "../automations.ts";
import { validTimeZone } from "../context-note.ts";
import { monthStart, nextFire, nextFires, ONCE_MAX_AHEAD_MS, ONCE_MIN_AHEAD_MS, subDaily } from "../schedule.ts";
import { isVerified } from "./account.ts";
import { fromOwnPage, getUser, unauthorized, type User } from "./auth.ts";
import { estimateSpec, type Estimate } from "./automation-estimate.ts";
import { advanceRun, finish, savedReceipt, verifyReceipt, versionSpec } from "./automation-runner.ts";
import { outputText, type AutoRow, type RunRow } from "./automation-steps.ts";
import { deleteAutomationNow } from "./automation-tick.ts";
import { cronHealth } from "./automation-admin.ts";
import { AUTOMATION_SHARED_PAID, automationsOpenTo, automationsServer, claimLimits, keyInUse, missingSetup } from "./automations.ts";
import { automationSpent } from "./credits.ts";
import { all, db, one, run as sql } from "./db.ts";
import { translatorFor, type ServerT } from "./i18n.ts";
import { randomId } from "./ids.ts";
import { DB_NOW, insertOwnerRun } from "./leases.ts";
import { overLimit } from "./limits.ts";
import { automationLink, noticeText } from "./notifications.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A run started by hand moves on in its own request for this long (its route's maxDuration is 800 s). */
export const OWNER_RUN_MS = 760_000;

/** Each route's limit: [most, per window in ms]. */
export const LIMITS = {
  list: [300, 10 * MINUTE],
  create: [30, HOUR],
  estimate: [300, HOUR],
  edit: [120, 10 * MINUTE],
  runAutomation: [10, HOUR],
  runUser: [30, HOUR],
  read: [300, 10 * MINUTE],
  act: [60, 10 * MINUTE],
  admin: [60, 10 * MINUTE],
} as const satisfies Record<string, readonly [number, number]>;

export type Gate = { user: User; t: ServerT };
const json = (body: unknown, status = 200) => Response.json(body, { status });
const n = (v: unknown) => Number(v ?? 0);

/**
 * Who may call an automation route (see the top of this file). limit names the route's limit; key
 * makes it per automation as well as per account.
 */
export async function gate(request: Request, o: { write?: boolean; limit: keyof typeof LIMITS; key?: string }): Promise<Gate | Response> {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (!automationsOpenTo(user)) return json({ error: t("Not found") }, 404);
  if (o.write) {
    if (!fromOwnPage(request)) return json({ error: t("Please use Flash's own page.") }, 403);
    if (!isVerified(user)) return json({ error: t(NOTICES.unconfirmed) }, 403);
  }
  const [max, windowMs] = LIMITS[o.limit];
  if (await overLimit(`auto:${o.limit}:${o.key ?? user.id}`, max, windowMs)) {
    return json({ error: windowMs >= HOUR ? t("Too many requests. Try again in an hour.") : t("Too many tries. Please wait a few minutes.") }, 429);
  }
  return { user, t };
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

/** A run of this user's (of an automation not being deleted). */
export const ownRun = (user: User, runId: string) =>
  one<RunRow & { trigger_json: string; receipt: string; receipt_hash: string; seen_at: number; summary: string; due_at: number; parked: number }>(
    "SELECT r.* FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE r.id = ? AND r.user_id = ? AND a.user_id = ? AND a.status <> 'deleting'",
    [runId, user.id, user.id],
  );

/** An automation as the routes return it, in the reader's language. */
export async function automationView(a: Row, t: ServerT) {
  const spec = await versionSpec(a.id, Number(a.version));
  const when = spec?.trigger.type === "schedule" ? spec.trigger.when : null;
  const schedule = when ? describeWhen(when, a.time_zone, t, t.locale) : null;
  const upcoming = when && a.status === "on" ? nextFires(when, a.time_zone, Date.now(), 3) : [];
  const unseen = await one<{ n: number }>("SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id = ? AND finished_at > 0 AND seen_at = 0", [a.id]);
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
    next: upcoming.length ? describeNext(upcoming, a.time_zone, t, t.locale) : "",
    capRun: Number(a.cap_run),
    capMonth: Number(a.cap_month),
    quotedMax: Number(a.quoted_max),
    spentThisMonth: await automationSpent(a.id, monthStart(Date.now())),
    lastStatus: a.last_status,
    lastRunAt: Number(a.last_run_at),
    unseen: Number(unseen?.n ?? 0),
    createdAt: Number(a.created_at),
    updatedAt: Number(a.updated_at),
  };
}

export async function listAutomations(g: Gate) {
  const rows = await all<Row>("SELECT * FROM automations WHERE user_id = ? AND status <> 'deleting' ORDER BY updated_at DESC LIMIT 100", [g.user.id]);
  return { automations: await Promise.all(rows.map((a) => automationView(a, g.t))) };
}

type Fields = { spec: Spec; name: string; timeZone: string };

/** The fields of a create or an edit, checked: a refusal answers 400 in the reader's words. */
function fieldsOf(body: Record<string, unknown>, t: ServerT, was?: Row & { spec: Spec | null }): Fields | Response {
  const parsed = body.spec === undefined && was?.spec ? { spec: was.spec } : parseSpec(body.spec);
  if ("error" in parsed) return json({ error: t(parsed.error, parsed.blanks) }, 400);
  const name = body.name === undefined && was ? was.name : typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim() : "";
  const timeZone = body.timeZone === undefined && was ? was.time_zone : validTimeZone(body.timeZone);
  if (!name || name.length > MAX_NAME_CHARS || !timeZone) return json({ error: t(SPEC_INVALID) }, 400);
  // A one-off between 2 minutes and a year ahead (a time already gone has no slot).
  const when = parsed.spec.trigger.type === "schedule" ? parsed.spec.trigger.when : null;
  if (when?.kind === "once") {
    const slot = nextFire(when, timeZone, Date.now());
    if (!slot || slot < Date.now() + ONCE_MIN_AHEAD_MS || slot > Date.now() + ONCE_MAX_AHEAD_MS) return json({ error: t(SPEC_INVALID) }, 400);
  }
  return { spec: parsed.spec, name, timeZone };
}

/** A limit from the body (whole credits, 1 to 100,000), or the default. */
function capOf(v: unknown, fallback: number): number | null {
  if (v === undefined || v === null) return fallback;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 100_000 ? v : null;
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
  if (on.length >= MAX_ON) return json({ error: t(TOO_MANY_ON, { count: MAX_ON }) }, 409);
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

/** Prices a draft, saving nothing. */
export async function estimate(g: Gate, body: Record<string, unknown>) {
  const f = fieldsOf({ name: "Estimate", timeZone: "UTC", ...body }, g.t);
  if (f instanceof Response) return f;
  return json({ estimate: await estimateSpec(f.spec, g.user, { name: f.name, time_zone: f.timeZone, where_json: "{}", language: g.user.language ?? "" }) });
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
  const f = fieldsOf(body, g.t, { ...a, spec });
  if (f instanceof Response) return f;
  const edited = body.spec !== undefined || body.name !== undefined || body.timeZone !== undefined;
  const status = body.status === "on" || body.status === "paused" ? body.status : a.status;
  const turningOn = status === "on" && a.status !== "on";
  if (status === "on" && a.status === "finished" && !edited) return json({ error: g.t(FINISHED) }, 409);
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
  const nextAt = status === "on" && (turningOn || edited) ? nextSlot(f.spec, f.timeZone) : Number(a.next_at);
  // A pause by its owner never ends by itself; turned on, every pause is over.
  const pause =
    status === a.status
      ? { reason: a.paused_reason, at: Number(a.paused_at), resumeAt: Number(a.resume_at), need: Number(a.need_credits) }
      : status === "paused"
        ? { reason: "user", at: Date.now(), resumeAt: 0, need: 0 }
        : { reason: "", at: 0, resumeAt: 0, need: 0 };
  const t = Date.now();
  const rs = await (await db()).batch(
    [
      {
        // Only over the automation as it was read: a run pausing it meanwhile, or another edit, wins.
        sql: `UPDATE automations SET name = ?, time_zone = ?, version = ?, trigger_kind = ?, status = ?, next_at = ?, cap_run = ?, cap_month = ?, quoted_max = ?,
                     paused_reason = ?, paused_at = ?, resume_at = ?, need_credits = ?, fail_streak = CASE WHEN ? = 1 THEN 0 ELSE fail_streak END, updated_at = ${DB_NOW}
               WHERE id = ? AND user_id = ? AND version = ? AND status = ?`,
        args: [
          f.name,
          f.timeZone,
          version,
          f.spec.trigger.type,
          status,
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
      // Paused, its runs that haven't started wait with it; turned on, they go on.
      {
        sql: `UPDATE automation_runs SET parked = ?, updated_at = ${DB_NOW}
               WHERE automation_id = ? AND status IN ('queued','waiting') AND lease_until < ${DB_NOW} AND parked <> ?
                 AND EXISTS (SELECT 1 FROM automations WHERE id = ? AND status = ?)`,
        args: [status === "paused" ? 1 : 0, a.id, status === "paused" ? 1 : 0, a.id, status],
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
  // Leased to this request: it moves the run on after answering, within this route's time.
  if (run.owner) {
    const { id, owner } = run;
    after(() => advanceRun(id, owner, Date.now() + OWNER_RUN_MS).catch((err) => console.error("[flash] automation run failed", err instanceof Error ? err.name : "error")));
  }
  return json({ run: { id: run.id, status: run.status }, ...(run.status === "queued" && { note: g.t(QUEUED) }) }, run.existing ? 200 : 202);
}

/** An automation's runs, newest first, 20 a page (cursor: the last one's created_at). */
export async function listRuns(g: Gate, id: string, cursor: string | null) {
  const a = await ownAutomation(g.user, id);
  if (!a) return json({ error: g.t("Not found") }, 404);
  const before = Number(cursor) > 0 ? Number(cursor) : Number.MAX_SAFE_INTEGER;
  const rows = await all<RunRow & { summary: string; seen_at: number }>(
    `SELECT id, status, outcome, origin, credits, summary, scheduled_at, started_at, finished_at, created_at, seen_at FROM automation_runs
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
      summary: r.summary,
      scheduledAt: Number(r.scheduled_at),
      startedAt: Number(r.started_at),
      finishedAt: Number(r.finished_at),
      createdAt: Number(r.created_at),
      seen: Number(r.seen_at) > 0,
    })),
    cursor: rows.length > 20 ? String(page.at(-1)!.created_at) : null,
  });
}

/** What a step's note says, in the reader's words, where it has one. */
const NOTE_PHRASES: Record<string, string> = { cut_short: NOTICES.cutShort, interrupted: NOTICES.interrupted, missed: NOTICES.missed, overlap: NOTICES.overlap };

/** A run's receipt: what started it, each attempt of each step with its hold, and its fingerprint. Reads only. */
export async function receipt(g: Gate, runId: string) {
  const r = await ownRun(g.user, runId);
  if (!r) return null;
  const steps = await all<{ step_id: string; attempt: number; kind: string; status: string; input: string; output: Uint8Array | null; note: string; hold_ref: string; held: number; credits: number; level: string; model: string; started_at: number; finished_at: number }>(
    "SELECT * FROM automation_run_steps WHERE run_id = ? ORDER BY started_at, attempt",
    [r.id],
  );
  const holds = await all<{ ref: string; held: number; credits: number; started: number; done: number; settled_at: number; created_at: number }>(
    "SELECT ref, held, credits, started, done, settled_at, created_at FROM credit_holds WHERE run_id = ? ORDER BY created_at",
    [r.id],
  );
  const a = await one<{ name: string }>("SELECT name FROM automations WHERE id = ?", [r.automation_id]);
  const saved = savedReceipt(r);
  const sourcesOf = (output: Uint8Array | null) => {
    try {
      const parsed = output ? (JSON.parse(gunzipSync(Buffer.from(output)).toString("utf8")) as { sources?: { url: string; title?: string }[] }) : {};
      return (parsed.sources ?? []).map((s) => ({ url: s.url, title: s.title ?? "" }));
    } catch {
      return [];
    }
  };
  return {
    run: {
      id: r.id,
      automationId: r.automation_id,
      name: a?.name ?? "",
      version: Number(r.version),
      origin: r.origin,
      trigger: JSON.parse(r.trigger_json || "{}") as unknown,
      status: r.status,
      outcome: r.outcome,
      credits: Number(r.credits),
      summary: r.summary,
      scheduledAt: Number(r.scheduled_at),
      startedAt: Number(r.started_at),
      finishedAt: Number(r.finished_at),
      createdAt: Number(r.created_at),
      stopRequested: Number(r.stop_requested) > 0,
    },
    steps: steps.map((s) => ({
      stepId: s.step_id,
      attempt: Number(s.attempt),
      kind: s.kind,
      status: s.status,
      level: s.level,
      model: s.model,
      held: Number(s.held),
      credits: Number(s.credits),
      note: s.note,
      noteText: NOTE_PHRASES[s.note] ? g.t(NOTE_PHRASES[s.note], { credits: Number(s.credits) }) : "",
      input: s.input,
      output: outputText(s.output),
      sources: sourcesOf(s.output),
      holdRef: s.hold_ref,
      startedAt: Number(s.started_at),
      finishedAt: Number(s.finished_at),
    })),
    holds: holds.map((h) => ({ ref: h.ref, held: Number(h.held), credits: Number(h.credits), started: Number(h.started) > 0, done: Number(h.done) > 0, settledAt: Number(h.settled_at), createdAt: Number(h.created_at) })),
    // The fingerprint and the compact receipt it was made from (empty until the run ends).
    fingerprint: r.receipt_hash,
    receipt: saved,
  };
}

/** Checks a receipt the user saved earlier against the automation's chain (see verifyReceipt). */
export async function checkReceipt(g: Gate, runId: string, body: Record<string, unknown>) {
  const r = await ownRun(g.user, runId);
  if (!r) return json({ error: g.t("Not found") }, 404);
  const file = body.receipt as { receipt?: unknown } | undefined;
  const saved = file && typeof file === "object" ? (file.receipt ?? file) : null;
  const ok = saved && typeof saved === "object" ? await verifyReceipt(r.automation_id, saved as never).catch(() => false) : false;
  return json({ matches: ok });
}

/** Stop, Retry (a new run, its price confirmed) and read (seen) on a run. */
export async function actOnRun(g: Gate, runId: string, body: Record<string, unknown>) {
  const r = await ownRun(g.user, runId);
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
    const spec = await versionSpec(a.id, Number(a.version));
    if (!spec) return json({ error: g.t(SPEC_INVALID) }, 409);
    const est = await estimateSpec(spec, g.user, a);
    if (!seenEnough(body.seenMax, est)) return priceChanged(g.t, est);
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
  const runs = await all<{ id: string; automation_id: string; name: string; status: string; outcome: string; origin: string; credits: number; scheduled_at: number; started_at: number; finished_at: number; created_at: number; held: number; open: number }>(
    `SELECT r.id, r.automation_id, a.name, r.status, r.outcome, r.origin, r.credits, r.scheduled_at, r.started_at, r.finished_at, r.created_at,
            (SELECT COALESCE(SUM(held), 0) FROM credit_holds h WHERE h.run_id = r.id) AS held,
            (SELECT COUNT(*) FROM credit_holds h WHERE h.run_id = r.id AND h.settled_at = 0) AS open
       FROM automation_runs r JOIN automations a ON a.id = r.automation_id
      WHERE r.user_id = ? AND a.status <> 'deleting' ORDER BY r.created_at DESC LIMIT 20`,
    [g.user.id],
  );
  const spent = await one<{ credits: number }>(
    "SELECT COALESCE(-SUM(amount), 0) AS credits FROM credit_ledger WHERE user_id = ? AND automation_id <> '' AND amount < 0 AND created_at >= ?",
    [g.user.id, monthStart(Date.now())],
  );
  return {
    automations: await Promise.all(rows.map((a) => automationView(a, g.t))),
    runs: runs.map((r) => ({
      id: r.id,
      automationId: r.automation_id,
      name: r.name,
      status: r.status,
      outcome: r.outcome,
      origin: r.origin,
      credits: n(r.credits),
      held: n(r.held),
      openHolds: n(r.open),
      scheduledAt: n(r.scheduled_at),
      startedAt: n(r.started_at),
      finishedAt: n(r.finished_at),
      createdAt: n(r.created_at),
    })),
    spentThisMonth: n(spent?.credits),
    notices: (await listNotices(g)).notices.slice(0, 10),
    noticeLanguage: g.t.language,
    health: await cronHealth(),
    setup: { server: automationsServer(), key: keyInUse(), missing: missingSetup(), sharedPaid: AUTOMATION_SHARED_PAID },
  };
}

/** The test automations the burn-in card makes: a one-off 3 minutes ahead, a daily one, and one run by hand. */
export function burnInSpec(kind: "once" | "daily" | "manual", timeZone: string, prompt: string, level: "sonic" | "ascend" | "vision" | "ultra", mode: "write" | "research" | "quick"): { spec: Spec; name: string } {
  const step = { id: "a1", do: "ai" as const, mode, level, prompt };
  const notify = { id: "n1", do: "notify" as const };
  if (kind === "manual") return { name: "Burn-in: run by hand", spec: { v: 1, trigger: { type: "manual" }, steps: [step, notify] } };
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
    return { name: "Burn-in: one-off in 3 minutes", spec: { v: 1, trigger: { type: "schedule", when: { kind: "once", date: at.date, at: at.at } }, steps: [step, notify] } };
  }
  const at = local(Date.now() + 5 * 60_000);
  return { name: "Burn-in: every day", spec: { v: 1, trigger: { type: "schedule", when: { kind: "daily", at: at.at } }, steps: [step, notify] } };
}

