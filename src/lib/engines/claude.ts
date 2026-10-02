import Anthropic from "@anthropic-ai/sdk";
import type { ChatTurn, Source, StreamEvent } from "../types.ts";

export const TEXT_MODEL = process.env.FLASH_TEXT_MODEL || "claude-opus-5-5";

const BASE_SYSTEM =
  "You are Flash, a helpful all-in-one AI assistant. Answer directly and clearly. " +
  "Use short paragraphs and Markdown lists or headings only when they help.";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

let client: Anthropic | null = null;
function getClient(): Anthropic {
  client ??= new Anthropic();
  return client;
}

export function claudeConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function toContent(turn: ChatTurn): string | Anthropic.Beta.BetaContentBlockParam[] {
  const a = turn.attachment;
  if (!a) return turn.content;
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  if ((IMAGE_TYPES as readonly string[]).includes(a.mediaType)) {
    blocks.push({ type: "image", source: { type: "base64", media_type: a.mediaType as ImageType, data: a.data } });
  } else if (a.mediaType === "application/pdf") {
    blocks.push({ type: "document", title: a.name, source: { type: "base64", media_type: "application/pdf", data: a.data } });
  } else {
    const text = Buffer.from(a.data, "base64").toString("utf8");
    blocks.push({ type: "document", title: a.name, source: { type: "text", media_type: "text/plain", data: text } });
  }
  blocks.push({ type: "text", text: turn.content || "Please look at this file." });
  return blocks;
}

function toMessages(history: ChatTurn[]): Anthropic.Beta.BetaMessageParam[] {
  return history
    .filter((t) => t.content.trim() || t.attachment)
    .map((t) => ({ role: t.role, content: t.role === "user" ? toContent(t) : t.content }));
}

function system(preferences: string): string {
  const prefs = preferences.trim();
  return prefs ? `${BASE_SYSTEM}\n\nWhat the user told Flash to remember about them:\n${prefs}` : BASE_SYSTEM;
}

function refusalMessage(): StreamEvent {
  return { type: "text", delta: "\n\nFlash couldn't help with that request." };
}

/** Writing, reasoning and file questions: streams Claude's reply token by token. */
export async function* streamText(history: ChatTurn[], preferences: string): AsyncGenerator<StreamEvent> {
  const stream = getClient().beta.messages.stream({
    model: TEXT_MODEL,
    max_tokens: 64000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium" },
    system: system(preferences),
    messages: toMessages(history),
  });
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield { type: "text", delta: event.delta.text };
    }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") yield refusalMessage();
}

/** Research: Claude with server-side web search, returning the answer and its sources. */
export async function* streamSearch(history: ChatTurn[], preferences: string): AsyncGenerator<StreamEvent> {
  const messages = toMessages(history);
  const sources = new Map<string, Source>();
  // pause_turn means the server paused a long search loop; resend to let it continue.
  for (let round = 0; round < 4; round++) {
    const stream = getClient().beta.messages.stream({
      model: TEXT_MODEL,
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: system(preferences) + "\n\nSearch the web for current facts and keep the answer concise.",
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
      messages,
    });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text", delta: event.delta.text };
      }
    }
    const final = await stream.finalMessage();
    for (const block of final.content) {
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content) {
          if (r.type === "web_search_result" && !sources.has(r.url)) {
            sources.set(r.url, { title: r.title, url: r.url });
          }
        }
      }
    }
    if (final.stop_reason === "refusal") {
      yield refusalMessage();
      break;
    }
    if (final.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: final.content });
  }
  if (sources.size) yield { type: "sources", items: [...sources.values()].slice(0, 8) };
}

/** Turns a short image request into a detailed prompt for the image model. */
export async function improveImagePrompt(request: string): Promise<string> {
  const res = await getClient().beta.messages.create({
    model: TEXT_MODEL,
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    system:
      "Rewrite the user's request as one vivid prompt for an image generator, under 80 words. " +
      "Reply with the prompt only.",
    messages: [{ role: "user", content: request }],
  });
  if (res.stop_reason === "refusal") return request;
  const text = res.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text");
  return text?.text.trim() || request;
}
