import { translatorFor } from "@/lib/server/i18n.ts";
import { TooManyAccounts, canAdd, fromOwnPage, tooManyAccounts } from "@/lib/server/auth.ts";
import { clientIp, overLimit } from "@/lib/server/limits.ts";
import { safeNext } from "@/lib/server/oauth.ts";
import { clearChallengeCookie, signInOptions, verifyPasskeySignIn } from "@/lib/server/passkeys.ts";
import { clearPendingCookie, signInCookie } from "@/lib/server/two-factor.ts";

const WINDOW = 15 * 60 * 1000;

/**
 * Signing in with a passkey (see passkeys.ts): "options" gives the browser a challenge for the
 * device to sign, and "verify" checks what it signed and signs in. A passkey is both steps of
 * two-step sign-in, so it never goes to the code page.
 */
export async function POST(request: Request) {
  // Signed out, so the words follow the browser's language (see server/i18n.ts).
  const t = await translatorFor(request);
  // Only Flash's own sign-in page may sign someone in (see fromOwnPage).
  if (!fromOwnPage(request)) return Response.json({ error: t("Please sign in on Flash's own page.") }, { status: 403 });
  if (await overLimit(`passkey-ip:${clientIp(request)}`, 40, WINDOW)) {
    return Response.json({ error: t("Too many attempts. Try again in 15 minutes.") }, { status: 429 });
  }
  const body = (await request.json().catch(() => ({}))) as { step?: string; response?: unknown; next?: string };
  if (body.step === "options") {
    const { options, cookie } = await signInOptions(request);
    return Response.json({ options }, { headers: { "Set-Cookie": cookie, "Cache-Control": "no-store" } });
  }
  if (body.step !== "verify" || !body.response || typeof body.response !== "object") {
    return Response.json({ error: t("Something went wrong.") }, { status: 400 });
  }
  const result = await verifyPasskeySignIn(request, body.response as Parameters<typeof verifyPasskeySignIn>[1]);
  if (!result.ok) {
    const error =
      result.reason === "expired"
        ? t("This sign-in has timed out. Please sign in again.")
        : t("That passkey didn't work here. Sign in another way, then add a passkey in Settings > Account.");
    return Response.json({ error }, { status: 400, headers: { "Set-Cookie": clearChallengeCookie() } });
  }
  // A browser holds at most 5 accounts (see auth.ts): checked before anything is stored.
  if (!(await canAdd(request, result.userId))) return tooManyAccounts(t);
  try {
    const { cookie, also, account } = await signInCookie(result.userId, request, safeNext(body.next), "passkey");
    const headers = new Headers();
    // A sign-in still waiting for its two-step code here is done with too (the code page offers passkeys).
    for (const c of [cookie, ...also, clearChallengeCookie(), clearPendingCookie()]) headers.append("Set-Cookie", c);
    return Response.json({ ok: true, ...(account && { account }) }, { headers });
  } catch (err) {
    if (err instanceof TooManyAccounts) return tooManyAccounts(t);
    throw err;
  }
}
