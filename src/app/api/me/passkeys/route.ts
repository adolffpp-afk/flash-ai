import { fromOwnPage, getUser, unauthorized } from "@/lib/server/auth.ts";
import { isVerified } from "@/lib/server/account.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { MAX_PASSKEYS, addOptions, addPasskey, clearChallengeCookie, listPasskeys, removePasskey } from "@/lib/server/passkeys.ts";

/** The account's passkeys (Settings > Account). */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  return Response.json({ passkeys: await listPasskeys(user.id) }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Adds or removes a passkey: "options" gives the browser what it needs to make one on this device,
 * "add" checks and keeps what it made, "remove" takes one off the account.
 */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (!fromOwnPage(request)) return Response.json({ error: t("Please sign in on Flash's own page.") }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { action?: string; response?: unknown; id?: string };

  if (body.action === "options") {
    // An unconfirmed account's passkeys go when the inbox's owner claims it (see signin.ts).
    if (!isVerified(user)) return Response.json({ error: t("Confirm your email first, then add a passkey.") }, { status: 400 });
    if ((await listPasskeys(user.id)).length >= MAX_PASSKEYS) {
      return Response.json({ error: t("You have {count} passkeys, the most an account can have. Remove one first.", { count: MAX_PASSKEYS }) }, { status: 409 });
    }
    const { options, cookie } = await addOptions(user, request);
    return Response.json({ options }, { headers: { "Set-Cookie": cookie, "Cache-Control": "no-store" } });
  }
  if (body.action === "add" && body.response && typeof body.response === "object") {
    const r = await addPasskey(user.id, request, body.response as Parameters<typeof addPasskey>[2]);
    const headers = { "Set-Cookie": clearChallengeCookie() };
    if (r.ok) return Response.json({ ok: true, passkey: r.passkey }, { headers });
    const error =
      r.reason === "expired"
        ? t("That took too long. Please try again.")
        : r.reason === "full"
          ? t("You have {count} passkeys, the most an account can have. Remove one first.", { count: MAX_PASSKEYS })
          : t("Couldn't add the passkey. Please try again.");
    return Response.json({ error }, { status: 400, headers });
  }
  if (body.action === "remove") {
    const ok = await removePasskey(user.id, String(body.id ?? "").slice(0, 1400));
    return ok ? Response.json({ ok: true }) : Response.json({ error: t("That passkey is already gone.") }, { status: 404 });
  }
  return Response.json({ error: t("Something went wrong.") }, { status: 400 });
}
