import { createSession, hashPassword, isSecure, tooManyAttempts } from "@/lib/server/auth.ts";
import { ensureMonthlyCredits } from "@/lib/server/credits.ts";
import { one, run, now } from "@/lib/server/db.ts";
import { randomId } from "@/lib/server/ids.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string; name?: string };
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const name = (body.name ?? "").trim().slice(0, 80);
  if (!EMAIL.test(email)) return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  if (password.length < 8) return Response.json({ error: "Use a password of at least 8 characters." }, { status: 400 });
  if (tooManyAttempts(`signup:${request.headers.get("x-forwarded-for") ?? "local"}`)) {
    return Response.json({ error: "Too many attempts. Try again in a few minutes." }, { status: 429 });
  }
  if (await one("SELECT 1 FROM users WHERE email = ?", [email])) {
    return Response.json({ error: "An account with this email already exists. Sign in instead." }, { status: 409 });
  }
  const id = randomId();
  await run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)", [
    id,
    email,
    name || email.split("@")[0],
    await hashPassword(password),
    now(),
  ]);
  await ensureMonthlyCredits(id);
  const cookie = await createSession(id, isSecure(request));
  return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie } });
}
