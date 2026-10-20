import { fileResponse } from "@/lib/server/files.ts";
import { showcasePicture } from "@/lib/server/showcase.ts";

/** A picture approved for the showcase, for anyone. Gone as soon as it's hidden, taken back or deleted (browsers keep it up to an hour). */
export async function GET(request: Request, ctx: RouteContext<"/api/showcase/pictures/[id]">) {
  const { id } = await ctx.params;
  const file = await showcasePicture(id);
  if (!file) return new Response("Not found", { status: 404 });
  const response = fileResponse(file, request, "public, max-age=3600");
  response.headers.set("X-Robots-Tag", "noindex");
  return response;
}
