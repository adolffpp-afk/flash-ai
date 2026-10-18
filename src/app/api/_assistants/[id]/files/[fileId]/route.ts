import { NO_STORE, answer, gate, refusal } from "@/lib/server/assistant-routes.ts";
import { assistantFileText, deleteAssistantFile } from "@/lib/server/assistants.ts";

/*
 * One file of one of the user's assistants: GET gives its text as it was stored, as plain text
 * that a browser shows and never runs (for "View text" and export), DELETE deletes it. Only the
 * owner; nothing answers while assistants are off.
 */
export const dynamic = "force-dynamic";

// HEAD is GET without its body. Every other method is a 405 once assistants are on (a 404 while
// they're off), without a list of what this route takes.
export { GET as HEAD };
export { notTaken as POST, notTaken as PUT, notTaken as PATCH, notTaken as OPTIONS } from "@/lib/server/assistant-routes.ts";

type Ctx = { params: Promise<{ id: string; fileId: string }> };

export async function GET(request: Request, ctx: Ctx) {
  const asked = await gate(request);
  if (asked instanceof Response) return asked;
  const { id, fileId } = await ctx.params;
  return answer(asked.t, async () => {
    const file = await assistantFileText(asked.user.id, id, fileId);
    if (!file) return refusal({ code: "not_found" }, asked.t);
    return new Response(file.text, {
      headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "content-security-policy": "sandbox" },
    });
  });
}

export async function DELETE(request: Request, ctx: Ctx) {
  const asked = await gate(request, "none");
  if (asked instanceof Response) return asked;
  const { id, fileId } = await ctx.params;
  return answer(asked.t, async () => {
    const version = await deleteAssistantFile(asked.user.id, id, fileId);
    return version === null ? refusal({ code: "not_found" }, asked.t) : Response.json({ version }, { headers: NO_STORE });
  });
}
