import { after } from "next/server";
import { overLimit } from "@/lib/server/limits.ts";
import { NO_STORE, answer, gate, readForm, refusal } from "@/lib/server/assistant-routes.ts";
import { addAssistantFile } from "@/lib/server/assistants.ts";
import { catchUpIndex } from "@/lib/server/assistant-search.ts";
import { MAX_UPLOAD_BYTES } from "@/lib/assistants.ts";

/*
 * Adds a file to one of the user's assistants, as the text the browser read from it: a form with
 * name, kind (pdf, docx, xlsx, pptx or text), pages and text, the text up to MAX_UPLOAD_BYTES. A
 * bigger request is refused before it's read. Only the owner, only from Flash's own page; nothing
 * answers while assistants are off.
 */
export const dynamic = "force-dynamic";
// A file of 1,000,000 characters is counted and stored in about a thousand chunks.
export const maxDuration = 60;

export async function POST(request: Request, ctx: RouteContext<"/api/assistants/[id]/files">) {
  const asked = await gate(request, "form");
  if (asked instanceof Response) return asked;
  const { user, t } = asked;
  if (await overLimit(`assistant-file:${user.id}`, 60, 3600_000)) {
    return Response.json({ error: t("You've added a lot of files. Try again in an hour."), code: "limit" }, { status: 429, headers: NO_STORE });
  }
  const { id } = await ctx.params;
  const form = await readForm(request);
  if (form === "too_big") return refusal({ code: "upload_big", bytes: MAX_UPLOAD_BYTES }, t);
  if (form === "bad") return refusal({ code: "bad_file" }, t);
  const part = form.get("text");
  // A file part is measured before it's read.
  if (typeof part !== "string" && part && part.size > MAX_UPLOAD_BYTES) return refusal({ code: "upload_big", bytes: MAX_UPLOAD_BYTES }, t);
  const text = typeof part === "string" ? part : part ? await part.text() : "";
  const pages = Number(form.get("pages"));
  return answer(t, async () => {
    const added = await addAssistantFile(user.id, id, { name: form.get("name"), kind: form.get("kind"), pages, text });
    // Chunks stored while the database had no index go in it, a bounded step at a time.
    after(() => catchUpIndex().catch(() => {}));
    return Response.json(added, { headers: NO_STORE });
  });
}
