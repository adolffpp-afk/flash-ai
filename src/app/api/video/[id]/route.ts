import { fetchVideo, openaiConfigured } from "@/lib/engines/media.ts";

// Streams a finished Sora video to the browser without exposing the API key.
export async function GET(_req: Request, ctx: RouteContext<"/api/video/[id]">) {
  const { id } = await ctx.params;
  if (!openaiConfigured() || !/^[\w-]+$/.test(id)) return new Response("Not found", { status: 404 });
  const res = await fetchVideo(id);
  if (!res.ok || !res.body) {
    return new Response("This video is no longer available. Videos expire about an hour after they are made.", {
      status: res.status === 404 ? 404 : 502,
    });
  }
  return new Response(res.body, {
    headers: { "Content-Type": "video/mp4", "Cache-Control": "private, max-age=3600" },
  });
}
