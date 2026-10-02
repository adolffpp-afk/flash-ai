import { addPurchase } from "@/lib/server/credits.ts";
import { cancelStripeSubscription, verifyWebhook } from "@/lib/server/stripe.ts";
import {
  endSubscription,
  isInterval,
  otherSubscriptions,
  recordPayment,
  setCancelAtPeriodEnd,
} from "@/lib/server/subscriptions.ts";

type Meta = { user?: string; plan?: string; interval?: string; pack?: string };
type SubscriptionDetails = { subscription?: string; metadata?: Meta | null };
type Invoice = {
  id: string;
  customer?: string | null;
  amount_paid: number;
  billing_reason?: string;
  // Newer API versions put the subscription under parent; older ones on the invoice itself.
  parent?: { subscription_details?: SubscriptionDetails | null } | null;
  subscription?: string | null;
  subscription_details?: SubscriptionDetails | null;
  lines?: { data?: { period?: { start: number; end: number } }[] };
};
type StripeEvent = {
  type: string;
  data: {
    object: {
      id: string;
      mode?: string;
      payment_status?: string;
      status?: string;
      cancel_at_period_end?: boolean;
      metadata?: Meta | null;
    };
  };
};

/** A paid invoice adds a paid period to the plan and gives that month's credits. */
async function invoicePaid(invoice: Invoice) {
  const details = invoice.parent?.subscription_details ?? invoice.subscription_details ?? null;
  const subscriptionId = details?.subscription ?? invoice.subscription ?? null;
  const { user, plan, interval } = details?.metadata ?? {};
  const period = invoice.lines?.data?.[0]?.period;
  if (!subscriptionId || !user || !plan || !isInterval(interval) || !period) return;
  await recordPayment({
    subscriptionId,
    userId: user,
    planId: plan,
    interval,
    customer: invoice.customer ?? null,
    amountCents: invoice.amount_paid,
    periodStart: period.start * 1000,
    periodEnd: period.end * 1000,
    ref: `stripe-invoice:${invoice.id}`,
    test: false,
  });
  // A new plan replaces the old one. The old one ends now with no refund; its credits stay.
  if (invoice.billing_reason === "subscription_create") {
    for (const old of await otherSubscriptions(user, subscriptionId)) {
      if (!old.test) await cancelStripeSubscription(old.id).catch((err) => console.error("[flash] cancel failed", err));
      await endSubscription(old.id);
    }
  }
}

// Stripe calls this after payments. Point a Stripe webhook at /api/billing/webhook for the events
// checkout.session.completed, invoice.paid, customer.subscription.updated and
// customer.subscription.deleted, and put its signing secret in STRIPE_WEBHOOK_SECRET.
export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new Response("Webhook secret not set", { status: 503 });
  const payload = await request.text();
  if (!verifyWebhook(payload, request.headers.get("stripe-signature"), secret)) {
    return new Response("Bad signature", { status: 400 });
  }
  const event = JSON.parse(payload) as StripeEvent;
  const object = event.data.object;
  switch (event.type) {
    case "checkout.session.completed": {
      // Credit packs. Plans are handled by invoice.paid.
      const { user, pack } = object.metadata ?? {};
      if (object.mode !== "subscription" && object.payment_status === "paid" && user && pack) {
        await addPurchase(user, pack, `stripe:${object.id}`);
      }
      break;
    }
    case "invoice.paid":
      await invoicePaid(object as unknown as Invoice);
      break;
    case "customer.subscription.updated":
      await setCancelAtPeriodEnd(object.id, Boolean(object.cancel_at_period_end), object.status);
      break;
    case "customer.subscription.deleted":
      await endSubscription(object.id);
      break;
  }
  return Response.json({ received: true });
}
