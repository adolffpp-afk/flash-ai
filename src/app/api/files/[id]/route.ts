import { getUser, jarSessions, unauthorized } from "@/lib/server/auth.ts";
import { deleteFile, fileResponse, readFile } from "@/lib/server/files.ts";
import { translatorFor } from "@/lib/server/i18n.ts";

/**
 * A file of any account signed in to this browser: a picture in a saved chat loads with <img>,
 * which can't say which account its tab shows, and a file's id can't be guessed. Only reads:
 * deleting one needs the tab's own account.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/files/[id]">) {
  const ids = (await jarSessions(request)).entries.map((e) => e.user.id);
  if (!ids.length) return unauthorized();
  const { id } = await ctx.params;
  const file = await readFile(id, ids);
  if (!file) return new Response("Not found", { status: 404 });
  return fileResponse(file, request);
}

/** Deletes a file for good: it disappears from chats, shared chats and connector links too. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/files/[id]">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  if (!(await deleteFile(user.id, id))) {
    const t = await translatorFor(request, user.language);
    return Response.json({ error: t("Not found") }, { status: 404 });
  }
  return Response.json({ ok: true });
}
