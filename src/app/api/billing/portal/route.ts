import { appUrl, getUser, unauthorized } from "@/lib/server/auth.ts";
import { createPortalSession, demoPurchases } from "@/lib/server/stripe.ts";
import { activeSubscription, setCancelAtPeriodEnd } from "@/lib/server/subscriptions.ts";
import { translatorFor } from "@/lib/server/i18n.ts";

/** Opens Stripe's billing portal (card, invoices, cancel). For demo plans it toggles cancellation. */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const sub = await activeSubscription(user.id);
  if (!sub) return Response.json({ error: t("You don't have a plan yet.") }, { status: 404 });

  if (sub.test || demoPurchases()) {
    await setCancelAtPeriodEnd(sub.id, !sub.cancel_at_period_end);
    return Response.json({ demo: true, renews: Boolean(sub.cancel_at_period_end) });
  }
  if (!sub.customer) return Response.json({ error: t("This plan has no billing account.") }, { status: 404 });
  try {
    return Response.json({ url: await createPortalSession(sub.customer, appUrl(request)) });
  } catch (err) {
    console.error("[flash] billing portal failed", err);
    return Response.json({ error: t("Couldn't open billing. Please try again.") }, { status: 502 });
  }
}
