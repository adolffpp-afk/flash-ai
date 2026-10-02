import { route, textToSpeak } from "@/lib/router.ts";
import { ENGINES, type ChatTurn, type Engine, type StreamEvent } from "@/lib/types.ts";
import {
  NO_BUDGET,
  classifyRequest,
  claudeConfigured,
  countInputTokens,
  improvePrompt,
  modelForEngine,
  streamSearch,
  streamText,
  type Budget,
  type Meter,
} from "@/lib/engines/claude.ts";
import {
  composeMusic,
  downloadVideo,
  elevenConfigured,
  generateImage,
  generateVideo,
  openaiConfigured,
  synthesizeSpeech,
  transcribe,
  type Media,
} from "@/lib/engines/media.ts";
import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { balance, charge, ensureMonthlyCredits, logUsage, settle } from "@/lib/server/credits.ts";
import { saveFile } from "@/lib/server/files.ts";
import { MARKUP, TRANSCRIBE_COST_CENTS, TYPICAL_CREDITS, creditsFor, planHold, voiceCostCents } from "@/lib/credits.ts";
import { falConfigured, falGenerate } from "@/lib/engines/fal.ts";
import { MEDIA_ENGINES, modelCredits, pickModel, videoSeconds, type MediaEngine, type ModelInfo, type Provider } from "@/lib/models.ts";
import { demoReply } from "@/lib/engines/demo.ts";
import { streamBuild } from "@/lib/engines/builder.ts";

export const maxDuration = 800;

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

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
  if (engine === "voice" || engine === "transcribe") return elevenConfigured();
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

/** Builds the fal.ai input for a model from the user's request. */
function falInput(model: ModelInfo, prompt: string, request: string): Record<string, unknown> {
  switch (model.id) {
    case "flux-2-pro":
      return { prompt, image_size: "landscape_4_3", output_format: "png" };
    case "veo-3.1":
      return { prompt, duration: "8s", aspect_ratio: "16:9", generate_audio: true };
    case "kling-3":
      return { prompt, duration: String(videoSeconds(request)), aspect_ratio: "16:9" };
    case "minimax-music":
      // MiniMax writes the lyrics itself when none are given.
      return { prompt: prompt.slice(0, 2000).padEnd(10, "."), lyrics_optimizer: true };
    default:
      return { prompt };
  }
}

/** Uses Claude to sharpen a media prompt when a Claude key exists, else sends the request as written. */
const sharpen = (kind: "image" | "video" | "music", request: string, meter: Meter) =>
  claudeConfigured() ? improvePrompt(kind, request, meter) : Promise.resolve(request);

/** What a media request on this model cost Flash, in cents. */
const mediaCents = (model: ModelInfo, request: string) =>
  typeof model.costCents === "function" ? model.costCents(request) : model.costCents;

type Store = (media: Media, name: string) => Promise<string>;

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
    yield* demoReply(engine, last.content);
    return;
  }
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
      const prompt = await sharpen("image", last.content, meter);
      yield { type: "status", message: `Painting your image with ${model!.label}…` };
      const image =
        model!.provider === "fal"
          ? yield* withProgress((report) =>
              falGenerate(model!.endpoint!, falInput(model!, prompt, last.content), (m) => report(`${m}…`)),
            )
          : await generateImage(prompt);
      meter(model!.provider, model!.id, mediaCents(model!, last.content));
      yield { type: "image", url: await store(image, "flash-image.png"), prompt };
      return;
    }
    case "video": {
      const prompt = await sharpen("video", last.content, meter);
      yield { type: "status", message: `Filming your video with ${model!.label}. This usually takes one to three minutes…` };
      let video: Media;
      if (model!.provider === "fal") {
        video = yield* withProgress((report) =>
          falGenerate(model!.endpoint!, falInput(model!, prompt, last.content), (m) => report(`Filming your video… ${m.toLowerCase()}`)),
        );
      } else {
        const id = yield* withProgress((report) =>
          generateVideo(prompt, (pct) => pct && report(`Filming your video… ${pct}%`)),
        );
        yield { type: "status", message: "Saving your video…" };
        video = await downloadVideo(id);
      }
      meter(model!.provider, model!.id, mediaCents(model!, last.content));
      yield { type: "video", url: await store(video, "flash-video.mp4"), prompt };
      return;
    }
    case "voice": {
      const words = textToSpeak(last.content);
      yield { type: "text", delta: `Here is "${words.length > 80 ? words.slice(0, 80) + "…" : words}" read aloud.` };
      const speech = await synthesizeSpeech(words);
      meter("elevenlabs", "voice", voiceCostCents(words.length));
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
              falGenerate(model!.endpoint!, falInput(model!, prompt, last.content), (m) => report(`Composing… ${m.toLowerCase()}`)),
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
      const text = await transcribe(last.attachment);
      meter("elevenlabs", "transcribe", TRANSCRIBE_COST_CENTS);
      yield { type: "text", delta: `**Transcript of ${last.attachment.name}**\n\n${text}` };
      return;
    }
  }
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
  if (last.attachment && (last.attachment.data.length * 3) / 4 > MAX_ATTACHMENT_BYTES) {
    return Response.json({ error: "Files must be 25 MB or smaller." }, { status: 413 });
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

  // When no keyword rule fits, a small, fast model reads the request and picks the engine.
  if (!override && auto.guessed && !last.attachment && claudeConfigured()) {
    const guess = await classifyRequest(last.content, meter);
    if (guess && guess !== "text" && guess !== "transcribe") {
      engine = guess;
      reason = "Flash's router read your request.";
    }
  }

  const picked = isMedia(engine) ? pickModel(engine, last.content, providers(), body.model) : null;
  const model = picked?.model ?? null;

  // Demo replies are free. Media has a fixed price per model. Claude engines are charged by
  // length: Flash holds up to a limit, then keeps only what the reply really cost.
  const live = isMedia(engine) ? Boolean(model) : configured(engine);
  const metered = live && !isMedia(engine) && engine !== "voice" && engine !== "transcribe";
  await ensureMonthlyCredits(user.id);
  const available = await balance(user.id);
  let held = 0;
  let needed = 0;
  let budget = NO_BUDGET;
  if (live) {
    if (model) held = needed = modelCredits(model, last.content);
    else if (engine === "voice") held = needed = creditsFor(voiceCostCents(textToSpeak(last.content).length));
    else if (engine === "transcribe") held = needed = creditsFor(TRANSCRIBE_COST_CENTS);
    else {
      // The reply may only spend what the held credits pay for, so no request runs at a loss.
      const claudeModel = modelForEngine(engine);
      const hold = planHold(engine, claudeModel, await countInputTokens(claudeModel, history), available);
      ({ needed, held } = hold);
      budget = { maxTokens: hold.maxTokens, capCents: hold.capCents };
    }
  }
  const chargeId = held ? await charge(user.id, held, `${engine} request`) : 0;
  if (chargeId === null) {
    return Response.json(
      {
        error: `This needs ${metered ? "at least " : ""}${needed} credits and you have ${available}.`,
        code: "out_of_credits",
        needed,
      },
      { status: 402 },
    );
  }
  const store: Store = (media, name) => saveFile(user.id, media.mime, name, media.data);
  const preferences = body.preferences ?? user.preferences;

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
        cost: metered ? 0 : held,
        ...(model && { model: model.label, modelWhy: picked!.why }),
      });
      let ok = true;
      let failure = "";
      let written = 0;
      try {
        for await (const event of run(engine, history, preferences, store, model, meter, budget)) {
          if (cancelled || request.signal.aborted) break;
          if (event.type === "text") written += event.delta.length;
          send(event);
        }
      } catch (err) {
        console.error(`[flash] ${engine} engine failed`, err);
        ok = false;
        failure = err instanceof Error ? err.message : "Something went wrong.";
      }
      const costCents = spend.reduce((sum, s) => sum + s.cents, 0);
      // A failed request costs nothing. A stopped reply is charged what it used, or a typical reply.
      let credits = held;
      if (!ok) credits = 0;
      else if (metered) {
        // A stopped reply has no usage report: charge the larger of a typical reply and an
        // estimate from what was already sent (about 3 characters per token, doubled for thinking,
        // at Opus's output price of 2,000¢ per million tokens).
        const estimate = Math.ceil((((written / 3) * 2 * 2000) / 1e6) * MARKUP);
        const used = spend.length ? creditsFor(costCents) : Math.max(TYPICAL_CREDITS[engine] ?? 4, estimate);
        credits = Math.min(held, used);
      }
      await settle(chargeId, credits);
      if (live) {
        const main = spend.at(-1);
        await logUsage({
          userId: user.id,
          engine,
          model: model?.id ?? main?.model ?? "",
          provider: model?.provider ?? main?.provider ?? "",
          credits,
          costCents,
          ok,
        }).catch((err) => console.error("[flash] usage log failed", err));
      }
      if (!ok) send({ type: "error", message: `${failure}${held ? " Your credits were refunded." : ""}` });
      if (cancelled) return;
      if (metered && ok) send({ type: "cost", credits });
      send({ type: "done" });
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
