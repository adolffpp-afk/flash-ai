import { fileResponse } from "@/lib/server/files.ts";
import { sharedFile } from "@/lib/server/shares.ts";

/** A picture, video or recording shown in a shared chat. */
export async function GET(request: Request, ctx: RouteContext<"/s/[id]/files/[file]">) {
  const { id, file } = await ctx.params;
  const found = await sharedFile(id, file);
  if (!found) return new Response("Not found", { status: 404 });
  return fileResponse(found, request, "public, max-age=3600");
}
