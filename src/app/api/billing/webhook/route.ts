import { addPurchase } from "@/lib/server/credits.ts";
import { verifyWebhook } from "@/lib/server/stripe.ts";

type CheckoutEvent = {
  type: string;
  data: { object: { id: string; payment_status?: string; metadata?: { user?: string; pack?: string } } };
};

// Stripe calls this after a payment. Point a Stripe webhook at /api/billing/webhook
// for the checkout.session.completed event and put its signing secret in STRIPE_WEBHOOK_SECRET.
export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new Response("Webhook secret not set", { status: 503 });
  const payload = await request.text();
  if (!verifyWebhook(payload, request.headers.get("stripe-signature"), secret)) {
    return new Response("Bad signature", { status: 400 });
  }
  const event = JSON.parse(payload) as CheckoutEvent;
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { user, pack } = session.metadata ?? {};
    if (session.payment_status === "paid" && user && pack) await addPurchase(user, pack, `stripe:${session.id}`);
  }
  return Response.json({ received: true });
}
