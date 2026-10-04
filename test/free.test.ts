import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
process.env.GROQ_API_KEY = "g";
process.env.CLOUDFLARE_API_TOKEN = "c";
process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
const { freeEligible, CLOUDFLARE_DAILY_NEURONS, FLUX_SCHNELL_NEURONS } = await import("../src/lib/engines/free.ts");
const { reserveFree, reserveFreeImage, recordFree, reserveFreeUser, releaseFreeUser, freeLeft } = await import(
  "../src/lib/server/free.ts"
);
const { FREE_DAILY_IMAGES } = await import("../src/lib/engines/free.ts");

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
  // Several files: all must be text.
  const two = (type: string) => ({ ...turn("compare", "text/plain"), more: [{ name: "g", mediaType: type, data: "" }] });
  assert.equal(freeEligible("text", two("text/csv")), "chat");
  assert.equal(freeEligible("text", two("application/pdf")), null);
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

test("each user's free requests are reserved up front, so parallel ones can't pass the cap", async () => {
  const tries = await Promise.all(Array.from({ length: FREE_DAILY_IMAGES + 3 }, () => reserveFreeUser("u1", "image")));
  assert.equal(tries.filter(Boolean).length, FREE_DAILY_IMAGES);
  assert.equal(await freeLeft("u1", "image"), 0);
  // A failed request gives its slot back.
  await releaseFreeUser("u1", "image");
  assert.equal(await freeLeft("u1", "image"), 1);
  assert.equal(await reserveFreeUser("u1", "image"), true);
  assert.equal(await reserveFreeUser("u2", "image"), true, "other users have their own");
});

test("one audio or video file can be transcribed for free with Whisper", async () => {
  assert.equal(freeEligible("transcribe", turn("", "audio/mpeg")), "transcribe");
  assert.equal(freeEligible("transcribe", turn("", "video/mp4")), "transcribe");
  assert.equal(freeEligible("transcribe", turn("", "video/quicktime")), null, "Whisper on Groq can't read .mov");
  assert.equal(freeEligible("transcribe", turn("")), null);
  const two = { ...turn("", "audio/mpeg"), more: [{ name: "b", mediaType: "audio/mpeg", data: "" }] };
  assert.equal(freeEligible("transcribe", two), null);
  assert.equal(freeEligible("text", turn("", "audio/mpeg")), null);
});

test("free transcripts stop at each user's and Flash's daily allowance", async () => {
  const { reserveFreeAudio, recordFreeAudio } = await import("../src/lib/server/free.ts");
  const { FREE_DAILY_TRANSCRIPTS, GROQ_AUDIO_DAILY_SECONDS } = await import("../src/lib/engines/free.ts");
  for (let i = 0; i < FREE_DAILY_TRANSCRIPTS; i++) assert.equal(await reserveFreeUser("listener", "transcribe"), true);
  assert.equal(await reserveFreeUser("listener", "transcribe"), false);
  assert.equal(await freeLeft("listener", "chat"), 25, "transcripts don't use up chats");
  assert.equal(await reserveFreeAudio(), true);
  await recordFreeAudio(GROQ_AUDIO_DAILY_SECONDS - 500);
  assert.equal(await reserveFreeAudio(), false, "no room left for another recording");
});

test("the free transcript comes from Groq with the audio's length", async () => {
  const { createServer } = await import("node:http");
  let seen = "";
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen = `${req.url} ${req.headers.authorization} ${body.includes("whisper-large-v3-turbo")} ${body.includes('filename="talk.mp3"')}`;
      res.end(JSON.stringify({ text: " Hello bakery. ", duration: 3.2 }));
    });
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  process.env.GROQ_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { freeTranscribe } = await import("../src/lib/engines/free.ts");
  const result = await freeTranscribe({ name: "talk.mp3", mediaType: "audio/mpeg", data: Buffer.from("ID3").toString("base64") });
  server.close();
  delete process.env.GROQ_BASE_URL;
  assert.equal(seen, "/audio/transcriptions Bearer g true true");
  assert.deepEqual(result, { text: "Hello bakery.", seconds: 10 }, "Groq counts at least 10 seconds");
});
