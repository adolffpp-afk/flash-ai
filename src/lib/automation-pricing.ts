/*
 * The numbers automations are priced and limited with, in one place so they are easy to change.
 * AI steps cost exactly what chat costs at the same level (src/lib/credits.ts: planHold and
 * finalCredits, never edited here); Research steps cost what chat Research costs. What is set here is
 * only the default limits a new automation gets, which its owner can change:
 * - per run: the worst case of one run (the sum of its AI steps' holds), so a run is never cut short
 *   by its own default;
 * - per month: the larger of one run's worst case and a typical run × the runs it makes in the next
 *   30 days × MONTH_HEADROOM.
 * Price question 3 in the automations plan (its answers agree), pending the profitability thread's
 * final confirmation: change them here, never in src/lib/credits.ts.
 */

/** Room on top of the typical month, so a few long runs don't pause it. */
export const MONTH_HEADROOM = 1.5;

/** What a typical AI step writes, for "usually about N" (the estimate, never the hold). */
export const TYPICAL_OUTPUT_TOKENS = 1000;
/** What a typical Research step searches and reads (Quick research does one of each). */
export const TYPICAL_RESEARCH = { searches: 2, pages: 2 };
export const TYPICAL_QUICK_RESEARCH = { searches: 1, pages: 1 };
/** What a page or a search result typically adds to what the next step reads, in tokens. */
export const TYPICAL_RESULT_TOKENS = 3000;

/** The limits a new automation starts with: per run the worst case, per month as above. */
export function defaultLimits(worstPerRun: number, typicalPerRun: number, runsIn30Days: number): { capRun: number; capMonth: number } {
  const capRun = Math.max(1, Math.ceil(worstPerRun));
  const capMonth = Math.max(capRun, Math.ceil(typicalPerRun * runsIn30Days * MONTH_HEADROOM));
  return { capRun, capMonth };
}
