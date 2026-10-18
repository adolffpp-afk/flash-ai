import { SESSION_COOKIE, fromOwnPage, getUser, readCookie, unauthorized } from "@/lib/server/auth.ts";
import { isVerified } from "@/lib/server/account.ts";
import { sha256 } from "@/lib/server/ids.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { overLimit } from "@/lib/server/limits.ts";
import { checkSubscription, pushOnHere, pushPublicKey, removePush, savePush, sendPush } from "@/lib/server/push.ts";
import { PRODUCT_NAME } from "@/lib/product.ts";

export const dynamic = "force-dynamic";

const HOUR = 3600 * 1000;

// This account's sign-in in this browser, which its alerts here are tied to (see push.ts).
const sessionHash = (request: Request) => sha256(readCookie(request, SESSION_COOKIE) ?? "");

/**
 * Alerts when Flash is closed (Settings > General > Notifications): the public key browsers
 * subscribe with (null while alerts aren't set up, and then the setting stays hidden), and whether
 * they're on for this account in this browser (?e=, the SHA-256 of the browser's push address).
 */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const key = pushPublicKey();
  const e = new URL(request.url).searchParams.get("e") ?? "";
  const on = Boolean(key && /^[0-9a-f]{64}$/.test(e) && (await pushOnHere(user.id, sessionHash(request), e)));
  return Response.json({ key, on });
}

/**
 * Turns alerts on in this browser with its subscription ({endpoint, keys: {p256dh, auth}}), or sends
 * this browser a test alert ({action: "test", endpoint}).
 */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (!fromOwnPage(request)) return Response.json({ error: t("Something went wrong. Please try again.") }, { status: 403 });
  if (!pushPublicKey()) return Response.json({ error: t("Flash can't send alerts to this browser.") }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; endpoint?: unknown };
  if (await overLimit(`push:${user.id}`, 20, HOUR)) return Response.json({ error: t("Too many requests. Try again in an hour.") }, { status: 429 });
  if (body.action === "test") {
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    const { rows, sent } = await sendPush(user.id, { title: PRODUCT_NAME, body: t("Alerts work on this device."), url: "/", tag: "flash-test" }, endpoint);
    if (!rows) return Response.json({ error: t("Turn on alerts on this device first.") }, { status: 400 });
    if (!sent) return Response.json({ error: t("Couldn't send the test alert. Please try again.") }, { status: 502 });
    return Response.json({ ok: true });
  }
  // Alerts carry what an account does, so only its owner, who proved the inbox, may send them somewhere.
  if (!isVerified(user)) return Response.json({ error: t("Confirm your email to turn on alerts."), code: "unverified" }, { status: 403 });
  const sub = checkSubscription(body);
  if (!sub) return Response.json({ error: t("Flash can't send alerts to this browser.") }, { status: 400 });
  await savePush(user.id, sessionHash(request), sub);
  return Response.json({ ok: true });
}

/** Turns alerts off for this account in the browser with this push address ({endpoint}). */
export async function DELETE(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (!fromOwnPage(request)) return Response.json({ error: t("Something went wrong. Please try again.") }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { endpoint?: unknown };
  if (typeof body.endpoint !== "string" || body.endpoint.length > 2048) return Response.json({ ok: true });
  // Its own allowance, larger, so turning alerts off always works after trying them on and off.
  if (await overLimit(`push-off:${user.id}`, 60, HOUR)) return Response.json({ error: t("Too many requests. Try again in an hour.") }, { status: 429 });
  await removePush(user.id, body.endpoint);
  return Response.json({ ok: true });
}
