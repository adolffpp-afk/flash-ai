import { translatorFor } from "@/lib/server/i18n.ts";
import { appUrl, fromOwnPage } from "@/lib/server/auth.ts";
import { emailKey } from "@/lib/server/account.ts";
import { EMAILS, demoEmails, emailEnabled, sendEmail, tooManyFromNetwork } from "@/lib/server/email.ts";
import { clientIp, overLimit } from "@/lib/server/limits.ts";
import { safeNext } from "@/lib/server/oauth.ts";
import { createSignInLink, findAccount } from "@/lib/server/signin.ts";
import { askedCookie } from "@/lib/server/link-browser.ts";

const HOUR = 3600_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "Email me a sign-in link": a one-time link that works for 15 minutes. Never says whether the account exists. */
export async function POST(request: Request) {
  // Signed out, so the words follow the browser's language (see server/i18n.ts).
  const t = await translatorFor(request);
  if (!emailEnabled() && !demoEmails()) {
    return Response.json({ error: t("Email sign-in links aren't available right now. Use your password instead.") }, { status: 503 });
  }
  // Only Flash's own sign-in page may ask, so other sites can't use visitors' browsers to send mail.
  if (!fromOwnPage(request)) return Response.json({ error: t("Please sign in on Flash's own page.") }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { email?: string; next?: string };
  const email = String(body.email ?? "").trim().toLowerCase();
  // The length first: the pattern is slow on very long text.
  if (email.length > 254 || !EMAIL.test(email)) return Response.json({ error: t("Enter a valid email address.") }, { status: 400 });
  const ip = clientIp(request);
  if ((await overLimit(`link-ip:${ip}`, 10, HOUR)) || (await overLimit(`link:${emailKey(email)}`, 3, HOUR))) {
    return Response.json({ error: t("Too many requests. Try again in an hour.") }, { status: 429 });
  }
  if (await tooManyFromNetwork(ip)) return Response.json({ error: t("Too many tries today. Please try again tomorrow.") }, { status: 429 });
  // A link to an address with no confirmed account is a "new" email, which has a daily share of its own.
  const account = await findAccount(email);
  const kind = account && Number(account.verified_at) ? "account" : "new";
  const link = `${appUrl(request)}/signin?token=${await createSignInLink(email, safeNext(body.next))}`;
  try {
    if (!(await sendEmail(email, EMAILS.signin(link), kind))) {
      return Response.json({ error: t("Too many tries today. Please try again tomorrow.") }, { status: 429 });
    }
  } catch (err) {
    console.error("[flash] sign-in link email failed", err instanceof Error ? err.message : err);
    return Response.json({ error: t("Couldn't send the email. Please try again.") }, { status: 502 });
  }
  // This browser asked, so the link works here without typing the address (see link-browser.ts).
  return Response.json({ ok: true, devLink: demoEmails() ? link : undefined }, { headers: { "Set-Cookie": askedCookie(email, request) } });
}
