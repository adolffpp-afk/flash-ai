import { paymentFeeCents } from "./credits.ts";

/*
 * What Flash charges for a domain it buys for a customer through Name.com (see server/namecom.ts and
 * server/domain-orders.ts), so no domain is ever sold at a loss:
 *
 *   V  Name.com's live price for the name (Check Availability), plus ICANN's fee when Name.com's
 *      price leaves it out (FLASH_DOMAIN_ICANN_FEE_CENTS, 20¢ until Name.com says it is included)
 *   C  V × (1 + k), k the foreign-currency fee on the card that funds Name.com (FLASH_NAMECOM_CARD_FX)
 *   M  Flash's margin: the larger of FLASH_DOMAIN_MARGIN_CENTS (US$3) and 10% of V
 *   P  the price, rounded up to the next .99, the smallest that keeps
 *      P − Stripe's fee on P (paymentFeeCents, with an international card's 0.8% on top) − C ≥ M
 *
 * A domain is a pass-through sale: the rule is no loss on any sale, which the M check guarantees.
 */

const INTERNATIONAL_CARD = 0.008;
const num = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
};

export type PriceSettings = { fx: number; marginCents: number; icannCents: number };

export const priceSettings = (): PriceSettings => ({
  fx: num(process.env.FLASH_NAMECOM_CARD_FX, 0.025),
  marginCents: num(process.env.FLASH_DOMAIN_MARGIN_CENTS, 300),
  icannCents: num(process.env.FLASH_DOMAIN_ICANN_FEE_CENTS, 20),
});

/** Stripe's worst-case fee on a one-off domain charge of this many cents. */
export const domainFeeCents = (priceCents: number) => paymentFeeCents(priceCents, false) + priceCents * INTERNATIONAL_CARD;

/** What Flash's card really pays for a name Name.com prices at this many cents. */
export const domainCostCents = (namecomCents: number, s: PriceSettings = priceSettings()) => (namecomCents + s.icannCents) * (1 + s.fx);

/** Flash's margin on a name Name.com prices at this many cents. */
export const domainMarginCents = (namecomCents: number, s: PriceSettings = priceSettings()) =>
  Math.max(s.marginCents, Math.ceil(0.1 * (namecomCents + s.icannCents)));

/** What Flash keeps after every fee when it sells at priceCents a name Name.com prices at namecomCents. */
export const domainKeepsCents = (priceCents: number, namecomCents: number, s: PriceSettings = priceSettings()) =>
  priceCents - domainFeeCents(priceCents) - domainCostCents(namecomCents, s);

/** Flash's price in US cents, ending in .99, for a name Name.com prices at namecomCents. */
export function domainPriceCents(namecomCents: number, s: PriceSettings = priceSettings()): number {
  const cost = domainCostCents(namecomCents, s);
  const margin = domainMarginCents(namecomCents, s);
  const rate = paymentFeeCents(100, false) / 100 - 0.37 + INTERNATIONAL_CARD;
  const x = Math.ceil((cost + 37 + margin) / (1 - rate));
  let price = Math.ceil((x + 1) / 100) * 100 - 1;
  // Rounding never leaves it short, but the check is what promises it.
  while (domainKeepsCents(price, namecomCents, s) < margin) price += 100;
  return price;
}

/*
 * The endings Flash sells at launch: sold for 1 year, with free WHOIS privacy at Name.com, and no
 * papers to send the registry (so no .ca, .us or .ai, which is sold for 2 years at a time).
 */
export const DOMAIN_ENDINGS = ["com", "net", "org", "co", "io", "app", "dev", "xyz", "site", "online", "store", "shop", "tech", "me"];

// The dearest name Flash sells at launch, in Name.com's price.
export const MAX_NAMECOM_CENTS = 10_000;

// Words people use to pass a site off as a bank or a big brand.
const BLOCKED_WORDS = ["paypal", "apple", "icloud", "microsoft", "google", "amazon", "netflix", "facebook", "instagram", "whatsapp", "bank", "login", "signin", "verify", "wallet", "coinbase", "binance", "metamask", "stripe"];

/** Whether a name may be bought in Flash: an ending sold at launch, no brand or phishing word, no punycode. */
export function sellableName(domain: string): boolean {
  const parts = domain.split(".");
  if (parts.length !== 2 || !DOMAIN_ENDINGS.includes(parts[1])) return false;
  const name = parts[0];
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name) || name.startsWith("xn--")) return false;
  return !BLOCKED_WORDS.some((w) => name.includes(w));
}

/** The name people type to search, as Name.com's keyword: letters, digits and dashes, with any ending taken off. */
export function searchKeyword(input: string): string {
  const first = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  const known = DOMAIN_ENDINGS.find((e) => first.endsWith(`.${e}`));
  const bare = known ? first.slice(0, -known.length - 1) : first;
  return bare
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

// Countries a domain can be registered to (ISO 3166-1), without those no registrar may sell to.
export const SANCTIONED_COUNTRIES = ["CU", "IR", "KP", "SY"];
export const REGISTRANT_COUNTRIES = [
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AR", "AS", "AT", "AU", "AW", "AX", "AZ", "BA", "BB", "BD", "BE", "BF",
  "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BW", "BY", "BZ", "CA", "CC", "CD", "CF", "CG",
  "CH", "CI", "CK", "CL", "CM", "CN", "CO", "CR", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK", "DM", "DO", "DZ", "EC",
  "EE", "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF", "GG", "GH", "GI",
  "GL", "GM", "GN", "GP", "GQ", "GR", "GT", "GU", "GW", "GY", "HK", "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN",
  "IO", "IQ", "IS", "IT", "JE", "JM", "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KR", "KW", "KY", "KZ", "LA", "LB",
  "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK", "ML", "MM", "MN",
  "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA", "NC", "NE", "NF", "NG", "NI", "NL", "NO",
  "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY", "QA",
  "RE", "RO", "RS", "RU", "RW", "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR",
  "SS", "ST", "SV", "SX", "SZ", "TC", "TD", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW", "TZ",
  "UA", "UG", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI", "VN", "VU", "WF", "WS", "YE", "YT", "ZA", "ZM", "ZW",
];

/** A price in US cents as people read it: 1599 is "US$15.99". */
export const usd = (cents: number) => `US$${(cents / 100).toFixed(2)}`;
