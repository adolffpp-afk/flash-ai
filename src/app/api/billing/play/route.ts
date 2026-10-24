import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { addPurchase } from "@/lib/server/credits.ts";
import { consumePurchase, lookupPurchase, playBillingOpenTo } from "@/lib/server/play-billing.ts";
import { PLAY_PACKS } from "@/lib/credits.ts";
import { translatorFor } from "@/lib/server/i18n.ts";

/**
 * A credit pack bought inside the Android app through Google Play Billing. The app sends the product and
 * the purchase token; the credits are added only once Google confirms a paid purchase of that product,
 * and once per order (a token sent again, by the app's retry, adds nothing).
 */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (!playBillingOpenTo(user)) return Response.json({ error: t("Paid plans and top-ups are coming soon.") }, { status: 503 });
  const { sku, token } = (await request.json().catch(() => ({}))) as { sku?: unknown; token?: unknown };
  const play = PLAY_PACKS.find((p) => p.sku === sku);
  if (!play || typeof token !== "string" || !token || token.length > 2000) {
    return Response.json({ error: t("Unknown credit pack.") }, { status: 400 });
  }
  try {
    const purchase = await lookupPurchase(play.sku, token);
    if (!purchase) return Response.json({ error: t("Couldn't open checkout. Please try again.") }, { status: 400 });
    // Still pending (a slow payment method) or cancelled: no credits, and the app asks again later.
    if (purchase.purchaseState !== 0) return Response.json({ pending: purchase.purchaseState === 2 }, { status: 202 });
    const ref = `${purchase.test ? "play-test" : "play"}:${purchase.orderId}`;
    const added = await addPurchase(user.id, play.id, ref, null, play.priceCents);
    // Even when the credits were given before, the purchase may still wait to be consumed (a retry after a failure).
    if (!purchase.consumed) await consumePurchase(play.sku, token);
    return Response.json({ added });
  } catch (err) {
    console.error("[flash] play purchase check failed", err);
    return Response.json({ error: t("Couldn't open checkout. Please try again.") }, { status: 502 });
  }
}
