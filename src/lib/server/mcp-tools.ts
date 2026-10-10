import { creditsFor, MAX_SPEECH_CHARS, voiceCostCents, voiceCredits } from "../credits.ts";
import { MODELS, modelCredits, pickModel, type MediaEngine, type ModelInfo, type Provider } from "../models.ts";
import { falConfigured, falGenerate } from "../engines/fal.ts";
import { falEditInput, falInput } from "../engines/fal-input.ts";
import { DEFAULT_VOICE, VOICES } from "../voices.ts";
import { imageDimensions, MAX_EDIT_PIXELS } from "../imageSize.ts";
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
import { listSites, publishSite } from "./sites.ts";
import { dataLine } from "../data-rules.ts";
import { publicFile, publicFileLink } from "./connector.ts";
import type { User } from "./auth.ts";
import { fullName } from "../names.ts";

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

/**
 * The models an app may ask for: no photo editing (it needs a photo), and none that only run in a
 * chat, like the Movie maker (it runs longer than apps wait) or the post pack (it makes several files).
 */
const offered = (engine: MediaEngine) =>
  MODELS.filter((m) => m.engine === engine && !m.edits && !m.chatOnly && providers().has(m.provider));

/** The model for a request, like the chat picks it, never one that only runs in a chat. */
function chooseModel(engine: MediaEngine, request: string, requested?: string): ModelInfo | null {
  const picked = pickModel(engine, request, providers(), requested)?.model;
  if (!picked?.chatOnly) return picked ?? null;
  return pickModel(engine, "", providers())?.model ?? null;
}

const priceList = (engine: MediaEngine, example = "") =>
  offered(engine)
    .map((m) => `${m.id} (${m.label}, ${modelCredits(m, example)} credits): ${m.blurb}`)
    .join("; ");

/** What Kling 3 charges for a clip this long, as the chat charges it. */
const klingCredits = (length: string) => modelCredits(MODELS.find((m) => m.id === "kling-3")!, length);

const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });
const failed = (s: string): ToolResult => ({ content: [{ type: "text", text: s }], isError: true });

/** The tools, listing only the models that are set up. */
export const tools = () => [
  {
    name: "flash_create_image",
    title: "Create an image with Flash",
    description:
      "Makes one image from a description with Flash AI's image models and returns it with a link. Uses the user's Flash credits. " +
      `Models: ${priceList("image")}. Leave model out and Flash picks the best fit. ` +
      "Pictures are 4:3 unless the prompt asks for another shape: vertical or 9:16 (phone stories), 3:4 or poster, square or 1:1, wide or 16:9 (banners).",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What the image should show: subject, style, lighting, framing, and shape if not 4:3.", maxLength: MAX_PROMPT },
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
      `Uses the user's Flash credits. Models: ${priceList("video")} (Kling is priced at 10 seconds; it costs about ${creditsFor(14)} credits a second: ${klingCredits("5 seconds")} for 5 seconds, ${klingCredits("15 seconds")} for 15). ` +
      "Leave model out and Flash picks: Veo when the clip needs sound or speech, Kling for longer clips. " +
      "Videos are wide (16:9) unless the prompt asks for vertical (9:16, for phones) or, with Kling, square (1:1).",
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
      `Turns text into natural speech (an MP3 voice-over) and returns a link. Uses the user's Flash credits: about ${voiceCredits(1000)} credits per 1,000 characters. ` +
      `Up to ${MAX_SPOKEN.toLocaleString("en-US")} characters.`,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The exact words to say.", maxLength: MAX_SPOKEN },
        voice: {
          type: "string",
          enum: VOICES.map((x) => x.name),
          description: `Who reads it (default ${DEFAULT_VOICE.name}). ${VOICES.map((x) => `${x.name}: ${x.about}`).join("; ")}.`,
        },
        speed: { type: "number", minimum: 0.7, maximum: 1.2, description: "Reading speed, 0.7 to 1.2 (default 1)." },
      },
      required: ["text"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  ...(["remove-bg", "upscale"] as const).map((id) => {
    const model = MODELS.find((m) => m.id === id)!;
    return {
      name: id === "remove-bg" ? "flash_remove_background" : "flash_upscale_image",
      title: id === "remove-bg" ? "Remove a photo's background with Flash" : "Upscale a photo with Flash",
      description:
        (id === "remove-bg"
          ? "Cuts the subject out of a photo and returns it on a transparent background (PNG)."
          : "Makes a photo sharper and up to 4 times bigger (longest side up to 4,096 pixels).") +
        ` Costs ${modelCredits(model)} Flash credits. Give a Flash file link (from another Flash tool) as image_url, or the photo itself as image_base64. ` +
        "PNG, JPEG or WebP, up to 2048 × 2048 pixels.",
      inputSchema: {
        type: "object",
        properties: {
          image_url: { type: "string", description: "A Flash file link, like https://www.flash-app.dev/f/…" },
          image_base64: { type: "string", description: "The photo as base64 (PNG, JPEG or WebP), when there is no Flash link." },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    };
  }).filter(() => falConfigured()),
  ...[MODELS.find((m) => m.id === "flux-2-edit")!]
    .filter((m) => providers().has(m.provider))
    .map((m) => ({
      name: "flash_edit_photo",
      title: "Edit a photo with Flash",
      description:
        "Changes a photo from a written instruction with FLUX.2 Edit (swap the background, change the style, add or remove things, fix lighting) and returns the new image with a link. " +
        `Costs ${modelCredits(m)} Flash credits. Give a Flash file link (from another Flash tool) as image_url, or the photo itself as image_base64. ` +
        "PNG, JPEG or WebP, up to 2048 × 2048 pixels.",
      inputSchema: {
        type: "object",
        properties: {
          image_url: { type: "string", description: "A Flash file link, like https://www.flash-app.dev/f/…" },
          image_base64: { type: "string", description: "The photo as base64 (PNG, JPEG or WebP), when there is no Flash link." },
          prompt: { type: "string", description: "What to change, in plain words.", maxLength: 2500 },
        },
        required: ["prompt"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    })),
  ...[MODELS.find((m) => m.id === "kling-3-animate")!]
    .filter((m) => providers().has(m.provider))
    .map((m) => ({
      name: "flash_animate_photo",
      title: "Animate a photo with Flash",
      description:
        "Turns a photo into a short video (MP4) with Kling 3 Pro and returns a link. Takes one to three minutes. " +
        `Costs about ${creditsFor(11.2)} Flash credits per second without sound, ${creditsFor(16.8)} with sound (a 5 second clip: ${modelCredits(m, "5 seconds")} credits, ` +
        `or ${modelCredits(m, "5 seconds with sound")} with sound). Tell the user the price first. ` +
        "Give a Flash file link (from another Flash tool) as image_url, or the photo itself as image_base64. PNG, JPEG or WebP, up to 2048 × 2048 pixels.",
      inputSchema: {
        type: "object",
        properties: {
          image_url: { type: "string", description: "A Flash file link, like https://www.flash-app.dev/f/…" },
          image_base64: { type: "string", description: "The photo as base64 (PNG, JPEG or WebP), when there is no Flash link." },
          prompt: { type: "string", description: "The motion: what moves and how, camera movement, mood.", maxLength: 2500 },
          seconds: { type: "integer", minimum: 3, maximum: 15, description: "Length in seconds (default 5)." },
          sound: { type: "boolean", description: "Add sound (ambience, speech, music). Costs more. Default false." },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    })),
  {
    name: "flash_publish_app",
    title: "Publish a web app on Flash",
    description:
      "Publishes a single-file HTML app (HTML, CSS and JavaScript in one page) at a public Flash address anyone can open, and returns the link. Free: uses no credits. " +
      "To update an app published before, pass its slug and it keeps the same address. " +
      "The app can save shared data with the built-in database window.flashDB (always available, all methods async): " +
      "flashDB.list(collection) returns an array of records; flashDB.add(collection, object) returns the new record with id and createdAt; " +
      "flashDB.update(collection, id, partialObject); flashDB.remove(collection, id). Collection names use letters, digits, - or _. " +
      "Data is shared by everyone who opens the app, so never store passwords or private data. " +
      'Name who may change each shared collection before </body> with <script type="application/json" id="flash-data">{"menu":"read","reviews":"add"}</script>: ' +
      "read (only the owner adds or changes), add (anyone adds; a record is changed only by the owner or by whoever added it while signed in), own (signed-in people manage their own), private (anyone adds; only the owner reads, in Flash) or open (anyone changes anything). " +
      "The block must be strict JSON (no comments, no trailing commas). Collections it doesn't name are read-only for visitors, and so is everything while Flash can't read the block; \"*\" sets the rule for every collection it doesn't name (for names made at run time). " +
      "flashDB.isOwner is true when the app's owner opens it with Open as owner in Flash, so show editing controls only then. " +
      "External scripts may load from CDNs. Up to 2 MB; up to 20 apps per account.",
    inputSchema: {
      type: "object",
      properties: {
        html: { type: "string", description: "The whole app as one HTML document." },
        title: { type: "string", description: "A short name for the app.", maxLength: 100 },
        slug: { type: "string", description: "To update an existing app: its slug (from an earlier publish or flash_list_apps)." },
      },
      required: ["html", "title"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "flash_list_apps",
    title: "List published Flash apps",
    description: "Lists the apps this Flash account has published, with their slugs and links.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
  const credits = voiceCredits(words.length);
  const voice = VOICES.find((x) => x.name === str(args.voice)) ?? DEFAULT_VOICE;
  const speed = typeof args.speed === "number" ? Math.min(1.2, Math.max(0.7, args.speed)) : 1;
  const result = await paid(
    ctx,
    { engine: "voice", model: "voice", provider, credits, costCents: cents },
    () => synthesizeSpeech(words, { voice: voice.name, speed }),
    "flash-voice",
  );
  if ("content" in result) return result;
  return {
    content: [
      { type: "text", text: `Spoken by Flash${provider === "fal" ? ` in ${voice.name}'s voice` : ""} for ${result.credits} credits. ${await balanceLine(ctx)}\nLink: ${result.url}` },
      { type: "resource_link", uri: result.url, name: "flash-voice.mp3", mimeType: result.media.mime },
    ],
  };
}

const PHOTO_TYPES: Record<string, string> = { "89504e47": "image/png", ffd8ff: "image/jpeg", "52494646": "image/webp" };
const photoType = (data: Buffer) =>
  Object.entries(PHOTO_TYPES).find(([magic]) => data.subarray(0, magic.length / 2).toString("hex") === magic)?.[1] ?? null;

/** The photo a tool was given: one of the user's own Flash links, or the image itself. */
async function photoArg(args: Args, ctx: ToolContext): Promise<{ data: Buffer; mime: string } | string> {
  const url = str(args.image_url);
  let data: Buffer;
  if (url) {
    const id = url.match(/\/f\/([\w-]+)$/)?.[1];
    const file = id && url.startsWith(`${ctx.origin}/f/`) ? await publicFile(id) : null;
    if (!file || file.user_id !== ctx.user.id) return "image_url must be a Flash file link from this account. Otherwise send the photo as image_base64.";
    data = Buffer.from(file.data);
  } else {
    const b64 = str(args.image_base64).replace(/^data:[^,]*,/, "");
    if (!b64) return "Give the photo as image_url (a Flash link) or image_base64.";
    data = Buffer.from(b64, "base64");
  }
  const mime = photoType(data);
  const size = imageDimensions(data);
  if (!mime || !size) return "Flash can work on PNG, JPEG and WebP photos.";
  if (size.width * size.height > MAX_EDIT_PIXELS) return "That photo is too big. Flash works on photos up to 2048 × 2048 pixels.";
  return { data, mime };
}

async function animateTool(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const model = MODELS.find((m) => m.id === "kling-3-animate")!;
  if (!providers().has(model.provider)) return failed("Flash's photo animation isn't available yet.");
  const photo = await photoArg(args, ctx);
  if (typeof photo === "string") return failed(photo);
  const seconds = typeof args.seconds === "number" ? Math.min(15, Math.max(3, Math.round(args.seconds))) : 5;
  const motion = str(args.prompt).slice(0, 2500) || "Bring this photo to life with natural, gentle motion.";
  // Priced and sent exactly as the chat would read it: the length, and sound only when asked for.
  const request = `${motion.replace(/\b(sound|audio|music|voice|noise|silent)\b/gi, "")}\n${seconds} seconds${args.sound === true ? " with sound" : ""}`;
  const credits = modelCredits(model, request);
  ctx.progress(`Starting ${model.label} (${credits} credits)…`);
  const input = { ...falEditInput(model, `data:${photo.mime};base64,${photo.data.toString("base64")}`, null, request), prompt: motion };
  const result = await paid(
    ctx,
    { engine: "video", model: model.id, provider: model.provider, credits, costCents: costOf(model, request) },
    () => falGenerate(model.endpoint!, input, (m) => ctx.progress(m)),
    "flash-animated",
  );
  if ("content" in result) return result;
  return {
    content: [
      { type: "text", text: `Animated with ${model.label} on Flash for ${result.credits} credits. ${await balanceLine(ctx)}\nLink (anyone with it can open the video): ${result.url}` },
      { type: "resource_link", uri: result.url, name: "flash-animated.mp4", mimeType: result.media.mime },
    ],
  };
}

async function photoTool(id: "remove-bg" | "upscale" | "flux-2-edit", args: Args, ctx: ToolContext): Promise<ToolResult> {
  const model = MODELS.find((m) => m.id === id)!;
  if (!providers().has(model.provider)) return failed(`Flash's ${model.label} isn't available yet.`);
  const request = id === "flux-2-edit" ? str(args.prompt).slice(0, 2500) : "";
  if (id === "flux-2-edit" && !request) return failed("Say what to change in the photo as prompt.");
  const photo = await photoArg(args, ctx);
  if (typeof photo === "string") return failed(photo);
  const name = `flash-${id === "flux-2-edit" ? "edited" : id}`;
  const credits = modelCredits(model, request);
  ctx.progress(`Starting ${model.label} (${credits} credits)…`);
  const input = falEditInput(model, `data:${photo.mime};base64,${photo.data.toString("base64")}`, imageDimensions(photo.data), request);
  const result = await paid(
    ctx,
    { engine: "image", model: model.id, provider: model.provider, credits, costCents: costOf(model, request) },
    () => falGenerate(model.endpoint!, input, (m) => ctx.progress(m)),
    name,
  );
  if ("content" in result) return result;
  const content: ToolContent[] = [];
  if (result.media.data.length <= INLINE_IMAGE_BYTES) {
    content.push({ type: "image", data: result.media.data.toString("base64"), mimeType: result.media.mime });
  }
  content.push({
    type: "text",
    text: `Done with ${model.label} on Flash for ${result.credits} credits. ${await balanceLine(ctx)}\nLink (anyone with it can open the file): ${result.url}`,
  });
  content.push({ type: "resource_link", uri: result.url, name: `${name}.${extFor(result.media.mime, "image")}`, mimeType: result.media.mime });
  return { content };
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
    case "flash_remove_background":
      return photoTool("remove-bg", args, ctx);
    case "flash_upscale_image":
      return photoTool("upscale", args, ctx);
    case "flash_edit_photo":
      return photoTool("flux-2-edit", args, ctx);
    case "flash_animate_photo":
      return animateTool(args, ctx);
    case "flash_publish_app": {
      const result = await publishSite(ctx.user, args);
      if ("error" in result) {
        return failed(result.code === "unverified" ? `The user needs to confirm their email in Flash (${ctx.origin}) before publishing apps.` : result.error);
      }
      // Who may change the app's data, as the person sees it in Flash after publishing.
      const rules = result.data ? dataLine(result.data) : "";
      return text(
        `Published "${str(args.title) || "My app"}" at ${ctx.origin}${result.url} (slug: ${result.slug}). Anyone with the link can open it. Free, no credits used.` +
          (rules ? ` ${rules}` : ""),
      );
    }
    case "flash_list_apps": {
      const sites = await listSites(ctx.user.id);
      if (!sites.length) return text("No published apps yet.");
      return text(sites.map((x) => `${x.title}: ${ctx.origin}/p/${x.slug} (slug: ${x.slug})`).join("\n"));
    }
    case "flash_check_credits": {
      await ensureMonthlyCredits(ctx.user.id);
      const { total, pool } = await spendable(ctx.user.id);
      return text(
        `${fullName(ctx.user)} has ${total.toLocaleString("en-US")} Flash credits` +
          (pool !== null ? ` (${pool.toLocaleString("en-US")} of them in their team's shared pool)` : "") +
          `. More credits: ${ctx.origin}/?credits=1`,
      );
    }
    default:
      return null;
  }
}
