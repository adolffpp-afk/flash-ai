import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for Claude that answers the picture check with the word for each message.
const answers: Record<string, string> = { "great edit!": "other", "make it darker": "change", "a dragon": "new", "hmm": "maybe" };
const asked: { system: string; message: string }[] = [];
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw);
    const message = String(body.messages[0].content);
    asked.push({ system: String(body.system), message });
    if (message === "down") return res.writeHead(500).end("{}");
    const usage = { input_tokens: 300, output_tokens: 1 };
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: answers[message] ?? "" }], stop_reason: "end_turn", usage }),
    );
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const { pictureRequest } = await import("../src/lib/engines/claude.ts");

test("a small model checks a picture change before it is paid for", async () => {
  const spent: number[] = [];
  const meter = (_p: string, _m: string, cents: number) => void spent.push(cents);
  assert.equal(await pictureRequest("great edit!", true, meter), "other");
  assert.equal(await pictureRequest("make it darker", true, meter), "change");
  assert.equal(await pictureRequest("a dragon", true, meter), "new");
  assert.equal(spent.length, 3, "each check is metered");
  assert.ok(spent.every((c) => c > 0 && c < 0.1), "and costs a small part of a cent");
  assert.match(asked[0].system, /just made for them/);
  assert.match((await pictureRequest("make it darker", false), asked.at(-1)!.system), /photo they attached/);
});

test("an unclear answer or an error keeps the keyword rules' answer", async () => {
  assert.equal(await pictureRequest("hmm", true), null);
  assert.equal(await pictureRequest("down", true), null);
});
