import { countryOf } from "@/lib/server/free.ts";
import { usdRate } from "@/lib/server/fx.ts";
import { currency } from "@/lib/server/stripe.ts";
import { currencyForCountry, type LocalCurrency } from "@/lib/local-currency.ts";

export const dynamic = "force-dynamic";

/**
 * Public: the visitor's currency (from their country) and today's rate from Flash's prices, so
 * price tags can show "about €23" too; null when they pay in dollars or the rate isn't known.
 * adaptive: Stripe's Adaptive Pricing is on (FLASH_ADAPTIVE_PRICING), so checkout charges them in it.
 */
export async function GET(request: Request) {
  const local = currencyForCountry(countryOf(request));
  if (!local || currency() !== "usd") return Response.json(null);
  const rate = await usdRate(local);
  const body: LocalCurrency | null = rate ? { currency: local, rate, adaptive: process.env.FLASH_ADAPTIVE_PRICING === "true" } : null;
  return Response.json(body, { headers: { "Cache-Control": "private, max-age=3600" } });
}
