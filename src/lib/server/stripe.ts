import { createHmac, timingSafeEqual } from "node:crypto";
import type { CreditPack } from "../credits.ts";

const STRIPE_API = process.env.STRIPE_API_BASE || "https://api.stripe.com/v1";

export const paymentsEnabled = () => Boolean(process.env.STRIPE_SECRET_KEY);
// Lets you test the buy flow before Stripe is set up. Never turn this on for real users.
export const demoPurchases = () => !paymentsEnabled() && process.env.FLASH_DEMO_PURCHASES === "true";

/** Creates a Stripe Checkout page for a credit pack and returns its URL. */
export async function createCheckout(pack: CreditPack, userId: string, email: string, origin: string): Promise<string> {
  const form = new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": process.env.FLASH_CURRENCY || "usd",
    "line_items[0][price_data][unit_amount]": String(pack.priceCents),
    "line_items[0][price_data][product_data][name]": `Flash AI ${pack.name}: ${pack.credits.toLocaleString("en-US")} credits`,
    customer_email: email,
    client_reference_id: userId,
    "metadata[user]": userId,
    "metadata[pack]": pack.id,
    success_url: `${origin}/?purchase=success`,
    cancel_url: `${origin}/?purchase=cancelled`,
  });
  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const json = (await res.json()) as { url?: string; error?: { message?: string } };
  if (!res.ok || !json.url) throw new Error(json.error?.message ?? `Stripe returned ${res.status}`);
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
