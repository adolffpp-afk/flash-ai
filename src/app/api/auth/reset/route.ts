import { createSession, fromOwnPage, hashPassword, isSecure } from "@/lib/server/auth.ts";
import { endAllSessions, markVerified, redeemToken } from "@/lib/server/account.ts";
import { run } from "@/lib/server/db.ts";

/** Sets a new password from a reset link, signs out every other device and signs this one in. */
export async function POST(request: Request) {
  // This signs in too, so only Flash's own reset page may use it (see fromOwnPage).
  if (!fromOwnPage(request)) return Response.json({ error: "Open the link from your email again." }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { token?: string; password?: string };
  const password = body.password ?? "";
  if (password.length < 8) return Response.json({ error: "Use a password of at least 8 characters." }, { status: 400 });
  const userId = await redeemToken(body.token ?? "", "reset");
  if (!userId) {
    return Response.json({ error: "This link has expired or was already used. Ask for a new one." }, { status: 400 });
  }
  await run("UPDATE users SET password_hash = ? WHERE id = ?", [await hashPassword(password), userId]);
  await endAllSessions(userId);
  // Opening the link proved they own the inbox.
  await markVerified(userId);
  const cookie = await createSession(userId, isSecure(request));
  return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie } });
}
