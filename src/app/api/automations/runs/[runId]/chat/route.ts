import { gate, openInChat } from "@/lib/server/automation-api.ts";

/* Open in chat: a new chat with the run's instruction and its answer, to ask follow-ups. */
export async function POST(request: Request, ctx: RouteContext<"/api/automations/runs/[runId]/chat">) {
  const g = await gate(request, { write: true, limit: "chat" });
  if (g instanceof Response) return g;
  const { runId } = await ctx.params;
  return openInChat(g, runId);
}
