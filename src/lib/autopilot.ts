/*
 * What a finished run comes to, in one word the person can act on (Universal Autopilot A2, point 8 of
 * its spec): Done (it finished and every check passed), Partly done (it finished, but a check didn't
 * pass or it was cut short), Needs you (it stopped before its end: credits, a limit, or Stop) or
 * Didn't finish (Flash couldn't: nothing more was charged). Shared by every receipt. Pure.
 */
import { msg } from "./i18n.ts";

export type Verdict = "done" | "partly" | "needs_you" | "not_finished";

export const VERDICT_WORDS: Record<Verdict, string> = {
  done: msg("Done"),
  partly: msg("Partly done"),
  needs_you: msg("Needs you"),
  not_finished: msg("Didn't finish"),
};

/** The verdict of a run that ended (null while it goes on), from its status, outcome and checks. */
export function verdictOf(run: { status: string; outcome: string; finishedAt: number }, checks: { pass: boolean }[]): Verdict | null {
  if (!run.finishedAt) return null;
  if (run.status === "done") return run.outcome === "cut_short" || checks.some((c) => !c.pass) ? "partly" : "done";
  if (run.status === "failed" || run.status === "interrupted") return "not_finished";
  return "needs_you";
}
