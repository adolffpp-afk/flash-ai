import type { ChatTurn, Engine, StreamEvent } from "../types.ts";
import { system, type WritingMode } from "./claude.ts";
import { NO_SPEECH, type Media } from "./media.ts";
import { msg } from "../i18n.ts";
import { FriendlyError } from "./errors.ts";

/*
 * The free lane: models on providers' free tiers (mostly open-source), used when a user has run out of
 * credits. Flash pays nothing for these. Each provider has a daily cap set below its free limit
 * (checked 2026-10-02), so a free request can never turn into a bill. Providers are tried in
 * order; one that is busy or over its cap is skipped.
 */

export type FreeProvider = "groq" | "gemini" | "openrouter" | "cloudflare" | "mistral";

type ChatProvider = {
  id: FreeProvider;
  label: string;
  url: () => string;
  key: () => string | undefined;
  model: () => string;
  // Requests and tokens per day Flash allows itself on this provider (under the free limit).
  dailyRequests: number;
  dailyTokens: number;
  // The request and reply shape: OpenAI-style chat completions (the default), or Gemini's own.
  format?: "openai" | "gemini";
  // Whether to ask for token counts with stream_options (OpenAI-style providers that accept it).
  streamOptions?: boolean;
  // Whether the provider's terms let it answer someone in this country (a two-letter code, "" when unknown).
  serves?: (country: string) => boolean;
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

/*
 * Gemini's free tier may only answer people outside the European Economic Area, the UK and
 * Switzerland, in the countries where Google offers it, and not in apps for anyone under 18
 * (Gemini API Additional Terms, checked 2026-10-09). Google may use free-tier messages to improve
 * its products, and human reviewers may read them; Flash's privacy policy says so.
 */
const GEMINI_FREE_BLOCKED = new Set(
  [
    // The European Economic Area, then the UK and Switzerland.
    "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO",
    "GB CH",
    // Where Google doesn't offer the Gemini API.
    "CN HK MO RU BY IR KP SY CU",
  ]
    .join(" ")
    .split(" "),
);
// Unknown countries are left out: the free tier is only used where it's clearly allowed.
export const geminiFreeServes = (country: string) => /^[A-Z]{2}$/.test(country) && !GEMINI_FREE_BLOCKED.has(country);

const geminiModel = () => env("FLASH_FREE_GEMINI_MODEL") ?? "gemini-3.5-flash-lite";

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
    id: "gemini",
    label: "Gemini Flash-Lite",
    // Gemini's own endpoint: keys made in AI Studio since May 2026 don't always work on its OpenAI-style one.
    url: () => `${env("GEMINI_BASE_URL") ?? "https://generativelanguage.googleapis.com/v1beta"}/models/${geminiModel()}:streamGenerateContent?alt=sse`,
    key: () => env("GEMINI_API_KEY"),
    model: geminiModel,
    // 500 a day and 15 a minute on the free tier (AI Studio's rate limits page shows a project's own).
    dailyRequests: num("FLASH_GEMINI_DAILY_REQUESTS", 450),
    dailyTokens: Infinity,
    format: "gemini",
    serves: geminiFreeServes,
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
  /*
   * Mistral's free plan, the last backup (checked 2026-10-09). Its terms allow apps with real users,
   * but Mistral calls the free plan "intended for evaluation and prototyping" and may limit it, so it
   * only answers when the others are busy. Free requests may train Mistral's models unless training
   * is switched off in Mistral's admin panel (Privacy), which is done before the key is made. The
   * plan takes no card, so it can't bill; Flash stays far under its published limits (1 request a second).
   */
  {
    id: "mistral",
    label: "Mistral Small",
    url: () => `${env("MISTRAL_BASE_URL") ?? "https://api.mistral.ai/v1"}/chat/completions`,
    key: () => env("MISTRAL_API_KEY"),
    model: () => env("FLASH_FREE_MISTRAL_MODEL") ?? "mistral-small-latest",
    dailyRequests: num("FLASH_MISTRAL_DAILY_REQUESTS", 500),
    dailyTokens: num("FLASH_MISTRAL_DAILY_TOKENS", 2_000_000),
    // Mistral's API doesn't list stream_options, so it isn't sent; the last chunk carries the token counts.
    streamOptions: false,
  },
];

export const freeChatConfigured = () => CHAT_PROVIDERS.some((p) => p.key());
export const freeImageConfigured = () => Boolean(cloudflareKey());

// What each user gets per day once their credits run out.
export const FREE_DAILY_CHATS = num("FLASH_FREE_DAILY_CHATS", 25);
export const FREE_DAILY_IMAGES = num("FLASH_FREE_DAILY_IMAGES", 3);
export const FREE_DAILY_TRANSCRIPTS = num("FLASH_FREE_DAILY_TRANSCRIPTS", 3);
// Spoken turns a day in browsers that can't recognise speech (Firefox). Groq counts each as at least 10 seconds.
export const FREE_DAILY_VOICE_TURNS = num("FLASH_FREE_DAILY_VOICE_TURNS", 40);

// Groq's free tier limits Whisper by requests and seconds of audio a day (2,000 and 28,800 in
// the lowest figures published). Flash stops well below both; check the Groq console's limits page.
export const GROQ_AUDIO_DAILY_REQUESTS = num("FLASH_GROQ_AUDIO_DAILY_REQUESTS", 1500);
export const GROQ_AUDIO_DAILY_SECONDS = num("FLASH_GROQ_AUDIO_DAILY_SECONDS", 20000);
// Groq counts every request as at least 10 seconds.
export const MIN_AUDIO_SECONDS = 10;
// Formats Whisper on Groq reads.
const FREE_AUDIO_TYPE = /^(audio\/(mpeg|mp3|mp4|m4a|x-m4a|aac|wav|x-wav|wave|ogg|opus|webm|flac|x-flac)|video\/(mp4|webm|mpeg))$/;
export const freeTranscribeConfigured = () => Boolean(env("GROQ_API_KEY"));
// Free replies stay short so the daily token allowance goes further.
const FREE_MAX_TOKENS = 4000;

export const FREE_CHAT_ENGINES: Engine[] = ["text", "translate", "code", "docs"];

export type FreeLane = "chat" | "image" | "transcribe" | "voice";

/**
 * Whether a request can use the free lane: chat-style engines or images with no file or text
 * files, or transcribing one audio or video file.
 */
export function freeEligible(engine: Engine, last: ChatTurn): FreeLane | null {
  const a = last.attachment;
  if (engine === "transcribe") {
    return a && !last.more?.length && FREE_AUDIO_TYPE.test(a.mediaType) && freeTranscribeConfigured() ? "transcribe" : null;
  }
  const files = a ? [a, ...(last.more ?? [])] : [];
  if (files.some((f) => !f.mediaType.startsWith("text/") && f.mediaType !== "application/json")) return null;
  if (engine === "image" && !a) return freeImageConfigured() ? "image" : null;
  if (FREE_CHAT_ENGINES.includes(engine)) return freeChatConfigured() ? "chat" : null;
  return null;
}

type Message = { role: "system" | "user" | "assistant"; content: string };

/** The request body for a provider: OpenAI-style, or Gemini's contents with the system prompt apart. */
function requestBody(p: ChatProvider, messages: Message[]): string {
  if (p.format === "gemini") {
    const [first, ...rest] = messages;
    return JSON.stringify({
      systemInstruction: { parts: [{ text: first.content }] },
      contents: rest.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: FREE_MAX_TOKENS },
    });
  }
  return JSON.stringify({
    model: p.model(),
    messages,
    stream: true,
    max_tokens: FREE_MAX_TOKENS,
    ...(p.streamOptions !== false && { stream_options: { include_usage: true } }),
  });
}

const requestHeaders = (p: ChatProvider, key: string): Record<string, string> =>
  p.format === "gemini"
    ? { "x-goog-api-key": key, "Content-Type": "application/json" }
    : { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

type Chunk = { text: string; input?: number; output?: number };

/** The words and token counts in one streamed event, from either reply shape. */
function readChunk(p: ChatProvider, data: string): Chunk | null {
  try {
    if (p.format === "gemini") {
      const json = JSON.parse(data) as {
        candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
      };
      const parts = json.candidates?.[0]?.content?.parts ?? [];
      const usage = json.usageMetadata;
      return {
        // Thinking stays out of the answer.
        text: parts.filter((part) => !part.thought).map((part) => part.text ?? "").join(""),
        input: usage?.promptTokenCount,
        output: usage ? (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0) : undefined,
      };
    }
    const json = JSON.parse(data) as {
      choices?: { delta?: { content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
    };
    return { text: json.choices?.[0]?.delta?.content ?? "", input: json.usage?.prompt_tokens, output: json.usage?.completion_tokens };
  } catch {
    return null;
  }
}

function toMessages(history: ChatTurn[], preferences: string, mode: WritingMode, systemPrompt?: string): Message[] {
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
  return [{ role: "system", content: systemPrompt ?? system(preferences, mode) }, ...turns.filter((t) => t.content.trim())];
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
  // Replaces Flash's usual instructions, for the companion.
  systemPrompt?: string,
  // Where the user is (two letters, from the host), for providers that may only answer some countries.
  country = "",
): AsyncGenerator<StreamEvent> {
  const messages = toMessages(history, preferences, mode, systemPrompt);
  let lastError = "";
  for (const p of CHAT_PROVIDERS) {
    const key = p.key();
    if (!key) continue;
    if (p.serves && !p.serves(country.toUpperCase())) continue;
    if (!(await reserve(p.id, { requests: p.dailyRequests, tokens: p.dailyTokens }))) continue;
    let res: Response;
    try {
      res = await fetch(p.url(), {
        method: "POST",
        headers: requestHeaders(p, key),
        body: requestBody(p, messages),
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
        const chunk = readChunk(p, data);
        if (!chunk) continue;
        if (chunk.text) {
          chars += chunk.text.length;
          yield { type: "text", delta: chunk.text };
        }
        input = chunk.input ?? input;
        output = chunk.output ?? output;
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
      ? msg("The free models are busy right now. Please try again in a minute, or get more credits.")
      : msg("Today's free messages are used up across Flash. They reset tomorrow, or you can get more credits."),
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

/** Groq answered a free transcript with an error (status), so it didn't transcribe the file. */
export class FreeRefused extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** A transcript from Whisper on Groq's free tier, with the audio's length in seconds. */
export async function freeTranscribe(file: { name: string; mediaType: string; data: string }): Promise<{ text: string; seconds: number }> {
  const form = new FormData();
  form.append("model", env("FLASH_FREE_WHISPER_MODEL") ?? "whisper-large-v3-turbo");
  form.append("response_format", "verbose_json");
  form.append("file", new Blob([Buffer.from(file.data, "base64")], { type: file.mediaType }), file.name);
  const res = await fetch(`${env("GROQ_BASE_URL") ?? "https://api.groq.com/openai/v1"}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("GROQ_API_KEY")}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const json = (await res.json().catch(() => ({}))) as { text?: string; duration?: number; error?: { message?: string } };
  if (!res.ok) throw new FreeRefused(json.error?.message ?? `The free transcription model returned ${res.status}`, res.status);
  return { text: json.text?.trim() || NO_SPEECH, seconds: Math.max(MIN_AUDIO_SECONDS, Math.ceil(json.duration ?? 0)) };
}

/**
 * One spoken turn from Whisper large-v3 on Groq's free tier (more accurate than turbo, and as free),
 * with the length Groq counts. Whisper writes "Thank you." or "Merci." over silence; a stretch it
 * thinks has no speech and isn't sure of is dropped, as Whisper's own transcriber does.
 */
export async function freeHear(file: { name: string; mediaType: string; data: string }): Promise<{ text: string; seconds: number }> {
  const form = new FormData();
  form.append("model", env("FLASH_FREE_VOICE_MODEL") ?? "whisper-large-v3");
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  form.append("file", new Blob([Buffer.from(file.data, "base64")], { type: file.mediaType }), file.name);
  const res = await fetch(`${env("GROQ_BASE_URL") ?? "https://api.groq.com/openai/v1"}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("GROQ_API_KEY")}` },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  type Segment = { text?: string; no_speech_prob?: number; avg_logprob?: number };
  const json = (await res.json().catch(() => ({}))) as { text?: string; duration?: number; segments?: Segment[]; error?: { message?: string } };
  if (!res.ok) throw new FreeRefused(json.error?.message ?? `The free transcription model returned ${res.status}`, res.status);
  const silent = (s: Segment) => (s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -1;
  const text = json.segments ? json.segments.filter((s) => !silent(s)).map((s) => s.text ?? "").join("") : (json.text ?? "");
  return { text: text.trim(), seconds: Math.max(MIN_AUDIO_SECONDS, Math.ceil(json.duration ?? 0)) };
}
