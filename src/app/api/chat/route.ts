import { route, textToSpeak } from "@/lib/router.ts";
import type { ChatTurn, Engine, StreamEvent } from "@/lib/types.ts";
import { claudeConfigured, improveImagePrompt, streamSearch, streamText } from "@/lib/engines/claude.ts";
import { generateImage, imageConfigured, synthesizeSpeech, voiceConfigured } from "@/lib/engines/media.ts";
import { demoReply } from "@/lib/engines/demo.ts";

export const maxDuration = 300;

const ENGINES: Engine[] = ["text", "search", "image", "voice"];
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

type ChatRequest = { messages: ChatTurn[]; engine?: Engine | "auto"; preferences?: string };

function configured(engine: Engine): boolean {
  if (engine === "image") return imageConfigured();
  if (engine === "voice") return voiceConfigured();
  return claudeConfigured();
}

async function* run(engine: Engine, history: ChatTurn[], preferences: string): AsyncGenerator<StreamEvent> {
  const last = history[history.length - 1];
  if (!configured(engine)) {
    yield* demoReply(engine, last.content);
    return;
  }
  switch (engine) {
    case "text":
      yield* streamText(history, preferences);
      return;
    case "search":
      yield* streamSearch(history, preferences);
      return;
    case "image": {
      const prompt = claudeConfigured() ? await improveImagePrompt(last.content) : last.content;
      yield { type: "image", url: await generateImage(prompt), prompt };
      return;
    }
    case "voice": {
      const words = textToSpeak(last.content);
      yield { type: "text", delta: `Here is "${words.length > 80 ? words.slice(0, 80) + "…" : words}" read aloud.` };
      yield { type: "audio", url: await synthesizeSpeech(words) };
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
    return Response.json({ error: "Files must be 10 MB or smaller." }, { status: 413 });
  }

  const auto = route(last.content, Boolean(last.attachment));
  const override = body.engine && body.engine !== "auto" && ENGINES.includes(body.engine) ? body.engine : null;
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
