import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { readFile } from "@/lib/server/files.ts";

export async function GET(request: Request, ctx: RouteContext<"/api/files/[id]">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const file = await readFile(id, user.id);
  if (!file) return new Response("Not found", { status: 404 });
  const bytes = new Uint8Array(file.data);
  const total = bytes.byteLength;
  const headers: Record<string, string> = {
    "Content-Type": file.mime,
    "Cache-Control": "private, max-age=31536000, immutable",
    "Content-Disposition": `inline; filename="${file.name.replace(/"/g, "")}"`,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
  };
  // Range support lets browsers seek in audio and video.
  const range = request.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
    if (start >= total || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": String(end - start + 1) },
    });
  }
  return new Response(bytes, { headers: { ...headers, "Content-Length": String(total) } });
}
