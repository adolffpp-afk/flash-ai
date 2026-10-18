import { bodyOf, gate, LIMITS, runNow } from "@/lib/server/automation-api.ts";
import { overLimit } from "@/lib/server/limits.ts";

/*
 * Run now (and Run once now): { requestId, seenMax }. Through the account's and Flash's limits; when
 * they allow it now, this request moves the run on after answering (after() runs within maxDuration,
 * Vercel Pro's most), else it is queued for the tick.
 */
export const maxDuration = 800;

export async function POST(request: Request, ctx: RouteContext<"/api/automations/[id]/run">) {
  const g = await gate(request, { write: true, limit: "runUser" });
  if (g instanceof Response) return g;
  const { id } = await ctx.params;
  const [max, windowMs] = LIMITS.runAutomation;
  // Per automation of this account, so another account's tries (404s) never use it up.
  if (await overLimit(`auto:runAutomation:${g.user.id}:${id}`, max, windowMs)) return Response.json({ error: g.t("Too many requests. Try again in an hour.") }, { status: 429 });
  return runNow(g, id, await bodyOf(request));
}
