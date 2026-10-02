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

export const CREDIT_PACKS: CreditPack[] = [
  { id: "starter", name: "Starter", credits: 500, priceCents: 500, blurb: "About 120 chats or 4 apps" },
  { id: "creator", name: "Creator", credits: 2500, priceCents: 2000, blurb: "Apps, images and music every week" },
  { id: "studio", name: "Studio", credits: 7500, priceCents: 5000, blurb: "Heavy app building and video" },
];
