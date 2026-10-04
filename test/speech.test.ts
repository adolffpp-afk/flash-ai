import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for fal.ai's queue: every job is done on the first status check.
const submitted: { endpoint: string; body: Record<string, unknown> }[] = [];
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const json = (v: unknown) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(v));
    if (req.method === "POST") {
      const endpoint = req.url!.slice(1);
      submitted.push({ endpoint, body: JSON.parse(raw) });
      return json({ status_url: `${base}/status`, response_url: `${base}/result/${endpoint}` });
    }
    if (req.url === "/status") return json({ status: "COMPLETED" });
    if (req.url!.includes("speech-to-text")) return json({ text: " Hello from the recording. ", language_code: "eng" });
    if (req.url!.includes("/result/")) return json({ audio: { url: `${base}/voice.mp3`, content_type: "audio/mpeg" } });
    if (req.url === "/voice.mp3") return res.writeHead(200, { "Content-Type": "audio/mpeg" }).end("MP3");
    res.writeHead(404).end();
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

process.env.FAL_KEY = "k";
process.env.FAL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
delete process.env.ELEVENLABS_API_KEY;
const { speechProvider, synthesizeSpeech, transcribe } = await import("../src/lib/engines/media.ts");
const { engineStatus } = await import("../src/lib/server/status.ts");

test("voice and transcription run through fal.ai when there is no ElevenLabs key", () => {
  assert.equal(speechProvider(), "fal");
  const status = engineStatus();
  assert.equal(status.voice, true);
  assert.equal(status.transcribe, true);
});

test("voice comes back as an MP3 from fal.ai", async () => {
  const speech = await synthesizeSpeech("Welcome to Flash AI");
  assert.equal(speech.mime, "audio/mpeg");
  assert.equal(speech.data.toString(), "MP3");
  const job = submitted.find((s) => s.endpoint.includes("tts"))!;
  assert.equal(job.body.text, "Welcome to Flash AI");
});

test("a recording is sent inline and its transcript comes back trimmed", async () => {
  const text = await transcribe({ name: "memo.m4a", mediaType: "audio/mp4", data: "AAAA" });
  assert.equal(text, "Hello from the recording.");
  const job = submitted.find((s) => s.endpoint.includes("speech-to-text"))!;
  assert.equal(job.body.audio_url, "data:audio/mp4;base64,AAAA");
});
