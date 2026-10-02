import { route, textToSpeak } from "@/lib/router.ts";
import { ENGINES, type ChatTurn, type Engine, type StreamEvent } from "@/lib/types.ts";
import { claudeConfigured, improvePrompt, streamSearch, streamText } from "@/lib/engines/claude.ts";
import {
  composeMusic,
  elevenConfigured,
  generateImage,
  generateVideo,
  openaiConfigured,
  synthesizeSpeech,
  transcribe,
} from "@/lib/engines/media.ts";
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

async function* run(engine: Engine, history: ChatTurn[], preferences: string): AsyncGenerator<StreamEvent> {
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
      yield { type: "image", url: await generateImage(prompt), prompt };
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
      yield { type: "video", url: `/api/video/${await job}`, prompt };
      return;
    }
    case "voice": {
      const words = textToSpeak(last.content);
      yield { type: "text", delta: `Here is "${words.length > 80 ? words.slice(0, 80) + "…" : words}" read aloud.` };
      yield { type: "audio", url: await synthesizeSpeech(words), label: "flash-voice.mp3" };
      return;
    }
    case "music": {
      const prompt = await sharpen("music", last.content);
      yield { type: "status", message: "Composing a 30 second track…" };
      yield { type: "text", delta: `**Track brief:** ${prompt}` };
      yield { type: "audio", url: await composeMusic(prompt), label: "flash-music.mp3" };
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

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: StreamEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      send({ type: "route", engine, reason, demo: !configured(engine) });
      try {
        for await (const event of run(engine, history, body.preferences ?? "")) send(event);
      } catch (err) {
        console.error(`[flash] ${engine} engine failed`, err);
        send({ type: "error", message: err instanceof Error ? err.message : "Something went wrong." });
      }
      send({ type: "done" });
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
