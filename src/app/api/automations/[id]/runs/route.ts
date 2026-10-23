import { gate, listRuns, receiptsFile } from "@/lib/server/automation-api.ts";

/**
 * An automation's runs, newest first, 20 a page (?cursor= from the page before); ?format=receipts
 * downloads its fingerprinted receipts as one file.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/automations/[id]/runs">) {
  const g = await gate(request, { limit: "read" });
  if (g instanceof Response) return g;
  const { id } = await ctx.params;
  const params = new URL(request.url).searchParams;
  if (params.get("format") === "receipts") return receiptsFile(g, id);
  return listRuns(g, id, params.get("cursor"));
}
