/*
 * Prices in the visitor's own money, as a guide next to Flash's US dollar prices. The estimate
 * uses the day's exchange rate (see server/fx.ts) plus LOCAL_BUFFER, about what Stripe's Adaptive
 * Pricing (or the customer's bank) adds for converting, so the real charge is rarely above it.
 */

// Stripe adds 2-4% to the rate when a customer pays in their own currency; banks add about as much.
export const LOCAL_BUFFER = 1.03;

/** The visitor's currency and how many of it one US dollar buys (buffer not included). */
export type LocalCurrency = { currency: string; rate: number; adaptive: boolean };

/** The currency each country pays in, by two-letter country code. Countries on US dollars are left out. */
export const COUNTRY_CURRENCY: Record<string, string> = {
  // Europe
  AT: "EUR", BE: "EUR", CY: "EUR", DE: "EUR", EE: "EUR", ES: "EUR", FI: "EUR", FR: "EUR", GR: "EUR",
  HR: "EUR", IE: "EUR", IT: "EUR", LT: "EUR", LU: "EUR", LV: "EUR", MT: "EUR", NL: "EUR", PT: "EUR",
  SI: "EUR", SK: "EUR", MC: "EUR", SM: "EUR", VA: "EUR", AD: "EUR", ME: "EUR", XK: "EUR",
  GB: "GBP", CH: "CHF", LI: "CHF", NO: "NOK", SE: "SEK", DK: "DKK", IS: "ISK", PL: "PLN", CZ: "CZK",
  HU: "HUF", RO: "RON", BG: "BGN", RS: "RSD", BA: "BAM", MK: "MKD", AL: "ALL", MD: "MDL", UA: "UAH",
  GE: "GEL", AM: "AMD", AZ: "AZN", TR: "TRY", RU: "RUB", BY: "BYN",
  // Americas
  CA: "CAD", MX: "MXN", BR: "BRL", AR: "ARS", CL: "CLP", CO: "COP", PE: "PEN", UY: "UYU", PY: "PYG",
  BO: "BOB", VE: "VES", GT: "GTQ", HN: "HNL", NI: "NIO", CR: "CRC", PA: "PAB", DO: "DOP", JM: "JMD",
  TT: "TTD", HT: "HTG", BS: "BSD", BB: "BBD", BZ: "BZD", GY: "GYD", SR: "SRD", CU: "CUP",
  AG: "XCD", DM: "XCD", GD: "XCD", KN: "XCD", LC: "XCD", VC: "XCD", KY: "KYD", BM: "BMD", AW: "AWG",
  // Africa
  NG: "NGN", GH: "GHS", KE: "KES", UG: "UGX", TZ: "TZS", RW: "RWF", BI: "BIF", ET: "ETB", ZA: "ZAR",
  NA: "NAD", BW: "BWP", ZM: "ZMW", MW: "MWK", MZ: "MZN", AO: "AOA", CD: "CDF", EG: "EGP", MA: "MAD",
  DZ: "DZD", TN: "TND", LY: "LYD", SD: "SDG", SS: "SSP", SO: "SOS", DJ: "DJF", ER: "ERN", MG: "MGA",
  MU: "MUR", SC: "SCR", KM: "KMF", GM: "GMD", GN: "GNF", SL: "SLE", LR: "LRD", CV: "CVE", MR: "MRU",
  LS: "LSL", SZ: "SZL", ST: "STN",
  BJ: "XOF", BF: "XOF", CI: "XOF", GW: "XOF", ML: "XOF", NE: "XOF", SN: "XOF", TG: "XOF",
  CM: "XAF", CF: "XAF", TD: "XAF", CG: "XAF", GQ: "XAF", GA: "XAF",
  // Asia and the Middle East
  IN: "INR", PK: "PKR", BD: "BDT", LK: "LKR", NP: "NPR", BT: "BTN", MV: "MVR", AF: "AFN",
  CN: "CNY", HK: "HKD", MO: "MOP", TW: "TWD", JP: "JPY", KR: "KRW", MN: "MNT",
  ID: "IDR", MY: "MYR", SG: "SGD", TH: "THB", VN: "VND", PH: "PHP", MM: "MMK", KH: "KHR", LA: "LAK", BN: "BND",
  AE: "AED", SA: "SAR", QA: "QAR", KW: "KWD", BH: "BHD", OM: "OMR", JO: "JOD", IL: "ILS", LB: "LBP",
  IQ: "IQD", IR: "IRR", YE: "YER", SY: "SYP", KZ: "KZT", UZ: "UZS", KG: "KGS", TJ: "TJS", TM: "TMT",
  // Oceania
  AU: "AUD", NZ: "NZD", FJ: "FJD", PG: "PGK", WS: "WST", TO: "TOP", VU: "VUV", SB: "SBD",
  KI: "AUD", NR: "AUD", TV: "AUD", CK: "NZD", NU: "NZD", PF: "XPF", NC: "XPF", WF: "XPF",
};

/** The currency for a two-letter country code, or null for the US, US dollar countries and unknown ones. */
export const currencyForCountry = (country: string): string | null => COUNTRY_CURRENCY[country.toUpperCase()] ?? null;

/**
 * A US dollar price in the visitor's currency, rounded the way a person would say it ("€23",
 * "₦38,500"), or null when there's nothing to show (no rate, or the visitor pays in dollars).
 */
export function localPrice(usdCents: number, local: LocalCurrency | null, locale?: string): string | null {
  if (!local || !(local.rate > 0) || local.currency === "USD") return null;
  const amount = (usdCents / 100) * local.rate * LOCAL_BUFFER;
  // Small amounts keep one more digit; big ones round to 2-3 significant digits.
  const step = amount >= 1000 ? 10 ** (Math.floor(Math.log10(amount)) - 2) : amount >= 10 ? 1 : 0.1;
  const rounded = Math.round(amount / step) * step;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: local.currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: step < 1 ? 1 : 0,
      minimumFractionDigits: 0,
    }).format(rounded);
  } catch {
    return null;
  }
}
