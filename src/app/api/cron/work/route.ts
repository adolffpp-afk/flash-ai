import { after } from "next/server";
import { advanceRun } from "@/lib/server/automation-runner.ts";
import { cronRefusal } from "@/lib/server/automations.ts";

/*
 * One claimed automation run, moved forward in a function of its own (sent by the tick with the cron
 * secret): the same checks as the tick, then 202 at once, and the run's steps go on after the answer
 * for up to WORK_MS (Vercel Pro's longest function is 800 s, and after() runs within it). Only the
 * worker named by owner, the run's lease holder, moves it.
 */
export const maxDuration = 800;
const WORK_MS = 760_000;

export async function POST(request: Request) {
  const refused = cronRefusal(request);
  if (refused) return refused;
  let body: { runId?: unknown; owner?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response(null, { status: 400 });
  }
  const { runId, owner } = body ?? {};
  if (typeof runId !== "string" || typeof owner !== "string" || !runId || !owner || runId.length > 64 || owner.length > 128) {
    return new Response(null, { status: 400 });
  }
  const deadline = Date.now() + WORK_MS;
  after(() => advanceRun(runId, owner, deadline).catch((err) => console.error("[flash] automation run failed", err instanceof Error ? err.name : "error")));
  return new Response(null, { status: 202 });
}
