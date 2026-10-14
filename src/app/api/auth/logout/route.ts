import { clearSessionCookie, endSession, getUser } from "@/lib/server/auth.ts";
import { endAllSessions } from "@/lib/server/account.ts";

/** Signs out this device, or every device with { everywhere: true } (Settings > Account). */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { everywhere?: boolean };
  if (body.everywhere === true) {
    const user = await getUser(request);
    if (user) await endAllSessions(user.id);
  }
  await endSession(request);
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
}
