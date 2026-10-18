import Anthropic from "@anthropic-ai/sdk";
import { ENGINES, type Attachment, type ChatTurn, type Engine, type Source, type StreamEvent } from "../types.ts";
import { levelName, type ModelLevel } from "../levels.ts";
import {
  CLAUDE_PRICES,
  CONNECT_STEPS,
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  NO_TOOLS,
  WEATHER_RESULT_TOKENS,
  WEB_SEARCH_CENTS,
  callMaxCents,
  claudeCostCents,
  claudePrice,
  fallbackModel,
  readCostCents,
  researchPlan,
  tokensMaxCents,
  tokensWithin,
  worstTokens,
  type ToolPlan,
} from "../credits.ts";
import { english, msg, type Translate } from "../i18n.ts";
import { FriendlyError } from "./errors.ts";
import { MAX_FORECASTS, TOO_MANY, WEATHER_ROUNDS, WEATHER_TOOL, type WeatherTool } from "../weather.ts";
import { tokensAtMost } from "../tokens.ts";
import type { Where } from "../context-note.ts";
import { CONNECT_LINE, connectorCalls, type ConnectState, type ConnectorKit, type ConnectorTool } from "./connect.ts";
import { claudeTool, failText, FRED_NOTE, limitText, toolFlags, ToolLedger, type ClientTool, type ToolResult } from "../research.ts";

/*
 * Flash uses three Claude models, to keep quality high where it shows and costs low elsewhere:
 * Opus for building apps, slides and code; Sonnet for everyday chat, writing, research and
 * translation; Haiku for tiny behind-the-scenes jobs like deciding which engine a request needs.
 * FLASH_TEXT_MODEL, if set, overrides the first two (for example to run everything on Opus).
 */
export const BUILD_MODEL = process.env.FLASH_BUILD_MODEL || process.env.FLASH_TEXT_MODEL || "claude-opus-5-5";
export const CHAT_MODEL = process.env.FLASH_CHAT_MODEL || process.env.FLASH_TEXT_MODEL || "claude-sonnet-5-5";
// The companion's model (see companion.ts).
export const ROUTER_MODEL = process.env.FLASH_ROUTER_MODEL || "claude-haiku-4-5";
/*
 * The helpers: the router, the picture check, and the writers of media prompts and movie scenes.
 * Haiku 5.5 is the cheapest model and has no refusal fallback, so the most each call can cost is
 * known before it runs (see the _MAX_CENTS values below) and is a small part of a cent.
 */
export const HELPER_MODEL = "claude-haiku-5-5";
// Helpers answer in a word or a short prompt, so they don't think first, and answer fast.
const HELPER_SETTINGS = { output_config: { effort: "low" as const }, thinking: { type: "disabled" as const } };

/*
 * The model behind each of Flash's levels (see levels.ts). Ascend and Vision are the chat and
 * build models above, so Auto keeps the quality people had before levels; Sonic and Summit add a
 * faster, cheaper model and the most capable one.
 */
export const LEVEL_MODELS: Record<ModelLevel, string> = {
  sonic: process.env.FLASH_SONIC_MODEL || "claude-haiku-5-5",
  ascend: CHAT_MODEL,
  vision: BUILD_MODEL,
  ultra: process.env.FLASH_ULTRA_MODEL || "claude-fable-5-1",
};

type Effort = "low" | "medium" | "high";

/**
 * The model and effort one Claude request runs on, and the level to move to if that model can't
 * answer. fallback says whether a refusal may be answered by another model, which the credits held
 * must pay for (see planHold); left out, the model's own fallback is used if it has one.
 */
export type ClaudeChoice = { level: ModelLevel; model: string; effort: Effort; stepDown?: ClaudeChoice; fallback?: boolean };

/**
 * What a level runs on for an engine. Building and code get more thought, Sonic answers at low
 * effort for speed, and Summit steps down to Vision when its model is busy or not available.
 * Research runs on Ascend or above: Sonic's model doesn't have the web tools research uses.
 * careful: the request has sums, units or money in it (see needsCare in levels.ts), so Sonic
 * thinks at medium effort; on Haiku that costs a small part of a credit.
 */
export function claudeChoice(engine: Engine, level: ModelLevel, { careful = false }: { careful?: boolean } = {}): ClaudeChoice {
  if (engine === "search" && level === "sonic") return claudeChoice(engine, "ascend", { careful });
  const effort: Effort =
    level === "sonic" ? (careful ? "medium" : "low") : engine === "app" || engine === "slides" || engine === "code" ? "high" : "medium";
  return { level, model: LEVEL_MODELS[level], effort, ...(level === "ultra" && { stepDown: claudeChoice(engine, "vision") }) };
}

/** The level an engine ran on before levels existed: Vision for building and code, Ascend for the rest. */
export const defaultChoice = (engine: Engine) =>
  claudeChoice(engine, engine === "app" || engine === "slides" || engine === "code" ? "vision" : "ascend");

/** Whether a choice's refusals may be answered by a fallback model (see FALLBACKS in credits.ts). */
export const usesFallback = (choice: ClaudeChoice) => choice.fallback !== false && Boolean(fallbackModel(choice.model));

// Only models listed in FALLBACKS get one: Haiku has none (sending one is an error), and Opus 5.5's
// would cost more than it does.
const refusalFallback = (on: boolean) =>
  on ? { betas: ["server-side-fallback-2026-07-01"] as Anthropic.AnthropicBeta[], fallbacks: "default" as const } : {};

/** The request settings a choice needs: its model, its effort, and a refusal fallback when it may have one. */
export const choiceParams = (choice: ClaudeChoice) => ({
  model: choice.model,
  output_config: { effort: choice.effort },
  ...refusalFallback(usesFallback(choice)),
});

// Not found, no access yet, rate limited or overloaded: another model can still answer.
const UNAVAILABLE = new Set([403, 404, 429, 503, 529]);

/**
 * Runs a Claude engine on a choice, and on its step-down when the model can't take the request
 * before anything was written. Nothing is billed for a request the model never started.
 * t says the step-down in the user's language.
 */
export async function* withStepDown(
  choice: ClaudeChoice,
  engine: (choice: ClaudeChoice) => AsyncGenerator<StreamEvent>,
  onStepDown: (choice: ClaudeChoice) => void = () => {},
  t: Translate = english,
): AsyncGenerator<StreamEvent> {
  let started = false;
  try {
    for await (const event of engine(choice)) {
      if (event.type !== "status") started = true;
      yield event;
    }
  } catch (err) {
    if (started || !choice.stepDown || !(err instanceof Anthropic.APIError && UNAVAILABLE.has(Number(err.status)))) throw err;
    console.error(`[flash] ${choice.model} unavailable (${err.status}), stepping down to ${choice.stepDown.model}`);
    onStepDown(choice.stepDown);
    yield {
      type: "status",
      message: t("{level} is busy right now, so {instead} is answering…", { level: levelName(choice.level), instead: levelName(choice.stepDown.level) }),
    };
    yield* withStepDown(choice.stepDown, engine, onStepDown, t);
  }
}

/** Records what an AI call cost Flash, for credits and the owner dashboard. */
export type Meter = (provider: "anthropic" | "openai" | "elevenlabs" | "fal", model: string, costCents: number) => void;
export const noMeter: Meter = () => {};

/**
 * The most a reply may spend: an output token cap, and a cost cap in cents for multi-step replies.
 * byCredits says the user's credits set the cap, not the engine's own limit (see planHold).
 */
export type Budget = { maxTokens: number; capCents: number; byCredits?: boolean };
export const NO_BUDGET: Budget = { maxTokens: MAX_OUTPUT_TOKENS, capCents: Infinity };

// Claude writes at most about this many tokens a second. Thinking isn't shown, so a call stopped or
// failed while it thinks is charged as if it had thought this fast, up to its max_tokens (see Running).
export const PEAK_TOKENS_PER_SECOND = 200;
/** About how many tokens streamed text is: 3 bytes of UTF-8 a token, a little high for English, right for Chinese. */
const streamedTokens = (text: string) => Buffer.byteLength(text) / 3;
const isPriced = (model: string) => Object.hasOwn(CLAUDE_PRICES, model);

/*
 * What the Claude call in progress has cost so far, estimated from its stream. Claude reports what
 * a call used only when it finishes, so a reply that is stopped or fails part way is charged from
 * this (see finalCredits). Claude bills nothing for a call it never started, so the estimate stays at
 * 0 until message_start. From then on it counts, at the price of the model that is running:
 * - the input, exactly as message_start reports it, cache reads and writes included;
 * - each web search, and for each tool result, reading everything so far again with it;
 * - a refusal fallback reading the input and the declined words again, from its `fallback` block;
 * - every character streamed (words, HTML and edit pieces, tool inputs), at about 3 bytes a token;
 * - thinking, which isn't shown, by the time spent on it (PEAK_TOKENS_PER_SECOND).
 * Once the call is metered from its usage (meterClaude), the estimate goes back to 0.
 */
export class Running {
  private requested = "";
  private model = "";
  private maxTokens = 0;
  private started = false;
  // Tokens: the input as first read, everything written, what the current attempt wrote, tool results.
  private input = 0;
  private wrote = 0;
  private attemptWrote = 0;
  private results = 0;
  // Cents counted so far, but the thinking under way.
  private cents = 0;
  private blocks = new Map<number, string>();
  private thinkingSince = 0;
  private thinkingShown = 0;

  /** A call starts on this model, writing at most maxTokens. */
  begin(model: string, maxTokens: number) {
    this.end();
    this.requested = this.model = model;
    this.maxTokens = maxTokens;
  }

  /** The call reported what it used and was metered from that, or never started. */
  end() {
    this.started = false;
    this.input = this.wrote = this.attemptWrote = this.results = this.cents = this.thinkingSince = this.thinkingShown = 0;
    this.blocks.clear();
  }

  /** What the call has cost so far, in cents. */
  get soFar(): number {
    return this.started ? this.cents + this.outputCents(this.thinking()) : 0;
  }

  /** Counts one event from the call's stream. */
  see(event: Anthropic.Beta.BetaRawMessageStreamEvent) {
    if (event.type === "message_start") {
      this.started = true;
      // A request routed straight to its fallback starts on it, priced as itself (never dearer than the model asked for).
      if (isPriced(event.message.model)) this.model = event.message.model;
      const u = event.message.usage;
      const cached = (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      this.input = u.input_tokens + cached;
      const weighted = u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1;
      this.cents += (weighted * claudePrice(this.model, this.input).input) / 1e6;
    } else if (event.type === "content_block_start") {
      const block = event.content_block;
      this.blocks.set(event.index, block.type);
      if (block.type === "thinking" || block.type === "redacted_thinking") {
        this.thinkingSince = Date.now();
        this.thinkingShown = 0;
      } else if (block.type === "web_search_tool_result" || block.type === "web_fetch_tool_result") {
        // A search that returned results is billed; then Claude reads everything again with what it found.
        if (block.type === "web_search_tool_result" && Array.isArray(block.content)) this.cents += WEB_SEARCH_CENTS;
        this.results += streamedTokens(JSON.stringify(block));
        this.cents += readCostCents(this.model, this.input + this.wrote + this.results);
      } else if (block.type === "fallback") {
        // The model declined; its fallback (or the dearest it can have, for a model Flash doesn't know)
        // reads the input and what was written again, and writes from here on.
        const next = isPriced(block.to.model) ? block.to.model : (fallbackModel(this.requested) ?? this.requested);
        this.cents += readCostCents(next, this.input + this.wrote + this.results);
        this.model = next;
        this.attemptWrote = 0;
      } else if (block.type === "text" && block.text) {
        this.write(streamedTokens(block.text));
      }
    } else if (event.type === "content_block_delta") {
      const delta = event.delta;
      if (delta.type === "text_delta") this.write(streamedTokens(delta.text));
      else if (delta.type === "input_json_delta") this.write(streamedTokens(delta.partial_json));
      else if (delta.type === "thinking_delta") this.thinkingShown += streamedTokens(delta.thinking);
    } else if (event.type === "content_block_stop") {
      const type = this.blocks.get(event.index);
      if (type === "thinking" || type === "redacted_thinking") {
        this.write(this.thinking());
        this.thinkingSince = 0;
      }
    }
  }

  /** Tokens of the thinking under way: by time, or by what it showed when that is more, within max_tokens. */
  private thinking(): number {
    if (!this.thinkingSince) return 0;
    const timed = ((Date.now() - this.thinkingSince) / 1000) * PEAK_TOKENS_PER_SECOND;
    return Math.min(Math.max(timed, this.thinkingShown), Math.max(0, this.maxTokens - this.attemptWrote));
  }

  private outputCents(tokens: number): number {
    return (tokens * claudePrice(this.model, this.input).output) / 1e6;
  }

  private write(tokens: number) {
    this.wrote += tokens;
    this.attemptWrote += tokens;
    this.cents += this.outputCents(tokens);
  }
}

/**
 * Follows a Claude call as it runs: signal stops it at once (the user pressed Stop, or the request's
 * time ran out, with "deadline" as its reason), running keeps what it has cost so far, and endsAt is
 * when the request's time runs out.
 */
export type Watch = { signal?: AbortSignal; running?: Running; endsAt?: number };

/** The Claude model an engine runs on. */
export const modelForEngine = (engine: Engine) =>
  engine === "app" || engine === "slides" || engine === "code" ? BUILD_MODEL : CHAT_MODEL;

/**
 * Counts the tokens a conversation and its system prompt will cost to read. With tools (a reply with
 * connectors) they are counted exactly too; without, 3,000 tokens are added as room for any tool.
 */
export async function countInputTokens(model: string, history: ChatTurn[], systemPrompt = "", tools?: Anthropic.Beta.BetaTool[]): Promise<number> {
  const messages = toMessages(history);
  const withTools = Boolean(tools?.length);
  // Throws when counting fails: no guess is safe (a character can be several tokens, and a picture or
  // PDF page costs tokens whatever its size), so the request isn't priced or sent (see the chat route).
  const res = await getClient().beta.messages.countTokens({ model, messages, ...(systemPrompt && { system: systemPrompt }), ...(withTools && { tools }) });
  return res.input_tokens + (withTools ? 0 : 3000);
}

/**
 * Meters a Claude call at what it really cost, every attempt included (a refusal fallback bills the
 * declined attempt too), and returns that cost in cents. requested is the model asked for. Searches
 * are counted from the results in the reply too, since the usage leaves out a declined attempt's.
 */
export function meterClaude(meter: Meter, message: Anthropic.Beta.BetaMessage, requested = message.model, running?: Running): number {
  const searched = message.content.filter((b) => b.type === "web_search_tool_result" && Array.isArray(b.content)).length;
  const cents = claudeCostCents(message.model, message.usage, requested, searched);
  meter("anthropic", message.model, cents);
  running?.end();
  return cents;
}

/*
 * Who Flash is and how it answers, for every chat engine and the free models: the answer first, the
 * assumptions said in a few words, at most one question, and nothing made up.
 */
export const BASE_SYSTEM = [
  "You are Flash, the assistant in Flash AI (flash-app.dev), an all-in-one AI app. People use Flash on their phones and computers, " +
    "in about 30 languages, for quick answers, writing, research, documents and code. Many are busy business owners, students and " +
    "creators who want the answer, not a conversation about it.",
  "Answer first. Open with the direct answer or the finished piece of work, then add only the detail that helps. When a request " +
    "leaves something open (a place, a date, a tone, a length, a name), take the most sensible reading from the conversation and what " +
    'you know about the user, say that assumption in a few words ("For Lagos, today:"), and carry on; the user can correct you in ' +
    "their next message. Ask a question only when you can't do the task well without the answer, and then ask just one short question, " +
    "after giving whatever you can. Stop when the answer is complete; offer one next step only when it's genuinely useful.",
  "Be right. Work through sums, percentages, unit and currency conversions and dates carefully, and check them before you give them. " +
    "When you aren't sure, say so in a few words and say what would settle it, instead of guessing or piling on caveats. Never present " +
    "a number, quote, source or fact you made up as real. When a real detail is missing from something you write (a phone number, a " +
    "price, a name), leave a clear placeholder like [phone number].",
  "Use the units, currency and date format of the user's country. Use short paragraphs, and Markdown lists, tables or headings only " +
    "when they make the answer easier to scan.",
].join("\n\n");

/*
 * What the model is told about the rest of Flash, built only from the engines that work right now
 * (engineStatus), so it never names a missing feature or says Flash can't do something it can.
 */
const OTHER_TOOL_NAMES: Partial<Record<Engine, string>> = {
  image: "pictures",
  video: "videos",
  music: "music",
  voice: "voice-overs",
  app: "apps and websites",
  slides: "slide decks",
  transcribe: "transcripts of recordings",
};
/** "a, b and c". */
const listed = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/**
 * The line about Flash's other tools, from what's live (engineStatus()), or "" when none are. free: for
 * the free models. picked: the user picked this tool, so Flash doesn't switch by itself; they pick
 * another one, or go back to Auto.
 */
export function otherToolsLine(status: Partial<Record<Engine, boolean>>, free = false, picked = false): string {
  const live = (Object.keys(OTHER_TOOL_NAMES) as Engine[]).filter((e) => status[e]);
  if (!live.length) return "";
  const list = listed(live.map((e) => OTHER_TOOL_NAMES[e]!));
  const example = status.image && !free ? ' (for example "Make a picture of a red bicycle")' : "";
  const makes = free ? `Flash also makes ${list}, most of them with credits.` : `Flash also makes ${list}.`;
  const when = picked
    ? "The user picked this tool, so Flash won't switch tools by itself: when they want one of these, tell them to pick it with the tool " +
      `button by the message box, or to switch back to Auto and ask for it in their own words${example}.`
    : `When the user wants one of these, tell them to ask for it in their own words${example}${free ? "." : "; Flash switches tools by itself."}`;
  return `${makes} ${when} Never say Flash can't do them.`;
}

/** What may have changed since the model's training: the weather is listed only when no forecast tool is attached. */
const changing = (weather: boolean) => (weather ? "" : "the weather, ");

const WEB_LINES = {
  // Research.
  search: (weather: boolean) => {
    const things = `${changing(weather)}news, prices and exchange rates, scores, schedules and opening hours, who holds an office or title, the latest version of anything, and laws and rules`;
    return (
      "You can search the web and read web pages. Your training data ends well before today's date. " +
      `${things[0].toUpperCase()}${things.slice(1)} may have changed since then, so search for those before you answer, even when you feel sure. ` +
      "Facts that can't change need no search. When the answer depends on where the user is, put their city or country in the search query."
    );
  },
  // Claude without search: Write, Code, Translate, Docs & Sheets.
  none: (weather: boolean) =>
    "You can't search the web in this answer. Your training data ends well before today's date, so for anything that may have changed " +
    `since then (${changing(weather)}news, prices, scores, who holds an office, the latest version of something), give what you know and ` +
    "roughly when it dates from, and say that Flash's Research can check it live. Never state a current figure as if you had just checked it.",
  // The free models with web_search (the owner's SearXNG, see server/searxng.ts).
  freeSearch: (weather: boolean) =>
    "You're answering on Flash's free model, with a web_search tool. Your training data ends well before today's date, so for anything " +
    `that may have changed since then (${changing(weather)}news, today's events, prices, exchange rates, scores, schedules, opening hours, who ` +
    "holds an office now, the latest version of something), search before you answer, with a short query, at most twice. Answer from " +
    "the results and cite each fact you take from them with its number, like [1]; snippets are short, so never add details they don't " +
    "show, and give the date of anything that changes. If the search fails or finds nothing, say so in one sentence, give what you know " +
    "and roughly when it dates from, and never present it as current or checked. Facts that can't change need no search.",
  // The free models.
  free: (weather: boolean) =>
    "You're answering on Flash's free model, which can't search the web. For anything that changes " +
    `(${changing(weather)}news, prices, exchange rates, scores, schedules, opening hours, who holds an office now, the latest version of ` +
    "something), never state a current value as if you had checked it: say in one sentence that the free model can't check live " +
    "information, give what you know and roughly when it dates from, and say where to check it (the official source). Once in a " +
    "conversation, you can mention that with credits, Flash's Research checks the web and cites its sources.",
};

/** For a reply that has the get_weather tool (see weather.ts). */
export const WEATHER_LINE =
  "You have a get_weather tool with a live forecast. For any question about the weather now or in the coming days (rain, temperature, " +
  "wind, what to wear, whether to take an umbrella or go ahead with plans), call it before you answer, instead of saying you can't check, " +
  'and don\'t ask where: when no place is named, use where the user is (where: "user_location"); for a named place, give its coordinates. ' +
  "Use the figures exactly as the tool gives them, in its units, and name the place and the day you mean. They are forecasts: for the " +
  'current hour say "around" or "forecast", never that it was measured. If the tool returns an error, say in one sentence that you ' +
  "couldn't get the live forecast just now and give no figures; if it says the user's location is unknown, ask which city in one short " +
  "question. If the forecast shows thunder, heavy rain or snow, strong wind or gusts, or extreme heat or cold, or the user mentions a " +
  "storm, flood or warning, add one sentence telling them to follow their national weather service's official warnings, which this " +
  "forecast doesn't include. Flash shows the data source under your answer, so you needn't name it.";

/** For a reply that has the SEC EDGAR tools (see research.ts). */
export const SEC_LINE =
  "You have SEC EDGAR tools with what US public companies file: sec_company_filings lists a company's recent filings (10-K, 10-Q, 8-K) " +
  "with links, and sec_financial_facts gives the figures it reported (revenue, net income, EPS and more) by fiscal year or quarter. For " +
  "a public company's filings or reported figures, call them before you answer instead of giving figures from memory. Use the values " +
  "exactly as they come, in their units, and say which period each covers (a fiscal year may not match the calendar year). If a tool " +
  "returns an error or no values, say so in one sentence and give no figures as if they were checked. Flash lists the filings used under your answer.";

/** For a reply that has the FRED tools (see research.ts). */
export const FRED_LINE =
  "You have FRED tools with US economic data from the Federal Reserve Bank of St. Louis: fred_series gives a series' values (UNRATE " +
  "unemployment, CPIAUCSL consumer prices, GDP, FEDFUNDS and more) and fred_series_search finds a series' id. For an economic " +
  "indicator, call them before you answer instead of giving figures from memory. Use the values exactly as they come, with their units " +
  "and dates, and give the latest date the data covers. If a tool returns an error, say so in one sentence and give no figures from it. " +
  "Never say or suggest that the Federal Reserve endorses Flash. Flash adds FRED's notice and the series' link under your answer.";

const RESEARCH_PROMPT =
  "This is a research answer: search the web, and read any page the user links. Answer first, in a sentence or a short list, then the " +
  "supporting detail; keep the whole answer as short as the question allows. Prefer official and primary sources. When sources disagree, " +
  "say so, and say which you trust and why. Give the date of anything that changes (\"as of 3 March\"), and name the source of key facts " +
  "in the text; Flash shows the links under your answer. If what you found doesn't answer the question, say what you found and what's " +
  "missing instead of filling the gap from memory.";
// Research's quick plan: one search and one page read.
const QUICK_RESEARCH = "One good search is enough here: answer as soon as you have what you need.";

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

function fileBlock(a: Attachment): Anthropic.Beta.BetaContentBlockParam {
  if ((IMAGE_TYPES as readonly string[]).includes(a.mediaType)) {
    return { type: "image", source: { type: "base64", media_type: a.mediaType as ImageType, data: a.data } };
  }
  if (a.mediaType === "application/pdf") {
    return { type: "document", title: a.name, source: { type: "base64", media_type: "application/pdf", data: a.data } };
  }
  const text = Buffer.from(a.data, "base64").toString("utf8");
  return { type: "document", title: a.name, source: { type: "text", media_type: "text/plain", data: text } };
}

function toContent(turn: ChatTurn): string | Anthropic.Beta.BetaContentBlockParam[] {
  if (!turn.attachment) return turn.content;
  const files = [turn.attachment, ...(turn.more ?? [])];
  // Pictures have no title, so several are named in the text to tell them apart.
  const named = files.length > 1 ? `Attached files, in order: ${files.map((f) => f.name).join(", ")}.\n\n` : "";
  return [...files.map(fileBlock), { type: "text", text: named + (turn.content || (files.length > 1 ? "Please look at these files." : "Please look at this file.")) }];
}

function assistantContent(t: ChatTurn): string {
  return t.app ? `${t.content}\n\n\`\`\`html\n${t.app}\n\`\`\`` : t.content;
}

/** A turn's content with the tool blocks the server put on it (see ChatTurn): calls after the words, results before them. */
function withTools(t: ChatTurn, content: string | Anthropic.Beta.BetaContentBlockParam[]): string | Anthropic.Beta.BetaContentBlockParam[] {
  const calls = t.role === "assistant" ? (t.toolCalls ?? []) : [];
  const results = t.role === "user" ? (t.toolResults ?? []) : [];
  if (!calls.length && !results.length) return content;
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = typeof content === "string" ? (content.trim() ? [{ type: "text", text: content }] : []) : content;
  return [
    ...results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.content, ...(r.isError && { is_error: true }) })),
    ...blocks,
    ...calls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input })),
  ];
}

export function toMessages(history: ChatTurn[]): Anthropic.Beta.BetaMessageParam[] {
  return history
    .filter((t) => t.content.trim() || t.attachment || t.app || t.toolCalls?.length || t.toolResults?.length)
    .map((t) => ({ role: t.role, content: withTools(t, t.role === "user" ? toContent(t) : assistantContent(t)) }));
}

export type WritingMode = "text" | "code" | "translate" | "docs";

const MODE_PROMPTS: Record<WritingMode, string> = {
  text: "",
  code:
    "You are acting as an expert software engineer. Give working, complete code in fenced code blocks with the language named, then a " +
    "short explanation. When the language, framework or version isn't stated, use what the conversation points to, else the most common " +
    "current choice, and name it in one line instead of asking. Libraries change after your training: when it matters, say which version " +
    "your code is for, and flag any API you're not sure still exists. Point out the bugs and edge cases that matter for this code.",
  translate:
    "You are acting as a professional translator. Give the translation first, keeping tone and meaning. " +
    "If the target language is unclear, use the language named under \"About the user\" below, else English. " +
    "Add a short note only for idioms or ambiguity.",
  docs:
    "You are acting as a document and spreadsheet specialist. When the user wants a spreadsheet or table data, " +
    "return it as a fenced ```csv code block with a header row (the app turns it into a downloadable file), " +
    "plus a short Markdown table preview if it has 15 rows or fewer. When they want a document (letter, resume, " +
    "report, proposal), write the whole document as formatted Markdown, not inside a code block: the app offers " +
    "Word, PDF and PowerPoint downloads under every answer. " +
    "When the user hasn't given the details a document needs (a CV with no work history, a letter with no names), write the complete " +
    "document anyway with clear placeholders in square brackets, like [Company name] or [Start date], and end with one line listing what " +
    "to fill in. Date letters and documents with today's date. For tables of figures that change (rates, prices, populations), say what " +
    "date the figures are from. " +
    "When analysing an attached file, lead with the key findings and the numbers behind them. " +
    "When reading text from photos or scans (receipts, menus, notes, letters, signs): copy the words exactly as " +
    "written, in their own language, keeping spelling, numbers and line breaks; write [unclear] for anything you " +
    "can't read and never guess a number. For receipts, invoices, menus, price lists and anything in rows, also give " +
    "the rows as a spreadsheet, with amounts as plain numbers and the currency in its own column. Copy totals as " +
    "printed and only work out new totals when asked.",
};

/**
 * What a system prompt says beyond the mode. web: whether the model can search (Research), can't
 * (the other Claude modes) or is a free model; weather: get_weather is attached; quick: Research's
 * quick plan; tools: otherToolsLine(engineStatus()), built in route.ts since this file can't import
 * server code; context: contextNote(where, now). search: a free model has web_search; filings and
 * economy: the SEC EDGAR and FRED tools are attached (see research.ts).
 */
export type SystemOptions = {
  web?: "search" | "none" | "free";
  weather?: boolean;
  quick?: boolean;
  tools?: string;
  context?: string;
  connect?: boolean;
  search?: boolean;
  filings?: boolean;
  economy?: boolean;
};

/**
 * A chat engine's system prompt. The text that never changes comes first and the per-minute context
 * last, so the prompt can be cached later: who Flash is, its other tools, what it can know of today,
 * the forecast tool, the connected accounts, the mode, the user's settings and memory, then their
 * date, time and place.
 */
export function system(preferences: string, mode: WritingMode | "search" = "text", o: SystemOptions = {}): string {
  const prefs = preferences.trim();
  const weather = Boolean(o.weather);
  const web = o.web ?? (mode === "search" ? "search" : "none");
  const parts = [
    BASE_SYSTEM,
    o.tools ?? "",
    web === "free" && o.search ? WEB_LINES.freeSearch(weather) : WEB_LINES[web](weather),
    weather ? WEATHER_LINE : "",
    o.filings ? SEC_LINE : "",
    o.economy ? FRED_LINE : "",
    o.connect ? CONNECT_LINE : "",
    mode === "search" ? RESEARCH_PROMPT + (o.quick ? ` ${QUICK_RESEARCH}` : "") : MODE_PROMPTS[mode],
  ];
  // Settings > General (the language to answer in, what to call them) comes first, then their memory.
  if (prefs) parts.push(`About the user, from their settings and what they asked Flash to remember. Follow their language setting in every answer:\n${prefs}`);
  parts.push(o.context ?? "");
  return parts.filter(Boolean).join("\n\n");
}

function refusalMessage(t: Translate): StreamEvent {
  return { type: "text", delta: "\n\n" + t("Flash couldn't help with that request.") };
}

/**
 * What a reply with tools may use besides its system prompt: get_weather (weather), onUsed, called
 * once when a forecast first comes back with data, so the reply's header can say why, the user's
 * connected accounts (connect, Write, Code, Translate and Docs only; see engines/connect.ts), and the
 * SEC EDGAR and FRED tools (data, see research.ts), with onTool called once for each of them whose
 * data the reply first uses. Claude has its own web search (Research), so the free models' is never given it.
 */
export type ReplyOptions = {
  system?: SystemOptions;
  weather?: WeatherTool;
  onUsed?: () => void;
  connect?: ConnectorKit;
  data?: ClientTool[];
  onTool?: (name: string) => void;
};

/** The data tools Claude may have: SEC EDGAR and FRED. */
const claudeData = (data: ClientTool[] = []) => data.filter((x) => x.family !== "web");

/**
 * What ends a reply that used data tools: FRED's notice when it showed FRED data, then one list of
 * sources (the browser keeps only the last one a reply sends): the data's, then MET Norway's.
 */
function* dataEnd(ledger: ToolLedger, weather: Source[] | null, say: (words: string) => StreamEvent = (delta) => ({ type: "text", delta })): Generator<StreamEvent> {
  if (ledger.fred) yield say(FRED_NOTE);
  const items = [...ledger.sources(), ...(weather ?? [])];
  if (items.length) yield { type: "sources", items };
}

// A tool round is followed by another call only when the credits held still pay for this much of it.
const MIN_ROUND_TOKENS = 300;

/** Everything a call read: its input, cache reads and writes included. */
const inputOf = (u: Anthropic.Beta.BetaUsage) => u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);

/** The forecast rounds a reply may still ask for after `rounds`, for the credits the next call must leave for them. */
const weatherLeft = (rounds: number): ToolPlan => ({ results: Array(Math.max(0, WEATHER_ROUNDS - rounds)).fill(WEATHER_RESULT_TOKENS), searches: 0 });

/**
 * A call that failed after an earlier call of the same reply was paid for isn't retried on another
 * level (see withStepDown), which would start the reply again with all of its credits.
 */
function afterSpending(err: unknown): unknown {
  if (!(err instanceof Anthropic.APIError) || err instanceof Anthropic.APIUserAbortError) return err;
  return new Error(`Claude failed part way through a reply: ${err.message}`, { cause: err });
}

/**
 * A turn's content as it goes back to Claude. After a refusal fallback part way through (a "fallback"
 * block marks where the next model took over), the declined model's thinking and tool calls before
 * the last such block are left out, with any server tool call that has no result, so only the model
 * that answered has its calls run and echoed (see the API's refusal fallback guidance).
 */
export function echoedContent(content: Anthropic.Beta.BetaContentBlock[]): Anthropic.Beta.BetaContentBlock[] {
  const boundary = content.map((b) => b.type).lastIndexOf("fallback");
  if (boundary < 0) return content;
  // A server tool's result (a search, a page read, or the code that filters a search) goes back with
  // its call, and a call goes back only with its result.
  const isResult = (b: Anthropic.Beta.BetaContentBlock) => b.type.endsWith("_tool_result") && b.type !== "mcp_tool_result";
  const answered = new Set(content.flatMap((b) => (isResult(b) && "tool_use_id" in b ? [b.tool_use_id] : [])));
  return content.filter(
    (b, i) => i >= boundary || b.type === "text" || b.type === "fallback" || isResult(b) || (b.type === "server_tool_use" && answered.has(b.id)),
  );
}

/** A reply's forecasts so far: tool rounds, calls, and whether any came back with data. */
type WeatherState = { rounds: number; calls: number; used: boolean };

/** What one round of a reply's tools needs: the forecast and its state, the connected accounts (see engines/connect.ts), and the data tools and their ledger. */
type RoundTools = {
  weather?: WeatherTool;
  state: WeatherState;
  onUsed?: () => void;
  kit?: ConnectorKit;
  connectors?: ConnectorTool[];
  connect?: ConnectState;
  signal?: AbortSignal;
  t?: Translate;
  data?: ClientTool[];
  ledger?: ToolLedger;
  onTool?: (name: string) => void;
};

/**
 * Runs the tool calls of a turn that stopped for them, saying what it checks, and returns their
 * results, in order, for one user message, with about how many tokens they add (and how many
 * characters, for the most they can be): the get_weather calls (at most MAX_FORECASTS in a reply) and
 * the data tools' calls (at most CALL_CAPS of each kind, see research.ts) together, then the connector
 * calls in order (see connectorCalls). Each round counts as one.
 */
async function* replyRound(
  content: Anthropic.Beta.BetaContentBlock[],
  r: RoundTools,
): AsyncGenerator<StreamEvent, { results: Anthropic.Beta.BetaToolResultBlockParam[]; tokens: number; chars: number }> {
  const { weather: tool, state, ledger } = r;
  const calls = content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
  const isWeather = (call: Anthropic.Beta.BetaToolUseBlock) => Boolean(tool) && call.name === WEATHER_TOOL.name;
  const dataOf = (call: Anthropic.Beta.BetaToolUseBlock) => (ledger ? r.data?.find((x) => x.name === call.name) : undefined);
  for (const call of calls) if (isWeather(call)) yield { type: "status", message: tool!.status(call.input) };
  for (const call of calls) {
    const data = dataOf(call);
    if (data) yield { type: "status", message: data.status(call.input) };
  }
  // Each kind's calls are counted in the order they were asked for, before any runs.
  const looking = Promise.all(
    calls.flatMap((call) => {
      const data = dataOf(call);
      if (!data) return [];
      const run: Promise<ToolResult> = ledger!.take(data.family)
        ? data.run(call.input, r.signal).catch(() => ({ text: failText(data.family), isError: true, used: false }))
        : Promise.resolve({ text: limitText(data.family), isError: true, used: false });
      return [run.then((result) => [call.id, result] as const)];
    }),
  );
  const forecasts = new Map(
    await Promise.all(
      calls.filter(isWeather).map(async (call) => [call.id, state.calls++ < MAX_FORECASTS ? await tool!.run(call.input) : { text: TOO_MANY, isError: true, used: false }] as const),
    ),
  );
  const looked = new Map(await looking);
  // Read in the order they were asked for, so a search's numbers don't depend on which answered first.
  const before = new Set(ledger?.used ?? []);
  const settled = new Map<string, { text: string; isError: boolean }>();
  for (const call of calls) {
    const result = looked.get(call.id);
    if (result) settled.set(call.id, { text: ledger!.settle(call.name, result), isError: result.isError });
  }
  for (const name of ledger?.used ?? []) if (!before.has(name)) r.onTool?.(name);
  const connected =
    r.kit && r.connectors?.length && r.connect
      ? yield* connectorCalls(
          calls.filter((c) => r.connectors!.some((x) => x.name === c.name)),
          r.connectors,
          r.kit,
          r.connect,
          r.signal,
          r.t,
        )
      : new Map<string, { content: string; isError: boolean }>();
  // The answer is written next: the progress line goes.
  yield { type: "status", message: "" };
  state.rounds++;
  if (!state.used && [...forecasts.values()].some((a) => a.used)) {
    state.used = true;
    r.onUsed?.();
  }
  const answers = calls.map((call) => {
    const forecast = forecasts.get(call.id);
    if (forecast) return { text: forecast.text, isError: forecast.isError };
    const data = settled.get(call.id);
    if (data) return data;
    const result = connected.get(call.id);
    if (result) return { text: result.content, isError: result.isError };
    return { text: `There is no tool called ${call.name}.`, isError: true };
  });
  const results = calls.map((call, i) => ({
    type: "tool_result" as const,
    tool_use_id: call.id,
    content: answers[i].text,
    ...(answers[i].isError && { is_error: true }),
  }));
  return {
    results,
    tokens: answers.reduce((sum, a) => sum + tokensAtMost(a.text) + 50, 0),
    chars: answers.reduce((sum, a) => sum + a.text.length + 50, 0),
  };
}

/**
 * What the next step of a reply with connectors will read, in tokens, before it is sent: counted by
 * Claude with its tools (counting costs nothing), and never less than what the last call read and
 * wrote plus what the tools returned, counted high (see tokensAtMost). When counting fails, the most
 * it can be (3 tokens a character, see worstTokens): for a first step, of everything it sends; for a
 * later one, of what the tools returned, on top of what the last call read and wrote. Never the hold's
 * own estimate, which counting failing may have made too low.
 */
async function nextInput(
  model: string,
  system: string,
  messages: Anthropic.Beta.BetaMessageParam[],
  tools: Anthropic.Beta.BetaTool[],
  last: { usage: Anthropic.Beta.BetaUsage; tokens: number; chars: number } | null,
  signal?: AbortSignal,
): Promise<number> {
  const read = last ? inputOf(last.usage) + last.usage.output_tokens : 0;
  try {
    const res = await getClient().beta.messages.countTokens({ model, system, messages, ...(tools.length && { tools }) }, { signal });
    return Math.max(res.input_tokens, read + (last?.tokens ?? 0));
  } catch (err) {
    if (signal?.aborted) throw err;
    if (last) return read + worstTokens(last.chars);
    return worstTokens(system.length + JSON.stringify(messages).length + (tools.length ? JSON.stringify(tools).length : 0));
  }
}

/** A reply with connectors whose first step the credits held don't pay for: it isn't started, and costs nothing. */
export const NO_FIRST_STEP = msg("Flash couldn't start this answer within the credits held for it. Try again in a moment.");

/** Ends a reply whose next step the credits held don't pay for, after a tool round. */
const stoppedLooking = (t: Translate): StreamEvent => ({
  type: "text",
  delta: `\n\n_${t("Stopped looking things up: the credits held for this reply are used.")}_`,
});

/**
 * Writing, code, translation, documents and file questions: streams Claude's reply token by token.
 * With o.weather, Claude may ask for live forecasts (see weather.ts), and with o.connect it may use
 * the user's connected accounts (see engines/connect.ts). Their results go back to it, appended to the
 * conversation, for up to WEATHER_ROUNDS rounds (CONNECT_STEPS − 1 with connectors), and every step is
 * checked before it starts: it writes only what the credits held still pay for once it has read
 * everything again, so the reply never costs more than was held. MET Norway is credited under an
 * answer that used a forecast, and the accounts' tools a reply used are listed under it.
 */
export async function* streamText(
  history: ChatTurn[],
  preferences: string,
  mode: WritingMode = "text",
  meter: Meter = noMeter,
  budget: Budget = NO_BUDGET,
  // The level's model and effort; by default Ascend at medium effort, and Vision thinking harder for code.
  choice: ClaudeChoice = defaultChoice(mode),
  // The language Flash's own notes (not the reply) are in.
  t: Translate = english,
  { signal, running }: Watch = {},
  // The rest of the system prompt (the tools line, the context note; see system) and the tools.
  o: ReplyOptions = {},
): AsyncGenerator<StreamEvent> {
  const tool = o.weather;
  const kit = o.connect;
  const data = claudeData(o.data);
  const ledger = new ToolLedger();
  // The same words in every call of the reply, so the hold counted them and Claude's thinking stays valid.
  const instructions = system(preferences, mode, { ...o.system, weather: Boolean(tool), connect: Boolean(kit), ...toolFlags(data) });
  const messages = toMessages(history);
  const state: WeatherState = { rounds: 0, calls: 0, used: false };
  const connect: ConnectState = { readFrom: new Set(kit?.tainted ?? []), used: [] };
  const rounds = kit ? CONNECT_STEPS - 1 : WEATHER_ROUNDS;
  let maxTokens = budget.maxTokens;
  let spent = 0;
  // Whether any words were sent yet, and whether the next call may only answer (no more forecasts).
  let wrote = false;
  let answerOnly = false;
  // Notes about the accounts, sent with the reply's first words: nothing but a status is sent before
  // Claude starts, so a level that is busy can still step down (see withStepDown), and the notes show once.
  let notes = "";
  const say = (words: string | StreamEvent): StreamEvent => {
    const delta = typeof words === "string" ? words : words.type === "text" ? words.delta : "";
    const event: StreamEvent = { type: "text", delta: notes + delta };
    notes = "";
    return event;
  };
  try {
    // The accounts' tools as their servers list them now: one that changed since the user added it is left out.
    let connectors: ConnectorTool[] = [];
    if (kit) {
      yield { type: "status", message: t("Checking your connected accounts…") };
      const checked = await kit.check(signal);
      connectors = checked.tools;
      yield { type: "status", message: "" };
      for (const name of checked.unreachable) {
        notes += `_${t("Flash couldn't reach {name} just now, so this answer doesn't use it.", { name })}_\n\n`;
      }
      for (const name of checked.changed) {
        notes += `_${t("{name} changed some of its tools since you added it. They're left out until you look at them in Settings > Connectors.", { name })}_\n\n`;
      }
    }
    const tools = [...(tool ? [WEATHER_TOOL] : []), ...data.map(claudeTool), ...connectors.map((c) => c.definition)];
    // Results continued from an approved card are tool blocks, which need their tools defined even
    // when none can be used now (their server is unreachable or changed): sent, but not to be called.
    const earlier = new Set(history.flatMap((turn) => turn.toolCalls?.map((call) => call.name) ?? []));
    const declared = tools.length ? tools : (kit?.tools ?? []).filter((c) => earlier.has(c.name)).map((c) => c.definition);
    if (kit) {
      // The first step is checked too, with the tools it really has. One that doesn't fit isn't
      // started: the reply fails before Claude is called, so it costs nothing.
      const first = await nextInput(choice.model, instructions, messages, declared, null, signal);
      maxTokens = Math.min(budget.maxTokens, tokensWithin(mode, choice.model, first, budget.capCents, usesFallback(choice)));
      if (!(maxTokens >= MIN_ROUND_TOKENS)) throw new FriendlyError(NO_FIRST_STEP);
    }
    for (;;) {
      running?.begin(choice.model, maxTokens);
      const stream = getClient().beta.messages.stream(
        {
          ...choiceParams(choice),
          max_tokens: maxTokens,
          system: instructions,
          messages,
          // The last round can't ask for more, so the reply always ends in words.
          ...(declared.length && {
            tools: declared,
            tool_choice: { type: !tools.length || state.rounds >= rounds || answerOnly ? ("none" as const) : ("auto" as const) },
          }),
        },
        { signal },
      );
      // Words written before a forecast was asked for end their paragraph; the answer starts a new one.
      let gap = wrote && state.rounds > 0 ? "\n\n" : "";
      for await (const event of stream) {
        running?.see(event);
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield say(gap + event.delta.text);
          gap = "";
          wrote = true;
        }
      }
      const final = await stream.finalMessage();
      spent += meterClaude(meter, final, choice.model, running);
      // A turn cut off or declined never runs the tools it asked for.
      if (final.stop_reason === "refusal") {
        yield say(refusalMessage(t));
        break;
      }
      if (final.stop_reason === "max_tokens") {
        yield say(lengthNote(budget, t));
        break;
      }
      if (!tools.length || final.stop_reason !== "tool_use" || answerOnly) break;
      const content = echoedContent(final.content);
      const round = yield* replyRound(content, { weather: tool, state, onUsed: o.onUsed, kit, connectors, connect, signal, t, data, ledger, onTool: o.onTool });
      messages.push({ role: "assistant", content }, { role: "user", content: round.results });
      // The next call reads everything again with what the tools returned, and writes only what the
      // credits held still pay for: priced as this one call with connectors, and leaving room for the
      // forecast's rounds still to come without.
      const next = kit
        ? await nextInput(choice.model, instructions, messages, tools, { usage: final.usage, tokens: round.tokens, chars: round.chars }, signal)
        : inputOf(final.usage) + final.usage.output_tokens + round.tokens;
      const left = budget.capCents - spent;
      maxTokens = Math.min(budget.maxTokens, tokensWithin(mode, choice.model, next!, left, usesFallback(choice), kit ? undefined : weatherLeft(state.rounds)));
      if (!(maxTokens >= (MIN_OUTPUT_TOKENS[mode] ?? 1500))) {
        // Too little left for another round and a full answer: one last call answers with what the tools
        // returned, with no tools, so it is paid for as a single call. (Room that grew with the credits
        // held would otherwise give some a shorter answer. A step with connectors is already priced as
        // one call: for it this only keeps it from calling again when its answer would then have less.)
        answerOnly = true;
        maxTokens = Math.min(budget.maxTokens, tokensWithin(mode, choice.model, next!, left, usesFallback(choice), NO_TOOLS));
      }
      if (!(maxTokens >= MIN_ROUND_TOKENS)) {
        yield say(kit ? stoppedLooking(t) : lengthNote(budget, t));
        break;
      }
    }
    // A reply that ended without words still shows the notes.
    if (notes) yield say("");
  } catch (err) {
    // A reply stopped or cut off after a forecast or a look-up still credits MET Norway and the data's
    // sources (with FRED's notice) for what it showed, and lists the accounts' tools it used.
    yield* dataEnd(ledger, state.used ? tool!.sources : null);
    if (connect.used.length) yield { type: "connector_used", items: connect.used };
    throw spent > 0 ? afterSpending(err) : err;
  } finally {
    await kit?.close();
  }
  yield* dataEnd(ledger, state.used ? tool!.sources : null, (words) => say(words));
  if (connect.used.length) yield { type: "connector_used", items: connect.used };
}

function lengthNote(budget: Budget, t: Translate): StreamEvent {
  const note = budget.byCredits
    ? t("Flash stopped here because the reply reached what your credits cover. Ask it to continue.")
    : t("Flash stopped here because the reply reached its length limit. Ask it to continue.");
  return { type: "text", delta: `\n\n_${note}_` };
}

/** Research's options: quick asks for one search and one page (see researchPlan), where is the user's rough place. */
export type ResearchOptions = ReplyOptions & { quick?: boolean; where?: Where };

/** Where the user is, for web search, from the checked values only (see where.ts), or undefined when nothing is known. */
export function searchLocation(where?: Where): Anthropic.Beta.BetaUserLocation | undefined {
  if (!where) return undefined;
  const place = {
    ...(where.city && { city: where.city }),
    ...(where.country && { country: where.country }),
    // UTC is what an unknown zone falls back to, so it says nothing about the user.
    ...(where.timeZone && where.timeZone !== "UTC" && { timezone: where.timeZone }),
  };
  return Object.keys(place).length ? { type: "approximate", ...place } : undefined;
}

/** The page reader for a model: Summit's Fable 5.1 has its own version. */
const webFetch = (model: string, uses: number): Anthropic.Beta.BetaToolUnion =>
  /^claude-fable-5-1/.test(model)
    ? { type: "web_fetch_20260318", name: "web_fetch", max_uses: uses, max_content_tokens: 6000 }
    : { type: "web_fetch_20260209", name: "web_fetch", max_uses: uses, max_content_tokens: 6000 };

/**
 * Research: Claude with server-side web search and page reading, returning the answer and one list of
 * sources: the links it cited first, then the others it read, and MET Norway when a forecast was used.
 */
export async function* streamSearch(
  history: ChatTurn[],
  preferences: string,
  meter: Meter = noMeter,
  budget: Budget = NO_BUDGET,
  choice: ClaudeChoice = defaultChoice("search"),
  // The language Flash's own notes (not the answer) are in.
  t: Translate = english,
  { signal, running }: Watch = {},
  o: ResearchOptions = {},
): AsyncGenerator<StreamEvent> {
  const tool = o.weather;
  const data = claudeData(o.data);
  const ledger = new ToolLedger();
  // Whether Claude has tools of Flash's own to call (the forecast, SEC EDGAR, FRED), each round of them priced as a forecast's.
  const own = Boolean(tool) || data.length > 0;
  const quick = Boolean(o.quick);
  const plan = researchPlan(quick, own);
  const instructions = system(preferences, "search", { ...o.system, quick, weather: Boolean(tool), ...toolFlags(data) });
  const messages = toMessages(history);
  const cited = new Map<string, Source>();
  const read = new Map<string, Source>();
  const state: WeatherState = { rounds: 0, calls: 0, used: false };
  let location = searchLocation(o.where);
  const tools = () => [
    { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: quick ? 1 : 3, ...(location && { user_location: location }) },
    webFetch(choice.model, quick ? 1 : 2),
    ...(tool ? [WEATHER_TOOL] : []),
    ...data.map(claudeTool),
  ];
  let spent = 0;
  let maxTokens = budget.maxTokens;
  // The sources so far, in one list: the links cited first, then the others read, then the data's
  // sources (SEC EDGAR, FRED) and MET Norway's credit.
  const sources = () => {
    const web = [...cited.values(), ...[...read.values()].filter((s) => !cited.has(s.url))];
    const extra = [...ledger.sources(), ...(state.used ? tool!.sources : [])];
    return extra.length ? [...web.slice(0, 6), ...extra] : web.slice(0, 8);
  };
  // Whether any words were sent yet, and whether the next call may only answer (no searches or forecasts).
  let wroteAny = false;
  let answerOnly = false;
  try {
    // pause_turn means the server paused a long search loop, and tool_use that Claude asked for a
    // forecast; either way the turn goes back to Claude, as it is, to carry on.
    for (let call = 0; call < 4 + WEATHER_ROUNDS; call++) {
      running?.begin(choice.model, maxTokens);
      const stream = getClient().beta.messages.stream(
        {
          ...choiceParams(choice),
          max_tokens: maxTokens,
          system: instructions,
          tools: tools(),
          // tool_choice none also keeps the web search and page reader from running.
          ...(((own && state.rounds >= WEATHER_ROUNDS) || answerOnly) && { tool_choice: { type: "none" as const } }),
          messages,
        },
        { signal },
      );
      let wrote = false;
      // Words written before a forecast was asked for end their paragraph; the answer starts a new one.
      let gap = wroteAny && state.rounds > 0 ? "\n\n" : "";
      try {
        for await (const event of stream) {
          running?.see(event);
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            wrote = wroteAny = true;
            yield { type: "text", delta: gap + event.delta.text };
            gap = "";
          }
        }
      } catch (err) {
        // A location the search tool doesn't take: once, without it, before anything was written.
        if (err instanceof Anthropic.BadRequestError && location && !wrote && call === 0) {
          console.error("[flash] web search refused the user's location, searching without it", err.message);
          location = undefined;
          call--;
          continue;
        }
        throw err;
      }
      const final = await stream.finalMessage();
      spent += meterClaude(meter, final, choice.model, running);
      for (const block of final.content) {
        if (block.type === "text") {
          for (const c of block.citations ?? []) {
            if (c.type === "web_search_result_location" && !cited.has(c.url)) cited.set(c.url, { title: c.title ?? c.url, url: c.url });
          }
        }
        if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content) {
            if (r.type === "web_search_result" && !read.has(r.url)) read.set(r.url, { title: r.title, url: r.url });
          }
        }
        if (block.type === "web_fetch_tool_result" && block.content.type === "web_fetch_result") {
          const url = block.content.url;
          if (!read.has(url)) read.set(url, { title: block.content.content.title ?? url, url });
        }
      }
      if (final.stop_reason === "refusal") {
        yield refusalMessage(t);
        break;
      }
      if (final.stop_reason === "max_tokens") {
        yield lengthNote(budget, t);
        break;
      }
      const forecasts = own && final.stop_reason === "tool_use";
      if ((final.stop_reason !== "pause_turn" && !forecasts) || answerOnly) break;
      const content = echoedContent(final.content);
      const round = forecasts ? yield* replyRound(content, { weather: tool, state, onUsed: o.onUsed, signal, t, data, ledger, onTool: o.onTool }) : null;
      messages.push({ role: "assistant", content });
      if (round) messages.push({ role: "user", content: round.results });
      // Keep going only while the credits held for this request still cover another call: it reads
      // everything again, what the searches found and the forecasts included.
      // What the searches found and Claude read before its last words or call is in this call's usage
      // already; what came after (a paused search) it reads for the first time next call.
      let lastSaid = -1;
      content.forEach((b, i) => {
        if (b.type === "text" || b.type === "thinking" || b.type === "tool_use" || b.type === "server_tool_use") lastSaid = i;
      });
      // After a refusal fallback, the model that answered never read what the declined one found before
      // the last fallback block (see echoedContent), so the next call reads that for the first time too.
      const boundary = content.map((b) => b.type).lastIndexOf("fallback");
      const found = content.filter((b, i) => (i > lastSaid || i < boundary) && (b.type === "web_search_tool_result" || b.type === "web_fetch_tool_result"));
      const nextInput = inputOf(final.usage) + final.usage.output_tokens + tokensAtMost(JSON.stringify(found)) + (round?.tokens ?? 0);
      const left = budget.capCents - spent;
      maxTokens = Math.min(budget.maxTokens, tokensWithin("search", choice.model, nextInput, left, usesFallback(choice), plan));
      if (round && !(maxTokens >= (MIN_OUTPUT_TOKENS.search ?? 2000))) {
        // Too little left for more searches and forecasts after this one, and for a full answer: one last
        // call answers with what it has, with no tools (tool_choice none), so it is paid for as a single
        // call. (Room that grew with the credits held would otherwise give some a shorter answer.)
        answerOnly = true;
        maxTokens = Math.min(budget.maxTokens, tokensWithin("search", choice.model, nextInput, left, usesFallback(choice), NO_TOOLS));
      }
      if (!(maxTokens >= (round ? MIN_ROUND_TOKENS : (MIN_OUTPUT_TOKENS.search ?? 2000)))) {
        if (round) yield lengthNote(budget, t);
        break;
      }
    }
  } catch (err) {
    // A reply stopped or cut off part way still shows the links it found, credits MET Norway, and
    // carries FRED's notice when it showed FRED data.
    if (ledger.fred) yield { type: "text", delta: FRED_NOTE };
    const items = sources();
    if (items.length) yield { type: "sources", items };
    throw spent > 0 ? afterSpending(err) : err;
  }
  if (ledger.fred) yield { type: "text", delta: FRED_NOTE };
  // One list, sent once: the browser keeps only the last one a reply sends.
  const items = sources();
  if (items.length) yield { type: "sources", items };
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

// The prompt writer reads at most this much of a request, and of the brand kit and picture notes,
// and writes at most PROMPT_TOKENS: a prompt of under 90 words. It costs at most WRITER_ALLOWANCE_CENTS.
const MEDIA_REQUEST_CHARS = 2000;
const MEDIA_NOTES_CHARS = 1200;
const PROMPT_TOKENS = 300;
const rewriterSystem = (kind: keyof typeof PROMPT_REWRITERS, notes: string) =>
  `${PROMPT_REWRITERS[kind]} Reply with the prompt only.${notes ? `\n\n${notes.slice(0, MEDIA_NOTES_CHARS)}` : ""}`;

/** The most improvePrompt can cost, in cents. The price of a picture, video or track it writes for covers it. */
export const PROMPT_WRITER_MAX_CENTS = callMaxCents(
  HELPER_MODEL,
  Math.max(...(Object.keys(PROMPT_REWRITERS) as (keyof typeof PROMPT_REWRITERS)[]).map((k) => rewriterSystem(k, "x".repeat(MEDIA_NOTES_CHARS)).length)) +
    MEDIA_REQUEST_CHARS,
  PROMPT_TOKENS,
);

/** Turns a short media request into a detailed prompt for the image, video or music model. */
export async function improvePrompt(
  kind: keyof typeof PROMPT_REWRITERS,
  request: string,
  meter: Meter = noMeter,
  // The user's brand kit, for the rewriter to use when the request is for their business, and the
  // language of any words in the picture (see pictureWordsNote).
  brand = "",
): Promise<string> {
  const res = await getClient()
    .beta.messages.create(
      {
        model: HELPER_MODEL,
        max_tokens: PROMPT_TOKENS,
        ...HELPER_SETTINGS,
        system: rewriterSystem(kind, brand),
        messages: [{ role: "user", content: request.slice(0, MEDIA_REQUEST_CHARS) }],
      },
      // Kept short so a slow rewrite can't eat the time a video needs.
      { timeout: 15_000, maxRetries: 0 },
    )
    .catch((err: unknown) => meterLost(err, meter, PROMPT_WRITER_MAX_CENTS));
  meterClaude(meter, res, HELPER_MODEL);
  // A refusal, or a prompt cut off part way, leaves the request as the user wrote it.
  if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") return request;
  const text = res.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text");
  return text?.text.trim() || request;
}

// The scene writer reads at most this much of a movie idea, and writes at most SCENE_TOKENS: up to
// nine scenes of under 90 words each, in any language.
const MOVIE_REQUEST_CHARS = 3000;
const SCENE_TOKENS = 4000;
const scenesSystem = (scenes: number, seconds: number) =>
  `You are a film director. Turn the user's idea into a short film of exactly ${scenes} scenes, ` +
  `each about ${seconds} seconds, that tell the story from beginning to end. Write each scene as one prompt ` +
  "for a text-to-video model, under 90 words: the action, the camera movement, the lighting and the style. " +
  "Every clip is filmed separately, so describe the main characters (age, face, hair, clothes) and the setting " +
  "in the same exact words in every scene, and keep one visual style throughout. " +
  "Reply with a JSON array of strings only.";

/** The most writeScenes can cost, in cents. It must stay within the part of a movie's price for writing (MOVIE_EXTRA_CENTS). */
export const SCENE_WRITER_MAX_CENTS = callMaxCents(HELPER_MODEL, scenesSystem(99, 99).length + MOVIE_REQUEST_CHARS, SCENE_TOKENS);

/**
 * Splits a movie idea into scene prompts for a text-to-video model. Each scene repeats the full
 * description of the characters and setting, because every clip is filmed separately.
 */
export async function writeScenes(request: string, scenes: number, seconds: number, meter: Meter = noMeter): Promise<string[]> {
  const res = await getClient()
    .beta.messages.create(
      {
        model: HELPER_MODEL,
        max_tokens: SCENE_TOKENS,
        ...HELPER_SETTINGS,
        system: scenesSystem(scenes, seconds),
        messages: [{ role: "user", content: request.slice(0, MOVIE_REQUEST_CHARS) }],
      },
      { timeout: 30_000, maxRetries: 0 },
    )
    .catch((err: unknown) => meterLost(err, meter, SCENE_WRITER_MAX_CENTS));
  meterClaude(meter, res, HELPER_MODEL);
  const text = res.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")?.text ?? "";
  return parseScenes(text, scenes);
}

/**
 * A helper call that ended without an answer because the connection failed or timed out may still
 * have run, and Claude bills it, so it is metered at the most it can cost before the error goes on.
 * A call Claude refused with an error status never ran, so it costs nothing.
 */
export function meterLost(err: unknown, meter: Meter, mostCents: number, model = HELPER_MODEL): never {
  if (err instanceof Anthropic.APIConnectionError) meter("anthropic", model, mostCents);
  throw err;
}

/** Reads the scene list from a reply, which may come wrapped in a code fence. */
export function parseScenes(text: string, scenes: number): string[] {
  const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
  try {
    const list = (JSON.parse(json) as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "");
    if (list.length >= 1) return list.slice(0, scenes).map((x) => x.trim());
  } catch {
    // Falls through to the error below.
  }
  throw new Error("The scene writer didn't return a scene list.");
}

// What each answer the router may give is for, in the order it reads them. weather is Write with a
// live forecast (see weather.ts); the rest are the engines.
const ROUTER_GUIDE: [Engine | "weather", string][] = [
  [
    "weather",
    "the weather or forecast for a place, now or in the next days: rain, temperature, wind, snow, storms, humidity, UV, what to wear, whether to take an umbrella or go ahead with plans",
  ],
  ["text", "questions about things that don't change, advice, explanations, maths, writing, emails, brainstorming"],
  [
    "search",
    "anything else whose answer depends on today: news, prices and exchange rates, sports scores and fixtures, opening hours, travel and schedules, who currently holds a job or title, the latest version or release of anything, and anything the user asks to look up, check or cite",
  ],
  ["app", "build a working web app, website, tool, game, dashboard or landing page"],
  ["slides", "make a presentation or slide deck"],
  ["code", "write, fix or explain program code"],
  ["translate", "translate text into another language"],
  ["docs", "make a spreadsheet, table, budget, resume, report or formal document"],
  ["image", "make a picture, drawing, logo, illustration or photo"],
  ["video", "make a video clip"],
  ["voice", "read text aloud as speech"],
  ["music", "compose music, a song, jingle or beat"],
  ["transcribe", "turn a recording into text"],
];

const ROUTER_SYSTEM =
  "You route messages in Flash, an all-in-one AI app. Pick the one tool that best fits the user's latest message. " +
  "Messages can be in any language. A short follow-up (\"and tomorrow?\", \"what about Paris?\") continues the earlier message. " +
  "Reply with the tool name only.\n\n" +
  ROUTER_GUIDE.map(([answer, what]) => `${answer}: ${what}`).join("\n");
// The picture check reads at most this much of a message. It and the router answer in one word, and
// each costs at most CHECK_ALLOWANCE_CENTS.
const CHECK_MESSAGE_CHARS = 1000;
const CHECK_TOKENS = 10;
// The router reads at most ROUTER_BYTES bytes of UTF-8, and no text is fewer tokens than its bytes:
// its instructions (with the build and the question Flash asked), the earlier message (at most
// EARLIER_CHARS) and as much of the latest message as fits, up to ROUTER_MESSAGE_CHARS.
const ROUTER_BYTES = 5600;
const EARLIER_CHARS = 300;
const ROUTER_MESSAGE_CHARS = 2000;

/** The most classifyRequest can cost, in cents. */
export const ROUTER_MAX_CENTS = tokensMaxCents(HELPER_MODEL, ROUTER_BYTES, CHECK_TOKENS);

// How much of Flash's own question the router reads with a "yes" (see classifyRequest).
const OFFER_CHARS = 200;

const utf8 = new TextEncoder();
const utf8Bytes = (text: string) => utf8.encode(text).length;
/** The longest start of text that is at most n bytes of UTF-8, never cutting a character in two. */
const firstBytes = (text: string, n: number) => text.slice(0, utf8.encodeInto(text, new Uint8Array(Math.max(0, n))).read);

/**
 * Asks Haiku which engine fits a request the keyword rules couldn't place, or "weather" for a
 * question a live forecast answers. earlier: the user's message before this one, which a short
 * follow-up continues ("and tomorrow?"); previous: the engine of Flash's last reply. about: the app
 * or deck Flash just built in this chat, when the request was said about it ("it's too dark");
 * offer: the question Flash's last reply ended on, which a "yes" may answer ("Want me to add a dark
 * mode?"). timeoutMs is shorter for someone talking, who waits in silence.
 * Returns null on any doubt or error, so the caller keeps its default.
 */
export async function classifyRequest(
  message: string,
  meter: Meter = noMeter,
  {
    timeoutMs = 4000,
    about,
    offer,
    earlier,
    previous,
  }: { timeoutMs?: number; about?: Engine; offer?: string; earlier?: string; previous?: Engine } = {},
): Promise<Engine | "weather" | null> {
  const build = about === "app" || about === "slides";
  const system =
    ROUTER_SYSTEM +
    (build
      ? `\n\nFlash just made ${about === "app" ? "an app" : "a slide deck"} for this user, and they said this about it. ` +
        `Reply ${about} only if they ask for it to be changed, fixed or added to; reply text for thanks, questions and anything else.` +
        (offer ? ` Flash's last words to them were: "${offer.slice(-OFFER_CHARS)}" A yes to an offer to change it is a change.` : "")
      : "");
  const head = [
    earlier?.trim() && `Earlier message: ${earlier.trim().slice(0, EARLIER_CHARS)}`,
    previous && `The previous reply came from: ${previous}`,
    "Latest message: ",
  ]
    .filter(Boolean)
    .join("\n");
  // What's left of ROUTER_BYTES is the latest message's, so the call never costs more than ROUTER_MAX_CENTS.
  const content = head + firstBytes(message.slice(0, ROUTER_MESSAGE_CHARS), ROUTER_BYTES - utf8Bytes(system) - utf8Bytes(head));
  try {
    const res = await getClient()
      .messages.create(
        { model: HELPER_MODEL, max_tokens: CHECK_TOKENS, ...HELPER_SETTINGS, system, messages: [{ role: "user", content }] },
        { timeout: timeoutMs, maxRetries: 0 },
      )
      .catch((err: unknown) => meterLost(err, meter, ROUTER_MAX_CENTS));
    meter("anthropic", res.model, claudeCostCents(res.model, res.usage, HELPER_MODEL));
    const text = res.content.find((b) => b.type === "text");
    const word = text?.type === "text" ? text.text.trim().toLowerCase().replace(/[^a-z]/g, "") : "";
    if (word === "weather") return "weather";
    return (ENGINES as readonly string[]).includes(word) ? (word as Engine) : null;
  } catch {
    return null;
  }
}

// The engines the router may pick, the ones that never count tokens first, and the dearest, first.
const PICK_ORDER: Engine[] = ["video", "music", "image", "voice", "app", "slides", "search", "code", "docs", "translate"];

/**
 * Lets the router pick the engine for a request the keyword rules couldn't place (engine), but
 * only when the user can pay for the request on every engine it may pick, the router included. So
 * the router is always part of a paid request, whatever it picks: a request headed for the free lane
 * or for "you need more credits" never reaches a paid model, and nobody pays for a reply on an
 * engine they didn't ask for because the router's pick was too dear. plan prices a request on an
 * engine (with extraCents more for helpers still to run, and with the forecast tool when weather);
 * ready says whether an engine is set up. may says which engines the guess may move the request to:
 * any but text and transcribing unless the caller says otherwise (a voice conversation's, see
 * takesGuess in router.ts). weather: the guess may also answer with Write and a live forecast, which
 * must be paid for too. timeoutMs, about, offer, earlier and previous are passed on to classifyRequest.
 * answered says the router gave an answer, whether or not it moved the request.
 */
export async function guessEngine<P extends { live: boolean; needed: number }>(
  message: string,
  engine: Engine,
  available: number,
  plan: (engine: Engine, extraCents?: number, weather?: boolean) => Promise<P>,
  ready: (engine: Engine) => boolean,
  meter: Meter = noMeter,
  {
    may = (e: Engine) => e !== "text" && e !== "transcribe",
    weather = false,
    timeoutMs,
    about,
    offer,
    earlier,
    previous,
  }: {
    may?: (engine: Engine) => boolean;
    weather?: boolean;
    timeoutMs?: number;
    about?: Engine;
    offer?: string;
    earlier?: string;
    previous?: Engine;
  } = {},
): Promise<{ engine: Engine; plan: P; guessed: boolean; weather?: true; answered: boolean }> {
  const kept = async () => ({ engine, plan: await plan(engine), guessed: false, answered: false });
  const asRouted = await plan(engine, ROUTER_MAX_CENTS);
  if (!asRouted.live || available < asRouted.needed) return kept();
  // A guess is only a guess, so it never sends a request to an engine that isn't available yet.
  const picks = ENGINES.filter((e) => e !== engine && may(e) && ready(e));
  // Nowhere to move it, and no forecast to add, so the router has nothing to decide.
  if (!picks.length && !weather) return kept();
  const order = (e: Engine) => (PICK_ORDER.includes(e) ? PICK_ORDER.indexOf(e) : -1);
  picks.sort((a, b) => order(a) - order(b));
  const affordable = async (e: Engine, forecast = false) => {
    const p = await plan(e, ROUTER_MAX_CENTS, forecast);
    return !p.live || available >= p.needed;
  };
  // Pictures, video, music and voice have fixed prices, so they are checked first, one by one.
  const priced = picks.filter((e) => ["video", "music", "image", "voice"].includes(e));
  for (const e of priced) if (!(await affordable(e))) return kept();
  const rest = await Promise.all([...picks.filter((e) => !priced.includes(e)).map((e) => affordable(e)), ...(weather ? [affordable("text", true)] : [])]);
  if (rest.includes(false)) return kept();
  const guess = await classifyRequest(message, meter, { timeoutMs, about, offer, earlier, previous });
  if (guess === "weather" ? weather : guess && picks.includes(guess)) {
    const forecast = guess === "weather";
    const to: Engine = forecast ? "text" : (guess as Engine);
    const picked = await plan(to, undefined, forecast);
    if (picked.live && available >= picked.needed) return { engine: to, plan: picked, guessed: true, ...(forecast && { weather: true as const }), answered: true };
  }
  return { engine, plan: asRouted, guessed: false, answered: guess !== null };
}

export type PictureRequest = "change" | "new" | "other";

const pictureSystem = (above: boolean) =>
  `A user of Flash, an AI app, sent a message with a picture: ${above ? "the picture Flash just made for them, shown right above the message" : "a photo they attached"}. Reply with one word:\n` +
  "change: the message asks Flash for a changed version of that picture: edit it, fix it, restyle or recolour it, add or remove something, change its background, size or shape, put words on it, combine it, or animate it into a video.\n" +
  "new: it asks for a different picture that doesn't start from this one.\n" +
  "other: anything else: praise or thanks, a question about the picture or how it was made, an opinion, a complaint, saying not to change something, undoing a change or going back to an earlier picture, writing or numbers taken from the picture (a caption, post, description, notes, answers, sums, a rewrite of text shown in it), sharing, saving or deleting it, music or sound, or their account, credits or settings.";

/** The most pictureRequest can cost, in cents. */
export const PICTURE_CHECK_MAX_CENTS = callMaxCents(
  HELPER_MODEL,
  Math.max(pictureSystem(true).length, pictureSystem(false).length) + CHECK_MESSAGE_CHARS,
  CHECK_TOKENS,
);

/**
 * Asks Haiku whether a message sent with a picture asks for a changed version of it ("change"), for a
 * different picture ("new"), or for something else: thanks, a question, undoing a change, words taken
 * from the picture ("other"). The keyword rules can't know every way people say these, and a change
 * costs credits. Returns null on any doubt or error, so the caller keeps the rules' answer.
 */
export async function pictureRequest(message: string, above: boolean, meter: Meter = noMeter): Promise<PictureRequest | null> {
  try {
    const res = await getClient()
      .messages.create(
        {
          model: HELPER_MODEL,
          max_tokens: CHECK_TOKENS,
          ...HELPER_SETTINGS,
          system: pictureSystem(above),
          messages: [{ role: "user", content: message.slice(0, CHECK_MESSAGE_CHARS) }],
        },
        { timeout: 4000, maxRetries: 0 },
      )
      .catch((err: unknown) => meterLost(err, meter, PICTURE_CHECK_MAX_CENTS));
    meter("anthropic", res.model, claudeCostCents(res.model, res.usage, HELPER_MODEL));
    const text = res.content.find((b) => b.type === "text");
    const word = text?.type === "text" ? text.text.trim().toLowerCase().replace(/[^a-z]/g, "") : "";
    return word === "change" || word === "new" || word === "other" ? word : null;
  } catch {
    return null;
  }
}
