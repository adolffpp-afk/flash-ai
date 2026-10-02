import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { one } from "@/lib/server/db.ts";
import { randomId } from "@/lib/server/ids.ts";
import { createSubscriptionCheckout, demoPurchases, paymentsEnabled } from "@/lib/server/stripe.ts";
import {
  activeSubscription,
  addMonths,
  endSubscription,
  isInterval,
  otherSubscriptions,
  planById,
  recordPayment,
} from "@/lib/server/subscriptions.ts";
import { planPrice } from "@/lib/credits.ts";

/** Starts a plan, or switches to another one. Switching starts a new month today. */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const body = (await request.json().catch(() => ({}))) as { plan?: string; interval?: string };
  const plan = planById(body.plan);
  const interval = body.interval ?? "month";
  if (!plan || !isInterval(interval)) return Response.json({ error: "Unknown plan." }, { status: 400 });

  const current = await activeSubscription(user.id);
  if (current && current.plan === plan.id && current.interval === interval) {
    return Response.json({ error: `You're already on ${plan.name}.` }, { status: 409 });
  }

  if (demoPurchases()) {
    const id = `demo_sub_${randomId()}`;
    const start = Date.now();
    await recordPayment({
      subscriptionId: id,
      userId: user.id,
      planId: plan.id,
      interval,
      customer: null,
      amountCents: planPrice(plan, interval),
      periodStart: start,
      periodEnd: addMonths(start, interval === "year" ? 12 : 1),
      ref: `demo:${randomId()}`,
      test: true,
    });
    for (const old of await otherSubscriptions(user.id, id)) await endSubscription(old.id);
    return Response.json({ demo: true });
  }
  if (!paymentsEnabled()) {
    return Response.json(
      { error: "Payments aren't switched on yet. Add a Stripe key to turn on plans." },
      { status: 503 },
    );
  }
  try {
    const customer = await one<{ customer: string }>(
      "SELECT customer FROM subscriptions WHERE user_id = ? AND customer IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      [user.id],
    );
    const url = await createSubscriptionCheckout(
      plan,
      interval,
      user,
      customer?.customer ?? null,
      new URL(request.url).origin,
    );
    return Response.json({ url });
  } catch (err) {
    console.error("[flash] subscription checkout failed", err);
    return Response.json({ error: "Couldn't open checkout. Please try again." }, { status: 502 });
  }
}
