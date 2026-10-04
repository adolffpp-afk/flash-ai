import { creditsFor, MAX_SPEECH_CHARS, voiceCostCents } from "../credits.ts";
import { MODELS, modelCredits, pickModel, type MediaEngine, type ModelInfo, type Provider } from "../models.ts";
import { falConfigured, falGenerate } from "../engines/fal.ts";
import { falInput } from "../engines/fal-input.ts";
import {
  composeMusic,
  downloadVideo,
  elevenConfigured,
  generateImage,
  generateVideo,
  openaiConfigured,
  speechProvider,
  synthesizeSpeech,
  type Media,
} from "../engines/media.ts";
import { FriendlyError, JobAbandoned } from "../engines/errors.ts";
import { charge, ensureMonthlyCredits, logUsage, settle, spendable } from "./credits.ts";
import { saveFile } from "./files.ts";
import { publicFileLink } from "./connector.ts";
import type { User } from "./auth.ts";

/** The tools the Flash connector offers, in MCP's shapes (the 2025-06-18 specification). */

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name: string; mimeType: string };
export type ToolResult = { content: ToolContent[]; isError?: boolean };
export type ToolContext = { user: User; origin: string; app: string; progress: (message: string) => void };

// Pictures up to this size are also sent inside the reply, so the app can show them at once.
const INLINE_IMAGE_BYTES = 1_000_000;
const MAX_PROMPT = 4000;
// About five minutes of speech.
const MAX_SPOKEN = Math.min(5000, MAX_SPEECH_CHARS);

function providers(): Set<Provider> {
  const set = new Set<Provider>();
  if (openaiConfigured()) set.add("openai");
  if (elevenConfigured()) set.add("elevenlabs");
  if (falConfigured()) set.add("fal");
  return set;
}

/** The models an app may ask for: no photo editing (it needs a photo) and no Movie maker (it runs longer than apps wait). */
const offered = (engine: MediaEngine) =>
  MODELS.filter((m) => m.engine === engine && !m.edits && m.id !== "movie" && providers().has(m.provider));

/** The model for a request, like the chat picks it, never the Movie maker. */
function chooseModel(engine: MediaEngine, request: string, requested?: string): ModelInfo | null {
  const picked = pickModel(engine, request, providers(), requested)?.model;
  if (picked?.id !== "movie") return picked ?? null;
  return pickModel(engine, "", providers())?.model ?? null;
}

const priceList = (engine: MediaEngine, example = "") =>
  offered(engine)
    .map((m) => `${m.id} (${m.label}, ${modelCredits(m, example)} credits): ${m.blurb}`)
    .join("; ");

const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });
const failed = (s: string): ToolResult => ({ content: [{ type: "text", text: s }], isError: true });

/** The tools, listing only the models that are set up. */
export const tools = () => [
  {
    name: "flash_create_image",
    title: "Create an image with Flash",
    description:
      "Makes one image from a description with Flash AI's image models and returns it with a link. Uses the user's Flash credits. " +
      `Models: ${priceList("image")}. Leave model out and Flash picks the best fit.`,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What the image should show: subject, style, lighting, framing.", maxLength: MAX_PROMPT },
        model: { type: "string", enum: offered("image").map((m) => m.id) },
      },
      required: ["prompt"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "flash_create_video",
    title: "Create a video with Flash",
    description:
      "Films a short video clip from a description with Flash AI's video models and returns a link to the MP4. Takes one to three minutes. " +
      `Uses the user's Flash credits. Models: ${priceList("video")} (Kling is priced at 10 seconds; it costs ${creditsFor(14)} credits a second). ` +
      "Leave model out and Flash picks: Veo when the clip needs sound or speech, Kling for longer clips.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The shot: subject, action, camera movement, mood, any sound.", maxLength: MAX_PROMPT },
        seconds: { type: "integer", minimum: 3, maximum: 15, description: "Length in seconds. Kling makes 3 to 15; Veo and Sora make 8." },
        model: { type: "string", enum: offered("video").map((m) => m.id) },
      },
      required: ["prompt"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "flash_create_music",
    title: "Create music with Flash",
    description:
      "Composes a music track from a description and returns a link to the MP3. Uses the user's Flash credits. " +
      `Models: ${priceList("music")}. For a song with sung words, include the lyrics in the prompt.`,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Genre, mood, instruments, tempo, and lyrics if it should be sung.", maxLength: MAX_PROMPT },
        model: { type: "string", enum: offered("music").map((m) => m.id) },
      },
      required: ["prompt"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "flash_speak",
    title: "Read text aloud with Flash",
    description:
      `Turns text into natural speech (an MP3 voice-over) and returns a link. Uses the user's Flash credits: about ${creditsFor(voiceCostCents(1000))} credits per 1,000 characters. ` +
      `Up to ${MAX_SPOKEN.toLocaleString("en-US")} characters.`,
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The exact words to say.", maxLength: MAX_SPOKEN } },
      required: ["text"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "flash_check_credits",
    title: "Check Flash credits",
    description: "Shows how many Flash credits the user has left, and where to get more.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

type Args = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Charges for a job, runs it, and settles: the full price when it works, nothing when it
 * fails, except work the provider billed anyway (like the chat, so nothing runs at a loss).
 */
async function paid(
  ctx: ToolContext,
  job: { engine: string; model: string; provider: string; credits: number; costCents: number },
  make: () => Promise<Media>,
  name: string,
): Promise<{ media: Media; url: string; credits: number } | ToolResult> {
  await ensureMonthlyCredits(ctx.user.id);
  const chargeId = await charge(ctx.user.id, job.credits, `${job.engine} via ${ctx.app}`);
  if (chargeId === null) {
    const { largest } = await spendable(ctx.user.id);
    return failed(
      `This needs ${job.credits} Flash credits and the user has ${largest}. They can get more at ${ctx.origin}/?credits=1`,
    );
  }
  let ok = false;
  let used = 0;
  try {
    const media = await make();
    ok = true;
    used = job.credits;
    const saved = await saveFile(ctx.user.id, media.mime, name, media.data);
    const link = await publicFileLink(ctx.user.id, saved);
    return { media, url: `${ctx.origin}${link}`, credits: job.credits };
  } catch (err) {
    console.error(`[flash] connector ${job.engine} failed`, err);
    if (err instanceof JobAbandoned && err.billed) used = job.credits;
    return failed(
      (err instanceof FriendlyError ? err.message : "Flash is busy right now. Please try again in a moment.") +
        (used ? "" : " No credits were used."),
    );
  } finally {
    await settle(chargeId, used);
    await logUsage({
      userId: ctx.user.id,
      engine: job.engine,
      model: job.model,
      provider: job.provider,
      credits: used,
      costCents: used ? job.costCents : 0,
      ok,
    }).catch((err) => console.error("[flash] usage log failed", err));
  }
}

const costOf = (model: ModelInfo, request: string) =>
  typeof model.costCents === "function" ? model.costCents(request) : model.costCents;

async function balanceLine(ctx: ToolContext): Promise<string> {
  const { total } = await spendable(ctx.user.id);
  return `${total.toLocaleString("en-US")} credits left.`;
}

/** Runs a media model the way the chat does, reporting progress. */
async function generate(model: ModelInfo, prompt: string, request: string, ctx: ToolContext): Promise<Media> {
  if (model.provider === "fal") {
    const input = falInput(model, prompt, request);
    // A smaller picture to send back inside the reply.
    if (model.engine === "image") input.output_format = "jpeg";
    return falGenerate(model.endpoint!, input, (m) => ctx.progress(m));
  }
  if (model.engine === "image") return generateImage(prompt);
  if (model.engine === "music") return composeMusic(prompt);
  const id = await generateVideo(prompt, (pct) => pct && ctx.progress(`Filming… ${pct}%`));
  return downloadVideo(id).catch(() => {
    throw new JobAbandoned("Flash couldn't fetch the video. Please try again.", true);
  });
}

const EXT: Record<string, string> = { image: "jpg", video: "mp4", music: "mp3" };
const extFor = (mime: string, engine: MediaEngine) =>
  ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav" })[mime] ??
  EXT[engine];

async function media(engine: MediaEngine, args: Args, ctx: ToolContext): Promise<ToolResult> {
  const prompt = str(args.prompt).slice(0, MAX_PROMPT);
  if (!prompt) return failed("Describe what to make in prompt.");
  const seconds = typeof args.seconds === "number" ? Math.round(args.seconds) : null;
  // The words the model is chosen and priced on, as if typed in the chat.
  const request = seconds ? `${prompt}\n${seconds} seconds` : prompt;
  const requested = str(args.model) || undefined;
  if (requested && !offered(engine).some((m) => m.id === requested)) {
    return failed(`${requested} isn't available. Use one of: ${offered(engine).map((m) => m.id).join(", ") || "none yet"}.`);
  }
  const model = chooseModel(engine, request, requested);
  if (!model) return failed(`Flash's ${engine} models aren't available yet.`);
  const credits = modelCredits(model, request);
  ctx.progress(`Starting ${model.label} (${credits} credits)…`);
  const result = await paid(
    ctx,
    { engine, model: model.id, provider: model.provider, credits, costCents: costOf(model, request) },
    () => generate(model, prompt, request, ctx),
    `flash-${engine}`,
  );
  if ("content" in result) return result;
  const file = `flash-${engine}.${extFor(result.media.mime, engine)}`;
  const content: ToolContent[] = [];
  if (engine === "image" && result.media.data.length <= INLINE_IMAGE_BYTES) {
    content.push({ type: "image", data: result.media.data.toString("base64"), mimeType: result.media.mime });
  }
  content.push({
    type: "text",
    text: `Made with ${model.label} on Flash for ${result.credits} credits. ${await balanceLine(ctx)}\nLink (anyone with it can open the file): ${result.url}`,
  });
  content.push({ type: "resource_link", uri: result.url, name: file, mimeType: result.media.mime });
  return { content };
}

async function speak(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const words = str(args.text);
  if (!words) return failed("Give the words to say in text.");
  if (words.length > MAX_SPOKEN) return failed(`That's ${words.length} characters; Flash reads up to ${MAX_SPOKEN} at a time. Split it into parts.`);
  const provider = speechProvider();
  if (!provider) return failed("Flash's voice isn't available yet.");
  const cents = voiceCostCents(words.length);
  const credits = creditsFor(cents);
  const result = await paid(ctx, { engine: "voice", model: "voice", provider, credits, costCents: cents }, () => synthesizeSpeech(words), "flash-voice");
  if ("content" in result) return result;
  return {
    content: [
      { type: "text", text: `Spoken by Flash for ${result.credits} credits. ${await balanceLine(ctx)}\nLink: ${result.url}` },
      { type: "resource_link", uri: result.url, name: "flash-voice.mp3", mimeType: result.media.mime },
    ],
  };
}

/** Runs one tool. Unknown tools return null (a protocol error, not a tool error). */
export async function callTool(name: string, args: Args, ctx: ToolContext): Promise<ToolResult | null> {
  switch (name) {
    case "flash_create_image":
      return media("image", args, ctx);
    case "flash_create_video":
      return media("video", args, ctx);
    case "flash_create_music":
      return media("music", args, ctx);
    case "flash_speak":
      return speak(args, ctx);
    case "flash_check_credits": {
      await ensureMonthlyCredits(ctx.user.id);
      const { total, pool } = await spendable(ctx.user.id);
      return text(
        `${ctx.user.name || ctx.user.email} has ${total.toLocaleString("en-US")} Flash credits` +
          (pool !== null ? ` (${pool.toLocaleString("en-US")} of them in their team's shared pool)` : "") +
          `. More credits: ${ctx.origin}/?credits=1`,
      );
    }
    default:
      return null;
  }
}
