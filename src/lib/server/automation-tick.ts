/*
 * The per-minute tick (api/cron/tick): finds automation work that is due and hands it out. One tick:
 *   0. settles credit holds left behind (the reaper), before anything can claim their runs;
 *   1. turns paused automations back on when their pause ends (a new month, credits that arrived);
 *   2. turns due schedules into runs, once per slot whatever happens (a unique run key and a
 *      compare-and-set on next_at): a slot past its grace window is missed, one that would overlap a
 *      run still going is skipped, an older slot that never started is superseded, all for free, and
 *      the next slot is always the first after now, so an outage never makes a burst;
 *   3. marks scheduled runs that never started a step by the end of their grace window (queued, claimed
 *      but never sent, or waiting to try again) as missed, never charged;
 *   4. claims what it can start now, within the account's and Flash's limits (see claimRuns), and
 *   5. sends each claimed run to its own work call at once;
 *   6. once a day: deletes automations being deleted, compacts old receipts, prunes notices, versions
 *      and rate limits, and checks the month's capacity.
 * anythingDue answers whether a tick has anything to do with indexed reads only, so an empty tick
 * writes nothing.
 */
import { isPaid, NOTICES, parseSpec, type Spec } from "../automations.ts";
import { graceFor, monthStart, nextFire, nextMonthStart, utcDay } from "../schedule.ts";
import { reapLapsed } from "./automation-runner.ts";
import { claimLimits, cronSecret } from "./automations.ts";
import { balance, ensureMonthlyCredits, topUpFloor } from "./credits.ts";
import { all, db, one, run as sql } from "./db.ts";
import { randomId } from "./ids.ts";
import { claimRuns, DB_NOW, probe } from "./leases.ts";
import { automationLink, notify } from "./notifications.ts";

const DAY = 86_400_000;

/**
 * Whether a tick has anything to do, each an indexed SELECT 1 (parked runs aren't in the due index):
 * a due schedule, a due run (or one whose lease ran out), a hold left behind, a pause to check, and
 * the daily job not done today (UTC).
 */
export const DUE_CHECKS = [
  `SELECT 1 FROM automations WHERE status = 'on' AND next_at > 0 AND next_at <= ${DB_NOW} LIMIT 1`,
  `SELECT 1 FROM automation_runs WHERE parked = 0 AND status IN ('queued','waiting','running','approval') AND due_at <= ${DB_NOW} AND lease_until < ${DB_NOW} LIMIT 1`,
  `SELECT 1 FROM credit_holds WHERE settled_at = 0 AND lease_until < ${DB_NOW} LIMIT 1`,
  `SELECT 1 FROM automations WHERE status = 'paused' AND resume_at > 0 AND resume_at <= ${DB_NOW} LIMIT 1`,
];
const DAILY_KEY = "auto:daily";
const CAPACITY_KEY = "auto:capacity";
/** This month's estimated writes, counted by the daily job ({ month, writes }), for /admin. */
const WRITES_KEY = "auto:writes";

/**
 * A run that never started a step: nothing done or charged, no lease and no hold open. Claimed runs are
 * 'running' from their claim, so this is what a slot whose work call never arrived looks like too.
 */
const NEVER_STARTED = `step = '' AND credits = 0 AND lease_until < ${DB_NOW}
  AND NOT EXISTS (SELECT 1 FROM credit_holds h WHERE h.run_id = automation_runs.id AND h.settled_at = 0 AND h.run_id <> '')`;

/** Step rows a never-started run left running (a server that stopped before its hold), closed with it. */
async function closeLeftSteps(runIds: string[]) {
  for (let i = 0; i < runIds.length; i += 200) {
    const chunk = runIds.slice(i, i + 200);
    await sql(
      `UPDATE automation_run_steps SET status = 'interrupted', note = 'interrupted', finished_at = ${DB_NOW}
        WHERE status = 'running' AND run_id IN (${chunk.map(() => "?").join(",")})`,
      chunk,
    );
  }
}

export async function anythingDue(): Promise<boolean> {
  for (const check of DUE_CHECKS) if (await one(check)) return true;
  const daily = await one<{ value: string }>("SELECT value FROM settings WHERE key = ?", [DAILY_KEY]);
  return !daily || daily.value < utcDay(Date.now());
}

/** Sends a claimed run to its own work call (the tick waits only for its 202). */
export type Dispatch = (claim: { id: string; owner: string }) => Promise<void>;

const DISPATCH_TIMEOUT_MS = 10_000;

/**
 * A work call for a claimed run, to Flash itself (FLASH_APP_URL) with the cron secret: never through
 * safeFetch, never with its outbound header, and never following a redirect. A call that doesn't
 * arrive leaves the claim's lease to run out, and the run is claimed again.
 */
export const dispatchWork: Dispatch = async ({ id, owner }) => {
  const base = process.env.FLASH_APP_URL;
  if (!base) return;
  try {
    const res = await fetch(new URL("/api/cron/work", base), {
      method: "POST",
      headers: { authorization: `Bearer ${cronSecret()}`, "content-type": "application/json" },
      body: JSON.stringify({ runId: id, owner }),
      redirect: "manual",
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
    if (res.status !== 202) console.error("[flash] automation work call answered", res.status);
    await res.body?.cancel();
  } catch (err) {
    console.error("[flash] automation work call failed", err instanceof Error ? err.name : "error");
  }
};

export type TickReport = { reaped: number; resumed: number; scheduled: number; missed: number; claimed: number; daily: boolean };

/** One tick (see the top of this file). worker names this tick in the claims it makes. */
export async function runTick(worker: string, o: { dispatch?: Dispatch } = {}): Promise<TickReport> {
  const report: TickReport = { reaped: 0, resumed: 0, scheduled: 0, missed: 0, claimed: 0, daily: false };
  const step = async (name: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (err) {
      console.error(`[flash] automation tick: ${name} failed`, err instanceof Error ? err.name : "error");
    }
  };
  await step("reaper", async () => void (report.reaped = await reapLapsed()));
  await step("resumes", async () => void (report.resumed = await resumePaused()));
  await step("schedules", async () => void (report.scheduled = await enqueueDue()));
  await step("late runs", async () => void (report.missed = await missLate()));
  const dispatch = o.dispatch ?? (process.env.FLASH_APP_URL ? dispatchWork : null);
  // Only what is sent now is claimed, so nothing claimed waits while its lease runs out.
  if (dispatch) {
    await step("claims", async () => {
      const claimed = await claimRuns(worker, await claimLimits());
      report.claimed = claimed.length;
      await Promise.allSettled(claimed.map((c) => dispatch(c)));
    });
  }
  await step("daily job", async () => void (report.daily = await dailyJob()));
  return report;
}

/** A version's spec, or null for one that no longer parses. */
function specOf(text: string): Spec | null {
  try {
    const parsed = parseSpec(JSON.parse(text));
    return "spec" in parsed ? parsed.spec : null;
  } catch {
    return null;
  }
}

/** The next slot of a schedule after a moment, or 0 when it has none (a one-off). */
const nextSlot = (spec: Spec | null, timeZone: string, after: number) =>
  spec?.trigger.type === "schedule" && spec.trigger.when.kind !== "once" ? nextFire(spec.trigger.when, timeZone, after) : 0;

/**
 * Pauses that end now: a month (or day) limit at its reset, and a wait for credits, checked at the
 * next slot (at most once a day) after granting any monthly credits due. Their parked runs go on.
 */
async function resumePaused(): Promise<number> {
  const rows = await all<{
    id: string;
    pay_account: string;
    paused_reason: string;
    resume_at: number;
    need_credits: number;
    next_at: number;
    time_zone: string;
    spec: string;
  }>(
    `SELECT a.id, a.pay_account, a.paused_reason, a.resume_at, a.need_credits, a.next_at, a.time_zone, v.spec
       FROM automations a JOIN automation_versions v ON v.automation_id = a.id AND v.version = a.version
      WHERE a.status = 'paused' AND a.resume_at > 0 AND a.resume_at <= ${DB_NOW} LIMIT 100`,
  );
  let resumed = 0;
  for (const a of rows) {
    const spec = specOf(a.spec);
    const now = Date.now();
    let turnOn = a.paused_reason === "month_cap" || a.paused_reason === "day_cap";
    if (a.paused_reason === "credits") {
      await ensureMonthlyCredits(a.pay_account);
      turnOn = (await balance(a.pay_account)) - (await topUpFloor(a.pay_account)) >= Number(a.need_credits);
    }
    const grace = spec?.trigger.type === "schedule" ? graceFor(spec.trigger.when) : 0;
    // A slot still in its grace window runs; otherwise the next one after now.
    const next = Number(a.next_at) && Number(a.next_at) + grace >= now ? Number(a.next_at) : nextSlot(spec, a.time_zone, now);
    if (turnOn) {
      const rs = await (await db()).batch(
        [
          {
            sql: `UPDATE automations SET status = 'on', paused_reason = '', paused_at = 0, resume_at = 0, need_credits = 0, next_at = ?, updated_at = ${DB_NOW}
                   WHERE id = ? AND status = 'paused' AND paused_reason = ? AND resume_at = ?`,
            args: [next, a.id, a.paused_reason, a.resume_at],
          },
          {
            sql: `UPDATE automation_runs SET parked = 0, updated_at = ${DB_NOW} WHERE automation_id = ? AND finished_at = 0 AND parked = 1 AND EXISTS (SELECT 1 FROM automations WHERE id = ? AND status = 'on')`,
            args: [a.id, a.id],
          },
        ],
        "write",
      );
      if (rs[0].rowsAffected === 1) resumed++;
    } else if (a.paused_reason === "credits") {
      // Still short: looked at again at the next slot, at most once a day.
      await sql(`UPDATE automations SET resume_at = ?, next_at = ?, updated_at = ${DB_NOW} WHERE id = ? AND status = 'paused' AND resume_at = ?`, [
        Math.max(nextSlot(spec, a.time_zone, now), now + DAY),
        next,
        a.id,
        a.resume_at,
      ]);
    } else {
      // A pause only its owner ends (price up, failing): nothing to look at by itself.
      await sql(`UPDATE automations SET resume_at = 0 WHERE id = ? AND status = 'paused' AND resume_at = ?`, [a.id, a.resume_at]);
    }
  }
  return resumed;
}

/** Whether this month's automation capacity is reached: hourly slots are then skipped, for free. */
async function capacityFull(): Promise<boolean> {
  const row = await one<{ value: string }>("SELECT value FROM settings WHERE key = ?", [CAPACITY_KEY]);
  return row?.value === utcDay(Date.now()).slice(0, 7);
}

/**
 * Turns due schedules into runs (at most 200 a tick), each in one batch: an older slot that never
 * started (queued, claimed or waiting to try again, see NEVER_STARTED) is superseded, the slot's run is
 * inserted (queued, or skipped as missed, overlapping or over capacity) once per slot, and next_at moves
 * to the first slot after now by compare-and-set. Each reads only the automation's unfinished runs.
 */
async function enqueueDue(): Promise<number> {
  const due = await all<{ id: string; user_id: string; name: string; next_at: number; time_zone: string; spec: string }>(
    `SELECT a.id, a.user_id, a.name, a.next_at, a.time_zone, v.spec
       FROM automations a JOIN automation_versions v ON v.automation_id = a.id AND v.version = a.version
      WHERE a.status = 'on' AND a.next_at > 0 AND a.next_at <= ${DB_NOW} ORDER BY a.next_at LIMIT 200`,
  );
  if (!due.length) return 0;
  const full = await capacityFull();
  let made = 0;
  for (const a of due) {
    const spec = specOf(a.spec);
    const slot = Number(a.next_at);
    if (!spec || spec.trigger.type !== "schedule") {
      // Nothing to run on a clock: it waits for its owner.
      await sql(`UPDATE automations SET next_at = 0, updated_at = ${DB_NOW} WHERE id = ? AND next_at = ?`, [a.id, slot]);
      continue;
    }
    const when = spec.trigger.when;
    const once = when.kind === "once" ? 1 : 0;
    const next = once ? 0 : nextFire(when, a.time_zone, Date.now());
    const key = `sched:${slot}`;
    const trigger = JSON.stringify({ type: "schedule", slot });
    const overCapacity = full && when.kind === "hourly" ? 1 : 0;
    await probe("before-enqueue", { automationId: a.id });
    const rs = await (await db()).batch(
      [
        {
          sql: `UPDATE automation_runs SET status = 'skipped', outcome = 'superseded', finished_at = ${DB_NOW}, updated_at = ${DB_NOW}, lease_owner = '', lease_until = 0
                 WHERE automation_id = ? AND finished_at = 0 AND origin = 'schedule' AND status IN ('queued','running') AND ${NEVER_STARTED} AND run_key <> ?
                   AND EXISTS (SELECT 1 FROM automations WHERE id = ? AND next_at = ? AND status = 'on')
                RETURNING id`,
          args: [a.id, key, a.id, slot],
        },
        {
          sql: `INSERT INTO automation_runs (id, automation_id, user_id, version, run_key, origin, root_origin, status, outcome, trigger_json,
                                             next_paid, due_at, grace_until, scheduled_at, finished_at, created_at, updated_at)
                SELECT ?, a.id, a.user_id, a.version, ?, 'schedule', 'schedule', CASE WHEN k.why = '' THEN 'queued' ELSE 'skipped' END, k.why, ?,
                       ?, k.now, ?, ?, CASE WHEN k.why = '' THEN 0 ELSE k.now END, k.now, k.now
                  FROM automations a,
                       (SELECT c.now, CASE WHEN ? = 1 THEN 'capacity'
                                           WHEN ? < c.now THEN 'missed'
                                           WHEN EXISTS (SELECT 1 FROM automation_runs r WHERE r.automation_id = ? AND r.finished_at = 0
                                                          AND r.status IN ('running','waiting','approval')) THEN 'overlap'
                                           ELSE '' END AS why
                          FROM (SELECT ${DB_NOW} AS now) c) k
                 WHERE a.id = ? AND a.status = 'on' AND a.next_at = ?
                ON CONFLICT(automation_id, run_key) DO NOTHING
                RETURNING id, status, outcome`,
          args: [
            randomId(),
            key,
            trigger,
            isPaid(spec.steps[0]) ? 1 : 0,
            slot + graceFor(when),
            slot,
            overCapacity,
            slot + graceFor(when),
            a.id,
            a.id,
            slot,
          ],
        },
        {
          // A one-off is done with once its slot is taken; one skipped is finished now.
          sql: `UPDATE automations SET next_at = ?, last_run_at = ${DB_NOW}, updated_at = ${DB_NOW},
                       status = CASE WHEN ? = 1 AND EXISTS (SELECT 1 FROM automation_runs WHERE automation_id = ? AND run_key = ? AND status = 'skipped')
                                     THEN 'finished' ELSE status END
                 WHERE id = ? AND next_at = ? AND status = 'on'`,
          args: [next, once, a.id, key, a.id, slot],
        },
      ],
      "write",
    );
    if (rs[0].rows.length) await closeLeftSteps(rs[0].rows.map((r) => String(r.id)));
    const inserted = rs[1].rows[0] as unknown as { id: string; status: string; outcome: string } | undefined;
    if (!inserted) continue;
    made++;
    const link = automationLink(a.id, String(inserted.id));
    if (inserted.outcome === "missed") {
      await notify({ userId: a.user_id, kind: "missed", phrase: NOTICES.missed, blanks: { name: a.name }, link, ref: `missed:${a.id}:${utcDay(Date.now())}` });
    } else if (inserted.outcome === "capacity") {
      const month = utcDay(Date.now()).slice(0, 7);
      await notify({ userId: a.user_id, kind: "missed", phrase: NOTICES.capacity, blanks: { name: a.name, date: nextMonthStart(Date.now()) }, link, ref: `capacity:${a.id}:${month}` });
    }
  }
  return made;
}

/**
 * Scheduled runs past their grace window that never started a step (queued, claimed but never sent,
 * or waiting to try again after Claude was busy): missed, never charged (told once a day). A one-off
 * whose run was missed is finished, as finish() finishes one that ran.
 */
async function missLate(): Promise<number> {
  const r = await sql(
    `UPDATE automation_runs SET status = 'skipped', outcome = 'missed', finished_at = ${DB_NOW}, updated_at = ${DB_NOW}, lease_owner = '', lease_until = 0
      WHERE id IN (SELECT id FROM automation_runs
                    WHERE parked = 0 AND status IN ('queued','waiting','running','approval') AND status IN ('queued','running')
                      AND grace_until > 0 AND grace_until < ${DB_NOW} AND ${NEVER_STARTED} LIMIT 500)
     RETURNING id, automation_id, user_id`,
  );
  if (r.rows.length) await closeLeftSteps(r.rows.map((row) => String(row.id)));
  const told = new Set<string>();
  for (const row of r.rows as unknown as { id: string; automation_id: string; user_id: string }[]) {
    if (told.has(row.automation_id)) continue;
    told.add(row.automation_id);
    const auto = await one<{ name: string; status: string; next_at: number; spec: string }>(
      "SELECT a.name, a.status, a.next_at, v.spec FROM automations a LEFT JOIN automation_versions v ON v.automation_id = a.id AND v.version = a.version WHERE a.id = ?",
      [row.automation_id],
    );
    if (!auto) continue;
    // A one-off whose slot was taken (next_at 0) has nothing more to run.
    const spec = specOf(auto.spec ?? "");
    if (auto.status === "on" && !Number(auto.next_at) && spec?.trigger.type === "schedule" && spec.trigger.when.kind === "once") {
      await sql(`UPDATE automations SET status = 'finished', updated_at = ${DB_NOW} WHERE id = ? AND status = 'on' AND next_at = 0`, [row.automation_id]);
    }
    await notify({
      userId: row.user_id,
      kind: "missed",
      phrase: NOTICES.missed,
      blanks: { name: auto.name },
      link: automationLink(row.automation_id, row.id),
      ref: `missed:${row.automation_id}:${utcDay(Date.now())}`,
    });
  }
  return r.rows.length;
}

/**
 * Receipt detail kept: 30 days or the last 50 runs with detail per automation, whichever keeps less, and
 * 20 MB per account; and always each automation's latest run that delivered (see notLatestOk).
 */
export const RECEIPT_DAYS = 30;
export const RECEIPT_RUNS = 50;
export const RECEIPT_BYTES = 20 * 1024 * 1024;
/** Fingerprints and credits are kept this long, then the run goes. */
export const RUN_DAYS = 395;
/** About the writes one run makes, for the month's capacity (see the plan's §4.9). */
export const WRITES_PER_RUN = 30;

/**
 * The daily job, claimed once a day (UTC) by the first tick that gets to it: deletes automations being
 * deleted once nothing of theirs runs (foreign keys are off, so each table by hand), compacts
 * receipts, and prunes read notices, unused versions and old rate limits.
 */
export async function dailyJob(today = utcDay(Date.now())): Promise<boolean> {
  const claim = await sql(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value < excluded.value`,
    [DAILY_KEY, today],
  );
  if (claim.rowsAffected !== 1) return false;
  const part = async (name: string, work: () => Promise<unknown>) =>
    work().catch((err) => console.error(`[flash] automation daily job: ${name} failed`, err instanceof Error ? err.name : "error"));
  await part("deletes", deleteAutomations);
  await part("compaction", compactReceipts);
  await part("notices", () => sql("DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE read_at > 0 AND read_at < ? LIMIT 5000)", [Date.now() - 90 * DAY]));
  await part("versions", () =>
    sql(
      `DELETE FROM automation_versions
        WHERE version < (SELECT a.version FROM automations a WHERE a.id = automation_versions.automation_id)
          AND NOT EXISTS (SELECT 1 FROM automation_runs r WHERE r.automation_id = automation_versions.automation_id AND r.version = automation_versions.version)`,
    ),
  );
  await part("rate limits", async () => {
    for (let batch = 0; batch < 20; batch++) {
      const r = await sql("DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE reset_at < ? LIMIT 5000)", [Date.now() - DAY]);
      if (r.rowsAffected < 5000) break;
    }
  });
  await part("capacity", checkCapacity);
  return true;
}

/** Nothing of this automation runs: no run holds a live lease. */
const NOTHING_RUNS = `NOT EXISTS (SELECT 1 FROM automation_runs r WHERE r.automation_id = automations.id AND r.lease_until > 0 AND r.lease_until >= ${DB_NOW})`;

/** Deletes automations marked deleting once none of their runs holds a lease (see deleteAutomationNow). */
async function deleteAutomations() {
  const gone = await all<{ id: string; user_id: string }>(`SELECT id, user_id FROM automations WHERE status = 'deleting' AND ${NOTHING_RUNS} LIMIT 50`);
  for (const a of gone) await deleteAutomationNow(a);
}

/**
 * Deletes an automation marked deleting, if nothing of it runs: its steps, runs, versions and notices,
 * then it, each table by hand (foreign keys are off). Ledger rows and holds stay. Returns whether it went.
 */
export async function deleteAutomationNow(a: { id: string; user_id: string }): Promise<boolean> {
  const link = `automations=${encodeURIComponent(a.id)}`;
  const deletable = { sql: `EXISTS (SELECT 1 FROM automations WHERE id = ? AND status = 'deleting' AND ${NOTHING_RUNS})`, args: [a.id] };
  const rs = await (await db()).batch(
    [
      { sql: `DELETE FROM automation_run_steps WHERE run_id IN (SELECT id FROM automation_runs WHERE automation_id = ?) AND ${deletable.sql}`, args: [a.id, ...deletable.args] },
      { sql: `DELETE FROM automation_runs WHERE automation_id = ? AND ${deletable.sql}`, args: [a.id, ...deletable.args] },
      { sql: `DELETE FROM automation_versions WHERE automation_id = ? AND ${deletable.sql}`, args: [a.id, ...deletable.args] },
      { sql: `DELETE FROM notifications WHERE user_id = ? AND (link = ? OR link LIKE ?) AND ${deletable.sql}`, args: [a.user_id, link, `${link}&%`, ...deletable.args] },
      { sql: `DELETE FROM automations WHERE id = ? AND status = 'deleting' AND ${NOTHING_RUNS}`, args: [a.id] },
    ],
    "write",
  );
  return rs.at(-1)!.rowsAffected === 1;
}

/** Clears the inputs and outputs of these runs' steps; their receipts and fingerprints stay. */
const COMPACT = `UPDATE automation_run_steps SET output = NULL, input = '' WHERE output IS NOT NULL AND run_id IN`;
/** Runs whose steps still have detail (the automation_run_steps_detail index): a pass reads only those, never the same twice. */
const DETAILED = "SELECT run_id FROM automation_run_steps WHERE output IS NOT NULL";
/**
 * Not an automation's latest run that delivered (of runs as `r`): that one keeps its detail, however old,
 * since an "only if changed" step compares with it (a monthly one's is 31 days old). Newest by created_at, then id, as
 * previousResult reads it.
 */
const notLatestOk = (r: string) =>
  `NOT (${r}.status = 'done' AND ${r}.outcome = 'ok' AND NOT EXISTS (SELECT 1 FROM automation_runs n WHERE n.automation_id = ${r}.automation_id AND n.created_at >= ${r}.created_at AND (n.created_at > ${r}.created_at OR n.id > ${r}.id)
                 AND n.status = 'done' AND n.outcome = 'ok'))`;
/** The daily passes go in batches of this many runs, at most BATCHES of them a day. */
const BATCH = 5000;
const BATCHES = 20;

/** Runs a pass until a batch comes back short (nothing more to do) or the day's batches are used. */
async function inBatches(pass: () => Promise<number>) {
  for (let batch = 0; batch < BATCHES; batch++) if ((await pass()) < BATCH) break;
}

async function compactReceipts() {
  const now = Date.now();
  // Older than 30 days.
  await inBatches(
    async () =>
      (await sql(`${COMPACT} (SELECT id FROM automation_runs WHERE id IN (${DETAILED}) AND finished_at > 0 AND finished_at < ? AND ${notLatestOk("automation_runs")} LIMIT ${BATCH})`, [now - RECEIPT_DAYS * DAY]))
        .rowsAffected,
  );
  // Beyond the newest 50 runs with detail of each automation.
  await inBatches(
    async () =>
      (
        await sql(
          `${COMPACT} (SELECT id FROM (SELECT id, automation_id, created_at, status, outcome, ROW_NUMBER() OVER (PARTITION BY automation_id ORDER BY created_at DESC) AS k
                                          FROM automation_runs WHERE id IN (${DETAILED}) AND finished_at > 0) x WHERE k > ? AND ${notLatestOk("x")} LIMIT ${BATCH})`,
          [RECEIPT_RUNS],
        )
      ).rowsAffected,
  );
  // Accounts over their receipt space: oldest detail first.
  const over = await all<{ user_id: string; bytes: number }>(
    "SELECT user_id, SUM(LENGTH(output)) + SUM(LENGTH(input)) AS bytes FROM automation_run_steps WHERE output IS NOT NULL GROUP BY user_id HAVING bytes > ?",
    [RECEIPT_BYTES],
  );
  for (const u of over) {
    let extra = Number(u.bytes) - RECEIPT_BYTES;
    const runs = await all<{ id: string; bytes: number }>(
      `SELECT s.run_id AS id, SUM(LENGTH(s.output)) + SUM(LENGTH(s.input)) AS bytes FROM automation_run_steps s CROSS JOIN automation_runs r ON r.id = s.run_id
        WHERE s.user_id = ? AND s.output IS NOT NULL AND r.finished_at > 0 AND ${notLatestOk("r")} GROUP BY s.run_id ORDER BY MIN(r.created_at) LIMIT 1000`,
      [u.user_id],
    );
    const ids: string[] = [];
    for (const r of runs) {
      if (extra <= 0) break;
      ids.push(r.id);
      extra -= Number(r.bytes);
    }
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      await sql(`${COMPACT} (${chunk.map(() => "?").join(",")})`, chunk);
    }
  }
  // After 13 months even the fingerprint goes, oldest first (the automation_runs_created index).
  const old = `SELECT id FROM automation_runs WHERE created_at < ? AND finished_at > 0 ORDER BY created_at LIMIT ${BATCH}`;
  await inBatches(async () => {
    const rs = await (await db()).batch(
      [
        { sql: `DELETE FROM automation_run_steps WHERE run_id IN (${old})`, args: [now - RUN_DAYS * DAY] },
        { sql: `DELETE FROM automation_runs WHERE id IN (${old})`, args: [now - RUN_DAYS * DAY] },
      ],
      "write",
    );
    return rs[1].rowsAffected;
  });
}

/** Flash's Turso writes a month (AUTOMATION_MONTHLY_WRITES, the plan's included writes), for the capacity check. */
const monthlyWrites = () => {
  const set = Math.floor(Number(process.env.AUTOMATION_MONTHLY_WRITES));
  return set > 0 ? set : 25_000_000;
};

/**
 * Estimated writes this month from runs, as the daily job last counted them (a new month counts from
 * 0 until its first daily job): past 90% of the plan, hourly slots are skipped for free until the month ends.
 */
export async function monthWrites(): Promise<{ writes: number; limit: number; day: string }> {
  const row = await one<{ value: string }>("SELECT value FROM settings WHERE key = ?", [WRITES_KEY]);
  let saved: { month?: unknown; writes?: unknown; day?: unknown } = {};
  try {
    saved = JSON.parse(row?.value || "{}") as typeof saved;
  } catch {
    // Not counted yet.
  }
  const current = saved.month === utcDay(Date.now()).slice(0, 7);
  return { writes: current ? Number(saved.writes) || 0 : 0, limit: monthlyWrites(), day: current && typeof saved.day === "string" ? saved.day : "" };
}

/** The daily count of this month's runs (the automation_runs_created index), kept for monthWrites and the capacity check. */
async function checkCapacity() {
  const now = Date.now();
  const row = await one<{ n: number }>("SELECT COUNT(*) AS n FROM automation_runs WHERE created_at >= ?", [monthStart(now)]);
  const writes = Number(row?.n ?? 0) * WRITES_PER_RUN;
  const month = utcDay(now).slice(0, 7);
  const save = "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
  await (await db()).batch(
    [
      { sql: save, args: [WRITES_KEY, JSON.stringify({ month, writes, day: utcDay(now) })] },
      { sql: save, args: [CAPACITY_KEY, writes >= monthlyWrites() * 0.9 ? month : ""] },
    ],
    "write",
  );
}
