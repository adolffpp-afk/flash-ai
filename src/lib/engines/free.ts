import type { ChatTurn, Engine, StreamEvent } from "../types.ts";
import { system, type WritingMode } from "./claude.ts";
import type { Media } from "./media.ts";
import { FriendlyError } from "./errors.ts";

/*
 * The free lane: open-source models on providers' free tiers, used when a user has run out of
 * credits. Flash pays nothing for these. Each provider has a daily cap set below its free limit
 * (checked 2026-10-02), so a free request can never turn into a bill. Providers are tried in
 * order; one that is busy or over its cap is skipped.
 */

export type FreeProvider = "groq" | "openrouter" | "cloudflare";

type ChatProvider = {
  id: FreeProvider;
  label: string;
  url: () => string;
  key: () => string | undefined;
  model: () => string;
  // Requests and tokens per day Flash allows itself on this provider (under the free limit).
  dailyRequests: number;
  dailyTokens: number;
};

const env = (name: string) => process.env[name] || undefined;
const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

const cloudflareBase = () =>
  env("CLOUDFLARE_BASE_URL") ?? `https://api.cloudflare.com/client/v4/accounts/${env("CLOUDFLARE_ACCOUNT_ID")}`;
const cloudflareKey = () => (env("CLOUDFLARE_ACCOUNT_ID") || env("CLOUDFLARE_BASE_URL") ? env("CLOUDFLARE_API_TOKEN") : undefined);

// Cloudflare bills in neurons; 10,000 a day are free. Flash stops at 9,000.
export const CLOUDFLARE_DAILY_NEURONS = num("FLASH_CLOUDFLARE_DAILY_NEURONS", 9000);
// FLUX.1 schnell at 4 steps, 1024x1024: 4 tiles x 4.8 + 4 steps x 9.6 neurons.
export const FLUX_SCHNELL_NEURONS = 4 * 4.8 + 4 * 9.6;
// gpt-oss-120b on Cloudflare, neurons per token.
const CF_CHAT_NEURONS = { input: 31818 / 1e6, output: 68182 / 1e6 };
export const cloudflareChatNeurons = (input: number, output: number) =>
  input * CF_CHAT_NEURONS.input + output * CF_CHAT_NEURONS.output;

export const CHAT_PROVIDERS: ChatProvider[] = [
  {
    id: "groq",
    label: "GPT-OSS 120B",
    url: () => `${env("GROQ_BASE_URL") ?? "https://api.groq.com/openai/v1"}/chat/completions`,
    key: () => env("GROQ_API_KEY"),
    model: () => env("FLASH_FREE_GROQ_MODEL") ?? "openai/gpt-oss-120b",
    dailyRequests: num("FLASH_GROQ_DAILY_REQUESTS", 900),
    dailyTokens: num("FLASH_GROQ_DAILY_TOKENS", 180000),
  },
  {
    id: "openrouter",
    label: "Llama 3.3 70B",
    url: () => `${env("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1"}/chat/completions`,
    key: () => env("OPENROUTER_API_KEY"),
    model: () => env("FLASH_FREE_OPENROUTER_MODEL") ?? "meta-llama/llama-3.3-70b-instruct:free",
    // 50 a day on a free account; set FLASH_OPENROUTER_DAILY_REQUESTS=950 after a $10 top-up.
    dailyRequests: num("FLASH_OPENROUTER_DAILY_REQUESTS", 45),
    dailyTokens: Infinity,
  },
  {
    id: "cloudflare",
    label: "GPT-OSS 120B",
    url: () => `${cloudflareBase()}/ai/v1/chat/completions`,
    key: cloudflareKey,
    model: () => env("FLASH_FREE_CLOUDFLARE_MODEL") ?? "@cf/openai/gpt-oss-120b",
    dailyRequests: Infinity,
    dailyTokens: Infinity,
  },
];

export const freeChatConfigured = () => CHAT_PROVIDERS.some((p) => p.key());
export const freeImageConfigured = () => Boolean(cloudflareKey());

// What each user gets per day once their credits run out.
export const FREE_DAILY_CHATS = num("FLASH_FREE_DAILY_CHATS", 25);
export const FREE_DAILY_IMAGES = num("FLASH_FREE_DAILY_IMAGES", 3);
// Free replies stay short so the daily token allowance goes further.
const FREE_MAX_TOKENS = 4000;

export const FREE_CHAT_ENGINES: Engine[] = ["text", "translate", "code", "docs"];

/** Whether a request can use the free lane: chat-style engines or images, with no file or a text file. */
export function freeEligible(engine: Engine, last: ChatTurn): "chat" | "image" | null {
  const a = last.attachment;
  const files = a ? [a, ...(last.more ?? [])] : [];
  if (files.some((f) => !f.mediaType.startsWith("text/") && f.mediaType !== "application/json")) return null;
  if (engine === "image" && !a) return freeImageConfigured() ? "image" : null;
  if (FREE_CHAT_ENGINES.includes(engine)) return freeChatConfigured() ? "chat" : null;
  return null;
}

type Message = { role: "system" | "user" | "assistant"; content: string };

function toMessages(history: ChatTurn[], preferences: string, mode: WritingMode): Message[] {
  const turns = history.slice(-10).map((t): Message => {
    let content = t.content;
    if (t.attachment) {
      const files = [t.attachment, ...(t.more ?? [])];
      // The free models read less, so several files share the same room as one.
      const room = Math.floor(20000 / files.length);
      const texts = files.map((f) => `File "${f.name}":\n${Buffer.from(f.data, "base64").toString("utf8").slice(0, room)}`);
      content = `${texts.join("\n\n")}\n\n${content || (files.length > 1 ? "Please look at these files." : "Please look at this file.")}`;
    }
    if (t.app) content += "\n\n(An app was built here.)";
    return { role: t.role, content: content.slice(0, 24000) };
  });
  return [{ role: "system", content: system(preferences, mode) }, ...turns.filter((t) => t.content.trim())];
}

/** Gate that reserves a provider for one request, or says no when it is over its daily cap. */
export type Reserve = (provider: FreeProvider, limits: { requests: number; tokens: number }) => Promise<boolean>;
/** Records what a free request used: tokens, and Cloudflare neurons. */
export type RecordUse = (provider: FreeProvider, tokens: number, neurons: number) => Promise<void>;

/** Streams a reply from the first free provider that is configured, under its cap, and answers. */
export async function* streamFreeChat(
  history: ChatTurn[],
  preferences: string,
  mode: WritingMode,
  reserve: Reserve,
  record: RecordUse,
  onModel: (label: string, provider: FreeProvider) => void,
): AsyncGenerator<StreamEvent> {
  const messages = toMessages(history, preferences, mode);
  let lastError = "";
  for (const p of CHAT_PROVIDERS) {
    const key = p.key();
    if (!key) continue;
    if (!(await reserve(p.id, { requests: p.dailyRequests, tokens: p.dailyTokens }))) continue;
    let res: Response;
    try {
      res = await fetch(p.url(), {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: p.model(),
          messages,
          stream: true,
          max_tokens: FREE_MAX_TOKENS,
          stream_options: { include_usage: true },
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (!res.ok || !res.body) {
      // Busy or over the provider's own limit: try the next one.
      lastError = `${p.id} returned ${res.status}`;
      await res.body?.cancel().catch(() => {});
      continue;
    }
    onModel(p.label, p.id);
    let input = 0;
    let output = 0;
    let chars = 0;
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const data = line.trim().replace(/^data:\s*/, "");
        if (!data || data === "[DONE]" || !line.trim().startsWith("data:")) continue;
        let json: {
          choices?: { delta?: { content?: string | null } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
        };
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          chars += delta.length;
          yield { type: "text", delta };
        }
        if (json.usage) {
          input = json.usage.prompt_tokens ?? input;
          output = json.usage.completion_tokens ?? output;
        }
      }
    }
    // Without a usage report, estimate on the high side.
    if (!input) input = Math.ceil(JSON.stringify(messages).length / 3);
    if (!output) output = Math.ceil(chars / 2);
    await record(p.id, input + output, p.id === "cloudflare" ? cloudflareChatNeurons(input, output) : 0);
    return;
  }
  throw new FriendlyError(
    lastError
      ? "The free models are busy right now. Please try again in a minute, or get more credits."
      : "Today's free messages are used up across Flash. They reset tomorrow, or you can get more credits.",
  );
}

/** One image from FLUX.1 schnell on Cloudflare's free allocation. */
export async function freeImage(prompt: string): Promise<Media> {
  const res = await fetch(`${cloudflareBase()}/ai/run/@cf/black-forest-labs/flux-1-schnell`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cloudflareKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: prompt.slice(0, 2048), steps: 4 }),
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await res.json().catch(() => ({}))) as { result?: { image?: string }; errors?: { message?: string }[] };
  if (!res.ok || !json.result?.image) {
    throw new Error(json.errors?.[0]?.message ?? `The free image model returned ${res.status}`);
  }
  return { data: Buffer.from(json.result.image, "base64"), mime: "image/jpeg" };
}
