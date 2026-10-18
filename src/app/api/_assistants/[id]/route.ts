import { overLimit } from "@/lib/server/limits.ts";
import { NO_STORE, answer, gate, refusal } from "@/lib/server/assistant-routes.ts";
import { deleteAssistant, getAssistant, updateAssistant } from "@/lib/server/assistants.ts";
import type { ServerT } from "@/lib/server/i18n.ts";

/*
 * One of the user's assistants: GET reads it with its files, PUT changes the fields sent with the
 * version it was read at ({ version, name?, … }, refused with the version now if it changed since),
 * DELETE deletes it and everything kept for it. Only its owner reaches it; nothing answers while
 * assistants are off.
 */
export const dynamic = "force-dynamic";

// HEAD is GET without its body. Every other method is a 405 once assistants are on (a 404 while
// they're off), without a list of what this route takes.
export { GET as HEAD };
export { notTaken as POST, notTaken as PATCH, notTaken as OPTIONS } from "@/lib/server/assistant-routes.ts";

type Ctx = { params: Promise<{ id: string }> };

const saved = async (userId: string, t: ServerT) =>
  (await overLimit(`assistant-save:${userId}`, 300, 3600_000))
    ? Response.json({ error: t("Too many updates. Try again in an hour."), code: "limit" }, { status: 429, headers: NO_STORE })
    : null;

export async function GET(request: Request, ctx: Ctx) {
  const asked = await gate(request);
  if (asked instanceof Response) return asked;
  const { id } = await ctx.params;
  return answer(asked.t, async () => {
    const assistant = await getAssistant(asked.user.id, id);
    return assistant ? Response.json({ assistant }, { headers: NO_STORE }) : refusal({ code: "not_found" }, asked.t);
  });
}

export async function PUT(request: Request, ctx: Ctx) {
  const asked = await gate(request, "json");
  if (asked instanceof Response) return asked;
  const { user, t } = asked;
  const limited = await saved(user.id, t);
  if (limited) return limited;
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  return answer(t, async () => Response.json({ assistant: await updateAssistant(user.id, id, body, body?.version as number) }, { headers: NO_STORE }));
}

export async function DELETE(request: Request, ctx: Ctx) {
  const asked = await gate(request, "none");
  if (asked instanceof Response) return asked;
  const { user, t } = asked;
  const limited = await saved(user.id, t);
  if (limited) return limited;
  const { id } = await ctx.params;
  return answer(t, async () => ((await deleteAssistant(user.id, id)) ? Response.json({ ok: true }, { headers: NO_STORE }) : refusal({ code: "not_found" }, t)));
}
