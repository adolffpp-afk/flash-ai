/*
 * The day's exchange rates from US dollars, for the "about €23" guide next to prices (see
 * local-currency.ts). They come from open.er-api.com (free, no key, updated daily) and are kept in
 * memory for 12 hours. They never decide what anyone pays: Stripe sets that at checkout.
 */

const RATES_URL = process.env.FLASH_FX_URL || "https://open.er-api.com/v6/latest/USD";
const KEEP_MS = 12 * 60 * 60 * 1000;

let cached: { at: number; rates: Record<string, number> } | null = null;
let pending: Promise<Record<string, number> | null> | null = null;

async function load(): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(RATES_URL, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: string; rates?: Record<string, unknown> };
    if (json.result && json.result !== "success") return null;
    const rates: Record<string, number> = {};
    for (const [code, value] of Object.entries(json.rates ?? {})) {
      if (/^[A-Z]{3}$/.test(code) && typeof value === "number" && Number.isFinite(value) && value > 0) rates[code] = value;
    }
    return Object.keys(rates).length ? rates : null;
  } catch {
    return null;
  }
}

/** How many of a currency one US dollar buys today, or null when it isn't known. */
export async function usdRate(currency: string): Promise<number | null> {
  if (!cached || Date.now() - cached.at > KEEP_MS) {
    pending ??= load().finally(() => (pending = null));
    const rates = await pending;
    // A failed fetch keeps yesterday's rates, if there are any.
    if (rates) cached = { at: Date.now(), rates };
  }
  return cached?.rates[currency.toUpperCase()] ?? null;
}

/** For tests: forgets the rates. */
export const forgetRates = () => {
  cached = null;
  pending = null;
};
