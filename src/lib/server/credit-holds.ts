/*
 * Credit holds that are settled exactly once, even when the function holding one dies (an automation's
 * paid step; later a chat reply finished with the tab closed). The order inside a paid step:
 *   1. the hold is recorded (recordHold) before any credits move;
 *   2. the credits are taken (chargeOnce, server/credits.ts), then the charge's id is kept (markCharged);
 *   3. started is set just before the provider call is sent (markStarted);
 *   4. while it runs, the hold's lease is renewed with the meter's checkpoint (heartbeat), and when the
 *      call ends its final cost goes in with done = 1 (markDone);
 *   5. it is settled in one batch with a token of its own (settleHold): only the writer whose token
 *      landed lowers the ledger, so a worker finishing and the reaper can't both settle it.
 * Past its lease the tick's reaper settles it (see reaperCredits for what it charges).
 */
import type { InStatement, InValue } from "@libsql/client";
import { claudePrice, creditsFor, fallbackModel, WEB_SEARCH_CENTS } from "../credits.ts";
import { PEAK_TOKENS_PER_SECOND } from "../engines/claude.ts";
import { db, run as sql } from "./db.ts";
import { randomId } from "./ids.ts";
import { DB_NOW } from "./leases.ts";

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
  checked_at: number;
  lease_until: number;
  settled_at: number;
  credits: number;
  created_at: number;
};

/**
 * Records a hold before any credits move, with the whole worst case of its plan as what is left.
 * A hold with this ref already recorded is kept as it is (false): the charge then finds its replay.
 */
export async function recordHold(h: { ref: string; userId: string; runId: string; held: number; model: string; inputCents: number; leftCents: number }): Promise<boolean> {
  const r = await sql(
    `INSERT INTO credit_holds (ref, user_id, run_id, held, model, input_cents, left_cents, lease_until, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ${DB_NOW} + ?, ${DB_NOW})
     ON CONFLICT(ref) DO NOTHING`,
    [h.ref, h.userId, h.runId, h.held, h.model, h.inputCents, h.leftCents, HOLD_LEASE_MS],
  );
  return r.rowsAffected === 1;
}

/** Keeps the id of the ledger row the hold took. */
export async function markCharged(ref: string, chargeId: number) {
  await sql("UPDATE credit_holds SET charge_id = ? WHERE ref = ? AND settled_at = 0", [chargeId, ref]);
}

/** Marks the provider call as sent, just before it is. False when the hold was settled meanwhile (don't send it). */
export async function markStarted(ref: string): Promise<boolean> {
  const r = await sql(`UPDATE credit_holds SET started = 1, lease_until = ${DB_NOW} + ?, checked_at = ${DB_NOW} WHERE ref = ? AND settled_at = 0`, [HOLD_LEASE_MS, ref]);
  return r.rowsAffected === 1;
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
 */
export async function settleHold(ref: string, credits: number, then: (won: Won) => InStatement[] = () => []): Promise<boolean> {
  const token = randomId(9);
  const won: Won = { sql: "EXISTS (SELECT 1 FROM credit_holds WHERE ref = ? AND settle_token = ?)", args: [ref, token] };
  const c = Math.max(0, Math.round(credits));
  const rs = await (await db()).batch(
    [
      { sql: `UPDATE credit_holds SET settle_token = ?, settled_at = ${DB_NOW}, credits = ? WHERE ref = ? AND settled_at = 0`, args: [token, c, ref] },
      { sql: `UPDATE credit_ledger SET amount = MAX(amount, ?), settled_at = ${DB_NOW} WHERE ref = ? AND ${won.sql}`, args: [-c, ref, ...won.args] },
      ...then(won),
    ],
    "write",
  );
  return rs[0].rowsAffected === 1;
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
 *   before that lease ends, so this is never less than the provider could have billed.
 */
export function reaperCredits(h: Pick<Hold, "held" | "started" | "done" | "spent_cents" | "left_cents" | "input_cents" | "checked_at" | "lease_until" | "created_at" | "model">, charged: boolean): number {
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
  return Math.min(held, creditsFor(incurred));
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
