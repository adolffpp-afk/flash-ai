import { appUrl } from "@/lib/server/auth.ts";
import { emailKey } from "@/lib/server/account.ts";
import { EMAILS, demoEmails, emailEnabled, sendEmail } from "@/lib/server/email.ts";
import { clientIp, overLimit } from "@/lib/server/limits.ts";
import { safeNext } from "@/lib/server/oauth.ts";
import { createSignInLink } from "@/lib/server/signin.ts";

const HOUR = 3600_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "Email me a sign-in link": a one-time link that works for 15 minutes. Never says whether the account exists. */
export async function POST(request: Request) {
  if (!emailEnabled() && !demoEmails()) {
    return Response.json({ error: "Email sign-in links aren't available right now. Use your password instead." }, { status: 503 });
  }
  const body = (await request.json().catch(() => ({}))) as { email?: string; next?: string };
  const email = (body.email ?? "").trim().toLowerCase();
  if (!EMAIL.test(email)) return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  if ((await overLimit(`link-ip:${clientIp(request)}`, 10, HOUR)) || (await overLimit(`link:${emailKey(email)}`, 3, HOUR))) {
    return Response.json({ error: "Too many requests. Try again in an hour." }, { status: 429 });
  }
  const link = `${appUrl(request)}/signin?token=${await createSignInLink(email, safeNext(body.next))}`;
  try {
    await sendEmail(email, EMAILS.signin(link), "account");
  } catch (err) {
    console.error("[flash] sign-in link email failed", err instanceof Error ? err.message : err);
    return Response.json({ error: "Couldn't send the email. Please try again." }, { status: 502 });
  }
  return Response.json({ ok: true, devLink: demoEmails() ? link : undefined });
}
