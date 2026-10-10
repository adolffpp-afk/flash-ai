import Anthropic from "@anthropic-ai/sdk";
import { ENGINES, type Attachment, type ChatTurn, type Engine, type Source, type StreamEvent } from "../types.ts";
import { levelName, type ModelLevel } from "../levels.ts";
import {
  CLAUDE_PRICES,
  MAX_OUTPUT_TOKENS,
  WEB_SEARCH_CENTS,
  callMaxCents,
  claudeCostCents,
  claudePrice,
  fallbackModel,
  readCostCents,
  tokensWithin,
} from "../credits.ts";
import { english, type Translate } from "../i18n.ts";

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
 */
export function claudeChoice(engine: Engine, level: ModelLevel): ClaudeChoice {
  if (engine === "search" && level === "sonic") return claudeChoice(engine, "ascend");
  const effort: Effort = level === "sonic" ? "low" : engine === "app" || engine === "slides" || engine === "code" ? "high" : "medium";
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
const PEAK_TOKENS_PER_SECOND = 200;
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

/** Counts the tokens a conversation and its system prompt will cost to read, plus room for tools. */
export async function countInputTokens(model: string, history: ChatTurn[], systemPrompt = ""): Promise<number> {
  const messages = toMessages(history);
  try {
    const res = await getClient().beta.messages.countTokens({ model, messages, ...(systemPrompt && { system: systemPrompt }) });
    return res.input_tokens + 3000;
  } catch {
    // Counting failed: estimate on the high side (about 2.5 characters per token).
    return Math.ceil((JSON.stringify(messages).length + systemPrompt.length) / 2.5) + 3000;
  }
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

/** The line about Flash's other tools, from what's live (engineStatus()), or "" when none are. free: for the free models. */
export function otherToolsLine(status: Partial<Record<Engine, boolean>>, free = false): string {
  const live = (Object.keys(OTHER_TOOL_NAMES) as Engine[]).filter((e) => status[e]);
  if (!live.length) return "";
  const list = listed(live.map((e) => OTHER_TOOL_NAMES[e]!));
  if (free) return `Flash also makes ${list}, most of them with credits. When the user wants one of these, tell them to ask for it in their own words; never say Flash can't do them.`;
  const example = status.image ? ' (for example "Make a picture of a red bicycle")' : "";
  return `Flash also makes ${list}. When the user wants one of these, tell them to ask for it in their own words${example}; Flash switches tools by itself. Never say Flash can't do them.`;
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

export function toMessages(history: ChatTurn[]): Anthropic.Beta.BetaMessageParam[] {
  return history
    .filter((t) => t.content.trim() || t.attachment || t.app)
    .map((t) => ({ role: t.role, content: t.role === "user" ? toContent(t) : assistantContent(t) }));
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
 * server code; context: contextNote(where, now).
 */
export type SystemOptions = { web?: "search" | "none" | "free"; weather?: boolean; quick?: boolean; tools?: string; context?: string };

/**
 * A chat engine's system prompt. The text that never changes comes first and the per-minute context
 * last, so the prompt can be cached later: who Flash is, its other tools, what it can know of today,
 * the forecast tool, the mode, the user's settings and memory, then their date, time and place.
 */
export function system(preferences: string, mode: WritingMode | "search" = "text", o: SystemOptions = {}): string {
  const prefs = preferences.trim();
  const weather = Boolean(o.weather);
  const web = o.web ?? (mode === "search" ? "search" : "none");
  const parts = [
    BASE_SYSTEM,
    o.tools ?? "",
    WEB_LINES[web](weather),
    weather ? WEATHER_LINE : "",
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

/** Writing, code, translation, documents and file questions: streams Claude's reply token by token. */
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
  // The rest of the system prompt: the tools line, the context note (see system).
  o: { system?: SystemOptions } = {},
): AsyncGenerator<StreamEvent> {
  running?.begin(choice.model, budget.maxTokens);
  const stream = getClient().beta.messages.stream(
    {
      ...choiceParams(choice),
      max_tokens: budget.maxTokens,
      system: system(preferences, mode, o.system),
      messages: toMessages(history),
    },
    { signal },
  );
  for await (const event of stream) {
    running?.see(event);
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield { type: "text", delta: event.delta.text };
    }
  }
  const final = await stream.finalMessage();
  meterClaude(meter, final, choice.model, running);
  if (final.stop_reason === "refusal") yield refusalMessage(t);
  if (final.stop_reason === "max_tokens") yield lengthNote(budget, t);
}

function lengthNote(budget: Budget, t: Translate): StreamEvent {
  const note = budget.byCredits
    ? t("Flash stopped here because the reply reached what your credits cover. Ask it to continue.")
    : t("Flash stopped here because the reply reached its length limit. Ask it to continue.");
  return { type: "text", delta: `\n\n_${note}_` };
}

/** Research: Claude with server-side web search and page reading, returning the answer and its sources. */
export async function* streamSearch(
  history: ChatTurn[],
  preferences: string,
  meter: Meter = noMeter,
  budget: Budget = NO_BUDGET,
  choice: ClaudeChoice = defaultChoice("search"),
  // The language Flash's own notes (not the answer) are in.
  t: Translate = english,
  { signal, running }: Watch = {},
  o: { system?: SystemOptions } = {},
): AsyncGenerator<StreamEvent> {
  const messages = toMessages(history);
  const sources = new Map<string, Source>();
  let spent = 0;
  let maxTokens = budget.maxTokens;
  // pause_turn means the server paused a long search loop; resend to let it continue.
  for (let round = 0; round < 4; round++) {
    running?.begin(choice.model, maxTokens);
    const stream = getClient().beta.messages.stream(
      {
        ...choiceParams(choice),
        max_tokens: maxTokens,
        system: system(preferences, "search", o.system),
        tools: [
          { type: "web_search_20260209", name: "web_search", max_uses: 3 },
          { type: "web_fetch_20260209", name: "web_fetch", max_uses: 2, max_content_tokens: 6000 },
        ],
        messages,
      },
      { signal },
    );
    for await (const event of stream) {
      running?.see(event);
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text", delta: event.delta.text };
      }
    }
    const final = await stream.finalMessage();
    spent += meterClaude(meter, final, choice.model, running);
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
      yield refusalMessage(t);
      break;
    }
    if (final.stop_reason === "max_tokens") yield lengthNote(budget, t);
    if (final.stop_reason !== "pause_turn") break;
    // Keep searching only while the credits held for this request still cover another round.
    const nextInput = final.usage.input_tokens + final.usage.output_tokens;
    maxTokens = tokensWithin("search", choice.model, nextInput, budget.capCents - spent, usesFallback(choice));
    if (!(maxTokens >= 2000)) break;
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

const ENGINE_GUIDE: Record<Engine, string> = {
  text: "general questions, advice, explanations, writing, emails, brainstorming",
  app: "build a working web app, website, tool, game, dashboard or landing page",
  slides: "make a presentation or slide deck",
  search: "needs current or recent information from the web: news, prices, schedules, latest releases",
  code: "write, fix or explain program code",
  translate: "translate text into another language",
  docs: "make a spreadsheet, table, budget, resume, report or formal document",
  image: "make a picture, drawing, logo, illustration or photo",
  video: "make a video clip",
  voice: "read text aloud as speech",
  music: "compose music, a song, jingle or beat",
  transcribe: "turn a recording into text",
};

const ROUTER_SYSTEM =
  "Pick the one tool that best fits the user's request. Reply with the tool name only.\n\n" +
  ENGINES.map((e) => `${e}: ${ENGINE_GUIDE[e]}`).join("\n");
// The router and the picture check read at most this much of a message, and answer in one word.
// Each costs at most CHECK_ALLOWANCE_CENTS.
const CHECK_MESSAGE_CHARS = 1000;
const CHECK_TOKENS = 10;

/** The most classifyRequest can cost, in cents. */
export const ROUTER_MAX_CENTS = callMaxCents(HELPER_MODEL, ROUTER_SYSTEM.length + CHECK_MESSAGE_CHARS, CHECK_TOKENS);

// How much of Flash's own question the router reads with a "yes" (see classifyRequest).
const OFFER_CHARS = 200;

/**
 * Asks Haiku which engine fits a request the keyword rules couldn't place. about: the app or deck
 * Flash just built in this chat, when the request was said about it ("it's too dark"); offer: the
 * question Flash's last reply ended on, which a "yes" may answer ("Want me to add a dark mode?").
 * timeoutMs is shorter for someone talking, who waits in silence.
 * Returns null on any doubt or error, so the caller keeps its default.
 */
export async function classifyRequest(
  message: string,
  meter: Meter = noMeter,
  { timeoutMs = 4000, about, offer }: { timeoutMs?: number; about?: Engine; offer?: string } = {},
): Promise<Engine | null> {
  const build = about === "app" || about === "slides";
  const system =
    ROUTER_SYSTEM +
    (build
      ? `\n\nFlash just made ${about === "app" ? "an app" : "a slide deck"} for this user, and they said this about it. ` +
        `Reply ${about} only if they ask for it to be changed, fixed or added to; reply text for thanks, questions and anything else.` +
        (offer ? ` Flash's last words to them were: "${offer.slice(-OFFER_CHARS)}" A yes to an offer to change it is a change.` : "")
      : "");
  try {
    const res = await getClient()
      .messages.create(
        {
          model: HELPER_MODEL,
          max_tokens: CHECK_TOKENS,
          ...HELPER_SETTINGS,
          system,
          // A longer system prompt reads less of the message, so the call never costs more than ROUTER_MAX_CENTS.
          messages: [{ role: "user", content: message.slice(0, CHECK_MESSAGE_CHARS - (system.length - ROUTER_SYSTEM.length)) }],
        },
        { timeout: timeoutMs, maxRetries: 0 },
      )
      .catch((err: unknown) => meterLost(err, meter, ROUTER_MAX_CENTS));
    meter("anthropic", res.model, claudeCostCents(res.model, res.usage, HELPER_MODEL));
    const text = res.content.find((b) => b.type === "text");
    const word = text?.type === "text" ? text.text.trim().toLowerCase().replace(/[^a-z]/g, "") : "";
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
 * engine (with extraCents more for helpers still to run); ready says whether an engine is set up.
 * may says which engines the guess may move the request to: any but text and transcribing unless
 * the caller says otherwise (a voice conversation's, see takesGuess in router.ts). timeoutMs, about
 * and offer are passed on to classifyRequest.
 */
export async function guessEngine<P extends { live: boolean; needed: number }>(
  message: string,
  engine: Engine,
  available: number,
  plan: (engine: Engine, extraCents?: number) => Promise<P>,
  ready: (engine: Engine) => boolean,
  meter: Meter = noMeter,
  {
    may = (e: Engine) => e !== "text" && e !== "transcribe",
    timeoutMs,
    about,
    offer,
  }: { may?: (engine: Engine) => boolean; timeoutMs?: number; about?: Engine; offer?: string } = {},
): Promise<{ engine: Engine; plan: P; guessed: boolean }> {
  const kept = async () => ({ engine, plan: await plan(engine), guessed: false });
  const asRouted = await plan(engine, ROUTER_MAX_CENTS);
  if (!asRouted.live || available < asRouted.needed) return kept();
  // A guess is only a guess, so it never sends a request to an engine that isn't available yet.
  const picks = ENGINES.filter((e) => e !== engine && may(e) && ready(e));
  // Nowhere to move it, so the router has nothing to decide.
  if (!picks.length) return kept();
  const order = (e: Engine) => (PICK_ORDER.includes(e) ? PICK_ORDER.indexOf(e) : -1);
  picks.sort((a, b) => order(a) - order(b));
  const affordable = async (e: Engine) => {
    const p = await plan(e, ROUTER_MAX_CENTS);
    return !p.live || available >= p.needed;
  };
  // Pictures, video, music and voice have fixed prices, so they are checked first, one by one.
  const priced = picks.filter((e) => ["video", "music", "image", "voice"].includes(e));
  for (const e of priced) if (!(await affordable(e))) return kept();
  const rest = await Promise.all(picks.filter((e) => !priced.includes(e)).map(affordable));
  if (rest.includes(false)) return kept();
  const guess = await classifyRequest(message, meter, { timeoutMs, about, offer });
  if (guess && picks.includes(guess)) {
    const picked = await plan(guess);
    if (picked.live && available >= picked.needed) return { engine: guess, plan: picked, guessed: true };
  }
  return { engine, plan: asRouted, guessed: false };
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
