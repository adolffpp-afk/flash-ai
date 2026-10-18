import { SESSION_COOKIE, clearSessionCookie, endSession, getUser, readCookie } from "@/lib/server/auth.ts";
import { endAllSessions } from "@/lib/server/account.ts";
import { sha256 } from "@/lib/server/ids.ts";

/** Signs out this device, or every device with { everywhere: true } (Settings > Account). */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { everywhere?: boolean };
  if (body.everywhere === true) {
    const user = await getUser(request);
    // This browser's page takes its own alerts off its screen (logOutHere in push.ts).
    if (user) await endAllSessions(user.id, sha256(readCookie(request, SESSION_COOKIE) ?? ""));
  }
  await endSession(request);
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
}
