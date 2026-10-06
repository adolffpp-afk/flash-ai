import { createSession, getUser, hashPassword, isSecure, unauthorized, verifyPassword } from "@/lib/server/auth.ts";
import { endAllSessions } from "@/lib/server/account.ts";
import { one, run } from "@/lib/server/db.ts";
import { clearLimit, overLimit } from "@/lib/server/limits.ts";

const WINDOW = 15 * 60 * 1000;

/** Changes the signed-in user's password; signs out their other devices. */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const body = (await request.json().catch(() => ({}))) as { current?: string; next?: string };
  const next = body.next ?? "";
  if (next.length < 8) return Response.json({ error: "Use a new password of at least 8 characters." }, { status: 400 });
  if (await overLimit(`password:${user.id}`, 10, WINDOW)) {
    return Response.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  }
  const row = await one<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", [user.id]);
  if (!row?.password_hash) {
    return Response.json({ error: "Your account has no password yet. Use “Email me a link” to set one." }, { status: 400 });
  }
  if (!(await verifyPassword(body.current ?? "", row.password_hash))) {
    return Response.json({ error: "Your current password isn't right." }, { status: 400 });
  }
  await clearLimit(`password:${user.id}`);
  await run("UPDATE users SET password_hash = ? WHERE id = ?", [await hashPassword(next), user.id]);
  // Anyone signed in elsewhere with the old password is signed out; this device stays signed in.
  await endAllSessions(user.id);
  const cookie = await createSession(user.id, isSecure(request));
  return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie } });
}
