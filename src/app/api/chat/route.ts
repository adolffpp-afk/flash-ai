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
import { freeChatConfigured, freeEligible, freeImage, freeImageConfigured, streamFreeChat } from "@/lib/engines/free.ts";
import { recordFree, releaseFreeUser, reserveFree, reserveFreeImage, reserveFreeUser } from "@/lib/server/free.ts";
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
import { getUser, unauthorized } from "@/lib/server/auth.ts";
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
import { MEDIA_ENGINES, modelCredits, movieScenes, movieSeconds, pickModel, type MediaEngine, type ModelInfo, type Provider } from "@/lib/models.ts";
import { unavailableReply } from "@/lib/engines/demo.ts";
import { FriendlyError, JobAbandoned } from "@/lib/engines/errors.ts";
import { buildSystem, streamBuild } from "@/lib/engines/builder.ts";
import { makeMovie } from "@/lib/engines/movie.ts";
import { falInput } from "@/lib/engines/fal-input.ts";

// Vercel Pro allows up to 800 seconds, which the Movie maker needs (scenes, filming and joining).
export const maxDuration = 800;

// Vercel caps a request at 4.5 MB, and a file grows by a third when sent as base64.
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
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

/** Uses Claude to sharpen a media prompt when a Claude key exists, else sends the request as written. */
const sharpen = (kind: "image" | "video" | "music", request: string, meter: Meter) =>
  claudeConfigured() ? improvePrompt(kind, request, meter).catch(() => request) : Promise.resolve(request);

/** The edited photo keeps the original's size, within the 512 to 2048 pixels the model makes. */
function editOutputSize(base64: string): { width: number; height: number } | undefined {
  const size = imageDimensions(Buffer.from(base64, "base64"));
  if (!size) return undefined;
  const scale = Math.max(1, 512 / Math.min(size.width, size.height));
  const width = Math.min(2048, Math.round(size.width * scale));
  const height = Math.min(2048, Math.round(size.height * scale));
  return { width, height };
}

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

async function* run(
  engine: Engine,
  history: ChatTurn[],
  preferences: string,
  store: Store,
  model: ModelInfo | null,
  meter: Meter,
  budget: Budget,
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
        yield { type: "status", message: `Editing your photo with ${model!.label}…` };
        const edited = yield* withProgress((report) =>
          falGenerate(
            model!.endpoint!,
            {
              prompt: last.content,
              image_urls: [`data:${photo.mediaType};base64,${photo.data}`],
              // The same size as the photo (checked to be at most 2048 × 2048 before credits were held).
              image_size: editOutputSize(photo.data),
              output_format: "png",
            },
            (m) => report(`${m}…`),
          ).catch(billIfAbandoned),
        );
        meter(model!.provider, model!.id, mediaCents(model!, last.content));
        yield { type: "image", url: await store(edited, "flash-edit.png"), prompt: last.content };
        return;
      }
      const prompt = await sharpen("image", last.content, meter);
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
        const movie = yield* withProgress((report) => makeMovie(model!.endpoint!, scenes, seconds, meter, report));
        yield { type: "video", url: await store(movie, "flash-movie.mp4"), prompt: last.content };
        return;
      }
      const prompt = await sharpen("video", last.content, meter);
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
      yield { type: "text", delta: `Here is "${words.length > 80 ? words.slice(0, 80) + "…" : words}" read aloud.` };
      const voiceCents = voiceCostCents(words.length);
      const speech = await synthesizeSpeech(words).catch(billSpeech("voice", voiceCents));
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
  lane: "chat" | "image",
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
  let reason = override ? "You picked this engine." : auto.reason;

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

  // An image request with a photo attached edits the photo.
  const editing = engine === "image" && Boolean(last.attachment && EDITABLE_TYPE.test(last.attachment.mediaType));
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
  const preferences = (typeof body.preferences === "string" ? body.preferences : user.preferences).slice(
    0,
    MAX_PREFERENCES_CHARS,
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
  let free: "chat" | "image" | null = null;
  const verified = isVerified(user);
  if (live && available < needed && verified) {
    const lane = freeEligible(engine, last);
    if (lane) {
      if (!(await reserveFreeUser(user.id, lane))) {
        return Response.json(
          {
            error: `You've used today's free ${lane === "image" ? "images" : "messages"} and you have ${available} credits. Free use resets tomorrow, or get more credits now.`,
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
          (verified && freeChatConfigured() ? " Free models still answer chat, writing, code and translation" + (freeImageConfigured() ? ", and make images." : ".") : ""),
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
          ? { free: true, model: free === "image" ? "FLUX.1 schnell" : "Open-source model", modelWhy: "You're out of credits, so Flash used a free model." }
          : model && { model: model.label, modelWhy: picked!.why }),
      });
      let ok = true;
      let stopped = false;
      let failure = "";
      let written = 0;
      try {
        const events = free
          ? runFree(free, engine, history, preferences, store, freeUse)
          : run(engine, history, preferences, store, model, meter, budget);
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
