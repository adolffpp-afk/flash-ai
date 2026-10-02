import { createSession, isSecure, tooManyAttempts, verifyPassword } from "@/lib/server/auth.ts";
import { one } from "@/lib/server/db.ts";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string };
  const email = (body.email ?? "").trim().toLowerCase();
  if (tooManyAttempts(`login:${email}`)) {
    return Response.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  }
  const user = await one<{ id: string; password_hash: string }>("SELECT id, password_hash FROM users WHERE email = ?", [
    email,
  ]);
  if (!user || !(await verifyPassword(body.password ?? "", user.password_hash))) {
    return Response.json({ error: "That email and password don't match." }, { status: 401 });
  }
  const cookie = await createSession(user.id, isSecure(request));
  return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie } });
}
