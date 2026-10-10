/*
 * The price question: a request that costs at least CONFIRM_CREDITS waits for the user to agree to
 * its price (Go ahead, or "yes" in a voice conversation). What Flash decided and priced before asking
 * comes back with that yes, so exactly what was asked about runs, at no more than the price asked.
 */
import { ENGINES, type Engine } from "./types.ts";
import type { UIMessage } from "./store.ts";

/** Requests that cost at least this many credits wait for the user to agree to the price first. */
export const CONFIRM_CREDITS = 50;

/**
 * What the router and the picture check decided for a request before Flash asked the user to agree
 * to its price: the engine, and whether the picture above is made fresh. The request the user agrees
 * to uses it instead of asking them again, so the engine and the price can't change after the user
 * agreed, and the helpers that decided are paid for by that request (its price includes them, see
 * CHECK_ALLOWANCE_CENTS). It only picks what the user could pick themselves. model and credits are
 * the price asked: the request runs on that model, and only at no more than those credits, or the
 * user is asked about the new price.
 */
export type Decided = { engine: Engine; fresh?: boolean; model?: string; credits?: number };

/** What the browser sends about the price: confirmed (yes, or yes to every price) and what came back with the question. */
export type PriceAnswer = { confirmed?: unknown; decided?: unknown };

/**
 * What the user said yes to (see Decided), or null when there's none, or it was for another tool
 * than the one picked now (override). Chats saved before prices were kept with it send no model or credits.
 */
export function decidedFor(body: PriceAnswer, override: Engine | null): Decided | null {
  const d = (body.decided ?? null) as Partial<Decided> | null;
  if (body.confirmed !== true || !d || typeof d !== "object" || !(ENGINES as readonly string[]).includes(d.engine as string)) return null;
  const engine = d.engine as Engine;
  if (override && engine !== override) return null;
  const priced = typeof d.model === "string" && typeof d.credits === "number" && Number.isFinite(d.credits) && d.credits > 0;
  return { engine, fresh: d.fresh === true, ...(priced && { model: d.model, credits: d.credits }) };
}

/**
 * Whether the user agreed to pay needed credits for a request on model: to every price (confirmed
 * alone, "always" on their device), or to the price asked, for this model at no more than those
 * credits. A yes sent back for something else (another tool was picked since) is asked about again.
 */
export function consents(body: PriceAnswer, decided: Decided | null, model: string | null, needed: number): boolean {
  if (body.confirmed !== true) return false;
  if (!decided) return !body.decided;
  return !decided.model || (model === decided.model && needed <= (decided.credits ?? 0));
}

/**
 * Whether a chat is waiting for a yes to a price: its last message is the price question asked
 * right after the last request, and nothing is running. reply: only when it's that question.
 */
export function priceWaiting(messages: readonly UIMessage[], reply?: string): boolean {
  const asked = messages.at(-1);
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  if (!asked || asked.role !== "assistant" || lastUser !== messages.length - 2) return false;
  return asked.errorCode === "confirm_cost" && !asked.pending && (reply === undefined || asked.id === reply);
}
