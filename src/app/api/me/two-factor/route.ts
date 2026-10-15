import QRCode from "qrcode";
import { fromOwnPage, getUser, unauthorized } from "@/lib/server/auth.ts";
import { isVerified } from "@/lib/server/account.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import {
  disableTwoFactor,
  enableTwoFactor,
  recoveryLeft,
  renewRecoveryCodes,
  startSetup,
  twoFactorOn,
  twoFactorReady,
} from "@/lib/server/two-factor.ts";

/** Whether two-step sign-in is on (Settings > Account), and how many recovery codes are left. */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const on = await twoFactorOn(user.id);
  return Response.json({ available: twoFactorReady(), on, recoveryLeft: on ? await recoveryLeft(user.id) : 0 });
}

/**
 * Turns two-step sign-in on or off: "start" gives the QR code for the app, "enable" turns it on with
 * the app's first code and returns the recovery codes, "disable" and "renew" (new recovery codes)
 * need a code too, so someone using a signed-in device that isn't theirs can't change it.
 */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (!fromOwnPage(request)) return Response.json({ error: t("Please sign in on Flash's own page.") }, { status: 403 });
  if (!twoFactorReady()) return Response.json({ error: t("Two-step sign-in isn't available right now.") }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as { action?: string; code?: string };
  const code = String(body.code ?? "").slice(0, 40);
  const failed = (reason: "wrong" | "busy") =>
    reason === "busy"
      ? Response.json({ error: t("Too many attempts. Try again in 15 minutes.") }, { status: 429 })
      : Response.json({ error: t("That code isn't right. Check your authenticator app and try again.") }, { status: 400 });

  if (body.action === "start") {
    // An unconfirmed account's setup would be cleared when the inbox's owner claims it (see signin.ts).
    if (!isVerified(user)) return Response.json({ error: t("Confirm your email first, then turn on two-step sign-in.") }, { status: 400 });
    const setup = await startSetup(user);
    if (!setup) return Response.json({ error: t("Two-step sign-in is already on.") }, { status: 409 });
    const qr = await QRCode.toString(setup.uri, { type: "svg", margin: 2, errorCorrectionLevel: "M" });
    return Response.json({ secret: setup.secret, uri: setup.uri, qr }, { headers: { "Cache-Control": "no-store" } });
  }
  if (body.action === "enable") {
    const r = await enableTwoFactor(user.id, code);
    return r.ok ? Response.json({ ok: true, codes: r.codes }, { headers: { "Cache-Control": "no-store" } }) : failed(r.reason);
  }
  if (body.action === "renew") {
    const r = await renewRecoveryCodes(user.id, code);
    return r.ok ? Response.json({ ok: true, codes: r.codes }, { headers: { "Cache-Control": "no-store" } }) : failed(r.reason);
  }
  if (body.action === "disable") {
    const r = await disableTwoFactor(user.id, code);
    return r.ok ? Response.json({ ok: true }) : failed(r.reason);
  }
  return Response.json({ error: t("Something went wrong.") }, { status: 400 });
}
