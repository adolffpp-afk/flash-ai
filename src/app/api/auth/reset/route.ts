import { translatorFor } from "@/lib/server/i18n.ts";
import { SESSION_COOKIE, fromOwnPage, hashPassword, readCookie } from "@/lib/server/auth.ts";
import { sha256 } from "@/lib/server/ids.ts";
import { redeemToken, resetLinkEmail } from "@/lib/server/account.ts";
import { mayUse } from "@/lib/server/link-browser.ts";
import { resetPassword } from "@/lib/server/signin.ts";
import { signInCookie } from "@/lib/server/two-factor.ts";

/** Sets a new password from a reset link, signs out every other device and signs this one in. */
export async function POST(request: Request) {
  // Signed out, so the words follow the browser's language (see server/i18n.ts).
  const t = await translatorFor(request);
  // This signs in too, so only Flash's own reset page may use it (see fromOwnPage).
  if (!fromOwnPage(request)) return Response.json({ error: t("Open the link from your email again.") }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { token?: string; password?: string; email?: string };
  const password = body.password ?? "";
  if (password.length < 8) return Response.json({ error: t("Use a password of at least 8 characters.") }, { status: 400 });
  // Opened in a browser that didn't ask for it: the address it was sent to is typed first (see link-browser.ts).
  const sentTo = await resetLinkEmail(body.token ?? "");
  const use = sentTo ? mayUse(sentTo, request, body.email) : "ok";
  if (use === "ask") return Response.json({ error: t("To keep your account safe, type the email address this link was sent to."), code: "confirm_email" }, { status: 400 });
  if (use === "wrong") return Response.json({ error: t("That isn't the email address this link was sent to."), code: "confirm_email" }, { status: 400 });
  const userId = await redeemToken(body.token ?? "", "reset");
  if (!userId) {
    return Response.json({ error: t("This link has expired or was already used. Ask for a new one.") }, { status: 400 });
  }
  // Opening the link proved they own the inbox: what an unconfirmed account had set up goes. This
  // browser gets no wordless push (see clearScreens): it's signed in again below (after its two-step
  // code, if that's on), and Flash then turns its alerts back on there, as after a password change.
  await resetPassword(userId, await hashPassword(password), sha256(readCookie(request, SESSION_COOKIE) ?? ""));
  // A reset link only proves the inbox, so with two-step sign-in on the code is still asked for.
  const { cookie, twoFactor } = await signInCookie(userId, request, "/?reset=1");
  return Response.json({ ok: true, twoFactor }, { headers: { "Set-Cookie": cookie } });
}
