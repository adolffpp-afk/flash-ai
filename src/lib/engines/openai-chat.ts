import { createHash } from "node:crypto";
import type { Attachment, ChatTurn, Engine, StreamEvent } from "../types.ts";
import { GPT_PICKS, type GptPick } from "../levels.ts";
import { MAX_OUTPUT_TOKENS, claudeCostCents, tokensMaxCents } from "../credits.ts";
import { english, msg, type Translate } from "../i18n.ts";
import { PASSAGE_CONTEXT } from "../assistant-prompt.ts";
import { FriendlyError } from "./errors.ts";
import { openaiConfigured } from "./media.ts";
import { NO_BUDGET, lengthNote, noMeter, refusalMessage, system, type Budget, type Meter, type SystemOptions, type Watch, type WritingMode } from "./claude.ts";

/*
 * ChatGPT in Flash: OpenAI's GPT models answer Write, Code, Translate and Docs & Sheets when the user
 * picks one in the Intelligence menu (see GPT_PICKS in levels.ts). They are called straight through
 * OpenAI's Responses API with the key Flash already has for pictures (OPENAI_API_KEY), and priced like
 * Claude: held before the reply, metered from what OpenAI reports, at cost × MARKUP (the prices are in
 * CLAUDE_PRICES in credits.ts). A reply on them has no tools: Research, apps and slides, the live
 * forecast, SEC EDGAR and FRED, connected accounts and assistants stay on Claude (see the chat route).
 */

// OPENAI_BASE_URL points it elsewhere (tests use a stand-in), as for pictures (see media.ts).
const OPENAI = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

/** The OpenAI model behind each pick. */
export const GPT_MODELS: Record<GptPick, string> = {
  "gpt-sol": "gpt-6.1-sol",
  "gpt-luna": "gpt-6-luna",
};

/** The engines a ChatGPT model answers: the ones that write words with no tools of their own. */
export const GPT_ENGINES: readonly Engine[] = ["text", "code", "translate", "docs"];

export const gptConfigured = openaiConfigured;

type GptEffort = "low" | "medium" | "high";

/**
 * The model and effort one ChatGPT reply runs on, the tokens it reads (counted before it is sent, for
 * the Stop estimate), a hashed account id OpenAI may use to spot abuse (its safety_identifier), and
 * whether Auto chose the model rather than the user (see AUTO_GPT in levels.ts).
 */
export type GptChoice = { level: GptPick; model: string; effort: GptEffort; inputTokens: number; safetyId?: string; auto?: boolean };

/**
 * What a pick runs on for an engine. Luna answers at low effort for speed, at medium when the request
 * has numbers to get right (needsCare in levels.ts), as Sonic does; Sol thinks harder for code, as the
 * Claude levels do. (Sol can't run without thinking: its lowest effort is low.)
 */
export function gptChoice(engine: Engine, pick: GptPick, { careful = false, auto = false }: { careful?: boolean; auto?: boolean } = {}): Omit<GptChoice, "inputTokens"> {
  const effort: GptEffort = pick === "gpt-luna" ? (careful ? "medium" : "low") : engine === "code" ? "high" : "medium";
  return { level: pick, model: GPT_MODELS[pick], effort, ...(auto && { auto }) };
}

/**
 * Whether a ChatGPT model costs at most half as much as a Claude model for a reply that reads
 * inputTokens and writes outputTokens: when Auto moves a request to its level's peer (see AUTO_GPT
 * in levels.ts). The Claude count stands in for OpenAI's, which is only made once Auto moves.
 */
export const muchCheaper = (gptModel: string, claudeModel: string, inputTokens: number, outputTokens: number) =>
  2 * tokensMaxCents(gptModel, inputTokens, outputTokens) <= tokensMaxCents(claudeModel, inputTokens, outputTokens);

/** A stable id for an account that tells OpenAI nothing about who it is. */
export const safetyId = (userId: string) => createHash("sha256").update(`flash:${userId}`).digest("hex").slice(0, 32);

/*
 * ChatGPT writes at most about this many tokens a second, so a reply stopped or failed while it thinks
 * (which its stream doesn't show) is charged as if it had thought this fast, up to max_output_tokens
 * (see Running in claude.ts). Luna is the faster of the two.
 */
const PEAK_TOKENS_PER_SECOND: Record<string, number> = { "gpt-6.1-sol": 200, "gpt-6-luna": 400 };
const peakOf = (model: string) => PEAK_TOKENS_PER_SECOND[model] ?? 400;

/** The system prompt a ChatGPT reply sends: Flash's own for the mode, and which model answers, picked by the user or by Auto. */
export function gptInstructions(base: string, pick: GptPick, auto = false): string {
  const name = GPT_PICKS.find((g) => g.id === pick)!.name;
  const chosen = auto ? "which Flash's Auto chose for this request" : "which the user picked in Flash";
  return `${base}\n\nThis answer is written by OpenAI's ${name} model, ${chosen}. If they ask which AI answered, say so.`;
}

type InputContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "auto" }
  | { type: "input_file"; filename: string; file_data: string };
type InputItem = { role: "user" | "assistant"; content: string | InputContent[] };

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** A file as OpenAI reads it: a picture, a PDF, or any other file as its text. */
function fileContent(a: Attachment): InputContent {
  if (IMAGE_TYPES.includes(a.mediaType)) return { type: "input_image", image_url: `data:${a.mediaType};base64,${a.data}`, detail: "auto" };
  if (a.mediaType === "application/pdf") return { type: "input_file", filename: a.name || "file.pdf", file_data: `data:application/pdf;base64,${a.data}` };
  return { type: "input_text", text: `File: ${a.name}\n\n${Buffer.from(a.data, "base64").toString("utf8")}` };
}

/** A user turn's content: their files, then any assistant passages, then what they wrote (as for Claude, see toContent in claude.ts). */
function userContent(turn: ChatTurn): string | InputContent[] {
  const passages: InputContent[] = (turn.passages ?? []).map((p) => ({ type: "input_text", text: `${p.title}\n${PASSAGE_CONTEXT}\n\n${p.text}` }));
  if (!turn.attachment) return passages.length ? [...passages, ...(turn.content ? [{ type: "input_text" as const, text: turn.content }] : [])] : turn.content;
  const files = [turn.attachment, ...(turn.more ?? [])];
  const named = files.length > 1 ? `Attached files, in order: ${files.map((f) => f.name).join(", ")}.\n\n` : "";
  return [...files.map(fileContent), ...passages, { type: "input_text", text: named + (turn.content || (files.length > 1 ? "Please look at these files." : "Please look at this file.")) }];
}

/**
 * A conversation as OpenAI reads it. Tool calls and results stay out: they come only from connected
 * accounts, and a chat that used them is never sent to OpenAI (see the chat route).
 */
export function toInput(history: ChatTurn[]): InputItem[] {
  return history
    .filter((t) => t.content.trim() || t.attachment || t.app || t.passages?.length)
    .map((t) =>
      t.role === "user" ? { role: "user", content: userContent(t) } : { role: "assistant", content: t.app ? `${t.content}\n\n\`\`\`html\n${t.app}\n\`\`\`` : t.content },
    );
}

/**
 * What an OpenAI error says, for the logs: its type, code and the field it names, never its message,
 * which can quote what the request sent.
 */
export async function errorDetail(res: Response): Promise<string> {
  try {
    const { error } = JSON.parse(await res.text()) as { error?: Record<string, unknown> };
    const parts = [error?.type, error?.code, error?.param].filter((v): v is string => typeof v === "string" && v !== "");
    return parts.map((v) => v.slice(0, 80)).join(" ") || "no details";
  } catch {
    return "no details";
  }
}

const headers = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` });
// How long one count may take, so a slow count can't hold up the request that waits for it.
const COUNT_TIMEOUT_MS = 20_000;

/**
 * Counts the tokens a ChatGPT reply will read: OpenAI's own count of the same request, which costs
 * nothing. Throws when counting fails: the chat route then doesn't send the reply (no guess is safe,
 * as for Claude's count).
 */
export async function countGptTokens(model: string, history: ChatTurn[], instructions: string, effort: GptEffort, signal?: AbortSignal): Promise<number> {
  const res = await fetch(`${OPENAI}/responses/input_tokens`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ model, instructions, input: toInput(history), reasoning: { effort } }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(COUNT_TIMEOUT_MS)]) : AbortSignal.timeout(COUNT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenAI's token count returned ${res.status}: ${await errorDetail(res)}`);
  const { input_tokens } = (await res.json()) as { input_tokens?: unknown };
  if (typeof input_tokens !== "number" || !Number.isFinite(input_tokens) || input_tokens < 0) throw new Error("OpenAI's token count sent no number");
  return input_tokens;
}

/** What a reply used, as OpenAI reports it: input_tokens counts the cached and cache-written tokens too, and output_tokens the thinking. */
export type GptUsage = {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details?: { cached_tokens?: number | null; cache_write_tokens?: number | null } | null;
};

/**
 * What a reply cost Flash, in cents, at the model's price in CLAUDE_PRICES: cache writes at 1.25 times
 * the input price and cache reads at a tenth of it (OpenAI's Sol charges a twentieth, so Flash errs on
 * its own side), and the long-prompt rate for the whole reply once it read more than 272,000 tokens.
 */
export function gptCostCents(model: string, usage: GptUsage): number {
  const cached = Math.max(0, usage.input_tokens_details?.cached_tokens ?? 0);
  const written = Math.max(0, usage.input_tokens_details?.cache_write_tokens ?? 0);
  return claudeCostCents(model, {
    input_tokens: Math.max(0, usage.input_tokens - cached - written),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: written,
    output_tokens: Math.max(0, usage.output_tokens),
  });
}

// What a reply shows when OpenAI can't take it. Nothing was charged: it never started.
export const GPT_BUSY = msg("ChatGPT is busy right now. Try again in a moment, or pick a Flash level.");
export const GPT_REFUSED = msg("ChatGPT couldn't take this request. Try again, or pick a Flash level.");

/** One event from the stream, as far as Flash reads it. */
type GptEvent = {
  type: string;
  delta?: string;
  item?: { type?: string };
  response?: { usage?: GptUsage | null; incomplete_details?: { reason?: string } | null; error?: { code?: string; message?: string } | null };
  error?: { code?: string; message?: string } | null;
  message?: string;
};

/** The events of a server-sent event stream, as they arrive. */
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<GptEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (block: string): GptEvent | null => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return null;
    try {
      return JSON.parse(data) as GptEvent;
    } catch {
      return null;
    }
  };
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const event = parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (event) yield event;
    }
  }
  const last = parse(buffer + decoder.decode());
  if (last) yield last;
}

/**
 * Writing, code, translation and documents on a ChatGPT model: streams the reply as OpenAI writes it,
 * writing at most what the credits held pay for (budget.maxTokens, which counts its thinking too), and
 * meters it from the usage OpenAI reports at the end. Until then, running counts what it has cost so
 * far, so a reply that is stopped or fails part way is charged for what really ran, and nothing when
 * OpenAI never started it. OpenAI doesn't keep the reply (store: false).
 */
export async function* streamGpt(
  history: ChatTurn[],
  preferences: string,
  mode: WritingMode,
  meter: Meter = noMeter,
  budget: Budget = NO_BUDGET,
  choice: GptChoice,
  t: Translate = english,
  { signal, running }: Watch = {},
  // The rest of the system prompt (the tools line, the context note; see system in claude.ts).
  o: { system?: SystemOptions } = {},
): AsyncGenerator<StreamEvent> {
  const instructions = gptInstructions(system(preferences, mode, o.system), choice.level, choice.auto);
  const maxTokens = Math.min(budget.maxTokens, MAX_OUTPUT_TOKENS);
  running?.begin(choice.model, maxTokens, peakOf(choice.model));
  const res = await fetch(`${OPENAI}/responses`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: choice.model,
      instructions,
      input: toInput(history),
      reasoning: { effort: choice.effort },
      max_output_tokens: maxTokens,
      store: false,
      stream: true,
      ...(choice.safetyId && { safety_identifier: choice.safetyId }),
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    console.error(`[flash] OpenAI returned ${res.status} for ${choice.model}: ${await errorDetail(res)}`);
    throw new FriendlyError(res.status === 429 || res.status >= 500 ? GPT_BUSY : GPT_REFUSED);
  }
  let usage: GptUsage | null = null;
  let refused = false;
  let cutShort = false;
  let ended = false;
  for await (const event of events(res.body)) {
    if (event.type === "response.created") running?.opened(choice.inputTokens);
    else if (event.type === "response.output_item.added" && event.item?.type === "reasoning") running?.thinks(true);
    else if (event.type === "response.output_item.done" && event.item?.type === "reasoning") running?.thinks(false);
    else if (event.type === "response.output_text.delta" && event.delta) {
      running?.streamed(event.delta);
      yield { type: "text", delta: event.delta };
    } else if (event.type === "response.refusal.delta" && event.delta) {
      // The model's own refusal isn't shown: Flash says it couldn't help, as for Claude's.
      running?.streamed(event.delta);
      refused = true;
    } else if (event.type === "response.completed" || event.type === "response.incomplete") {
      usage = event.response?.usage ?? null;
      const reason = event.response?.incomplete_details?.reason;
      if (reason === "content_filter") refused = true;
      else if (event.type === "response.incomplete") cutShort = true;
      ended = true;
    } else if (event.type === "response.failed" || event.type === "error") {
      const error = event.response?.error ?? event.error;
      throw new Error(`OpenAI failed part way through a reply: ${error?.code ?? ""} ${error?.message ?? event.message ?? ""}`.trim());
    }
  }
  if (!ended) throw new Error("OpenAI's reply ended before it finished");
  // Without a usage report, the most the reply could have cost: everything read at the full price, and every token it could write.
  const cents = usage ? gptCostCents(choice.model, usage) : tokensMaxCents(choice.model, choice.inputTokens, maxTokens);
  meter("openai", choice.model, cents);
  running?.end();
  if (refused) yield refusalMessage(t);
  else if (cutShort) yield lengthNote(budget, t);
}
