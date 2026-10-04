import { createHmac, timingSafeEqual } from "node:crypto";
import { planPrice, type CreditPack, type Interval, type Plan } from "../credits.ts";
import { one, run } from "./db.ts";

const STRIPE_API = process.env.STRIPE_API_BASE || "https://api.stripe.com/v1";

export const paymentsEnabled = () => Boolean(process.env.STRIPE_SECRET_KEY);
// Lets you test the buy flow before Stripe is set up. Never turn this on for real users.
export const demoPurchases = () => !paymentsEnabled() && process.env.FLASH_DEMO_PURCHASES === "true";

/** Calls Stripe's API; `account` acts on a connected seller's account (see shop.ts). */
export async function stripe<T>(method: string, path: string, form?: URLSearchParams, account?: string): Promise<T> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(account ? { "Stripe-Account": account } : {}),
    },
    body: form,
  });
  const json = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `Stripe returned ${res.status}`);
  return json;
}

const currency = () => process.env.FLASH_CURRENCY || "usd";

/** Creates a Stripe Checkout page for a credit pack and returns its URL. */
export async function createCheckout(pack: CreditPack, userId: string, email: string, origin: string): Promise<string> {
  const form = new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": currency(),
    "line_items[0][price_data][unit_amount]": String(pack.priceCents),
    "line_items[0][price_data][product_data][name]": `Flash AI ${pack.name}: ${pack.credits.toLocaleString("en-US")} credits`,
    customer_email: email,
    client_reference_id: userId,
    "metadata[user]": userId,
    "metadata[pack]": pack.id,
    success_url: `${origin}/?purchase=success`,
    cancel_url: `${origin}/?purchase=cancelled`,
  });
  const json = await stripe<{ url?: string }>("POST", "/checkout/sessions", form);
  if (!json.url) throw new Error("Stripe didn't return a checkout link");
  return json.url;
}

/** Creates a Stripe Checkout page that starts a monthly or yearly plan, and returns its URL. */
export async function createSubscriptionCheckout(
  plan: Plan,
  interval: Interval,
  user: { id: string; email: string },
  customer: string | null,
  origin: string,
): Promise<string> {
  const form = new URLSearchParams({
    mode: "subscription",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": currency(),
    "line_items[0][price_data][unit_amount]": String(planPrice(plan, interval)),
    "line_items[0][price_data][recurring][interval]": interval,
    "line_items[0][price_data][product_data][name]": `Flash AI ${plan.name}: ${plan.credits.toLocaleString("en-US")} credits a month`,
    client_reference_id: user.id,
    // Copied onto every invoice, so the webhook knows whose plan each payment is for.
    "subscription_data[metadata][user]": user.id,
    "subscription_data[metadata][plan]": plan.id,
    "subscription_data[metadata][interval]": interval,
    success_url: `${origin}/?purchase=subscribed`,
    cancel_url: `${origin}/?purchase=cancelled`,
  });
  if (customer) form.set("customer", customer);
  else form.set("customer_email", user.email);
  const json = await stripe<{ url?: string }>("POST", "/checkout/sessions", form);
  if (!json.url) throw new Error("Stripe didn't return a checkout link");
  return json.url;
}

/**
 * The invoice a payment paid, for refunds and disputes of plan payments. Newer Stripe API
 * versions no longer put the invoice on the charge, so this asks Stripe's invoice payments list.
 */
export async function invoiceForPaymentIntent(paymentIntent: string): Promise<string | null> {
  const json = await stripe<{ data?: { invoice?: string }[] }>(
    "GET",
    `/invoice_payments?${new URLSearchParams({ "payment[type]": "payment_intent", "payment[payment_intent]": paymentIntent, limit: "1" })}`,
  );
  return json.data?.[0]?.invoice ?? null;
}

/** Ends a Stripe subscription now, without a refund (used when a subscriber switches plans). */
export async function cancelStripeSubscription(id: string): Promise<void> {
  await stripe("DELETE", `/subscriptions/${encodeURIComponent(id)}`);
}

/*
 * The billing portal lets subscribers update their card, see invoices and cancel at the end of
 * the period. Plan changes inside the portal are off: they would prorate refunds for credits
 * already used. Switching plans goes through a new checkout instead.
 */
async function portalConfiguration(): Promise<string> {
  if (process.env.STRIPE_PORTAL_CONFIGURATION) return process.env.STRIPE_PORTAL_CONFIGURATION;
  const saved = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'stripe_portal_configuration'");
  if (saved) return saved.value;
  const config = await stripe<{ id: string }>(
    "POST",
    "/billing_portal/configurations",
    new URLSearchParams({
      "features[invoice_history][enabled]": "true",
      "features[payment_method_update][enabled]": "true",
      "features[subscription_cancel][enabled]": "true",
      "features[subscription_cancel][mode]": "at_period_end",
      "features[subscription_cancel][proration_behavior]": "none",
      "features[subscription_update][enabled]": "false",
    }),
  );
  await run("INSERT OR REPLACE INTO settings (key, value) VALUES ('stripe_portal_configuration', ?)", [config.id]);
  return config.id;
}

/** Opens Stripe's billing portal for a customer and returns its URL. */
export async function createPortalSession(customer: string, origin: string): Promise<string> {
  const json = await stripe<{ url: string }>(
    "POST",
    "/billing_portal/sessions",
    new URLSearchParams({ customer, return_url: `${origin}/`, configuration: await portalConfiguration() }),
  );
  return json.url;
}

/** Checks a Stripe webhook signature (the Stripe-Signature header) against the raw body. */
export function verifyWebhook(payload: string, header: string | null, secret: string, toleranceSec = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = Number(parts.t);
  const signatures = header
    .split(",")
    .filter((kv) => kv.startsWith("v1="))
    .map((kv) => kv.slice(3));
  if (!t || !signatures.length || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest();
  return signatures.some((sig) => {
    const given = Buffer.from(sig, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
