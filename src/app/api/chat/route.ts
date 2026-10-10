import { EDITABLE_TYPE, checksSpoken, fixesPictureText, route, takesGuess, textToSpeak } from "@/lib/router.ts";
import { MAX_EDIT_PIXELS, imageDimensions } from "@/lib/imageSize.ts";
import { ENGINES, ENGINE_LABELS, type Attachment, type ChatTurn, type Engine, type StreamEvent } from "@/lib/types.ts";
import {
  NO_BUDGET,
  claudeChoice,
  classifyRequest,
  defaultChoice,
  pictureRequest,
  claudeConfigured,
  countInputTokens,
  improvePrompt,
  streamSearch,
  streamText,
  system,
  withStepDown,
  writeScenes,
  type Budget,
  type ClaudeChoice,
  type Meter,
  type WritingMode,
} from "@/lib/engines/claude.ts";
import { autoLevel, isLevel, levelName, type ModelLevel } from "@/lib/levels.ts";
import { checkFiles } from "@/lib/attachments.ts";
import { withInstructions } from "@/lib/project-instructions.ts";
import { profileNote } from "@/lib/names.ts";
import { pictureWordsNote } from "@/lib/languages.ts";
import { withVoiceStyle } from "@/lib/voice-chat.ts";
import { brandForMedia, withBrand } from "@/lib/brand.ts";
import { getBrand } from "@/lib/server/brand.ts";
import { one } from "@/lib/server/db.ts";
import {
  FREE_CHAT_ENGINES,
  MIN_AUDIO_SECONDS,
  freeChatConfigured,
  freeEligible,
  freeImage,
  freeImageConfigured,
  freeTranscribe,
  freeTranscribeConfigured,
  streamFreeChat,
  type FreeLane,
} from "@/lib/engines/free.ts";
import {
  AUDIO_SECONDS_RESERVE,
  countryOf,
  freeAudioFailed,
  recordFree,
  recordFreeAudio,
  releaseFreeUser,
  reserveFree,
  reserveFreeAudio,
  reserveFreeImage,
  reserveFreeUser,
} from "@/lib/server/free.ts";
import { audioLength, billableSeconds } from "@/lib/server/audio-length.ts";
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
  NO_SPEECH,
  type Media,
} from "@/lib/engines/media.ts";
import { appUrl, getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { english, msg, type Translate } from "@/lib/i18n.ts";
import { charge, ensureMonthlyCredits, logUsage, settle, spendable } from "@/lib/server/credits.ts";
import { saveFile } from "@/lib/server/files.ts";
import {
  MAX_SPEECH_CHARS,
  TYPICAL_CREDITS,
  claudePrice,
  creditsFor,
  finalCredits,
  planHold,
  readCostCents,
  transcribeCostCents,
  voiceCostCents,
} from "@/lib/credits.ts";
import { falConfigured, falGenerate, type FalProgress } from "@/lib/engines/fal.ts";
import {
  MEDIA_ENGINES,
  MODELS,
  PACK_IMAGE_CENTS,
  PACK_VIDEO_CENTS,
  PACK_VIDEO_ENDPOINT,
  PACK_VIDEO_SECONDS,
  MAX_EDIT_PHOTOS,
  modelCredits,
  requestCents,
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
import { buildSystem, latestApp, streamBuild } from "@/lib/engines/builder.ts";
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
  // The user agrees to every price (Go ahead with "always", on their device), or agreed to this
  // request's in a chat saved before prices were kept with their engine (see CONFIRM_CREDITS).
  confirmed?: boolean;
  // The price the user said yes to: the engine and model it was for, and its credits. The request
  // runs on exactly that, and is asked about again if that can't be.
  agreed?: Agreed;
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
};

/** Requests that cost at least this many credits wait for the user to agree to the price first. */
const CONFIRM_CREDITS = 50;

/** A price the user was asked about: the engine and model it's for and its credits (sent back with "yes"). */
type Agreed = { engine: MediaEngine; model: string; credits: number };
const agreedPrice = (a: unknown): Agreed | null => {
  const { engine, model, credits } = (a ?? {}) as Partial<Agreed>;
  if (typeof engine !== "string" || !(MEDIA_ENGINES as string[]).includes(engine)) return null;
  if (typeof model !== "string" || typeof credits !== "number" || !Number.isFinite(credits) || credits <= 0) return null;
  return { engine, model, credits };
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

/** A transcript under its heading, with Flash's own words in the user's language. */
const transcript = (name: string, text: string, t: Translate) =>
  `**${t("Transcript of {name}", { name })}**\n\n${text === NO_SPEECH ? t(NO_SPEECH) : text}`;

/** The bytes in a base64 attachment. */
const attachmentBytes = (a: { data: string }) => (a.data.length * 3) / 4;

/** How long a recording plays, when Flash can measure it (see audio-length.ts); 0 when it can't. */
function recordingSeconds(a: { data: string }): number {
  const length = audioLength(Buffer.from(a.data, "base64"));
  return length ? billableSeconds(length) : 0;
}

/** What transcribing a file costs: its measured length, and at least what its size could hold. */
const transcriptCents = (a: { data: string }) => transcribeCostCents(attachmentBytes(a), recordingSeconds(a));

/** The voice engine speaks at most MAX_SPEECH_CHARS, and is priced on exactly that text. */
const spokenText = (message: string) => textToSpeak(message).slice(0, MAX_SPEECH_CHARS);

/** The system prompt a Claude engine sends, so the credit hold counts it too. */
function systemFor(engine: Engine, preferences: string, history: ChatTurn[]): string {
  if (engine === "app" || engine === "slides") return buildSystem(engine, preferences, latestApp(history) !== null);
  return system(preferences, engine === "code" || engine === "translate" || engine === "docs" ? engine : "text");
}

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
  t: Translate,
): AsyncGenerator<StreamEvent> {
  if (!claudeConfigured()) throw new FriendlyError(msg("Social post packs aren't available yet. Please try again later."));
  yield { type: "status", message: t("Writing your posts and hashtags…") };
  const pack = await writePack(request, about, meter, brandNote).catch((err) => {
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
  const pictures = yield* withProgress((report) => {
    const painting = falReport(t, report, msg("Painting your pictures… working"), msg("Painting your pictures… in line (position {position})"));
    return Promise.allSettled(
      shapes.map((shape) =>
        falGenerate(model.endpoint!, packImageInput(pack.picture, shape), painting).then(
          (image) => (meter("fal", "flux-2-pro", PACK_IMAGE_CENTS), image),
          billPicture,
        ),
      ),
    );
  });
  for (const [i, result] of pictures.entries()) {
    if (result.status !== "fulfilled") continue;
    yield { type: "image", url: await store(result.value, `flash-post-${shapes[i]}.png`), prompt: pack.picture, label: labels[shapes[i]] };
  }
  const failed = pictures.findIndex((r) => r.status === "rejected");
  if (failed !== -1) {
    console.error(`[flash] post pack ${shapes[failed]} picture failed`, (pictures[failed] as PromiseRejectedResult).reason);
    throw new FriendlyError(
      shapes[failed] === "square"
        ? msg("The square picture didn't come out, but your posts are ready above. Please try again for the pictures.")
        : msg("The tall picture didn't come out, but your posts are ready above. Please try again for the pictures."),
    );
  }
  const tall = pictures[1].status === "fulfilled" ? pictures[1].value : null;
  if (!video || !tall) return;

  yield { type: "status", message: t("Filming a {seconds} second video from the tall picture. This usually takes one to three minutes…", seconds) };
  const clip = yield* withProgress((report) =>
    falGenerate(
      PACK_VIDEO_ENDPOINT,
      packVideoInput(`data:${tall.mime};base64,${tall.data.toString("base64")}`, pack.motion),
      falReport(t, report, msg("Filming your video… working"), msg("Filming your video… in line (position {position})")),
    ).catch((err) => {
      if (err instanceof JobAbandoned && err.billed) meter("fal", "kling-3-animate", PACK_VIDEO_CENTS);
      console.error("[flash] post pack video failed", err);
      throw new FriendlyError(msg("The video didn't come out, but your posts and pictures are ready above."));
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
  // The brand kit and the language of words in pictures, for the picture and video prompt writer, or "".
  brandNote = "",
  // The level a Claude engine runs on, and what to do when it steps down to another.
  choice: ClaudeChoice | null = null,
  onStepDown: (choice: ClaudeChoice) => void = () => {},
  // The language Flash's own words (progress, notes, errors) are in.
  t: Translate & { language?: string } = english,
): AsyncGenerator<StreamEvent> {
  const last = history[history.length - 1];
  if (isMedia(engine) ? !model : !configured(engine)) {
    yield* unavailableReply(engine, t);
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
      yield* withStepDown(choice ?? claudeChoice(engine, "ascend"), (c) => streamText(history, preferences, engine, meter, budget, c, t), onStepDown, t);
      return;
    case "search":
      yield* withStepDown(choice ?? claudeChoice(engine, "ascend"), (c) => streamSearch(history, preferences, meter, budget, c, t), onStepDown, t);
      return;
    case "app":
    case "slides":
      yield* withStepDown(choice ?? claudeChoice(engine, "vision"), (c) => streamBuild(history, preferences, engine, meter, budget, c, t), onStepDown, t);
      return;
    case "image": {
      if (model!.edits) {
        const photo = last.attachment!;
        // Photos after the first are combined with it; only FLUX.2 Edit is given more than one.
        const more = model!.id === "flux-2-edit" ? (last.more ?? []).slice(0, MAX_EDIT_PHOTOS - 1) : [];
        const dataUrl = (f: Attachment) => `data:${f.mediaType};base64,${f.data}`;
        const label = { model: model!.label };
        yield { type: "status", message: more.length ? t("Combining your photos with {model}…", label) : t("Working on your photo with {model}…", label) };
        const edited = yield* withProgress((report) =>
          falGenerate(
            model!.endpoint!,
            // Each photo was checked to be at most 2048 × 2048 before credits were held.
            falEditInput(model!, dataUrl(photo), imageDimensions(Buffer.from(photo.data, "base64")), last.content, more.map(dataUrl)),
            falReport(t, report, msg("Working…"), msg("In line (position {position})…")),
          ).catch(billIfAbandoned),
        );
        meter(model!.provider, model!.id, mediaCents(model!, last.content, 1 + more.length));
        yield { type: "image", url: await store(edited, `flash-${model!.id === "flux-2-edit" ? "edit" : model!.id}.png`), prompt: last.content };
        return;
      }
      if (model!.id === "post-pack") {
        yield* postPack(last.content, preferences, brandNote, model!, store, meter, t);
        return;
      }
      const prompt = await sharpen("image", last.content, meter, brandNote);
      yield { type: "status", message: t("Painting your image with {model}…", { model: model!.label }) };
      const image =
        model!.provider === "fal"
          ? yield* withProgress((report) =>
              falGenerate(
                model!.endpoint!,
                falInput(model!, prompt, last.content),
                falReport(t, report, msg("Working…"), msg("In line (position {position})…")),
              ).catch(billIfAbandoned),
            )
          : await generateImage(prompt);
      meter(model!.provider, model!.id, mediaCents(model!, last.content));
      yield { type: "image", url: await store(image, "flash-image.png"), prompt };
      return;
    }
    case "video": {
      if (model!.edits) {
        const photo = last.attachment!;
        yield { type: "status", message: t("Bringing your photo to life with {model}. This usually takes one to three minutes…", { model: model!.label }) };
        const clip = yield* withProgress((report) =>
          falGenerate(
            model!.endpoint!,
            falEditInput(model!, `data:${photo.mediaType};base64,${photo.data}`, null, last.content),
            falReport(t, report, msg("Animating… working"), msg("Animating… in line (position {position})")),
          ).catch(billIfAbandoned),
        );
        meter(model!.provider, model!.id, mediaCents(model!, last.content));
        yield { type: "video", url: await store(clip, "flash-animated.mp4"), prompt: last.content };
        return;
      }
      if (model!.id === "movie") {
        const { scenes: count, seconds } = movieScenes(movieSeconds(last.content));
        yield { type: "status", message: t("Writing {count} scenes for your movie…", { count }) };
        const scenes = claudeConfigured()
          ? await writeScenes(last.content, count, seconds, meter).catch((err) => {
              console.error("[flash] scene writing failed", err);
              throw new FriendlyError(msg("Flash couldn't write the scenes for this movie. Nothing was filmed. Please try again."));
            })
          : // Prompts for the video model, so in English.
            Array.from({ length: count }, (_, i) => `Scene ${i + 1} of ${count}: ${last.content}`);
        yield {
          type: "text",
          delta: `**${t("Your movie, in {count} scenes:", { count: scenes.length })}**\n\n${scenes.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
        };
        yield { type: "status", message: t("Filming every scene at once. This usually takes three to eight minutes…") };
        const movie = yield* withProgress((report) => makeMovie(model!.endpoint!, scenes, seconds, meter, report, videoAspect(last.content), t));
        yield { type: "video", url: await store(movie, "flash-movie.mp4"), prompt: last.content };
        return;
      }
      const prompt = await sharpen("video", last.content, meter, brandNote);
      yield { type: "status", message: t("Filming your video with {model}. This usually takes one to three minutes…", { model: model!.label }) };
      let video: Media;
      if (model!.provider === "fal") {
        video = yield* withProgress((report) =>
          falGenerate(
            model!.endpoint!,
            falInput(model!, prompt, last.content),
            falReport(t, report, msg("Filming your video… working"), msg("Filming your video… in line (position {position})")),
          ).catch(billIfAbandoned),
        );
      } else {
        const id = yield* withProgress((report) =>
          generateVideo(prompt, (pct) => pct && report(t("Filming your video… {percent}%", { percent: pct }))).catch(billIfAbandoned),
        );
        yield { type: "status", message: t("Saving your video…") };
        video = await downloadVideo(id).catch((err) => {
          console.error("[flash] video download failed", err);
          return billIfAbandoned(new JobAbandoned(msg("Flash couldn't fetch the video. Please try again."), true));
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
      const speech = await synthesizeSpeech(words, { voice: voice.name, speed }).catch(billSpeech("voice", voiceCents));
      meter(speechProvider()!, "voice", voiceCents);
      yield { type: "audio", url: await store(speech, "flash-voice.mp3"), label: "flash-voice.mp3" };
      return;
    }
    case "music": {
      const prompt = await sharpen("music", last.content, meter);
      yield { type: "status", message: t("Composing your track with {model}…", { model: model!.label }) };
      yield { type: "text", delta: `**${t("Track brief:")}** ${prompt}` };
      const track =
        model!.provider === "fal"
          ? yield* withProgress((report) =>
              falGenerate(
                model!.endpoint!,
                falInput(model!, prompt, last.content),
                falReport(t, report, msg("Composing… working"), msg("Composing… in line (position {position})")),
              ).catch(billIfAbandoned),
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
      yield { type: "status", message: t("Transcribing {name}…", { name: last.attachment.name }) };
      const transcribeCents = transcriptCents(last.attachment);
      const text = await transcribe(last.attachment).catch(billSpeech("transcribe", transcribeCents));
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
    // Groq counts at least 10 seconds a file; one Flash can't measure holds room for a long recording.
    const seconds = recordingSeconds(file);
    const reserve = seconds ? Math.max(MIN_AUDIO_SECONDS, Math.ceil(seconds)) : AUDIO_SECONDS_RESERVE;
    if (!(await reserveFreeAudio(reserve))) {
      throw new FriendlyError(msg("Today's free transcripts are used up across Flash. They reset tomorrow, or you can get more credits."));
    }
    audio.reserved = reserve;
    used.provider = "groq";
    used.model = "whisper-large-v3-turbo";
    yield { type: "status", message: t("Transcribing {name} with Whisper (free)…", { name: file.name }) };
    const { text, seconds: counted } = await freeTranscribe(file);
    await recordFreeAudio(counted, reserve);
    yield { type: "text", delta: transcript(file.name, text, t) };
    return;
  }
  yield* streamFreeChat(history, preferences, engine as WritingMode, reserveFree, recordFree, (label, provider) => {
    used.provider = provider;
    used.model = label;
  }, undefined, country);
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
  const history = (body.messages ?? []).slice(-30);
  const last = history[history.length - 1];
  if (!last || last.role !== "user") {
    return Response.json({ error: t("The last message must be from the user.") }, { status: 400 });
  }
  if (last.attachment && attachmentBytes(last.attachment) > MAX_ATTACHMENT_BYTES) {
    return Response.json({ error: t("Files must be 3 MB or smaller.") }, { status: 413 });
  }
  const filesProblem = checkFiles(last.attachment, last.more, t);
  if (filesProblem) return Response.json({ error: filesProblem }, { status: 413 });
  const severalFiles = Boolean(last.more?.length);
  if (typeof last.content !== "string" || last.content.length > MAX_MESSAGE_CHARS) {
    return Response.json(
      { error: t("This message is too long. Send a shorter one, or attach the text as a file.") },
      { status: 413 },
    );
  }

  const previous = body.previous && (ENGINES as readonly string[]).includes(body.previous) ? body.previous : undefined;
  const spoken = body.voice === true;
  const auto = route(last.content, last.attachment?.mediaType, previous, { spoken });
  const override =
    body.engine && body.engine !== "auto" && (ENGINES as readonly string[]).includes(body.engine) ? body.engine : null;
  // A "yes" to a price runs what was priced, never a fresh guess at the request.
  const agreed = override ? null : agreedPrice(body.agreed);
  let engine = override ?? agreed?.engine ?? auto.engine;
  // Why this engine answers, in the user's language.
  let reason = override
    ? typeof body.template === "string" && body.template.trim()
      ? t("Made from the {template} template.", { template: body.template.trim().slice(0, 40) })
      : body.build === true && (override === "app" || override === "slides")
        ? override === "app"
          ? t("Updating your app.")
          : t("Updating your slides.")
        : t("You picked this engine.")
    : agreed && agreed.engine !== auto.engine
      ? t("Flash's router read your request.")
      : t(auto.reason);
  // Several files are read and compared by the writing engines; media tools take one file. The
  // builder reads several pictures too, so a few screens can be built in one go.
  const allPictures = [last.attachment, ...(last.more ?? [])].every((f) => f && PICTURE_TYPE.test(f.mediaType));
  const builds = engine === "app" || engine === "slides";
  // Several photos and a change asked for are combined into one picture: "put me and my dog on a beach".
  const photos = last.attachment ? [last.attachment, ...(last.more ?? [])] : [];
  const combines =
    engine === "image" && severalFiles && photos.length <= MAX_EDIT_PHOTOS && photos.every((f) => EDITABLE_TYPE.test(f.mediaType));
  if (severalFiles && !WRITING_ENGINES.includes(engine) && !(builds && allPictures) && !combines) {
    engine = "docs";
    reason = t("Flash reads several files together.");
  }

  // Everything this request spends with AI providers, for credits and the owner dashboard.
  const spend: { provider: string; model: string; cents: number }[] = [];
  // Characters of reply sent since the last Claude call was paid for, so a call that fails
  // after them isn't billed for words an earlier call already paid for.
  let written = 0;
  const meter: Meter = (provider, model, cents) => {
    spend.push({ provider, model, cents });
    if (provider === "anthropic") written = 0;
  };

  await ensureMonthlyCredits(user.id);
  // A team member spends the shared pool first. One ledger pays for each request, so the hold
  // is sized to the larger balance.
  const available = (await spendable(user.id)).largest;

  // When no keyword rule fits, a small, fast model reads the request and picks the engine.
  // Skipped for users out of credits, so the free lane costs Flash nothing.
  // In a voice conversation it also checks requests the rules sent to code, docs or search (see checksSpoken).
  const recheck = !override && spoken && checksSpoken(engine);
  if (!override && !agreed && (auto.guessed || recheck) && !last.attachment && claudeConfigured() && available >= 5) {
    // Someone talking is waiting in silence, so the router gets less time to think.
    const guess = await classifyRequest(last.content, meter, spoken ? 1500 : 4000);
    // A guess is only a guess, so it never sends a request to an engine that isn't available yet.
    const ready = (e: Engine) => (isMedia(e) ? Boolean(pickModel(e, last.content, providers())) : configured(e));
    if (guess && takesGuess(guess, engine, last.content, { spoken, recheck }) && ready(guess)) {
      engine = guess;
      reason = t("Flash's router read your request.");
    }
  }

  // "Fix the spelling" sent with the picture above fixes the words in that picture. With a photo the
  // user attached, the same words are about the photo's own text, so they get words.
  if (!override && !agreed && body.pictureAbove === true && last.attachment && EDITABLE_TYPE.test(last.attachment.mediaType) && fixesPictureText(last.content)) {
    engine = "image";
  }
  // The keyword rules can't tell every "make it darker" from "great edit!" or "change it back", and a change
  // costs credits, so a small model checks the request first. Words about the picture get an answer in
  // words; a different picture is made fresh. Once the user has agreed to a price, the check isn't asked again.
  const wouldEdit = (engine === "image" || engine === "video") && Boolean(last.attachment && EDITABLE_TYPE.test(last.attachment.mediaType));
  // A price agreed to was for an edit or for a new picture, as its model says.
  let fresh = Boolean(agreed && wouldEdit && !MODELS.find((m) => m.id === agreed.model)?.edits);
  if (fresh && body.pictureAbove === true) reason = t("Flash makes a new picture.");
  if (wouldEdit && !override && !agreed && body.confirmed !== true && claudeConfigured() && available >= 5) {
    const asked = await pictureRequest(last.content, body.pictureAbove === true, meter);
    if (asked === "other") {
      engine = severalFiles ? "docs" : "text";
      reason = body.pictureAbove === true ? t("Flash answers about the picture above.") : t("A photo is attached, so the writing model reads it.");
    } else if (asked === "new" && body.pictureAbove === true) {
      fresh = true;
      reason = t("Flash makes a new picture.");
    }
  }
  // An image request with a photo attached edits it; a video request animates it.
  const editing = !fresh && (engine === "image" || engine === "video") && Boolean(last.attachment && EDITABLE_TYPE.test(last.attachment.mediaType));
  if (editing && body.pictureAbove === true) reason = engine === "video" ? t("Bringing the picture above to life.") : t("Changing the picture above.");
  for (const photo of editing ? (combines ? photos : [last.attachment!]) : []) {
    const editSize = imageDimensions(Buffer.from(photo.data, "base64"));
    if (!editSize || editSize.width * editSize.height > MAX_EDIT_PIXELS) {
      return Response.json(
        { error: t("Flash can edit PNG, JPEG and WebP photos up to 2048 × 2048 pixels. Try a smaller photo.") },
        { status: 400 },
      );
    }
  }
  if (combines && editing) reason = t("Flash combines your {count} photos into one picture.", { count: photos.length });
  // Only FLUX.2 Edit takes several photos at once; the other photo tools work on one.
  let picked = isMedia(engine) ? pickModel(engine, last.content, providers(), combines ? "flux-2-edit" : body.model, editing) : null;
  // The model whose price was agreed to, while it's still there (otherwise the new price is asked about).
  if (agreed && picked && picked.model.id !== agreed.model) {
    const kept = pickModel(picked.model.engine, last.content, providers(), agreed.model, editing);
    if (kept?.model.id === agreed.model) picked = kept;
  }
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
  // What the user asked to be called, their work and their language (Settings > General), then their memory.
  const memory = (typeof body.preferences === "string" ? body.preferences : user.preferences).slice(0, MAX_PREFERENCES_CHARS);
  const preferences = withVoiceStyle(
    withBrand(withInstructions([profileNote(user, engine), memory].filter((p) => p.trim()).join("\n"), project?.instructions ?? ""), brand),
    engine,
    body.voice,
  );
  // For the picture and video prompt writer: the brand kit, and the language of words in pictures.
  const mediaNotes = [brandForMedia(brand), pictureWordsNote(user.language)].filter(Boolean).join("\n\n");
  let held = 0;
  let needed = 0;
  let budget = NO_BUDGET;
  // What reading the input once costs, charged even when the user stops the reply.
  let inputCents = 0;
  // The level a Claude engine runs on, why, and how its model's price compares with the engine's usual one.
  let claudeRun: ClaudeChoice | null = null;
  let levelWhy = "";
  let levelScale = 1;
  if (live) {
    if (model) held = needed = modelCredits(model, last.content, combines ? photos.length : 1);
    else if (engine === "voice") held = needed = creditsFor(voiceCostCents(spokenText(last.content).length));
    else if (engine === "transcribe") {
      // Priced on the recording's length (see transcribeCostCents); with no file, the engine just asks for one.
      held = needed = last.attachment ? creditsFor(transcriptCents(last.attachment)) : 0;
    } else {
      // The level the user picked, or the one Auto picks for this request (see levels.ts).
      const files = last.attachment ? 1 + (last.more?.length ?? 0) : 0;
      const autoPick = autoLevel(engine, last.content, { files, voice: body.voice === true });
      const wanted = isLevel(body.level) && body.level !== "auto" ? body.level : null;
      const systemText = systemFor(engine, preferences, history);
      // The reply may only spend what the held credits pay for, so no request runs at a loss.
      const plan = async (level: ModelLevel) => {
        const choice = claudeChoice(engine, level);
        const inputTokens = await countInputTokens(choice.model, history, systemText);
        const scale = claudePrice(choice.model, inputTokens).output / claudePrice(defaultChoice(engine).model, inputTokens).output;
        return { choice, scale, inputTokens, hold: planHold(engine, choice.model, inputTokens, available, scale) };
      };
      let planned = await plan(wanted ?? autoPick.level);
      levelWhy = !wanted
        ? t(autoPick.why)
        : planned.choice.level === wanted
          ? t("You picked {level}.", { level: levelName(wanted) })
          : t("Research runs on {level} or above, so it answered instead of {picked}.", {
              level: levelName(planned.choice.level),
              picked: levelName(wanted),
            });
      // Not enough credits for the level picked: Auto's level answers when the user has enough for that.
      if (wanted && wanted !== autoPick.level && available < planned.hold.needed) {
        const instead = await plan(autoPick.level);
        if (available >= instead.hold.needed) {
          levelWhy = t("{picked} needs {credits} credits for this and you have {available}, so {level} answered.", {
            picked: levelName(wanted),
            credits: planned.hold.needed,
            available,
            level: levelName(autoPick.level),
          });
          planned = instead;
        }
      }
      const { hold } = planned;
      ({ needed, held } = hold);
      budget = { maxTokens: hold.maxTokens, capCents: hold.capCents };
      inputCents = readCostCents(planned.choice.model, planned.inputTokens);
      claudeRun = planned.choice;
      levelScale = planned.scale;
    }
  }
  // Out of credits: chat-style requests and images fall back to free models,
  // up to a daily allowance per user.
  let free: FreeLane | null = null;
  const verified = isVerified(user);
  if (live && available < needed && verified) {
    // A post pack has no free version: one free picture isn't what was asked for.
    const lane = model?.id === "post-pack" ? null : freeEligible(engine, last);
    if (lane) {
      if (!(await reserveFreeUser(user.id, lane))) {
        const left = { credits: available };
        return Response.json(
          {
            error:
              lane === "image"
                ? t("You've used today's free images and you have {credits} credits. Free use resets tomorrow, or get more credits now.", left)
                : lane === "transcribe"
                  ? t("You've used today's free transcripts and you have {credits} credits. Free use resets tomorrow, or get more credits now.", left)
                  : t("You've used today's free messages and you have {credits} credits. Free use resets tomorrow, or get more credits now.", left),
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
  // Agreed to: this model at no more than the credits the user said yes to.
  const consented = body.confirmed === true || Boolean(model && agreed && model.id === agreed.model && needed <= agreed.credits);
  if (model && !free && needed >= CONFIRM_CREDITS && available >= needed && !consented) {
    // The price question, which a voice conversation also reads out.
    const price = { model: model.label, credits: needed.toLocaleString(t.locale), available: available.toLocaleString(t.locale) };
    const error =
      model.id === "post-pack"
        ? t("This social post pack with a video uses {credits} credits. You have {available}.", price)
        : engine === "video"
          ? model.id === "movie"
            ? t("This {model} movie uses {credits} credits. You have {available}.", price)
            : t("This {model} video uses {credits} credits. You have {available}.", price)
          : engine === "music"
            ? t("This {model} track uses {credits} credits. You have {available}.", price)
            : t("This {model} image uses {credits} credits. You have {available}.", price);
    const asked: Agreed = { engine: model.engine, model: model.id, credits: needed };
    return Response.json({ error, code: "confirm_cost", needed, agreed: asked }, { status: 409 });
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
      const routed: StreamEvent = {
        type: "route",
        engine,
        reason,
        demo: !live,
        cost: metered && !free ? 0 : held,
        ...(free
          ? {
              free: true,
              model: free === "image" ? "FLUX.1 schnell" : free === "transcribe" ? "Whisper" : t("Free model"),
              modelWhy: t("You're out of credits, so Flash used a free model."),
            }
          : model
            ? { model: model.label, modelWhy: pickedWhy(picked!, t) }
            : // The level's name stays as it is: the browser matches it to the level's sign.
              claudeRun && { model: levelName(claudeRun.level), modelWhy: levelWhy }),
      };
      send(routed);
      // The reply's header names the level that really answered.
      const steppedDown = (choice: ClaudeChoice) => {
        if (claudeRun) {
          const modelWhy = t("{level} was busy, so {instead} answered.", { level: levelName(claudeRun.level), instead: levelName(choice.level) });
          send({ ...routed, model: levelName(choice.level), modelWhy });
        }
        claudeRun = choice;
      };
      let ok = true;
      let stopped = false;
      let failure = "";
      let error: unknown;
      try {
        const events = free
          ? runFree(free, engine, history, preferences, store, freeUse, countryOf(request), t, freeAudio)
          : run(engine, history, preferences, store, model, meter, budget, mediaNotes, claudeRun, steppedDown, t);
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
        error = err;
        // Provider errors can hold raw responses, so only messages written for the user are shown.
        failure =
          err instanceof FriendlyError
            ? err.in(t)
            : engine === "text"
              ? t("Flash is busy right now. Please try again in a moment.")
              : t("{engine} is busy right now. Please try again in a moment.", { engine: t(ENGINE_LABELS[engine]) });
      }
      const costCents = spend.reduce((sum, s) => sum + s.cents, 0);
      // A failed request costs only the provider work that really ran. A stopped reply is
      // charged for reading its input and what it wrote, or a typical reply. The free lane is free.
      const credits = free
        ? 0
        : finalCredits({
            held,
            ok,
            stopped,
            metered,
            costCents,
            inputCents,
            written,
            // A typical reply on this level: a fraction of the usual on Sonic, more on Summit.
            typical: Math.max(1, Math.round((TYPICAL_CREDITS[engine] ?? 4) * levelScale)),
            outputPrice: claudeRun ? claudePrice(claudeRun.model).output : undefined,
          });
      await settle(chargeId, credits);
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
        }).catch((err) => console.error("[flash] usage log failed", err));
      }
      if (!ok) send({ type: "error", message: failure + refundNote(held, credits, t) });
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
