import { after } from "next/server";
import { cronRefusal } from "@/lib/server/automations.ts";
import { socialDue, socialTick } from "@/lib/server/social.ts";

/*
 * The Social hub's per-minute tick, called by Vercel Cron (vercel.json) with CRON_SECRET, like the
 * automations tick: 404 off production, 503 until CRON_SECRET is set, 401 for anyone else. 204 when
 * nothing is due (indexed reads only), else 202, and the tick runs after the answer: due posts are
 * sent and free inboxes read (see social.ts).
 */
export const maxDuration = 300;

export async function GET(request: Request) {
  const refused = cronRefusal(request);
  if (refused) return refused;
  if (!(await socialDue())) return new Response(null, { status: 204 });
  after(() => socialTick().then(() => undefined, (err) => console.error("[flash] social tick failed", err instanceof Error ? err.name : "error")));
  return new Response(null, { status: 202 });
}
