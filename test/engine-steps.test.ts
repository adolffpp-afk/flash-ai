import { test } from "node:test";
import assert from "node:assert/strict";
import type { StreamEvent } from "../src/lib/types.ts";

const { readEngine } = await import("../src/lib/server/engine-steps.ts");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reads an engine as the chat route does, with Stop pressed after stopAt ms (and the abort it sends). */
async function read(engine: (signal: AbortSignal) => AsyncGenerator<StreamEvent>, stopAt: number, drainMs?: number) {
  const abort = new AbortController();
  const sent: StreamEvent[] = [];
  let halt = false;
  let wake = () => {};
  const timer = setTimeout(() => {
    halt = true;
    abort.abort();
    wake();
  }, stopAt);
  try {
    const how = await readEngine(engine(abort.signal)[Symbol.asyncIterator](), (e) => sent.push(e), {
      halted: () => halt,
      onWake: (w) => (wake = w),
      drainMs,
    });
    return { how, sent };
  } finally {
    clearTimeout(timer);
  }
}

// A builder whose call already finished (and was paid for) when Stop came, still working out the app.
async function* finishedBuild(): AsyncGenerator<StreamEvent> {
  yield { type: "text", delta: "Here is your app." };
  // Reading what was written: the call is over, so the abort changes nothing.
  await wait(60);
  yield { type: "app", app: { title: "App", html: "<html></html>", kind: "app" } };
  yield { type: "text", delta: "Enjoy!" };
}

// A call still streaming when Stop came: the abort ends it at once.
async function* cutCall(signal: AbortSignal): AsyncGenerator<StreamEvent> {
  yield { type: "text", delta: "Thinking about" };
  await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("Request was aborted."))));
  yield { type: "text", delta: " never sent" };
}

test("Stop after a build's call finished still delivers the app it paid for, and the reply isn't stopped", async () => {
  const { how, sent } = await read(finishedBuild, 20, 15_000);
  assert.equal(how, "ended");
  assert.deepEqual(
    sent.map((e) => e.type),
    ["text", "app", "text"],
  );
});

test("Stop during a call cuts it at once, and the engine's abort error says it was stopped", async () => {
  const started = Date.now();
  await assert.rejects(read(cutCall, 20, 15_000), /aborted/);
  assert.ok(Date.now() - started < 1000);
});

test("without draining (a picture, or the free lane) Stop ends reading at once", async () => {
  const { how, sent } = await read(finishedBuild, 20);
  assert.equal(how, "stopped");
  assert.deepEqual(
    sent.map((e) => e.type),
    ["text"],
  );
});

test("an engine that doesn't end after Stop is let go once the drain time is up", async () => {
  async function* stuck(): AsyncGenerator<StreamEvent> {
    yield { type: "text", delta: "a" };
    await wait(1500);
  }
  const started = Date.now();
  const { how } = await read(stuck, 20, 100);
  assert.equal(how, "stopped");
  assert.ok(Date.now() - started < 1000);
});

test("with no Stop the engine is read to its end", async () => {
  const { how, sent } = await read(finishedBuild, 60_000, 15_000);
  assert.equal(how, "ended");
  assert.equal(sent.length, 3);
});
