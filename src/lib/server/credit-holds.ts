/*
 * Credit holds that are settled exactly once, even when the function holding one dies (an automation's
 * paid step; later a chat reply finished with the tab closed). The order inside a paid step:
 *   1. the hold is recorded (recordHold) before any credits move, only while the worker holds the run's lease;
 *   2. the credits are taken (chargeOnce, server/credits.ts), then the charge's id is kept (markCharged);
 *   3. started is set just before the provider call is sent (markStarted);
 *   4. while it runs, the hold's lease is renewed with the meter's checkpoint (heartbeat), and when the
 *      call ends its final cost goes in with done = 1 (markDone);
 *   5. it is settled in one batch with a token of its own (settleHold): only the writer whose token
 *      landed lowers the ledger, so a worker finishing and the reaper can't both settle it.
 * Past its lease the tick's reaper settles it (see reaperCredits for what it charges), only as it read
 * it: a heartbeat that lands first keeps the hold open.
 */
import type { InStatement, InValue } from "@libsql/client";
import { claudePrice, creditsFor, fallbackModel, WEB_SEARCH_CENTS } from "../credits.ts";
import { PEAK_TOKENS_PER_SECOND } from "../engines/claude.ts";
import { HOLD_MINUTES } from "./credits.ts";
import { db, one, run as sql } from "./db.ts";
import { randomId } from "./ids.ts";
import { DB_NOW } from "./leases.ts";
import { watchBalance } from "./low-balance.ts";

/** How long a hold's lease lasts after each heartbeat (sent every 60 s, see automation-steps.ts). */
export const HOLD_LEASE_MS = 150_000;

export type Hold = {
  ref: string;
  user_id: string;
  run_id: string;
  charge_id: number;
  held: number;
  model: string;
  input_cents: number;
  started: number;
  done: number;
  spent_cents: number;
  left_cents: number;
  cap_cents: number;
  checked_at: number;
  lease_until: number;
  settled_at: number;
  credits: number;
  created_at: number;
};

/**
 * Records a hold before any credits move, with the whole worst case of its plan as what is left.
 * owner: only while that worker still holds the run's lease (a worker that outlived its lease, say
 * on a slow token count, records nothing, so it can't charge or call Claude next to the run's new
 * worker). False when it wasn't recorded: the lease is gone, or a hold with this ref is kept as it is.
 * capCents: the most the step's calls may cost by its plan (0: no bound but the hold), see reaperCredits.
 */
export async function recordHold(h: {
  ref: string;
  userId: string;
  runId: string;
  held: number;
  model: string;
  inputCents: number;
  leftCents: number;
  capCents?: number;
  owner?: string;
}): Promise<boolean> {
  const lease = h.owner === undefined ? "1 = 1" : `EXISTS (SELECT 1 FROM automation_runs WHERE id = ? AND lease_owner = ? AND lease_until > ${DB_NOW})`;
  const r = await sql(
    `INSERT INTO credit_holds (ref, user_id, run_id, held, model, input_cents, left_cents, cap_cents, lease_until, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ${DB_NOW} + ?, ${DB_NOW} WHERE ${lease}
     ON CONFLICT(ref) DO NOTHING`,
    [h.ref, h.userId, h.runId, h.held, h.model, h.inputCents, h.leftCents, h.capCents ?? 0, HOLD_LEASE_MS, ...(h.owner === undefined ? [] : [h.runId, h.owner])],
  );
  return r.rowsAffected === 1;
}

/**
 * Sizes a hold again before anything was taken under it (its charge was refused at a limit, and its step
 * is planned once more within what is left): only while it is open and nothing is in the ledger under
 * its ref (its charge, its charge id and its start mark all come after that row, which is never deleted).
 */
export async function resizeHold(ref: string, held: number, leftCents: number, capCents = 0): Promise<boolean> {
  const r = await sql(
    `UPDATE credit_holds SET held = ?, left_cents = ?, cap_cents = ? WHERE ref = ? AND settled_at = 0
        AND NOT EXISTS (SELECT 1 FROM credit_ledger WHERE ref = ?)`,
    [held, leftCents, capCents, ref, ref],
  );
  return r.rowsAffected === 1;
}

/**
 * What other requests' open holds take now from an account, and of that from one automation (its month
 * and day limits count them): other runs' steps priced at the same moment (read through the open holds
 * only, credit_holds_open), and chat replies still being written (their charge is held, unsettled and
 * with no ref, until the reply ends, as monthlyCredits counts them), each held at its worst case and
 * settled within its own time, mostly far lower. exceptRef: the asking step's own hold, left out (it has no
 * ledger row while its charge is refused, so this only matters should it ever have one). An open hold's
 * lease_until is never 0, so "lease_until > 0" changes no answer: it lets the read use credit_holds_open.
 * A chat reply's row counts only while negative: refund() writes the only positive rows with no ref, and
 * nothing calls it yet.
 */
export async function heldElsewhere(account: string, automationId: string, exceptRef = ""): Promise<{ account: number; automation: number }> {
  const [row, chat] = await Promise.all([
    one<{ account: number; automation: number }>(
      `SELECT COALESCE(-SUM(l.amount), 0) AS account, COALESCE(-SUM(CASE WHEN l.automation_id = ? THEN l.amount ELSE 0 END), 0) AS automation
         FROM credit_holds h JOIN credit_ledger l ON l.ref = h.ref
        WHERE h.settled_at = 0 AND h.lease_until > 0 AND h.user_id = ? AND h.ref <> ? AND l.amount < 0`,
      [automationId, account, exceptRef],
    ),
    one<{ held: number }>(
      "SELECT COALESCE(-SUM(amount), 0) AS held FROM credit_ledger WHERE user_id = ? AND amount < 0 AND settled_at = 0 AND ref IS NULL AND created_at > ?",
      [account, Date.now() - HOLD_MINUTES * 60_000],
    ),
  ]);
  return {
    account: Math.max(0, Number(row?.account ?? 0)) + Math.max(0, Number(chat?.held ?? 0)),
    automation: Math.max(0, Number(row?.automation ?? 0)),
  };
}

/** Keeps the id of the ledger row the hold took. */
export async function markCharged(ref: string, chargeId: number) {
  await sql("UPDATE credit_holds SET charge_id = ? WHERE ref = ? AND settled_at = 0", [chargeId, ref]);
}

/**
 * Marks the provider call as sent, just before it is, unless the hold was settled meanwhile ("settled")
 * or its run was asked to stop ("stopped", say while the step was being priced): either way, don't send it.
 */
export async function markStarted(ref: string): Promise<"started" | "settled" | "stopped"> {
  const r = await sql(
    `UPDATE credit_holds SET started = 1, lease_until = ${DB_NOW} + ?, checked_at = ${DB_NOW} WHERE ref = ? AND settled_at = 0
        AND NOT EXISTS (SELECT 1 FROM automation_runs WHERE id = credit_holds.run_id AND stop_requested = 1)`,
    [HOLD_LEASE_MS, ref],
  );
  if (r.rowsAffected === 1) return "started";
  const h = await one<{ settled_at: number }>("SELECT settled_at FROM credit_holds WHERE ref = ?", [ref]);
  return !h || Number(h.settled_at) ? "settled" : "stopped";
}

/**
 * Renews the hold's lease with the meter's checkpoint: what the step has cost so far, and the worst
 * case of what the plan still allows. Returns the rows changed: 0 means the reaper settled it, and the
 * step must stop at once.
 */
export async function heartbeat(ref: string, spentCents: number, leftCents: number): Promise<number> {
  const r = await sql(
    `UPDATE credit_holds SET lease_until = ${DB_NOW} + ?, spent_cents = ?, left_cents = ?, checked_at = ${DB_NOW} WHERE ref = ? AND settled_at = 0`,
    [HOLD_LEASE_MS, spentCents, leftCents, ref],
  );
  return r.rowsAffected;
}

/** The provider call ended: its final cost, so a reaper that settles it charges exactly that. */
export async function markDone(ref: string, spentCents: number): Promise<boolean> {
  const r = await sql(
    `UPDATE credit_holds SET done = 1, spent_cents = ?, left_cents = 0, checked_at = ${DB_NOW}, lease_until = ${DB_NOW} + ? WHERE ref = ? AND settled_at = 0`,
    [spentCents, HOLD_LEASE_MS, ref],
  );
  return r.rowsAffected === 1;
}

/** The SQL that is true only for the writer whose settle token landed, for the statements settled with it. */
export type Won = { sql: string; args: InValue[] };

/**
 * Settles a hold at credits, once: in one batch, the hold takes this writer's token if nobody settled
 * it yet, the ledger row is lowered to credits (never raised), and the statements from `then` run,
 * each conditioned on the token (won). Returns whether this writer settled it.
 * leaseUntil: only if the hold's lease is still the one this writer read (the reaper settles what it
 * read; every markStarted, heartbeat and markDone moves the lease, so a hold that changed since is left).
 * When the batch fails, the hold says whether it landed (its token), and it is sent again only if not.
 */
export async function settleHold(ref: string, credits: number, then: (won: Won) => InStatement[] = () => [], o: { leaseUntil?: number } = {}): Promise<boolean> {
  const token = randomId(9);
  const won: Won = { sql: "EXISTS (SELECT 1 FROM credit_holds WHERE ref = ? AND settle_token = ?)", args: [ref, token] };
  const c = Math.max(0, Math.round(credits));
  const same = o.leaseUntil === undefined ? { sql: "", args: [] } : { sql: " AND lease_until = ?", args: [o.leaseUntil] };
  const statements: InStatement[] = [
    { sql: `UPDATE credit_holds SET settle_token = ?, settled_at = ${DB_NOW}, credits = ? WHERE ref = ? AND settled_at = 0${same.sql}`, args: [token, c, ref, ...same.args] },
    { sql: `UPDATE credit_ledger SET amount = MAX(amount, ?), settled_at = ${DB_NOW} WHERE ref = ? AND ${won.sql}`, args: [-c, ref, ...won.args] },
    ...then(won),
  ];
  for (let attempt = 1; ; attempt++) {
    try {
      const rs = await (await db()).batch(statements, "write");
      return settled(ref, rs[0].rowsAffected === 1);
    } catch (err) {
      const h = await one<{ settled_at: number; settle_token: string }>("SELECT settled_at, settle_token FROM credit_holds WHERE ref = ?", [ref]).catch(() => null);
      if (h && Number(h.settled_at)) return settled(ref, h.settle_token === token);
      if (!h || attempt >= 3) throw err;
    }
  }
}

/**
 * Whether this writer settled the hold (won); when it did, its charge is looked at like any spend (see
 * low-balance.ts), so its account's low-credit email can go now. Never an auto top-up: a run keeps the
 * top-up level (keepTopUpLevel) and buys nothing.
 */
async function settled(ref: string, won: boolean): Promise<boolean> {
  if (!won) return false;
  const row = await one<{ user_id: string; amount: number }>("SELECT user_id, amount FROM credit_ledger WHERE ref = ?", [ref]).catch(() => null);
  if (row) watchBalance(String(row.user_id), -Number(row.amount), { topUp: false });
  return true;
}

/** Holds the reaper should settle: still open, with their lease run out. */
export async function lapsedHolds(limit = 50): Promise<Hold[]> {
  const r = await sql(`SELECT * FROM credit_holds WHERE settled_at = 0 AND lease_until < ${DB_NOW} ORDER BY lease_until LIMIT ?`, [limit]);
  return r.rows as unknown as Hold[];
}

/** The open holds of a run (the claim never takes such a run; an earlier attempt's is settled first). */
export async function openHolds(runId: string): Promise<Hold[]> {
  const r = await sql("SELECT * FROM credit_holds WHERE run_id = ? AND settled_at = 0 AND run_id <> ''", [runId]);
  return r.rows as unknown as Hold[];
}

/**
 * What a hold left behind is settled at, in credits, never above what was held:
 * - nothing was charged (no ledger row), or the provider was never called: 0;
 * - the call ended (done): its final metered cost;
 * - otherwise what it had cost at its last checkpoint (at least reading its input once), plus the most
 *   the model could have written from then to the lease's end at PEAK_TOKENS_PER_SECOND, plus the
 *   worst case of every tool round and search its plan still allowed. The worker stops its own stream
 *   before that lease ends, so this is never less than the provider could have billed;
 * and never above what its plan let its calls cost (cap_cents, when the plan paid for no fallback: its
 * max_tokens and every round within it), as a step finished at its max_tokens is charged no more.
 */
export function reaperCredits(
  h: Pick<Hold, "held" | "started" | "done" | "spent_cents" | "left_cents" | "input_cents" | "checked_at" | "lease_until" | "created_at" | "model"> & { cap_cents?: number },
  charged: boolean,
): number {
  if (!charged || !Number(h.started)) return 0;
  const held = Number(h.held);
  if (Number(h.done)) return Number(h.spent_cents) > 0 ? Math.min(held, creditsFor(Number(h.spent_cents))) : 0;
  const since = Math.max(Number(h.checked_at), Number(h.created_at));
  const seconds = Math.max(0, Number(h.lease_until) - since) / 1000;
  // With a refusal fallback, the fallback could have written too.
  const backup = fallbackModel(h.model);
  const outputPrice = claudePrice(h.model).output + (backup ? claudePrice(backup).output : 0);
  const gap = (seconds * PEAK_TOKENS_PER_SECOND * outputPrice) / 1e6;
  const incurred = Math.max(Number(h.spent_cents), Number(h.input_cents)) + gap + Number(h.left_cents);
  const cap = Number(h.cap_cents ?? 0) > 0 ? Number(h.cap_cents) : Infinity;
  return Math.min(held, creditsFor(Math.min(incurred, cap)));
}

/**
 * What a hold's call is known to have cost when it is settled by the reaper: its final cost once it
 * ended, else its last checkpoint (at least reading its input once); 0 if it was never sent. The
 * reaper logs this as the call's AI cost on /admin, and a worker that finds its hold reaped adds only
 * what it cost on top.
 */
export function reapedCents(h: Pick<Hold, "started" | "done" | "spent_cents" | "input_cents">): number {
  if (!Number(h.started)) return 0;
  return Number(h.done) ? Number(h.spent_cents) : Math.max(Number(h.spent_cents), Number(h.input_cents));
}

/**
 * The worst case a paid step's plan still allows after some of its tool results and searches: a full
 * re-read of the largest input the hold allowed for each result to come, with its fallback's, plus 1¢
 * for each search left.
 */
export function leftCents(o: { model: string; largestInput: number; resultsLeft: number; searchesLeft: number; fallback: boolean }): number {
  const read = (model: string) => (o.largestInput * claudePrice(model, o.largestInput).input) / 1e6;
  const backup = o.fallback ? fallbackModel(o.model) : undefined;
  const perResult = read(o.model) + (backup ? read(backup) : 0);
  return Math.max(0, o.resultsLeft) * perResult + Math.max(0, o.searchesLeft) * WEB_SEARCH_CENTS;
}
