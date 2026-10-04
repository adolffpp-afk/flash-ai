import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { listFiles, type FileKind } from "@/lib/server/files.ts";

const KINDS: FileKind[] = ["image", "video", "audio"];

/** My creations: the pictures, videos and sounds Flash made for the user, newest first. */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const params = new URL(request.url).searchParams;
  const kind = KINDS.find((k) => k === params.get("kind"));
  const before = Number(params.get("before")) || undefined;
  return Response.json({ files: await listFiles(user.id, kind, before) });
}
