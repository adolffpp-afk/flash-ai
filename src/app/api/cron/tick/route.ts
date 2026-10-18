import { after } from "next/server";
import { anythingDue, runTick } from "@/lib/server/automation-tick.ts";
import { cronRefusal } from "@/lib/server/automations.ts";
import { randomId } from "@/lib/server/ids.ts";

/*
 * The per-minute tick, called by Vercel Cron (vercel.json) with CRON_SECRET as its bearer token: 404
 * off production, 503 until CRON_SECRET is set, 401 for anyone else. It answers at once: 204 when
 * nothing is due (indexed reads only, no writes), else 202, and the tick runs after the answer (see
 * automation-tick.ts), within this function's time.
 */
export const maxDuration = 60;

export async function GET(request: Request) {
  const refused = cronRefusal(request);
  if (refused) return refused;
  if (!(await anythingDue())) return new Response(null, { status: 204 });
  after(() => runTick(`t${randomId(6)}`).then(() => undefined, (err) => console.error("[flash] automation tick failed", err instanceof Error ? err.name : "error")));
  return new Response(null, { status: 202 });
}
