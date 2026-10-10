import type { Engine } from "./types.ts";
import { msg } from "./i18n.ts";

/*
 * How Flash prices requests.
 *
 * One credit is worth one US cent at the Starter pack price. Each request costs MARKUP times
 * what it costs Flash to run (the AI provider's bill), so every request makes a margin.
 * Provider prices below were checked on 2026-10-02; update them when providers change prices.
 */
export const MARKUP = Number(process.env.FLASH_MARKUP ?? 2.5);

export const creditsFor = (costCents: number) => Math.max(1, Math.ceil(costCents * MARKUP));

type Price = { input: number; output: number };

// Claude, in US cents per million tokens. Haiku 5.5 costs five times more once a prompt is over
// 100,000 tokens. Opus 5, Opus 4.8 and Sonnet 5 only answer as refusal fallbacks (see FALLBACKS
// below); their prices are from Anthropic's model list, checked on 2026-10-06.
export const CLAUDE_PRICES: Record<string, Price & { long?: Price & { over: number } }> = {
  "claude-fable-5-1": { input: 1000, output: 5000 },
  "claude-opus-5-5": { input: 400, output: 2000 },
  "claude-opus-5": { input: 500, output: 2500 },
  "claude-opus-4-8": { input: 500, output: 2500 },
  "claude-sonnet-5-5": { input: 200, output: 1000 },
  "claude-sonnet-5": { input: 200, output: 1000 },
  "claude-haiku-5-5": { input: 10, output: 50, long: { over: 100_000, input: 50, output: 250 } },
  "claude-haiku-4-5": { input: 100, output: 500 },
};

// A model missing from the list above is priced at the dearest rates on it, so a new or renamed
// model can never cost Flash more than it charges.
const ALL_PRICES = Object.values(CLAUDE_PRICES).flatMap((p) => (p.long ? [p, p.long] : [p]));
const DEAREST_PRICE: Price = {
  input: Math.max(...ALL_PRICES.map((p) => p.input)),
  output: Math.max(...ALL_PRICES.map((p) => p.output)),
};

/** A model's price for a prompt of this many tokens. Unknown models are priced at the dearest rates. */
export function claudePrice(model: string, promptTokens = 0): Price {
  if (!Object.hasOwn(CLAUDE_PRICES, model)) return DEAREST_PRICE;
  const price = CLAUDE_PRICES[model];
  return price.long && promptTokens > price.long.over ? price.long : price;
}
export const WEB_SEARCH_CENTS = 1;

/*
 * A token is never shorter than a byte, and one character of a JavaScript string is at most three
 * bytes of UTF-8, so a text of n characters is at most 3n tokens, whatever its language. Holds that
 * must cover any text use this instead of a typical rate.
 */
export const worstTokens = (chars: number) => chars * 3;
// Room for what wraps the system prompt and messages of a call.
const FRAMING_TOKENS = 100;

/** The most a call can cost, in cents, when it reads at most inputChars characters and writes at most maxTokens. */
export function callMaxCents(model: string, inputChars: number, maxTokens: number): number {
  const tokens = worstTokens(inputChars) + FRAMING_TOKENS;
  const price = claudePrice(model, tokens);
  return (tokens * price.input + maxTokens * price.output) / 1e6;
}

/** The tokens one attempt of a call used, as Claude reports each attempt in usage.iterations. */
export type ClaudeAttempt = {
  model?: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

export type ClaudeUsage = ClaudeAttempt & {
  server_tool_use?: { web_search_requests?: number | null } | null;
  // Every attempt of the call. The rest of the usage counts only the attempt that answered, so a
  // reply one model declined and its refusal fallback answered is only priced in full from these.
  iterations?: ClaudeAttempt[] | null;
};

/** What reading and writing these tokens cost on a model, in cents. */
function tokenCents(model: string, used: ClaudeAttempt): number {
  const prompt = used.input_tokens + (used.cache_creation_input_tokens ?? 0) + (used.cache_read_input_tokens ?? 0);
  const price = claudePrice(model, prompt);
  const input = used.input_tokens + (used.cache_creation_input_tokens ?? 0) * 1.25 + (used.cache_read_input_tokens ?? 0) * 0.1;
  return (input * price.input + used.output_tokens * price.output) / 1e6;
}

/**
 * What one Claude call cost Flash, in cents: every attempt at its own model's price, plus web
 * searches. model is the model that answered; requested is the one asked for, which prices an
 * attempt that doesn't name its model when it is the dearer of the two. Unknown models are priced
 * at the dearest rates. searched is the searches that returned results in the reply, which counts
 * a declined attempt's too (the usage only counts the attempt that answered).
 */
export function claudeCostCents(model: string, usage: ClaudeUsage, requested = model, searched = 0): number {
  const searches = Math.max(usage.server_tool_use?.web_search_requests ?? 0, searched) * WEB_SEARCH_CENTS;
  const answered = tokenCents(model, usage);
  const attempts = usage.iterations ?? [];
  if (!attempts.length) return answered + searches;
  const unnamed = claudePrice(requested).output > claudePrice(model).output ? requested : model;
  const all = attempts.reduce((sum, a) => sum + tokenCents(a.model || unnamed, a), 0);
  return Math.max(all, answered) + searches;
}

/*
 * Refusal fallbacks. When a model declines a request on safety grounds, Claude can answer it on
 * another model inside the same call, and both attempts are billed: the declined one for what it
 * read and wrote before it stopped, and the fallback for reading everything again, with the declined
 * words, and writing its own reply. Only the models listed here get a fallback (see choiceParams in
 * engines/claude.ts), each with the dearest model it can fall back to, and a request only gets one
 * when its hold pays for both attempts (see planHold). Opus 5.5 falls back to Opus 5 and Opus 4.8,
 * which cost more than it does, so it gets none; Haiku has no fallback.
 */
export const FALLBACKS: Record<string, string> = {
  "claude-sonnet-5-5": "claude-sonnet-5",
  // Opus 4.8 or Opus 5, which cost the same.
  "claude-fable-5-1": "claude-opus-5",
};

/** The model a model falls back to when it declines, or undefined when it has none. */
export const fallbackModel = (model: string): string | undefined => (Object.hasOwn(FALLBACKS, model) ? FALLBACKS[model] : undefined);

/*
 * Helper allowances. Before a priced job (a picture, video, track or speech) Flash may ask Haiku about
 * the request: the router or the picture check (never both: the router only reads messages without a
 * file, the check only messages with a picture), and for a new picture, video or track the prompt
 * writer too. A job's price includes the most these can cost, so the price listed is the price held
 * and charged, whether or not they ran, and never less than they cost. test/helper-costs.test.ts
 * checks that each helper's most stays within its allowance.
 */
export const CHECK_ALLOWANCE_CENTS = 0.06;
export const WRITER_ALLOWANCE_CENTS = 0.12;

// ElevenLabs voice and transcription, in cents. Both are priced at the dearer of the two ways Flash
// reaches them: fal.ai's Turbo v2.5 voice ($0.05 per 1,000 characters, ElevenLabs direct is about
// $0.022) and fal.ai's Scribe v2 ($0.008 a minute, ElevenLabs direct is $0.40 an hour).
export const voiceCostCents = (characters: number) => (characters / 1000) * 5;
// Voice reads at most this many characters, and is priced on the same text.
export const MAX_SPEECH_CHARS = 10000;
/** Credits for reading this many characters aloud: the voice, and the router that may have picked it. */
export const voiceCredits = (characters: number) => creditsFor(voiceCostCents(characters) + CHECK_ALLOWANCE_CENTS);

/*
 * Transcription is billed per minute of audio, at Scribe's $0.008 a minute. Opus, AAC and FLAC can
 * hold an hour of quiet in under a megabyte, so a recording is priced on its seconds, the longer of
 * what it plays and what it says it lasts (see server/audio-length.ts, which reads Opus, Vorbis,
 * MP3, AAC, FLAC and WAV; files it can't read aren't transcribed). Every file is also priced as at
 * least the longest recording its size holds at 8 kbps (1,000 bytes a second, below common speech
 * codecs): a 3 MB file pays for 52 minutes, and a normal 128 kbps MP3 pays for more than it uses.
 */
const TRANSCRIBE_CENTS_PER_MINUTE = 0.8;
const MIN_AUDIO_BYTES_PER_SECOND = 1000;
export const transcribeCostCents = (bytes: number, seconds = 0) =>
  Math.max(1, (Math.max(bytes / MIN_AUDIO_BYTES_PER_SECOND, seconds) / 60) * TRANSCRIBE_CENTS_PER_MINUTE);

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

// Blurbs and features are marked msg("…") and shown in the user's language with t(…); names stay as they are.
export type CreditPack = { id: string; name: string; credits: number; priceCents: number; blurb: string };

// One-off top-ups. Plans give more credits per dollar, like Lovable's and Emergent's.
export const CREDIT_PACKS: CreditPack[] = [
  { id: "starter", name: "Starter", credits: 500, priceCents: 500, blurb: msg("About 120 chats or 4 apps") },
  { id: "creator", name: "Creator", credits: 2200, priceCents: 2000, blurb: msg("Apps, slides and research for a busy week") },
  { id: "studio", name: "Studio", credits: 5800, priceCents: 5000, blurb: msg("Heavy app building") },
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
    blurb: msg("For makers who build every week"),
    features: [msg("3,000 credits a month"), msg("About 25 apps or 700 chats"), msg("Writing, research, code, apps and slides"), msg("Unused credits carry over")],
  },
  {
    id: "power",
    name: "Power",
    priceCents: 5000,
    yearlyPriceCents: 4000,
    credits: 6500,
    blurb: msg("For daily building and research"),
    features: [msg("6,500 credits a month"), msg("About 55 apps or 1,600 chats"), msg("Writing, research, code, apps and slides"), msg("Unused credits carry over")],
  },
  {
    id: "max",
    name: "Max",
    priceCents: 20000,
    yearlyPriceCents: 16000,
    credits: 28000,
    blurb: msg("For studios and heavy app building"),
    features: [msg("28,000 credits a month"), msg("About 230 apps or 7,000 chats"), msg("Writing, research, code, apps and slides"), msg("Unused credits carry over")],
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
    blurb: msg("For teams: one bill, one shared credit pool"),
    features: [msg("13,500 shared credits a month"), msg("Up to 5 people, the owner included"), msg("Owner invites and removes members"), msg("Each member's projects stay private")],
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
 * so Flash never loses money on a long answer. Refusal fallbacks are counted in full (see
 * callCost), and SAFETY leaves a margin on top, for a fallback that reads the same text as more tokens.
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

/** What reading the input once costs, in cents. Claude bills this even when a reply is stopped. */
export const readCostCents = (model: string, inputTokens: number) => (inputTokens * claudePrice(model, inputTokens).input) / 1e6;

/** Worst-case input cost of one request, in cents (search re-reads its context per tool call). */
export function inputCostCents(engine: Engine, model: string, inputTokens: number): number {
  if (engine !== "search") return readCostCents(model, inputTokens);
  let tokens = inputTokens;
  for (let i = 1; i <= SEARCH_CALLS; i++) tokens += inputTokens + i * SEARCH_RESULT_TOKENS;
  return readCostCents(model, tokens) + 3 * WEB_SEARCH_CENTS;
}

/**
 * The most a Claude call can cost, in two parts: reading its input once per step (inputCents) and
 * each token it writes (outputPrice, in cents per million). With a refusal fallback both attempts
 * are counted: each reads the input and may write up to the token limit, and the fallback rereads
 * what the declined model wrote (research at every search step).
 */
export function callCost(engine: Engine, model: string, inputTokens: number, fallback = true) {
  let inputCents = inputCostCents(engine, model, inputTokens);
  let outputPrice = claudePrice(model, inputTokens).output;
  const backup = fallback ? fallbackModel(model) : undefined;
  if (backup) {
    const price = claudePrice(backup, inputTokens);
    inputCents += inputCostCents(engine, backup, inputTokens);
    outputPrice += price.output + price.input * (engine === "search" ? SEARCH_CALLS + 1 : 1);
  }
  return { inputCents, outputPrice, fallback: Boolean(backup) };
}

/** Most output tokens a call can write while costing no more than `cents` in all, its fallback included. */
export function tokensWithin(engine: Engine, model: string, inputTokens: number, cents: number, fallback = true): number {
  const cost = callCost(engine, model, inputTokens, fallback);
  return Math.min(MAX_OUTPUT_TOKENS, Math.floor(((cents - cost.inputCents) * 1e6) / cost.outputPrice));
}

/**
 * How many credits a Claude request needs at least, and how many to hold. Long conversations
 * cost more to read, so the hold grows with the input on top of the engine's reply allowance.
 * scale grows that allowance for a level whose model costs more than the engine's usual one, so
 * a Summit reply has room for as many words as a Vision or Ascend one. spentCents is what helper
 * calls for this request (the router) already cost, which the hold pays for too. byCredits says
 * the user's balance, not the engine's allowance, set how long the reply may be.
 *
 * A model with a refusal fallback gets it only when the user has the credits to hold for both
 * attempts at the full length the reply would have without one, so a fallback never makes a reply
 * shorter, and more credits never give a shorter reply. Otherwise the request runs without one.
 */
export function planHold(engine: Engine, model: string, inputTokens: number, available: number, scale = 1, spentCents = 0) {
  const alone = (() => {
    const cost = callCost(engine, model, inputTokens, false);
    const fixedCents = cost.inputCents + spentCents;
    const minOutputCents = ((MIN_OUTPUT_TOKENS[engine] ?? 1500) * cost.outputPrice) / 1e6;
    const needed = Math.ceil((fixedCents + minOutputCents) * MARKUP * SAFETY) + 1;
    const limit = Math.ceil(fixedCents * MARKUP * SAFETY) + Math.ceil((CREDIT_LIMITS[engine] ?? 30) * Math.max(1, scale));
    const held = Math.max(needed, Math.min(limit, available));
    // What the reply itself may spend, after the helpers.
    const capCents = held / MARKUP / SAFETY - spentCents;
    const maxTokens = tokensWithin(engine, model, inputTokens, capCents, false);
    return { needed, held, maxTokens, capCents, fallback: false, byCredits: held < limit && maxTokens < MAX_OUTPUT_TOKENS };
  })();
  if (!fallbackModel(model)) return alone;
  // Both attempts, each writing as much as the reply alone may.
  const both = callCost(engine, model, inputTokens, true);
  const held = Math.ceil((both.inputCents + spentCents + (alone.maxTokens * both.outputPrice) / 1e6) * MARKUP * SAFETY) + 1;
  if (alone.byCredits || available < held) return alone;
  return { ...alone, held, capCents: held / MARKUP / SAFETY - spentCents, fallback: true };
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
  (inputTokens * claudePrice(model, inputTokens).input + COMPANION_MAX_TOKENS * claudePrice(model, inputTokens).output) / 1e6;

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
 * provider cost. A stopped Claude reply has no usage report, so it pays for what the call in
 * progress had cost so far (estimated from its stream, see Running in engines/claude.ts), and at
 * least a typical reply. A failed request pays only for provider work that really ran, so Flash
 * never pays for it.
 *
 * A priced job (a picture, video, track, speech or transcript) pays its listed price, which includes
 * its Claude helpers (see CHECK_ALLOWANCE_CENTS). Stopped or closed, it pays for the provider jobs
 * already sent, which the provider bills whether or not anyone waits for them, and the helpers that
 * ran: nothing at all when no provider was called.
 */
export function finalCredits(r: {
  held: number;
  ok: boolean;
  stopped: boolean;
  // A Claude engine charged by length.
  metered: boolean;
  // What metered provider calls cost Flash, in cents.
  costCents: number;
  // What the Claude call in progress had cost when the reply stopped or failed, from its stream:
  // 0 when Claude never started it, since Claude bills nothing then.
  pendingCents?: number;
  // Without pendingCents (the companion): what reading the input once costs (readCostCents), and the
  // characters of reply already sent at the model's output price (Opus's by default).
  inputCents?: number;
  written?: number;
  outputPrice?: number;
  typical: number;
  // A priced job: the credits it is priced at as it was made (its listed price, or less for a movie
  // filmed with fewer scenes), and in cents what Claude helpers cost for it and the provider jobs
  // already sent. Without it, a finished job that isn't metered pays everything held.
  priced?: { credits: number; helperCents: number; startedCents: number };
}): number {
  if (r.held <= 0) return 0;
  const written = r.written ?? 0;
  // Without an estimate from the stream: about 3 characters per token, doubled for thinking.
  const writtenCents = ((written / 3) * 2 * (r.outputPrice ?? 2000)) / 1e6;
  if (!r.ok) {
    // A Claude call that had started was billed for what it read and wrote before it failed.
    const pending = r.pendingCents ?? (written > 0 ? (r.inputCents ?? 0) + writtenCents : 0);
    const incurred = r.costCents + (r.metered ? pending : 0);
    return incurred > 0 ? Math.min(r.held, creditsFor(incurred)) : 0;
  }
  if (!r.metered) {
    if (!r.priced) return r.held;
    const { credits, helperCents, startedCents } = r.priced;
    if (!r.stopped) return Math.min(r.held, credits);
    // Jobs are metered when they finish, so one still running counts from when it was sent.
    const incurred = helperCents + Math.max(startedCents, r.costCents - helperCents);
    return incurred > 0 ? Math.min(r.held, creditsFor(incurred)) : 0;
  }
  if (r.stopped) {
    const pending = r.pendingCents ?? (r.inputCents ?? 0) + writtenCents;
    return Math.min(r.held, Math.max(r.typical, creditsFor(r.costCents + pending)));
  }
  return Math.min(r.held, creditsFor(r.costCents));
}
