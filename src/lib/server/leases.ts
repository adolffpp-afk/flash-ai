/*
 * Who may move an automation run forward, and for how long (see automation-tick.ts and
 * automation-runner.ts). A run is claimed with a lease on the database's own clock, so a server whose
 * clock is off can't shorten it, and with an owner token of its own (<worker>:<runId>) that its work
 * call carries. Before every step the lease is renewed by compare-and-set, in one batch with the step's
 * row, and a unique index lets one step of a run run at a time: two workers can never start the same
 * step, and a worker whose lease was taken over writes nothing.
 */
import { db, one, run as sql } from "./db.ts";

/** The database's clock in UTC ms, for every claim, lease and heartbeat. */
export const DB_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

/** A claimed run's lease, before its first step renews it: a dispatch that never arrives frees the run by then. */
export const CLAIM_LEASE_MS = 120_000;
/** The lease a step gets on top of its budget, so it can settle after its budget runs out. */
export const STEP_LEASE_EXTRA_MS = 90_000;

/**
 * Named points in a run's life where tests wait, slow a worker down or stop it (see
 * test/automation-race.test.ts). Does nothing outside tests.
 */
export const probes: { at: (point: string, info?: Record<string, unknown>) => void | Promise<void> } = { at: () => {} };
export const probe = async (point: string, info?: Record<string, unknown>) => {
  await probes.at(point, info);
};

/** Runs that may be live: their lease is held now. Repeats the partial index's own term so it is used. */
const LIVE = `lease_until > 0 AND lease_until >= ${DB_NOW}`;

export type ClaimLimits = {
  // Runs at once per account.
  perUser: number;
  // Runs whose next step is an AI step, Flash-wide; and the others.
  maxPaid: number;
  maxOther: number;
  // 0 while paid claims wait out a 429 (auto:backoff_until), else 1.
  paidOpen: 0 | 1;
  // At most this many claimed by one tick, each dispatched at once.
  perTick: number;
  runnerVersion: number;
};

/**
 * Claims due runs for this worker in one statement on the database's clock: at most perUser at once
 * per account and the paid and other pools Flash-wide, oldest first, never a parked run, a run with
 * a credit hold still open (the reaper settles it first) or one whose version needs a newer runner.
 * A queued run becomes running. Returns each run with its owner token.
 */
export async function claimRuns(worker: string, limits: ClaimLimits): Promise<{ id: string; owner: string }[]> {
  const r = await sql(
    `WITH clock AS (SELECT ${DB_NOW} AS now),
          busy AS (SELECT user_id, COUNT(*) AS n FROM automation_runs, clock WHERE lease_until > 0 AND lease_until >= clock.now GROUP BY user_id),
          pools AS (SELECT next_paid, COUNT(*) AS n FROM automation_runs, clock WHERE lease_until > 0 AND lease_until >= clock.now GROUP BY next_paid),
          cand AS (SELECT r.id, r.user_id, r.next_paid, r.due_at,
                          ROW_NUMBER() OVER (PARTITION BY r.user_id ORDER BY r.due_at) AS k,
                          ROW_NUMBER() OVER (PARTITION BY r.next_paid ORDER BY r.due_at) AS q
                   FROM automation_runs r, clock
                   WHERE r.parked = 0 AND r.status IN ('queued','waiting','running','approval')
                     AND r.due_at <= clock.now AND r.lease_until < clock.now
                     AND NOT EXISTS (SELECT 1 FROM credit_holds h WHERE h.run_id = r.id AND h.settled_at = 0 AND h.run_id <> '')
                     AND (SELECT runner FROM automation_versions v WHERE v.automation_id = r.automation_id AND v.version = r.version) <= ?
                   ORDER BY r.due_at LIMIT 500)
     UPDATE automation_runs
        SET lease_owner = ? || ':' || id, lease_until = (SELECT now FROM clock) + ?, updated_at = (SELECT now FROM clock),
            status = CASE status WHEN 'queued' THEN 'running' ELSE status END,
            started_at = CASE started_at WHEN 0 THEN (SELECT now FROM clock) ELSE started_at END
      WHERE lease_until < (SELECT now FROM clock) AND id IN (
            SELECT c.id FROM cand c LEFT JOIN busy b ON b.user_id = c.user_id
             WHERE c.k + COALESCE(b.n, 0) <= ?
               AND c.q <= CASE c.next_paid
                            WHEN 1 THEN ? * (? - COALESCE((SELECT n FROM pools WHERE next_paid = 1), 0))
                            ELSE ? - COALESCE((SELECT n FROM pools WHERE next_paid = 0), 0) END
             ORDER BY c.due_at LIMIT ?)
     RETURNING id, lease_owner`,
    [limits.runnerVersion, worker, CLAIM_LEASE_MS, limits.perUser, limits.paidOpen, limits.maxPaid, limits.maxOther, limits.perTick],
  );
  return r.rows.map((row) => ({ id: String(row.id), owner: String(row.lease_owner) }));
}

export type Started = { attempt: number; ref: string };

/**
 * Starts a step of a run this worker holds: renews the lease to cover the step's budget (and, for a
 * paid step, only while the Flash-wide paid pool has room) and writes the step's row as running, in
 * one batch. "lost" when the lease is gone or another worker runs a step of this run (it writes
 * nothing then); "no_paid_slot" when the paid pool is full (the run is released with its place kept).
 * A paid step's hold and ledger ref is auto:<runId>:<stepId>:<attempt>.
 */
export async function startStep(
  runId: string,
  me: string,
  o: { stepId: string; kind: string; budgetMs: number; paid: boolean; maxPaid: number; level?: string },
): Promise<Started | "lost" | "no_paid_slot"> {
  const paid = o.paid ? 1 : 0;
  let rs;
  try {
    rs = await (await db()).batch(
      [
        {
          sql: `UPDATE automation_runs
                   SET lease_until = ${DB_NOW} + ?, attempts = attempts + 1, next_paid = ?, updated_at = ${DB_NOW}
                 WHERE id = ? AND lease_owner = ? AND lease_until > ${DB_NOW}
                   AND (? = 0 OR next_paid = 1
                        OR (SELECT COUNT(*) FROM automation_runs WHERE next_paid = 1 AND ${LIVE}) < ?)`,
          args: [o.budgetMs + STEP_LEASE_EXTRA_MS, paid, runId, me, paid, o.maxPaid],
        },
        {
          sql: `INSERT INTO automation_run_steps (run_id, step_id, attempt, user_id, kind, status, hold_ref, delivery_id, level, started_at)
                SELECT id, ?, attempts, user_id, ?, 'running',
                       CASE WHEN ? = 1 THEN 'auto:' || id || ':' || ? || ':' || attempts ELSE '' END,
                       id || ':' || ?, ?, ${DB_NOW}
                  FROM automation_runs WHERE id = ? AND lease_owner = ? AND lease_until > ${DB_NOW} + ?
                RETURNING attempt, hold_ref`,
          args: [o.stepId, o.kind, paid, o.stepId, o.stepId, o.level ?? "", runId, me, o.budgetMs],
        },
      ],
      "write",
    );
  } catch (err) {
    // Another worker's step of this run is running (the one-running-step index): this one isn't.
    if (/UNIQUE constraint failed/i.test(String((err as Error)?.message))) return "lost";
    throw err;
  }
  const row = rs[1].rows[0];
  if (row) return { attempt: Number(row.attempt), ref: String(row.hold_ref) };
  const held = await one("SELECT 1 FROM automation_runs WHERE id = ? AND lease_owner = ? AND lease_until > " + DB_NOW, [runId, me]);
  return held ? "no_paid_slot" : "lost";
}

/**
 * Gives a run's lease back, keeping its place (due_at) unless a new time is given. status is what it
 * waits as: queued before its first step, running when it is part way.
 */
export async function releaseRun(runId: string, me: string, o: { status?: string; dueAt?: number } = {}): Promise<boolean> {
  const r = await sql(
    `UPDATE automation_runs SET lease_owner = '', lease_until = 0,
            status = COALESCE(?, status), due_at = COALESCE(?, due_at), updated_at = ${DB_NOW}
      WHERE id = ? AND lease_owner = ?`,
    [o.status ?? null, o.dueAt ?? null, runId, me],
  );
  return r.rowsAffected === 1;
}

/**
 * Parks a run whose automation was paused: out of every due query until it is resumed, with its lease
 * given back. A run that hasn't done a step yet waits as queued.
 */
export async function parkRun(runId: string, me: string): Promise<boolean> {
  const r = await sql(
    `UPDATE automation_runs SET parked = 1, lease_owner = '', lease_until = 0, updated_at = ${DB_NOW},
            status = CASE WHEN status = 'running' AND step = '' AND credits = 0 THEN 'queued' ELSE status END
      WHERE id = ? AND lease_owner = ?`,
    [runId, me],
  );
  return r.rowsAffected === 1;
}

/**
 * Inserts a run its owner started (Run now), once per request key. When the account's and Flash-wide
 * limits allow, the run gets its lease in the same statement, so the request can move it forward
 * itself; otherwise it waits as queued for the tick. Returns the run, or null when the automation
 * isn't the user's (or can't run).
 */
export async function insertOwnerRun(o: {
  id: string;
  automationId: string;
  userId: string;
  runKey: string;
  worker: string;
  firstPaid: boolean;
  limits: Pick<ClaimLimits, "perUser" | "maxPaid" | "maxOther" | "paidOpen">;
  triggerJson: string;
}): Promise<{ id: string; owner: string; status: string; existing: boolean } | null> {
  const paid = o.firstPaid ? 1 : 0;
  // Whether this run may start now: the account's runs at once, then its pool's room.
  const fits = `((SELECT COUNT(*) FROM automation_runs WHERE user_id = ? AND ${LIVE}) < ?
                 AND CASE WHEN ? = 1 THEN ? * (? - (SELECT COUNT(*) FROM automation_runs WHERE next_paid = 1 AND ${LIVE}))
                          ELSE ? - (SELECT COUNT(*) FROM automation_runs WHERE next_paid = 0 AND ${LIVE}) END > 0)`;
  const fitArgs = [o.userId, o.limits.perUser, paid, o.limits.paidOpen, o.limits.maxPaid, o.limits.maxOther];
  const r = await sql(
    `INSERT INTO automation_runs (id, automation_id, user_id, version, run_key, origin, root_origin, trigger_json, status, next_paid,
                                  due_at, lease_owner, lease_until, started_at, created_at, updated_at)
     SELECT ?, id, user_id, version, ?, 'owner', 'owner', ?,
            CASE WHEN ${fits} THEN 'running' ELSE 'queued' END, ?,
            ${DB_NOW},
            CASE WHEN ${fits} THEN ? || ':' || ? ELSE '' END,
            CASE WHEN ${fits} THEN ${DB_NOW} + ? ELSE 0 END,
            CASE WHEN ${fits} THEN ${DB_NOW} ELSE 0 END,
            ${DB_NOW}, ${DB_NOW}
       FROM automations WHERE id = ? AND user_id = ? AND status IN ('draft', 'on', 'finished')
     ON CONFLICT(automation_id, run_key) DO NOTHING
     RETURNING id, lease_owner, status`,
    [
      o.id,
      o.runKey,
      o.triggerJson,
      ...fitArgs,
      paid,
      ...fitArgs,
      o.worker,
      o.id,
      ...fitArgs,
      CLAIM_LEASE_MS,
      ...fitArgs,
      o.automationId,
      o.userId,
    ],
  );
  const row = r.rows[0];
  if (row) return { id: String(row.id), owner: String(row.lease_owner), status: String(row.status), existing: false };
  // The same request again (a double tap): its run, once.
  const seen = await one<{ id: string; status: string }>(
    "SELECT r.id, r.status FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE r.automation_id = ? AND r.run_key = ? AND a.user_id = ?",
    [o.automationId, o.runKey, o.userId],
  );
  return seen ? { id: seen.id, owner: "", status: seen.status, existing: true } : null;
}
