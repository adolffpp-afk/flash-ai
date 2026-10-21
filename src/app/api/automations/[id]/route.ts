import { automationView, bodyOf, deleteAutomation, editAutomation, gate, ownAutomation } from "@/lib/server/automation-api.ts";

/** One automation: read it, edit it (a new version; on, pause, zone, limits) or delete it. */
export async function GET(request: Request, ctx: RouteContext<"/api/automations/[id]">) {
  const g = await gate(request, { limit: "list" });
  if (g instanceof Response) return g;
  const { id } = await ctx.params;
  const a = await ownAutomation(g.user, id);
  if (!a) return Response.json({ error: g.t("Not found") }, { status: 404 });
  return Response.json({ automation: await automationView(a, g.t) });
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/automations/[id]">) {
  const g = await gate(request, { write: true, limit: "edit" });
  if (g instanceof Response) return g;
  const { id } = await ctx.params;
  return editAutomation(g, id, await bodyOf(request));
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/automations/[id]">) {
  const g = await gate(request, { write: true, limit: "edit" });
  if (g instanceof Response) return g;
  const { id } = await ctx.params;
  return deleteAutomation(g, id);
}
