import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for fal.ai's transcription: "silence" has no words, "broken" never starts, and
// "lost" runs (so fal bills it) but its result can't be fetched.
const heard: string[] = [];
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const json = (v: unknown, code = 200) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(v));
    if (req.method === "POST") {
      const audio = String(JSON.parse(raw).audio_url ?? "");
      heard.push(audio);
      const kind = Buffer.from(audio.split(",")[1] ?? "", "base64").toString();
      if (kind === "broken") return json({ detail: "down" }, 500);
      return json({ status_url: `${base}/status`, response_url: `${base}/result/${kind}` });
    }
    if (req.url === "/status") return json({ status: "COMPLETED" });
    if (req.url === "/result/silence") return json({ text: "  " });
    if (req.url === "/result/lost") return json({ detail: "boom" }, 500);
    if (req.url!.startsWith("/result/")) return json({ text: " What's on my calendar today? " });
    res.writeHead(404).end();
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

process.env.DATABASE_URL = ":memory:";
process.env.FAL_KEY = "k";
process.env.FAL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
delete process.env.ELEVENLABS_API_KEY;

const { wakeMatch, isYes, isNo, isGoodbye, speechChunks, voiceReply, withVoiceStyle, VOICE_STYLE, MAX_SPOKEN_CHARS } = await import(
  "../src/lib/voice-chat.ts"
);
const { run, one } = await import("../src/lib/server/db.ts");
const { hearTurn } = await import("../src/lib/server/voice.ts");

test('"Hey Flash" wakes Flash, and what follows is the first request', () => {
  assert.deepEqual(wakeMatch("hey flash"), { rest: "" });
  assert.deepEqual(wakeMatch("Hey, Flash! What's the weather in Toronto?"), { rest: "What's the weather in Toronto?" });
  assert.deepEqual(wakeMatch("okay flash make me a logo"), { rest: "make me a logo" });
  assert.deepEqual(wakeMatch("so I said hi Flash"), { rest: "" });
  assert.equal(wakeMatch("grab the flashlight"), null);
  assert.equal(wakeMatch("hey flashy sneakers"), null);
  assert.equal(wakeMatch("they flash their lights"), null);
  assert.equal(wakeMatch("there's a flash sale today"), null);
});

test("short answers: yes, no and goodbye", () => {
  for (const y of ["Yes", "yeah go ahead", "OK.", "Sure, do it", "go ahead please"]) assert.ok(isYes(y), y);
  for (const n of ["no", "yes no wait", "maybe later", "yes I want to change the picture to a blue sky with birds"]) assert.ok(!isYes(n), n);
  for (const n of ["No thanks", "cancel", "never mind", "Don't."]) assert.ok(isNo(n), n);
  for (const b of ["Bye", "goodbye Flash", "OK thanks, that's all", "stop listening", "bye bye", "end the conversation"]) assert.ok(isGoodbye(b), b);
  for (const b of ["say bye to my customers in an email", "what's all this", "stop the video"]) assert.ok(!isGoodbye(b), b);
});

test("long answers are spoken in short pieces, without losing a word", () => {
  const text = "One. Two is a longer sentence, with a pause. Three! " + "word ".repeat(80).trim() + ".";
  const pieces = speechChunks(text, 60);
  assert.ok(pieces.every((p) => p.length <= 60), JSON.stringify(pieces));
  assert.equal(pieces.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "));
  assert.deepEqual(speechChunks("Hi there. How are you?"), ["Hi there. How are you?"]);
  assert.deepEqual(speechChunks(""), []);
});

test("what Flash says back: the answer, made things, prices and errors", () => {
  assert.deepEqual(voiceReply({ content: "**Two plus two** is four." }), { say: "Two plus two is four.", confirm: false });
  assert.deepEqual(voiceReply({ content: "", images: [{ url: "/f/a", prompt: "cat" }] }), {
    say: "Your picture is ready. It's on your screen.",
    confirm: false,
  });
  assert.equal(voiceReply({ content: "", videos: [{ url: "/f/v", prompt: "waves" }] }).say, "Your video is ready. It's on your screen.");
  assert.equal(voiceReply({ content: "" }).say, "Done. It's on your screen.");
  assert.deepEqual(voiceReply({ content: "", error: "This Kling 3 video uses 140 credits. You have 200.", errorCode: "confirm_cost" }), {
    say: "This Kling 3 video uses 140 credits. You have 200. Say yes to go ahead, or no to skip it.",
    confirm: true,
  });
  assert.deepEqual(voiceReply({ content: "", error: "You're out of credits." }), { say: "You're out of credits.", confirm: false });
  assert.equal(voiceReply({ content: "Half", stopped: true }).say, "Stopped.");
  // Code and tables stay on screen.
  assert.equal(voiceReply({ content: "Here it is:\n\n```py\nprint(1)\n```" }).say, "Here it is: The details are on your screen.");
  assert.equal(voiceReply({ content: "Prices:\n\n| Item | Price |\n|---|---|\n| Bread | 8 |" }).say, "Prices: The details are on your screen.");
  // A long answer is cut at a sentence, and the rest stays on screen.
  const long = voiceReply({ content: "This is a sentence that goes on for a while. ".repeat(30) }).say;
  assert.ok(long.length <= MAX_SPOKEN_CHARS + 40);
  assert.ok(long.endsWith("a while. The rest is on your screen."), long);
});

test("voice requests get spoken answers from the writing engines only", () => {
  assert.equal(withVoiceStyle("I run a bakery.", "text", true), `I run a bakery.\n\n${VOICE_STYLE}`);
  assert.equal(withVoiceStyle("", "search", true), VOICE_STYLE);
  assert.equal(withVoiceStyle("I run a bakery.", "text", undefined), "I run a bakery.");
  assert.equal(withVoiceStyle("I run a bakery.", "text", "yes"), "I run a bakery.", "only a real true");
  // Apps, code and documents keep their own instructions.
  for (const engine of ["app", "code", "docs", "slides", "image"] as const) assert.equal(withVoiceStyle("x", engine, true), "x");
});

// A user with some credits hears turns (added in the first test: top-level awaits here would end the file's tests early).
const balance = async () => Number((await one<{ c: number }>("SELECT COALESCE(SUM(amount), 0) AS c FROM credit_ledger WHERE user_id = 'v1'"))?.c);
const turn = async (body: Buffer, type = "audio/ogg") => {
  const r = await hearTurn("v1", type, body);
  return { status: r.status, json: async () => r.body };
};

test("Firefox turns: a recording comes back as words and costs a few credits", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('v1', 'v1@x.io', '', 0, 0)");
  const res = await turn(Buffer.from("hello"));
  assert.equal(res.status, 200);
  const data = (await res.json()) as { text: string; credits: number };
  assert.equal(data.text, "What's on my calendar today?");
  assert.equal(data.credits, 3);
  assert.equal(await balance(), 197, "the free monthly 200, less 3");
  assert.ok(heard.at(-1)!.startsWith("data:audio/ogg;base64,"));
  const usage = await one<{ engine: string; credits: number; ok: number }>("SELECT engine, credits, ok FROM usage WHERE user_id = 'v1' ORDER BY rowid DESC LIMIT 1");
  assert.deepEqual({ ...usage }, { engine: "transcribe", credits: 3, ok: 1 });
});

test("silence is no words; a turn that never started is free, one fal ran is paid", async () => {
  const quiet = await turn(Buffer.from("silence"));
  assert.deepEqual(await quiet.json(), { text: "", credits: 3 });
  assert.equal(await balance(), 194);
  const failed = await turn(Buffer.from("broken"));
  assert.equal(failed.status, 502);
  assert.equal(await balance(), 194, "refunded");
  const lost = await turn(Buffer.from("lost"));
  assert.equal(lost.status, 502);
  assert.equal(await balance(), 191, "fal charged for the work");
});

test("hearing refuses non-audio, huge files and empty wallets", async () => {
  assert.equal((await turn(Buffer.from("hello"), "text/plain")).status, 415);
  assert.equal((await turn(Buffer.from("hello"), "audio/webm;codecs=opus")).status, 200, "codec details are fine");
  assert.equal((await turn(Buffer.alloc(1_000_001))).status, 413);
  assert.deepEqual(await (await turn(Buffer.alloc(0))).json(), { text: "" });
  // Spent everything (the month's free credits were already given, so none come back).
  await run("UPDATE credit_ledger SET amount = 0 WHERE user_id = 'v1'");
  const broke = await turn(Buffer.from("hello"));
  assert.equal(broke.status, 402);
  assert.match(((await broke.json()) as { error: string }).error, /Chrome, Edge or Safari/);
});
