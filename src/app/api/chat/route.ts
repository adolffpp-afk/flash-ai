import { route, textToSpeak } from "@/lib/router.ts";
import { ENGINES, type ChatTurn, type Engine, type StreamEvent } from "@/lib/types.ts";
import { claudeConfigured, improvePrompt, streamSearch, streamText } from "@/lib/engines/claude.ts";
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
import { balance, charge, ensureMonthlyCredits, refund } from "@/lib/server/credits.ts";
import { saveFile } from "@/lib/server/files.ts";
import { CREDIT_COSTS } from "@/lib/credits.ts";
import { falConfigured, falGenerate } from "@/lib/engines/fal.ts";
import { MEDIA_ENGINES, pickModel, requestedSeconds, type MediaEngine, type ModelInfo, type Provider } from "@/lib/models.ts";
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
      return { prompt, duration: String(requestedSeconds(request, 3, 15, 10)), aspect_ratio: "16:9" };
    case "minimax-music":
      // MiniMax writes the lyrics itself when none are given.
      return { prompt: prompt.slice(0, 2000).padEnd(10, "."), lyrics_optimizer: true };
    default:
      return { prompt };
  }
}

/** Uses Claude to sharpen a media prompt when a Claude key exists, else sends the request as written. */
const sharpen = (kind: "image" | "video" | "music", request: string) =>
  claudeConfigured() ? improvePrompt(kind, request) : Promise.resolve(request);

type Store = (media: Media, name: string) => Promise<string>;

async function* run(
  engine: Engine,
  history: ChatTurn[],
  preferences: string,
  store: Store,
  model: ModelInfo | null,
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
      yield* streamText(history, preferences, engine);
      return;
    case "search":
      yield* streamSearch(history, preferences);
      return;
    case "app":
    case "slides":
      yield* streamBuild(history, preferences, engine);
      return;
    case "image": {
      const prompt = await sharpen("image", last.content);
      yield { type: "status", message: `Painting your image with ${model!.label}…` };
      const image =
        model!.provider === "fal"
          ? yield* withProgress((report) =>
              falGenerate(model!.endpoint!, falInput(model!, prompt, last.content), (m) => report(`${m}…`)),
            )
          : await generateImage(prompt);
      yield { type: "image", url: await store(image, "flash-image.png"), prompt };
      return;
    }
    case "video": {
      const prompt = await sharpen("video", last.content);
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
      yield { type: "video", url: await store(video, "flash-video.mp4"), prompt };
      return;
    }
    case "voice": {
      const words = textToSpeak(last.content);
      yield { type: "text", delta: `Here is "${words.length > 80 ? words.slice(0, 80) + "…" : words}" read aloud.` };
      yield { type: "audio", url: await store(await synthesizeSpeech(words), "flash-voice.mp3"), label: "flash-voice.mp3" };
      return;
    }
    case "music": {
      const prompt = await sharpen("music", last.content);
      yield { type: "status", message: `Composing your track with ${model!.label}…` };
      yield { type: "text", delta: `**Track brief:** ${prompt}` };
      const track =
        model!.provider === "fal"
          ? yield* withProgress((report) =>
              falGenerate(model!.endpoint!, falInput(model!, prompt, last.content), (m) => report(`Composing… ${m.toLowerCase()}`)),
            )
          : await composeMusic(prompt);
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
  const engine = override ?? auto.engine;
  const picked = isMedia(engine) ? pickModel(engine, last.content, providers(), body.model) : null;
  const model = picked?.model ?? null;
  const reason = override ? "You picked this engine." : auto.reason;

  // Demo replies are free; live engines cost credits, refunded if the engine fails.
  const live = isMedia(engine) ? Boolean(model) : configured(engine);
  const cost = live ? (model?.credits ?? CREDIT_COSTS[engine]) : 0;
  if (cost) {
    await ensureMonthlyCredits(user.id);
    if (!(await charge(user.id, cost, `${engine} request`))) {
      return Response.json(
        {
          error: `This needs ${cost} credits and you have ${await balance(user.id)}.`,
          code: "out_of_credits",
          needed: cost,
        },
        { status: 402 },
      );
    }
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
        cost,
        ...(model && { model: model.label, modelWhy: picked!.why }),
      });
      try {
        for await (const event of run(engine, history, preferences, store, model)) {
          if (cancelled || request.signal.aborted) return;
          send(event);
        }
      } catch (err) {
        console.error(`[flash] ${engine} engine failed`, err);
        await refund(user.id, cost, `Refund: ${engine} request failed`);
        send({
          type: "error",
          message: `${err instanceof Error ? err.message : "Something went wrong."}${cost ? " Your credits were refunded." : ""}`,
        });
      }
      if (cancelled) return;
      send({ type: "done" });
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
