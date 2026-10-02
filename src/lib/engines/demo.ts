import type { Engine, StreamEvent } from "../types.ts";

const KEY_FOR: Record<Engine, string> = {
  text: "ANTHROPIC_API_KEY",
  search: "ANTHROPIC_API_KEY",
  image: "OPENAI_API_KEY",
  voice: "ELEVENLABS_API_KEY",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function placeholderImage(prompt: string): string {
  const safe = prompt.replace(/[<>&"]/g, "").slice(0, 60);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/><text x="256" y="236" font-family="sans-serif" font-size="28" fill="white" text-anchor="middle">Demo image</text><text x="256" y="280" font-family="sans-serif" font-size="16" fill="white" text-anchor="middle">${safe}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/** Stand-in replies so the whole app can be tried before any API key is added. */
export async function* demoReply(engine: Engine, message: string): AsyncGenerator<StreamEvent> {
  const note =
    `Demo mode: add ${KEY_FOR[engine]} to .env.local to get real answers from this engine. ` +
    `Flash routed your request to the ${engine} engine.`;
  if (engine === "image") {
    yield { type: "text", delta: note };
    yield { type: "image", url: placeholderImage(message), prompt: message };
    return;
  }
  for (const word of note.split(/(?<= )/)) {
    yield { type: "text", delta: word };
    await sleep(15);
  }
  if (engine === "search") {
    yield { type: "sources", items: [{ title: "Example source", url: "https://example.com" }] };
  }
}
