import { translatorFor } from "@/lib/server/i18n.ts";
import { MAX_ACCOUNTS, TooManyAccounts, addToJar, appUrl, fromOwnPage, hashPassword, jarSessions, tooManyAccounts } from "@/lib/server/auth.ts";
import { backfillEmailKeys, emailKey, sendVerification } from "@/lib/server/account.ts";
import { one } from "@/lib/server/db.ts";
import { clientIp, overLimit } from "@/lib/server/limits.ts";
import { tooManyFromNetwork } from "@/lib/server/email.ts";
import { CLEAR_REF_COOKIE } from "@/lib/server/referrals.ts";
import { createUser } from "@/lib/server/users.ts";
import { recordSignIn } from "@/lib/server/sign-ins.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  // Signed out, so the words follow the browser's language (see server/i18n.ts).
  const t = await translatorFor(request);
  // Only Flash's own sign-up page may make an account and sign into it (see fromOwnPage).
  if (!fromOwnPage(request)) return Response.json({ error: t("Please create your account on Flash's own page.") }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string; name?: string };
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const name = (body.name ?? "").trim().slice(0, 80);
  // The length first: the pattern is slow on very long text.
  if (email.length > 254 || !EMAIL.test(email)) return Response.json({ error: t("Enter a valid email address.") }, { status: 400 });
  if (password.length < 8) return Response.json({ error: t("Use a password of at least 8 characters.") }, { status: 400 });
  // A few sign-ups per network per hour is plenty for real people and slows account farming.
  if (await overLimit(`signup:${clientIp(request)}`, 5, 3600_000)) {
    return Response.json({ error: t("Too many new accounts from here. Try again in an hour.") }, { status: 429 });
  }
  if (await tooManyFromNetwork(clientIp(request))) return Response.json({ error: t("Too many tries today. Please try again tomorrow.") }, { status: 429 });
  // A browser holds at most 5 accounts (see auth.ts): checked before the account is made.
  if ((await jarSessions(request)).entries.length >= MAX_ACCOUNTS) return tooManyAccounts(t);
  await backfillEmailKeys();
  const key = emailKey(email);
  if (await one("SELECT 1 FROM users WHERE email = ? OR email_key = ?", [email, key])) {
    return Response.json({ error: t("An account with this email already exists. Sign in instead.") }, { status: 409 });
  }
  // createUser() records who referred them from the referral cookie (never the same inbox).
  const id = await createUser({ email, name, passwordHash: await hashPassword(password), request });
  // The account works even if the email can't be sent; the banner asks the user to send it again.
  let emailFailed = false;
  const devLink = await sendVerification({ id, email }, appUrl(request)).catch((err) => {
    console.error("[flash] verification email failed", err);
    emailFailed = true;
    return undefined;
  });
  let added: Awaited<ReturnType<typeof addToJar>>;
  try {
    added = await addToJar(request, id);
  } catch (err) {
    // Another tab filled the browser's 5 in the meantime: the account is made, and signs in later.
    if (err instanceof TooManyAccounts) return tooManyAccounts(t);
    throw err;
  }
  await recordSignIn(id, "sign_up", request);
  const headers = new Headers();
  for (const c of [added.cookie, ...added.also]) headers.append("Set-Cookie", c);
  headers.append("Set-Cookie", CLEAR_REF_COOKIE);
  return Response.json({ ok: true, devLink, emailFailed, account: added.account }, { headers });
}
