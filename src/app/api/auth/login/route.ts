import { createSession, isSecure, verifyPassword } from "@/lib/server/auth.ts";
import { one } from "@/lib/server/db.ts";
import { clearLimit, clientIp, overLimit } from "@/lib/server/limits.ts";

const WINDOW = 15 * 60 * 1000;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string };
  const email = (body.email ?? "").trim().toLowerCase();
  // Slows password guessing on one account, and one network trying many accounts.
  if ((await overLimit(`login:${email}`, 10, WINDOW)) || (await overLimit(`login-ip:${clientIp(request)}`, 50, WINDOW))) {
    return Response.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  }
  const user = await one<{ id: string; password_hash: string }>("SELECT id, password_hash FROM users WHERE email = ?", [
    email,
  ]);
  if (!user || !(await verifyPassword(body.password ?? "", user.password_hash))) {
    return Response.json({ error: "That email and password don't match." }, { status: 401 });
  }
  await clearLimit(`login:${email}`);
  const cookie = await createSession(user.id, isSecure(request));
  return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie } });
}
