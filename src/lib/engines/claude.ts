import Anthropic from "@anthropic-ai/sdk";
import { ENGINES, type Attachment, type ChatTurn, type Engine, type Source, type StreamEvent } from "../types.ts";
import { levelName, type ModelLevel } from "../levels.ts";
import { MAX_OUTPUT_TOKENS, claudeCostCents, claudePrice, inputCostCents } from "../credits.ts";
import { english, type Translate } from "../i18n.ts";

/*
 * Flash uses three Claude models, to keep quality high where it shows and costs low elsewhere:
 * Opus for building apps, slides and code; Sonnet for everyday chat, writing, research and
 * translation; Haiku for tiny behind-the-scenes jobs like deciding which engine a request needs.
 * FLASH_TEXT_MODEL, if set, overrides the first two (for example to run everything on Opus).
 */
export const BUILD_MODEL = process.env.FLASH_BUILD_MODEL || process.env.FLASH_TEXT_MODEL || "claude-opus-5-5";
export const CHAT_MODEL = process.env.FLASH_CHAT_MODEL || process.env.FLASH_TEXT_MODEL || "claude-sonnet-5-5";
export const ROUTER_MODEL = process.env.FLASH_ROUTER_MODEL || "claude-haiku-4-5";

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

/** The model and effort one Claude request runs on, and the level to move to if that model can't answer. */
export type ClaudeChoice = { level: ModelLevel; model: string; effort: Effort; stepDown?: ClaudeChoice };

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

// Haiku has no server-side fallback, and sending one is an error.
const fallbackFor = (model: string) =>
  /haiku/.test(model) ? {} : { betas: ["server-side-fallback-2026-07-01"] as Anthropic.AnthropicBeta[], fallbacks: "default" as const };

/** The request settings a choice needs: its model, its effort, and a refusal fallback where the model has one. */
export const choiceParams = (choice: ClaudeChoice) => ({ model: choice.model, output_config: { effort: choice.effort }, ...fallbackFor(choice.model) });

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

/** The most a reply may spend: an output token cap, and a cost cap in cents for multi-step replies. */
export type Budget = { maxTokens: number; capCents: number };
export const NO_BUDGET: Budget = { maxTokens: MAX_OUTPUT_TOKENS, capCents: Infinity };

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

export const meterClaude = (meter: Meter, message: Anthropic.Beta.BetaMessage) =>
  meter("anthropic", message.model, claudeCostCents(message.model, message.usage));

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
    "You are acting as an expert software engineer. Give working, complete code in fenced code blocks " +
    "with the language named, then a short explanation. Point out bugs and edge cases.",
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
    "When analysing an attached file, lead with the key findings and the numbers behind them. " +
    "When reading text from photos or scans (receipts, menus, notes, letters, signs): copy the words exactly as " +
    "written, in their own language, keeping spelling, numbers and line breaks; write [unclear] for anything you " +
    "can't read and never guess a number. For receipts, invoices, menus, price lists and anything in rows, also give " +
    "the rows as a spreadsheet, with amounts as plain numbers and the currency in its own column. Copy totals as " +
    "printed and only work out new totals when asked.",
};

export function system(preferences: string, mode: WritingMode = "text"): string {
  const prefs = preferences.trim();
  const parts = [BASE_SYSTEM, MODE_PROMPTS[mode]];
  // Settings > General (the language to answer in, what to call them) comes first, then their memory.
  if (prefs) parts.push(`About the user, from their settings and what they asked Flash to remember. Follow their language setting in every answer:\n${prefs}`);
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
): AsyncGenerator<StreamEvent> {
  const stream = getClient().beta.messages.stream({
    ...choiceParams(choice),
    max_tokens: budget.maxTokens,
    system: system(preferences, mode),
    messages: toMessages(history),
  });
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield { type: "text", delta: event.delta.text };
    }
  }
  const final = await stream.finalMessage();
  meterClaude(meter, final);
  if (final.stop_reason === "refusal") yield refusalMessage(t);
  if (final.stop_reason === "max_tokens") yield lengthNote(budget, t);
}

function lengthNote(budget: Budget, t: Translate): StreamEvent {
  const note =
    budget.maxTokens < MAX_OUTPUT_TOKENS
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
): AsyncGenerator<StreamEvent> {
  const messages = toMessages(history);
  const sources = new Map<string, Source>();
  let spent = 0;
  let maxTokens = budget.maxTokens;
  // pause_turn means the server paused a long search loop; resend to let it continue.
  for (let round = 0; round < 4; round++) {
    const stream = getClient().beta.messages.stream({
      ...choiceParams(choice),
      max_tokens: maxTokens,
      system:
        system(preferences) +
        "\n\nSearch the web for current facts, read any page the user links, and keep the answer concise.",
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: 3 },
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: 2, max_content_tokens: 6000 },
      ],
      messages,
    });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text", delta: event.delta.text };
      }
    }
    const final = await stream.finalMessage();
    meterClaude(meter, final);
    spent += claudeCostCents(final.model, final.usage);
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
    const left = budget.capCents - spent - inputCostCents("search", choice.model, nextInput);
    maxTokens = Math.min(MAX_OUTPUT_TOKENS, Math.floor((left * 1e6) / claudePrice(choice.model, nextInput).output));
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

/** Turns a short media request into a detailed prompt for the image, video or music model. */
export async function improvePrompt(
  kind: keyof typeof PROMPT_REWRITERS,
  request: string,
  meter: Meter = noMeter,
  // The user's brand kit, for the rewriter to use when the request is for their business, and the
  // language of any words in the picture (see pictureWordsNote).
  brand = "",
): Promise<string> {
  const res = await getClient().beta.messages.create(
    {
      model: CHAT_MODEL,
      max_tokens: 2000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: `${PROMPT_REWRITERS[kind]} Reply with the prompt only.${brand ? `\n\n${brand}` : ""}`,
      messages: [{ role: "user", content: request.slice(0, 2000) }],
    },
    // Kept short so a slow rewrite can't eat the time a video needs.
    { timeout: 15_000, maxRetries: 0 },
  );
  meterClaude(meter, res);
  if (res.stop_reason === "refusal") return request;
  const text = res.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text");
  return text?.text.trim() || request;
}

/**
 * Splits a movie idea into scene prompts for a text-to-video model. Each scene repeats the full
 * description of the characters and setting, because every clip is filmed separately.
 */
export async function writeScenes(request: string, scenes: number, seconds: number, meter: Meter = noMeter): Promise<string[]> {
  const res = await getClient().beta.messages.create(
    {
      model: CHAT_MODEL,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system:
        `You are a film director. Turn the user's idea into a short film of exactly ${scenes} scenes, ` +
        `each about ${seconds} seconds, that tell the story from beginning to end. Write each scene as one prompt ` +
        "for a text-to-video model, under 90 words: the action, the camera movement, the lighting and the style. " +
        "Every clip is filmed separately, so describe the main characters (age, face, hair, clothes) and the setting " +
        "in the same exact words in every scene, and keep one visual style throughout. " +
        "Reply with a JSON array of strings only.",
      messages: [{ role: "user", content: request.slice(0, 3000) }],
    },
    { timeout: 30_000, maxRetries: 0 },
  );
  meterClaude(meter, res);
  const text = res.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")?.text ?? "";
  return parseScenes(text, scenes);
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

/**
 * Asks Haiku which engine fits a request the keyword rules couldn't place. about: the app or deck
 * Flash just built in this chat, when the request was said about it ("it's too dark").
 * Returns null on any doubt or error, so the caller keeps its default.
 */
export async function classifyRequest(message: string, meter: Meter = noMeter, timeoutMs = 4000, about?: Engine): Promise<Engine | null> {
  const system =
    "Pick the one tool that best fits the user's request. Reply with the tool name only.\n\n" +
    ENGINES.map((e) => `${e}: ${ENGINE_GUIDE[e]}`).join("\n") +
    (about === "app" || about === "slides"
      ? `\n\nFlash just made ${about === "app" ? "an app" : "a slide deck"} for this user, and they said this about it. ` +
        `Reply ${about} only if they ask for it to be changed, fixed or added to; reply text for thanks, questions and anything else.`
      : "");
  const content = message.slice(0, 2000);
  try {
    const res = await getClient().messages.create(
      { model: ROUTER_MODEL, max_tokens: 10, system, messages: [{ role: "user", content }] },
      { timeout: timeoutMs, maxRetries: 0 },
    );
    meter("anthropic", res.model, claudeCostCents(res.model, res.usage));
    const text = res.content.find((b) => b.type === "text");
    const word = text?.type === "text" ? text.text.trim().toLowerCase().replace(/[^a-z]/g, "") : "";
    return (ENGINES as readonly string[]).includes(word) ? (word as Engine) : null;
  } catch (err) {
    // A call that ran out of time may still be billed for reading the request: about a token for
    // every three characters, counted so the spend shows on the dashboard and in the request's price.
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      meter("anthropic", ROUTER_MODEL, claudeCostCents(ROUTER_MODEL, { input_tokens: Math.ceil((system.length + content.length) / 3), output_tokens: 0 }));
    }
    return null;
  }
}

export type PictureRequest = "change" | "new" | "other";

/**
 * Asks Haiku whether a message sent with a picture asks for a changed version of it ("change"), for a
 * different picture ("new"), or for something else: thanks, a question, undoing a change, words taken
 * from the picture ("other"). The keyword rules can't know every way people say these, and a change
 * costs credits. Returns null on any doubt or error, so the caller keeps the rules' answer.
 */
export async function pictureRequest(message: string, above: boolean, meter: Meter = noMeter): Promise<PictureRequest | null> {
  try {
    const res = await getClient().messages.create(
      {
        model: ROUTER_MODEL,
        max_tokens: 5,
        system:
          `A user of Flash, an AI app, sent a message with a picture: ${above ? "the picture Flash just made for them, shown right above the message" : "a photo they attached"}. Reply with one word:\n` +
          "change: the message asks Flash for a changed version of that picture: edit it, fix it, restyle or recolour it, add or remove something, change its background, size or shape, put words on it, combine it, or animate it into a video.\n" +
          "new: it asks for a different picture that doesn't start from this one.\n" +
          "other: anything else: praise or thanks, a question about the picture or how it was made, an opinion, a complaint, saying not to change something, undoing a change or going back to an earlier picture, writing or numbers taken from the picture (a caption, post, description, notes, answers, sums, a rewrite of text shown in it), sharing, saving or deleting it, music or sound, or their account, credits or settings.",
        messages: [{ role: "user", content: message.slice(0, 2000) }],
      },
      { timeout: 4000, maxRetries: 0 },
    );
    meter("anthropic", res.model, claudeCostCents(res.model, res.usage));
    const text = res.content.find((b) => b.type === "text");
    const word = text?.type === "text" ? text.text.trim().toLowerCase().replace(/[^a-z]/g, "") : "";
    return word === "change" || word === "new" || word === "other" ? word : null;
  } catch {
    return null;
  }
}
