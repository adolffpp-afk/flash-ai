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

// ElevenLabs voice and transcription, in cents. Both are priced at the dearer of the two ways Flash
// reaches them: fal.ai's Turbo v2.5 voice ($0.05 per 1,000 characters, ElevenLabs direct is about
// $0.022) and fal.ai's Scribe v2 ($0.008 a minute, ElevenLabs direct is $0.40 an hour).
export const voiceCostCents = (characters: number) => (characters / 1000) * 5;
// Voice reads at most this many characters, and is priced on the same text.
export const MAX_SPEECH_CHARS = 10000;

/*
 * Transcription is billed per minute of audio, which Flash can't measure before sending the
 * file. So it is priced as if the file were the longest recording its size could hold: at 8 kbps
 * (1,000 bytes a second, below common speech codecs), at Scribe's $0.008 a minute. A 3 MB file
 * is priced as 52 minutes; a normal 128 kbps MP3 pays for more than it uses, but never less.
 */
const TRANSCRIBE_CENTS_PER_MINUTE = 0.8;
const MIN_AUDIO_BYTES_PER_SECOND = 1000;
export const transcribeCostCents = (bytes: number) =>
  Math.max(1, (bytes / MIN_AUDIO_BYTES_PER_SECOND / 60) * TRANSCRIBE_CENTS_PER_MINUTE);

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
  voice: 4,
  // A 500 KB recording (see transcribeCostCents).
  transcribe: 18,
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
  // Team plans: how many people (the owner included) share the plan's monthly credits.
  seats?: number;
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
  /*
   * Business: one owner pays and up to 5 people (the owner included) spend one shared monthly
   * pool. Credits per dollar are below Max's (13,500 / $99 = 136 per dollar vs Max's 140), so
   * its worst-case margin is at least Max's, monthly and yearly. Seats don't add credits.
   */
  {
    id: "business",
    name: "Business",
    priceCents: 9900,
    yearlyPriceCents: 7920,
    credits: 13500,
    blurb: "For teams: one bill, one shared credit pool",
    features: ["13,500 shared credits a month", "Up to 5 people, the owner included", "Owner invites and removes members", "Each member's projects stay private"],
    seats: 5,
  },
];

export type Interval = "month" | "year";
export const planPrice = (plan: Plan, interval: Interval) =>
  interval === "year" ? plan.yearlyPriceCents * 12 : plan.priceCents;

/*
 * Referrals. When a referred friend makes their first real payment, the friend gets
 * REFERRAL_FRIEND_SHARE more credits on top of it and the referrer gets REFERRAL_REFERRER_SHARE
 * of the credits bought, up to REFERRAL_REFERRER_CAP. For a plan, "credits bought" is one
 * month's credits, even when the first payment is yearly. test/pricing.test.ts checks that every
 * pack and plan, with both bonuses, still makes a profit if every credit is used.
 *
 * The friend's bonus is part of their own purchase and is taken back with it on a refund. The
 * referrer's bonus can't be taken back once spent, so it stays pending for
 * REFERRAL_PENDING_DAYS after the friend's payment and is cancelled if that payment is refunded
 * or disputed first: a refunded payment never pays for a referrer's credits.
 */
export const REFERRAL_PENDING_DAYS = 30;
export const REFERRAL_FRIEND_SHARE = 0.2;
export const REFERRAL_REFERRER_SHARE = 0.2;
export const REFERRAL_REFERRER_CAP = 2000;

export function referralBonus(credits: number) {
  return {
    friend: Math.round(credits * REFERRAL_FRIEND_SHARE),
    referrer: Math.min(REFERRAL_REFERRER_CAP, Math.round(credits * REFERRAL_REFERRER_SHARE)),
  };
}

// Stripe's card fee (2.9% + 30¢), plus 0.7% for Stripe Billing on subscriptions, 2% to convert
// US-dollar charges into the account's Canadian-dollar payouts, and 7¢ for Radar fraud screening.
export const paymentFeeCents = (amountCents: number, subscription: boolean) =>
  amountCents * ((subscription ? 0.036 : 0.029) + 0.02) + 30 + 7;

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

/** What reading the input once costs, in cents. Claude bills this even when a reply is stopped. */
export const readCostCents = (model: string, inputTokens: number) => (inputTokens * priceOf(model).input) / 1e6;

/** Worst-case input cost of one request, in cents (search re-reads its context per tool call). */
export function inputCostCents(engine: Engine, model: string, inputTokens: number): number {
  if (engine !== "search") return readCostCents(model, inputTokens);
  let tokens = inputTokens;
  for (let i = 1; i <= SEARCH_CALLS; i++) tokens += inputTokens + i * SEARCH_RESULT_TOKENS;
  return readCostCents(model, tokens) + 3 * WEB_SEARCH_CENTS;
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

/*
 * The companion (see companion.ts) answers in up to COMPANION_STEPS calls when it looks things
 * up, and each call re-reads everything before it plus what the last one wrote and found
 * (COMPANION_TOOL_TOKENS at most per step). It needs credits for one call and holds enough for
 * all of them when the user has them; it stops looking things up when the next call wouldn't fit.
 */
export const COMPANION_STEPS = 4;
export const COMPANION_MAX_TOKENS = 800;
export const COMPANION_TOOL_TOKENS = 2000;

/** Worst-case cost of one companion call, in cents. */
export const companionStepCents = (model: string, inputTokens: number) =>
  (inputTokens * priceOf(model).input + COMPANION_MAX_TOKENS * priceOf(model).output) / 1e6;

export function companionHold(model: string, inputTokens: number, available: number) {
  const needed = Math.ceil(companionStepCents(model, inputTokens) * MARKUP * SAFETY) + 1;
  let allCents = 0;
  for (let step = 0, tokens = inputTokens; step < COMPANION_STEPS; step++, tokens += COMPANION_MAX_TOKENS + COMPANION_TOOL_TOKENS) {
    allCents += companionStepCents(model, tokens);
  }
  const held = Math.max(needed, Math.min(Math.ceil(allCents * MARKUP * SAFETY) + 1, available));
  return { needed, held, capCents: held / MARKUP / SAFETY };
}

/*
 * What a request is finally charged, never more than was held. A finished request pays its
 * provider cost. A stopped Claude reply has no usage report, so it pays for reading the input
 * (Claude bills it in full) plus an estimate of what was written, and at least a typical reply.
 * A failed request pays only for provider work that really ran, so Flash never pays for it.
 */
export function finalCredits(r: {
  held: number;
  ok: boolean;
  stopped: boolean;
  // A Claude engine charged by length.
  metered: boolean;
  // What metered provider calls cost Flash, in cents.
  costCents: number;
  // What reading the input once costs (readCostCents), for a reply that never reported usage.
  inputCents: number;
  // Characters of reply already sent.
  written: number;
  typical: number;
}): number {
  if (r.held <= 0) return 0;
  // About 3 characters per token, doubled for thinking, at Opus's output price of 2,000¢ per million tokens.
  const writtenCents = (((r.written / 3) * 2 * 2000) / 1e6);
  if (!r.ok) {
    // A Claude call that already sent text was billed for its input and output too.
    const incurred = r.costCents + (r.metered && r.written > 0 ? r.inputCents + writtenCents : 0);
    return incurred > 0 ? Math.min(r.held, creditsFor(incurred)) : 0;
  }
  if (!r.metered) return r.held;
  if (r.stopped) {
    return Math.min(r.held, Math.max(r.typical, creditsFor(r.costCents + r.inputCents + writtenCents)));
  }
  return Math.min(r.held, creditsFor(r.costCents));
}
