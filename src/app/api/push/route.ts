import { fromOwnPage, jarSessions, resolveSession, unauthorized, type Jar } from "@/lib/server/auth.ts";
import { isVerified } from "@/lib/server/account.ts";
import { sha256 } from "@/lib/server/ids.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { overLimit } from "@/lib/server/limits.ts";
import { checkSubscription, dropEnded, pushAccountsHere, pushPublicKey, removePush, savePush, sendPush } from "@/lib/server/push.ts";
import { PRODUCT_NAME } from "@/lib/product.ts";

export const dynamic = "force-dynamic";

const HOUR = 3600 * 1000;

/**
 * The accounts signed in to this browser that get alerts at the push address with this SHA-256,
 * each by its own sign-in here (alerts are tied to the sign-in, see push.ts).
 */
const accountsHere = (jar: Jar, endpointHash: string) =>
  pushAccountsHere(
    jar.entries.map((e) => ({ userId: e.user.id, sessionHash: sha256(e.token) })),
    endpointHash,
  );

/**
 * Alerts when Flash is closed (Settings > General > Notifications, and the service worker before an
 * alert shows its words): the public key browsers subscribe with (null while alerts aren't set up,
 * and then the setting stays hidden); on, whether they're on in this browser (?e=, the SHA-256 of
 * its push address) for the account the request names (X-Flash-Account: the tab's, or the alert's);
 * and here, whether any account signed in to this browser still gets them there, so the subscription
 * they share stays. An account that isn't signed in here gets on false. With no account signed in
 * here at all, 401. The account's rows from sign-ins that expired go here too, without waiting for
 * an alert.
 */
export async function GET(request: Request) {
  const jar = await jarSessions(request);
  if (!jar.entries.length) return unauthorized();
  const entry = await resolveSession(request);
  if (entry) await dropEnded(entry.user.id);
  const key = pushPublicKey();
  const e = new URL(request.url).searchParams.get("e") ?? "";
  const accounts = key && /^[0-9a-f]{64}$/.test(e) ? await accountsHere(jar, e) : [];
  return Response.json({ key, on: Boolean(entry && accounts.includes(entry.user.id)), here: accounts.length > 0 }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Turns alerts on in this browser with its subscription ({endpoint, keys: {p256dh, auth}}), or sends
 * this browser a test alert ({action: "test", endpoint}).
 */
export async function POST(request: Request) {
  const entry = await resolveSession(request);
  if (!entry) return unauthorized();
  const user = entry.user;
  const t = await translatorFor(request, user.language);
  if (!fromOwnPage(request)) return Response.json({ error: t("Something went wrong. Please try again.") }, { status: 403 });
  if (!pushPublicKey()) return Response.json({ error: t("Flash can't send alerts to this browser.") }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; endpoint?: unknown };
  if (await overLimit(`push:${user.id}`, 20, HOUR)) return Response.json({ error: t("Too many requests. Try again in an hour.") }, { status: 429 });
  if (body.action === "test") {
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    const { rows, sent, gone } = await sendPush(user.id, { title: PRODUCT_NAME, body: t("Alerts work on this device."), url: "/", tag: "flash-test" }, endpoint);
    // Off here: never turned on, or the push service just said this browser's address is gone (and
    // it was deleted). "off" tells the switch to show it.
    if (!rows || gone) return Response.json({ error: t("Turn on alerts on this device first."), code: "off" }, { status: 400 });
    if (!sent) return Response.json({ error: t("Couldn't send the test alert. Please try again.") }, { status: 502 });
    return Response.json({ ok: true });
  }
  // Alerts carry what an account does, so only its owner, who proved the inbox, may send them somewhere.
  if (!isVerified(user)) return Response.json({ error: t("Confirm your email to turn on alerts."), code: "unverified" }, { status: 403 });
  const sub = checkSubscription(body);
  if (!sub) return Response.json({ error: t("Flash can't send alerts to this browser.") }, { status: 400 });
  await savePush(user.id, sha256(entry.token), sub);
  return Response.json({ ok: true });
}

/**
 * Turns alerts off for this account in the browser with this push address ({endpoint}). here: as
 * for GET, whether another account signed in here still gets alerts there, so the page keeps the
 * subscription they share.
 */
export async function DELETE(request: Request) {
  const entry = await resolveSession(request);
  if (!entry) return unauthorized();
  const user = entry.user;
  const t = await translatorFor(request, user.language);
  if (!fromOwnPage(request)) return Response.json({ error: t("Something went wrong. Please try again.") }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { endpoint?: unknown };
  if (typeof body.endpoint !== "string" || body.endpoint.length > 2048) return Response.json({ ok: true, here: false });
  // Its own allowance, larger, so turning alerts off always works after trying them on and off.
  if (await overLimit(`push-off:${user.id}`, 60, HOUR)) return Response.json({ error: t("Too many requests. Try again in an hour.") }, { status: 429 });
  await removePush(user.id, body.endpoint);
  return Response.json({ ok: true, here: (await accountsHere(await jarSessions(request), sha256(body.endpoint))).length > 0 });
}
