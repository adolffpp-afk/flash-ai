import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { fileResponse, readFile } from "@/lib/server/files.ts";

export async function GET(request: Request, ctx: RouteContext<"/api/files/[id]">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const file = await readFile(id, user.id);
  if (!file) return new Response("Not found", { status: 404 });
  return fileResponse(file, request);
}
