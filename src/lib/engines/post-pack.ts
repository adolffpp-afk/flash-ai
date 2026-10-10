import type Anthropic from "@anthropic-ai/sdk";
import { CHAT_MODEL, choiceParams, getClient, meterClaude, noMeter, type Meter } from "./claude.ts";
import { tokensAtMost } from "./companion.ts";
import { FriendlyError } from "./errors.ts";
import { msg } from "../i18n.ts";
import { callCost, claudePrice } from "../credits.ts";
import { PACK_VIDEO_SECONDS, PACK_WRITING_CENTS } from "../models.ts";
import { parsePack, type Pack } from "../post-pack.ts";

// Writing is held to its budget at no less than Opus's price, the dearest a chat request is
// answered at (Summit's model is only used when someone picks it).
export const DEAREST = claudePrice("claude-opus-5-5");

// Enough for three posts in any language; a shorter allowance than this can't fit them.
const MAX_PACK_TOKENS = 3000;
const MIN_PACK_TOKENS = 1000;
// Saved memory (2,000), project instructions (4,000) and the brand kit, with room to spare.
const MAX_ABOUT_CHARS = 8000;

/**
 * The most the writer may write so that reading inputTokens and writing stay within PACK_WRITING_CENTS,
 * even when the writer's model declines and its refusal fallback writes the posts: both are billed.
 */
export function packMaxTokens(inputTokens: number): number {
  const worst = callCost("text", CHAT_MODEL, inputTokens);
  const left = PACK_WRITING_CENTS - Math.max(worst.inputCents, (inputTokens * DEAREST.input) / 1e6);
  return Math.max(0, Math.min(MAX_PACK_TOKENS, Math.floor((left * 1e6) / Math.max(worst.outputPrice, DEAREST.output))));
}

/** The writer's instructions, with what Flash knows about the user (their brand kit included). */
export function packSystem(about: string): string {
  const parts = [
    "You write social media posts for small businesses and creators. From the user's request, write one post each " +
      "for Instagram, TikTok and Facebook, in the same language as the request (or the one the notes below ask Flash to " +
      "answer in), and describe one picture for all three.\n" +
      "- Instagram: a hook in the first line, 60 to 150 words, a few fitting emoji and a call to action; 8 to 15 hashtags.\n" +
      "- TikTok: one to three short, punchy lines, under 150 characters; 3 to 5 hashtags.\n" +
      "- Facebook: friendly and conversational, 40 to 120 words, with a clear call to action; 1 to 3 hashtags.\n" +
      "- Captions are plain text: no Markdown, no hashtags inside them. Use only facts the user gave (prices, dates, " +
      "places, offers, phone numbers) and never make any up; leave out what isn't given instead of writing placeholders.\n" +
      "- picture: a prompt for an image model, under 80 words, for an eye-catching photo or illustration that works " +
      "both square and tall, with the subject in the middle and space around it. No words or letters in the picture " +
      "unless the request asks for some; then at most five words, in quotes. Never draw a logo.\n" +
      `- motion: under 40 words, how that picture should move in a ${PACK_VIDEO_SECONDS} second silent video: a gentle ` +
      "camera move and natural motion of the subject.\n" +
      "When the request is for the user's own business, use their brand kit below: their business name, tone of voice, " +
      "and their colours in the picture.\n" +
      'Reply with JSON only, in this shape: {"posts":[{"platform":"Instagram","caption":"…","hashtags":["#…"]},' +
      '{"platform":"TikTok","caption":"…","hashtags":["#…"]},{"platform":"Facebook","caption":"…","hashtags":["#…"]}],' +
      '"picture":"…","motion":"…"}',
  ];
  const known = about.trim().slice(0, MAX_ABOUT_CHARS);
  if (known) parts.push(`What the user told Flash to remember about them:\n${known}`);
  return parts.join("\n\n");
}

/** How much the writer may write with this system prompt, counted by Claude (or estimated on the high side). */
async function allowance(system: string, messages: Anthropic.MessageParam[], request: string): Promise<number> {
  const counted = await getClient()
    .messages.countTokens({ model: CHAT_MODEL, system, messages })
    .then((r) => r.input_tokens)
    .catch(() => tokensAtMost(system + request) + 50);
  // A little room in case a fallback model reads the same text as more tokens.
  return packMaxTokens(Math.ceil(counted * 1.1) + 50);
}

/**
 * Writes a social post pack for the request: three posts, a picture prompt and a motion prompt.
 * about is everything Flash knows about the user; when that is too long to afford, only the brand
 * kit notes (brand) go with the request.
 */
export async function writePack(request: string, about: string, meter: Meter = noMeter, brand = ""): Promise<Pack> {
  const asked = request.slice(0, 2000);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: asked }];
  let system = packSystem(about);
  let maxTokens = await allowance(system, messages, asked);
  if (maxTokens < MIN_PACK_TOKENS && about.trim()) {
    system = packSystem(brand);
    maxTokens = await allowance(system, messages, asked);
  }
  if (maxTokens < MIN_PACK_TOKENS) {
    throw new FriendlyError(msg("This request is too long for a post pack. Shorten it and try again."));
  }
  const res = await getClient().beta.messages.create(
    {
      // A refusal fallback only where packMaxTokens counted one (see FALLBACKS in credits.ts).
      ...choiceParams({ level: "ascend", model: CHAT_MODEL, effort: "low" }),
      max_tokens: maxTokens,
      system,
      messages,
    },
    { timeout: 45_000, maxRetries: 0 },
  );
  meterClaude(meter, res, CHAT_MODEL);
  if (res.stop_reason === "refusal") throw new FriendlyError(msg("Flash can't make posts for that request."));
  const text = res.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")?.text ?? "";
  const pack = parsePack(text);
  if (!pack) throw new FriendlyError(msg("Flash couldn't write the posts this time. Please try again."));
  return { ...pack, picture: pack.picture || request.slice(0, 1500) };
}
