import { createHmac, timingSafeEqual } from "node:crypto";
import { EXTRA_SEAT, planCredits, planPrice, type CreditPack, type Interval, type Plan } from "../credits.ts";
import { one, run } from "./db.ts";

const STRIPE_API = process.env.STRIPE_API_BASE || "https://api.stripe.com/v1";

export const paymentsEnabled = () => Boolean(process.env.STRIPE_SECRET_KEY);
/**
 * Whether STRIPE_SECRET_KEY is a live key (sk_live_ or rk_live_). Anything else is test mode, and a
 * payment is only an order in its key's own mode (see recordOrder in shop.ts).
 */
export const liveKey = () => /^[rs]k_live_/.test(process.env.STRIPE_SECRET_KEY ?? "");
// Lets you test the buy flow before Stripe is set up. Never turn this on for real users.
export const demoPurchases = () => !paymentsEnabled() && process.env.FLASH_DEMO_PURCHASES === "true";

/**
 * Calls Stripe's API; `account` acts on a connected seller's account (see shop.ts). With an
 * idempotency key, a retry of the same call gets Stripe's first answer instead of doing it twice.
 */
export async function stripe<T>(method: string, path: string, form?: URLSearchParams, account?: string, idempotencyKey?: string): Promise<T> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(account ? { "Stripe-Account": account } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: form,
  });
  const json = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `Stripe returned ${res.status}`);
  return json;
}

export const currency = () => (process.env.FLASH_CURRENCY || "usd").toLowerCase();

/**
 * What a Checkout Session paid, in Flash's currency, or null when it wasn't paid in it. With
 * Stripe's Adaptive Pricing on, a customer abroad pays in their own currency: the session's
 * currency and total are then theirs, and currency_conversion holds the total in Flash's currency,
 * which is what Flash gets (Stripe's conversion fee is added on the customer's side).
 */
export function paidInFlashCurrency(session: {
  amount_total?: number | null;
  currency?: string | null;
  currency_conversion?: { amount_total?: number | null; source_currency?: string | null } | null;
}): number | null {
  if ((session.currency ?? "").toLowerCase() === currency()) return Number(session.amount_total ?? 0);
  const converted = session.currency_conversion;
  if (converted && (converted.source_currency ?? "").toLowerCase() === currency()) return Number(converted.amount_total ?? 0);
  return null;
}

/*
 * Sales tax (GST/HST, VAT, US sales tax) through Stripe Tax, on when FLASH_STRIPE_TAX is "true".
 * Turn it on only once Stripe Tax is set up in the Stripe dashboard (business address and the
 * places Flash is registered), or checkout fails. Tax is added on top of Flash's prices, so what
 * Flash keeps, and every plan's margin, stays the same.
 */
export const taxOn = () => process.env.FLASH_STRIPE_TAX === "true";

/** Asks Stripe to work out and add tax on a checkout with these many line items. */
export function withTax(form: URLSearchParams, lineItems: number, existingCustomer: boolean): URLSearchParams {
  if (!taxOn()) return form;
  form.set("automatic_tax[enabled]", "true");
  for (let i = 0; i < lineItems; i++) form.set(`line_items[${i}][price_data][tax_behavior]`, "exclusive");
  form.set("billing_address_collection", "required");
  // A returning customer's address is saved on them, so tax on their renewals uses it.
  if (existingCustomer) {
    form.set("customer_update[address]", "auto");
    form.set("customer_update[name]", "auto");
  }
  return form;
}

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
  withTax(form, 1, false);
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
  extraSeats = 0,
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
    "subscription_data[metadata][extra_seats]": String(extraSeats),
    success_url: `${origin}/?purchase=subscribed`,
    cancel_url: `${origin}/?purchase=cancelled`,
  });
  if (extraSeats > 0) {
    const seat = interval === "year" ? EXTRA_SEAT.yearlyPriceCents * 12 : EXTRA_SEAT.priceCents;
    form.set("line_items[1][quantity]", String(extraSeats));
    form.set("line_items[1][price_data][currency]", currency());
    form.set("line_items[1][price_data][unit_amount]", String(seat));
    form.set("line_items[1][price_data][recurring][interval]", interval);
    form.set("line_items[1][price_data][product_data][name]", `Flash AI extra seat: 1 more person, ${EXTRA_SEAT.credits.toLocaleString("en-US")} more credits a month`);
    form.set("line_items[0][price_data][product_data][name]", `Flash AI ${plan.name}: ${planCredits(plan, extraSeats).toLocaleString("en-US")} credits a month with ${extraSeats} extra seats`);
  }
  if (customer) form.set("customer", customer);
  else form.set("customer_email", user.email);
  withTax(form, extraSeats > 0 ? 2 : 1, Boolean(customer));
  const json = await stripe<{ url?: string }>("POST", "/checkout/sessions", form);
  if (!json.url) throw new Error("Stripe didn't return a checkout link");
  return json.url;
}

/*
 * A domain's Checkout (see domain-orders.ts): the card is only held (manual capture) until Name.com
 * has bought the domain, then charged, or the hold is let go at no cost. Banks are asked for 3-D
 * Secure, and the statement reads FLASH* DOMAIN. Always in US dollars, as Name.com's prices are.
 */
export async function createDomainCheckout(
  order: { id: string; domain: string; priceCents: number },
  user: { id: string; email: string },
  origin: string,
): Promise<{ id: string; url: string }> {
  const form = new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(order.priceCents),
    "line_items[0][price_data][product_data][name]": `${order.domain}: domain name for 1 year`,
    customer_email: user.email,
    client_reference_id: user.id,
    "metadata[user]": user.id,
    "metadata[domain_order]": order.id,
    "payment_intent_data[capture_method]": "manual",
    "payment_intent_data[metadata][domain_order]": order.id,
    "payment_intent_data[metadata][user]": user.id,
    "payment_intent_data[statement_descriptor_suffix]": "DOMAIN",
    "payment_method_types[0]": "card",
    "payment_method_options[card][request_three_d_secure]": "any",
    // Stripe's shortest: a held price that waits longer could be gone.
    expires_at: String(Math.floor(Date.now() / 1000) + 31 * 60),
    success_url: `${origin}/?apps=1&purchase=domain`,
    cancel_url: `${origin}/?apps=1&purchase=cancelled`,
  });
  const json = await stripe<{ id: string; url?: string }>("POST", "/checkout/sessions", form, undefined, `domain-checkout:${order.id}`);
  if (!json.url) throw new Error("Stripe didn't return a checkout link");
  return { id: json.id, url: json.url };
}

export type HeldPayment = {
  id: string;
  status: string;
  amount: number;
  amount_capturable?: number;
  currency: string;
  metadata?: Record<string, string> | null;
  latest_charge?: { outcome?: { risk_level?: string; type?: string } | null; review?: string | null } | null;
  review?: string | null;
};

/** A payment with its charge's fraud check. */
export const getPayment = (id: string) => stripe<HeldPayment>("GET", `/payment_intents/${encodeURIComponent(id)}?expand[]=latest_charge`);

/** Charges a held payment. */
export const capturePayment = (id: string) =>
  stripe<HeldPayment>("POST", `/payment_intents/${encodeURIComponent(id)}/capture`, new URLSearchParams(), undefined, `capture:${id}`);

/** Lets a held payment go: the customer is never charged. */
export const cancelPayment = (id: string) =>
  stripe<HeldPayment>("POST", `/payment_intents/${encodeURIComponent(id)}/cancel`, new URLSearchParams(), undefined, `cancel:${id}`);

/** A Checkout Session's status ("open", "complete", "expired") and its PaymentIntent, once it has one. */
export const getCheckout = (session: string) =>
  stripe<{ payment_intent?: string | null; status?: string }>("GET", `/checkout/sessions/${encodeURIComponent(session)}`);

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
