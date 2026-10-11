import { translatorFor } from "@/lib/server/i18n.ts";
import { createSession, fromOwnPage, isSecure, verifyPassword } from "@/lib/server/auth.ts";
import { one } from "@/lib/server/db.ts";
import { clearLimit, clientIp, overLimit } from "@/lib/server/limits.ts";
import { PROVIDERS, isProvider } from "@/lib/server/oauth.ts";
import { linkedProviders } from "@/lib/server/signin.ts";

const WINDOW = 15 * 60 * 1000;

export async function POST(request: Request) {
  // Signed out, so the words follow the browser's language (see server/i18n.ts).
  const t = await translatorFor(request);
  // Only Flash's own sign-in page may sign someone in (see fromOwnPage).
  if (!fromOwnPage(request)) return Response.json({ error: t("Please sign in on Flash's own page.") }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string };
  const email = (body.email ?? "").trim().toLowerCase();
  // Slows password guessing on one account, and one network trying many accounts.
  if ((await overLimit(`login:${email}`, 10, WINDOW)) || (await overLimit(`login-ip:${clientIp(request)}`, 50, WINDOW))) {
    return Response.json({ error: t("Too many attempts. Try again in 15 minutes.") }, { status: 429 });
  }
  const user = await one<{ id: string; password_hash: string }>("SELECT id, password_hash FROM users WHERE email = ?", [
    email,
  ]);
  // Accounts made with Google, GitHub, Microsoft or an email link have no password until they set one.
  if (user && !user.password_hash) {
    const names = (await linkedProviders(user.id)).map((p) => (isProvider(p) ? PROVIDERS[p].name : p));
    const error = names.length
      ? t('This account signs in with {names} or an email sign-in link. Use that, or choose "Forgot password?" to set a password.', {
          names: names.join(", "),
        })
      : t('This account signs in with an email sign-in link. Use that, or choose "Forgot password?" to set a password.');
    return Response.json({ error }, { status: 401 });
  }
  if (!user || !(await verifyPassword(body.password ?? "", user.password_hash))) {
    return Response.json({ error: t("That email and password don't match.") }, { status: 401 });
  }
  await clearLimit(`login:${email}`);
  const cookie = await createSession(user.id, isSecure(request));
  return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie } });
}
