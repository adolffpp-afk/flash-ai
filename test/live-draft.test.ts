import { test } from "node:test";
import assert from "node:assert/strict";
import { DRAFT_CHUNK, DRAFT_EVERY_MS, DRAFT_MAX, draftSender, sendable, type DraftEvent } from "../src/lib/live-draft.ts";
import { splitBuild } from "../src/lib/build-parse.ts";

const PAGE = `<!doctype html>
<html>
  <head>
    <title>Golden Crumb</title>
    <style>.order { background: #d97706; }</style>
  </head>
  <body>
    <h1>Golden Crumb</h1>
<pre>
\`\`x
\`\`
</pre>
    <script>
      const tick = \`\`;
    </script>
  </body>
</html>`;
const REPLY = `Here's your bakery page.\n\n\`\`\`html\n${PAGE}\n\`\`\`\n\n- Add opening hours`;

/** The drafts a sender makes when the reply is written step characters at a time, on a clock that moves by tick ms. */
function feed(text: string, step: number, { base = false, tick = 0 } = {}) {
  let clock = 0;
  const sender = draftSender({ base, now: () => clock });
  const events: DraftEvent[] = [];
  for (let i = step; ; i += step) {
    const part = splitBuild(text.slice(0, Math.min(i, text.length)));
    if (part.html !== null) {
      const e = sender.next(part.html, part.open);
      if (e) events.push(e);
    }
    clock += tick;
    if (i >= text.length) break;
  }
  return events;
}

const joined = (events: DraftEvent[]) => events.reduce((html, e) => (e.at === 0 ? e.delta : html + e.delta), "");

test("only a last line that may still become the closing fence is held back", () => {
  assert.equal(sendable("<p>a</p>\n", true), 8, "a newline");
  assert.equal(sendable("<p>a</p>\n`", true), 8, "a newline and one backtick");
  assert.equal(sendable("<p>a</p>\n``", true), 8, "a newline and two");
  assert.equal(sendable("<p>a</p>\n`x", true), 11, "a backtick that starts something else");
  assert.equal(sendable("<p>a</p>\n  <p>b", true), 15, "a line being written");
  assert.equal(sendable("<p>" + "x".repeat(10_000), true), 10_003, "a long line with no newline");
  assert.equal(sendable("<p>a</p>\n", false), 9, "a finished block is sent whole");
});

test("what is sent is always the start of the finished file, however the reply is cut into deltas", () => {
  const html = splitBuild(REPLY).html!;
  for (const step of [1, 2, 3, 40, 97]) {
    for (let i = 1; i <= REPLY.length; i += step) {
      const part = splitBuild(REPLY.slice(0, i));
      if (part.html === null) continue;
      const n = sendable(part.html, part.open);
      assert.ok(html.startsWith(part.html.slice(0, n)), `step ${step} at ${i}`);
    }
    const events = feed(REPLY, step);
    assert.equal(joined(events), html, `step ${step}: the drafts join up to the file`);
  }
});

test("drafts are sent at most twice a second unless 4 KB are waiting, each going on where the last stopped", () => {
  const big = "Here.\n\n```html\n<!doctype html>\n<body>\n" + "<p>A line of the page that goes on and on.</p>\n".repeat(2_000) + "</body>\n```\n";
  const html = splitBuild(big).html!;
  // A clock that never moves: only the 4 KB rule sends.
  const still = feed(big, 40, { tick: 0 });
  for (const e of still.slice(1, -1)) assert.ok(e.delta.length >= DRAFT_CHUNK, "a send waits for 4 KB");
  // A clock that moves 100 ms a delta: every 500 ms, or sooner with 4 KB waiting.
  const ticking = feed(big, 40, { tick: 100 });
  assert.ok(ticking.length > still.length);
  for (const e of ticking.slice(1, -1)) assert.ok(e.delta.length <= 40 * (DRAFT_EVERY_MS / 100) + 80 || e.delta.length >= DRAFT_CHUNK);
  for (const events of [still, ticking]) {
    let at = 0;
    for (const e of events) {
      assert.equal(e.at, at, "each draft goes on at the end of the last");
      at += e.delta.length;
    }
    assert.equal(joined(events), html);
  }
});

test("nothing past 400 KB is drafted", () => {
  let clock = 0;
  const sender = draftSender({ base: false, now: () => (clock += 1_000) });
  let html = "<!doctype html>\n";
  let total = 0;
  for (let i = 0; i < 105; i++) {
    html += "x".repeat(3_999) + "\n";
    const e = sender.next(html, true);
    if (e) total += e.delta.length;
  }
  assert.ok(html.length > 420_000);
  assert.equal(total, DRAFT_MAX);
  assert.equal(sender.next(html + "more\n", false), null);
});

test("a change drafts only a whole file: never a snippet, never pieces", () => {
  // A snippet quoted in the answer.
  assert.deepEqual(feed('Use this:\n\n```html\n<button class="order big">Order</button>\n```\n', 7, { base: true }), []);
  // Pieces in an html block.
  assert.deepEqual(feed("Renamed it.\n\n```html\n<<<<<<< FIND\n<h1>A</h1>\n=======\n<h1>B</h1>\n>>>>>>> REPLACE\n```", 5, { base: true }), []);
  // A whole file with no app before: any block is the app.
  assert.ok(feed('```html\n<button class="order big">Order</button>\n```', 5).length > 0);
  assert.equal(joined(feed(REPLY, 13, { base: true })), splitBuild(REPLY).html);
});

test("a file that turns out to be pieces takes back what was shown, once", () => {
  const reply = "Done.\n\n```html\n<!doctype html>\n<html><body><h1>Golden Crumb</h1>\n<<<<<<< FIND\n<h1>Golden Crumb</h1>\n=======\n<h1>Bakery</h1>\n>>>>>>> REPLACE\n```";
  const events = feed(reply, 3, { base: true });
  assert.ok(events.length >= 2);
  assert.deepEqual(events.at(-1), { type: "draft", at: 0, delta: "" }, "cleared");
  assert.equal(events.filter((e) => e.at === 0 && e.delta === "").length, 1, "and nothing after");
});
