import { EDITABLE_TYPE, route, textToSpeak } from "@/lib/router.ts";
import { MAX_EDIT_PIXELS, imageDimensions } from "@/lib/imageSize.ts";
import { ENGINES, ENGINE_LABELS, type ChatTurn, type Engine, type StreamEvent } from "@/lib/types.ts";
import {
  NO_BUDGET,
  classifyRequest,
  claudeConfigured,
  countInputTokens,
  improvePrompt,
  modelForEngine,
  streamSearch,
  streamText,
  system,
  writeScenes,
  type Budget,
  type Meter,
  type WritingMode,
} from "@/lib/engines/claude.ts";
import { checkFiles } from "@/lib/attachments.ts";
import { withInstructions } from "@/lib/project-instructions.ts";
import { profileNote } from "@/lib/names.ts";
import { withVoiceStyle } from "@/lib/voice-chat.ts";
import { brandForMedia, withBrand } from "@/lib/brand.ts";
import { getBrand } from "@/lib/server/brand.ts";
import { one } from "@/lib/server/db.ts";
import {
  FREE_CHAT_ENGINES,
  freeChatConfigured,
  freeEligible,
  freeImage,
  freeImageConfigured,
  freeTranscribe,
  freeTranscribeConfigured,
  streamFreeChat,
  type FreeLane,
} from "@/lib/engines/free.ts";
import { recordFree, recordFreeAudio, releaseFreeUser, reserveFree, reserveFreeAudio, reserveFreeImage, reserveFreeUser } from "@/lib/server/free.ts";
import { isVerified } from "@/lib/server/account.ts";
import {
  composeMusic,
  downloadVideo,
  elevenConfigured,
  generateImage,
  generateVideo,
  openaiConfigured,
  speechProvider,
  synthesizeSpeech,
  transcribe,
  type Media,
} from "@/lib/engines/media.ts";
import { appUrl, getUser, unauthorized } from "@/lib/server/auth.ts";
import { charge, ensureMonthlyCredits, logUsage, settle, spendable } from "@/lib/server/credits.ts";
import { saveFile } from "@/lib/server/files.ts";
import {
  MAX_SPEECH_CHARS,
  TYPICAL_CREDITS,
  creditsFor,
  finalCredits,
  planHold,
  readCostCents,
  transcribeCostCents,
  voiceCostCents,
} from "@/lib/credits.ts";
import { falConfigured, falGenerate } from "@/lib/engines/fal.ts";
import {
  MEDIA_ENGINES,
  PACK_IMAGE_CENTS,
  PACK_VIDEO_CENTS,
  PACK_VIDEO_ENDPOINT,
  PACK_VIDEO_SECONDS,
  modelCredits,
  movieScenes,
  movieSeconds,
  packWantsVideo,
  pickModel,
  type MediaEngine,
  type ModelInfo,
  type Provider,
} from "@/lib/models.ts";
import { unavailableReply } from "@/lib/engines/demo.ts";
import { FriendlyError, JobAbandoned } from "@/lib/engines/errors.ts";
import { buildSystem, streamBuild } from "@/lib/engines/builder.ts";
import { makeMovie } from "@/lib/engines/movie.ts";
import { DEFAULT_VOICE, pickVoice } from "@/lib/voices.ts";
import { falEditInput, falInput, packImageInput, packVideoInput, videoAspect } from "@/lib/engines/fal-input.ts";
import { writePack } from "@/lib/engines/post-pack.ts";
import { packMarkdown } from "@/lib/post-pack.ts";

// Vercel Pro allows up to 800 seconds, which the Movie maker needs (scenes, filming and joining).
export const maxDuration = 800;

// Vercel caps a request at 4.5 MB, and a file grows by a third when sent as base64.
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
// The engines that can read several files at once.
const WRITING_ENGINES: Engine[] = FREE_CHAT_ENGINES;
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
  // The user already agreed to this request's price (see CONFIRM_CREDITS).
  confirmed?: boolean;
  // The project this chat is in, for its instructions.
  projectId?: string;
  // The template the request was made from, named in the reply's header.
  template?: string;
  // Said out loud in a voice conversation: the writing engines answer in a few spoken sentences.
  voice?: boolean;
};

/** Requests that cost at least this many credits wait for the user to agree to the price first. */
const CONFIRM_CREDITS = 50;

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
  job: (report: (message: string) => void) => Promise<T>,
): AsyncGenerator<StreamEvent, T> {
  let latest = "";
  let reported = "";
  let finished = false;
  const work = job((message) => (latest = message)).finally(() => (finished = true));
  while (!finished) {
    await Promise.race([work.catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    if (latest && latest !== reported) {
      reported = latest;
      yield { type: "status", message: latest };
    }
  }
  return work;
}

/** Uses Claude to sharpen a media prompt when a Claude key exists, else sends the request as written. */
const sharpen = (kind: "image" | "video" | "music", request: string, meter: Meter, brand = "") =>
  claudeConfigured() ? improvePrompt(kind, request, meter, brand).catch(() => request) : Promise.resolve(request);

/** The bytes in a base64 attachment. */
const attachmentBytes = (a: { data: string }) => (a.data.length * 3) / 4;

/** The voice engine speaks at most MAX_SPEECH_CHARS, and is priced on exactly that text. */
const spokenText = (message: string) => textToSpeak(message).slice(0, MAX_SPEECH_CHARS);

/** The system prompt a Claude engine sends, so the credit hold counts it too. */
function systemFor(engine: Engine, preferences: string): string {
  if (engine === "app" || engine === "slides") return buildSystem(engine, preferences);
  return system(preferences, engine === "code" || engine === "translate" || engine === "docs" ? engine : "text");
}

/** What a media request on this model cost Flash, in cents. */
const mediaCents = (model: ModelInfo, request: string) =>
  typeof model.costCents === "function" ? model.costCents(request) : model.costCents;

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
): AsyncGenerator<StreamEvent> {
  if (!claudeConfigured()) throw new FriendlyError("Social post packs aren't available yet. Please try again later.");
  yield { type: "status", message: "Writing your posts and hashtags…" };
  const pack = await writePack(request, about, meter, brandNote).catch((err) => {
    if (err instanceof FriendlyError) throw err;
    console.error("[flash] post pack writing failed", err);
    throw new FriendlyError("Flash couldn't write the posts this time. Please try again.");
  });
  const video = packWantsVideo(request);
  yield {
    type: "text",
    delta:
      packMarkdown(pack.posts) +
      "\n\n**Pictures:** square for Instagram and Facebook posts, tall for TikTok, Reels and Stories." +
      (video
        ? ` The ${PACK_VIDEO_SECONDS} second video is silent, so you can add a trending sound in TikTok or Instagram.`
        : ` For a ${PACK_VIDEO_SECONDS} second video too, ask for "a social post pack with a video".`),
  };
  yield { type: "posts", posts: pack.posts };

  yield { type: "status", message: "Painting a square and a tall picture with FLUX.2 Pro…" };
  const billPicture = (err: unknown): never => {
    if (err instanceof JobAbandoned && err.billed) meter("fal", "flux-2-pro", PACK_IMAGE_CENTS);
    throw err;
  };
  const shapes = ["square", "tall"] as const;
  const labels = { square: "Square, for posts", tall: "Tall, for TikTok, Reels and Stories" };
  const pictures = yield* withProgress((report) =>
    Promise.allSettled(
      shapes.map((shape) =>
        falGenerate(model.endpoint!, packImageInput(pack.picture, shape), (m) => report(`Painting your pictures… ${m.toLowerCase()}`)).then(
          (image) => (meter("fal", "flux-2-pro", PACK_IMAGE_CENTS), image),
          billPicture,
        ),
      ),
    ),
  );
  for (const [i, result] of pictures.entries()) {
    if (result.status !== "fulfilled") continue;
    yield { type: "image", url: await store(result.value, `flash-post-${shapes[i]}.png`), prompt: pack.picture, label: labels[shapes[i]] };
  }
  const failed = pictures.findIndex((r) => r.status === "rejected");
  if (failed !== -1) {
    console.error(`[flash] post pack ${shapes[failed]} picture failed`, (pictures[failed] as PromiseRejectedResult).reason);
    throw new FriendlyError(`The ${shapes[failed]} picture didn't come out, but your posts are ready above. Please try again for the pictures.`);
  }
  const tall = pictures[1].status === "fulfilled" ? pictures[1].value : null;
  if (!video || !tall) return;

  yield { type: "status", message: `Filming a ${PACK_VIDEO_SECONDS} second video from the tall picture. This usually takes one to three minutes…` };
  const clip = yield* withProgress((report) =>
    falGenerate(
      PACK_VIDEO_ENDPOINT,
      packVideoInput(`data:${tall.mime};base64,${tall.data.toString("base64")}`, pack.motion),
      (m) => report(`Filming your video… ${m.toLowerCase()}`),
    ).catch((err) => {
      if (err instanceof JobAbandoned && err.billed) meter("fal", "kling-3-animate", PACK_VIDEO_CENTS);
      console.error("[flash] post pack video failed", err);
      throw new FriendlyError("The video didn't come out, but your posts and pictures are ready above.");
    }),
  );
  meter("fal", "kling-3-animate", PACK_VIDEO_CENTS);
  yield { type: "video", url: await store(clip, "flash-post-video.mp4"), prompt: pack.motion || pack.picture };
}

async function* run(
  engine: Engine,
  history: ChatTurn[],
  preferences: string,
  store: Store,
  model: ModelInfo | null,
  meter: Meter,
  budget: Budget,
  // The brand kit for the picture and video prompt writer, or "".
  brandNote = "",
): AsyncGenerator<StreamEvent> {
  const last = history[history.length - 1];
  if (isMedia(engine) ? !model : !configured(engine)) {
    yield* unavailableReply(engine);
    return;
  }
  // A media job the provider bills even though it ended without a result is charged too.
  const billIfAbandoned = (err: unknown): never => {
    if (err instanceof JobAbandoned && err.billed) meter(model!.provider, model!.id, mediaCents(model!, last.content));
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
    case "docs":
      yield* streamText(history, preferences, engine, meter, budget);
      return;
    case "search":
      yield* streamSearch(history, preferences, meter, budget);
      return;
    case "app":
    case "slides":
      yield* streamBuild(history, preferences, engine, meter, budget);
      return;
    case "image": {
      if (model!.edits) {
        const photo = last.attachment!;
        yield { type: "status", message: `Working on your photo with ${model!.label}…` };
        const edited = yield* withProgress((report) =>
          falGenerate(
            model!.endpoint!,
            // The photo was checked to be at most 2048 × 2048 before credits were held.
            falEditInput(model!, `data:${photo.mediaType};base64,${photo.data}`, imageDimensions(Buffer.from(photo.data, "base64")), last.content),
            (m) => report(`${m}…`),
          ).catch(billIfAbandoned),
        );
        meter(model!.provider, model!.id, mediaCents(model!, last.content));
        yield { type: "image", url: await store(edited, `flash-${model!.id === "flux-2-edit" ? "edit" : model!.id}.png`), prompt: last.content };
        return;
      }
      if (model!.id === "post-pack") {
        yield* postPack(last.content, preferences, brandNote, model!, store, meter);
        return;
      }
      const prompt = await sharpen("image", last.content, meter, brandNote);
      yield { type: "status", message: `Painting your image with ${model!.label}…` };
      const image =
        model!.provider === "fal"
          ? yield* withProgress((report) =>
              falGenerate(model!.endpoint!, falInput(model!, prompt, last.content), (m) => report(`${m}…`)).catch(
                billIfAbandoned,
              ),
            )
          : await generateImage(prompt);
      meter(model!.provider, model!.id, mediaCents(model!, last.content));
      yield { type: "image", url: await store(image, "flash-image.png"), prompt };
      return;
    }
    case "video": {
      if (model!.edits) {
        const photo = last.attachment!;
        yield { type: "status", message: `Bringing your photo to life with ${model!.label}. This usually takes one to three minutes…` };
        const clip = yield* withProgress((report) =>
          falGenerate(
            model!.endpoint!,
            falEditInput(model!, `data:${photo.mediaType};base64,${photo.data}`, null, last.content),
            (m) => report(`Animating… ${m.toLowerCase()}`),
          ).catch(billIfAbandoned),
        );
        meter(model!.provider, model!.id, mediaCents(model!, last.content));
        yield { type: "video", url: await store(clip, "flash-animated.mp4"), prompt: last.content };
        return;
      }
      if (model!.id === "movie") {
        const { scenes: count, seconds } = movieScenes(movieSeconds(last.content));
        yield { type: "status", message: `Writing ${count} scenes for your movie…` };
        const scenes = claudeConfigured()
          ? await writeScenes(last.content, count, seconds, meter).catch((err) => {
              console.error("[flash] scene writing failed", err);
              throw new FriendlyError("Flash couldn't write the scenes for this movie. Nothing was filmed. Please try again.");
            })
          : Array.from({ length: count }, (_, i) => `Scene ${i + 1} of ${count}: ${last.content}`);
        yield {
          type: "text",
          delta: `**Your movie, in ${scenes.length} scenes:**\n\n${scenes.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
        };
        yield { type: "status", message: "Filming every scene at once. This usually takes three to eight minutes…" };
        const movie = yield* withProgress((report) => makeMovie(model!.endpoint!, scenes, seconds, meter, report, videoAspect(last.content)));
        yield { type: "video", url: await store(movie, "flash-movie.mp4"), prompt: last.content };
        return;
      }
      const prompt = await sharpen("video", last.content, meter, brandNote);
      yield { type: "status", message: `Filming your video with ${model!.label}. This usually takes one to three minutes…` };
      let video: Media;
      if (model!.provider === "fal") {
        video = yield* withProgress((report) =>
          falGenerate(model!.endpoint!, falInput(model!, prompt, last.content), (m) =>
            report(`Filming your video… ${m.toLowerCase()}`),
          ).catch(billIfAbandoned),
        );
      } else {
        const id = yield* withProgress((report) =>
          generateVideo(prompt, (pct) => pct && report(`Filming your video… ${pct}%`)).catch(billIfAbandoned),
        );
        yield { type: "status", message: "Saving your video…" };
        video = await downloadVideo(id).catch((err) => {
          console.error("[flash] video download failed", err);
          return billIfAbandoned(new JobAbandoned("Flash couldn't fetch the video. Please try again.", true));
        });
      }
      meter(model!.provider, model!.id, mediaCents(model!, last.content));
      yield { type: "video", url: await store(video, "flash-video.mp4"), prompt };
      return;
    }
    case "voice": {
      const words = spokenText(last.content);
      const { voice, speed } = pickVoice(last.content);
      const named = speechProvider() === "fal";
      yield {
        type: "text",
        delta:
          `Here is "${words.length > 80 ? words.slice(0, 80) + "…" : words}" read aloud` +
          (named ? ` by ${voice.name}, a ${voice.about}.` : ".") +
          (named && voice === DEFAULT_VOICE ? ` For another voice, ask for one, like "in a deep British man's voice".` : ""),
      };
      const voiceCents = voiceCostCents(words.length);
      const speech = await synthesizeSpeech(words, { voice: voice.name, speed }).catch(billSpeech("voice", voiceCents));
      meter(speechProvider()!, "voice", voiceCents);
      yield { type: "audio", url: await store(speech, "flash-voice.mp3"), label: "flash-voice.mp3" };
      return;
    }
    case "music": {
      const prompt = await sharpen("music", last.content, meter);
      yield { type: "status", message: `Composing your track with ${model!.label}…` };
      yield { type: "text", delta: `**Track brief:** ${prompt}` };
      const track =
        model!.provider === "fal"
          ? yield* withProgress((report) =>
              falGenerate(model!.endpoint!, falInput(model!, prompt, last.content), (m) =>
                report(`Composing… ${m.toLowerCase()}`),
              ).catch(billIfAbandoned),
            )
          : await composeMusic(prompt);
      meter(model!.provider, model!.id, mediaCents(model!, last.content));
      yield { type: "audio", url: await store(track, "flash-music.mp3"), label: "flash-music.mp3" };
      return;
    }
    case "transcribe": {
      if (!last.attachment) {
        yield { type: "text", delta: "Attach an audio or video file with the 📎 button and Flash will transcribe it." };
        return;
      }
      yield { type: "status", message: `Transcribing ${last.attachment.name}…` };
      const transcribeCents = transcribeCostCents(attachmentBytes(last.attachment));
      const text = await transcribe(last.attachment).catch(billSpeech("transcribe", transcribeCents));
      meter(speechProvider()!, "transcribe", transcribeCents);
      yield { type: "text", delta: `**Transcript of ${last.attachment.name}**\n\n${text}` };
      return;
    }
  }
}

/** The free lane: open-source models on free tiers, for users who are out of credits. */
async function* runFree(
  lane: FreeLane,
  engine: Engine,
  history: ChatTurn[],
  preferences: string,
  store: Store,
  used: { provider: string; model: string },
): AsyncGenerator<StreamEvent> {
  const last = history[history.length - 1];
  if (lane === "image") {
    if (!(await reserveFreeImage())) {
      throw new FriendlyError("Today's free images are used up across Flash. They reset tomorrow, or you can get more credits.");
    }
    used.provider = "cloudflare";
    used.model = "flux-1-schnell";
    yield { type: "status", message: "Painting your image with FLUX.1 schnell (free)…" };
    const image = await freeImage(last.content);
    yield { type: "image", url: await store(image, "flash-image.jpg"), prompt: last.content };
    return;
  }
  if (lane === "transcribe") {
    const file = last.attachment!;
    if (!(await reserveFreeAudio())) {
      throw new FriendlyError("Today's free transcripts are used up across Flash. They reset tomorrow, or you can get more credits.");
    }
    used.provider = "groq";
    used.model = "whisper-large-v3-turbo";
    yield { type: "status", message: `Transcribing ${file.name} with Whisper (free)…` };
    const { text, seconds } = await freeTranscribe(file);
    await recordFreeAudio(seconds);
    yield { type: "text", delta: `**Transcript of ${file.name}**\n\n${text}` };
    return;
  }
  yield* streamFreeChat(history, preferences, engine as WritingMode, reserveFree, recordFree, (label, provider) => {
    used.provider = provider;
    used.model = label;
  });
}

/** What the error message says about credits after a failed request. */
function refundNote(held: number, credits: number): string {
  if (!held) return "";
  if (!credits) return " Your credits were refunded.";
  if (credits >= held) return ` The AI provider charged for the work already done, so this used ${credits} credits.`;
  return ` Your credits were partly refunded: ${credits} paid for the work already done.`;
}

export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  let body: ChatRequest;
  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const history = (body.messages ?? []).slice(-30);
  const last = history[history.length - 1];
  if (!last || last.role !== "user") {
    return Response.json({ error: "The last message must be from the user." }, { status: 400 });
  }
  if (last.attachment && attachmentBytes(last.attachment) > MAX_ATTACHMENT_BYTES) {
    return Response.json({ error: "Files must be 3 MB or smaller." }, { status: 413 });
  }
  const filesProblem = checkFiles(last.attachment, last.more);
  if (filesProblem) return Response.json({ error: filesProblem }, { status: 413 });
  const severalFiles = Boolean(last.more?.length);
  if (typeof last.content !== "string" || last.content.length > MAX_MESSAGE_CHARS) {
    return Response.json(
      { error: "This message is too long. Send a shorter one, or attach the text as a file." },
      { status: 413 },
    );
  }

  const previous = body.previous && (ENGINES as readonly string[]).includes(body.previous) ? body.previous : undefined;
  const auto = route(last.content, last.attachment?.mediaType, previous);
  const override =
    body.engine && body.engine !== "auto" && (ENGINES as readonly string[]).includes(body.engine) ? body.engine : null;
  let engine = override ?? auto.engine;
  let reason = override
    ? typeof body.template === "string" && body.template.trim()
      ? `Made from the ${body.template.trim().slice(0, 40)} template.`
      : "You picked this engine."
    : auto.reason;
  // Several files are read and compared by the writing engines; media tools take one file.
  if (severalFiles && !WRITING_ENGINES.includes(engine)) {
    engine = "docs";
    reason = "Flash reads several files together.";
  }

  // Everything this request spends with AI providers, for credits and the owner dashboard.
  const spend: { provider: string; model: string; cents: number }[] = [];
  const meter: Meter = (provider, model, cents) => spend.push({ provider, model, cents });

  await ensureMonthlyCredits(user.id);
  // A team member spends the shared pool first. One ledger pays for each request, so the hold
  // is sized to the larger balance.
  const available = (await spendable(user.id)).largest;

  // When no keyword rule fits, a small, fast model reads the request and picks the engine.
  // Skipped for users out of credits, so the free lane costs Flash nothing.
  if (!override && auto.guessed && !last.attachment && claudeConfigured() && available >= 5) {
    const guess = await classifyRequest(last.content, meter);
    // A guess is only a guess, so it never sends a request to an engine that isn't available yet.
    const ready = (e: Engine) => (isMedia(e) ? Boolean(pickModel(e, last.content, providers())) : configured(e));
    if (guess && guess !== "text" && guess !== "transcribe" && ready(guess)) {
      engine = guess;
      reason = "Flash's router read your request.";
    }
  }

  // An image request with a photo attached edits it; a video request animates it.
  const editing = (engine === "image" || engine === "video") && Boolean(last.attachment && EDITABLE_TYPE.test(last.attachment.mediaType));
  if (editing) {
    const editSize = imageDimensions(Buffer.from(last.attachment!.data, "base64"));
    if (!editSize || editSize.width * editSize.height > MAX_EDIT_PIXELS) {
      return Response.json(
        { error: "Flash can edit PNG, JPEG and WebP photos up to 2048 × 2048 pixels. Try a smaller photo." },
        { status: 400 },
      );
    }
  }
  const picked = isMedia(engine) ? pickModel(engine, last.content, providers(), body.model, editing) : null;
  const model = picked?.model ?? null;

  // Engines that aren't available yet reply for free. Media has a fixed price per model. Claude engines are charged by
  // length: Flash holds up to a limit, then keeps only what the reply really cost.
  const live = isMedia(engine) ? Boolean(model) : configured(engine);
  const metered = live && !isMedia(engine) && engine !== "voice" && engine !== "transcribe";
  const project =
    typeof body.projectId === "string"
      ? await one<{ instructions: string }>("SELECT instructions FROM projects WHERE id = ? AND user_id = ?", [body.projectId, user.id])
      : null;
  const brand = await getBrand(user.id, appUrl(request));
  // What the user asked to be called and their work (Settings > General), then their memory.
  const memory = (typeof body.preferences === "string" ? body.preferences : user.preferences).slice(0, MAX_PREFERENCES_CHARS);
  const preferences = withVoiceStyle(
    withBrand(withInstructions([profileNote(user), memory].filter((p) => p.trim()).join("\n"), project?.instructions ?? ""), brand),
    engine,
    body.voice,
  );
  let held = 0;
  let needed = 0;
  let budget = NO_BUDGET;
  // What reading the input once costs, charged even when the user stops the reply.
  let inputCents = 0;
  if (live) {
    if (model) held = needed = modelCredits(model, last.content);
    else if (engine === "voice") held = needed = creditsFor(voiceCostCents(spokenText(last.content).length));
    else if (engine === "transcribe") {
      // Priced by file size (see transcribeCostCents); with no file, the engine just asks for one.
      held = needed = last.attachment ? creditsFor(transcribeCostCents(attachmentBytes(last.attachment))) : 0;
    } else {
      // The reply may only spend what the held credits pay for, so no request runs at a loss.
      const claudeModel = modelForEngine(engine);
      const inputTokens = await countInputTokens(claudeModel, history, systemFor(engine, preferences));
      const hold = planHold(engine, claudeModel, inputTokens, available);
      ({ needed, held } = hold);
      budget = { maxTokens: hold.maxTokens, capCents: hold.capCents };
      inputCents = readCostCents(claudeModel, inputTokens);
    }
  }
  // Out of credits: chat-style requests and images fall back to free open-source models,
  // up to a daily allowance per user.
  let free: FreeLane | null = null;
  const verified = isVerified(user);
  if (live && available < needed && verified) {
    // A post pack has no free version: one free picture isn't what was asked for.
    const lane = model?.id === "post-pack" ? null : freeEligible(engine, last);
    if (lane) {
      if (!(await reserveFreeUser(user.id, lane))) {
        return Response.json(
          {
            error: `You've used today's free ${lane === "image" ? "images" : lane === "transcribe" ? "transcripts" : "messages"} and you have ${available} credits. Free use resets tomorrow, or get more credits now.`,
            code: "out_of_credits",
            needed,
          },
          { status: 402 },
        );
      }
      free = lane;
      held = needed = 0;
      budget = NO_BUDGET;
    }
  }
  if (model && !free && needed >= CONFIRM_CREDITS && available >= needed && body.confirmed !== true) {
    const what =
      model.id === "post-pack"
        ? "social post pack with a video"
        : `${model.label} ${engine === "video" ? (model.id === "movie" ? "movie" : "video") : engine === "music" ? "track" : engine}`;
    return Response.json(
      {
        error: `This ${what} uses ${needed.toLocaleString("en-US")} credits. You have ${available.toLocaleString("en-US")}.`,
        code: "confirm_cost",
        needed,
      },
      { status: 409 },
    );
  }
  const freeUse = { provider: "", model: "" };
  const chargeId = held ? await charge(user.id, held, `${engine} request`) : 0;
  if (chargeId === null) {
    return Response.json(
      {
        error:
          `This needs ${metered ? "at least " : ""}${needed} credits and you have ${available}.` +
          (!verified
            ? " Confirm your email to get your free credits and free daily messages."
            : "") +
          (verified && freeChatConfigured()
            ? " Free models still answer chat, writing, code and translation" +
              (freeImageConfigured() ? ", make images" : "") +
              (freeTranscribeConfigured() ? ", and transcribe short recordings." : ".")
            : ""),
        code: "out_of_credits",
        needed,
      },
      { status: 402 },
    );
  }
  // Saved files take the extension of what the provider really sent, so downloads open correctly.
  const store: Store = (media, name) => saveFile(user.id, media.mime, withExtension(name, media.mime), media.data);

  const encoder = new TextEncoder();
  // Set when the browser stops reading (the user pressed Stop), so the engine stops too.
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    async start(controller) {
      const send = (e: StreamEvent) => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          cancelled = true;
        }
      };
      send({
        type: "route",
        engine,
        reason,
        demo: !live,
        cost: metered && !free ? 0 : held,
        ...(free
          ? { free: true, model: free === "image" ? "FLUX.1 schnell" : free === "transcribe" ? "Whisper" : "Open-source model", modelWhy: "You're out of credits, so Flash used a free model." }
          : model && { model: model.label, modelWhy: picked!.why }),
      });
      let ok = true;
      let stopped = false;
      let failure = "";
      let written = 0;
      try {
        const events = free
          ? runFree(free, engine, history, preferences, store, freeUse)
          : run(engine, history, preferences, store, model, meter, budget, brandForMedia(brand));
        for await (const event of events) {
          if (cancelled || request.signal.aborted) {
            stopped = true;
            break;
          }
          if (event.type === "text") written += event.delta.length;
          send(event);
        }
      } catch (err) {
        console.error(`[flash] ${engine} engine failed`, err);
        ok = false;
        // Provider errors can hold raw responses, so only messages written for the user are shown.
        failure =
          err instanceof FriendlyError
            ? err.message
            : `${engine === "text" ? "Flash" : ENGINE_LABELS[engine]} is busy right now. Please try again in a moment.`;
      }
      const costCents = spend.reduce((sum, s) => sum + s.cents, 0);
      // A failed request costs only the provider work that really ran. A stopped reply is
      // charged for reading its input and what it wrote, or a typical reply. The free lane is free.
      const credits = free
        ? 0
        : finalCredits({ held, ok, stopped, metered, costCents, inputCents, written, typical: TYPICAL_CREDITS[engine] ?? 4 });
      await settle(chargeId, credits);
      // A free request that failed doesn't use up one of the user's free requests for today.
      if (free && !ok) await releaseFreeUser(user.id, free).catch((err) => console.error("[flash] free release failed", err));
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
        }).catch((err) => console.error("[flash] usage log failed", err));
      }
      if (!ok) send({ type: "error", message: failure + refundNote(held, credits) });
      if (cancelled) return;
      if (metered && ok && !free) send({ type: "cost", credits });
      send({ type: "done" });
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
