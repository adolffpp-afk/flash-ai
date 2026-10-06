import { clearSessionCookie, endSession, getUser } from "@/lib/server/auth.ts";
import { run } from "@/lib/server/db.ts";

/** Signs out this device, or every device with { everywhere: true } (Settings > Account). */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { everywhere?: boolean };
  if (body.everywhere === true) {
    const user = await getUser(request);
    if (user) await run("DELETE FROM sessions WHERE user_id = ?", [user.id]);
  }
  await endSession(request);
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
}
