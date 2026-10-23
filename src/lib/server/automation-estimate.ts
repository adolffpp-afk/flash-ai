/*
 * The price of an automation before it runs (POST /api/automations/estimate, and again when it is
 * saved, turned on or run by hand): the most one run can cost, what it usually costs, about what a
 * month of its schedule costs, and the limits a new one starts with (src/lib/automation-pricing.ts).
 *
 * Each AI step is priced as the runner prices it (automation-price.ts, from chat's prices in
 * src/lib/credits.ts, which this file only reads), with its own instruction, system prompt and data
 * tools, counted with the automations key:
 * - the most a run costs is the sum of its AI steps' holds with no limit on what is available, so a
 *   run is never charged more than it says (its output and tools are capped by that hold);
 * - an "only if changed" step reads its previous result too, counted at its longest, and a Check step
 *   the result it checks and its pages, at their longest;
 * - a count is kept a day by (model, text), and when counting fails the text is priced at 3 tokens a
 *   character (worstTokens), which is still the most it can be; what Anthropic said goes to the logs,
 *   and to an admin with the estimate (countProblem), so /admin can say why.
 */
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { defaultLimits, TYPICAL_OUTPUT_TOKENS, TYPICAL_QUICK_RESEARCH, TYPICAL_RESEARCH, TYPICAL_RESULT_TOKENS } from "../automation-pricing.ts";
import { isCheck, isPaid, type AiStep, type Spec } from "../automations.ts";
import { claudePrice, creditsFor, planHold, WEB_SEARCH_CENTS, worstTokens } from "../credits.ts";
import { countInputTokens } from "../engines/claude.ts";
import { firesBetween } from "../schedule.ts";
import type { ChatTurn } from "../types.ts";
import { priceStep, type Counter } from "./automation-price.ts";
import { CHECKED_CHARS, CHECKED_PAGES_CHARS, PREVIOUS_CHARS, STEP_TIMING, stepInputs, type AutoRow } from "./automation-steps.ts";
import { anthropicProblem, automationClient, problemKind, type ProblemKind } from "./automations.ts";
import { isAdmin, type User } from "./auth.ts";

const DAY = 86_400_000;
// Room for what changes from one run to the next in what a step reads: its date and time lines.
const RUN_SLACK_TOKENS = 200;

export type StepEstimate = { id: string; worst: number; typical: number; tokens: number };
export type Estimate = {
  // Never more than this a run, and usually about this (an estimate).
  worst: number;
  typical: number;
  // The least its first AI step holds to start (with less left of its month limit, it's skipped).
  least: number;
  // Runs in the next 30 days (0 for one its owner starts), and about what they cost.
  runs: number;
  month: number;
  // The limits a new automation starts with.
  limits: { capRun: number; capMonth: number };
  // False when a count failed and the text was priced at its most.
  counted: boolean;
  // What Anthropic said when the first count failed (status, type and words, never a key) and what it
  // means (see problemKind): for admins only.
  countProblem?: { text: string; kind: ProblemKind };
  steps: StepEstimate[];
};

/** Counts kept a day by (model, text), so an editor asking again costs no call (at most 500). */
const counts = new Map<string, { tokens: number; at: number }>();
const COUNTS_KEPT = 500;

/** A counter for estimates: kept counts first, then the automations key, then the most the text can be. */
function estimateCounter(o: { counted: boolean; problem?: { text: string; kind: ProblemKind } }): Counter {
  return async (model: string, history: ChatTurn[], systemPrompt: string, client: Anthropic) => {
    const text = `${systemPrompt}\u0000${history.map((h) => (typeof h.content === "string" ? h.content : JSON.stringify(h.content))).join("\u0000")}`;
    const key = createHash("sha256").update(`${model}\u0000${text}`).digest("hex");
    const kept = counts.get(key);
    if (kept && Date.now() - kept.at < DAY) return kept.tokens;
    try {
      const tokens = await countInputTokens(model, history, systemPrompt, undefined, client);
      counts.delete(key);
      counts.set(key, { tokens, at: Date.now() });
      while (counts.size > COUNTS_KEPT) counts.delete(counts.keys().next().value!);
      return tokens;
    } catch (err) {
      o.counted = false;
      if (!o.problem) {
        o.problem = { text: anthropicProblem(err), kind: problemKind(err) };
        console.error(`Automation estimate: counting failed on ${model}: ${o.problem.text}`);
      }
      // countInputTokens leaves 3,000 tokens for tools when there are none; so does this.
      return worstTokens(text.length) + 3000;
    }
  };
}

/** What a step usually costs: its input read once, a typical answer at its model, and for Research its usual searches and pages. */
function typicalStep(step: AiStep, model: string, tokens: number): number {
  const price = claudePrice(model, tokens);
  const research = step.mode === "research" ? TYPICAL_RESEARCH : step.mode === "quick" ? TYPICAL_QUICK_RESEARCH : { searches: 0, pages: 0 };
  // Each result found is read again by the call after it.
  const read = tokens + (research.searches + research.pages) * TYPICAL_RESULT_TOKENS;
  const cents = (read * price.input + TYPICAL_OUTPUT_TOKENS * price.output) / 1e6 + research.searches * WEB_SEARCH_CENTS;
  return creditsFor(cents);
}

/**
 * Prices a spec for its owner, as one of its runs would be priced now. auto is the automation as it
 * is (or would be) saved: its name, zone and place.
 */
export async function estimateSpec(
  spec: Spec,
  user: User,
  auto: Pick<AutoRow, "name" | "time_zone" | "where_json" | "language">,
  o: { client?: Anthropic; now?: number } = {},
): Promise<Estimate> {
  // Counting gets the runner's short time (the SDK's default is 10 minutes): a Run once now is timed from its request.
  const client = o.client ?? automationClient().withOptions({ timeout: STEP_TIMING.countMs, maxRetries: 1 });
  const now = o.now ?? Date.now();
  const state: { counted: boolean; problem?: { text: string; kind: ProblemKind } } = { counted: true };
  const count = estimateCounter(state);
  const steps: StepEstimate[] = [];
  let least = 0;
  const origin = spec.trigger.type === "schedule" ? "schedule" : "owner";
  for (const step of spec.steps) {
    if (!isPaid(step)) continue;
    // The previous result an "only if changed" step reads, at its longest: counted as the most it can be.
    const check = isCheck(step);
    const inputs = await stepInputs({ auto, spec, run: { origin }, user, step, now: new Date(now), previous: step.onlyIfChanged ? " " : null, checked: check ? { text: " ", sources: [] } : null });
    const price = await priceStep(step, inputs.history, inputs.preferences, inputs.options, inputs.data, client, count);
    const tokens = price.tokens + RUN_SLACK_TOKENS + (step.onlyIfChanged ? worstTokens(PREVIOUS_CHARS) : 0) + (check ? worstTokens(CHECKED_CHARS + CHECKED_PAGES_CHARS) : 0);
    const worst = planHold(price.engine, price.choice.model, tokens, Infinity, price.scale, 0, price.plan).held;
    if (!steps.length) least = planHold(price.engine, price.choice.model, tokens, 0, price.scale, 0, price.plan).needed;
    steps.push({ id: step.id, worst, typical: typicalStep(step, price.choice.model, tokens), tokens });
  }
  const worst = steps.reduce((sum, s) => sum + s.worst, 0);
  const typical = steps.reduce((sum, s) => sum + s.typical, 0);
  const runs = spec.trigger.type === "schedule" ? firesBetween(spec.trigger.when, auto.time_zone, now, now + 30 * DAY) : 0;
  const countProblem = state.problem && isAdmin(user) ? state.problem : undefined;
  return { worst, typical, least, runs, month: typical * runs, limits: defaultLimits(worst, typical, runs), counted: state.counted, ...(countProblem && { countProblem }), steps };
}

/** Forgets the kept counts (tests). */
export const forgetCounts = () => counts.clear();
