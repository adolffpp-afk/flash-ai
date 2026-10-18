/*
 * Automations on /admin (PR 1a's burn-in): whether they can run here and with which key, the cron
 * health lines (worked out from data, so they cost no writes), and what runs did and cost. Reads
 * only. The burn-in card's own automations, runs and holds are burnIn in automation-api.ts.
 */
import { RUNNER_VERSION, STEP_BUDGET_MS } from "../automations.ts";
import { monthWrites } from "./automation-tick.ts";
import { automationsServer, AUTOMATION_SHARED_PAID, cronSecretTooShort, keyInUse, maxPaid, missingSetup, paidOpen, RATE_LIMITED_KEY } from "./automations.ts";
import { all, one } from "./db.ts";
import { countOf } from "./limits.ts";
import { DB_NOW } from "./leases.ts";

const DAY = 86_400_000;
const n = (v: unknown) => Number(v ?? 0);

/** The p95 of a list of numbers (0 for none). */
const p95 = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
};

/** The lines /admin shows for automations over the last days (see adminStats). */
export async function automationStats(days: number) {
  const now = Date.now();
  const since = now - days * DAY;
  // Runs that ended in the last 7 days by outcome, with those of the last 24 hours, read through the
  // runs that ended then only (automation_runs_finished).
  const outcomes = await all<{ status: string; outcome: string; day: number; week: number }>(
    `SELECT status, outcome, SUM(CASE WHEN finished_at >= ? THEN 1 ELSE 0 END) AS day, COUNT(*) AS week
       FROM automation_runs WHERE finished_at >= ? AND finished_at > 0 GROUP BY status, outcome ORDER BY week DESC`,
    [now - DAY, now - 7 * DAY],
  );
  const usage = await one<{ requests: number; credits: number; cost: number; losses: number; lostCents: number }>(
    `SELECT SUM(CASE WHEN part = 0 THEN 1 ELSE 0 END) AS requests, COALESCE(SUM(credits), 0) AS credits, COALESCE(SUM(cost_cents), 0) AS cost,
            SUM(CASE WHEN part = 0 AND credits = 0 AND cost_cents > 0 THEN 1 ELSE 0 END) AS losses,
            COALESCE(SUM(CASE WHEN credits = 0 THEN cost_cents ELSE 0 END), 0) AS lostCents
       FROM usage WHERE automation_id <> '' AND created_at >= ?`,
    [since],
  );
  // Function time: each step of the runs that ended, from its start to its end, so the time a run waits
  // between tries or while paused (in no function) isn't counted; a step left behind by a server that
  // stopped counts at most the longest a step may take (the work calls' own time is a few ms more).
  const time = await one<{ ms: number }>(
    `SELECT COALESCE(SUM(MIN(s.finished_at - s.started_at, ?)), 0) AS ms FROM automation_runs r JOIN automation_run_steps s ON s.run_id = r.id
      WHERE r.finished_at >= ? AND r.finished_at > 0 AND s.started_at > 0 AND s.finished_at > s.started_at`,
    [Math.max(...Object.values(STEP_BUDGET_MS)), since],
  );
  const active = await one<{ active: number; paused: number }>(
    "SELECT SUM(CASE WHEN status = 'on' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) AS paused FROM automations",
  );
  return {
    server: automationsServer(),
    key: keyInUse(),
    sharedPaid: AUTOMATION_SHARED_PAID,
    missing: missingSetup(),
    cronSecretShort: cronSecretTooShort(),
    active: n(active?.active),
    paused: n(active?.paused),
    outcomes: outcomes.map((r) => ({ status: r.status, outcome: r.outcome, day: n(r.day), week: n(r.week) })),
    requests: n(usage?.requests),
    credits: n(usage?.credits),
    costCents: n(usage?.cost),
    losses: n(usage?.losses),
    lostCents: n(usage?.lostCents),
    functionSeconds: Math.round(n(time?.ms) / 1000),
    health: await cronHealth(),
  };
}

/** The cron health lines (the plan's §4.2): lag, queues, the paid pool, 429s, spend and writes. Parked runs are left out. */
export async function cronHealth() {
  const now = Date.now();
  const schedule = await one<{ at: number }>(`SELECT MIN(next_at) AS at FROM automations WHERE status = 'on' AND next_at > 0 AND next_at <= ${DB_NOW}`);
  const run = await one<{ at: number }>(
    `SELECT MIN(due_at) AS at FROM automation_runs WHERE parked = 0 AND status IN ('queued','waiting','running','approval') AND due_at <= ${DB_NOW} AND lease_until < ${DB_NOW}`,
  );
  // Each line reads through an index: runs of the last week by age, the live queue, the live leases.
  const lags = await all<{ lag: number }>(
    "SELECT started_at - scheduled_at AS lag FROM automation_runs WHERE created_at >= ? AND origin = 'schedule' AND started_at > 0 AND scheduled_at > 0 LIMIT 5000",
    [now - 7 * DAY],
  );
  const queued = await one<{ n: number }>("SELECT COUNT(*) AS n FROM automation_runs WHERE parked = 0 AND status IN ('queued','waiting','running','approval') AND status = 'queued'");
  const paid = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM automation_runs WHERE lease_until > 0 AND lease_until > ${DB_NOW} AND next_paid = 1 AND finished_at = 0`);
  const peak = await one<{ credits: number }>(
    `SELECT COALESCE(MAX(spent), 0) AS credits FROM (SELECT -SUM(amount) AS spent FROM credit_ledger
       WHERE automation_id <> '' AND amount < 0 AND created_at >= ? GROUP BY created_at / 60000)`,
    [now - 7 * DAY],
  );
  const holds = await one<{ open: number; lapsed: number }>(
    `SELECT COUNT(*) AS open, SUM(CASE WHEN lease_until < ${DB_NOW} THEN 1 ELSE 0 END) AS lapsed FROM credit_holds WHERE settled_at = 0`,
  );
  const newer = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM automation_runs r JOIN automation_versions v ON v.automation_id = r.automation_id AND v.version = r.version
      WHERE r.finished_at = 0 AND v.runner > ?`,
    [RUNNER_VERSION],
  );
  const daily = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'auto:daily'");
  return {
    overdueScheduleMin: schedule?.at ? Math.max(0, Math.floor((now - n(schedule.at)) / 60_000)) : 0,
    overdueRunMin: run?.at ? Math.max(0, Math.floor((now - n(run.at)) / 60_000)) : 0,
    lagP95Sec: Math.round(p95(lags.map((l) => n(l.lag))) / 1000),
    lagRuns: lags.length,
    queued: n(queued?.n),
    paidNow: n(paid?.n),
    maxPaid: maxPaid(),
    paidOpen: (await paidOpen()) === 1,
    rateLimitedLastHour: await countOf(RATE_LIMITED_KEY),
    peakCreditsPerMinute: n(peak?.credits),
    writes: await monthWrites(),
    openHolds: n(holds?.open),
    lapsedHolds: n(holds?.lapsed),
    newerRunner: n(newer?.n),
    dailyJob: daily?.value ?? "",
  };
}
