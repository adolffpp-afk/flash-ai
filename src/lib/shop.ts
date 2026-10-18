/*
 * Selling from a published site: prices, item names and return links. No server code here, so
 * the tests and the browser can use it too (the server side is src/lib/server/shop.ts).
 */
import { msg } from "./i18n.ts";

// Currencies without cents, where Stripe counts whole units.
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);

/** Countries a seller can open a Stripe account in, shown when they start selling (names translated where shown). */
export const SELLER_COUNTRIES: [string, string][] = [
  ["CA", msg("Canada")],
  ["US", msg("United States")],
  ["GB", msg("United Kingdom")],
  ["FR", msg("France")],
  ["BE", msg("Belgium")],
  ["CH", msg("Switzerland")],
  ["DE", msg("Germany")],
  ["ES", msg("Spain")],
  ["IT", msg("Italy")],
  ["NL", msg("Netherlands")],
  ["IE", msg("Ireland")],
  ["PT", msg("Portugal")],
  ["LU", msg("Luxembourg")],
  ["AT", msg("Austria")],
  ["SE", msg("Sweden")],
  ["NO", msg("Norway")],
  ["DK", msg("Denmark")],
  ["FI", msg("Finland")],
  ["PL", msg("Poland")],
  ["AU", msg("Australia")],
  ["NZ", msg("New Zealand")],
  ["SG", msg("Singapore")],
  ["HK", msg("Hong Kong")],
  ["JP", msg("Japan")],
  ["MX", msg("Mexico")],
  ["BR", msg("Brazil")],
  ["AE", msg("United Arab Emirates")],
];

export const MAX_ITEM_NAME = 80;
export const MAX_QUANTITY = 20;

/** An item name as the site's code gives it: trimmed, single spaces, not too long. Null if empty. */
export function cleanItemName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const name = input.replace(/\s+/g, " ").trim();
  return name && name.length <= MAX_ITEM_NAME ? name : null;
}

/** A price typed by a person ("12.50", "12,50", "$12") in the currency's smallest unit, or null. */
export function toMinor(input: string, currency: string): number | null {
  const text = input.replace(/[^\d.,]/g, "").replace(",", ".");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) return null;
  const zero = ZERO_DECIMAL.has(currency.toLowerCase());
  if (zero && text.includes(".")) return null;
  return zero ? Number(text) : Math.round(Number(text) * 100);
}

/** A price for people to read, like "$12.50" or "€8.00", written the reader's way when given their locale. */
export function formatMoney(minor: number, currency: string, locale = "en-US"): string {
  const zero = ZERO_DECIMAL.has(currency.toLowerCase());
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase() }).format(zero ? minor : minor / 100);
  } catch {
    return `${zero ? minor : (minor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** The smallest price, in the smallest unit: Stripe takes about 50 cents (or 50 yen and the like). */
export const MIN_PRICE = 50;

/** Flash's share of a sale, in basis points of the total (200 = 2%). */
export const saleFee = (amount: number, bps: number) => Math.min(amount, Math.max(0, Math.round((amount * bps) / 10_000)));

/** The item names a site's code sells or shows prices for, so the owner can price each one. */
export function itemsInHtml(html: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /flashDB\.buy\(\s*(["'`])([^"'`\n]{1,80})\1/g,
    /data-flash-(?:buy|price)\s*=\s*(["'])([^"'\n]{1,80})\1/g,
  ];
  for (const re of patterns) {
    for (const m of html.matchAll(re)) {
      const name = cleanItemName(m[2].replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"'));
      // Template literals with ${…} are worked out at run time, so they aren't a fixed name.
      if (name && !name.includes("${")) found.add(name);
      if (found.size >= 50) return [...found];
    }
  }
  return [...found];
}

/**
 * What in a page's address can say where its visitor came from: link tags (utm_…, ref), Flash's own
 * notes (flash_…), and ad networks' and email tools' click IDs (gclid, fbclid, msclkid, mc_eid, _hsenc…).
 */
const SOURCE_PARAM =
  /^(?:utm_.*|ref|ref_src|flash_.*|.*(?:clid|clkid|click_?id)|gclsrc|gbraid|wbraid|gad_.*|_ga|_gl|igshid|igsh|li_fat_id|srsltid|epik|sccid|s_cid|rdt_cid|mc_.*|_hs.*|__hs.*|hsctatracking|mkt_tok|vero_.*|oly_.*|_kx|ck_subscriber_id|wickedid|_branch_.*)$/i;

/**
 * Where to send a visitor after paying: the page they bought from, if it is one of the site's own
 * addresses, else the site's first address. Stops a checkout being used to send people elsewhere.
 */
export function safeReturn(page: unknown, addresses: string[]): string {
  if (typeof page === "string") {
    try {
      const url = new URL(page);
      const base = `${url.origin}${url.pathname}`.replace(/\/$/, "");
      if (url.protocol.startsWith("http") && addresses.some((a) => a.replace(/\/$/, "") === base)) {
        // The page, its #/route and the app's own query (?table=12), without what can say where the
        // buyer came from, which mustn't go to Stripe with their name.
        for (const name of [...new Set(url.searchParams.keys())]) if (SOURCE_PARAM.test(name)) url.searchParams.delete(name);
        return url.toString();
      }
    } catch {
      // Not a URL: use the site's own address.
    }
  }
  return addresses[0];
}

/** The page with a note for the site to say thank you, keeping the page's #/route. */
export function withPaidNote(page: string): string {
  const url = new URL(page);
  url.searchParams.set("flash_paid", "1");
  return url.toString();
}
