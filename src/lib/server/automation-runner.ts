/*
 * Moves one automation run forward, step by step, for the worker that holds its lease (a work call,
 * see api/cron/work; or Run now). A run's whole state is in its row, so a run can go on in a later
 * call: a step starts only when the call has time for its budget, and otherwise the run is released
 * with its place kept and the next tick hands it to a fresh call.
 *
 * Before every step: Stop, whether the automation still exists and is on (paused: the step in flight
 * finished, and the run is parked until it is resumed), the account, the version the run follows (an
 * edit never changes a run under way), and any earlier attempt of the step left behind by a server
 * that stopped: its hold is settled now by the reaper's rule, and when it had started, the run ends
 * interrupted instead of calling Claude again. Nothing is ever charged twice without the owner's tap.
 *
 * finish() writes the run's end, its receipt and fingerprint, what it changes on the automation
 * (failures in a row, a pause for credits or a limit, a one-off finished) and its notices.
 */
import { gunzipSync } from "node:zlib";
import { budgetOf, engineOf, isPaid, MAX_STEPS, NOTICES, parseSpec, stepAt, type Spec, type Step } from "../automations.ts";
import { nextMonthStart, utcDay } from "../schedule.ts";
import { isVerified } from "./account.ts";
import { automationsOpenTo, maxPaid, userById } from "./automations.ts";
import { lapsedHolds, reapedCents, reaperCredits, settleHold, type Hold } from "./credit-holds.ts";
import { topUpFloor } from "./credits.ts";
import { all, db, one, run as sql } from "./db.ts";
import { sha256 } from "./ids.ts";
import { DB_NOW, parkRun, probe, releaseRun, startStep, takeLease } from "./leases.ts";
import { canonicalJson } from "./mcp-client.ts";
import { automationLink, NOTICE_TEXT_CHARS, noticeStatement, type Notice } from "./notifications.ts";
import { MAX_ATTEMPTS, outputText, runStep, STEP_TIMING, varsOf, type AutoRow, type Offer, type RunEnd, type RunRow } from "./automation-steps.ts";

/** The spec a run follows: its own version, frozen when the run was made. */
export async function versionSpec(automationId: string, version: number): Promise<Spec | null> {
  const row = await one<{ spec: string }>("SELECT spec FROM automation_versions WHERE automation_id = ? AND version = ?", [automationId, version]);
  if (!row) return null;
  try {
    const parsed = parseSpec(JSON.parse(row.spec));
    return "spec" in parsed ? parsed.spec : null;
  } catch {
    return null;
  }
}

const automationRow = (id: string) => one<AutoRow>("SELECT * FROM automations WHERE id = ?", [id]);
const runRow = (id: string) => one<RunRow>("SELECT * FROM automation_runs WHERE id = ?", [id]);

/**
 * Moves a run forward while this worker holds it (owner is the token its claim gave it, taken for this
 * call alone, see takeLease) and the call has time, until the run ends, waits or is handed on.
 * deadline is when the call's own time runs out.
 */
export async function advanceRun(runId: string, owner: string, deadline: number): Promise<void> {
  const me = await takeLease(runId, owner);
  if (!me) return;
  // Each pass starts at most one step; a spec has at most MAX_STEPS, each tried at most MAX_ATTEMPTS times.
  for (let pass = 0; pass <= MAX_STEPS * MAX_ATTEMPTS; pass++) {
    const run = await one<RunRow>(`SELECT * FROM automation_runs WHERE id = ? AND lease_owner = ? AND lease_until > ${DB_NOW}`, [runId, me]);
    if (!run || Number(run.finished_at)) return;
    // Delete also asks its runs to stop: a run of an automation being deleted ends as deleted.
    const auto = await automationRow(run.automation_id);
    if (!auto || auto.status === "deleting") return void (await finish(run, "stopped", "deleted", { me }));
    if (Number(run.stop_requested)) return void (await finish(run, "stopped", "stopped_by_user", { me }));
    // The step in flight finished; the next one waits until the automation is turned back on.
    if (auto.status === "paused") return void (await parkRun(runId, me));
    const user = await userById(auto.user_id);
    if (!user) return void (await finish(run, "stopped", "deleted", { me }));
    if (!isVerified(user)) return void (await finish(run, "stopped", "unconfirmed", { me }));
    // Automations are no longer open to this account (in PR 1a: no longer an admin): nothing more runs.
    if (!automationsOpenTo(user)) return void (await finish(run, "stopped", "closed", { me }));
    const spec = await versionSpec(run.automation_id, Number(run.version));
    if (!spec) return void (await finish(run, "failed", "invalid", { me }));
    const step = stepAt(spec, run.step);
    // At the end: after its last step, or after an AI step that ended it (failed, stopped or nothing
    // new) whose finish didn't land: it ends as that step said, and nothing runs again.
    if (!step) return void (await finish(run, END_STATUS[run.outcome] ?? "done", run.outcome || "ok", { me, spec, ...(run.summary && { summary: run.summary }) }));
    // Not enough time left in this call for the step and the gap it keeps for settling (see runAiStep):
    // the next tick hands it to a fresh one, in its place.
    if (deadline - Date.now() < budgetOf(step) + STEP_TIMING.deadlineGapMs) return void (await releaseRun(runId, me));
    const earlier = await earlierAttempts(run, step);
    if (earlier === "started") return void (await finish(run, "interrupted", "interrupted", { me, spec }));
    // A hold left behind changed while it was being settled (its worker is still going): the run waits.
    if (earlier === "busy") return void (await releaseRun(runId, me));
    // A step's waits for other runs' holds (see runAiStep) aren't attempts: only its tries count.
    const waits = Number(run.attempts) > 0 ? await waitsOf(runId, step.id) : 0;
    const tries = Number(run.attempts) - waits;
    if (tries >= MAX_ATTEMPTS) return void (await finish(run, "failed", "failed", { me, spec }));
    const started = await startStep(runId, me, {
      stepId: step.id,
      kind: step.do,
      budgetMs: budgetOf(step),
      paid: isPaid(step),
      maxPaid: maxPaid(),
      level: isPaid(step) ? step.level : "",
    });
    if (started === "lost") return;
    // The paid pool is full (or waits out a 429): it waits in its place, in that pool, as queued if it hasn't done anything yet.
    if (started === "no_paid_slot") return void (await releaseRun(runId, me, { ...waitingAs(run), nextPaid: 1 }));
    // The run as it is now (attempts counts this try).
    const now = { ...run, attempts: tries + 1 };
    const r = await runStep({ run: now, auto, user, spec, started, me, deadline, waits }, step);
    if (r.kind === "next") continue;
    if (r.kind === "lost") return;
    if (r.kind === "retry") return void (await releaseRun(runId, me, { ...waitingAs(run), dueAt: Date.now() + r.delayMs }));
    // Stopped because its automation is being deleted (Delete also asks its runs to stop).
    const deleting = r.outcome === "stopped_by_user" && (await automationRow(run.automation_id))?.status === "deleting";
    const outcome = deleting ? "deleted" : r.outcome;
    return void (await finish((await runRow(runId)) ?? run, r.status, outcome, { me, spec, summary: r.summary, need: r.need, offer: r.offer }));
  }
}

/** How many times a run's step waited for other runs' holds (its attempts noted waiting). */
async function waitsOf(runId: string, stepId: string): Promise<number> {
  const row = await one<{ n: number }>("SELECT COUNT(*) AS n FROM automation_run_steps WHERE run_id = ? AND step_id = ? AND note = 'waiting'", [runId, stepId]);
  return Number(row?.n ?? 0);
}

/** How a run that an AI step ended ends, by the outcome it kept (see runAiStep); any other ends done. */
const END_STATUS: Record<string, RunEnd> = { failed: "failed", stopped_by_user: "stopped", nothing_new: "done" };

/** How a released run waits: queued when it hasn't done anything yet, otherwise as it is. */
const waitingAs = (run: Pick<RunRow, "credits" | "step">) => (Number(run.credits) === 0 && run.step === "" ? { status: "queued" } : {});

/**
 * Settles what an earlier attempt of this run left behind (a server that stopped mid-step): its
 * step rows still running, and their open holds by the reaper's rule. Says "started" when an
 * attempt of this step had called Claude: the run then ends interrupted, and is never re-run by itself.
 * "busy" when a hold changed under the settle (its worker is still writing): nothing is settled then.
 */
async function earlierAttempts(run: RunRow, step: Step): Promise<"started" | "busy" | "none"> {
  const left = await all<{ step_id: string; attempt: number; hold_ref: string }>(
    "SELECT step_id, attempt, hold_ref FROM automation_run_steps WHERE run_id = ? AND status = 'running'",
    [run.id],
  );
  for (const s of left) {
    const hold = s.hold_ref ? await one<Hold>("SELECT * FROM credit_holds WHERE ref = ?", [s.hold_ref]) : null;
    if (hold && !Number(hold.settled_at) && !(await reapHold(hold, { inline: true }))) return "busy";
    // No hold (a notice, or a step stopped before its hold was recorded), or one already settled.
    await sql(`UPDATE automation_run_steps SET status = 'interrupted', note = 'interrupted', finished_at = ${DB_NOW} WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'running'`, [
      run.id,
      s.step_id,
      s.attempt,
    ]);
  }
  if (!isPaid(step)) return "none";
  const started = await one(
    `SELECT 1 FROM automation_run_steps s JOIN credit_holds h ON h.ref = s.hold_ref
      WHERE s.run_id = ? AND s.step_id = ? AND s.status = 'interrupted' AND s.hold_ref <> '' AND h.started = 1 LIMIT 1`,
    [run.id, step.id],
  );
  return started ? "started" : "none";
}

/**
 * Settles a hold left behind (the reaper, see reaperCredits), once: its step is marked interrupted
 * and the credits go on its run. A hold whose call had started ends its run interrupted ("Retry" is
 * the owner's tap); one that never started puts its run back in the queue, in its place. inline: the
 * runner settles it before a step of a run it holds, and decides about the run itself. Settled only
 * if the hold is still as it was read (see settleHold's leaseUntil): a worker that marked it started
 * or renewed it since is left to settle it itself.
 */
export async function reapHold(h: Hold, o: { inline?: boolean } = {}): Promise<boolean> {
  const charged = Boolean(await one("SELECT 1 FROM credit_ledger WHERE ref = ?", [h.ref]));
  const credits = reaperCredits(h, charged);
  const started = charged && Number(h.started) === 1;
  const engine = started && h.run_id ? await engineOfHold(h) : "";
  const won = await settleHold(h.ref, credits, (w) =>
    h.run_id
      ? [
          {
            sql: `UPDATE automation_run_steps SET status = 'interrupted', note = 'interrupted', credits = ?, held = ?, finished_at = ${DB_NOW}
                   WHERE run_id = ? AND hold_ref = ? AND status = 'running' AND ${w.sql}`,
            args: [credits, h.held, h.run_id, h.ref, ...w.args],
          },
          {
            // Never started: back in the queue now (its lease is let go), unless the runner holds it here.
            sql: `UPDATE automation_runs SET credits = credits + ?, updated_at = ${DB_NOW},
                         lease_owner = CASE WHEN ? = 1 THEN lease_owner ELSE '' END,
                         lease_until = CASE WHEN ? = 1 THEN lease_until ELSE 0 END,
                         status = CASE WHEN ? = 1 OR status <> 'running' OR step <> '' OR credits > 0 THEN status ELSE 'queued' END
                   WHERE id = ? AND finished_at = 0 AND ${w.sql}`,
            args: [credits, o.inline || started ? 1 : 0, o.inline || started ? 1 : 0, o.inline || started ? 1 : 0, h.run_id, ...w.args],
          },
          // A call that was sent is one AI request on /admin's Runs and money: what the reaper charged, and what it is known to have cost
          // (failed only when it charged nothing: one charged for the work it did isn't a refund on /admin's Overview).
          ...(started
            ? [
                {
                  sql: `INSERT INTO usage (user_id, engine, model, provider, credits, cost_cents, ok, part, automation_id, created_at)
                        SELECT user_id, ?, ?, 'anthropic', ?, ?, ?, 0, automation_id, ${DB_NOW} FROM automation_runs WHERE id = ? AND ${w.sql}`,
                  args: [engine, h.model, credits, reapedCents(h), credits > 0 ? 1 : 0, h.run_id, ...w.args],
                },
              ]
            : []),
        ]
      : [],
    { leaseUntil: Number(h.lease_until) },
  );
  if (won && started && !o.inline && h.run_id) {
    const run = await runRow(h.run_id);
    if (run && !Number(run.finished_at)) await finish(run, "interrupted", "interrupted", { reaper: true });
  }
  return won;
}

/** The engine a hold's step ran on, as its worker logs it (text when its step can't be read). */
async function engineOfHold(h: Hold): Promise<string> {
  const row = await one<{ step_id: string; automation_id: string; version: number }>(
    "SELECT s.step_id, r.automation_id, r.version FROM automation_run_steps s JOIN automation_runs r ON r.id = s.run_id WHERE s.run_id = ? AND s.hold_ref = ? LIMIT 1",
    [h.run_id, h.ref],
  );
  const spec = row ? await versionSpec(row.automation_id, Number(row.version)) : null;
  const step = spec && row ? stepAt(spec, row.step_id) : null;
  return step?.do === "ai" ? engineOf(step) : "text";
}

/** The reaper's pass (the tick's first step): every hold whose lease ran out, settled once. */
export async function reapLapsed(limit = 50): Promise<number> {
  let n = 0;
  for (const h of await lapsedHolds(limit)) {
    try {
      if (await reapHold(h)) n++;
    } catch (err) {
      console.error("[flash] automation reaper failed", err instanceof Error ? err.name : "error");
    }
  }
  return n;
}

type StepReceipt = { step_id: string; attempt: number; kind: string; status: string; held: number; credits: number; level: string; model: string; note: string; input: string; output: ArrayBuffer | Uint8Array | null };

/** The sources a stored output cites, as a receipt shows them. */
export function sourcesOf(output: ArrayBuffer | Uint8Array | null | undefined): { url: string; title: string }[] {
  try {
    const parsed = output ? (JSON.parse(gunzipSync(Buffer.from(output as ArrayBuffer)).toString("utf8")) as { sources?: { url: string; title?: string }[] }) : {};
    return (parsed.sources ?? []).map((s) => ({ url: s.url, title: s.title ?? "" }));
  } catch {
    return [];
  }
}

/**
 * A step's tries in order, each numbered among its step's tries: a wait for other runs' holds (see
 * runAiStep) isn't a try, so it is left out (and counted, waits). The receipt and its fingerprint show these.
 */
export function triesOf<S extends { step_id: string; note: string }>(steps: S[]): { tries: (S & { try: number })[]; waits: number } {
  const seen = new Map<string, number>();
  const tries = steps.filter((s) => s.note !== "waiting").map((s) => {
    const n = (seen.get(s.step_id) ?? 0) + 1;
    seen.set(s.step_id, n);
    return { ...s, try: n };
  });
  return { tries, waits: steps.length - tries.length };
}

/**
 * The compact receipt a run's fingerprint is made from: what started it and the name it ran under, each
 * try of each step (and how many waits) with its level, model and note and the SHA-256 of what it sent,
 * wrote and cited (so compacting them away later keeps what a download says checkable), and the totals
 * with the SHA-256 of the summary.
 */
export function compactReceipt(
  run: Pick<RunRow, "id" | "automation_id" | "version" | "origin" | "run_key" | "scheduled_at">,
  steps: StepReceipt[],
  end: { status: string; outcome: string; credits: number; name: string; summary: string },
) {
  const { tries, waits } = triesOf(steps);
  return {
    v: 1,
    run: run.id,
    automation: run.automation_id,
    name: end.name,
    version: Number(run.version),
    trigger: { origin: run.origin, key: run.run_key, at: Number(run.scheduled_at) },
    steps: tries.map((s) => ({
      id: s.step_id,
      attempt: s.try,
      kind: s.kind,
      status: s.status,
      level: s.level,
      model: s.model,
      note: s.note,
      held: Number(s.held),
      credits: Number(s.credits),
      input: sha256(s.input ?? ""),
      output: sha256(outputText(s.output)),
      sources: sha256(canonicalJson(sourcesOf(s.output))),
    })),
    ...(waits > 0 && { waited: waits }),
    credits: end.credits,
    status: end.status,
    outcome: end.outcome,
    summary: sha256(end.summary),
  };
}
export type CompactReceipt = ReturnType<typeof compactReceipt>;

/** A receipt's fingerprint, chained per automation: the SHA-256 of the one before and this receipt. */
export const receiptHash = (prev: string, receipt: CompactReceipt) => sha256(prev + canonicalJson(receipt));

/** A run's receipt as its owner downloads it: the receipt before it in the chain, this one, and its fingerprint. */
export type SavedReceipt = { prev: string; receipt: CompactReceipt; hash: string };
export function savedReceipt(run: { receipt: string; receipt_hash: string }): SavedReceipt | null {
  if (!run.receipt || !run.receipt_hash) return null;
  try {
    const { prev, receipt } = JSON.parse(run.receipt) as { prev: string; receipt: CompactReceipt };
    return { prev, receipt, hash: run.receipt_hash };
  } catch {
    return null;
  }
}

/**
 * Whether a receipt saved earlier is still in its automation's chain: its fingerprint is its own, and
 * one of the automation's runs still has it. Compacting old detail leaves both, so it still checks.
 */
export async function verifyReceipt(automationId: string, saved: SavedReceipt): Promise<boolean> {
  if (typeof saved?.prev !== "string" || typeof saved.hash !== "string" || saved.receipt?.automation !== automationId) return false;
  if (receiptHash(saved.prev, saved.receipt) !== saved.hash) return false;
  return Boolean(await one("SELECT 1 FROM automation_runs WHERE automation_id = ? AND receipt_hash = ?", [automationId, saved.hash]));
}

/** The pauses that end by themselves: the tick looks again at resume_at (see resumePaused). */
export const SELF_ENDING = new Set(["credits", "month_cap", "day_cap"]);

/** What a run's end pauses its automation for, if anything: the reason, when the tick looks again, and its notice. */
function pauseFor(outcome: string, status: RunEnd, auto: AutoRow, now: number): { reason: string; resumeAt: number } | null {
  if (auto.trigger_kind !== "schedule" || auto.status !== "on") return null;
  if (outcome === "no_credits" || outcome === "topup_floor") return { reason: "credits", resumeAt: Number(auto.next_at) || now + 86_400_000 };
  if (outcome === "month_cap") return { reason: "month_cap", resumeAt: nextMonthStart(now) };
  if (outcome === "day_cap") return { reason: "day_cap", resumeAt: Math.floor(now / 86_400_000 + 1) * 86_400_000 };
  if (outcome === "price_up") return { reason: "price_up", resumeAt: 0 };
  if (outcome === "unconfirmed") return { reason: "unconfirmed", resumeAt: 0 };
  if (outcome === "closed") return { reason: "closed", resumeAt: 0 };
  if (status === "failed" && Number(auto.fail_streak) + 1 >= 3) return { reason: "failing", resumeAt: 0 };
  return null;
}

/**
 * Ends a run: its status and outcome, a short summary, its receipt and fingerprint (a compare-and-set
 * on the automation's chain), and in the same batch what it changes on the automation. me: only while
 * this worker holds the run; reaper: the reaper ending a run whose worker stopped. Then its notices.
 */
export async function finish(
  start: RunRow,
  status: RunEnd,
  outcome: string,
  o: { me?: string; reaper?: boolean; spec?: Spec; summary?: string; need?: number; offer?: Offer } = {},
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const run = await runRow(start.id);
    if (!run || Number(run.finished_at)) return false;
    if (!o.reaper && run.lease_owner !== o.me) return false;
    const auto = await automationRow(run.automation_id);
    // Its model as its receipt shows it (see receipt() in automation-api.ts): the step's, else, for a call
    // that was sent, its hold's.
    const steps = await all<StepReceipt>(
      `SELECT s.step_id, s.attempt, s.kind, s.status, s.held, s.credits, s.level, s.note, s.input, s.output,
              CASE WHEN s.model <> '' THEN s.model WHEN h.started = 1 THEN h.model ELSE '' END AS model
         FROM automation_run_steps s LEFT JOIN credit_holds h ON h.ref = s.hold_ref AND s.hold_ref <> ''
        WHERE s.run_id = ? ORDER BY s.started_at, s.attempt`,
      [run.id],
    );
    const vars = varsOf(run);
    const lastText = [...steps].reverse().find((s) => s.kind === "ai" && s.status === "done");
    const summary = (o.summary ?? (lastText ? vars[lastText.step_id] ?? outputText(lastText.output) : "")).replace(/\s+/g, " ").trim().slice(0, 500);
    const credits = Number(run.credits);
    const receipt = compactReceipt(run, steps, { status, outcome, credits, name: auto?.name ?? "", summary });
    const prev = auto?.receipt_hash ?? "";
    const hash = receiptHash(prev, receipt);
    const now = Date.now();
    const spec = o.spec ?? (await versionSpec(run.automation_id, Number(run.version)));
    let pause = auto ? pauseFor(outcome, status, auto, now) : null;
    // A one-off (as it is now) isn't paused for credits or a limit by a run that came up short (a Run once
    // now, or its old slot's run after it was moved): its own slot is priced when it comes, and ends it
    // with a notice saying why if it still doesn't fit, as any one-off's does.
    if (pause && auto && SELF_ENDING.has(pause.reason)) {
      const current = Number(auto.version) === Number(run.version) ? spec : await versionSpec(auto.id, Number(auto.version));
      if (current?.trigger.type === "schedule" && current.trigger.when.kind === "once") pause = null;
    }
    // A one-off that ran (or was skipped) is finished: while its automation is still that one-off, whose
    // slot was taken (next_at 0). Edited while this run went (into a daily, to a new time, or to run by
    // hand), it has more to run, and goes on as it is now.
    const once = spec?.trigger.type === "schedule" && spec.trigger.when.kind === "once" && run.origin === "schedule" && auto?.trigger_kind === "schedule" && Number(auto.next_at) === 0;
    const streak = status === "failed" ? Number(auto?.fail_streak ?? 0) + 1 : status === "done" ? 0 : Number(auto?.fail_streak ?? 0);
    const ended = { sql: "EXISTS (SELECT 1 FROM automation_runs WHERE id = ? AND receipt_hash = ? AND finished_at > 0)", args: [run.id, hash] };
    // Its notices go in the same batch, so a batch that lands with its answer lost still sends them.
    const notices = auto
      ? await noticesFor(run, auto, status, outcome, { credits, need: o.need ?? 0, pause: once ? null : pause, once, spec: spec ?? undefined, summary, offer: o.offer }).catch((err) => {
          console.error("[flash] automation notice failed", err instanceof Error ? err.name : "error");
          return [];
        })
      : [];
    const lease = o.reaper ? { sql: "1 = 1", args: [] } : { sql: "lease_owner = ?", args: [o.me ?? ""] };
    await probe("before-finish", { runId: run.id, prev });
    const rs = await (await db()).batch(
      [
        {
          sql: `UPDATE automation_runs SET status = ?, outcome = ?, summary = ?, receipt = ?, receipt_hash = ?, finished_at = ${DB_NOW}, updated_at = ${DB_NOW},
                       lease_owner = '', lease_until = 0, next_paid = 0, parked = 0
                 WHERE id = ? AND finished_at = 0 AND ${lease.sql}
                   AND (NOT EXISTS (SELECT 1 FROM automations WHERE id = ?) OR EXISTS (SELECT 1 FROM automations WHERE id = ? AND receipt_hash = ?))`,
          args: [status, outcome, summary, canonicalJson({ prev, receipt }), hash, run.id, ...lease.args, run.automation_id, run.automation_id, prev],
        },
        {
          // (next_at 0 and a schedule again here, as the automation is now: an edit meanwhile keeps its next run.)
          sql: `UPDATE automations SET receipt_hash = ?, last_status = ?, fail_streak = ?, updated_at = ${DB_NOW},
                       status = CASE WHEN ? = 1 AND status = 'on' AND next_at = 0 AND trigger_kind = 'schedule' THEN 'finished' ELSE status END
                 WHERE id = ? AND receipt_hash = ? AND ${ended.sql}`,
          args: [hash, outcome === "ok" ? status : outcome, streak, once ? 1 : 0, run.automation_id, prev, ...ended.args],
        },
        ...(pause && !once
          ? [
              {
                sql: `UPDATE automations SET status = 'paused', paused_reason = ?, paused_at = ${DB_NOW}, resume_at = ?, need_credits = ?
                       WHERE id = ? AND status = 'on' AND ${ended.sql}`,
                args: [pause.reason, pause.resumeAt, o.need ?? 0, run.automation_id, ...ended.args],
              },
              // Its queued and waiting runs wait with it.
              {
                sql: `UPDATE automation_runs SET parked = 1, updated_at = ${DB_NOW}
                       WHERE automation_id = ? AND finished_at = 0 AND parked = 0 AND status IN ('queued','waiting') AND lease_until < ${DB_NOW} AND ${ended.sql}`,
                args: [run.automation_id, ...ended.args],
              },
            ]
          : []),
        // A run with nothing new keeps only its summary.
        ...(outcome === "nothing_new"
          ? [{ sql: `UPDATE automation_run_steps SET output = NULL, input = '' WHERE run_id = ? AND ${ended.sql}`, args: [run.id, ...ended.args] }]
          : []),
        ...notices.map((n) => noticeStatement(n, ended)),
      ],
      "write",
    );
    if (rs[0].rowsAffected !== 1) continue;
    return true;
  }
  return false;
}

/** The notices a run's end sends (each once per ref, so a storm makes one). */
async function noticesFor(
  run: RunRow,
  auto: AutoRow,
  status: RunEnd,
  outcome: string,
  o: { credits: number; need: number; pause: { reason: string; resumeAt: number } | null; once?: boolean; spec?: Spec; summary: string; offer?: Offer },
): Promise<Notice[]> {
  const base = { userId: auto.user_id, link: automationLink(auto.id, run.id) };
  const name = auto.name;
  const month = utcDay(Date.now()).slice(0, 7);
  const notices: Notice[] = [];
  if (status === "interrupted") notices.push({ ...base, kind: "interrupted", phrase: NOTICES.interrupted, blanks: { name, credits: o.credits }, ref: `run:${run.id}:interrupted` });
  if (outcome === "run_cap") {
    // What was done is kept and delivered, with why it stopped.
    const delivers = o.spec?.steps.some((s) => s.do === "notify") && o.summary;
    notices.push({ ...base, kind: "stopped", phrase: NOTICES.runCap, blanks: { name, credits: Number(auto.cap_run), ...(delivers && { text: o.summary.slice(0, NOTICE_TEXT_CHARS) }) }, ref: `run:${run.id}:cap` });
  }
  if (o.pause?.reason === "credits") {
    const floor = outcome === "topup_floor" ? await topUpFloor(auto.pay_account) : 0;
    // With the cheaper way to run it (Quick research for Research, Sonic for Write) and its most.
    const offer: Record<string, string | number> = o.offer ? { offer: o.offer.offer, offerCredits: o.offer.credits } : {};
    notices.push(
      outcome === "topup_floor"
        ? { ...base, kind: "credits", phrase: NOTICES.topupFloor, blanks: { name, credits: floor, ...offer }, ref: `credits:${auto.id}:${month}` }
        : // "Up to": a whole run's worst case (as quoted), never more than the run limit.
          { ...base, kind: "credits", phrase: NOTICES.waitingCredits, blanks: { name, credits: Math.min(Number(auto.cap_run), Math.max(o.need, Number(auto.quoted_max) || 0)), ...offer }, ref: `credits:${auto.id}:${month}` },
    );
  }
  if (o.pause?.reason === "month_cap") notices.push({ ...base, kind: "paused", phrase: NOTICES.monthCap, blanks: { name, date: o.pause.resumeAt, credits: Number(auto.cap_month) }, ref: `month:${auto.id}:${month}` });
  if (o.pause?.reason === "price_up") notices.push({ ...base, kind: "paused", phrase: NOTICES.priceUp, blanks: { name, credits: o.need, cap: Number(auto.cap_run) }, ref: `price:${auto.id}:${o.need}` });
  if (o.pause?.reason === "failing") notices.push({ ...base, kind: "paused", phrase: NOTICES.failing, blanks: { name }, ref: `failing:${auto.id}:${utcDay(Date.now())}` });
  if (outcome === "unconfirmed") notices.push({ ...base, kind: "paused", phrase: NOTICES.unconfirmed, blanks: { name }, ref: `unconfirmed:${auto.id}` });
  // A one-off doesn't wait or pause: it is finished, and says why it didn't run.
  if (o.once) {
    const ref = `run:${run.id}:skipped`;
    if (outcome === "no_credits") notices.push({ ...base, kind: "credits", phrase: NOTICES.noCredits, blanks: { name }, ref });
    else if (outcome === "topup_floor") notices.push({ ...base, kind: "credits", phrase: NOTICES.topupFloor, blanks: { name, credits: await topUpFloor(auto.pay_account) }, ref });
    else if (outcome === "month_cap" || outcome === "day_cap" || outcome === "price_up") notices.push({ ...base, kind: "stopped", phrase: NOTICES.onceSkipped, blanks: { name }, ref });
    // Its only run failed: it never runs again, so it says so (an automation that repeats says so after 3).
    else if (status === "failed") notices.push({ ...base, kind: "stopped", phrase: o.credits > 0 ? NOTICES.failedCharged : NOTICES.failed, blanks: { name, credits: o.credits }, ref: `run:${run.id}:failed` });
  }
  return notices;
}
