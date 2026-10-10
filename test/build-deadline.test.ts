import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in Claude that writes what the test lines up next, 40 characters every 20 ms, so a test
// can cut it off part way. It counts the calls it was sent.
const answers: string[] = [];
let calls = 0;
const server = createServer((req, res) => {
  req.resume();
  req.on("end", async () => {
    calls++;
    const text = answers.shift() ?? "";
    const usage = { input_tokens: 3000, output_tokens: Math.ceil(text.length / 3) };
    const send = (e: { type: string }) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.writeHead(200, { "content-type": "text/event-stream" });
    send({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage } } as never);
    send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as never);
    for (let i = 0; i < text.length && !res.destroyed; i += 40) {
      send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(i, i + 40) } } as never);
      await new Promise((r) => setTimeout(r, 20));
    }
    if (res.destroyed) return;
    send({ type: "content_block_stop", index: 0 } as never);
    send({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage } as never);
    send({ type: "message_stop" });
    res.end();
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const { streamBuild } = await import("../src/lib/engines/builder.ts");
const { Running } = await import("../src/lib/engines/claude.ts");
type Event = { type: string; message?: string; app?: { html: string } };

const LONG_PAGE = "Here's your page.\n\n```html\n<!doctype html>\n<html><body>\n" + "<p>A line of the page that goes on.</p>\n".repeat(200) + "</body></html>\n```";
const PAGE = "<!doctype html>\n<html><body><h1>Bakery</h1></body></html>";
const edited = [
  { role: "user" as const, content: "build me a bakery page" },
  { role: "assistant" as const, content: "Here it is.", app: PAGE },
  { role: "user" as const, content: "make the title red" },
];

/** Runs a build, cut off after cutAt ms with the reason the chat route gives (Stop or its deadline). */
async function build(history: { role: "user" | "assistant"; content: string; app?: string }[], cutAt: number, reason: string, endsAt?: number) {
  const abort = new AbortController();
  const running = new Running();
  const costs: number[] = [];
  const events: Event[] = [];
  const timer = setTimeout(() => abort.abort(reason), cutAt);
  try {
    for await (const e of streamBuild(history, "", "app", (_p, _m, cents) => costs.push(cents), undefined, undefined, undefined, {
      signal: abort.signal,
      running,
      endsAt,
    })) {
      events.push(e as Event);
    }
    return { events, costs, error: null as unknown };
  } catch (error) {
    return { events, costs, error };
  } finally {
    clearTimeout(timer);
  }
}

test("a first build cut off by the request's deadline keeps what was written, paid from its estimate", async () => {
  answers.push(LONG_PAGE);
  const { events, costs, error } = await build([{ role: "user", content: "build me a page" }], 300, "deadline");
  assert.equal(error, null);
  const app = events.find((e) => e.type === "app")?.app;
  assert.ok(app && app.html.startsWith("<!doctype html>") && app.html.length < LONG_PAGE.length, "the half-written page");
  assert.equal(events.find((e) => e.type === "error")?.message, "The app was too large to finish in one go. Try asking for a simpler first version.");
  assert.equal(costs.length, 1);
  assert.ok(costs[0] > 0, "the cut call is paid for");
});

test("Stop on a first build, or the deadline on a change, keeps nothing: the call is cut", async () => {
  answers.push(LONG_PAGE);
  const stopped = await build([{ role: "user", content: "build me a page" }], 300, "stop");
  assert.ok(stopped.error);
  assert.equal(stopped.events.find((e) => e.type === "app"), undefined);
  answers.push(LONG_PAGE);
  const change = await build(edited, 300, "deadline");
  assert.ok(change.error);
  assert.equal(change.events.find((e) => e.type === "app"), undefined, "a half-written file never replaces an app that works");
});

test("the whole file isn't asked for again when the request's time would cut it off", async () => {
  // Pieces that don't fit the file: the builder would ask for the whole file again.
  const misfit = "```flash-edit\n<<<<<<< FIND\nnot in the file\n=======\n<h1 style=\"color:red\">Bakery</h1>\n>>>>>>> REPLACE\n```";
  answers.push(misfit, PAGE);
  calls = 0;
  const soon = await build(edited, 60_000, "stop", Date.now() + 1000);
  assert.equal(calls, 1, "no second call");
  assert.match(soon.events.find((e) => e.type === "error")?.message ?? "", /couldn't fit that change/);
  answers.length = 0;
  answers.push(misfit, "```html\n" + PAGE + "\n```");
  calls = 0;
  const later = await build(edited, 60_000, "stop", Date.now() + 600_000);
  assert.equal(calls, 2, "with time left it's asked for");
  assert.ok(later.events.find((e) => e.type === "app"));
});
