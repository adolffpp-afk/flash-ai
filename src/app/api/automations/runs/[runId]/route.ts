import { actOnRun, bodyOf, checkReceipt, gate, receipt } from "@/lib/server/automation-api.ts";

/*
 * A run's receipt (read-only; ?format=json downloads it), and on a run: { action: "stop" | "retry" |
 * "read" }, or { action: "check", receipt } to compare a downloaded receipt with Flash's record.
 */
export const maxDuration = 800;

export async function GET(request: Request, ctx: RouteContext<"/api/automations/runs/[runId]">) {
  const g = await gate(request, { limit: "read" });
  if (g instanceof Response) return g;
  const { runId } = await ctx.params;
  const r = await receipt(g, runId);
  if (!r) return Response.json({ error: g.t("Not found") }, { status: 404 });
  if (new URL(request.url).searchParams.get("format") === "json") {
    return new Response(JSON.stringify(r, null, 1), {
      headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="receipt-${runId.replace(/[^A-Za-z0-9_-]/g, "")}.json"` },
    });
  }
  return Response.json(r);
}

export async function POST(request: Request, ctx: RouteContext<"/api/automations/runs/[runId]">) {
  const g = await gate(request, { write: true, limit: "act" });
  if (g instanceof Response) return g;
  const { runId } = await ctx.params;
  const body = await bodyOf(request);
  return body.action === "check" ? checkReceipt(g, runId, body) : actOnRun(g, runId, body);
}
