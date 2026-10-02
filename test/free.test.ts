import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
process.env.GROQ_API_KEY = "g";
process.env.CLOUDFLARE_API_TOKEN = "c";
process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
const { freeEligible, CLOUDFLARE_DAILY_NEURONS, FLUX_SCHNELL_NEURONS } = await import("../src/lib/engines/free.ts");
const { reserveFree, reserveFreeImage, recordFree } = await import("../src/lib/server/free.ts");

const turn = (content: string, mediaType?: string) => ({
  role: "user" as const,
  content,
  ...(mediaType && { attachment: { name: "f", mediaType, data: "" } }),
});

test("only chat-style requests and plain images use the free lane", () => {
  assert.equal(freeEligible("text", turn("hi")), "chat");
  assert.equal(freeEligible("code", turn("fix", "text/plain")), "chat");
  assert.equal(freeEligible("image", turn("a cat")), "image");
  for (const engine of ["app", "slides", "video", "music", "voice", "search", "transcribe"] as const) {
    assert.equal(freeEligible(engine, turn("x")), null, engine);
  }
  // Free models can't read images or PDFs.
  assert.equal(freeEligible("text", turn("what is this", "image/png")), null);
});

test("each provider stops at its daily cap", async () => {
  for (let i = 0; i < 3; i++) assert.equal(await reserveFree("groq", { requests: 3, tokens: 1000 }), true);
  assert.equal(await reserveFree("groq", { requests: 3, tokens: 1000 }), false);
  assert.equal(await reserveFree("openrouter", { requests: 5, tokens: Infinity }), true);
  await recordFree("openrouter", 2000, 0);
  assert.equal(await reserveFree("openrouter", { requests: 5, tokens: 1500 }), false, "token cap");
});

test("free images stop before Cloudflare's free neurons run out", async () => {
  let images = 0;
  while (await reserveFreeImage()) images++;
  assert.equal(images, Math.floor(CLOUDFLARE_DAILY_NEURONS / FLUX_SCHNELL_NEURONS));
  assert.ok(images * FLUX_SCHNELL_NEURONS <= 10000, "within the 10,000 free neurons a day");
  // Chat on Cloudflare is blocked too once the neurons are used up.
  assert.equal(await reserveFree("cloudflare", { requests: Infinity, tokens: Infinity }), false);
});
