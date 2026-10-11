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
const { run } = await import("../src/lib/server/db.ts");

const turn = (content: string, mediaType?: string) => ({
  role: "user" as const,
  content,
  ...(mediaType && { attachment: { name: "f", mediaType, data: "" } }),
});

test("only chat-style requests and plain images use the free lane", () => {
  assert.equal(freeEligible("text", turn("hi")), "chat");
  assert.equal(freeEligible("code", turn("fix", "text/plain")), "chat");
  assert.equal(freeEligible("image", turn("a cat")), "image");
  for (const engine of ["app", "slides", "video", "music", "voice", "transcribe"] as const) {
    assert.equal(freeEligible(engine, turn("x")), null, engine);
  }
  // Research is answered in words by a free model, which can't search (the chat route says so).
  assert.equal(freeEligible("search", turn("who won last night?")), "chat");
  assert.equal(freeEligible("search", turn("what is this", "image/png")), null);
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

test("a reply that asks for the forecast first reserves both of its calls at once, under the same caps", async () => {
  const limits = { requests: 900, tokens: Infinity };
  const day = new Date().toISOString().slice(0, 10);
  await reserveFree("mistral", limits);
  await run("UPDATE free_quota SET requests = 899 WHERE day = ? AND provider = 'mistral'", [day]);
  assert.equal(await reserveFree("mistral", limits, 2), false, "899 of 900: no room for two");
  await run("UPDATE free_quota SET requests = 898 WHERE day = ? AND provider = 'mistral'", [day]);
  assert.equal(await reserveFree("mistral", limits, 2), true, "898 of 900: room for two");
  assert.equal(await reserveFree("mistral", limits), false, "now full");
  // On Cloudflare, room for two replies' neurons is kept too.
  await reserveFree("cloudflare", { requests: Infinity, tokens: Infinity });
  await run("UPDATE free_quota SET neurons = ? WHERE day = ? AND provider = 'cloudflare'", [CLOUDFLARE_DAILY_NEURONS - 500, day]);
  assert.equal(await reserveFree("cloudflare", { requests: Infinity, tokens: Infinity }, 2), false);
  assert.equal(await reserveFree("cloudflare", { requests: Infinity, tokens: Infinity }), true);
  await run("UPDATE free_quota SET neurons = 0, requests = 0 WHERE day = ? AND provider = 'cloudflare'", [day]);
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
  const { one } = await import("../src/lib/server/db.ts");
  const seconds = async () => Number((await one<{ s: number }>("SELECT tokens AS s FROM free_quota WHERE provider = 'groq-audio'"))?.s ?? 0);
  for (let i = 0; i < FREE_DAILY_TRANSCRIPTS; i++) assert.equal(await reserveFreeUser("listener", "transcribe"), true);
  assert.equal(await reserveFreeUser("listener", "transcribe"), false);
  assert.equal(await freeLeft("listener", "chat"), 25, "transcripts don't use up chats");
  // A recording's seconds are taken with its request, so recordings sent at once can't all fit in
  // the room left for one.
  const tries = await Promise.all(Array.from({ length: 30 }, () => reserveFreeAudio(1000)));
  assert.equal(tries.filter(Boolean).length, GROQ_AUDIO_DAILY_SECONDS / 1000);
  assert.equal(await seconds(), GROQ_AUDIO_DAILY_SECONDS);
  assert.equal(await reserveFreeAudio(10), false, "no room left for another recording");
  // What Groq counted replaces what was held.
  await recordFreeAudio(400, 1000);
  assert.equal(await seconds(), GROQ_AUDIO_DAILY_SECONDS - 600);
  assert.equal(await reserveFreeAudio(600), true);
  assert.equal(await reserveFreeAudio(1), false);
});

test("a free transcript that failed: what Groq refused goes back to everyone, the user's turn only when Groq broke", async () => {
  const { reserveFreeAudio, freeAudioFailed } = await import("../src/lib/server/free.ts");
  const { FreeRefused } = await import("../src/lib/engines/free.ts");
  const { one, run } = await import("../src/lib/server/db.ts");
  await run("UPDATE free_quota SET requests = 0, tokens = 0 WHERE provider = 'groq-audio'");
  const quota = async () => ({ ...(await one<{ requests: number; tokens: number }>("SELECT requests, tokens FROM free_quota WHERE provider = 'groq-audio'")) });
  const attempt = async (err: unknown) => {
    assert.equal(await reserveFreeUser("caller", "voice"), true);
    assert.equal(await reserveFreeAudio(30), true);
    await freeAudioFailed("caller", "voice", 30, err);
  };
  // A file Groq refused: the shared request and seconds come back; the user's turn stays used.
  await attempt(new FreeRefused("could not process file", 400));
  assert.deepEqual(await quota(), { requests: 0, tokens: 0 });
  assert.equal(await freeLeft("caller", "voice"), 39);
  // Groq broke or was busy: the user's turn comes back as well.
  await attempt(new FreeRefused("over capacity", 503));
  await attempt(new FreeRefused("rate limited", 429));
  assert.deepEqual(await quota(), { requests: 0, tokens: 0 });
  assert.equal(await freeLeft("caller", "voice"), 39);
  // No answer (a timeout): Groq may have heard it, so everything stays used.
  await attempt(new Error("The operation was aborted due to timeout"));
  assert.deepEqual(await quota(), { requests: 1, tokens: 30 });
  assert.equal(await freeLeft("caller", "voice"), 38);
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
