import type { Engine, StreamEvent } from "../types.ts";

export const KEY_FOR: Record<Engine, string> = {
  text: "ANTHROPIC_API_KEY",
  search: "ANTHROPIC_API_KEY",
  code: "ANTHROPIC_API_KEY",
  translate: "ANTHROPIC_API_KEY",
  docs: "ANTHROPIC_API_KEY",
  image: "OPENAI_API_KEY",
  video: "OPENAI_API_KEY",
  voice: "ELEVENLABS_API_KEY",
  music: "ELEVENLABS_API_KEY",
  transcribe: "ELEVENLABS_API_KEY",
};

const SAMPLES: Partial<Record<Engine, string>> = {
  code: "\n\n```python\ndef is_prime(n: int) -> bool:\n    if n < 2:\n        return False\n    return all(n % d for d in range(2, int(n ** 0.5) + 1))\n```",
  docs: "\n\n```csv\nCategory,Monthly budget,Spent\nRent,1200,1200\nFood,500,430\nTransport,150,120\n```",
  translate: "\n\n**Spanish:** Buenos días",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function placeholderImage(prompt: string, label: string): string {
  const safe = prompt.replace(/[<>&"]/g, "").slice(0, 60);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/><text x="256" y="236" font-family="sans-serif" font-size="28" fill="white" text-anchor="middle">${label}</text><text x="256" y="280" font-family="sans-serif" font-size="16" fill="white" text-anchor="middle">${safe}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/** Stand-in replies so the whole app can be tried before any API key is added. */
export async function* demoReply(engine: Engine, message: string): AsyncGenerator<StreamEvent> {
  const note =
    `Demo mode: add ${KEY_FOR[engine]} to .env.local to get real results from this engine. ` +
    `Flash routed your request to the ${engine} engine.`;
  for (const word of note.split(/(?<= )/)) {
    yield { type: "text", delta: word };
    await sleep(10);
  }
  if (SAMPLES[engine]) yield { type: "text", delta: SAMPLES[engine] };
  if (engine === "image") yield { type: "image", url: placeholderImage(message, "Demo image"), prompt: message };
  if (engine === "video") yield { type: "image", url: placeholderImage(message, "Demo video frame"), prompt: message };
  if (engine === "search") {
    yield { type: "sources", items: [{ title: "Example source", url: "https://example.com" }] };
  }
}
