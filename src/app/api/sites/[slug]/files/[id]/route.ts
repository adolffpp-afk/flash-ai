import { fileResponse } from "@/lib/server/files.ts";
import { readUpload } from "@/lib/server/site-files.ts";

/** A file someone sent to a published app, for anyone with its link. */
export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/files/[id]">) {
  const { slug, id } = await ctx.params;
  const file = await readUpload(slug, id);
  if (!file) return new Response("Not found", { status: 404 });
  const response = fileResponse(file, request, "public, max-age=31536000, immutable");
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("X-Robots-Tag", "noindex");
  return response;
}
