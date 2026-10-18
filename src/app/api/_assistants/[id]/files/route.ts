import { after } from "next/server";
import { overLimit } from "@/lib/server/limits.ts";
import { NO_STORE, answer, gate, readForm, refusal, versionOf } from "@/lib/server/assistant-routes.ts";
import { addAssistantFile } from "@/lib/server/assistants.ts";
import { catchUpIndex } from "@/lib/server/assistant-search.ts";
import { MAX_UPLOAD_BYTES } from "@/lib/assistants.ts";

/*
 * Adds a file to one of the user's assistants, as the text the browser read from it: a form with
 * name, kind (pdf, docx, xlsx, pptx or text), pages, text (up to MAX_UPLOAD_BYTES) and the version
 * the editor read. The answer has the file and the version the editor saves at next. A
 * request over UPLOAD_CAP (MAX_UPLOAD_BYTES and 64 KB for the other fields) is refused before it's
 * read, once the proxy doesn't run before this route (see readForm), as too big: its text can't be
 * counted yet. In a smaller one, the text is judged as it's kept, a file part's as a plain field's:
 * over MAX_FILE_CHARS, it's refused as too long. Only the owner, only from Flash's own page; nothing
 * answers while assistants are off.
 */
export const dynamic = "force-dynamic";
// A file of 1,000,000 characters is counted and stored in about a thousand chunks.
export const maxDuration = 60;

// Every other method is a 405 once assistants are on (a 404 while they're off), without a list of
// what this route takes.
export { notTaken as GET, notTaken as HEAD, notTaken as PUT, notTaken as PATCH, notTaken as DELETE, notTaken as OPTIONS } from "@/lib/server/assistant-routes.ts";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
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
  // A file part is read whatever its size (the form is already held, at most UPLOAD_CAP), since its
  // bytes aren't its text's: reading drops a byte order mark, and the file keeps no NULs.
  const text = typeof part === "string" ? part : part ? await part.text() : "";
  const pages = Number(form.get("pages"));
  return answer(t, async () => {
    const added = await addAssistantFile(user.id, id, { name: form.get("name"), kind: form.get("kind"), pages, text }, versionOf(form.get("version")));
    // Chunks stored while the database had no index go in it, a bounded step at a time.
    after(() => catchUpIndex().catch(() => {}));
    return Response.json(added, { headers: NO_STORE });
  });
}
