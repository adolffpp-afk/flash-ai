import type { Engine } from "./types.ts";
import { CLAUDE_PRICES, MARKUP } from "./credits.ts";
import { english, msg, type Blanks, type Translate } from "./i18n.ts";
import { PACK_VIDEO_SECONDS, helperAllowanceCents, modelById } from "./models.ts";

/*
 * Ready-made templates: a short form for a common job (a business plan, a resume, an invoice),
 * turned into a complete, well-made request for the right engine. Invoices and quotes are made
 * right here instead, with the totals worked out exactly, so they are free and never miscounted.
 *
 * What the Templates window shows (names, blurbs, labels, placeholders, choices) is marked msg()
 * and translated where it's shown. The requests stay in English: the engines answer in the user's
 * language anyway, and the choices picked go into them as written here.
 */

export type LineItem = { description: string; quantity: string; price: string };

export type FieldType = "text" | "textarea" | "date" | "select" | "items";
export type Field = {
  key: string;
  label: string;
  type?: FieldType;
  placeholder?: string;
  required?: boolean;
  options?: string[];
  // How a choice with a number in it is shown: its phrase, with the number in a blank (see choiceLabel).
  shown?: Record<string, { text: string; blanks: Blanks }>;
  // Kept on this device and offered again next time, in any template that asks for it.
  remember?: boolean;
  // Most characters accepted.
  max?: number;
};

export type TemplateValues = { text: Record<string, string>; items: LineItem[] };

export type Category = "Business" | "Career" | "Food & shop" | "Marketing";
export const CATEGORIES: Category[] = [msg("Business"), msg("Career"), msg("Food & shop"), msg("Marketing")];

export type Template = {
  id: string;
  name: string;
  icon: string;
  category: Category;
  blurb: string;
  // The engine the request goes to, or "local" for documents made in the browser for free.
  engine: Engine | "local";
  // The image or video model it needs, when the engine's usual pick won't do.
  model?: string;
  fields: Field[];
  // The new chat's name, in the language Flash is shown in (English without t).
  title: (v: TemplateValues, t?: Translate) => string;
  // The request sent to the engine, written the way a person would ask (they can edit it later).
  request: (v: TemplateValues) => string;
  // About how many tokens the answer is, to estimate its price for writing engines.
  answerTokens?: number;
};

// --- Shared fields and wording -------------------------------------------------------------

const BUSINESS: Field = { key: "business", label: msg("Business name"), placeholder: msg("Golden Crumb Bakery"), required: true, remember: true, max: 80 };
const CITY: Field = { key: "city", label: msg("Where"), placeholder: msg("Toronto, or online"), remember: true, max: 80 };
const TONE: Field = {
  key: "tone",
  label: msg("Tone"),
  type: "select",
  options: [msg("Friendly"), msg("Professional"), msg("Premium"), msg("Playful"), msg("Bold")],
};

const clean = (s: string | undefined) => (s ?? "").trim();

/** "Label: value" lines for the details that were filled in; empty ones are left out. */
function details(v: TemplateValues, fields: [string, string][]): string {
  return fields
    .map(([key, label]) => [label, clean(v.text[key])] as const)
    .filter(([, value]) => value)
    .map(([label, value]) => (value.includes("\n") ? `${label}:\n${value}` : `${label}: ${value}`))
    .join("\n");
}

const DOCUMENT_RULES =
  "Write it in the same language as the details above. Format it as a finished document in Markdown, with headings, " +
  "short paragraphs, lists and tables where they help. Don't put it in a code block and don't add any note before or " +
  "after it: start straight with the document. Where a detail is missing, write a short placeholder in [square " +
  "brackets] instead of making one up.";

// --- Money (invoices and quotes) -----------------------------------------------------------

export const CURRENCIES = ["CAD", "USD", "EUR", "GBP", "AUD", "NGN", "GHS", "KES", "ZAR", "XOF", "XAF", "INR", "JPY", "MXN", "BRL"];

/** How many decimals a currency uses (2 for dollars, 0 for yen and CFA francs). */
export function decimalsOf(currency: string): number {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

// BigInt constants (the build targets browsers older than BigInt literals).
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN = BigInt(10);
const HUNDRED = BigInt(100);

/** An exact decimal number: its digits as a whole number, and how many of them come after the point (12.50 is 1250n, 2). */
export type Decimal = { digits: bigint; scale: number };

// Currency words and abbreviations people type around amounts: "CAD 14", "Rs. 500", "R$ 80", "14 dollars".
const MONEY_WORDS = new Set([
  ...CURRENCIES.map((c) => c.toLowerCase()),
  ...["rs", "ksh", "sh", "r", "us", "ca", "c", "a", "au", "gh", "cfa", "fcfa", "f", "fr", "dollar", "dollars", "euro", "euros"],
  ...["naira", "cedi", "cedis", "rand", "rupee", "rupees", "yen", "pound", "pounds", "real", "reais", "peso", "pesos", "shilling", "shillings", "francs"],
]);

/** What may stand around the number: known currency words (with an abbreviation dot) and currency symbols. */
function moneyMarks(text: string, extra: RegExp): boolean {
  const words = text.match(/\p{L}+/gu) ?? [];
  if (words.some((w) => !MONEY_WORDS.has(w.toLowerCase()))) return false;
  return text.replace(/\p{L}+\.?/gu, "").replace(/\p{Sc}/gu, "").replace(extra, "") === "";
}

// Currencies whose countries often group thousands with dots (1.200 is twelve hundred reais).
const DOT_GROUPS = new Set(["EUR", "BRL", "XOF", "XAF"]);

/**
 * A typed amount, quantity or rate as an exact decimal: "1,200.50", "$8", "8,50", "Rs. 4,500", "1 250,00", "9.975%".
 * Null when it isn't clearly one number, like "2k" (a letter that isn't a currency). "1.200" reads as 1.2,
 * except with a currency whose countries group thousands with dots, where it could be either and is refused.
 */
export function parseDecimal(text: string, currency = ""): Decimal | null {
  // Spaces and apostrophes group thousands in many countries.
  const s = text.trim().replace(/[\s\u00a0\u202f'’]/g, "");
  const first = s.search(/\d/);
  if (first === -1) return null;
  const last = s.length - 1 - [...s].reverse().findIndex((ch) => /\d/.test(ch));
  let before = s.slice(0, first);
  const core = s.slice(first, last + 1);
  const after = s.slice(last + 1);
  // A mark right before the digits is a decimal point (".5", "$.50"), unless it ends a word like "Rs.".
  const leading = /[.,]$/.test(before) && !/\p{L}[.,]$/u.test(before);
  if (leading) before = before.slice(0, -1);
  const negative = (before.match(/-/g) ?? []).length;
  if (negative > 1 || !moneyMarks(before, /[-+]/g) || !moneyMarks(after, /^[.,]?%?[.,]?$/)) return null;
  if (!/^\d[\d.,]*$/.test(core)) return null;

  const grouped = (str: string, sep: string) => new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`).test(str);
  let whole = core;
  let frac = "";
  const dots = core.split(".").length - 1;
  const commas = core.split(",").length - 1;
  if (leading) {
    if (dots || commas) return null;
    whole = "0";
    frac = core;
  } else if (dots && commas) {
    // "1,200.50" and "1.200,50": the last mark is the decimal point, the other one groups thousands.
    const point = core.lastIndexOf(".") > core.lastIndexOf(",") ? "." : ",";
    const group = point === "." ? "," : ".";
    if (core.split(point).length > 2) return null;
    [whole, frac] = core.split(point);
    if (!grouped(whole, group)) return null;
    whole = whole.split(group).join("");
  } else if (dots + commas > 1) {
    const sep = dots ? "." : ",";
    if (!grouped(core, sep)) return null;
    whole = core.split(sep).join("");
  } else if (dots + commas === 1) {
    const sep = dots ? "." : ",";
    [whole, frac] = core.split(sep);
    if (frac.length === 3 && /^[1-9]\d{0,2}$/.test(whole)) {
      // "1,200" groups thousands. "1.200" is 1.2, unless the currency's countries write 1200 that way.
      if (sep === ",") {
        whole += frac;
        frac = "";
      } else if (DOT_GROUPS.has(currency.toUpperCase())) return null;
    }
  }
  if (!/^\d*$/.test(frac) || frac.length > 6 || (whole + frac).replace(/^0+/, "").length > 15) return null;
  const digits = BigInt(whole + frac || "0");
  return { digits: negative ? -digits : digits, scale: frac.length };
}

/** A typed amount or quantity as a number: "1,200.50", "$8", "8,50", "2.5". NaN when it isn't one. */
export function parseAmount(text: string): number {
  const d = parseDecimal(text);
  return d ? Number(d.digits) / 10 ** d.scale : NaN;
}

/** n ÷ 10^places, rounded half away from zero, the way money is rounded on paper. */
function shift(n: bigint, places: number): bigint {
  if (places <= 0) return n * TEN ** BigInt(-places);
  const d = TEN ** BigInt(places);
  const q = n / d;
  const r = n % d;
  if ((r < ZERO ? -r : r) * TWO >= d) return q + (n < ZERO ? -ONE : ONE);
  return q;
}

/** An exact decimal written out with thousands commas and at least `decimals` decimals: 1,234.50. */
export function formatDecimal(d: Decimal, decimals: number): string {
  let { digits, scale } = d;
  if (scale < decimals) {
    digits *= TEN ** BigInt(decimals - scale);
    scale = decimals;
  }
  const negative = digits < ZERO;
  const text = (negative ? -digits : digits).toString().padStart(scale + 1, "0");
  const whole = text.slice(0, text.length - scale).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${whole}${scale ? `.${text.slice(text.length - scale)}` : ""}`;
}

/** Minor units (cents) shown as "1,234.50" in the currency's own number of decimals. */
export function formatMinor(minor: number, decimals: number): string {
  return formatDecimal({ digits: BigInt(minor), scale: decimals }, decimals);
}

/** "2026-10-06" as "October 6, 2026" (in the locale given), read as a calendar date wherever the user is. */
export function longDate(iso: string, locale = "en-US"): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(locale, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** The number after this one, keeping its letters and zeros: INV-007 → INV-008, 2026-099 → 2026-100. */
export function nextNumber(previous: string): string {
  const m = /^(.*?)(\d+)(\D*)$/.exec(previous.trim());
  if (!m) return previous.trim() ? `${previous.trim()}-2` : "";
  const n = String(Number(m[2]) + 1).padStart(m[2].length, "0");
  return `${m[1]}${n}${m[3]}`;
}

export type Bill = {
  // Quantities and unit prices are shown as typed (a price of 0.125 stays 0.125); amounts are in minor units.
  lines: { description: string; quantity: string; unitPrice: string; amountMinor: number }[];
  subtotalMinor: number;
  taxes: { name: string; rate: string; minor: number }[];
  totalMinor: number;
  decimals: number;
};

// Above this (a hundred billion in dollars) a line can't be held exactly as a number any more.
const TOO_LARGE = TEN ** BigInt(13);

/** Works out an invoice's lines, taxes and total exactly, in whole minor units, or says what's wrong (in t's language). */
export function workOutBill(items: LineItem[], currency: string, taxes: { name: string; rate: string }[], t: Translate = english): Bill | { error: string } {
  const decimals = decimalsOf(currency);
  const lines: Bill["lines"] = [];
  let subtotal = ZERO;
  for (const [i, item] of items.entries()) {
    const description = item.description.trim();
    if (!description && !item.price.trim()) continue;
    if (!description) return { error: t("Item {number} needs a description.", { number: i + 1 }) };
    const quantity = item.quantity.trim() ? parseDecimal(item.quantity, currency) : { digits: ONE, scale: 0 };
    if (!quantity || quantity.digits <= ZERO) return { error: t('The quantity for "{item}" isn\'t a number above 0. Write it like 3 or 2.5.', { item: description }) };
    const price = parseDecimal(item.price, currency);
    if (!price) return { error: t('The price for "{item}" isn\'t clear. Write it like 1200 or 12.50.', { item: description }) };
    // Quantity × price, exactly, rounded once to the cent, the way the line is printed.
    const amount = shift(quantity.digits * price.digits * TEN ** BigInt(decimals), quantity.scale + price.scale);
    if ((amount < ZERO ? -amount : amount) >= TOO_LARGE) return { error: t('The amount for "{item}" is too large.', { item: description }) };
    subtotal += amount;
    lines.push({ description, quantity: formatDecimal(quantity, 0), unitPrice: formatDecimal(price, decimals), amountMinor: Number(amount) });
  }
  if (!lines.length) return { error: t("Add at least one item with a price.") };
  if (subtotal < ZERO) return { error: t("The items add up to less than zero. Check the discount lines.") };
  if (subtotal >= TOO_LARGE) return { error: t("The total is too large.") };
  const taxLines: Bill["taxes"] = [];
  let total = subtotal;
  for (const tax of taxes) {
    if (!tax.rate.trim()) continue;
    // A rate never groups thousands, so Quebec's 9.975% reads the same whatever the currency.
    const rate = parseDecimal(tax.rate);
    if (!rate || rate.digits < ZERO || rate.digits > HUNDRED * TEN ** BigInt(rate.scale)) {
      return { error: t('The tax rate "{rate}" isn\'t a percentage between 0 and 100.', { rate: tax.rate }) };
    }
    if (rate.digits === ZERO) continue;
    // Each tax is on the subtotal (like GST and QST in Canada), rounded to the cent.
    const minor = shift(subtotal * rate.digits, rate.scale + 2);
    total += minor;
    taxLines.push({ name: tax.name.trim() || t("Tax"), rate: formatDecimal(rate, 0), minor: Number(minor) });
  }
  return { lines, subtotalMinor: Number(subtotal), taxes: taxLines, totalMinor: Number(total), decimals };
}

// Table cells can't hold a "|", which every exporter reads as a column break.
const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n+/g, " ");
const block = (s: string) => clean(s).split("\n").map((l) => cell(l.trim())).filter(Boolean).join("  \n");

/**
 * An invoice or quote as a Markdown document, with every number already worked out, written in t's
 * language with its dates in that locale (English by default).
 */
export function billMarkdown(kind: "invoice" | "quote", v: TemplateValues, t: Translate = english, locale = "en-US"): string | { error: string } {
  const text = v.text;
  const invoice = kind === "invoice";
  const currency = CURRENCIES.includes(clean(text.currency)) ? clean(text.currency) : "CAD";
  if (!clean(text.business)) return { error: t("Add your business name.") };
  if (!clean(text.client)) return { error: invoice ? t("Add who the invoice is for.") : t("Add who the quote is for.") };
  const bill = workOutBill(
    v.items,
    currency,
    [
      { name: text.tax1Name ?? "", rate: text.tax1Rate ?? "" },
      { name: text.tax2Name ?? "", rate: text.tax2Rate ?? "" },
    ],
    t,
  );
  if ("error" in bill) return bill;
  const money = (minor: number) => formatMinor(minor, bill.decimals);
  const number = clean(text.number);
  const heading = number
    ? invoice
      ? t("Invoice {number}", { number: cell(number) })
      : t("Quote {number}", { number: cell(number) })
    : invoice
      ? t("Invoice")
      : t("Quote");
  const dates: [string, string][] = [
    [invoice ? t("Invoice date") : t("Quote date"), text.date ? longDate(text.date, locale) : ""],
    [invoice ? t("Due date") : t("Valid until"), text.due ? longDate(text.due, locale) : ""],
  ];
  const out: string[] = [`# ${heading}`, ""];
  // A name, then its details on the lines below it (two spaces end a line in Markdown).
  const party = (label: string, name: string, more: string | undefined) =>
    `**${label}:** ${cell(clean(name))}` + (clean(more) ? `  \n${block(more ?? "")}` : "");
  out.push(party(t("From"), text.business, text.yourDetails));
  out.push("", party(invoice ? t("Bill to") : t("For"), text.client, text.clientDetails));
  const facts = [
    ...dates.filter(([, d]) => d),
    [invoice ? t("Amount due") : t("Quote total"), `${currency} ${money(bill.totalMinor)}`],
  ];
  out.push("", facts.map(([label, d]) => `**${label}:** ${d}`).join("  \n"));
  out.push(
    "",
    `| ${t("Item")} | ${t("Quantity")} | ${t("Unit price ({currency})", { currency })} | ${t("Amount ({currency})", { currency })} |`,
    "|---|---:|---:|---:|",
    ...bill.lines.map((l) => `| ${cell(l.description)} | ${l.quantity} | ${l.unitPrice} | ${money(l.amountMinor)} |`),
    `| **${t("Subtotal")}** | | | **${money(bill.subtotalMinor)}** |`,
    ...bill.taxes.map((x) => `| ${cell(x.name)} (${x.rate}%) | | | ${money(x.minor)} |`),
    `| **${invoice ? t("Total due") : t("Total")}** | | | **${money(bill.totalMinor)}** |`,
  );
  if (clean(text.notes)) out.push("", block(text.notes));
  out.push("", invoice ? t("Thank you for your business!") : t("To accept this quote, reply to say yes or sign and return it."));
  return out.join("\n");
}

// Invoice and quote numbers, tax rates and currency codes are shown as they are.
const BILL_FIELDS = (kind: "invoice" | "quote"): Field[] => [
  BUSINESS,
  { key: "yourDetails", label: msg("Your details"), type: "textarea", placeholder: msg("Address, email, phone, tax number"), remember: true, max: 400 },
  { key: "client", label: kind === "invoice" ? msg("Bill to") : msg("Quote for"), placeholder: msg("Maple Café"), required: true, max: 80 },
  { key: "clientDetails", label: msg("Their details"), type: "textarea", placeholder: msg("Address, email"), max: 400 },
  { key: "number", label: kind === "invoice" ? msg("Invoice number") : msg("Quote number"), placeholder: kind === "invoice" ? "INV-001" : "Q-001", max: 40 },
  { key: "date", label: kind === "invoice" ? msg("Invoice date") : msg("Quote date"), type: "date" },
  { key: "due", label: kind === "invoice" ? msg("Due date") : msg("Valid until"), type: "date" },
  { key: "currency", label: msg("Currency"), type: "select", options: CURRENCIES, remember: true },
  { key: "items", label: msg("Items"), type: "items", required: true },
  { key: "tax1Name", label: msg("Tax"), placeholder: msg("HST, GST, VAT"), remember: true, max: 30 },
  { key: "tax1Rate", label: msg("Tax rate (%)"), placeholder: "13", remember: true, max: 8 },
  { key: "tax2Name", label: msg("Second tax (optional)"), placeholder: msg("QST"), remember: true, max: 30 },
  { key: "tax2Rate", label: msg("Second tax rate (%)"), placeholder: "9.975", remember: true, max: 8 },
  {
    key: "notes",
    label: kind === "invoice" ? msg("Payment details and notes") : msg("Notes"),
    type: "textarea",
    placeholder: kind === "invoice" ? msg("Pay by e-Transfer to hello@goldencrumb.ca within 14 days") : msg("Delivery included. Prices valid for 30 days."),
    remember: kind === "invoice",
    max: 600,
  },
];

// --- The templates ---------------------------------------------------------------------------

// The post pack's video choice, as it goes in the request; it's shown as its phrase in `shown`.
const WITH_VIDEO = `Pictures and a ${PACK_VIDEO_SECONDS} second video`;

export const TEMPLATES: Template[] = [
  {
    id: "business-plan",
    name: msg("Business plan"),
    icon: "📈",
    category: "Business",
    blurb: msg("A full plan with market, marketing, money forecast and risks."),
    engine: "docs",
    answerTokens: 6000,
    fields: [
      BUSINESS,
      { key: "offer", label: msg("What you sell or do"), type: "textarea", placeholder: msg("Sourdough bread, pastries and coffee, baked fresh every morning"), required: true, max: 600 },
      CITY,
      { key: "customers", label: msg("Who your customers are"), placeholder: msg("Office workers and families nearby"), max: 300 },
      { key: "budget", label: msg("Start-up money"), placeholder: msg("$40,000 savings + $20,000 loan"), max: 200 },
      { key: "goals", label: msg("Goals for the first year"), type: "textarea", placeholder: msg("Break even by month 8, open a second stall"), max: 600 },
    ],
    title: (v, t = english) => t("Business plan: {business}", { business: clean(v.text.business) }),
    request: (v) =>
      `Write a complete business plan for ${clean(v.text.business)}.\n\n` +
      details(v, [
        ["offer", "What it sells or does"],
        ["city", "Where"],
        ["customers", "Customers"],
        ["budget", "Start-up money"],
        ["goals", "Goals for the first year"],
      ]) +
      "\n\nInclude these sections: executive summary; the business; problem and solution; market and customers; " +
      "competition and what makes it different; marketing and sales; operations; team; financial plan, with a " +
      "start-up costs table and a 12-month forecast table of revenue, costs and profit, with the assumptions behind " +
      "the numbers stated plainly; milestones for the first year; risks and how to handle them. Mark every figure " +
      "you estimate as an estimate.\n\n" +
      DOCUMENT_RULES,
  },
  {
    id: "pitch-deck",
    name: msg("Pitch deck"),
    icon: "🎤",
    category: "Business",
    blurb: msg("A 10-slide investor deck you can present or download."),
    engine: "slides",
    fields: [
      BUSINESS,
      { key: "idea", label: msg("The idea in one sentence"), placeholder: msg("Fresh bread delivered to offices before 9 am"), required: true, max: 200 },
      { key: "problem", label: msg("The problem you solve"), type: "textarea", max: 400 },
      { key: "customers", label: msg("Who pays you, and how"), type: "textarea", placeholder: msg("Offices pay a monthly subscription"), max: 400 },
      { key: "traction", label: msg("Results so far"), placeholder: msg("12 offices, $4,000 a month"), max: 300 },
      { key: "team", label: msg("Team"), placeholder: msg("Ada (baker, 10 years), Ben (sales)"), max: 300 },
      { key: "ask", label: msg("What you're asking for"), placeholder: msg("$150,000 for a second oven and a van"), max: 200 },
    ],
    title: (v, t = english) => t("Pitch deck: {business}", { business: clean(v.text.business) }),
    request: (v) =>
      `Make a 10-slide investor pitch deck for ${clean(v.text.business)}.\n\n` +
      details(v, [
        ["idea", "The idea"],
        ["problem", "Problem"],
        ["customers", "Customers and business model"],
        ["traction", "Results so far"],
        ["team", "Team"],
        ["ask", "The ask"],
      ]) +
      "\n\nSlides: title; problem; solution; market; product; business model; traction; competition; team; the ask. " +
      "Use only the facts given. Where something is missing, show a short [placeholder] instead of making it up.",
  },
  {
    id: "invoice",
    name: msg("Invoice"),
    icon: "🧾",
    category: "Business",
    blurb: msg("Totals and taxes worked out exactly. Free, and ready for PDF, Word or Excel."),
    engine: "local",
    fields: BILL_FIELDS("invoice"),
    title: (v, t = english) => t("Invoice {number} for {client}", { number: clean(v.text.number), client: clean(v.text.client) }).replace(/\s+/g, " "),
    request: (v) => `Invoice ${clean(v.text.number)} for ${clean(v.text.client)}`.replace(/\s+/g, " "),
  },
  {
    id: "quote",
    name: msg("Quote"),
    icon: "📝",
    category: "Business",
    blurb: msg("A price quote or estimate with exact totals. Free."),
    engine: "local",
    fields: BILL_FIELDS("quote"),
    title: (v, t = english) => t("Quote {number} for {client}", { number: clean(v.text.number), client: clean(v.text.client) }).replace(/\s+/g, " "),
    request: (v) => `Quote ${clean(v.text.number)} for ${clean(v.text.client)}`.replace(/\s+/g, " "),
  },
  {
    id: "resume",
    name: msg("Resume"),
    icon: "📄",
    category: "Career",
    blurb: msg("A one-page resume aimed at the job you want."),
    engine: "docs",
    answerTokens: 1500,
    fields: [
      { key: "name", label: msg("Your name"), required: true, remember: true, max: 80 },
      { key: "role", label: msg("The job you want"), placeholder: msg("Head baker"), required: true, max: 120 },
      { key: "contact", label: msg("Contact"), placeholder: msg("Email, phone, city, LinkedIn"), remember: true, max: 300 },
      { key: "experience", label: msg("Experience"), type: "textarea", placeholder: msg("Job title, employer, dates, and what you did, one job per line"), required: true, max: 3000 },
      { key: "education", label: msg("Education"), type: "textarea", placeholder: msg("Diploma, school, year"), max: 1000 },
      { key: "skills", label: msg("Skills and languages"), placeholder: msg("Sourdough, pastry, food safety, French"), max: 500 },
    ],
    title: (v, t = english) => t("Resume: {name}", { name: clean(v.text.name) }),
    request: (v) =>
      `Write a one-page resume for ${clean(v.text.name)}, aimed at a ${clean(v.text.role)} job.\n\n` +
      details(v, [
        ["contact", "Contact"],
        ["experience", "Experience"],
        ["education", "Education"],
        ["skills", "Skills"],
      ]) +
      "\n\nOrder: name and contact line, a two or three sentence summary aimed at this job, experience, education, " +
      "skills. Turn the experience into short achievement bullet points that start with strong verbs. Keep every " +
      "employer, job title, date, school and number exactly as given, and never add ones that weren't given. Keep " +
      "the layout simple so hiring software can read it.\n\n" +
      DOCUMENT_RULES,
  },
  {
    id: "cover-letter",
    name: msg("Cover letter"),
    icon: "✉️",
    category: "Career",
    blurb: msg("A short, specific letter for one job."),
    engine: "docs",
    answerTokens: 700,
    fields: [
      { key: "name", label: msg("Your name"), required: true, remember: true, max: 80 },
      { key: "role", label: msg("The job"), placeholder: msg("Head baker"), required: true, max: 120 },
      { key: "company", label: msg("Company"), placeholder: msg("Maple Café"), required: true, max: 120 },
      { key: "highlights", label: msg("Why you're a good fit"), type: "textarea", placeholder: msg("8 years baking, ran a team of 4, love their sourdough"), max: 1500 },
      { key: "ad", label: msg("The job ad (optional)"), type: "textarea", placeholder: msg("Paste the job ad here"), max: 4000 },
    ],
    title: (v, t = english) => t("Cover letter: {role} at {company}", { role: clean(v.text.role), company: clean(v.text.company) }),
    request: (v) =>
      `Write a cover letter from ${clean(v.text.name)} for the ${clean(v.text.role)} job at ${clean(v.text.company)}.\n\n` +
      details(v, [
        ["highlights", "Why I'm a good fit"],
        ["ad", "The job ad"],
      ]) +
      "\n\nKeep it to 250 to 350 words, warm and specific, without clichés. Connect my experience to what the job " +
      "needs, and end with a clear next step and my name.\n\n" +
      DOCUMENT_RULES,
  },
  {
    id: "menu",
    name: msg("Menu"),
    icon: "🍽️",
    category: "Food & shop",
    blurb: msg("A printable menu with sections and tasty descriptions."),
    engine: "docs",
    answerTokens: 1200,
    fields: [
      BUSINESS,
      { key: "food", label: msg("Kind of food"), placeholder: msg("French bakery and café"), max: 120 },
      { key: "dishes", label: msg("Dishes and prices"), type: "textarea", placeholder: msg("Croissant 3.50\nPain au chocolat 4\nLatte 5.25"), required: true, max: 4000 },
      { key: "info", label: msg("Hours, address and other info"), type: "textarea", placeholder: msg("Open 7 am to 4 pm, 123 Queen St. Vegan options marked (V)."), max: 600 },
    ],
    title: (v, t = english) => t("Menu: {business}", { business: clean(v.text.business) }),
    request: (v) =>
      `Write the menu for ${clean(v.text.business)}.\n\n` +
      details(v, [
        ["food", "Kind of food"],
        ["dishes", "Dishes and prices"],
        ["info", "Other info"],
      ]) +
      "\n\nGroup the dishes into sections that fit them (like starters, mains, desserts, drinks). Give each dish a " +
      "short, appetising description of 15 words or fewer. Keep every price exactly as given; when a dish has no " +
      "price, write [price]. Only mark dishes vegetarian, vegan or gluten-free when the details say so. End with the " +
      "other info.\n\n" +
      DOCUMENT_RULES,
  },
  {
    id: "flyer",
    name: msg("Flyer"),
    icon: "📣",
    category: "Marketing",
    blurb: msg("A tall printable flyer or poster, in your brand colours."),
    engine: "image",
    fields: [
      BUSINESS,
      { key: "headline", label: msg("Headline"), placeholder: msg("Grand opening!"), required: true, max: 40 },
      { key: "details", label: msg("Details"), placeholder: msg("Saturday Oct 12, 9 am · free coffee"), max: 90 },
      { key: "look", label: msg("Look"), type: "select", options: [msg("Bold and colourful"), msg("Elegant"), msg("Minimal"), msg("Fun and playful"), msg("Warm and cosy")] },
    ],
    title: (v, t = english) => t("Flyer: {headline}", { headline: clean(v.text.headline) }),
    request: (v) =>
      `A tall vertical printable flyer for ${clean(v.text.business)}, with the headline "${clean(v.text.headline)}" ` +
      `in big clear letters` +
      (clean(v.text.details) ? ` and the line "${clean(v.text.details)}" in smaller letters` : "") +
      ` and the name "${clean(v.text.business)}". ${clean(v.text.look) || "Bold and colourful"} style, a clean ` +
      "layout with plenty of space, easy to read from a distance, and no other text.",
  },
  {
    id: "social-pack",
    name: msg("Social post pack"),
    icon: "📱",
    category: "Marketing",
    blurb: msg("Posts and hashtags for Instagram, TikTok and Facebook, with a square and a tall picture, and a video if you like."),
    engine: "image",
    model: "post-pack",
    fields: [
      BUSINESS,
      { key: "about", label: msg("What to post about"), type: "textarea", placeholder: msg("Our new honey oat loaf, $8, this weekend only"), required: true, max: 600 },
      { key: "action", label: msg("What people should do"), placeholder: msg("Order at goldencrumb.ca, or visit us on King St"), max: 150 },
      TONE,
      {
        key: "video",
        label: msg("Video"),
        type: "select",
        options: [msg("Pictures only"), WITH_VIDEO],
        shown: { [WITH_VIDEO]: { text: msg("Pictures and a {seconds} second video"), blanks: { seconds: PACK_VIDEO_SECONDS } } },
      },
    ],
    title: (v, t = english) => t("Posts: {about}", { about: clean(v.text.about).split("\n")[0].slice(0, 40) }),
    request: (v) =>
      `Make a social post pack for ${clean(v.text.business)} about: ${clean(v.text.about)}\n\n` +
      details(v, [
        ["action", "What people should do"],
        ["tone", "Tone"],
      ]) +
      (clean(v.text.video).includes("video") ? "\n\nWith a short video." : "\n\nPictures only, no video."),
  },
  {
    id: "product-description",
    name: msg("Product description"),
    icon: "🏷️",
    category: "Marketing",
    blurb: msg("A tagline, short and long descriptions, and SEO text."),
    engine: "docs",
    answerTokens: 800,
    fields: [
      { key: "product", label: msg("Product"), placeholder: msg("Honey oat sourdough loaf"), required: true, max: 120 },
      { key: "features", label: msg("What it is and what's special"), type: "textarea", placeholder: msg("Baked overnight, local honey, 800 g, keeps 4 days"), required: true, max: 1500 },
      { key: "audience", label: msg("Who it's for"), placeholder: msg("Families who want healthier bread"), max: 200 },
      TONE,
      { key: "where", label: msg("Where it's sold"), type: "select", options: [msg("Online shop"), "Amazon", "Etsy", "Instagram", msg("Shop shelf or menu")] },
    ],
    title: (v, t = english) => t("Product text: {product}", { product: clean(v.text.product) }),
    request: (v) =>
      `Write product descriptions for ${clean(v.text.product)}.\n\n` +
      details(v, [
        ["features", "What it is"],
        ["audience", "Who it's for"],
        ["tone", "Tone"],
        ["where", "Where it's sold"],
      ]) +
      "\n\nGive: a one-line tagline; a short description of 40 to 60 words; a long description of 120 to 180 words " +
      "with three to five bullet points of benefits; an SEO title of at most 60 characters; and a meta description " +
      "of at most 155 characters. Use only the features given.\n\n" +
      DOCUMENT_RULES,
  },
  {
    id: "website",
    name: msg("Business website"),
    icon: "🌐",
    category: "Marketing",
    blurb: msg("A multi-page site with a contact form, ready to publish."),
    engine: "app",
    fields: [
      BUSINESS,
      { key: "offer", label: msg("What you do"), type: "textarea", placeholder: msg("Sourdough bread, pastries and coffee"), required: true, max: 600 },
      CITY,
      { key: "siteContact", label: msg("Contact details"), placeholder: msg("Phone, email, address, hours"), remember: true, max: 300 },
      { key: "pages", label: msg("Pages"), placeholder: msg("Home, Menu, About, Contact"), max: 200 },
      TONE,
    ],
    title: (v, t = english) => t("Website: {business}", { business: clean(v.text.business) }),
    request: (v) =>
      `Build a website for ${clean(v.text.business)}.\n\n` +
      details(v, [
        ["offer", "What we do"],
        ["city", "Where"],
        ["siteContact", "Contact details"],
        ["tone", "Tone"],
      ]) +
      `\n\nPages: ${clean(v.text.pages) || "Home, About, Services, Contact"}. Include a contact form that sends ` +
      "messages to me, make it look great on phones, and use only the facts given (put [placeholders] for anything " +
      "missing, like prices or photos).",
  },
];

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id);

/** A choice as the form shows it, in t's language; the choice itself goes in the request as written. */
export function choiceLabel(f: Field, choice: string, t: Translate): string {
  const shown = f.shown?.[choice];
  return shown ? t(shown.text, shown.blanks) : t(choice);
}

/** The label of the first field a template needs filled in before it can be made (to show with t()), or "" when it's ready. */
export function missingField(t: Template, v: TemplateValues): string {
  for (const f of t.fields) {
    if (!f.required) continue;
    if (f.type === "items" ? !v.items.some((i) => i.description.trim()) : !clean(v.text[f.key])) return f.label;
  }
  return "";
}

/** About what a written template costs: its answer at the writing model's price, plus reading the request. */
export function writingCredits(answerTokens: number, model = "claude-sonnet-5-5", markup = MARKUP): number {
  const price = CLAUDE_PRICES[model] ?? CLAUDE_PRICES["claude-sonnet-5-5"];
  return Math.ceil(((answerTokens * price.output + 3000 * price.input) / 1e6) * markup);
}

/** What a template that needs a particular model costs Flash, in cents, for these details. */
export function modelTemplateCents(t: Template, v: TemplateValues): number {
  const m = modelById(t.model);
  if (!m) return 0;
  return typeof m.costCents === "function" ? m.costCents(t.request(v)) : m.costCents;
}

/** A template's form as it first opens: every choice on its first option. */
export const defaultValues = (t: Template): TemplateValues => ({
  text: Object.fromEntries(t.fields.filter((f) => f.type === "select").map((f) => [f.key, f.options?.[0] ?? ""])),
  items: [],
});

/**
 * The typical price of each template, by id. The server works these out with its real model and
 * markup. A template with a choice that costs more (the post pack's video) also has "<id>:with",
 * its price with the dearest choice. A template made with a model is priced like a request on it
 * (see modelCredits): its price includes the helpers that may run for it.
 */
export function templateCredits(model?: string, markup = MARKUP): Record<string, number> {
  const prices: Record<string, number> = {};
  for (const t of TEMPLATES) {
    if (t.answerTokens) prices[t.id] = writingCredits(t.answerTokens, model, markup);
    const m = modelById(t.model);
    if (!m) continue;
    const credits = (cents: number) => Math.max(1, Math.ceil((cents + helperAllowanceCents(m)) * markup));
    const base = defaultValues(t);
    prices[t.id] = credits(modelTemplateCents(t, base));
    const choices = t.fields
      .filter((f) => f.type === "select")
      .flatMap((f) => (f.options ?? []).map((o) => modelTemplateCents(t, { ...base, text: { ...base.text, [f.key]: o } })));
    const most = credits(Math.max(0, ...choices));
    if (most > prices[t.id]) prices[`${t.id}:with`] = most;
  }
  return prices;
}
