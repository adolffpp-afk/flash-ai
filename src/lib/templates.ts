import type { Engine } from "./types.ts";
import { CLAUDE_PRICES, MARKUP } from "./credits.ts";

/*
 * Ready-made templates: a short form for a common job (a business plan, a resume, an invoice),
 * turned into a complete, well-made request for the right engine. Invoices and quotes are made
 * right here instead, with the totals worked out exactly, so they are free and never miscounted.
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
  // Kept on this device and offered again next time, in any template that asks for it.
  remember?: boolean;
  // Most characters accepted.
  max?: number;
};

export type TemplateValues = { text: Record<string, string>; items: LineItem[] };

export type Category = "Business" | "Career" | "Food & shop" | "Marketing";
export const CATEGORIES: Category[] = ["Business", "Career", "Food & shop", "Marketing"];

export type Template = {
  id: string;
  name: string;
  icon: string;
  category: Category;
  blurb: string;
  // The engine the request goes to, or "local" for documents made in the browser for free.
  engine: Engine | "local";
  fields: Field[];
  // The new chat's name.
  title: (v: TemplateValues) => string;
  // The request sent to the engine, written the way a person would ask (they can edit it later).
  request: (v: TemplateValues) => string;
  // About how many tokens the answer is, to estimate its price for writing engines.
  answerTokens?: number;
};

// --- Shared fields and wording -------------------------------------------------------------

const BUSINESS: Field = { key: "business", label: "Business name", placeholder: "Golden Crumb Bakery", required: true, remember: true, max: 80 };
const CITY: Field = { key: "city", label: "Where", placeholder: "Toronto, or online", remember: true, max: 80 };
const TONE: Field = {
  key: "tone",
  label: "Tone",
  type: "select",
  options: ["Friendly", "Professional", "Premium", "Playful", "Bold"],
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

/** A typed amount or quantity as a number: "1,200.50", "$8", "8,50", "2.5". NaN when it isn't one. */
export function parseAmount(text: string): number {
  let t = text.trim().replace(/[\s$€£¥₦₵₹]|[a-z]/gi, "");
  // "8,50" uses a decimal comma; "1,200" and "1,200.50" use commas between thousands.
  t = /^-?\d+,\d{1,2}$/.test(t) ? t.replace(",", ".") : t.replace(/,(?=\d{3}(\D|$))/g, "");
  if (!/^-?(\d+(\.\d+)?|\.\d+)$/.test(t)) return NaN;
  return Number(t);
}

/** Minor units (cents) shown as "1,234.50" in the currency's own number of decimals. */
export function formatMinor(minor: number, decimals: number): string {
  return (minor / 10 ** decimals).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** "2026-10-06" as "October 6, 2026", read as a calendar date wherever the user is. */
export function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** The number after this one, keeping its letters and zeros: INV-007 → INV-008, 2026-099 → 2026-100. */
export function nextNumber(previous: string): string {
  const m = /^(.*?)(\d+)(\D*)$/.exec(previous.trim());
  if (!m) return previous.trim() ? `${previous.trim()}-2` : "";
  const n = String(Number(m[2]) + 1).padStart(m[2].length, "0");
  return `${m[1]}${n}${m[3]}`;
}

export type Bill = {
  lines: { description: string; quantity: number; unitMinor: number; amountMinor: number }[];
  subtotalMinor: number;
  taxes: { name: string; rate: number; minor: number }[];
  totalMinor: number;
  decimals: number;
};

/** Works out an invoice's lines, taxes and total exactly, in whole minor units, or says what's wrong. */
export function workOutBill(items: LineItem[], currency: string, taxes: { name: string; rate: string }[]): Bill | { error: string } {
  const decimals = decimalsOf(currency);
  const unit = 10 ** decimals;
  const lines: Bill["lines"] = [];
  for (const [i, item] of items.entries()) {
    const description = item.description.trim();
    if (!description && !item.price.trim()) continue;
    if (!description) return { error: `Item ${i + 1} needs a description.` };
    const quantity = item.quantity.trim() ? parseAmount(item.quantity) : 1;
    if (!Number.isFinite(quantity) || quantity <= 0) return { error: `The quantity for "${description}" isn't a number above 0.` };
    const price = parseAmount(item.price);
    if (!Number.isFinite(price)) return { error: `The price for "${description}" isn't a number.` };
    const unitMinor = Math.round(price * unit);
    // Rounded once per line, the way it's printed, so the lines add up to the subtotal.
    lines.push({ description, quantity, unitMinor, amountMinor: Math.round(quantity * unitMinor) });
  }
  if (!lines.length) return { error: "Add at least one item with a price." };
  const subtotalMinor = lines.reduce((n, l) => n + l.amountMinor, 0);
  const taxLines: Bill["taxes"] = [];
  for (const t of taxes) {
    if (!t.rate.trim()) continue;
    const rate = parseAmount(t.rate.replace("%", ""));
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) return { error: `The tax rate "${t.rate}" isn't a percentage between 0 and 100.` };
    if (rate === 0) continue;
    // Each tax is on the subtotal (like GST and QST in Canada), rounded to the cent.
    taxLines.push({ name: t.name.trim() || "Tax", rate, minor: Math.round((subtotalMinor * rate) / 100) });
  }
  const totalMinor = subtotalMinor + taxLines.reduce((n, t) => n + t.minor, 0);
  return { lines, subtotalMinor, taxes: taxLines, totalMinor, decimals };
}

// Table cells can't hold a "|", which every exporter reads as a column break.
const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n+/g, " ");
const block = (s: string) => clean(s).split("\n").map((l) => cell(l.trim())).filter(Boolean).join("  \n");
const qty = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 3 });

/** An invoice or quote as a Markdown document, with every number already worked out. */
export function billMarkdown(kind: "invoice" | "quote", v: TemplateValues): string | { error: string } {
  const t = v.text;
  const currency = CURRENCIES.includes(clean(t.currency)) ? clean(t.currency) : "CAD";
  if (!clean(t.business)) return { error: "Add your business name." };
  if (!clean(t.client)) return { error: `Add who the ${kind} is for.` };
  const bill = workOutBill(v.items, currency, [
    { name: t.tax1Name ?? "", rate: t.tax1Rate ?? "" },
    { name: t.tax2Name ?? "", rate: t.tax2Rate ?? "" },
  ]);
  if ("error" in bill) return bill;
  const money = (minor: number) => formatMinor(minor, bill.decimals);
  const title = kind === "invoice" ? "Invoice" : "Quote";
  const number = clean(t.number);
  const dates: [string, string][] = [
    [`${title} date`, t.date ? longDate(t.date) : ""],
    [kind === "invoice" ? "Due date" : "Valid until", t.due ? longDate(t.due) : ""],
  ];
  const out: string[] = [`# ${title}${number ? ` ${cell(number)}` : ""}`, ""];
  // A name, then its details on the lines below it (two spaces end a line in Markdown).
  const party = (label: string, name: string, more: string | undefined) =>
    `**${label}:** ${cell(clean(name))}` + (clean(more) ? `  \n${block(more ?? "")}` : "");
  out.push(party("From", t.business, t.yourDetails));
  out.push("", party(kind === "invoice" ? "Bill to" : "For", t.client, t.clientDetails));
  const facts = [
    ...dates.filter(([, d]) => d),
    [kind === "invoice" ? "Amount due" : "Quote total", `${currency} ${money(bill.totalMinor)}`],
  ];
  out.push("", facts.map(([label, d]) => `**${label}:** ${d}`).join("  \n"));
  out.push(
    "",
    `| Item | Quantity | Unit price (${currency}) | Amount (${currency}) |`,
    "|---|---:|---:|---:|",
    ...bill.lines.map((l) => `| ${cell(l.description)} | ${qty(l.quantity)} | ${money(l.unitMinor)} | ${money(l.amountMinor)} |`),
    `| **Subtotal** | | | **${money(bill.subtotalMinor)}** |`,
    ...bill.taxes.map((x) => `| ${cell(x.name)} (${qty(x.rate)}%) | | | ${money(x.minor)} |`),
    `| **${kind === "invoice" ? "Total due" : "Total"}** | | | **${money(bill.totalMinor)}** |`,
  );
  if (clean(t.notes)) out.push("", block(t.notes));
  out.push("", kind === "invoice" ? "Thank you for your business!" : "To accept this quote, reply to say yes or sign and return it.");
  return out.join("\n");
}

const BILL_FIELDS = (kind: "invoice" | "quote"): Field[] => [
  BUSINESS,
  { key: "yourDetails", label: "Your details", type: "textarea", placeholder: "Address, email, phone, tax number", remember: true, max: 400 },
  { key: "client", label: kind === "invoice" ? "Bill to" : "Quote for", placeholder: "Maple Café", required: true, max: 80 },
  { key: "clientDetails", label: "Their details", type: "textarea", placeholder: "Address, email", max: 400 },
  { key: "number", label: kind === "invoice" ? "Invoice number" : "Quote number", placeholder: kind === "invoice" ? "INV-001" : "Q-001", max: 40 },
  { key: "date", label: kind === "invoice" ? "Invoice date" : "Quote date", type: "date" },
  { key: "due", label: kind === "invoice" ? "Due date" : "Valid until", type: "date" },
  { key: "currency", label: "Currency", type: "select", options: CURRENCIES, remember: true },
  { key: "items", label: "Items", type: "items", required: true },
  { key: "tax1Name", label: "Tax", placeholder: "HST, GST, VAT", remember: true, max: 30 },
  { key: "tax1Rate", label: "Tax rate (%)", placeholder: "13", remember: true, max: 8 },
  { key: "tax2Name", label: "Second tax (optional)", placeholder: "QST", remember: true, max: 30 },
  { key: "tax2Rate", label: "Second tax rate (%)", placeholder: "9.975", remember: true, max: 8 },
  { key: "notes", label: kind === "invoice" ? "Payment details and notes" : "Notes", type: "textarea", placeholder: kind === "invoice" ? "Pay by e-Transfer to hello@goldencrumb.ca within 14 days" : "Delivery included. Prices valid for 30 days.", remember: kind === "invoice", max: 600 },
];

// --- The templates ---------------------------------------------------------------------------

export const TEMPLATES: Template[] = [
  {
    id: "business-plan",
    name: "Business plan",
    icon: "📈",
    category: "Business",
    blurb: "A full plan with market, marketing, money forecast and risks.",
    engine: "docs",
    answerTokens: 6000,
    fields: [
      BUSINESS,
      { key: "offer", label: "What you sell or do", type: "textarea", placeholder: "Sourdough bread, pastries and coffee, baked fresh every morning", required: true, max: 600 },
      CITY,
      { key: "customers", label: "Who your customers are", placeholder: "Office workers and families nearby", max: 300 },
      { key: "budget", label: "Start-up money", placeholder: "$40,000 savings + $20,000 loan", max: 200 },
      { key: "goals", label: "Goals for the first year", type: "textarea", placeholder: "Break even by month 8, open a second stall", max: 600 },
    ],
    title: (v) => `Business plan: ${clean(v.text.business)}`,
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
    name: "Pitch deck",
    icon: "🎤",
    category: "Business",
    blurb: "A 10-slide investor deck you can present or download.",
    engine: "slides",
    fields: [
      BUSINESS,
      { key: "idea", label: "The idea in one sentence", placeholder: "Fresh bread delivered to offices before 9 am", required: true, max: 200 },
      { key: "problem", label: "The problem you solve", type: "textarea", max: 400 },
      { key: "customers", label: "Who pays you, and how", type: "textarea", placeholder: "Offices pay a monthly subscription", max: 400 },
      { key: "traction", label: "Results so far", placeholder: "12 offices, $4,000 a month", max: 300 },
      { key: "team", label: "Team", placeholder: "Ada (baker, 10 years), Ben (sales)", max: 300 },
      { key: "ask", label: "What you're asking for", placeholder: "$150,000 for a second oven and a van", max: 200 },
    ],
    title: (v) => `Pitch deck: ${clean(v.text.business)}`,
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
    name: "Invoice",
    icon: "🧾",
    category: "Business",
    blurb: "Totals and taxes worked out exactly. Free, and ready for PDF, Word or Excel.",
    engine: "local",
    fields: BILL_FIELDS("invoice"),
    title: (v) => `Invoice ${clean(v.text.number)} for ${clean(v.text.client)}`.replace(/\s+/g, " "),
    request: (v) => `Invoice ${clean(v.text.number)} for ${clean(v.text.client)}`.replace(/\s+/g, " "),
  },
  {
    id: "quote",
    name: "Quote",
    icon: "📝",
    category: "Business",
    blurb: "A price quote or estimate with exact totals. Free.",
    engine: "local",
    fields: BILL_FIELDS("quote"),
    title: (v) => `Quote ${clean(v.text.number)} for ${clean(v.text.client)}`.replace(/\s+/g, " "),
    request: (v) => `Quote ${clean(v.text.number)} for ${clean(v.text.client)}`.replace(/\s+/g, " "),
  },
  {
    id: "resume",
    name: "Resume",
    icon: "📄",
    category: "Career",
    blurb: "A one-page resume aimed at the job you want.",
    engine: "docs",
    answerTokens: 1500,
    fields: [
      { key: "name", label: "Your name", required: true, remember: true, max: 80 },
      { key: "role", label: "The job you want", placeholder: "Head baker", required: true, max: 120 },
      { key: "contact", label: "Contact", placeholder: "Email, phone, city, LinkedIn", remember: true, max: 300 },
      { key: "experience", label: "Experience", type: "textarea", placeholder: "Job title, employer, dates, and what you did, one job per line", required: true, max: 3000 },
      { key: "education", label: "Education", type: "textarea", placeholder: "Diploma, school, year", max: 1000 },
      { key: "skills", label: "Skills and languages", placeholder: "Sourdough, pastry, food safety, French", max: 500 },
    ],
    title: (v) => `Resume: ${clean(v.text.name)}`,
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
    name: "Cover letter",
    icon: "✉️",
    category: "Career",
    blurb: "A short, specific letter for one job.",
    engine: "docs",
    answerTokens: 700,
    fields: [
      { key: "name", label: "Your name", required: true, remember: true, max: 80 },
      { key: "role", label: "The job", placeholder: "Head baker", required: true, max: 120 },
      { key: "company", label: "Company", placeholder: "Maple Café", required: true, max: 120 },
      { key: "highlights", label: "Why you're a good fit", type: "textarea", placeholder: "8 years baking, ran a team of 4, love their sourdough", max: 1500 },
      { key: "ad", label: "The job ad (optional)", type: "textarea", placeholder: "Paste the job ad here", max: 4000 },
    ],
    title: (v) => `Cover letter: ${clean(v.text.role)} at ${clean(v.text.company)}`,
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
    name: "Menu",
    icon: "🍽️",
    category: "Food & shop",
    blurb: "A printable menu with sections and tasty descriptions.",
    engine: "docs",
    answerTokens: 1200,
    fields: [
      BUSINESS,
      { key: "food", label: "Kind of food", placeholder: "French bakery and café", max: 120 },
      { key: "dishes", label: "Dishes and prices", type: "textarea", placeholder: "Croissant 3.50\nPain au chocolat 4\nLatte 5.25", required: true, max: 4000 },
      { key: "info", label: "Hours, address and other info", type: "textarea", placeholder: "Open 7 am to 4 pm, 123 Queen St. Vegan options marked (V).", max: 600 },
    ],
    title: (v) => `Menu: ${clean(v.text.business)}`,
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
    name: "Flyer",
    icon: "📣",
    category: "Marketing",
    blurb: "A tall printable flyer or poster, in your brand colours.",
    engine: "image",
    fields: [
      BUSINESS,
      { key: "headline", label: "Headline", placeholder: "Grand opening!", required: true, max: 40 },
      { key: "details", label: "Details", placeholder: "Saturday Oct 12, 9 am · free coffee", max: 90 },
      { key: "look", label: "Look", type: "select", options: ["Bold and colourful", "Elegant", "Minimal", "Fun and playful", "Warm and cosy"] },
    ],
    title: (v) => `Flyer: ${clean(v.text.headline)}`,
    request: (v) =>
      `A tall vertical printable flyer for ${clean(v.text.business)}, with the headline "${clean(v.text.headline)}" ` +
      `in big clear letters` +
      (clean(v.text.details) ? ` and the line "${clean(v.text.details)}" in smaller letters` : "") +
      ` and the name "${clean(v.text.business)}". ${clean(v.text.look) || "Bold and colourful"} style, a clean ` +
      "layout with plenty of space, easy to read from a distance, and no other text.",
  },
  {
    id: "product-description",
    name: "Product description",
    icon: "🏷️",
    category: "Marketing",
    blurb: "A tagline, short and long descriptions, and SEO text.",
    engine: "docs",
    answerTokens: 800,
    fields: [
      { key: "product", label: "Product", placeholder: "Honey oat sourdough loaf", required: true, max: 120 },
      { key: "features", label: "What it is and what's special", type: "textarea", placeholder: "Baked overnight, local honey, 800 g, keeps 4 days", required: true, max: 1500 },
      { key: "audience", label: "Who it's for", placeholder: "Families who want healthier bread", max: 200 },
      TONE,
      { key: "where", label: "Where it's sold", type: "select", options: ["Online shop", "Amazon", "Etsy", "Instagram", "Shop shelf or menu"] },
    ],
    title: (v) => `Product text: ${clean(v.text.product)}`,
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
    name: "Business website",
    icon: "🌐",
    category: "Marketing",
    blurb: "A multi-page site with a contact form, ready to publish.",
    engine: "app",
    fields: [
      BUSINESS,
      { key: "offer", label: "What you do", type: "textarea", placeholder: "Sourdough bread, pastries and coffee", required: true, max: 600 },
      CITY,
      { key: "contact", label: "Contact details", placeholder: "Phone, email, address, hours", remember: true, max: 300 },
      { key: "pages", label: "Pages", placeholder: "Home, Menu, About, Contact", max: 200 },
      TONE,
    ],
    title: (v) => `Website: ${clean(v.text.business)}`,
    request: (v) =>
      `Build a website for ${clean(v.text.business)}.\n\n` +
      details(v, [
        ["offer", "What we do"],
        ["city", "Where"],
        ["contact", "Contact details"],
        ["tone", "Tone"],
      ]) +
      `\n\nPages: ${clean(v.text.pages) || "Home, About, Services, Contact"}. Include a contact form that sends ` +
      "messages to me, make it look great on phones, and use only the facts given (put [placeholders] for anything " +
      "missing, like prices or photos).",
  },
];

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id);

/** The fields a template needs filled in before it can be made, or "" when it's ready. */
export function missingField(t: Template, v: TemplateValues): string {
  for (const f of t.fields) {
    if (!f.required) continue;
    if (f.type === "items" ? !v.items.some((i) => i.description.trim()) : !clean(v.text[f.key])) return f.label;
  }
  return "";
}

/** About what a written template costs: its answer at the writing model's price, plus reading the request. */
export function writingCredits(answerTokens: number): number {
  const price = CLAUDE_PRICES["claude-sonnet-5-5"];
  return Math.ceil(((answerTokens * price.output + 3000 * price.input) / 1e6) * MARKUP);
}
