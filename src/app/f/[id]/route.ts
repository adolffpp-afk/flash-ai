import { publicFile } from "@/lib/server/connector.ts";
import { fileResponse } from "@/lib/server/files.ts";

/** A file a connected app made, for anyone with the link (the app shows or downloads it from here). */
export async function GET(request: Request, ctx: RouteContext<"/f/[id]">) {
  const { id } = await ctx.params;
  const file = await publicFile(id);
  if (!file) return new Response("Not found", { status: 404 });
  const response = fileResponse(file, request, "public, max-age=31536000, immutable");
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("X-Robots-Tag", "noindex");
  return response;
}
