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
};

function configured(engine: Engine): boolean {
  if (engine === "image" || engine === "video") return openaiConfigured();
  if (engine === "voice" || engine === "music" || engine === "transcribe") return elevenConfigured();
  return claudeConfigured();
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
): AsyncGenerator<StreamEvent> {
  const last = history[history.length - 1];
  if (!configured(engine)) {
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
      yield { type: "status", message: "Painting your image…" };
      yield { type: "image", url: await store(await generateImage(prompt), "flash-image.png"), prompt };
      return;
    }
    case "video": {
      const prompt = await sharpen("video", last.content);
      yield { type: "status", message: "Filming your video. This usually takes one to three minutes…" };
      // Progress arrives through a callback, so it is collected and reported every few seconds.
      const updates: number[] = [];
      let finished = false;
      const job = generateVideo(prompt, (pct) => updates.push(pct)).finally(() => (finished = true));
      let reported = 0;
      while (!finished) {
        await Promise.race([job.catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
        const pct = updates.at(-1) ?? 0;
        if (pct > reported) {
          reported = pct;
          yield { type: "status", message: `Filming your video… ${pct}%` };
        }
      }
      const id = await job;
      yield { type: "status", message: "Saving your video…" };
      yield { type: "video", url: await store(await downloadVideo(id), "flash-video.mp4"), prompt };
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
      yield { type: "status", message: "Composing a 30 second track…" };
      yield { type: "text", delta: `**Track brief:** ${prompt}` };
      yield { type: "audio", url: await store(await composeMusic(prompt), "flash-music.mp3"), label: "flash-music.mp3" };
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
  const reason = override ? "You picked this engine." : auto.reason;

  // Demo replies are free; live engines cost credits, refunded if the engine fails.
  const live = configured(engine);
  const cost = live ? CREDIT_COSTS[engine] : 0;
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
      send({ type: "route", engine, reason, demo: !live, cost });
      try {
        for await (const event of run(engine, history, preferences, store)) {
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
