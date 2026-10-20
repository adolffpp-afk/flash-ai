import { translatorFor } from "@/lib/server/i18n.ts";
import { TooManyAccounts, canAdd, fromOwnPage, tooManyAccounts, verifyPassword } from "@/lib/server/auth.ts";
import { one } from "@/lib/server/db.ts";
import { clearLimit, clientIp, overLimit } from "@/lib/server/limits.ts";
import { PROVIDERS, isProvider, safeNext } from "@/lib/server/oauth.ts";
import { linkedProviders } from "@/lib/server/signin.ts";
import { signInCookie } from "@/lib/server/two-factor.ts";

const WINDOW = 15 * 60 * 1000;

export async function POST(request: Request) {
  // Signed out, so the words follow the browser's language (see server/i18n.ts).
  const t = await translatorFor(request);
  // Only Flash's own sign-in page may sign someone in (see fromOwnPage).
  if (!fromOwnPage(request)) return Response.json({ error: t("Please sign in on Flash's own page.") }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string; next?: string };
  const email = (body.email ?? "").trim().toLowerCase();
  // Slows password guessing on one account from one network, on one account from many networks,
  // and one network trying many accounts. The first is cleared by a right password, so a stranger
  // guessing someone's password can't lock them out unless they guess a hundred times.
  const ip = clientIp(request);
  if (
    (await overLimit(`login:${email}:${ip}`, 10, WINDOW)) ||
    (await overLimit(`login:${email}`, 100, WINDOW)) ||
    (await overLimit(`login-ip:${ip}`, 50, WINDOW))
  ) {
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
  await clearLimit(`login:${email}:${ip}`);
  // A browser holds at most 5 accounts (see auth.ts): checked before anything is stored.
  if (!(await canAdd(request, user.id))) return tooManyAccounts(t);
  try {
    // With two-step sign-in on, this only gets them to the code page (see two-factor.ts), which
    // then goes on to next: the page the sign-in was for (a link's, say), only ever a path on Flash.
    const { cookie, also, twoFactor, account } = await signInCookie(user.id, request, safeNext(body.next), "password");
    const headers = new Headers();
    for (const c of [cookie, ...also]) headers.append("Set-Cookie", c);
    return Response.json({ ok: true, twoFactor, ...(account && { account }) }, { headers });
  } catch (err) {
    if (err instanceof TooManyAccounts) return tooManyAccounts(t);
    throw err;
  }
}
