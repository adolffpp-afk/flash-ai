import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { deleteFile, fileResponse, readFile } from "@/lib/server/files.ts";

export async function GET(request: Request, ctx: RouteContext<"/api/files/[id]">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const file = await readFile(id, user.id);
  if (!file) return new Response("Not found", { status: 404 });
  return fileResponse(file, request);
}

/** Deletes a file for good: it disappears from chats, shared chats and connector links too. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/files/[id]">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  if (!(await deleteFile(user.id, id))) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ ok: true });
}
