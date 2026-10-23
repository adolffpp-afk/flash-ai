import { after } from "next/server";
import { EDITABLE_TYPE, checksSpoken, fixesPictureText, followsForecast, route, takesGuess, textToSpeak } from "@/lib/router.ts";
import { asksWeather } from "@/lib/weather-words.ts";
import { asksEconomy, asksFilings } from "@/lib/research-words.ts";
import { claudeTool, FAMILY_TOOLS, FRED_NOTE, type ClientTool } from "@/lib/research.ts";
import { tokensAtMost } from "@/lib/tokens.ts";
import { dataTools, fredReady, searxngReady } from "@/lib/server/research-tools.ts";
import type { WeatherTool } from "@/lib/weather.ts";
import { weatherTool } from "@/lib/server/weather.ts";
import { MAX_EDIT_PIXELS, imageDimensions } from "@/lib/imageSize.ts";
import { ENGINES, ENGINE_LABELS, STOPPABLE_ENGINES, type Attachment, type ChatTurn, type Engine, type StreamEvent } from "@/lib/types.ts";
import { applyEvent } from "@/lib/apply-event.ts";
import type { UIMessage } from "@/lib/store.ts";
import {
  NO_BUDGET,
  PICTURE_CHECK_MAX_CENTS,
  Running,
  claudeChoice,
  claudeDown,
  defaultChoice,
  guessEngine,
  pictureRequest,
  claudeConfigured,
  countInputTokens,
  improvePrompt,
  otherToolsLine,
  streamSearch,
  streamText,
  system,
  withStepDown,
  writeScenes,
  writeAd,
  writeStory,
  type AdScript,
  type Budget,
  type ClaudeChoice,
  type Meter,
  type SystemOptions,
  type Watch,
  type WritingMode,
} from "@/lib/engines/claude.ts";
import { AUTO_GPT, autoLevel, isGptPick, isLevel, levelName, needsCare, type GptPick, type ModelLevel } from "@/lib/levels.ts";
import { GPT_ENGINES, GPT_MODELS, countGptTokens, gptChoice, gptConfigured, gptInstructions, muchCheaper, safetyId, streamGpt, type GptChoice } from "@/lib/engines/openai-chat.ts";
import { checkFiles } from "@/lib/attachments.ts";
import { infectedFile, scannerSetUp } from "@/lib/server/virus-scan.ts";
import { withInstructions } from "@/lib/project-instructions.ts";
import { profileNote } from "@/lib/names.ts";
import { pictureWordsNote } from "@/lib/languages.ts";
import { withVoiceStyle } from "@/lib/voice-chat.ts";
import { brandForMedia, withBrand } from "@/lib/brand.ts";
import { getBrand } from "@/lib/server/brand.ts";
import { one } from "@/lib/server/db.ts";
import { MESSAGE_ID, requestTurn, saveReply, saveTurn } from "@/lib/server/turns.ts";
import { stopRecorded, watchStop } from "@/lib/server/stops.ts";
import { readEngine } from "@/lib/server/engine-steps.ts";
import { PROJECT_FULL, roomForTurn } from "@/lib/project-size.ts";
import {
  FREE_CHAT_ENGINES,
  MIN_AUDIO_SECONDS,
  freeChatConfigured,
  freeEligible,
  freeImage,
  freeImageConfigured,
  freeTranscribe,
  freeTranscribeConfigured,
  freePassageRoom,
  streamFreeChat,
  type FreeLane,
} from "@/lib/engines/free.ts";
import {
  freeAudioFailed,
  freeLeft,
  recordFree,
  recordFreeAudio,
  releaseFreeUser,
  reserveFree,
  reserveFreeAudio,
  reserveFreeImage,
  reserveFreeUser,
} from "@/lib/server/free.ts";
import { billableSeconds, measureAudio, type MeasuredAudio } from "@/lib/server/audio-length.ts";
import { isVerified } from "@/lib/server/account.ts";
import {
  composeMusic,
  defaultModel,
  elevenConfigured,
  editImage,
  generateImage,
  ImageServiceDown,
  openaiConfigured,
  speechProvider,
  synthesizeSpeech,
  transcribe,
  NO_SPEECH,
  type Media,
} from "@/lib/engines/media.ts";
import { appUrl, getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { english, msg, type Translate } from "@/lib/i18n.ts";
import { charge, ensureMonthlyCredits, logUsage, settle, spendAccounts, spendable } from "@/lib/server/credits.ts";
import { readFile, saveFile } from "@/lib/server/files.ts";
import {
  MAX_SPEECH_CHARS,
  MIN_OUTPUT_TOKENS,
  TYPICAL_CREDITS,
  WEATHER_PLAN,
  claudePrice,
  connectPlan,
  creditsFor,
  finalCredits,
  planHold,
  researchPlan,
  tokensWithin,
  transcribeCostCents,
  voiceCostCents,
  voiceCredits,
  worstTokens,
  type ToolPlan,
} from "@/lib/credits.ts";
import { countOf, overLimit } from "@/lib/server/limits.ts";
import { falConfigured, falGenerate, type FalProgress } from "@/lib/engines/fal.ts";
import {
  MEDIA_ENGINES,
  PACK_IMAGE_CENTS,
  PACK_VIDEO_CENTS,
  PACK_VIDEO_ENDPOINT,
  PACK_VIDEO_SECONDS,
  MAX_EDIT_PHOTOS,
  helperAllowanceCents,
  modelById,
  modelCredits,
  requestCents,
  movieSplit,
  packWantsVideo,
  pickModel,
  type MediaEngine,
  type ModelInfo,
  type Provider,
} from "@/lib/models.ts";
import { unavailableReply } from "@/lib/engines/demo.ts";
import { FriendlyError, JobAbandoned, JobStopped } from "@/lib/engines/errors.ts";
import { buildSystem, latestApp, streamBuild } from "@/lib/engines/builder.ts";
import { contextNote, type Where } from "@/lib/context-note.ts";
import { whereFrom } from "@/lib/server/where.ts";
import { engineStatus } from "@/lib/server/status.ts";
import { CLIP_CENTS_PER_SECOND, MOVIE_EXTRA_CENTS, makeMovie } from "@/lib/engines/movie.ts";
import { fetchMade, filmAd, paintFrames } from "@/lib/engines/ad-studio.ts";
import { AD_WRITER_CENTS, adPlan, adStep, adVoiceChars, filmRequest, readStoryboard, samePlan, storyboardOf, type Storyboard } from "@/lib/ad-studio.ts";
import { filmPart, paintCast, paintScenes, type CastPictures } from "@/lib/engines/story-studio.ts";
import {
  STORY_WRITER_CENTS,
  filmPartRequest,
  nextPartRequest,
  readSeries,
  readStoryBoard,
  sameStoryPlan,
  storyBoardOf,
  storyPlan,
  storyStep,
  type Series,
  type StoryBoard,
  type StoryScript,
} from "@/lib/story-studio.ts";
import { STUDIO_MODELS } from "@/lib/models.ts";
import { studioOpenTo } from "@/lib/server/studio.ts";
import { sendPush } from "@/lib/server/push.ts";
import { DEFAULT_VOICE, pickVoice } from "@/lib/voices.ts";
import { falEditInput, falInput, packImageInput, packVideoInput, videoAspect } from "@/lib/engines/fal-input.ts";
import { writePack } from "@/lib/engines/post-pack.ts";
import { packMarkdown } from "@/lib/post-pack.ts";
import { CONFIRM_CREDITS, consents, decidedFor, type Decided } from "@/lib/price-question.ts";
import { WEATHER_TOOL } from "@/lib/weather.ts";
import { refuseUnpaid, type ConnectorKit } from "@/lib/engines/connect.ts";
import { chatKit, continuedCalls, requestedConnections } from "@/lib/server/connections.ts";
import { approvedResults, releaseResults } from "@/lib/server/pending-actions.ts";
import { accountReplies, continuedIds } from "@/lib/connectors.ts";
import { messageWindow } from "@/lib/message-window.ts";
import { maybeAutoTopUp } from "@/lib/server/auto-topup.ts";
import { ASSISTANTS_ON, MAX_ASSISTANT_FILES, MAX_PASSAGES } from "@/lib/assistants.ts";
import { answersAsAssistant, assistantSection } from "@/lib/assistant-prompt.ts";
import { VISITOR_DAILY_MESSAGES, VISITOR_REPLY_TOKENS } from "@/lib/assistant-cost.ts";
import { assistantSummary, countPassages, loadAssistantFor, type ChatAssistant } from "@/lib/server/assistants.ts";
import { passagesFor, type Reading } from "@/lib/server/assistant-search.ts";

// Vercel Pro allows up to 800 seconds, which the Movie maker needs (scenes, filming and joining).
// Price questions (409 confirm_cost) one user gets in an hour before the paid helpers stop deciding
// their requests (see askedOften).
const PRICE_QUESTIONS_AN_HOUR = 20;
// Fix all's prices (quote) one user can ask for in an hour: each is a token count at Anthropic.
const QUOTES_AN_HOUR = 120;
// A request that would now hold more than the most Fix all said it would (maxCredits).
const OVER_CAP = msg(
  "This change now needs more than the {credits} credits shown before you sent it, so Flash didn't send it and no credits were used. Press Fix all in the search check again to see what it needs now.",
);

export const maxDuration = 800;
// Claude replies end as stopped this long after the request started, so they're saved and settled
// within maxDuration: a Claude stream can't be picked up again in another call.
const DEADLINE_MS = 760_000;
// How long a Claude engine told to stop may take to hand over what it finished before (see the work below).
const DRAIN_MS = 15_000;
// What a reply says once the user pressed Stop on a picture, video or sound: one not yet being made
// stops, and one being made is finished, delivered and charged as usual.
const STOPPING = msg("Stopping…");
const FINISHING_AFTER_STOP = msg("This was already being made, so Flash is finishing it. It shows here when it's ready.");
// A build out of time can't be continued: the next request starts it again.
const BUILD_TOO_LONG = msg("The app was too large to finish in one go. Try asking for a simpler first version.");

// Vercel caps a request at 4.5 MB, and a file grows by a third when sent as base64.
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
// The engines that can read several files at once.
const WRITING_ENGINES: Engine[] = FREE_CHAT_ENGINES;
// Pictures Claude can look at, so the builder can work from screenshots and sketches.
const PICTURE_TYPE = /^image\/(png|jpeg|gif|webp)$/;
// A message longer than this (about 25,000 words) is almost certainly pasted by mistake.
const MAX_MESSAGE_CHARS = 100_000;
// The same limit as saved preferences (PATCH /api/me).
const MAX_PREFERENCES_CHARS = 2000;

type ChatRequest = {
  messages: ChatTurn[];
  engine?: Engine | "auto";
  preferences?: string;
  // The engine that produced the previous reply, so follow-ups can edit an app.
  previous?: Engine;
  // An image, video or music model the user picked; otherwise Flash picks one.
  model?: string;
  // The user agreed to this request's price (Go ahead, or yes in a voice conversation, with decided),
  // or to every price (Go ahead with "always", on their device). See CONFIRM_CREDITS.
  confirmed?: boolean;
  // The project this chat is in, for its instructions.
  projectId?: string;
  // The template the request was made from, named in the reply's header.
  template?: string;
  // Said out loud in a voice conversation: the writing engines answer in a few spoken sentences.
  voice?: boolean;
  // A change to the latest app from its preview (Fix it, or a part the user picked).
  build?: boolean;
  // The attached picture is the one Flash made in its last reply, sent with a follow-up like "make it darker".
  pictureAbove?: boolean;
  // Flash's level of intelligence for writing, research and building (see levels.ts); Auto when missing.
  level?: string;
  // With confirmed: what was decided and priced before the price was asked (see Decided), sent back as it came.
  decided?: Decided;
  // The reply's id and the user's message as the browser made them, and the id of the message they
  // follow (null for a chat's first), so the server saves the turn itself (see turns.ts).
  replyId?: string;
  userMessage?: unknown;
  afterId?: string | null;
  // What a new chat is called when the browser named it (a template's title), else its first message.
  name?: string;
  // The browser's time zone ("Africa/Lagos"), for the date and time in the models' instructions.
  timeZone?: string;
  // The user's connected accounts this chat has on (see connectors.ts): only their own are used, and
  // only while CONNECTOR_KEYS is set. actions: approved connector results to continue the answer with.
  connectors?: unknown;
  actions?: unknown;
  // Fix all in the search check (SEO) asks what its change would hold before it's sent: the request is
  // priced exactly as it would be sent, and nothing is run, charged or saved (see quote below).
  quote?: boolean;
  // The most the request may hold, and so be charged, as Fix all said before it was sent ("Up to N credits").
  // One that would now hold more isn't sent (see cap below).
  maxCredits?: number;
  // In a chat started with an assistant (see assistants.ts): the version of it the page shows, whose
  // price line the user saw, and readStart, "Read the start of each file" instead of searching them.
  // Ignored while assistants are off.
  assistantVersion?: number;
  readStart?: boolean;
};

function providers(): Set<Provider> {
  const set = new Set<Provider>();
  if (openaiConfigured()) set.add("openai");
  if (elevenConfigured()) set.add("elevenlabs");
  if (falConfigured()) set.add("fal");
  return set;
}

const isMedia = (engine: Engine): engine is MediaEngine => (MEDIA_ENGINES as Engine[]).includes(engine);

function configured(engine: Engine): boolean {
  if (engine === "voice" || engine === "transcribe") return Boolean(speechProvider());
  return claudeConfigured();
}

/** Runs a slow job, relaying its progress messages as status events every few seconds. */
async function* withProgress<T>(
  // emit: other events the job sends as it goes (a Studio scene as soon as it's filmed), in order.
  job: (report: (message: string) => void, emit: (event: StreamEvent) => void) => Promise<T>,
): AsyncGenerator<StreamEvent, T> {
  let latest = "";
  let reported = "";
  let finished = false;
  const queue: StreamEvent[] = [];
  const work = job(
    (message) => (latest = message),
    (event) => queue.push(event),
  ).finally(() => (finished = true));
  while (!finished || queue.length) {
    if (!finished) await Promise.race([work.catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    while (queue.length) yield queue.shift()!;
    if (latest && latest !== reported && !finished) {
      reported = latest;
      yield { type: "status", message: latest };
    }
  }
  return work;
}

/** Said while a Studio film is made: it goes on without the page. */
const LEAVE_PAGE = msg("You can close this page: Flash keeps filming and saves your film here.");

/**
 * Reports a fal job's progress in the user's language: working while it runs, waiting with its
 * place in line ({position}) while it waits. Both are marked msg("…") where they're passed.
 */
const falReport =
  (t: Translate, report: (message: string) => void, working: string, waiting: string) =>
  (_english: string, { position }: FalProgress) =>
    report(position === null ? t(working) : t(waiting, { position }));

/** Uses Claude to sharpen a media prompt when a Claude key exists, else sends the request as written. */
const sharpen = (kind: "image" | "video" | "music", request: string, meter: Meter, brand = "") =>
  claudeConfigured() ? improvePrompt(kind, request, meter, brand).catch(() => request) : Promise.resolve(request);

/** Notes that a priced provider job was sent, with what the provider will bill for it in cents. */
type Started = (cents: number) => void;

/** What run() tells the request as the job goes, and what stops it. */
type Track = {
  // Called just before each priced provider job is sent, so a stopped request pays for what was sent.
  // A job taken out of fal's queue on Stop never ran, so its cents are taken back (negative).
  started: Started;
  // Asked just before each provider job is sent: true when the user pressed Stop, so the job isn't
  // sent and the reply ends as stopped. A job already sent is finished and charged as usual, unless
  // it's still in fal's queue: stop tells falRun to take it out (see JobStopped).
  halted: () => Promise<boolean>;
  stop?: AbortSignal;
  // A movie filmed with fewer scenes than it was priced for is priced again at what was filmed, and a
  // photo edited by FLUX.2 Edit when ChatGPT's editor couldn't take it at FLUX.2 Edit's price, in cents.
  repriced: (cents: number) => void;
  // Stops a Claude call as soon as the user presses Stop, and keeps what the call has cost so far.
  watch: Watch;
  // A Claude helper the job runs (the prompt, scene or post writer), which a request stopped while it
  // runs waits for, so it is settled once the helper has been metered and pays for it.
  helper: <T>(call: Promise<T>) => Promise<T>;
  // A file of the user's (a storyboard the Ads Studio saved, and its pictures), or null.
  own?: (id: string) => Promise<Media | null>;
};
const NO_TRACK: Track = { started: () => {}, halted: async () => false, repriced: () => {}, watch: {}, helper: (call) => call };

/** A transcript under its heading, with Flash's own words in the user's language. */
const transcript = (name: string, text: string, t: Translate) =>
  `**${t("Transcript of {name}", { name })}**\n\n${text === NO_SPEECH ? t(NO_SPEECH) : text}`;

/** The bytes in a base64 attachment. */
const attachmentBytes = (a: { data: string }) => (a.data.length * 3) / 4;

// Each attachment is measured once, however often it's priced and sent.
const measuredFiles = new WeakMap<{ data: string }, MeasuredAudio | null>();

/** A recording measured (see audio-length.ts), or null when Flash can't read how long it plays. */
function measured(a: { data: string }): MeasuredAudio | null {
  if (!measuredFiles.has(a)) measuredFiles.set(a, measureAudio(Buffer.from(a.data, "base64")));
  return measuredFiles.get(a)!;
}

/** How long a recording plays, when Flash can measure it; 0 when it can't. */
function recordingSeconds(a: { data: string }): number {
  const m = measured(a);
  return m ? billableSeconds(m.length) : 0;
}

/**
 * The file to send to be transcribed: the clean copy of exactly what Flash measured, so nothing
 * hidden in the file is heard and billed. Files Flash can't measure are refused before this.
 */
function toTranscribe(a: Attachment): Attachment {
  const m = measured(a);
  if (!m) return a;
  const { data, mediaType, extension } = m.file;
  return { name: `${a.name.replace(/\.[^.]*$/, "")}.${extension}`, mediaType, data: data.toString("base64") };
}

/** What transcribing a file costs: its measured length, and at least what its size could hold. */
const transcriptCents = (a: { data: string }) => transcribeCostCents(attachmentBytes(a), recordingSeconds(a));

/** The question Flash's last reply ended on, which a spoken "yes" may answer: "Want me to add a dark mode?" */
function offered(history: ChatTurn[]): string | undefined {
  const reply = history.at(-2);
  if (reply?.role !== "assistant" || typeof reply.content !== "string") return undefined;
  return reply.content.trim().slice(-300).match(/[^.!?\n]+\?$/)?.[0].trim();
}

/** The voice engine speaks at most MAX_SPEECH_CHARS, and is priced on exactly that text. */
const spokenText = (message: string) => textToSpeak(message).slice(0, MAX_SPEECH_CHARS);

/**
 * What every system prompt in a request adds to its mode: Flash's other tools that work now, and the
 * user's date, time and rough place, taken once so every call in the request sends the same words.
 * build is the builders' note, without the clock; free is the free models' (see otherToolsLine).
 */
type Prompting = {
  system: SystemOptions;
  free: SystemOptions;
  build: string;
  where?: Where;
  // In a chat with an assistant: its section, for Claude and the free models (see assistant-prompt.ts),
  // and whether Research leaves out its page reader (someone else's assistant, now or before
  // "Continue without it").
  assistant?: string;
  freeAssistant?: string;
  noFetch?: boolean;
};

const DAY_MS = 24 * 3600_000;

/** The history with passages from an assistant's files on its newest turn; without any, as it was. */
function withPassages(history: ChatTurn[], passages: { title: string; text: string }[]): ChatTurn[] {
  if (!passages.length) return history;
  return [...history.slice(0, -1), { ...history[history.length - 1], passages: passages.map(({ title, text }) => ({ title, text })) }];
}

/**
 * The free models' system options: their tools line and context note, with the chat's assistant's
 * section in its free form. Only their chat lane writes words, on engines that all answer as it.
 */
function freeSystem(prompting: Prompting): SystemOptions {
  return prompting.freeAssistant ? { ...prompting.free, assistant: prompting.freeAssistant } : prompting.free;
}

/**
 * What a Claude chat engine's system prompt adds to its mode: the tools line and the context note,
 * and in a chat with an assistant, its section, with Research's page reader left out in someone
 * else's (and in a chat that had someone else's). Only the engines that answer as it send this
 * prompt (a build has its own, see systemFor). The engine and systemFor both use it, so the hold
 * counts what's sent.
 */
function systemOptions(engine: Engine, prompting: Prompting): SystemOptions {
  const noFetch = engine === "search" && prompting.noFetch === true;
  if (!prompting.assistant && !noFetch) return prompting.system;
  return { ...prompting.system, ...(prompting.assistant && { assistant: prompting.assistant }), ...(noFetch && { noFetch: true }) };
}

function promptingFor(where: Where, now: Date, picked: boolean): Prompting {
  const status = engineStatus();
  const context = contextNote(where, now);
  return {
    system: { tools: otherToolsLine(status, false, picked), context },
    free: { tools: otherToolsLine(status, true, picked), context },
    build: contextNote(where, now, { clock: false }),
    where,
  };
}

// The engines that answer in words with a live forecast when one is asked for (see weather-words.ts).
const WEATHER_ENGINES: Engine[] = ["text", "docs", "search"];
// Asks Research for more than a quick look, so it searches in full.
const DEEP_RESEARCH =
  /\b(research|in[- ]depth|thorough|compare|comparison|versus|vs\.?|pros and cons|sources|cite|citations?|studies|evidence|literature|report|analysis|history of|everything about)\b/i;

/**
 * The tools a reply in words has beyond its engine's own: the live forecast (hintOnly when only a
 * weather word asked for it, see weather-words.ts), for Research, the quick plan of one search and
 * one page read, and the SEC EDGAR (filings) and FRED (economy) tools when the message asks about a
 * public company's filings or figures, or an economic indicator (see research-words.ts).
 */
type Tools = { weather: boolean; hintOnly: boolean; quick: boolean; connect?: boolean; filings?: boolean; economy?: boolean };
const NO_EXTRA_TOOLS: Tools = { weather: false, hintOnly: false, quick: false };
// The engines that answer in words with SEC EDGAR's and FRED's data when a message asks for it.
const DATA_ENGINES: Engine[] = ["text", "docs", "search"];
/** The data tools' definitions a reply has, as Claude reads them: SEC EDGAR's, then FRED's. */
const dataDefinitions = (tools: Tools) => [...(tools.filings ? FAMILY_TOOLS.sec : []), ...(tools.economy ? FAMILY_TOOLS.fred : [])].map(claudeTool);
/** Whether a reply has tools of Flash's own to call (the forecast, SEC EDGAR, FRED): each round of them is priced as a forecast's. */
const ownTools = (tools: Tools) => tools.weather || Boolean(tools.filings) || Boolean(tools.economy);
// The engines that use the user's connected accounts when a chat has them on. Research keeps its web
// search instead (the connector loop has no server tools), and building and media don't use them.
const CONNECT_ENGINES: Engine[] = ["text", "code", "translate", "docs"];
/** Whether a message has a name in it as a word of its own, in any script and any case. */
const namesWord = (message: string, name: string) =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "iu").test(message);
// What a request with connectors on says when the user can't pay for it: never the free lane.
const CONNECTORS_NEED_CREDITS = msg("Connectors use credits. Turn them off to keep chatting for free.");
// And a chat with a reply that used them: turning them off doesn't take that reply out of the chat.
const CONNECTED_CHAT_NEEDS_CREDITS = msg("This chat used your connected accounts, so it needs credits. Start a new chat to keep chatting for free.");
// The same, when chatting for free isn't open to them now (today's free messages are used up, or
// this request couldn't go free anyway): the way out isn't offered.
const CONNECTORS_USE_CREDITS = msg("Connectors use credits.");
const CONNECTED_CHAT_USES_CREDITS = msg("This chat used your connected accounts, so it needs credits.");

/**
 * Whether a chat has a reply that used a connected account (see accountReplies): marked so by the
 * browser on any turn it sent, or in the chat as the server saved it, so a page loaded before the
 * mark existed is held to it too.
 */
async function usedAccounts(sent: unknown, projectId: unknown, userId: string): Promise<boolean> {
  if (Array.isArray(sent) && sent.some((turn) => typeof turn === "object" && turn !== null && (turn as ChatTurn).usedConnector === true)) return true;
  if (typeof projectId !== "string") return false;
  const saved = await one<{ messages: string }>("SELECT messages FROM projects WHERE id = ? AND user_id = ?", [projectId, userId]);
  try {
    const messages: unknown = JSON.parse(saved?.messages ?? "[]");
    return Array.isArray(messages) && accountReplies(messages.filter((m) => typeof m === "object" && m !== null)).size > 0;
  } catch {
    return false;
  }
}

/** The system prompt a Claude engine sends, exactly, so the credit hold counts it too. */
function systemFor(engine: Engine, preferences: string, history: ChatTurn[], prompting: Prompting, tools: Tools = NO_EXTRA_TOOLS): string {
  if (engine === "app" || engine === "slides") return buildSystem(engine, preferences, latestApp(history) !== null, prompting.build);
  const { weather, quick } = tools;
  // The data tools' lines, as the engine adds them for the tools it gets (see toolFlags).
  const data = { ...(tools.filings && { filings: true }), ...(tools.economy && { economy: true }) };
  if (engine === "search") return system(preferences, "search", { ...systemOptions(engine, prompting), weather, quick, ...data });
  return system(preferences, engine === "code" || engine === "translate" || engine === "docs" ? engine : "text", {
    ...systemOptions(engine, prompting),
    weather,
    connect: Boolean(tools.connect),
    ...data,
  });
}

/**
 * The tool calls a reply's hold pays for (see ToolPlan): Research's searches, the forecast's rounds
 * (SEC EDGAR's and FRED's share them, and are priced the same), and the connectors' steps.
 */
const toolPlan = (engine: Engine, tools: Tools): ToolPlan | undefined =>
  engine === "search" ? researchPlan(tools.quick, ownTools(tools)) : tools.connect ? connectPlan(ownTools(tools)) : ownTools(tools) ? WEATHER_PLAN : undefined;

/** What a media request on this model cost Flash, in cents, with the number of photos it was given. */
const mediaCents = (model: ModelInfo, request: string, photos = 1) => requestCents(model, request, photos);

type Store = (media: Media, name: string) => Promise<string>;

const EXTENSIONS: Record<string, string> = { jpeg: "jpg", mpeg: "mp3", "svg+xml": "svg", quicktime: "mov" };

/** "flash-image.png" becomes "flash-image.jpg" when the image is really a JPEG. */
function withExtension(name: string, mime: string): string {
  const subtype = mime.split("/")[1]?.split(";")[0].trim().toLowerCase();
  if (!subtype || !/^[\w.+-]+$/.test(subtype)) return name;
  return name.replace(/\.\w+$/, "") + "." + (EXTENSIONS[subtype] ?? subtype);
}

/**
 * A social post pack: Claude writes the three posts and the picture, FLUX.2 Pro paints it square
 * and tall at once, and Kling animates the tall one when a video was asked for. Each part is
 * metered as it finishes, so a pack that fails part way costs only what was really made.
 */
async function* postPack(
  request: string,
  about: string,
  brandNote: string,
  model: ModelInfo,
  store: Store,
  meter: Meter,
  { started, helper, halted, stop }: Track,
  t: Translate,
): AsyncGenerator<StreamEvent> {
  if (!claudeConfigured()) throw new FriendlyError(msg("Social post packs aren't available yet. Please try again later."));
  yield { type: "status", message: t("Writing your posts and hashtags…") };
  const pack = await helper(writePack(request, about, meter, brandNote)).catch((err) => {
    if (err instanceof FriendlyError) throw err;
    console.error("[flash] post pack writing failed", err);
    throw new FriendlyError(msg("Flash couldn't write the posts this time. Please try again."));
  });
  const video = packWantsVideo(request);
  const seconds = { seconds: PACK_VIDEO_SECONDS };
  yield {
    type: "text",
    delta:
      packMarkdown(pack.posts) +
      "\n\n" +
      t("**Pictures:** square for Instagram and Facebook posts, tall for TikTok, Reels and Stories.") +
      " " +
      (video
        ? t("The {seconds} second video is silent, so you can add a trending sound in TikTok or Instagram.", seconds)
        : t('For a {seconds} second video too, ask for "a social post pack with a video".', seconds)),
  };
  yield { type: "posts", posts: pack.posts };

  yield { type: "status", message: t("Painting a square and a tall picture with FLUX.2 Pro…") };
  const billPicture = (err: unknown): never => {
    if (err instanceof JobAbandoned && err.billed) meter("fal", "flux-2-pro", PACK_IMAGE_CENTS);
    throw err;
  };
  const shapes = ["square", "tall"] as const;
  // Kept in English, as the picture's label in the chat, and shown in the user's language there.
  const labels = { square: msg("Square, for posts"), tall: msg("Tall, for TikTok, Reels and Stories") };
  // Stopped while the posts were written: the posts are ready, and nothing is painted.
  if (await halted()) return;
  started(shapes.length * PACK_IMAGE_CENTS);
  const pictures = yield* withProgress((report) => {
    const painting = falReport(t, report, msg("Painting your pictures… working"), msg("Painting your pictures… in line (position {position})"));
    return Promise.allSettled(
      shapes.map((shape) =>
        falGenerate(model.endpoint!, packImageInput(pack.picture, shape), painting, undefined, stop).then(
          (image) => (meter("fal", "flux-2-pro", PACK_IMAGE_CENTS), image),
          billPicture,
        ),
      ),
    );
  });
  // A picture still in fal's line when Stop was pressed was taken out of it, and isn't paid for.
  const unpainted = pictures.filter((r) => r.status === "rejected" && r.reason instanceof JobStopped).length;
  started(-unpainted * PACK_IMAGE_CENTS);
  for (const [i, result] of pictures.entries()) {
    if (result.status !== "fulfilled") continue;
    yield { type: "image", url: await store(result.value, `flash-post-${shapes[i]}.png`), prompt: pack.picture, label: labels[shapes[i]] };
  }
  const failed = pictures.findIndex((r) => r.status === "rejected" && !(r.reason instanceof JobStopped));
  if (failed !== -1) {
    console.error(`[flash] post pack ${shapes[failed]} picture failed`, (pictures[failed] as PromiseRejectedResult).reason);
    throw new FriendlyError(
      shapes[failed] === "square"
        ? msg("The square picture didn't come out, but your posts are ready above. Please try again for the pictures.")
        : msg("The tall picture didn't come out, but your posts are ready above. Please try again for the pictures."),
    );
  }
  if (unpainted) throw new JobStopped();
  const tall = pictures[1].status === "fulfilled" ? pictures[1].value : null;
  if (!video || !tall) return;
  // Stopped while the pictures were painted: they're delivered, and the video isn't filmed.
  if (await halted()) return;

  yield { type: "status", message: t("Filming a {seconds} second video from the tall picture. This usually takes one to three minutes…", seconds) };
  started(PACK_VIDEO_CENTS);
  const clip = yield* withProgress((report) =>
    falGenerate(
      PACK_VIDEO_ENDPOINT,
      packVideoInput(`data:${tall.mime};base64,${tall.data.toString("base64")}`, pack.motion),
      falReport(t, report, msg("Filming your video… working"), msg("Filming your video… in line (position {position})")),
      undefined,
      stop,
    ).catch((err) => {
      if (err instanceof JobStopped) {
        started(-PACK_VIDEO_CENTS);
        throw err;
      }
      if (err instanceof JobAbandoned && err.billed) meter("fal", "kling-3-animate", PACK_VIDEO_CENTS);
      console.error("[flash] post pack video failed", err);
      throw new FriendlyError(msg("The video didn't come out, but your posts and pictures are ready above."));
    }),
  );
  meter("fal", "kling-3-animate", PACK_VIDEO_CENTS);
  yield { type: "video", url: await store(clip, "flash-post-video.mp4"), prompt: pack.motion || pack.picture };
}

/** The id of a file of the user's from the URL saveFile gave it. */
const fileId = (url: string) => url.slice(url.lastIndexOf("/") + 1);

/** The script of an ad, as the chat shows it. */
function adScriptMarkdown(script: AdScript, t: Translate): string {
  const lines = [`**${script.title || t("Your ad")}**`, "", ...script.scenes.map((s, i) => `${i + 1}. ${s.picture}`)];
  if (script.voiceover) lines.push("", `**${t("Voiceover:")}** ${script.voiceover}`);
  if (script.music) lines.push("", `**${t("Music:")}** ${script.music}`);
  return lines.join("\n");
}

const NO_STORYBOARD = msg("Flash couldn't find that storyboard. Please make it again in the Infinity AI Studio.");

/**
 * Flash Infinity AI Studio's Ads Studio (see ad-studio.ts): a storyboard (the script and each scene's
 * first frame, kept to film later), filming a storyboard made before, or both at once. Each is priced
 * at the most it can cost, and charged as made (repriced).
 */
async function* adStudio(last: ChatTurn, store: Store, meter: Meter, track: Track, t: Translate): AsyncGenerator<StreamEvent> {
  const { started, halted, helper, stop, repriced, own } = track;
  const step = adStep(last.content);
  const plan = adPlan(last.content);
  const job = { meter, started, stop, t };
  let script: AdScript;
  let frames: string[];
  // What was made before filming, in cents: the script and the pictures.
  let before = 0;
  if (step === "film") {
    const id = storyboardOf(last.content)!;
    const file = own ? await own(id) : null;
    const board = file && readStoryboard(file.data.toString("utf8"));
    // Filmed with the choices it was priced with, which are the storyboard's own.
    if (!board || !samePlan(board.plan, plan)) throw new FriendlyError(NO_STORYBOARD);
    const pictures = await Promise.all(board.frames.map((frame) => own!(frame)));
    if (pictures.some((p) => !p)) throw new FriendlyError(NO_STORYBOARD);
    frames = pictures.map((p) => `data:${p!.mime};base64,${p!.data.toString("base64")}`);
    script = board.script;
  } else {
    const photo = last.attachment && /^image\//.test(last.attachment.mediaType) ? last.attachment : null;
    yield { type: "status", message: t("Writing the script for your ad…") };
    script = await helper(writeAd(last.content, { scenes: plan.scenes, seconds: plan.seconds, voiceChars: adVoiceChars(plan), product: Boolean(photo) }, meter)).catch((err) => {
      console.error("[flash] ad script failed", err);
      throw err instanceof FriendlyError ? err : new FriendlyError(msg("Flash couldn't write the script for this ad. Nothing was filmed. Please try again."));
    });
    yield { type: "text", delta: adScriptMarkdown(script, t) };
    // Stopped while the script was written: it's shown, and nothing is painted.
    if (await halted()) return;
    const painted = yield* withProgress((report) =>
      paintFrames(plan, script, photo ? `data:${photo.mediaType};base64,${photo.data}` : null, { ...job, onProgress: report }),
    );
    frames = painted.urls;
    before = AD_WRITER_CENTS + painted.cents;
    if (step === "storyboard") {
      const saved: string[] = [];
      for (const [i, url] of frames.entries()) {
        const picture = await fetchMade(url, "image/jpeg");
        const at = await store(picture, `flash-ad-scene-${i + 1}.jpg`);
        saved.push(fileId(at));
        yield { type: "image", url: at, prompt: script.scenes[i].motion, label: t("Scene {number}", { number: i + 1 }) };
      }
      const board: Storyboard = { v: 1, plan, script, frames: saved };
      const id = fileId(await store({ data: Buffer.from(JSON.stringify(board)), mime: "application/json" }, "flash-ad-storyboard.json"));
      repriced(before);
      yield { type: "storyboard", id, film: filmRequest(id, plan) };
      yield { type: "text", delta: "\n\n" + t("Happy with it? Press Film it in HD below. To change something, make the storyboard again with new words.") };
      return;
    }
    // Stopped while the scenes were painted: the script is shown, and nothing is filmed.
    if (await halted()) {
      repriced(before);
      return;
    }
  }
  yield { type: "status", message: t("Filming every scene at once in HD. This usually takes three to eight minutes…") };
  // The narrator the script asked for, from Flash's voices (see voices.ts).
  const voice = pickVoice(`in a ${(script.voice || "warm, clear").slice(0, 30)} voice`);
  const ad = yield* withProgress((report, emit) =>
    filmAd(plan, script, frames, voice, {
      ...job,
      onProgress: (message) => report(`${message} ${t(LEAVE_PAGE)}`),
      onClip: (i, url) => emit({ type: "scene", url, label: t("Scene {number}", { number: i + 1 }) }),
    }),
  );
  repriced(before + ad.cents);
  yield { type: "video", url: await store(ad.video, "flash-ad.mp4"), prompt: script.title || last.content };
  if (ad.notes.length) yield { type: "text", delta: "\n\n" + ad.notes.join(" ") };
}

/** A part's script as the chat shows it: its title, then each scene with its lines. */
function storyMarkdown(script: StoryScript["part"], part: number, series: string, t: Translate): string {
  const lines = [`**${series ? `${series} · ` : ""}${t("Part {number}", { number: part })}${script.title ? `: ${script.title}` : ""}**`, ""];
  for (const [i, scene] of script.scenes.entries()) {
    lines.push(`${i + 1}. ${scene.action}`);
    for (const l of scene.lines) lines.push(`   - **${l.who}:** ${l.line}`);
  }
  return lines.join("\n");
}

/** What the story writer is told of a series so far: its style, its cast and each part's summary. */
const seriesNote = (series: Series) =>
  JSON.stringify({
    title: series.title,
    style: series.style,
    cast: series.cast.map(({ name, look, voice }) => ({ name, look, voice })),
    parts: series.parts.map(({ part, title, summary }) => ({ part, title, summary })),
  });

const NO_SERIES = msg("Flash couldn't find this story. Please start it again in the Infinity AI Studio.");

/**
 * Flash Infinity AI Studio's Story mode (see story-studio.ts). A part's storyboard: the script, a new
 * series' cast painted front and side, and each scene's first frame, kept to film. Filming it: every
 * scene with its dialogue spoken, then the part, and the button for the next one. Each step is priced
 * at the most it can cost, and charged as made (repriced).
 */
async function* storyStudio(last: ChatTurn, store: Store, meter: Meter, track: Track, t: Translate): AsyncGenerator<StreamEvent> {
  const { started, halted, helper, stop, repriced, own } = track;
  const plan = storyPlan(last.content);
  const job = { meter, started, stop, t };
  const read = async (id: string) => (own ? await own(id) : null);
  const dataUri = (m: Media) => `data:${m.mime};base64,${m.data.toString("base64")}`;
  // A series' characters' pictures, from the user's files, to send to fal.
  const castPictures = async (series: Series): Promise<CastPictures[]> => {
    const files = await Promise.all(series.cast.flatMap((c) => [read(c.front), read(c.side)]));
    if (files.some((f) => !f)) throw new FriendlyError(NO_SERIES);
    return series.cast.map((_, i) => ({ front: dataUri(files[2 * i]!), side: dataUri(files[2 * i + 1]!) }));
  };

  if (storyStep(last.content) === "film") {
    const file = await read(storyBoardOf(last.content)!);
    const board = file && readStoryBoard(file.data.toString("utf8"));
    // Filmed with the choices it was priced with, which are the storyboard's own.
    if (!board || !sameStoryPlan(board.plan, plan)) throw new FriendlyError(NO_SERIES);
    const frames = await Promise.all(board.frames.map(read));
    if (frames.some((f) => !f)) throw new FriendlyError(NO_SERIES);
    const pictures = await castPictures(board.series);
    yield { type: "status", message: t("Filming every scene at once, with the characters speaking. This usually takes four to nine minutes…") };
    const filmed = yield* withProgress((report, emit) =>
      filmPart(board.plan, board.part.scenes, frames.map((f) => dataUri(f!)), board.series.cast, pictures, board.series.style, {
        ...job,
        onProgress: (message) => report(`${message} ${t(LEAVE_PAGE)}`),
        onClip: (i, url) => emit({ type: "scene", url, label: t("Scene {number}", { number: i + 1 }) }),
      }),
    );
    repriced(filmed.cents);
    yield { type: "video", url: await store(filmed.video, `flash-story-part-${board.plan.part}.mp4`), prompt: board.part.title || board.series.title };
    // The series with this part in it, which the next part continues.
    const series: Series = { ...board.series, parts: [...board.series.parts, { part: board.plan.part, title: board.part.title, summary: board.part.summary }] };
    const id = fileId(await store({ data: Buffer.from(JSON.stringify(series)), mime: "application/json" }, "flash-story-series.json"));
    const next = board.plan.part + 1;
    yield { type: "storyboard", id, film: nextPartRequest(id, next, board.plan), model: "story-studio", next };
    yield { type: "text", delta: "\n\n" + t("Part {number} is ready. Press Make Part {next} below to continue the story with the same characters.", { number: board.plan.part, next }) };
    return;
  }

  // A next part continues a series made before; a first part starts one.
  let series: Series | null = null;
  if (plan.series) {
    const file = await read(plan.series);
    series = file && readSeries(file.data.toString("utf8"));
    if (!series) throw new FriendlyError(NO_SERIES);
  }
  yield { type: "status", message: series ? t("Writing part {number} of your story…", { number: plan.part }) : t("Writing your story and its characters…") };
  const script = await helper(writeStory(last.content, plan, series ? seriesNote(series) : "", meter)).catch((err) => {
    console.error("[flash] story script failed", err);
    throw err instanceof FriendlyError ? err : new FriendlyError(msg("Flash couldn't write this part of the story. Nothing was filmed. Please try again."));
  });
  if (!series && !script.cast.length) throw new FriendlyError(msg("Flash couldn't write this part of the story. Nothing was filmed. Please try again."));
  const title = series?.title || script.title;
  yield { type: "text", delta: storyMarkdown(script.part, plan.part, title, t) };
  if (await halted()) {
    repriced(STORY_WRITER_CENTS);
    return;
  }
  let made = STORY_WRITER_CENTS;
  let pictures: CastPictures[];
  if (series) {
    pictures = await castPictures(series);
  } else {
    // A new series: its characters, painted and kept, and shown as its cast.
    const cast = yield* withProgress((report) => paintCast(script.cast, script.style, { ...job, onProgress: report }));
    made += cast.cents;
    const kept: Series["cast"] = [];
    for (const [i, c] of script.cast.entries()) {
      const front = await fetchMade(cast.pictures[i].front, "image/jpeg");
      const side = await fetchMade(cast.pictures[i].side, "image/jpeg");
      const at = await store(front, `flash-story-${i + 1}-front.jpg`);
      kept.push({ ...c, front: fileId(at), side: fileId(await store(side, `flash-story-${i + 1}-side.jpg`)) });
      yield { type: "image", url: at, prompt: c.look, label: c.name };
    }
    series = { v: 1, title: script.title, style: script.style, shape: plan.shape, cast: kept, parts: [] };
    pictures = cast.pictures;
    if (await halted()) {
      repriced(made);
      return;
    }
  }
  const painted = yield* withProgress((report) => paintScenes(plan, script.part.scenes, series!.cast, pictures, series!.style, { ...job, onProgress: report }));
  made += painted.cents;
  const frames: string[] = [];
  for (const [i, url] of painted.urls.entries()) {
    const at = await store(await fetchMade(url, "image/jpeg"), `flash-story-scene-${i + 1}.jpg`);
    frames.push(fileId(at));
    yield { type: "image", url: at, prompt: script.part.scenes[i].action, label: t("Scene {number}", { number: i + 1 }) };
  }
  const board: StoryBoard = { v: 1, plan, series, part: script.part, frames };
  const id = fileId(await store({ data: Buffer.from(JSON.stringify(board)), mime: "application/json" }, "flash-story-board.json"));
  repriced(made);
  yield { type: "storyboard", id, film: filmPartRequest(id, plan), model: "story-studio" };
  yield { type: "text", delta: "\n\n" + t("Happy with it? Press Film it in HD below. The characters will speak their lines. To change something, write the part again with new words.") };
}

async function* run(
  engine: Engine,
  history: ChatTurn[],
  preferences: string,
  store: Store,
  model: ModelInfo | null,
  meter: Meter,
  budget: Budget,
  // The brand kit and the language of words in pictures, for the picture and video prompt writer, or "".
  brandNote = "",
  // The level a Claude engine runs on, and what to do when it steps down to another.
  choice: ClaudeChoice | null = null,
  onStepDown: (choice: ClaudeChoice) => void = () => {},
  // What the job tells the request as it goes, and what stops it.
  track: Track = NO_TRACK,
  // The language Flash's own words (progress, notes, errors) are in.
  t: Translate & { language?: string } = english,
  // What the system prompt adds to the mode (see promptingFor); systemFor counts the same words.
  prompting: Prompting = { system: {}, free: {}, build: "" },
  // The live forecast for an answer in words, what to do once it's used, Research's quick plan, the
  // user's connected accounts for Write, Code, Translate and Docs, and SEC EDGAR's and FRED's tools,
  // with what to do once each tool's data is first used. gpt: the ChatGPT model the user picked
  // answers instead of Claude (see planFor), with none of these tools. backup: Auto's ChatGPT model
  // for a level that is busy or down, when it can answer within the hold (see AUTO_GPT), and what to
  // do once it does.
  tools: {
    weather?: WeatherTool;
    onUsed?: () => void;
    quick?: boolean;
    connect?: ConnectorKit;
    data?: ClientTool[];
    onTool?: (name: string) => void;
    gpt?: GptChoice | null;
    backup?: (from: ClaudeChoice) => Promise<{ choice: GptChoice; budget: Budget } | null>;
    onBackup?: (from: ClaudeChoice, choice: GptChoice) => void;
  } = {},
): AsyncGenerator<StreamEvent> {
  const last = history[history.length - 1];
  const { started, watch, helper, halted, stop } = track;
  const { weather, onUsed, quick, connect, data, onTool, gpt, backup, onBackup } = tools;
  if (isMedia(engine) ? !model : !configured(engine)) {
    yield* unavailableReply(engine, t);
    return;
  }
  // A media job the provider bills even though it ended without a result is charged too.
  const billIfAbandoned = (err: unknown): never => {
    if (err instanceof JobAbandoned && err.billed) meter(model!.provider, model!.id, mediaCents(model!, last.content));
    throw err;
  };
  // A job taken out of fal's queue on Stop never ran, so it isn't paid for (see JobStopped).
  const unqueued =
    (cents: number) =>
    (err: unknown): never => {
      if (err instanceof JobStopped) started(-cents);
      throw err;
    };
  // The same for voice and transcription, which have no model entry.
  const billSpeech =
    (job: string, cents: number) =>
    (err: unknown): never => {
      if (err instanceof JobAbandoned && err.billed) meter(speechProvider()!, job, cents);
      throw err;
    };
  switch (engine) {
    case "text":
    case "code":
    case "translate":
    case "docs": {
      if (gpt) {
        yield* streamGpt(history, preferences, engine, meter, budget, gpt, t, watch, { system: systemOptions(engine, prompting) });
        return;
      }
      // The level answering, after any step-down, and whether it wrote anything yet.
      let current = choice ?? claudeChoice(engine, "ascend");
      let wrote = false;
      try {
        const reply = withStepDown(
          current,
          (c) => {
            current = c;
            return streamText(history, preferences, engine, meter, budget, c, t, watch, { system: systemOptions(engine, prompting), weather, onUsed, connect, data, onTool });
          },
          onStepDown,
          t,
        );
        for await (const event of reply) {
          if (event.type !== "status") wrote = true;
          yield event;
        }
      } catch (err) {
        // Claude is busy or down and never started: Auto's ChatGPT backup answers, when it can.
        const instead = !wrote && claudeDown(err) && backup ? await backup(current) : null;
        if (!instead) throw err;
        console.error(`[flash] ${current.model} is down (${(err as { status?: number }).status}), ${instead.choice.model} answering`);
        onBackup?.(current, instead.choice);
        yield { type: "status", message: t("{level} is busy right now, so {instead} is answering…", { level: levelName(current.level), instead: levelName(instead.choice.level) }) };
        let answered = false;
        try {
          for await (const event of streamGpt(history, preferences, engine, meter, instead.budget, instead.choice, t, watch, { system: systemOptions(engine, prompting) })) {
            if (event.type !== "status") answered = true;
            yield event;
          }
        } catch (gptErr) {
          // Both busy: Claude's error says to try again (ChatGPT's would say to pick a Flash level).
          throw answered ? gptErr : err;
        }
      }
      return;
    }
    case "search":
      yield* withStepDown(
        choice ?? claudeChoice(engine, "ascend"),
        (c) =>
          streamSearch(history, preferences, meter, budget, c, t, watch, {
            system: systemOptions(engine, prompting),
            where: prompting.where,
            noFetch: prompting.noFetch === true,
            weather,
            onUsed,
            quick,
            data,
            onTool,
          }),
        onStepDown,
        t,
      );
      return;
    case "app":
    case "slides":
      yield* withStepDown(
        choice ?? claudeChoice(engine, "vision"),
        (c) => streamBuild(history, preferences, engine, meter, budget, c, t, watch, { context: prompting.build }),
        onStepDown,
        t,
      );
      return;
    case "image": {
      if (model!.edits) {
        const photo = last.attachment!;
        // The editor at work: ChatGPT's, until OpenAI can't take the job and FLUX.2 Edit makes the change.
        let editor = model!;
        // Photos after the first are combined with it; only FLUX.2 Edit is given more than one.
        const more = editor.id === "flux-2-edit" ? (last.more ?? []).slice(0, MAX_EDIT_PHOTOS - 1) : [];
        const dataUrl = (f: Attachment) => `data:${f.mediaType};base64,${f.data}`;
        if (await halted()) return;
        yield { type: "status", message: more.length ? t("Combining your photos with {model}…", { model: editor.label }) : t("Working on your photo with {model}…", { model: editor.label }) };
        let cents = mediaCents(editor, last.content, 1 + more.length);
        // A job that ended without a result is charged when the provider bills it anyway.
        const billed = (err: unknown): never => {
          if (err instanceof JobAbandoned && err.billed) meter(editor.provider, editor.id, cents);
          throw err;
        };
        started(cents);
        if (editor.provider === "openai") {
          const made = await editImage(photo, last.content, imageDimensions(Buffer.from(photo.data, "base64")))
            .catch(billed)
            .catch((err: unknown) => {
              if (!(err instanceof ImageServiceDown) || !falConfigured()) throw err;
              console.error(`[flash] OpenAI can't edit photos right now, so FLUX.2 Edit is: ${err.message}`);
              return null;
            });
          if (made) {
            if (made.cents !== null && made.cents > cents) console.warn(`[flash] a photo edit cost ${made.cents.toFixed(2)} cents, over its price of ${cents}`);
            meter(editor.provider, editor.id, made.cents ?? cents);
            yield { type: "image", url: await store(made, "flash-edit.png"), prompt: last.content };
            return;
          }
          // OpenAI never ran it, so it costs nothing, and the change costs only what FLUX.2 Edit charges.
          started(-cents);
          editor = modelById("flux-2-edit")!;
          cents = mediaCents(editor, last.content);
          track.repriced(cents);
          if (await halted()) return;
          yield { type: "status", message: t("Working on your photo with {model}…", { model: editor.label }) };
          started(cents);
        }
        const edited = yield* withProgress((report) =>
          falGenerate(
            editor.endpoint!,
            // Each photo was checked to be at most 2048 × 2048 before credits were held.
            falEditInput(editor, dataUrl(photo), imageDimensions(Buffer.from(photo.data, "base64")), last.content, more.map(dataUrl)),
            falReport(t, report, msg("Working…"), msg("In line (position {position})…")),
            undefined,
            stop,
          )
            .catch(billed)
            .catch(unqueued(cents)),
        );
        meter(editor.provider, editor.id, cents);
        yield { type: "image", url: await store(edited, `flash-${editor.id === "flux-2-edit" ? "edit" : editor.id}.png`), prompt: last.content };
        return;
      }
      if (model!.id === "post-pack") {
        yield* postPack(last.content, preferences, brandNote, model!, store, meter, track, t);
        return;
      }
      const prompt = await helper(sharpen("image", last.content, meter, brandNote));
      if (await halted()) return;
      yield { type: "status", message: t("Painting your image with {model}…", { model: model!.label }) };
      started(mediaCents(model!, last.content));
      const image =
        model!.provider === "fal"
          ? yield* withProgress((report) =>
              falGenerate(
                model!.endpoint!,
                falInput(model!, prompt, last.content),
                falReport(t, report, msg("Working…"), msg("In line (position {position})…")),
                undefined,
                stop,
              )
                .catch(billIfAbandoned)
                .catch(unqueued(mediaCents(model!, last.content))),
            )
          : await generateImage(prompt);
      meter(model!.provider, model!.id, mediaCents(model!, last.content));
      yield { type: "image", url: await store(image, "flash-image.png"), prompt };
      return;
    }
    case "video": {
      if (model!.edits) {
        const photo = last.attachment!;
        if (await halted()) return;
        yield { type: "status", message: t("Bringing your photo to life with {model}. This usually takes one to three minutes…", { model: model!.label }) };
        started(mediaCents(model!, last.content));
        const clip = yield* withProgress((report) =>
          falGenerate(
            model!.endpoint!,
            falEditInput(model!, `data:${photo.mediaType};base64,${photo.data}`, null, last.content),
            falReport(t, report, msg("Animating… working"), msg("Animating… in line (position {position})")),
            undefined,
            stop,
          )
            .catch(billIfAbandoned)
            .catch(unqueued(mediaCents(model!, last.content))),
        );
        meter(model!.provider, model!.id, mediaCents(model!, last.content));
        yield { type: "video", url: await store(clip, "flash-animated.mp4"), prompt: last.content };
        return;
      }
      if (model!.id === "ad-studio") {
        yield* adStudio(last, store, meter, track, t);
        return;
      }
      if (model!.id === "story-studio") {
        yield* storyStudio(last, store, meter, track, t);
        return;
      }
      if (model!.id === "movie") {
        // The same split the price came from (see movieSplit).
        const { scenes: count, seconds } = movieSplit(last.content);
        yield { type: "status", message: t("Writing {count} scenes for your movie…", { count }) };
        const scenes = claudeConfigured()
          ? await helper(writeScenes(last.content, count, seconds, meter)).catch((err) => {
              console.error("[flash] scene writing failed", err);
              throw new FriendlyError(msg("Flash couldn't write the scenes for this movie. Nothing was filmed. Please try again."));
            })
          : // Prompts for the video model, so in English.
            Array.from({ length: count }, (_, i) => `Scene ${i + 1} of ${count}: ${last.content}`);
        // Fewer scenes than asked for are filmed as they are, and paid for as filmed.
        if (scenes.length < count) track.repriced(scenes.length * seconds * CLIP_CENTS_PER_SECOND + MOVIE_EXTRA_CENTS);
        yield {
          type: "text",
          delta: `**${t("Your movie, in {count} scenes:", { count: scenes.length })}**\n\n${scenes.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
        };
        // Stopped while the scenes were written: they're shown, and nothing is filmed.
        if (await halted()) return;
        yield { type: "status", message: t("Filming every scene at once. This usually takes three to eight minutes…") };
        started(scenes.length * seconds * CLIP_CENTS_PER_SECOND);
        const movie = yield* withProgress((report) => makeMovie(model!.endpoint!, scenes, seconds, meter, report, videoAspect(last.content), t));
        yield { type: "video", url: await store(movie, "flash-movie.mp4"), prompt: last.content };
        return;
      }
      const prompt = await helper(sharpen("video", last.content, meter, brandNote));
      if (await halted()) return;
      yield { type: "status", message: t("Filming your video with {model}. This usually takes one to three minutes…", { model: model!.label }) };
      started(mediaCents(model!, last.content));
      // Every video model is on fal.ai (see models.ts).
      const video: Media = yield* withProgress((report) =>
        falGenerate(
          model!.endpoint!,
          falInput(model!, prompt, last.content),
          falReport(t, report, msg("Filming your video… working"), msg("Filming your video… in line (position {position})")),
          undefined,
          stop,
        )
          .catch(billIfAbandoned)
          .catch(unqueued(mediaCents(model!, last.content))),
      );
      meter(model!.provider, model!.id, mediaCents(model!, last.content));
      yield { type: "video", url: await store(video, "flash-video.mp4"), prompt };
      return;
    }
    case "voice": {
      if (await halted()) return;
      const words = spokenText(last.content);
      const { voice, speed } = pickVoice(last.content);
      const named = speechProvider() === "fal";
      const quoted = words.length > 80 ? words.slice(0, 80) + "…" : words;
      yield {
        type: "text",
        delta:
          (named
            ? (t.language ?? "en") === "en"
              ? t('Here is "{words}" read aloud by {voice}, a {about}.', { words: quoted, voice: voice.name, about: voice.about })
              : // The voice's description is built from English words, so other languages leave it out.
                t('Here is "{words}" read aloud by {voice}.', { words: quoted, voice: voice.name })
            : t('Here is "{words}" read aloud.', { words: quoted })) +
          (named && voice === DEFAULT_VOICE ? " " + t('For another voice, ask for one, like "in a deep British man\'s voice".') : ""),
      };
      const voiceCents = voiceCostCents(words.length);
      started(voiceCents);
      const speech = await synthesizeSpeech(words, { voice: voice.name, speed }).catch(billSpeech("voice", voiceCents));
      meter(speechProvider()!, "voice", voiceCents);
      yield { type: "audio", url: await store(speech, "flash-voice.mp3"), label: "flash-voice.mp3" };
      return;
    }
    case "music": {
      const prompt = await helper(sharpen("music", last.content, meter));
      if (await halted()) return;
      yield { type: "status", message: t("Composing your track with {model}…", { model: model!.label }) };
      yield { type: "text", delta: `**${t("Track brief:")}** ${prompt}` };
      started(mediaCents(model!, last.content));
      const track =
        model!.provider === "fal"
          ? yield* withProgress((report) =>
              falGenerate(
                model!.endpoint!,
                falInput(model!, prompt, last.content),
                falReport(t, report, msg("Composing… working"), msg("Composing… in line (position {position})")),
                undefined,
                stop,
              )
                .catch(billIfAbandoned)
                .catch(unqueued(mediaCents(model!, last.content))),
            )
          : await composeMusic(prompt);
      meter(model!.provider, model!.id, mediaCents(model!, last.content));
      yield { type: "audio", url: await store(track, "flash-music.mp3"), label: "flash-music.mp3" };
      return;
    }
    case "transcribe": {
      if (!last.attachment) {
        yield { type: "text", delta: t("Attach an audio or video file with the 📎 button and Flash will transcribe it.") };
        return;
      }
      if (await halted()) return;
      yield { type: "status", message: t("Transcribing {name}…", { name: last.attachment.name }) };
      const transcribeCents = transcriptCents(last.attachment);
      started(transcribeCents);
      const text = await transcribe(toTranscribe(last.attachment)).catch(billSpeech("transcribe", transcribeCents));
      meter(speechProvider()!, "transcribe", transcribeCents);
      yield { type: "text", delta: transcript(last.attachment.name, text, t) };
      return;
    }
  }
}

/** The free lane: models on providers' free tiers, for users who are out of credits. */
async function* runFree(
  lane: FreeLane,
  engine: Engine,
  history: ChatTurn[],
  preferences: string,
  store: Store,
  used: { provider: string; model: string },
  // Where the user is, for free models that may only answer some countries.
  country = "",
  t: Translate = english,
  // Seconds of Groq's free audio held for a transcript, set once they're taken.
  audio: { reserved?: number } = {},
  // The free models' tools line and the context note (see promptingFor).
  system: SystemOptions = {},
  // The live forecast, what to do once it's used, the language the user's answers are set to, the data
  // tools (web search, SEC EDGAR, FRED) with what to do once each is used, and the request's signal.
  chat: { weather?: WeatherTool; onUsed?: () => void; language?: string; tools?: ClientTool[]; onTool?: (name: string) => void; signal?: AbortSignal; maxTokens?: number } = {},
): AsyncGenerator<StreamEvent> {
  const last = history[history.length - 1];
  if (lane === "image") {
    if (!(await reserveFreeImage())) {
      throw new FriendlyError(msg("Today's free images are used up across Flash. They reset tomorrow, or you can get more credits."));
    }
    used.provider = "cloudflare";
    used.model = "flux-1-schnell";
    yield { type: "status", message: t("Painting your image with FLUX.1 schnell (free)…") };
    const image = await freeImage(last.content);
    yield { type: "image", url: await store(image, "flash-image.jpg"), prompt: last.content };
    return;
  }
  if (lane === "transcribe") {
    const file = last.attachment!;
    // Groq counts at least 10 seconds a file.
    const reserve = Math.max(MIN_AUDIO_SECONDS, Math.ceil(recordingSeconds(file)));
    if (!(await reserveFreeAudio(reserve))) {
      throw new FriendlyError(msg("Today's free transcripts are used up across Flash. They reset tomorrow, or you can get more credits."));
    }
    audio.reserved = reserve;
    used.provider = "groq";
    used.model = "whisper-large-v3-turbo";
    yield { type: "status", message: t("Transcribing {name} with Whisper (free)…", { name: file.name }) };
    const { text, seconds: counted } = await freeTranscribe(toTranscribe(file));
    await recordFreeAudio(counted, reserve);
    yield { type: "text", delta: transcript(file.name, text, t) };
    return;
  }
  yield* streamFreeChat(
    history,
    preferences,
    engine as WritingMode,
    reserveFree,
    recordFree,
    (label, provider) => {
      used.provider = provider;
      used.model = label;
    },
    { country, system, ...chat },
  );
}

/** What the error message says about credits after a failed request, after a space. */
function refundNote(held: number, credits: number, t: Translate): string {
  if (!held) return "";
  if (!credits) return " " + t("Your credits were refunded.");
  if (credits >= held) return " " + t("The AI provider charged for the work already done, so this used {credits} credits.", { credits });
  return " " + t("Your credits were partly refunded: {credits} paid for the work already done.", { credits });
}

/** Why a picture, video or music model was picked (see pickModel), in the user's language. */
function pickedWhy({ model, why }: { model: ModelInfo; why: string }, t: Translate): string {
  if (why === "you picked it") return t("you picked it");
  if (why === "the default") return t("the default");
  // The model's blurb: lowercased in English (as pickModel gives it), as the table writes it in another language.
  const blurb = t(model.blurb);
  return blurb === model.blurb ? why : blurb;
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const user = await getUser(request);
  if (!user) return unauthorized();
  // Flash's own words in the reply (errors, why an engine and a level were picked, progress) are in
  // the language Flash is shown in. The answers themselves follow the user's language setting.
  const t = await translatorFor(request, user.language);
  let body: ChatRequest;
  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return Response.json({ error: t("Invalid JSON") }, { status: 400 });
  }
  // Tool blocks and passages from an assistant's files are put on turns by the server only (a reply
  // continued with approved results, a chat with an assistant).
  const history: ChatTurn[] = (Array.isArray(body.messages) ? body.messages : [])
    .slice(-30)
    .map((turn) => ({ ...turn, toolCalls: undefined, toolResults: undefined, passages: undefined }));
  const last = history[history.length - 1];
  if (!last || last.role !== "user") {
    return Response.json({ error: t("The last message must be from the user.") }, { status: 400 });
  }
  if (last.attachment && attachmentBytes(last.attachment) > MAX_ATTACHMENT_BYTES) {
    return Response.json({ error: t("Files must be 3 MB or smaller.") }, { status: 413 });
  }
  const filesProblem = checkFiles(last.attachment, last.more, t);
  if (filesProblem) return Response.json({ error: filesProblem }, { status: 413 });
  const override =
    body.engine && body.engine !== "auto" && (ENGINES as readonly string[]).includes(body.engine) ? body.engine : null;
  // A quote is only for a change to an app or deck (Fix all), which no paid helper reads first: the
  // router only reads a request on Auto, and the picture check a picture or video request. Anthropic
  // counts its tokens for free, but only so often, so each user gets QUOTES_AN_HOUR, counted before
  // the virus scan or anything else that costs, so a quote past them costs nothing. A request that
  // isn't a quote passes both checks untouched.
  const quote = body.quote === true;
  if (quote && !(body.build === true && (override === "app" || override === "slides"))) {
    return Response.json({ error: t("Only a change to an app or slides can be priced before it's sent.") }, { status: 400 });
  }
  if (quote && (await overLimit(`quote:${user.id}`, QUOTES_AN_HOUR, 3600_000))) {
    return Response.json({ error: t("Too many requests. Try again in an hour.") }, { status: 429 });
  }
  // Every file in the conversation goes to the AI again, so each is checked (a clean one only once a week).
  const sent = history
    .flatMap((turn) => (turn.attachment ? [turn.attachment, ...(Array.isArray(turn.more) ? turn.more : [])] : []))
    .filter((f): f is Attachment => typeof f?.data === "string" && typeof f.name === "string");
  const infected = scannerSetUp() && (await infectedFile(sent.map((f) => ({ name: f.name, bytes: Buffer.from(f.data, "base64") }))));
  if (infected) {
    return Response.json(
      { error: t("Flash found a virus in {name}, so it won't open it. Delete it from your device.", { name: infected.slice(0, 120) }) },
      { status: 422 },
    );
  }
  const severalFiles = Boolean(last.more?.length);
  if (typeof last.content !== "string" || last.content.length > MAX_MESSAGE_CHARS) {
    return Response.json(
      { error: t("This message is too long. Send a shorter one, or attach the text as a file.") },
      { status: 413 },
    );
  }

  const previous = body.previous && (ENGINES as readonly string[]).includes(body.previous) ? body.previous : undefined;
  const spoken = body.voice === true;
  // The user's message before this one, which the router sees too: "and tonight?" after a forecast
  // follows it (see followsForecast).
  const earlier = [...history.slice(0, -1)].reverse().find((turn) => turn.role === "user")?.content;
  const earlierText = typeof earlier === "string" ? earlier : "";
  const auto = followsForecast(route(last.content, last.attachment?.mediaType, previous, { spoken }), last.content, earlierText, Boolean(last.attachment), previous);
  // The request the user agreed to the price of: the router and the picture check aren't asked again.
  const decided = decidedFor(body, override);
  // Where and when the user is, taken once, so the hold counts the same instructions the reply sends.
  const where = whereFrom(request, body.timeZone);
  const prompting = promptingFor(where, new Date(startedAt), override !== null);
  // The live forecast (see weather-words.ts) is asked for by a precise weather question (firm) or by
  // the router's guess. A weather word alone (hinted) and a short follow-up to a weather question
  // (followsWeather) are hints: they add it only until the router answers otherwise, a weather word
  // only when the user didn't pick the engine, and never make a request step down, search less or go
  // free. On the free lane, where nothing is charged, a hint is enough.
  const followsWeather = auto.followUp === true;
  const firm = auto.live === "weather";
  const hinted = !last.attachment && asksWeather(last.content);
  // A public company's filings or figures, or an economic indicator (see research-words.ts): hints that
  // give an answer in words SEC EDGAR's or FRED's tools. They never make a request step down, search
  // less or go free: on a paid reply they're left out when they would (see planFor).
  const asksData = { filings: !last.attachment && asksFilings(last.content), economy: !last.attachment && asksEconomy(last.content) };
  // Whether the router gave an answer, and whether that answer was the forecast.
  let guessRan = false;
  let guessedWeather = false;
  // A quick question Auto sent to Research gets one search and one page read.
  const quickAsk = !override && last.content.length <= 160 && !/https?:\/\//i.test(last.content) && !DEEP_RESEARCH.test(last.content);
  // The user's connected accounts this chat has on, set below once the request is checked (see chatKit).
  let kit: ConnectorKit | null = null;
  const connectsOn = (e: Engine) => Boolean(kit) && CONNECT_ENGINES.includes(e);
  // forecast: priced as the router's "weather" answer would be; onFree: for a free model's reply.
  const toolsFor = (e: Engine, forecast = false, onFree = false): Tools => {
    const asked = firm || guessedWeather || forecast;
    // The tool's instructions cost a little to read, so a paid reply the user picked the engine for
    // ("write a poem about the rain" on Write) doesn't get it for a weather word alone, and a reply
    // the router read as something else ("thanks!" after a forecast) doesn't get it for a follow-up.
    const followUp = followsWeather && (onFree || !guessRan);
    const weather = WEATHER_ENGINES.includes(e) && (asked || followUp || (hinted && (onFree || (!guessRan && !override))));
    const hintOnly = weather && !asked;
    // As for a weather word, a paid reply the user picked the engine for doesn't get them: a free one does.
    const data = DATA_ENGINES.includes(e) && (onFree || !override);
    return {
      weather,
      hintOnly,
      // Research asked about the weather searches quickly: the forecast comes from the tool.
      quick: e === "search" && ((weather && !hintOnly) || quickAsk),
      connect: connectsOn(e),
      ...(data && asksData.filings && { filings: true }),
      ...(data && asksData.economy && fredReady() && { economy: true }),
    };
  };
  // Sums, units and money: Sonic thinks harder on them.
  const careful = needsCare(last.content);
  let engine = override ?? auto.engine;
  // Why this engine answers, in the user's language.
  let reason = override
    ? body.template === "Infinity AI Studio"
      ? t("Made in the Infinity AI Studio.")
      : typeof body.template === "string" && body.template.trim()
      ? t("Made from the {template} template.", { template: body.template.trim().slice(0, 40) })
      : body.build === true && (override === "app" || override === "slides")
        ? override === "app"
          ? t("Updating your app.")
          : t("Updating your slides.")
        : t("You picked this engine.")
    : // A forecast question says so once the forecast is used (see onUsed below).
      firm
      ? t("Writing and reasoning task.")
      : t(auto.reason);
  // Several files are read and compared by the writing engines; media tools take one file. The
  // builder reads several pictures too, so a few screens can be built in one go.
  const allPictures = [last.attachment, ...(last.more ?? [])].every((f) => f && PICTURE_TYPE.test(f.mediaType));
  const builds = engine === "app" || engine === "slides";
  // Several photos and a change asked for are combined into one picture: "put me and my dog on a beach".
  const photos = last.attachment ? [last.attachment, ...(last.more ?? [])] : [];
  // Asked of the engine as it ends up: a price agreed to, or "fix the text" on the picture above, can make it image later.
  const combinesOn = (e: Engine) =>
    e === "image" && severalFiles && photos.length <= MAX_EDIT_PHOTOS && photos.every((f) => EDITABLE_TYPE.test(f.mediaType));
  if (severalFiles && !WRITING_ENGINES.includes(engine) && !(builds && allPictures) && !combinesOn(engine)) {
    engine = "docs";
    reason = t("Flash reads several files together.");
  }

  // Everything this request spends with AI providers, for credits and the owner dashboard.
  const spend: { provider: string; model: string; cents: number }[] = [];
  const meter: Meter = (provider, model, cents) => void spend.push({ provider, model, cents });
  // What the priced provider jobs already sent will cost Flash, in cents, so a stopped job pays for them.
  let startedCents = 0;
  // A movie filmed with fewer scenes than priced, or a photo edited by the backup editor: what it costs as made, in cents.
  let madeCents: number | null = null;
  // Trips when the user presses Stop, so a Claude call stops at once; running is what the call in progress has cost.
  const abort = new AbortController();
  const running = new Running();
  // The Claude helpers the job is running, which a stopped request waits for (see Track).
  const helping = new Set<Promise<unknown>>();
  // Stop pressed on a picture, video or sound (see halted in Track), and whether it kept a job from being sent.
  let stopAsked = false;
  let mediaHalted = false;
  const mediaStop = new AbortController();
  const askStop = () => {
    stopAsked = true;
    mediaStop.abort();
  };
  const track: Track = {
    started: (cents) => void (startedCents += cents),
    // Asked of the database too, for a Stop that reached another server instance since its last look.
    halted: async () => {
      if (!stopAsked && replyId && (await stopRecorded(user.id, replyId).catch(() => false))) askStop();
      if (stopAsked) mediaHalted = true;
      return stopAsked;
    },
    stop: mediaStop.signal,
    repriced: (cents) => void (madeCents = cents),
    watch: { signal: abort.signal, running, endsAt: startedAt + DEADLINE_MS },
    helper: (call) => {
      const watched = call.finally(() => helping.delete(watched));
      helping.add(watched);
      return watched;
    },
    own: async (id) => {
      const file = await readFile(id, user.id);
      return file && { data: Buffer.from(file.data), mime: file.mime };
    },
  };

  // The chat's own details and the brand kit are read while the credits are checked, not after:
  // each is a trip to the database, and the answer can't start until all of them are back.
  const projectRead =
    typeof body.projectId !== "string"
      ? Promise.resolve(null)
      : ASSISTANTS_ON
        ? one<{ instructions: string; size: number; assistant_id: string; name: string; assistant_theirs: number }>(
            "SELECT instructions, length(CAST(messages AS BLOB)) AS size, assistant_id, name, assistant_theirs FROM projects WHERE id = ? AND user_id = ?",
            [body.projectId, user.id],
          )
        : one<{ instructions: string; size: number }>("SELECT instructions, length(CAST(messages AS BLOB)) AS size FROM projects WHERE id = ? AND user_id = ?", [
            body.projectId,
            user.id,
          ]);
  // Only used for the user's own chats (see theirs below).
  const brandRead = getBrand(user.id, appUrl(request));
  // Who pays (the team pool, then the user) is read with them too; the balances only after the grants.
  const accounts = spendAccounts(user.id);
  projectRead.catch(() => {});
  brandRead.catch(() => {});
  accounts.catch(() => {});
  await ensureMonthlyCredits(user.id);
  // A team member spends the shared pool first. One ledger pays for each request, so the hold
  // is sized to the larger balance.
  const available = (await spendable(user.id, { accounts })).largest;
  // The most Fix all said it would hold (maxCredits). The request is planned as any is, and one that would
  // now hold more isn't sent (see below): it never runs on a hold cut down to the cap, which could stop a
  // long reply part way with credits to spare. Only a change to an app or deck takes one, as only that is
  // priced (quote): no paid helper reads it before the cap is checked, while the router and the picture
  // check would be paid for by a request the cap then refuses with nothing charged.
  const cap =
    body.build === true && (override === "app" || override === "slides") && typeof body.maxCredits === "number" && Number.isSafeInteger(body.maxCredits) && body.maxCredits > 0
      ? body.maxCredits
      : null;

  // "Fix the spelling" sent with the picture above fixes the words in that picture. With a photo the
  // user attached, the same words are about the photo's own text, so they get words.
  if (!override && body.pictureAbove === true && last.attachment && EDITABLE_TYPE.test(last.attachment.mediaType) && fixesPictureText(last.content)) {
    engine = "image";
  }

  // Its size in bytes, as it's sent when the chat is opened or saved, and with assistants on, the
  // assistant it was started with, its name, and whether it had someone else's (assistant_theirs).
  // While they're off, it's read as it always was.
  const project: { instructions: string; size: number; assistant_id?: string; name?: string; assistant_theirs?: number } | null = await projectRead;
  // The server saves the turn itself (see turns.ts), so the answer is kept when the page is closed.
  // A page loaded before this sends no turn, and keeps its answers itself as before.
  const replyId = typeof body.replyId === "string" && MESSAGE_ID.test(body.replyId) ? body.replyId : null;
  const turn = project ? requestTurn(body) : null;
  // A chat too big to open or save again gets no more messages: nothing is run or charged.
  if (turn && !roomForTurn(Number(project!.size), turn.user, latestApp(history) ?? "")) {
    return Response.json({ error: t(PROJECT_FULL), code: "project_too_large" }, { status: 413 });
  }
  // The assistant the chat was started with, before any helper, hold or free message: gone (deleted, or
  // not shared with the user any more), changed since the page showed its price, or someone else's
  // the user has sent too much today, and nothing is run or charged.
  let chosen: { a: ChatAssistant; mine: boolean } | null = null;
  if (ASSISTANTS_ON && project?.assistant_id) {
    const access = await loadAssistantFor(user.id, project.assistant_id);
    if ("gone" in access) {
      // Named after the chat, which was named after the assistant when it started: never its name now.
      const name = project.name || "";
      const error =
        access.gone === "deleted" ? t("{name} was deleted, so it can't answer here.", { name }) : t("{name} isn't shared any more, so it can't answer here.", { name });
      return Response.json({ error, code: "assistant_gone", reason: access.gone }, { status: 410 });
    }
    const name = access.a.name;
    if (body.assistantVersion !== access.a.version) {
      return Response.json(
        { error: t("{name} changed since this chat opened. Check its new price, then send again.", { name }), code: "assistant_changed", assistant: await assistantSummary(access.a, access.mine) },
        { status: 409 },
      );
    }
    if (!access.mine && !quote && (await overLimit(`assistant-msg:${user.id}:${access.a.id}`, VISITOR_DAILY_MESSAGES, DAY_MS))) {
      return Response.json({ error: t("You've sent {name} a lot of messages today. Try again tomorrow.", { name }), code: "assistant_limit" }, { status: 429 });
    }
    chosen = access;
    // Who the model answers as, with its maker's instructions; passages are titled by their files'
    // names where those may be shown.
    const voice = { name, instructions: access.a.instructions, mine: access.mine, named: access.mine || access.a.showFiles };
    Object.assign(prompting, { assistant: assistantSection(voice), freeAssistant: assistantSection(voice, { free: true }) });
  }
  // Someone else's assistant answers: its replies write at most a visitor's reply.
  const visiting = chosen !== null && !chosen.mine;
  // Someone else's assistant, now or before "Continue without it" (its replies are still in the chat):
  // the user's own things stay out of the chat (connected accounts, their approved results, their
  // brand kit, their memory), and Research has no page reader, so its maker's instructions and files
  // can't reach them. What they're called, their language, the chat's own instructions and the voice style stay.
  const theirs = visiting || Number(project?.assistant_theirs) === 1;
  if (theirs) prompting.noFetch = true;
  // The connected accounts the chat has on: only the user's own, and only while connectors are set up
  // (CONNECTOR_KEYS). This reads the database only; their servers are reached when the reply starts.
  const connectorIds = theirs ? [] : requestedConnections(body.connectors);
  kit = connectorIds.length ? await chatKit(user.id, connectorIds, { replyId: replyId ?? "", signal: abort.signal }) : null;
  // Results the user approved and asked to continue the answer with (Continue on an action card):
  // their calls go on the reply before and what came back on this message, as tool blocks, so Claude
  // reads them as that account's data, never as the user's words. Marked used once the reply is paid for.
  const asked = theirs ? [] : continuedIds(body.actions);
  const continued =
    kit && asked.length && history.length >= 2 && history[history.length - 2].role === "assistant" ? continuedCalls(kit, await approvedResults(user.id, asked)) : [];
  // A Continue, or its Retry, without any of the results it asks for (used by an answer already,
  // expired, or their account off here) would be paid for an answer that can't read them: not sent.
  if (asked.length && !continued.length) {
    return Response.json(
      { error: t("The approved results can't be read now (they were already used, they expired, or their account is off in this chat), so nothing was sent and no credits were used."), code: "no_results" },
      { status: 409 },
    );
  }
  if (kit && continued.length) {
    const callId = (id: string) => `toolu_flash_${id}`;
    const before = history.length - 2;
    history[before] = {
      ...history[before],
      toolCalls: continued.map(({ row, tool }) => ({ id: callId(row.id), name: tool.name, input: JSON.parse(row.input_json) as Record<string, unknown> })),
    };
    history[history.length - 1] = {
      ...history[history.length - 1],
      toolResults: continued.map(({ row, tool }) => ({
        id: callId(row.id),
        content: JSON.stringify({ source: tool.connection, tool: tool.tool, text: row.result }),
        isError: row.result_error === 1,
      })),
    };
    // Those accounts' data is in the conversation now (the taint rule, see engines/connect.ts).
    kit.tainted = [...new Set(continued.map(({ row }) => row.connection_id))];
    // Only an engine with the accounts' tools can read their results (and it's never the free lane).
    if (!CONNECT_ENGINES.includes(engine)) {
      engine = "text";
      reason = t("Writing and reasoning task.");
    }
  }
  // A request Auto would send to Research that names one of the accounts turned on is answered with
  // them, in Write: Research has no connectors. The router isn't asked to move it. Each account's name
  // is looked for once, not once for each of its tools, in the part of the message the other checks
  // before the credit check read (see message-window.ts).
  const said = messageWindow(last.content);
  const namesAccount =
    Boolean(kit) && !override && !decided && [...new Set(kit!.tools.map((tool) => tool.connection))].some((name) => namesWord(said, name));
  if (namesAccount && engine === "search") {
    engine = "text";
    reason = t("You named one of your connected accounts, so Flash answers with it.");
  }
  const brand = theirs ? null : await brandRead;
  // What the user asked to be called, their work and their language (Settings > General), then their memory.
  const memory = theirs ? "" : (typeof body.preferences === "string" ? body.preferences : user.preferences).slice(0, MAX_PREFERENCES_CHARS);
  // For the picture and video prompt writer: the brand kit, and the language of words in pictures.
  const mediaNotes = [brandForMedia(brand), pictureWordsNote(user.language)].filter(Boolean).join("\n\n");
  // What Claude helpers (the router, the picture check) have cost this request so far, in cents.
  const helperSpend = () => spend.reduce((sum, s) => sum + (s.provider === "anthropic" ? s.cents : 0), 0);
  // What a message to the chat's assistant reads from its files (see passagesFor), read once, the
  // first time an engine that answers as it is priced, with the passages counted on every level's model.
  let reading: Promise<Reading> | null = null;
  const readingFor = (a: ChatAssistant, named: boolean) =>
    (reading ??= passagesFor(a, last.content, earlierText, { readStart: body.readStart === true, named, count: countPassages }));
  /** The history an engine that answers as the chat's assistant reads: with the passages on its newest turn. */
  const historyFor = async (): Promise<ChatTurn[]> => {
    if (!chosen) return history;
    return withPassages(history, (await readingFor(chosen.a, chosen.mine || chosen.a.showFiles)).passages);
  };
  // A conversation's size depends only on the model, the system prompt and, with an assistant, the
  // passages, so it is counted once.
  const counts = new Map<string, Promise<number>>();
  // With connectors, the tools the reply may send are counted exactly too.
  // Set when Anthropic couldn't count a request: planning goes on with a guess, but a Claude reply
  // priced on it isn't sent (see below), since a guess can be far under what the reply reads.
  let countFailed = false;
  const countOnce = (e: Engine, model: string, systemText: string, tools?: Parameters<typeof countInputTokens>[3]) => {
    const reads = chosen !== null && answersAsAssistant(e);
    const key = `${model}\n${systemText}\n${tools?.map((tool) => tool.name).join(",") ?? ""}${reads ? "\n+passages" : ""}`;
    if (!counts.has(key)) {
      let sent = history;
      counts.set(
        key,
        (reads ? historyFor() : Promise.resolve(history))
          .then((h) => countInputTokens(model, (sent = h), systemText, tools))
          .catch(() => {
            countFailed = true;
            return worstTokens(systemText.length + JSON.stringify(sent).length + (tools ? JSON.stringify(tools).length : 0));
          }),
      );
    }
    return counts.get(key)!;
  };
  /**
   * The same for a ChatGPT reply, counted by OpenAI, or null when it couldn't be (the caller decides
   * what then). It never reads an assistant's passages (see gptBlock).
   */
  const gptCounts = new Map<string, Promise<number | null>>();
  const countGptOnce = (model: string, instructions: string, effort: GptChoice["effort"]) => {
    const key = `${model}\n${effort}\n${instructions}`;
    if (!gptCounts.has(key)) {
      gptCounts.set(
        key,
        countGptTokens(model, history, instructions, effort).catch((err) => {
          console.error("[flash] counting a ChatGPT request failed", err instanceof Error ? err.message.slice(0, 200) : "error");
          return null;
        }),
      );
    }
    return gptCounts.get(key)!;
  };
  // Whether the chat has a reply that used a connected account, read once and only for a ChatGPT pick.
  let accountsUsed: Promise<boolean> | null = null;
  /**
   * Why the ChatGPT model the user picked can't answer this request on an engine with these tools, or
   * null when it can. Its replies have no tools, so Research, apps and slides, the live forecast, SEC
   * EDGAR and FRED, and connected accounts stay on Claude, and so do chats with an assistant. A chat
   * that used a connected account goes to no other AI provider (see the privacy policy).
   */
  const gptBlock = async (engine: Engine, withTools: Tools): Promise<string | null> => {
    if (!gptConfigured()) return msg("{model} isn't available right now, so {level} answered.");
    if (!GPT_ENGINES.includes(engine)) return msg("{model} doesn't do Research, apps or slides in Flash yet, so {level} answered.");
    if (chosen || theirs) return msg("{model} doesn't answer as an assistant yet, so {level} answered.");
    if (withTools.connect || withTools.filings || withTools.economy || withTools.weather) {
      return msg("{model} can't use live forecasts, company filings, economic data or your connected accounts in Flash yet, so {level} answered.");
    }
    if (await (accountsUsed ??= usedAccounts(body.messages, body.projectId, user.id).catch(() => true))) {
      return msg("This chat used your connected accounts, which stay with Claude, so {level} answered.");
    }
    return null;
  };
  /** The tools a reply with connectors sends: the forecast's when it has one, SEC EDGAR's and FRED's, then the accounts'. */
  const connectTools = (withTools: Tools) =>
    withTools.connect && kit ? [...(withTools.weather ? [WEATHER_TOOL] : []), ...dataDefinitions(withTools), ...kit.tools.map((tool) => tool.definition)] : undefined;
  /**
   * What SEC EDGAR's and FRED's tools add to what a reply reads, counted high (see tokensAtMost), on
   * top of the room countInputTokens leaves for tools: 0 without them, and with connectors, where
   * every tool is counted exactly.
   */
  const dataRoom = (withTools: Tools) => {
    const definitions = dataDefinitions(withTools);
    return definitions.length === 0 || (withTools.connect && kit) ? 0 : tokensAtMost(JSON.stringify(definitions));
  };

  /**
   * Prices the request on an engine: its model or level, the credits it needs and holds, and what it
   * may spend. A Claude engine's hold also pays for the helpers that already ran, and extraCents for
   * one still to run; a priced job's listed price already includes them (see CHECK_ALLOWANCE_CENTS).
   * forecast: priced with the live forecast, as the router's "weather" answer runs (see toolsFor).
   * balance: what a Claude reply's hold is planned from (the user's credits; see Fix all's price below).
   */
  const planFor = async (engine: Engine, editing: boolean, extraCents = 0, forecast = false, balance = available) => {
    const helperCents = helperSpend() + extraCents;
    // The model whose price was agreed to, while it's still there (otherwise the new price is asked about).
    const asked = decided?.engine === engine && decided.model ? decided.model : body.model;
    // Flash Infinity AI Studio is for admins until it's open to everyone (see studio.ts).
    const wanted = asked && STUDIO_MODELS.includes(asked) && !studioOpenTo(user) ? undefined : asked;
    // Only FLUX.2 Edit takes several photos at once; the other photo tools work on one.
    const combining = editing && combinesOn(engine);
    let picked = isMedia(engine) ? pickModel(engine, last.content, providers(), combining ? "flux-2-edit" : wanted, editing, defaultModel(engine)) : null;
    // Too few credits for ChatGPT's photo editor, which Flash picked: the other photo tools do it for less.
    if (isMedia(engine) && picked && editing && picked.why !== "you picked it" && picked.model.provider === "openai" && modelCredits(picked.model, last.content) > balance) {
      picked = pickModel(engine, last.content, new Set([...providers()].filter((p) => p !== "openai")), undefined, editing, defaultModel(engine)) ?? picked;
    }
    const model = picked?.model ?? null;
    // Engines that aren't available yet reply for free. Media has a fixed price per model. Claude engines are charged by
    // length: Flash holds up to a limit, then keeps only what the reply really cost.
    const live = isMedia(engine) ? Boolean(model) : configured(engine);
    const metered = live && !isMedia(engine) && engine !== "voice" && engine !== "transcribe";
    const preferences = withVoiceStyle(
      withBrand(withInstructions([profileNote(user, engine), memory].filter((p) => p.trim()).join("\n"), project?.instructions ?? ""), brand),
      engine,
      body.voice,
    );
    let held = 0;
    let needed = 0;
    let budget = NO_BUDGET;
    // The price of a priced job (a picture, video, track, speech or transcript) in cents; null for a Claude engine.
    let priceCents: number | null = null;
    // The level a Claude engine runs on, and why, and the tools its reply has.
    let claudeRun: ClaudeChoice | null = null;
    // Or the ChatGPT model that answers instead (see gptBlock).
    let gptRun: GptChoice | null = null;
    let levelWhy = "";
    let tools = NO_EXTRA_TOOLS;
    // Whether Auto chose what answers (the user picked no level or ChatGPT model).
    let onAuto = false;
    if (live) {
      const count = combining ? photos.length : 1;
      if (model) priceCents = requestCents(model, last.content, count);
      else if (engine === "voice") priceCents = voiceCostCents(spokenText(last.content).length);
      // Priced on the recording's length (see transcribeCostCents); with no file, the engine just asks for one.
      else if (engine === "transcribe") priceCents = last.attachment ? transcriptCents(last.attachment) : 0;
      if (priceCents !== null) {
        // The listed price, which is what is held and charged. No helper reads a recording first.
        held = needed = !priceCents
          ? 0
          : model
            ? modelCredits(model, last.content, count)
            : engine === "voice"
              ? voiceCredits(spokenText(last.content).length)
              : creditsFor(priceCents);
      } else {
        // The level the user picked, or the one Auto picks for this request (see levels.ts).
        const files = last.attachment ? 1 + (last.more?.length ?? 0) : 0;
        const autoPick = autoLevel(engine, last.content, { files, voice: body.voice === true });
        const wanted = isLevel(body.level) && body.level !== "auto" ? body.level : null;
        // A ChatGPT model the user picked (see GPT_PICKS), and why it can't answer this request, if it can't.
        const gptWanted = isGptPick(body.level) ? body.level : null;
        onAuto = !wanted && !gptWanted;
        // A ChatGPT reply's model and effort, its instructions, and what OpenAI counts it reads.
        const gptRequest = (level: GptPick, withTools: Tools) => {
          const base = gptChoice(engine, level, { careful, auto: onAuto });
          const instructions = gptInstructions(systemFor(engine, preferences, history, prompting, withTools), level, onAuto);
          return { base, instructions, counted: countGptOnce(base.model, instructions, base.effort) };
        };
        // The reply may only spend what the held credits pay for, so no request runs at a loss.
        const plan = async (level: ModelLevel | GptPick, withTools: Tools) => {
          if (isGptPick(level)) {
            const { base, instructions, counted } = gptRequest(level, withTools);
            // A count OpenAI couldn't make is a guess, as for Claude: a reply priced on it isn't sent.
            const read = await counted;
            if (read === null) countFailed = true;
            const inputTokens = read ?? worstTokens(instructions.length + JSON.stringify(history).length);
            const choice: GptChoice = { ...base, inputTokens, safetyId: safetyId(user.id) };
            const scale = claudePrice(choice.model, inputTokens).output / claudePrice(defaultChoice(engine).model, inputTokens).output;
            return { choice, inputTokens, tools: withTools, hold: planHold(engine, choice.model, inputTokens, balance, scale, helperCents, toolPlan(engine, withTools)) };
          }
          const choice = claudeChoice(engine, level, { careful });
          const inputTokens = (await countOnce(engine, choice.model, systemFor(engine, preferences, history, prompting, withTools), connectTools(withTools))) + dataRoom(withTools);
          const scale = claudePrice(choice.model, inputTokens).output / claudePrice(defaultChoice(engine).model, inputTokens).output;
          return { choice, inputTokens, tools: withTools, hold: planHold(engine, choice.model, inputTokens, balance, scale, helperCents, toolPlan(engine, withTools)) };
        };
        // The level picked, or Auto's when the user can't pay for the one picked; Research the user
        // picked searches quickly when their credits pay only for that. fellBack: either happened.
        const price = async (withTools: Tools) => {
          // A ChatGPT model answers only when it can (gptBlock); otherwise Auto's level does, saying why.
          const picked = useGpt ? gptWanted : wanted;
          let planned = await plan(picked ?? autoPick.level, withTools);
          let why = gptWanted && !useGpt
            ? t(gptBlocked ?? "", { model: levelName(gptWanted), level: levelName(planned.choice.level) })
            : !picked
              ? t(autoPick.why)
              : planned.choice.level === picked
                ? t("You picked {level}.", { level: levelName(picked) })
                : t("Research runs on {level} or above, so it answered instead of {picked}.", {
                    level: levelName(planned.choice.level),
                    picked: levelName(picked),
                  });
          // On Auto, the level's ChatGPT peer answers when it needs at most half the credits (see
          // AUTO_GPT): checked on Claude's count first, so OpenAI counts only a request it may take,
          // and the level answers when OpenAI can't count it.
          const peer = onAuto ? AUTO_GPT[autoPick.level].peer : undefined;
          if (
            peer &&
            muchCheaper(GPT_MODELS[peer], planned.choice.model, planned.inputTokens, MIN_OUTPUT_TOKENS[engine] ?? 1500) &&
            (await gptBlock(engine, withTools)) === null &&
            (await gptRequest(peer, withTools).counted) !== null
          ) {
            const cheaper = await plan(peer, withTools);
            if (cheaper.hold.needed * 2 <= planned.hold.needed) {
              why = t("This chat is long, so {model} answered: it reads long chats for far fewer credits.", { model: levelName(peer) });
              planned = cheaper;
            }
          }
          let fellBack = false;
          // Not enough credits for the level or model picked: Auto's level answers when the user has enough for that.
          if (picked && picked !== autoPick.level && available < planned.hold.needed) {
            const instead = await plan(autoPick.level, withTools);
            if (available >= instead.hold.needed) {
              why = t("{picked} needs {credits} credits for this and you have {available}, so {level} answered.", {
                picked: levelName(picked),
                credits: planned.hold.needed,
                available,
                level: levelName(autoPick.level),
              });
              planned = instead;
              fellBack = true;
            }
          }
          if (engine === "search" && override === "search" && !withTools.quick && available < planned.hold.needed) {
            const quick = await plan(planned.choice.level, { ...withTools, quick: true });
            if (available >= quick.hold.needed) {
              why = t("Flash did a quick search: a full one needs {needed} credits and you have {available}.", { needed: planned.hold.needed, available });
              planned = quick;
              fellBack = true;
            }
          }
          return { planned, why, fellBack };
        };
        let asked = toolsFor(engine, forecast);
        // A weather word alone doesn't keep a ChatGPT model from answering: the forecast is left out instead.
        if (gptWanted && asked.hintOnly) asked = { ...asked, weather: false, hintOnly: false };
        const gptBlocked = gptWanted ? await gptBlock(engine, asked) : null;
        const useGpt = gptWanted !== null && gptBlocked === null;
        let priced = await price(asked);
        // Nor do SEC EDGAR's and FRED's tools: they're left out instead.
        if ((asked.filings || asked.economy) && (priced.fellBack || available < priced.planned.hold.needed)) {
          priced = await price({ ...asked, filings: false, economy: false });
        }
        // A weather word alone never makes a reply step down, search less or go to the free lane: the
        // forecast is left out instead, and the reply is priced as it was before it.
        if (priced.planned.tools.hintOnly && (priced.fellBack || available < priced.planned.hold.needed)) {
          priced = await price({ weather: false, hintOnly: false, quick: engine === "search" && quickAsk, connect: connectsOn(engine) });
        }
        const { hold } = priced.planned;
        levelWhy = priced.why;
        tools = priced.planned.tools;
        ({ needed, held } = hold);
        budget = { maxTokens: hold.maxTokens, capCents: hold.capCents, byCredits: hold.byCredits };
        // A refusal fallback only when the hold pays for it (see planHold); ChatGPT has none.
        const chose = priced.planned.choice;
        if (isGptPick(chose.level)) gptRun = chose as GptChoice;
        else claudeRun = { ...(chose as ClaudeChoice), fallback: hold.fallback };
      }
    }
    return { picked, model, live, metered, preferences, held, needed, budget, priceCents, claudeRun, gptRun, levelWhy, tools, onAuto };
  };

  // The keyword rules can't tell every "make it darker" from "great edit!" or "change it back", and a change
  // costs credits, so a small model checks the request first. Words about the picture get an answer in
  // words; a different picture is made fresh. Once the user has agreed to a price, the check isn't asked again.
  let fresh = false;
  const wouldEdit = (engine === "image" || engine === "video") && Boolean(last.attachment && EDITABLE_TYPE.test(last.attachment.mediaType));
  // Photos Flash can't edit get the error below whatever the check says, so it isn't asked.
  const editable = (list: Attachment[]) =>
    list.every((photo) => {
      const size = imageDimensions(Buffer.from(photo.data, "base64"));
      return size !== null && size.width * size.height <= MAX_EDIT_PIXELS;
    });
  // The picture check and the router are paid for by the request they decide, so someone who keeps
  // getting the price question and never says yes gets the keyword rules' answer instead.
  const askedOften = body.confirmed !== true && (await countOf(`price-q:${user.id}`)) >= PRICE_QUESTIONS_AN_HOUR;
  // The check runs only when every answer it can give leads to a request the user can pay for, which
  // pays for it. (A request with a picture never goes to the free lane, whose models can't see pictures.)
  const payable = async (e: Engine, editing: boolean) => {
    const p = await planFor(e, editing, PICTURE_CHECK_MAX_CENTS);
    return p.live && available >= p.needed;
  };
  // One photo the rules sent to the writing model because they didn't know the words: a typo ("make it
  // clairer"), "it's blurry", or any language but English. The writing model can only describe a change,
  // and is charged for it, so the same check reads it first, and a change goes to the photo tools.
  const photoInWords = engine === "text" && !severalFiles && Boolean(last.attachment && EDITABLE_TYPE.test(last.attachment.mediaType));
  if (decided) {
    // Decided before the user agreed to the price (see Decided).
    if (decided.engine !== engine) reason = t("Flash's router read your request.");
    engine = decided.engine;
    fresh = decided.fresh === true && body.pictureAbove === true;
    if (fresh) reason = t("Flash makes a new picture.");
  } else if (wouldEdit && !override && body.confirmed !== true && !askedOften && claudeConfigured() && editable(combinesOn(engine) ? photos : [last.attachment!])) {
    // Paid for by the change the rules decided on, an answer in words, and a new picture for the picture above.
    const words: Engine = severalFiles ? "docs" : "text";
    if ((await payable(engine, true)) && (await payable(words, false)) && (body.pictureAbove !== true || (await payable(engine, false)))) {
      const asked = await pictureRequest(last.content, body.pictureAbove === true, meter);
      if (asked === "other") {
        engine = words;
        reason = body.pictureAbove === true ? t("Flash answers about the picture above.") : t("A photo is attached, so the writing model reads it.");
      } else if (asked === "new" && body.pictureAbove === true) {
        fresh = true;
        reason = t("Flash makes a new picture.");
      }
    }
  } else if (photoInWords && !override && body.confirmed !== true && !askedOften && claudeConfigured() && editable([last.attachment!])) {
    // Paid for by the change or the answer in words. A different picture asked for with a photo attached
    // ("new") starts from that photo too.
    if ((await payable("image", true)) && (await payable("text", false))) {
      const asked = await pictureRequest(last.content, false, meter);
      if (asked === "change" || asked === "new") {
        engine = "image";
        reason = t("A photo is attached and you asked to change it.");
      }
    }
  }
  // An image request with a photo attached edits it; a video request animates it.
  const editing = !fresh && (engine === "image" || engine === "video") && Boolean(last.attachment && EDITABLE_TYPE.test(last.attachment.mediaType));
  if (editing && body.pictureAbove === true) reason = engine === "video" ? t("Bringing the picture above to life.") : t("Changing the picture above.");
  // Every photo sent is priced and checked: several photos go to a picture only when Flash combines them.
  if (editing && engine === "image" && severalFiles && !combinesOn(engine)) {
    return Response.json({ error: t("Flash can edit PNG, JPEG and WebP photos up to 2048 × 2048 pixels. Try a smaller photo.") }, { status: 400 });
  }
  if (editing && !editable(combinesOn(engine) ? photos : [last.attachment!])) {
    return Response.json({ error: t("Flash can edit PNG, JPEG and WebP photos up to 2048 × 2048 pixels. Try a smaller photo.") }, { status: 400 });
  }
  if (combinesOn(engine) && editing) reason = t("Flash combines your {count} photos into one picture.", { count: photos.length });
  // A transcript is priced on how long the recording plays, so one Flash can't measure isn't sent.
  if (engine === "transcribe" && last.attachment && configured(engine) && !measured(last.attachment)) {
    return Response.json(
      {
        error: t("Flash can't tell how long {name} plays, so it can't transcribe it. Save it as MP3, M4A, WAV or FLAC and send it again.", {
          name: last.attachment.name,
        }),
      },
      { status: 400 },
    );
  }

  // When no keyword rule fits, a small, fast model reads the request and picks the engine. It only runs
  // when the request can be paid for on whatever engine it picks, so the free lane costs Flash nothing.
  // In a voice conversation it also checks requests the rules sent to code, docs or search (see checksSpoken).
  const recheck = spoken && checksSpoken(engine);
  let plan: Awaited<ReturnType<typeof planFor>>;
  if (!override && !decided && !namesAccount && !continued.length && (auto.guessed || recheck) && !last.attachment && !askedOften && claudeConfigured()) {
    const ready = (e: Engine) => (isMedia(e) ? Boolean(pickModel(e, last.content, providers())) : configured(e));
    // A spoken turn about an app or deck the rules couldn't place: the guess knows about the build,
    // and the question Flash asked before it, which a "yes" may answer.
    const about = auto.guessed ? auto.about : undefined;
    const offer = spoken && about ? offered(history) : undefined;
    // Where the guess may move it (see takesGuess). A spoken request checked again, or one about a
    // build, only moves between the engines that answer in words, or to that build, or to what the
    // rules would have made of spoken talk that mentioned it (maybe).
    const answers = recheck || auto.answersOnly === true;
    const maybe = auto.guessed ? auto.maybe : undefined;
    // A weather word after an app or deck was kept as a change to it (captured): any answer the
    // router gives replaces that, an answer in words included.
    const may = (e: Engine) =>
      auto.captured ? e !== engine && e !== "transcribe" : takesGuess(e, engine, last.content, { spoken, recheck: answers, about, maybe });
    // Someone talking is waiting in silence, so the router gets less time to think. It sees the
    // earlier message and the engine of the last reply, so "and tomorrow?" follows a forecast.
    const routed = await guessEngine(
      last.content,
      engine,
      available,
      (e, extraCents, forecast) => planFor(e, false, extraCents, forecast),
      ready,
      meter,
      { may, weather: engine === "text" || may("text"), timeoutMs: spoken ? 1500 : 4000, about, offer, earlier: earlierText, previous },
    );
    guessRan = routed.answered;
    guessedWeather = routed.weather === true;
    if (routed.guessed) {
      engine = routed.engine;
      reason = guessedWeather ? t("Weather questions are answered from a live forecast.") : t("Flash's router read your request.");
    }
    plan = routed.plan;
    // Priced with the forecast for a weather word before the router answered, and it read the
    // request otherwise: the forecast is left out, so a wrong hint costs nothing.
    if (guessRan && plan.tools.hintOnly) plan = await planFor(engine, editing);
  } else {
    plan = await planFor(engine, editing);
  }
  const { picked, model, live, metered, preferences, priceCents, levelWhy, tools, onAuto } = plan;
  let { held, needed, budget, claudeRun, gptRun } = plan;
  // A reply as someone else's assistant writes at most VISITOR_REPLY_TOKENS, so its maker's "always
  // write long answers" can't run up their bills (they can ask it to continue). Held as before.
  if (visiting && metered && answersAsAssistant(engine) && budget.maxTokens > VISITOR_REPLY_TOKENS) {
    budget = { ...budget, maxTokens: VISITOR_REPLY_TOKENS, byCredits: false };
  }
  // Fix all's price: the credits this request holds when it's sent as it is now (what it needs at least,
  // and the balance it's held from), worked out above exactly as for sending it. Nothing is run, charged
  // or saved. A count Anthropic couldn't make is a guess, which is never shown as a price. With fewer
  // credits than it needs, nothing would be held, and the most it can cost is what it holds once there
  // are enough: planned again as if the balance paid for all of it (the level and tools are chosen on
  // the real balance, and what it needs doesn't change), never the least it needs.
  if (quote) {
    if (countFailed) return Response.json({ error: t("Flash is busy right now. Please try again in a moment.") }, { status: 503 });
    if (live && metered && available < needed) ({ held } = await planFor(engine, editing, 0, false, Number.MAX_SAFE_INTEGER));
    return Response.json({ held: live && metered ? held : 0, needed, available });
  }
  // Out of credits: chat-style requests and images fall back to free models,
  // up to a daily allowance per user.
  let free: FreeLane | null = null;
  // Research's question goes to a free model with the free web search, when SearXNG is set up.
  let freeSearch = false;
  const verified = isVerified(user);
  // Connectors use credits: a chat with them on never goes to the free lane. Nor does a chat with a
  // reply that used them, with them off now or on Research (which has none): what Claude wrote from an
  // account's data goes to Anthropic only, never to the free models' providers, which may keep it or
  // learn from it (see the privacy policy's Google section, and Google's Limited Use rules).
  const connected = refuseUnpaid(Boolean(tools.connect), available, needed);
  const goesFree = live && available < needed && verified && model?.id !== "post-pack" && freeEligible(engine, last) !== null;
  // What's said when today's free use of the kind this request would take is used up.
  const usedUp = (lane: FreeLane) => {
    const left = { credits: available };
    return lane === "image"
      ? t("You've used today's free images and you have {credits} credits. Free use resets tomorrow, or get more credits now.", left)
      : lane === "transcribe"
        ? t("You've used today's free transcripts and you have {credits} credits. Free use resets tomorrow, or get more credits now.", left)
        : t("You've used today's free messages and you have {credits} credits. Free use resets tomorrow, or get more credits now.", left);
  };
  if (live && (connected || goesFree)) {
    const used = await usedAccounts(body.messages, body.projectId, user.id);
    if (connected || used) {
      const counts = { needed, available };
      const short = metered ? t("This needs at least {needed} credits and you have {available}.", counts) : t("This needs {needed} credits and you have {available}.", counts);
      // A free reply is offered (turn connectors off, or a new chat) only when this one could go free
      // and today's free use of its kind (messages, images or transcripts) isn't used up; looking reserves nothing.
      const lane = verified && model?.id !== "post-pack" ? freeEligible(engine, last) : null;
      const freeOpen = lane !== null && (await freeLeft(user.id, lane)) > 0;
      const error = freeOpen
        ? `${short} ${t(used ? CONNECTED_CHAT_NEEDS_CREDITS : CONNECTORS_NEED_CREDITS)}`
        : lane !== null
          ? `${t(used ? CONNECTED_CHAT_USES_CREDITS : CONNECTORS_USE_CREDITS)} ${usedUp(lane)}`
          : `${short} ${t(used ? CONNECTED_CHAT_USES_CREDITS : CONNECTORS_USE_CREDITS)}`;
      return Response.json({ error, code: "out_of_credits", needed }, { status: 402 });
    }
  }
  // What a free model reads from the chat's assistant's files: as much as the turn has room for, uncounted.
  let freeReading: Reading | null = null;
  if (live && available < needed && verified) {
    // A post pack has no free version: one free picture isn't what was asked for.
    const lane = model?.id === "post-pack" ? null : freeEligible(engine, last);
    if (lane) {
      // Someone else's assistant answers on the free models only when its maker allows it; no free message is used up.
      if (lane === "chat" && chosen && !chosen.mine && !chosen.a.freeOk) {
        return Response.json({ error: t("{name} needs credits: its maker hasn't allowed free messages for it.", { name: chosen.a.name }), code: "assistant_needs_credits", needed }, { status: 402 });
      }
      if (lane === "chat" && chosen) {
        // Room for the line between each passage's title and text and the blank lines between them, for as many as can come back.
        const maxChars = Math.max(0, freePassageRoom(last) - 3 * Math.max(MAX_ASSISTANT_FILES, MAX_PASSAGES));
        try {
          freeReading = await passagesFor(chosen.a, last.content, earlierText, { readStart: body.readStart === true, named: chosen.mine || chosen.a.showFiles, maxChars });
        } catch (err) {
          console.error("[flash] reading an assistant's files failed", err instanceof Error ? err.name : "error");
          return Response.json({ error: t("Flash is busy right now. Please try again in a moment.") }, { status: 503 });
        }
      }
      if (!(await reserveFreeUser(user.id, lane))) return Response.json({ error: usedUp(lane), code: "out_of_credits", needed }, { status: 402 });
      free = lane;
      held = needed = 0;
      budget = NO_BUDGET;
      // A free model searches only with Flash's own search, so the header doesn't say Research.
      if (engine === "search") {
        engine = "text";
        freeSearch = searxngReady();
        reason = t("Research needs credits, so a free model answered without searching the web.");
      }
    }
  }
  // Agreed to: every price, or the price asked, for this model at no more than those credits (see consents).
  if (model && !free && needed >= CONFIRM_CREDITS && available >= needed && !consents(body, decided, model.id, needed)) {
    // The price question, which a voice conversation also reads out.
    const price = { model: model.label, credits: needed.toLocaleString(t.locale), available: available.toLocaleString(t.locale) };
    const error =
      model.id === "post-pack"
        ? t("This social post pack with a video uses {credits} credits. You have {available}.", price)
        : engine === "video"
          ? model.id === "movie"
            ? t("This {model} movie uses {credits} credits. You have {available}.", price)
            : model.id === "ad-studio"
              ? t("This ad uses up to {credits} credits. You have {available}. You only pay for what is made.", price)
            : model.id === "story-studio"
              ? t("This part of your story uses up to {credits} credits. You have {available}. You only pay for what is made.", price)
            : t("This {model} video uses {credits} credits. You have {available}.", price)
          : engine === "music"
            ? t("This {model} track uses {credits} credits. You have {available}.", price)
            : t("This {model} image uses {credits} credits. You have {available}.", price);
    // What the router and the picture check decided, and the price asked, for the request the user agrees to (see Decided).
    const settled: Decided = { engine, ...(fresh && { fresh }), model: model.id, credits: needed };
    await overLimit(`price-q:${user.id}`, PRICE_QUESTIONS_AN_HOUR, 3600_000);
    return Response.json({ error, code: "confirm_cost", needed, decided: settled }, { status: 409 });
  }
  // A Claude reply whose length couldn't be counted isn't run: nothing is charged or sent.
  if (countFailed && metered && !free) {
    return Response.json({ error: t("Flash is busy right now. Please try again in a moment.") }, { status: 503 });
  }
  // Never more than Fix all said: a request that would now hold more (its chat, level, instructions or the
  // balance changed since) isn't sent, and nothing is charged. One within it holds what any would, and
  // settling never charges more than the hold.
  if (cap !== null && held > cap) {
    return Response.json({ error: t(OVER_CAP, { credits: cap.toLocaleString(t.locale) }), code: "over_cap" }, { status: 409 });
  }
  // In a chat with an assistant: what the reply reads from its files, read before anything is
  // charged (planning read it already for an engine that answers as it), and a reply made without it
  // says so.
  let replyHistory = history;
  let read: Reading | null = freeReading;
  if (chosen && live) {
    if (!answersAsAssistant(engine)) reason = `${reason} ${t("{name} only answers in writing, so this was made without it.", { name: chosen.a.name })}`;
    else if (free === "chat" && freeReading) replyHistory = withPassages(history, freeReading.passages);
    else if (!free) {
      try {
        read = await readingFor(chosen.a, chosen.mine || chosen.a.showFiles);
        replyHistory = await historyFor();
      } catch (err) {
        console.error("[flash] reading an assistant's files failed", err instanceof Error ? err.name : "error");
        return Response.json({ error: t("Flash is busy right now. Please try again in a moment.") }, { status: 503 });
      }
    }
  }
  const freeUse = { provider: "", model: "" };
  const freeAudio: { reserved?: number } = {};
  const chargeId = held ? await charge(user.id, held, `${engine} request`) : 0;
  if (chargeId === null) {
    const counts = { needed, available };
    const notes = [
      metered ? t("This needs at least {needed} credits and you have {available}.", counts) : t("This needs {needed} credits and you have {available}.", counts),
    ];
    if (!verified) notes.push(t("Confirm your email to get your free credits and free daily messages."));
    if (verified && freeChatConfigured()) {
      notes.push(
        freeImageConfigured()
          ? freeTranscribeConfigured()
            ? t("Free models still answer chat, writing, code and translation, make images, and transcribe short recordings.")
            : t("Free models still answer chat, writing, code and translation, make images.")
          : freeTranscribeConfigured()
            ? t("Free models still answer chat, writing, code and translation, and transcribe short recordings.")
            : t("Free models still answer chat, writing, code and translation."),
      );
    }
    return Response.json({ error: notes.join(" "), code: "out_of_credits", needed }, { status: 402 });
  }
  // Approved results continued here are used once, now that the reply is paid for (and put back if it
  // fails or is stopped, so Retry has them again).
  const taken = continued.length ? (await approvedResults(user.id, continued.map(({ row }) => row.id), { take: true })).map((row) => row.id) : [];
  // Saved files take the extension of what the provider really sent, so downloads open correctly.
  const store: Store = (media, name) => saveFile(user.id, media.mime, withExtension(name, media.mime), media.data);

  const projectId = String(body.projectId);
  if (replyId && !turn) console.warn(`[flash] a ${engine} reply can't be saved by the server: its project or message is missing`);

  const encoder = new TextEncoder();
  // The page reading the reply. When it stops reading (it was closed, its connection was lost, or
  // Stop) only the reading stops: the work goes on to the end, and is saved and settled.
  let reader: ReadableStreamDefaultController<Uint8Array> | null = null;
  // What ends the engine early: Stop (see stops.ts), or a Claude reply's time running out.
  let halt: "stop" | "deadline" | null = null;
  // Wakes the work while it waits for the engine's next step.
  let wake = () => {};
  const stopEngine = (why: "stop" | "deadline") => {
    halt ??= why;
    // A Claude call stops at once, keeping what it has cost so far (see Watch).
    abort.abort(why);
    wake();
  };
  // Writing stops at once. A picture, video or sound not yet sent to its provider isn't made, and
  // one still in fal's line is taken out of it; one already being made is billed by its provider,
  // so it's finished, delivered into the chat and charged as usual (see halted in Track).
  const stoppable = STOPPABLE_ENGINES.includes(engine);
  // Claude engines end at once when told to stop, as their call is cut (see Watch).
  const drains = metered && !free;
  // A reply the server can't save (from a page loaded before it saved them) is kept only by its
  // page, so leaving the page stops it, as before: a provider job already sent is paid for as sent.
  const pageGone = () => {
    if (!turn) stopEngine("stop");
  };
  const signalAborted = () => {
    // Logged to confirm what the host does when a page goes away: Vercel tells a request only
    // with supportsCancellation, which Flash leaves off so the work goes on.
    console.log(`[flash] chat request.signal aborted after ${Math.round((Date.now() - startedAt) / 1000)} s (${engine}${turn ? ", the reply goes on" : ""})`);
    pageGone();
  };
  if (request.signal.aborted) signalAborted();
  else request.signal.addEventListener("abort", signalAborted, { once: true });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      reader = controller;
    },
    cancel() {
      // Logged like the abort above, to confirm what the host does when a page goes away.
      console.log(`[flash] chat response stopped being read after ${Math.round((Date.now() - startedAt) / 1000)} s (${engine})`);
      reader = null;
      pageGone();
    },
  });
  // The reply as the browser builds it from the same events (see apply-event.ts), saved at the end.
  let reply: UIMessage = turn?.reply ?? { id: "", role: "assistant", content: "", pending: true };
  const send = (e: StreamEvent) => {
    reply = applyEvent(reply, e);
    if (!reader) return;
    try {
      reader.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
    } catch {
      reader = null;
    }
  };

  // The work runs to the end even when the page goes away (after() keeps the call alive until it's
  // done); the response only reads from it. It never throws, and settles the credits once.
  const work = (async () => {
    // The reply's header, sent again in full when it changes (see apply-event.ts).
    let routed: Extract<StreamEvent, { type: "route" }> = {
      type: "route",
      engine,
      reason,
      // Talk about an app or deck: the next follow-up may still change it.
      ...(auto.about && engine !== auto.about && !override && { about: auto.about }),
      demo: !live,
      cost: metered && !free ? 0 : held,
      // So a reply the user stops can show what it really cost once that is settled.
      ...(chargeId ? { charge: chargeId } : {}),
      ...(free
        ? {
            free: true,
            model: free === "image" ? "FLUX.1 schnell" : free === "transcribe" ? "Whisper" : t("Free model"),
            modelWhy: t("You're out of credits, so Flash used a free model."),
          }
        : model
          ? { model: model.label, modelWhy: pickedWhy(picked!, t) }
          : // The level's name stays as it is: the browser matches it to the level's sign.
            gptRun
            ? { model: levelName(gptRun.level), modelWhy: levelWhy }
            : claudeRun && { model: levelName(claudeRun.level), modelWhy: levelWhy }),
    };
    send(routed);
    // What the reply read from the assistant's files: each passage's title, or that none matched.
    if (read && (read.passages.length || read.nomatch)) send({ type: "read", items: read.passages.map((p) => ({ label: p.title })), ...(read.nomatch && { nomatch: true }) });
    // Saved at once, so the user's message and the reply in progress are in the chat if the page is closed.
    const saving = turn
      ? saveTurn(user.id, projectId, { ...turn, reply: { ...reply, pendingSince: startedAt } }).catch((err) => {
          console.error("[flash] saving the turn failed", err);
          return false;
        })
      : null;
    // The reply's header names the level that really answered.
    const steppedDown = (choice: ClaudeChoice) => {
      if (claudeRun) {
        const modelWhy = t("{level} was busy, so {instead} answered.", { level: levelName(claudeRun.level), instead: levelName(choice.level) });
        routed = { ...routed, model: levelName(choice.level), modelWhy };
        send(routed);
      }
      claudeRun = choice;
    };
    // Auto's ChatGPT backup for a level that is busy or down (see AUTO_GPT): only where a ChatGPT model
    // can answer (see gptBlock), and only when the credits held for the level pay for an answer of the
    // usual length at least, read as OpenAI counts it. Otherwise the level's error shows, as before.
    const backup = async (from: ClaudeChoice) => {
      const pick = AUTO_GPT[from.level].backup;
      if (!pick || (await gptBlock(engine, tools)) !== null) return null;
      const base = gptChoice(engine, pick, { careful, auto: true });
      const instructions = gptInstructions(systemFor(engine, preferences, history, prompting, tools), pick, true);
      const inputTokens = await countGptTokens(base.model, history, instructions, base.effort, abort.signal).catch(() => null);
      if (inputTokens === null) return null;
      const maxTokens = Math.min(budget.maxTokens, tokensWithin(engine, base.model, inputTokens, budget.capCents, false));
      if (!(maxTokens >= Math.min(MIN_OUTPUT_TOKENS[engine] ?? 1500, budget.maxTokens))) return null;
      return { choice: { ...base, inputTokens, safetyId: safetyId(user.id) }, budget: { ...budget, maxTokens } };
    };
    const backedUp = (from: ClaudeChoice, choice: GptChoice) => {
      routed = { ...routed, model: levelName(choice.level), modelWhy: t("{level} was busy, so {instead} answered.", { level: levelName(from.level), instead: levelName(choice.level) }) };
      send(routed);
      claudeRun = null;
      gptRun = choice;
    };
    // Once a live forecast is used, the header says so, unless the user picked the engine.
    const weatherReason = t("Weather questions are answered from a live forecast.");
    const forecastUsed = () => {
      if (override || routed.reason === weatherReason) return;
      routed = { ...routed, reason: weatherReason };
      send(routed);
    };
    // What a picture, video or sound says once Stop is pressed: stopping, or being finished.
    const stopNote = () => ({ type: "status" as const, message: t(startedCents > 0 ? FINISHING_AFTER_STOP : STOPPING) });
    const endWatch = replyId
      ? watchStop(user.id, replyId, () => {
          if (stoppable) return stopEngine("stop");
          // The free lane's picture or transcript costs nothing and is finished.
          if (stopAsked || free) return;
          askStop();
          send(stopNote());
        })
      : () => {};
    const deadline = metered && !free ? setTimeout(() => stopEngine("deadline"), startedAt + DEADLINE_MS - Date.now()) : undefined;
    let ok = true;
    let stopped = false;
    // The reply showed FRED data, so it carries FRED's notice even when it's stopped (see below).
    let fredShown = false;
    let failure = "";
    let error: unknown;
    // Once a free model's web search is used, the header says so.
    const searchedReason = t("Research needs credits, so a free model answered with a free web search.");
    const freeToolUsed = (name: string) => {
      if (name.startsWith("fred_")) fredShown = true;
      if (name !== "web_search" || routed.reason === searchedReason) return;
      routed = { ...routed, reason: searchedReason };
      send(routed);
    };
    // A free reply gets the forecast whenever it's asked for or a weather word is in the message, and
    // SEC EDGAR, FRED and web search whenever they're asked for: they cost nothing.
    const freeTools = free === "chat" ? toolsFor(engine, false, true) : NO_EXTRA_TOOLS;
    const freeData =
      free === "chat" ? dataTools({ search: freeSearch, filings: freeTools.filings, economy: freeTools.economy }, { userId: user.id, language: user.language ?? "", t }) : [];
    // A paid reply's are those its hold paid for.
    const paidData = free ? [] : dataTools({ filings: tools.filings, economy: tools.economy }, { userId: user.id, t });
    const events = free
      ? runFree(free, engine, replyHistory, preferences, store, freeUse, where.country ?? "", t, freeAudio, freeSystem(prompting), {
          ...(freeTools.weather && { weather: weatherTool(where, t), onUsed: forecastUsed }),
          ...(freeData.length && { tools: freeData, onTool: freeToolUsed }),
          language: user.language ?? "",
          // Stop ends the free model's look-ups too: they'd use slots and daily counts every reply shares.
          signal: abort.signal,
          ...(visiting && { maxTokens: VISITOR_REPLY_TOKENS }),
        })
      : run(engine, replyHistory, preferences, store, model, meter, budget, mediaNotes, claudeRun, steppedDown, track, t, prompting, {
          ...(tools.weather && { weather: weatherTool(where, t), onUsed: forecastUsed }),
          quick: tools.quick,
          gpt: gptRun,
          ...(onAuto && !gptRun && { backup, onBackup: backedUp }),
          ...(tools.connect && kit && { connect: kit }),
          ...(paidData.length && {
            data: paidData,
            onTool: (name: string) => {
              if (name.startsWith("fred_")) fredShown = true;
            },
          }),
        });
    // Stop ends the request at once, without waiting for the next event: a Claude call is stopped,
    // and a provider job already sent is paid for as sent (see finalCredits). A Claude engine still
    // hands over what it finished before, and one that came to its end on its own isn't stopped.
    try {
      const how = await readEngine(
        events[Symbol.asyncIterator](),
        (e) => {
          // The file being written is only for the page watching it (see live-draft.ts), and never after Stop.
          if (e.type === "draft" && halt === "stop") return;
          // Once Stop is pressed on a picture, video or sound, its progress says what happens to it.
          send(stopAsked && e.type === "status" ? stopNote() : e);
        },
        { halted: () => halt !== null, onWake: (w) => (wake = w), ...(drains && { drainMs: DRAIN_MS }) },
      );
      stopped = how === "stopped";
    } catch (err) {
      // A job taken out of fal's queue on Stop never ran (see falRun).
      if (halt || err instanceof JobStopped) stopped = true;
      else {
        console.error(`[flash] ${engine} engine failed`, err);
        ok = false;
        error = err;
        // Provider errors can hold raw responses, so only messages written for the user are shown.
        failure =
          err instanceof FriendlyError
            ? err.in(t)
            : engine === "text"
              ? t("Flash is busy right now. Please try again in a moment.")
              : t("{engine} is busy right now. Please try again in a moment.", { engine: t(ENGINE_LABELS[engine]) });
      }
    }
    clearTimeout(deadline);
    endWatch();
    // A picture, video or sound Stop kept from being made.
    if (mediaHalted) stopped = true;
    // A build out of time can't be continued, so it ends as failed and says why; what it cost so
    // far is paid, as for any request that failed part way.
    if (stopped && halt === "deadline" && (engine === "app" || engine === "slides")) {
      stopped = false;
      ok = false;
      failure = t(BUILD_TOO_LONG);
    }
    // FRED's terms ask for its notice under any reply that showed its data, a stopped one too: the free
    // lane stops at once, before its engine adds the notice, and a paid reply's engine may not hand it
    // over within DRAIN_MS. Sent here, it's in the reply that's saved.
    if (stopped && fredShown && !reply.content.includes(FRED_NOTE)) send({ type: "text", delta: FRED_NOTE });
    // A helper still running when the user stopped is billed by Claude, so the request waits for it
    // to be metered (each has a timeout of under a minute) and pays for it.
    if (stopped) await Promise.allSettled(helping);
    const costCents = spend.reduce((sum, s) => sum + s.cents, 0);
    // The level that answered, after any step-down, sets what a typical reply costs and its prices.
    const answered: { model: string } | null = gptRun ?? (claudeRun as ClaudeChoice | null);
    const scale = answered ? claudePrice(answered.model).output / claudePrice(defaultChoice(engine).model).output : 1;
    // A failed request costs only the provider work that really ran. A stopped reply is charged
    // for what the call had cost so far. The free lane is free.
    const credits = free
      ? 0
      : finalCredits({
          held,
          ok,
          stopped,
          metered,
          costCents,
          pendingCents: running.soFar,
          // A typical reply on this level: a fraction of the usual on Sonic, more on Summit.
          typical: Math.max(1, Math.round((TYPICAL_CREDITS[engine] ?? 4) * scale)),
          ...(priceCents !== null && {
            priced: {
              // The listed price, or the price as made: a movie with fewer scenes, a photo edited by the backup editor.
              credits: madeCents !== null && model ? creditsFor(madeCents + helperAllowanceCents(model)) : held,
              helperCents: helperSpend(),
              startedCents,
            },
          }),
        });
    // Settled here, once. Trying again after an error is safe: it only lowers the hold to the same amount.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await settle(chargeId, credits);
        break;
      } catch (err) {
        console.error("[flash] settling credits failed", err);
      }
    }
    // A Continue that failed or was stopped gives its approved results back for Retry.
    if (taken.length && (!ok || stopped)) await releaseResults(user.id, taken).catch((err) => console.error("[flash] putting back results failed", err instanceof Error ? err.name : "error"));
    // A free request that failed doesn't use up one of the user's free requests for today, except a
    // transcript Groq was sent, which gives back what freeAudioFailed says.
    if (free && !ok) {
      await (free === "transcribe" && freeAudio.reserved !== undefined
        ? freeAudioFailed(user.id, free, freeAudio.reserved, error)
        : releaseFreeUser(user.id, free)
      ).catch((err) => console.error("[flash] free release failed", err));
    }
    if (live) {
      const main = spend.at(-1);
      await logUsage({
        userId: user.id,
        engine,
        model: free ? freeUse.model : (model?.id ?? main?.model ?? ""),
        provider: free ? freeUse.provider : (model?.provider ?? main?.provider ?? ""),
        credits,
        costCents,
        ok,
        parts: spend,
      }).catch((err) => console.error("[flash] usage log failed", err));
    }
    if (stopped && halt === "deadline") send({ type: "text", delta: "\n\n" + t("Flash ran out of time here. Ask it to continue.") });
    if (!ok) send({ type: "error", message: failure + refundNote(held, credits, t) });
    // Pages loaded before Stop was saved by the server don't know this event (they always send a replyId).
    if (stopped && replyId) send({ type: "stopped" });
    // What it cost, which can be less than was held: a reply charged by length or stopped, a movie
    // with fewer scenes, or a request that failed part way.
    if ((metered || priceCents !== null) && !free) send({ type: "cost", credits });
    if (turn) {
      await saving;
      // The finished reply as the browser saves it, in place of the pending one. Saving it again after
      // an error is safe: it's put in place by its id.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await saveReply(user.id, projectId, turn, { ...reply, pending: undefined, status: undefined });
          break;
        } catch (err) {
          console.error("[flash] saving the reply failed", err);
        }
      }
      // A Studio film takes minutes, so whoever left the page hears when it's ready (the service
      // worker shows nothing while Flash is open and in front).
      if (model && STUDIO_MODELS.includes(model.id) && !stopped && Date.now() - startedAt > 60_000) {
        await sendPush(user.id, {
          title: !ok ? t("Your film couldn't be finished") : reply.videos?.length ? t("Your film is ready") : t("Your storyboard is ready"),
          body: last.content.split("\n")[0],
          url: `/?project=${encodeURIComponent(projectId)}`,
          tag: "flash-film",
        }).catch((err) => console.error("[flash] film alert failed", err));
      }
    }
    send({ type: "done" });
  })()
    .catch((err) => console.error("[flash] chat request failed", err))
    .finally(() => {
      try {
        reader?.close();
      } catch {}
    })
    // A reply that brought the balance below the person's auto top-up level buys their pack.
    .then(() => maybeAutoTopUp(user.id))
    .catch((err) => console.error("[flash] auto top-up failed", err));
  after(work);
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
