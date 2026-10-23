import { fromOwnPage, getUser, unauthorized, verifyPassword } from "@/lib/server/auth.ts";
import { one } from "@/lib/server/db.ts";
import { overLimit } from "@/lib/server/limits.ts";
import { confirmWithCode, twoFactorOn } from "@/lib/server/two-factor.ts";
import { isVerified } from "@/lib/server/account.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import {
  MAX_PASSKEYS,
  RECENT_MINUTES,
  addOptions,
  addPasskey,
  clearChallengeCookie,
  emailPasskeyChange,
  listPasskeys,
  removePasskey,
  signedInRecently,
} from "@/lib/server/passkeys.ts";

const WINDOW = 15 * 60_000;

/** The account's passkeys (Settings > Account). */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  return Response.json({ passkeys: await listPasskeys(user.id) }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Adds or removes a passkey: "options" gives the browser what it needs to make one on this device,
 * "add" checks and keeps what it made, "remove" takes one off the account. A passkey is a way in on
 * its own, so "options" needs a sign-in from the last few minutes, or the password or an app code
 * (code "reauth" says which the account has), and each change is emailed to the account.
 */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (!fromOwnPage(request)) return Response.json({ error: t("Please sign in on Flash's own page.") }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { action?: string; response?: unknown; id?: string; password?: string; code?: string };

  if (body.action === "options") {
    // Each try counts, wrong passwords included, so a borrowed session can't guess its way through.
    if (await overLimit(`passkey-add:${user.id}`, 10, WINDOW)) {
      return Response.json({ error: t("Too many attempts. Try again in 15 minutes.") }, { status: 429 });
    }
    // An unconfirmed account's passkeys go when the inbox's owner claims it (see signin.ts).
    if (!isVerified(user)) return Response.json({ error: t("Confirm your email first, then add a passkey.") }, { status: 400 });
    if ((await listPasskeys(user.id)).length >= MAX_PASSKEYS) {
      return Response.json({ error: t("You have {count} passkeys, the most an account can have. Remove one first.", { count: MAX_PASSKEYS }) }, { status: 409 });
    }
    if (!(await signedInRecently(request, user.id))) {
      const row = await one<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", [user.id]);
      const hasPassword = Boolean(row?.password_hash);
      const hasCode = await twoFactorOn(user.id);
      const password = String(body.password ?? "").slice(0, 200);
      const code = String(body.code ?? "").slice(0, 40);
      if (password && hasPassword) {
        if (!(await verifyPassword(password, row!.password_hash))) return Response.json({ error: t("Your current password isn't right.") }, { status: 400 });
      } else if (code && hasCode) {
        const r = await confirmWithCode(user.id, code);
        if (!r.ok) {
          return r.reason === "busy"
            ? Response.json({ error: t("Too many attempts. Try again in 15 minutes.") }, { status: 429 })
            : Response.json({ error: t("That code isn't right. Check your authenticator app and try again.") }, { status: 400 });
        }
      } else {
        const error =
          hasPassword || hasCode
            ? t("For your safety, confirm it's you first.")
            : t("For your safety, log out, sign in again, then add the passkey within {minutes} minutes.", { minutes: RECENT_MINUTES });
        return Response.json({ error, code: "reauth", password: hasPassword, twoFactor: hasCode }, { status: 403 });
      }
    }
    const { options, cookie } = await addOptions(user, request);
    return Response.json({ options }, { headers: { "Set-Cookie": cookie, "Cache-Control": "no-store" } });
  }
  if (body.action === "add" && body.response && typeof body.response === "object") {
    const r = await addPasskey(user.id, request, body.response as Parameters<typeof addPasskey>[2]);
    const headers = { "Set-Cookie": clearChallengeCookie() };
    if (r.ok) {
      await emailPasskeyChange(user.id, request, "added", r.passkey.name);
      return Response.json({ ok: true, passkey: r.passkey }, { headers });
    }
    const error =
      r.reason === "expired"
        ? t("That took too long. Please try again.")
        : r.reason === "full"
          ? t("You have {count} passkeys, the most an account can have. Remove one first.", { count: MAX_PASSKEYS })
          : t("Couldn't add the passkey. Please try again.");
    return Response.json({ error }, { status: 400, headers });
  }
  if (body.action === "remove") {
    const removed = await removePasskey(user.id, String(body.id ?? "").slice(0, 1400));
    if (removed === null) return Response.json({ error: t("That passkey is already gone.") }, { status: 404 });
    await emailPasskeyChange(user.id, request, "removed", removed);
    return Response.json({ ok: true });
  }
  return Response.json({ error: t("Something went wrong.") }, { status: 400 });
}
