import { isAdmin, jarSessions, unauthorized } from "@/lib/server/auth.ts";
import { one } from "@/lib/server/db.ts";
import { fileResponse } from "@/lib/server/files.ts";

export const dynamic = "force-dynamic";

/** A picture offered for the showcase, for the owner of Flash to look at before approving it (?id=). */
export async function GET(request: Request) {
  // Loaded with <img>, which can't say which account its tab shows: any of this browser's accounts that is the owner's.
  const users = (await jarSessions(request)).entries.map((e) => e.user);
  if (!users.length) return unauthorized();
  if (!users.some(isAdmin)) return Response.json({ error: "Only the owner can see this." }, { status: 403 });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const file = await one<{ mime: string; name: string; data: ArrayBuffer }>(
    `SELECT f.mime, f.name, f.data FROM showcase c JOIN files f ON f.id = c.ref AND f.user_id = c.user_id
     WHERE c.kind = 'picture' AND c.ref = ? AND f.mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')`,
    [id],
  );
  if (!file) return new Response("Not found", { status: 404 });
  return fileResponse(file, request, "private, max-age=300");
}
