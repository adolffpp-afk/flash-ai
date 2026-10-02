import Anthropic from "@anthropic-ai/sdk";
import type { ChatTurn, Source, StreamEvent } from "../types.ts";

export const TEXT_MODEL = process.env.FLASH_TEXT_MODEL || "claude-opus-5-5";

const BASE_SYSTEM =
  "You are Flash, a helpful all-in-one AI assistant. Answer directly and clearly. " +
  "Use short paragraphs and Markdown lists or headings only when they help.";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

let client: Anthropic | null = null;
export function getClient(): Anthropic {
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

function assistantContent(t: ChatTurn): string {
  return t.app ? `${t.content}\n\n\`\`\`html\n${t.app}\n\`\`\`` : t.content;
}

export function toMessages(history: ChatTurn[]): Anthropic.Beta.BetaMessageParam[] {
  return history
    .filter((t) => t.content.trim() || t.attachment || t.app)
    .map((t) => ({ role: t.role, content: t.role === "user" ? toContent(t) : assistantContent(t) }));
}

export type WritingMode = "text" | "code" | "translate" | "docs";

const MODE_PROMPTS: Record<WritingMode, string> = {
  text: "",
  code:
    "You are acting as an expert software engineer. Give working, complete code in fenced code blocks " +
    "with the language named, then a short explanation. Point out bugs and edge cases.",
  translate:
    "You are acting as a professional translator. Give the translation first, keeping tone and meaning. " +
    "If the target language is unclear, translate into English. Add a short note only for idioms or ambiguity.",
  docs:
    "You are acting as a document and spreadsheet specialist. When the user wants a spreadsheet or table data, " +
    "return it as a fenced ```csv code block with a header row (the app turns it into a downloadable file), " +
    "plus a short Markdown table preview if it has 15 rows or fewer. When they want a document (letter, resume, " +
    "report, proposal), write it in full as a fenced ```markdown code block so it can be downloaded. " +
    "When analysing an attached file, lead with the key findings and the numbers behind them.",
};

function system(preferences: string, mode: WritingMode = "text"): string {
  const prefs = preferences.trim();
  const parts = [BASE_SYSTEM, MODE_PROMPTS[mode]];
  if (prefs) parts.push(`What the user told Flash to remember about them:\n${prefs}`);
  return parts.filter(Boolean).join("\n\n");
}

function refusalMessage(): StreamEvent {
  return { type: "text", delta: "\n\nFlash couldn't help with that request." };
}

/** Writing, code, translation, documents and file questions: streams Claude's reply token by token. */
export async function* streamText(
  history: ChatTurn[],
  preferences: string,
  mode: WritingMode = "text",
): AsyncGenerator<StreamEvent> {
  const stream = getClient().beta.messages.stream({
    model: TEXT_MODEL,
    max_tokens: 64000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: mode === "code" ? "high" : "medium" },
    system: system(preferences, mode),
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

/** Research: Claude with server-side web search and page reading, returning the answer and its sources. */
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
      system:
        system(preferences) +
        "\n\nSearch the web for current facts, read any page the user links, and keep the answer concise.",
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: 5 },
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: 3 },
      ],
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
      if (block.type === "web_fetch_tool_result" && block.content.type === "web_fetch_result") {
        const url = block.content.url;
        if (!sources.has(url)) sources.set(url, { title: block.content.content.title ?? url, url });
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

const PROMPT_REWRITERS = {
  image: "Rewrite the user's request as one vivid prompt for an image generator, under 80 words.",
  video:
    "Rewrite the user's request as one prompt for a text-to-video model, under 90 words: " +
    "the subject, the action, the camera movement, the lighting and the style.",
  music:
    "Rewrite the user's request as one prompt for a music generator, under 60 words: " +
    "genre, mood, tempo, instruments, and whether it has vocals.",
};

/** Turns a short media request into a detailed prompt for the image, video or music model. */
export async function improvePrompt(kind: keyof typeof PROMPT_REWRITERS, request: string): Promise<string> {
  const res = await getClient().beta.messages.create({
    model: TEXT_MODEL,
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    system: `${PROMPT_REWRITERS[kind]} Reply with the prompt only.`,
    messages: [{ role: "user", content: request }],
  });
  if (res.stop_reason === "refusal") return request;
  const text = res.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text");
  return text?.text.trim() || request;
}
