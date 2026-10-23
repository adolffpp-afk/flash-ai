import { bodyOf, gate, overRunLimits, runNow } from "@/lib/server/automation-api.ts";

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
  // The account's limit was counted by the gate; per automation of this account too.
  const limited = await overRunLimits(g, id, { account: false });
  if (limited) return limited;
  return runNow(g, id, await bodyOf(request));
}
