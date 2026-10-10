import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEvent } from "../src/lib/apply-event.ts";
import type { UIMessage } from "../src/lib/store.ts";
import type { StreamEvent } from "../src/lib/types.ts";

const placeholder = (): UIMessage => ({ id: "r1", role: "assistant", content: "", pending: true });
const build = (events: StreamEvent[]) => events.reduce(applyEvent, placeholder());

// What the browser saves once a reply is done (Flash.tsx: respond's finally, then the autosave).
const browserSaves = (m: UIMessage) => JSON.stringify({ ...{ ...m, pending: false, status: undefined }, pending: undefined, status: undefined });
// What the chat route saves at the end of the request.
const serverSaves = (m: UIMessage) => JSON.stringify({ ...m, pending: undefined, status: undefined });

const route: StreamEvent = { type: "route", engine: "text", reason: "Writing.", demo: false, cost: 0, model: "Vision", modelWhy: "Auto" };

test("a written reply: text joins up, the cost arrives last, done ends it", () => {
  const m = build([route, { type: "status", message: "Thinking…" }, { type: "text", delta: "Hello" }, { type: "text", delta: " there" }, { type: "cost", credits: 3 }, { type: "done" }]);
  assert.equal(m.content, "Hello there");
  assert.equal(m.engine, "text");
  assert.equal(m.model, "Vision");
  assert.equal(m.cost, 3);
  assert.equal(m.pending, false);
  assert.equal(m.status, undefined);
});

test("text after an app goes below it, and pictures, videos, sound and sources each land in their place", () => {
  const app = build([{ type: "text", delta: "Here it is." }, { type: "app", app: { title: "T", html: "<p>x</p>", kind: "app" } }, { type: "text", delta: "\n\nTry it." }]);
  assert.equal(app.content, "Here it is.");
  assert.equal(app.after, "\n\nTry it.");
  const media = build([
    { type: "status", message: "Painting…" },
    { type: "image", url: "/api/files/a", prompt: "p", label: "Square, for posts" },
    { type: "video", url: "/api/files/b", prompt: "v" },
    { type: "audio", url: "/api/files/c", label: "flash-voice.mp3" },
    { type: "sources", items: [{ title: "S", url: "https://s.io" }] },
  ]);
  assert.equal(media.status, undefined, "a finished file clears the progress line");
  assert.deepEqual(media.images, [{ url: "/api/files/a", prompt: "p", label: "Square, for posts" }]);
  assert.deepEqual(media.videos, [{ url: "/api/files/b", prompt: "v" }]);
  assert.equal(media.audioLabel, "flash-voice.mp3");
  assert.equal(media.sources?.length, 1);
});

test("a stopped or failed reply says so", () => {
  assert.equal(build([{ type: "text", delta: "Half" }, { type: "stopped" }, { type: "done" }]).stopped, true);
  assert.equal(build([{ type: "error", message: "Busy." }, { type: "done" }]).error, "Busy.");
});

test("the browser and the server save the same reply from the same events", () => {
  const streams: StreamEvent[][] = [
    [route, { type: "text", delta: "One" }, { type: "cost", credits: 2 }, { type: "done" }],
    [route, { type: "status", message: "Writing your app… 25 lines" }, { type: "app", app: { title: "A", html: "<html></html>", kind: "app" } }, { type: "text", delta: "Done." }, { type: "done" }],
    [route, { type: "text", delta: "Cut" }, { type: "stopped" }, { type: "cost", credits: 1 }, { type: "done" }],
    [route, { type: "error", message: "Busy. Your credits were refunded." }, { type: "done" }],
  ];
  for (const events of streams) {
    // The browser applies each line as it arrives; the server applies them as it sends them, and
    // saves before it sends done.
    const browser = build(events);
    const server = events.filter((e) => e.type !== "done").reduce(applyEvent, placeholder());
    assert.equal(serverSaves(server), browserSaves(browser));
  }
});
