import { run, one, now } from "./db.ts";
import { randomId } from "./ids.ts";

/** Stores generated media for a user and returns the URL that serves it. */
export async function saveFile(userId: string, mime: string, name: string, data: Buffer): Promise<string> {
  const id = randomId(16);
  await run("INSERT INTO files (id, user_id, mime, name, data, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    id,
    userId,
    mime,
    name,
    data,
    now(),
  ]);
  return `/api/files/${id}`;
}

export async function readFile(id: string, userId: string) {
  return one<{ mime: string; name: string; data: ArrayBuffer }>(
    "SELECT mime, name, data FROM files WHERE id = ? AND user_id = ?",
    [id, userId],
  );
}

/**
 * A stored file as an HTTP response, with range support so browsers can seek in audio and video.
 * The sandbox policy stops a file (an SVG, say) from running scripts if opened directly.
 */
export function fileResponse(
  file: { mime: string; name: string; data: ArrayBuffer },
  request: Request,
  cache = "private, max-age=31536000, immutable",
): Response {
  const bytes = new Uint8Array(file.data);
  const total = bytes.byteLength;
  const headers: Record<string, string> = {
    "Content-Type": file.mime,
    "Cache-Control": cache,
    "Content-Disposition": `inline; filename="${file.name.replace(/"/g, "")}"`,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  };
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
