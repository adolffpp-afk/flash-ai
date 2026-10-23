import { gate, listRuns } from "@/lib/server/automation-api.ts";

/** An automation's runs, newest first, 20 a page (?cursor= from the page before). */
export async function GET(request: Request, ctx: RouteContext<"/api/automations/[id]/runs">) {
  const g = await gate(request, { limit: "read" });
  if (g instanceof Response) return g;
  const { id } = await ctx.params;
  return listRuns(g, id, new URL(request.url).searchParams.get("cursor"));
}
