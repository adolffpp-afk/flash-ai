import { overLimit } from "@/lib/server/limits.ts";
import { NO_STORE, answer, gate, refusal } from "@/lib/server/assistant-routes.ts";
import { startAssistantChat } from "@/lib/server/assistants.ts";

/*
 * Starts a chat with one of the user's own assistants: a new chat that keeps the assistant's id,
 * which the chat reads the assistant by on every message (nothing about it is taken from what a
 * message sends). Nothing answers while assistants are off.
 */
export const dynamic = "force-dynamic";

// Every other method is a 404 too while assistants are off, so this route can't be told from a path
// Flash doesn't have, and a 405 once they're on.
export { notTaken as GET, notTaken as HEAD, notTaken as PUT, notTaken as PATCH, notTaken as DELETE, notTaken as OPTIONS } from "@/lib/server/assistant-routes.ts";

export async function POST(request: Request, ctx: RouteContext<"/api/assistants/[id]/chats">) {
  const asked = await gate(request, "json");
  if (asked instanceof Response) return asked;
  const { user, t } = asked;
  if (await overLimit(`assistant-start:${user.id}`, 30, 3600_000)) {
    return Response.json({ error: t("Too many requests. Try again in an hour."), code: "limit" }, { status: 429, headers: NO_STORE });
  }
  const { id } = await ctx.params;
  return answer(t, async () => {
    const project = await startAssistantChat(user.id, id);
    return project ? Response.json({ project }, { headers: NO_STORE }) : refusal({ code: "not_found" }, t);
  });
}
