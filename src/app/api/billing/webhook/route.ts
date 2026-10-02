import { addPurchase, clawBack, findPurchase } from "@/lib/server/credits.ts";
import { cancelStripeSubscription, invoiceForPaymentIntent, verifyWebhook } from "@/lib/server/stripe.ts";
import {
  endSubscription,
  isInterval,
  otherSubscriptions,
  planById,
  recordPayment,
  setCancelAtPeriodEnd,
} from "@/lib/server/subscriptions.ts";
import { planPrice } from "@/lib/credits.ts";

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
  // Older API versions name the payment on the invoice; newer ones list it under payments.
  payment_intent?: string | null;
  payments?: { data?: { payment?: { payment_intent?: string | null } }[] } | null;
};
type Charge = {
  id: string;
  amount: number;
  amount_refunded: number;
  refunded?: boolean;
  payment_intent?: string | null;
  // Only on API versions before 2025-03-31.
  invoice?: string | null;
};
type Dispute = { id: string; charge: string; payment_intent?: string | null };
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
      payment_intent?: string | null;
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
  // Credits are only given for the plan's full price (no zero or discounted invoices).
  const planInfo = planById(plan);
  if (!planInfo || invoice.amount_paid < planPrice(planInfo, interval)) {
    console.warn(`[flash] invoice ${invoice.id} paid ${invoice.amount_paid} for ${plan}/${interval}: no credits given`);
    return;
  }
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
    paymentIntent: invoice.payment_intent ?? invoice.payments?.data?.[0]?.payment?.payment_intent ?? null,
  });
  // A new plan replaces the old one. The old one ends now with no refund; its credits stay.
  if (invoice.billing_reason === "subscription_create") {
    for (const old of await otherSubscriptions(user, subscriptionId)) {
      if (!old.test) await cancelStripeSubscription(old.id).catch((err) => console.error("[flash] cancel failed", err));
      await endSubscription(old.id);
    }
  }
}

/** The purchase a charge paid for: a pack by its payment intent, a plan by its invoice. */
async function purchaseFor(paymentIntent: string | null | undefined, invoice?: string | null) {
  const found = await findPurchase({ paymentIntent, ref: invoice && `stripe-invoice:${invoice}` });
  if (found || !paymentIntent || invoice) return found;
  const looked = await invoiceForPaymentIntent(paymentIntent).catch((err) => {
    console.error("[flash] invoice lookup failed", err);
    return null;
  });
  return looked ? findPurchase({ ref: `stripe-invoice:${looked}` }) : null;
}

/**
 * A refunded or disputed payment takes back the credits it gave (the refunded share, or all
 * of them for a dispute), and a fully refunded or disputed plan payment ends the plan.
 */
async function reversePayment(
  charge: string,
  paymentIntent: string | null | undefined,
  invoice: string | null | undefined,
  share: number,
  ref: string,
  reason: string,
) {
  const purchase = await purchaseFor(paymentIntent, invoice);
  if (!purchase) {
    console.warn(`[flash] ${ref}: no purchase found for charge ${charge}`);
    return;
  }
  await clawBack(purchase, share, charge, ref, reason);
  if (share >= 1 && purchase.subscription) {
    await cancelStripeSubscription(purchase.subscription).catch((err) => console.error("[flash] cancel failed", err));
    await endSubscription(purchase.subscription);
  }
}

// Stripe calls this after payments. Point a Stripe webhook at /api/billing/webhook for the events
// checkout.session.completed, checkout.session.async_payment_succeeded, invoice.paid,
// customer.subscription.updated, customer.subscription.deleted, charge.refunded and
// charge.dispute.created, and put its signing secret in STRIPE_WEBHOOK_SECRET.
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
    case "checkout.session.completed":
    // Payment methods that take days (bank debits) complete unpaid and send this once paid.
    case "checkout.session.async_payment_succeeded": {
      // Credit packs. Plans are handled by invoice.paid.
      const { user, pack } = object.metadata ?? {};
      if (object.mode !== "subscription" && object.payment_status === "paid" && user && pack) {
        await addPurchase(user, pack, `stripe:${object.id}`, object.payment_intent ?? null);
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
    case "charge.refunded": {
      const charge = object as unknown as Charge;
      const share = charge.refunded ? 1 : charge.amount ? charge.amount_refunded / charge.amount : 0;
      // Each partial refund has its own amount_refunded, so a later one takes back the rest.
      await reversePayment(charge.id, charge.payment_intent, charge.invoice, share,
        `stripe-refund:${charge.id}:${charge.amount_refunded}`, "Payment refunded");
      break;
    }
    case "charge.dispute.created": {
      const dispute = object as unknown as Dispute;
      await reversePayment(dispute.charge, dispute.payment_intent, null, 1,
        `stripe-dispute:${dispute.id}:${dispute.charge}`, "Payment disputed");
      break;
    }
  }
  return Response.json({ received: true });
}
