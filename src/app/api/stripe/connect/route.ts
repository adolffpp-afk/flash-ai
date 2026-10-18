import { appUrl } from "@/lib/server/auth.ts";
import { connectEvent, type ConnectEvent } from "@/lib/server/shop.ts";
import { verifyWebhook } from "@/lib/server/stripe.ts";

/*
 * Stripe calls this for events on sellers' connected accounts (see connectEvent in shop.ts), so an
 * order is saved when it is paid even if the buyer closes the tab, and refunds and disputes are kept
 * with it. In the Stripe Dashboard, add a webhook endpoint that listens to events on connected
 * accounts, at /api/stripe/connect, for checkout.session.completed,
 * checkout.session.async_payment_succeeded, charge.refunded and charge.dispute.created, and put its
 * signing secret in STRIPE_CONNECT_WEBHOOK_SECRET. Until it is set, every call is refused.
 */
export async function POST(request: Request) {
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET?.trim();
  if (!secret) return new Response("Webhook secret not set", { status: 503 });
  // The signature is over the body exactly as sent, and only for 5 minutes after Stripe signed it.
  const payload = await request.text();
  if (!verifyWebhook(payload, request.headers.get("stripe-signature"), secret)) {
    return new Response("Bad signature", { status: 400 });
  }
  let event: ConnectEvent;
  try {
    event = JSON.parse(payload) as ConnectEvent;
  } catch {
    return new Response("Not an event", { status: 400 });
  }
  if (!event || typeof event !== "object") return new Response("Not an event", { status: 400 });
  try {
    // 200 for the events this ignores too, so Stripe stops sending them.
    return Response.json({ received: true, outcome: await connectEvent(event, appUrl(request)) });
  } catch (err) {
    console.error("[flash] connect event failed", err);
    // Stripe sends it again later.
    return new Response("Couldn't handle the event", { status: 500 });
  }
}
