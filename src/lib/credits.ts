import type { Engine } from "./types.ts";

/*
 * How Flash prices requests.
 *
 * One credit is worth one US cent at the Starter pack price. Each request costs MARKUP times
 * what it costs Flash to run (the AI provider's bill), so every request makes a margin.
 * Provider prices below were checked on 2026-10-02; update them when providers change prices.
 */
export const MARKUP = Number(process.env.FLASH_MARKUP ?? 2.5);

export const creditsFor = (costCents: number) => Math.max(1, Math.ceil(costCents * MARKUP));

// Claude, in US cents per million tokens.
export const CLAUDE_PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 400, output: 2000 },
  "claude-sonnet-5-5": { input: 200, output: 1000 },
  "claude-haiku-4-5": { input: 100, output: 500 },
};
const WEB_SEARCH_CENTS = 1;

export type ClaudeUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
};

/** What one Claude call cost Flash, in cents. Unknown models are priced as Opus to stay safe. */
export function claudeCostCents(model: string, usage: ClaudeUsage): number {
  const price = CLAUDE_PRICES[model] ?? CLAUDE_PRICES["claude-opus-5-5"];
  const input =
    usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) * 1.25 + (usage.cache_read_input_tokens ?? 0) * 0.1;
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  return (input * price.input + usage.output_tokens * price.output) / 1e6 + searches * WEB_SEARCH_CENTS;
}

// ElevenLabs voice and transcription, in cents.
export const voiceCostCents = (characters: number) => (characters / 1000) * 2.2;
export const TRANSCRIBE_COST_CENTS = 1;

/*
 * Claude engines are charged by length. Flash holds up to this many credits while it writes
 * and gives back what the reply didn't use, so a reply never costs more than its limit.
 */
export const CREDIT_LIMITS: Partial<Record<Engine, number>> = {
  text: 30,
  translate: 30,
  docs: 60,
  search: 60,
  code: 120,
  app: 400,
  slides: 300,
};

// What a typical request costs, shown on the pricing table. Media engines use their models' prices.
export const TYPICAL_CREDITS: Partial<Record<Engine, number>> = {
  text: 4,
  translate: 3,
  docs: 10,
  search: 15,
  code: 25,
  app: 120,
  slides: 100,
  voice: 3,
  transcribe: 3,
};

export const FREE_MONTHLY_CREDITS = Number(process.env.FLASH_FREE_CREDITS ?? 200);

export type CreditPack = { id: string; name: string; credits: number; priceCents: number; blurb: string };

// One-off top-ups. Plans give more credits per dollar, like Lovable's and Emergent's.
export const CREDIT_PACKS: CreditPack[] = [
  { id: "starter", name: "Starter", credits: 500, priceCents: 500, blurb: "About 120 chats or 4 apps" },
  { id: "creator", name: "Creator", credits: 2200, priceCents: 2000, blurb: "Apps, slides and research for a busy week" },
  { id: "studio", name: "Studio", credits: 5800, priceCents: 5000, blurb: "Heavy app building" },
];

/*
 * Monthly plans. Credits arrive each month (yearly plans too) and unused credits carry over.
 * Every plan must make a profit even if the subscriber uses every credit: at worst a credit
 * costs Flash 1/MARKUP cents, so credits / MARKUP + payment fees must stay below the price.
 * test/pricing.test.ts checks this for every plan and pack.
 */
export type Plan = {
  id: string;
  name: string;
  priceCents: number; // per month, billed monthly
  yearlyPriceCents: number; // per month, billed yearly
  credits: number; // per month
  blurb: string;
  features: string[];
};

export const PLANS: Plan[] = [
  {
    id: "pro",
    name: "Pro",
    priceCents: 2500,
    yearlyPriceCents: 2000,
    credits: 3000,
    blurb: "For makers who build every week",
    features: ["3,000 credits a month", "About 25 apps or 700 chats", "Writing, research, code, apps and slides", "Unused credits carry over"],
  },
  {
    id: "power",
    name: "Power",
    priceCents: 5000,
    yearlyPriceCents: 4000,
    credits: 6500,
    blurb: "For daily building and research",
    features: ["6,500 credits a month", "About 55 apps or 1,600 chats", "Writing, research, code, apps and slides", "Unused credits carry over"],
  },
  {
    id: "max",
    name: "Max",
    priceCents: 20000,
    yearlyPriceCents: 16000,
    credits: 28000,
    blurb: "For studios and heavy app building",
    features: ["28,000 credits a month", "About 230 apps or 7,000 chats", "Writing, research, code, apps and slides", "Unused credits carry over"],
  },
];

export type Interval = "month" | "year";
export const planPrice = (plan: Plan, interval: Interval) =>
  interval === "year" ? plan.yearlyPriceCents * 12 : plan.priceCents;

// Stripe's card fee (2.9% + 30¢) plus 0.7% for Stripe Billing on subscriptions.
export const paymentFeeCents = (amountCents: number, subscription: boolean) =>
  amountCents * (subscription ? 0.036 : 0.029) + 30;

/** Profit per month if every credit is used, in cents: the worst case for Flash. */
export function worstCaseProfitCents(priceCents: number, credits: number, subscription: boolean, months = 1) {
  return (priceCents - paymentFeeCents(priceCents, subscription)) / months - credits / MARKUP;
}

/*
 * Output budget for Claude replies. A reply may spend at most what its held credits pay for,
 * so Flash never loses money on a long answer. SAFETY covers a fallback model that costs more.
 */
const SAFETY = 1.25;
export const MAX_OUTPUT_TOKENS = 64000;
export const MIN_OUTPUT_TOKENS: Partial<Record<Engine, number>> = {
  text: 1500,
  translate: 1500,
  docs: 4000,
  search: 2000,
  code: 4000,
  app: 16000,
  slides: 16000,
};
// Web search: up to 3 searches at 1¢ each, and the context is re-read once per tool call.
const SEARCH_CALLS = 5;
const SEARCH_RESULT_TOKENS = 6000;

const priceOf = (model: string) => CLAUDE_PRICES[model] ?? CLAUDE_PRICES["claude-opus-5-5"];

/** Worst-case input cost of one request, in cents (search re-reads its context per tool call). */
export function inputCostCents(engine: Engine, model: string, inputTokens: number): number {
  const price = priceOf(model);
  if (engine !== "search") return (inputTokens * price.input) / 1e6;
  let tokens = inputTokens;
  for (let i = 1; i <= SEARCH_CALLS; i++) tokens += inputTokens + i * SEARCH_RESULT_TOKENS;
  return (tokens * price.input) / 1e6 + 3 * WEB_SEARCH_CENTS;
}

/** Most output tokens a reply can write while costing no more than its held credits pay for. */
export function outputBudget(model: string, heldCredits: number, inputCents: number): number {
  const spendable = heldCredits / MARKUP / SAFETY - inputCents;
  return Math.min(MAX_OUTPUT_TOKENS, Math.floor((spendable * 1e6) / priceOf(model).output));
}

/**
 * How many credits a Claude request needs at least, and how many to hold. Long conversations
 * cost more to read, so the hold grows with the input on top of the engine's reply allowance.
 */
export function planHold(engine: Engine, model: string, inputTokens: number, available: number) {
  const inputCents = inputCostCents(engine, model, inputTokens);
  const minOutputCents = ((MIN_OUTPUT_TOKENS[engine] ?? 1500) * priceOf(model).output) / 1e6;
  const needed = Math.ceil((inputCents + minOutputCents) * MARKUP * SAFETY) + 1;
  const limit = Math.ceil(inputCents * MARKUP * SAFETY) + (CREDIT_LIMITS[engine] ?? 30);
  const held = Math.max(needed, Math.min(limit, available));
  return { needed, held, maxTokens: outputBudget(model, held, inputCents), capCents: held / MARKUP / SAFETY };
}
