import { overLimit } from "@/lib/server/limits.ts";
import { NO_STORE, answer, gate } from "@/lib/server/assistant-routes.ts";
import { createAssistant, listAssistants } from "@/lib/server/assistants.ts";

/*
 * The signed-in user's assistants (see server/assistants.ts): GET lists them, POST makes one from
 * { name, description, instructions, starters, level, color }. Nothing answers while assistants
 * are off.
 */
export const dynamic = "force-dynamic";

// HEAD is GET without its body. Every other method is a 404 too while assistants are off, so this
// route can't be told from a path Flash doesn't have, and a 405 once they're on.
export { GET as HEAD };
export { notTaken as PUT, notTaken as PATCH, notTaken as DELETE, notTaken as OPTIONS } from "@/lib/server/assistant-routes.ts";

export async function GET(request: Request) {
  const asked = await gate(request);
  if (asked instanceof Response) return asked;
  return answer(asked.t, async () => Response.json({ assistants: await listAssistants(asked.user.id) }, { headers: NO_STORE }));
}

export async function POST(request: Request) {
  const asked = await gate(request, "json");
  if (asked instanceof Response) return asked;
  const { user, t } = asked;
  if (await overLimit(`assistant-new:${user.id}`, 30, 3600_000)) {
    return Response.json({ error: t("You've made a lot of assistants. Try again in an hour."), code: "limit" }, { status: 429, headers: NO_STORE });
  }
  const body: unknown = await request.json().catch(() => ({}));
  return answer(t, async () => Response.json({ assistant: await createAssistant(user.id, body) }, { headers: NO_STORE }));
}
