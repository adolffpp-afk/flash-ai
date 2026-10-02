import { appUrl, createSession, hashPassword, isSecure } from "@/lib/server/auth.ts";
import { backfillEmailKeys, emailKey, sendVerification } from "@/lib/server/account.ts";
import { ensureMonthlyCredits } from "@/lib/server/credits.ts";
import { one, run, now } from "@/lib/server/db.ts";
import { randomId } from "@/lib/server/ids.ts";
import { clientIp, overLimit } from "@/lib/server/limits.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string; name?: string };
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const name = (body.name ?? "").trim().slice(0, 80);
  if (!EMAIL.test(email)) return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  if (password.length < 8) return Response.json({ error: "Use a password of at least 8 characters." }, { status: 400 });
  // A few sign-ups per network per hour is plenty for real people and slows account farming.
  if (await overLimit(`signup:${clientIp(request)}`, 5, 3600_000)) {
    return Response.json({ error: "Too many new accounts from here. Try again in an hour." }, { status: 429 });
  }
  await backfillEmailKeys();
  const key = emailKey(email);
  if (await one("SELECT 1 FROM users WHERE email = ? OR email_key = ?", [email, key])) {
    return Response.json({ error: "An account with this email already exists. Sign in instead." }, { status: 409 });
  }
  const id = randomId();
  await run("INSERT INTO users (id, email, email_key, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    id,
    email,
    key,
    name || email.split("@")[0],
    await hashPassword(password),
    now(),
  ]);
  await ensureMonthlyCredits(id);
  // The account works even if the email can't be sent; the banner asks the user to send it again.
  let emailFailed = false;
  const devLink = await sendVerification({ id, email }, appUrl(request)).catch((err) => {
    console.error("[flash] verification email failed", err);
    emailFailed = true;
    return undefined;
  });
  const cookie = await createSession(id, isSecure(request));
  return Response.json({ ok: true, devLink, emailFailed }, { headers: { "Set-Cookie": cookie } });
}
