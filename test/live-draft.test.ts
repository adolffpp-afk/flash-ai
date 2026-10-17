import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILD_STEPS,
  DRAFT_CHUNK,
  DRAFT_EVERY_MS,
  DRAFT_MAX,
  FONTS_MS,
  SWAP_BY_MS,
  buildStep,
  draftSender,
  draftShown,
  draftStore,
  draftView,
  sendable,
  swapAt,
  writingPart,
  type DraftEvent,
} from "../src/lib/live-draft.ts";
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

const draft = (at: number, delta: string): DraftEvent => ({ type: "draft", at, delta });

test("the page keeps one reply's draft: it grows piece by piece, starts over at 0, and stops growing at a gap", () => {
  const store = draftStore();
  let renders = 0;
  store.subscribe(() => renders++);
  const empty = store.get();
  assert.deepEqual(empty, { reply: "", html: "", frozen: false });
  store.apply("r1", draft(0, "<!doctype html>"));
  store.apply("r1", draft(15, "<body>"));
  assert.deepEqual(store.get(), { reply: "r1", html: "<!doctype html><body>", frozen: false });
  const shown = store.get();
  assert.equal(store.get(), shown, "the same snapshot while nothing changes");
  store.apply("r1", draft(99, "<p>lost</p>"));
  assert.equal(store.get().frozen, true, "a missed piece stops the draft");
  assert.equal(store.get().html, "<!doctype html><body>", "but what it has stays on show");
  store.apply("r1", draft(21, "<p>late</p>"));
  assert.equal(store.get().html, "<!doctype html><body>", "nothing joins a stopped draft");
  store.apply("r1", draft(0, "<!doctype html>"));
  assert.deepEqual(store.get(), { reply: "r1", html: "<!doctype html>", frozen: false }, "at 0 starts it over");
  store.apply("r2", draft(0, "<html>"));
  assert.equal(store.get().reply, "r2", "another reply starts its own");
  const before = renders;
  store.clear("r1");
  assert.equal(store.get().html, "<html>", "clearing another reply's draft does nothing");
  assert.equal(renders, before);
  store.clear("r2");
  assert.equal(store.get().html, "");
  store.apply("r3", draft(0, "x".repeat(DRAFT_MAX - 1)));
  store.apply("r3", draft(DRAFT_MAX - 1, "yy"));
  assert.equal(store.get().html.length, DRAFT_MAX - 1, "never past 400 KB");
  assert.equal(store.get().frozen, true);
  store.clear();
  assert.equal(store.get().html, "");
});

test("a draft is shown with nothing in it that runs, and ends before anything half-written", () => {
  const view = draftView(
    '<!DOCTYPE html><html><head><meta http-equiv="Refresh" content="0;url=https://elsewhere.example"><title>T</title></head><body>' +
      "<h1>Hi</h1><SCRIPT>alert(1)</SCRIPT><svg><script>alert(2)</script></svg><noscript><p>Turn on scripts</p></noscript><p>After</p>",
  );
  assert.ok(!/script|refresh|Turn on scripts|alert/i.test(view), view);
  assert.match(view, /<h1>Hi<\/h1>/);
  assert.match(view, /<p>After<\/p>$/);
  assert.match(view, /^<!DOCTYPE html><html><head><base target="_blank">/, "links open nothing");
  // An unclosed script, comment or tag: the draft ends before it.
  assert.equal(draftView("<head></head><p>One</p><script>let a = '<p>not shown</p>"), '<head><base target="_blank"></head><p>One</p>');
  assert.equal(draftView("<head></head><p>One</p><!-- a note <p>"), '<head><base target="_blank"></head><p>One</p>');
  assert.equal(draftView('<head></head><p>One</p><a href="#/menu" cla'), '<head><base target="_blank"></head><p>One</p>');
  assert.equal(draftView("<head></head><p>Words being writ"), '<head><base target="_blank"></head><p>Words being writ', "text already written stays");
  assert.equal(draftView("<head></head><p>a</p><!-- done --><p>b"), '<head><base target="_blank"></head><p>a</p><!-- done --><p>b');
  assert.equal(draftView("<!doctype html><body>x"), '<!doctype html><base target="_blank"><body>x');
  assert.ok(draftView("<header>not the head</header>").startsWith('<base target="_blank"><header>'));
});

test("every link in a draft opens a new window, which the frame may not: its own target is put aside", () => {
  // _self would take the frame itself away to the link; _blank is a window the frame may not open.
  assert.equal(
    draftView(
      '<head></head><a target="_self" href="https://elsewhere.example">A</a><A HREF=b TARGET=_top>B</A><map><area shape=rect target=\'_parent\' href="c"></map>' +
        '<a title="1 > 2" target = _self data-target="menu">D</a><abbr target="x">E</abbr><p>Set target="_self" on it</p><a href=e/>F</a>',
    ),
    '<head><base target="_blank"></head><a href="https://elsewhere.example" target="_blank">A</a><A HREF=b target="_blank">B</A><map><area shape=rect href="c" target="_blank"></map>' +
      '<a title="1 > 2" data-target="menu" target="_blank">D</a><abbr target="x">E</abbr><p>Set target="_self" on it</p><a href=e/ target="_blank">F</a>',
  );
});

test("an SVG link, which doesn't follow the page's base target, is given _blank too", () => {
  // With no target of its own, an SVG link would take the frame away to the other site.
  assert.equal(
    draftView(
      '<head></head><svg viewBox="0 0 10 10"><a href="https://elsewhere.example/map"><circle r="4"/></a>' +
        '<a target="_blank" xlink:href="https://elsewhere.example/x"><rect width="2"/></a><a target="_self" href="y" /><text>Shops</text></svg>',
    ),
    '<head><base target="_blank"></head><svg viewBox="0 0 10 10"><a href="https://elsewhere.example/map" target="_blank"><circle r="4"/></a>' +
      '<a xlink:href="https://elsewhere.example/x" target="_blank"><rect width="2"/></a><a href="y" target="_blank" /><text>Shops</text></svg>',
  );
});

test("the build steps follow how far the file has got", () => {
  const steps = (html: string) => BUILD_STEPS[buildStep(html)];
  assert.equal(steps(""), "Page layout");
  assert.equal(steps("<!doctype html><html><head><title>Shop</title>"), "Page layout");
  assert.equal(steps("<head><style>body{margin:0}"), "Styles");
  assert.equal(steps('<head><link rel="stylesheet" href="x.css">'), "Styles");
  assert.equal(steps('<head><script src="https://cdn.tailwindcss.com"></script></head>'), "Styles", "a library in the head isn't the app's own script");
  assert.equal(steps("<head></head><body><h1>Shop</h1>"), "Content");
  assert.equal(steps("<head></head><body><h1>Shop</h1><script>const cart = [];"), "Interactions");
  assert.equal(steps('<body><script type="application/ld+json">{}</script>'), "Content");
  assert.equal(steps('<body><script>go()</script>\n<script type="application/json" id="flash-data">{"menu": "read"}'), "Final checks");
  assert.equal(steps("<body><main></main></body>"), "Final checks");
});

test("a change keeps the version on show until the new file's page starts; a first build or a deck shows at once", () => {
  const head = "<!doctype html><html><head><title>Golden Crumb</title><style>body { margin: 0 }";
  const content = `${head}</style></head><body><h1>Golden Crumb</h1>`;
  for (const kind of ["app", "slides"] as const) {
    assert.equal(draftShown("", { changing: false, kind }), false, "nothing written yet");
    assert.equal(draftShown(head, { changing: false, kind }), true, `a first ${kind} shows its steps from the start`);
    assert.equal(draftShown(content, { changing: true, kind }), true);
  }
  assert.equal(draftShown(head, { changing: true, kind: "app" }), false, "a whole new file for an app: the app stays while the head and styles are written");
  assert.equal(draftShown(head, { changing: true, kind: "slides" }), true, "a deck never has a live page, so its steps show at once");
});

test("a redrawn draft comes to the front a while after its load, so its web fonts have come, and never later than 1.5 s", () => {
  assert.ok(FONTS_MS >= 500, "a font that takes half a second still arrives underneath");
  assert.equal(swapAt(10_000, 10_080), 10_080 + FONTS_MS, "not at its load: the load doesn't wait for fonts");
  assert.ok(swapAt(10_000, 10_080) > 10_080 + 300, "a font host answering in 300 ms after the load is in time");
  assert.equal(swapAt(10_000, 11_200), 10_000 + SWAP_BY_MS, "a page held back by its pictures comes by the cap");
  assert.equal(swapAt(10_000), 10_000 + SWAP_BY_MS, "one that never loads too");
});

test("the part being written is the last heading's words", () => {
  assert.equal(writingPart("<h1>Golden Crumb</h1><p>x</p><h2 class=\"t\">Our <em>fresh</em> &amp; warm loaves</h2>"), "Our fresh & warm loaves");
  assert.equal(writingPart("<h1>Golden Crumb</h1><section><h3>Opening ho"), "Opening ho");
  assert.equal(writingPart("<h2>A heading that goes on far longer than any heading should</h2>"), "A heading that goes on far longer than a…");
  assert.equal(writingPart("<p>No heading here</p><header>x</header>"), "");
  assert.equal(writingPart("<h2>Menu <span cla"), "Menu");
});
