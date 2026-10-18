import { translatorFor } from "@/lib/server/i18n.ts";
import { TooManyAccounts, canAdd, fromOwnPage, tooManyAccounts } from "@/lib/server/auth.ts";
import { clientIp, overLimit } from "@/lib/server/limits.ts";
import { CLEAR_REF_COOKIE } from "@/lib/server/referrals.ts";
import { mayUse } from "@/lib/server/link-browser.ts";
import { accountIdForEmail, redeemSignInLink, signInLinkEmail, signInWithEmail } from "@/lib/server/signin.ts";
import { signInCookie } from "@/lib/server/two-factor.ts";

/**
 * Signs in with the code from a sign-in link. The link opens a page with a button that calls
 * this, so email scanners that open links don't use it up.
 */
export async function POST(request: Request) {
  // Signed out, so the words follow the browser's language (see server/i18n.ts).
  const t = await translatorFor(request);
  // Only this site's own page may use a link, so another site can't sign a visitor into its account.
  if (!fromOwnPage(request)) return Response.json({ error: t("Open the link from your email again.") }, { status: 403 });
  if (await overLimit(`link-use:${clientIp(request)}`, 30, 15 * 60_000)) {
    return Response.json({ error: t("Too many attempts. Try again in 15 minutes.") }, { status: 429 });
  }
  const body = (await request.json().catch(() => ({}))) as { token?: string; email?: string };
  // Opened in a browser that didn't ask for it: the address it was sent to is typed first (see link-browser.ts).
  const sentTo = await signInLinkEmail(body.token ?? "");
  const use = sentTo ? mayUse(sentTo, request, body.email) : "ok";
  if (use === "ask") return Response.json({ error: t("To keep your account safe, type the email address this link was sent to."), code: "confirm_email" }, { status: 400 });
  if (use === "wrong") return Response.json({ error: t("That isn't the email address this link was sent to."), code: "confirm_email" }, { status: 400 });
  // A browser holds at most 5 accounts (see auth.ts): checked before the link is used up or an account made.
  if (sentTo && !(await canAdd(request, await accountIdForEmail(sentTo)))) return tooManyAccounts(t);
  const link = await redeemSignInLink(body.token ?? "");
  if (!link) {
    return Response.json({ error: t("This link has expired or was already used. Ask for a new one.") }, { status: 400 });
  }
  const userId = await signInWithEmail(link.email, request);
  try {
    // With two-step sign-in on, this only gets them to the code page (see two-factor.ts).
    const { cookie, also, twoFactor, account } = await signInCookie(userId, request, link.next);
    const headers = new Headers();
    for (const c of [cookie, ...also]) headers.append("Set-Cookie", c);
    // Signed in, so a referral code (used if this made the account) is no longer needed.
    headers.append("Set-Cookie", CLEAR_REF_COOKIE);
    return Response.json({ ok: true, next: link.next, twoFactor, ...(account && { account }) }, { headers });
  } catch (err) {
    if (err instanceof TooManyAccounts) return tooManyAccounts(t);
    throw err;
  }
}
