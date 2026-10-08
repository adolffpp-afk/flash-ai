import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in Claude that streams whatever the test lines up next, and keeps what it was sent.
const answers: (string | { text: string; stop: string })[] = [];
const sent: { system: string; messages: string; maxTokens: number }[] = [];
const usage = { input_tokens: 3000, output_tokens: 300 };
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    sent.push({ system: String(body.system ?? ""), messages: JSON.stringify(body.messages ?? []), maxTokens: body.max_tokens });
    const next = answers.shift() ?? "";
    const [text, stop] = typeof next === "string" ? [next, "end_turn"] : [next.text, next.stop];
    const events: object[] = [
      { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ];
    for (let i = 0; i < text.length; i += 40) events.push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(i, i + 40) } });
    events.push({ type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: stop }, usage }, { type: "message_stop" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const e of events) res.write(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const { streamBuild } = await import("../src/lib/engines/builder.ts");
type Event = { type: string; delta?: string; message?: string; app?: { title: string; html: string; kind: string } };

const PAGE = `<!doctype html>
<html>
  <head>
    <title>Golden Crumb</title>
    <style>
      .order { background: #d97706; }
    </style>
  </head>
  <body>
    <h1>Golden Crumb</h1>
    <button class="order">Order a loaf</button>
  </body>
</html>`;

const history = (request: string) => [
  { role: "user" as const, content: "build me a bakery page" },
  { role: "assistant" as const, content: "Here's your bakery page.", app: PAGE },
  { role: "user" as const, content: request },
];

const edit = (find: string, replace: string) => `\`\`\`flash-edit\n<<<<<<< FIND\n${find}\n=======\n${replace}\n>>>>>>> REPLACE\n\`\`\``;

async function run(request: string, budget?: { maxTokens: number; capCents: number }) {
  const events: Event[] = [];
  const costs: number[] = [];
  for await (const e of streamBuild(history(request), "", "app", (_p, _m, cents) => costs.push(cents), budget)) events.push(e as Event);
  const said = events.filter((e) => e.type === "text").map((e) => e.delta).join("");
  const app = events.find((e) => e.type === "app")?.app;
  const error = events.find((e) => e.type === "error")?.message;
  const statuses = events.filter((e) => e.type === "status").map((e) => e.message);
  return { said, app, error, statuses, costs };
}

test("a small change comes back as the whole app, built from the pieces", async () => {
  sent.length = 0;
  answers.push(`Made the button green.\n\n${edit("      .order { background: #d97706; }", "      .order { background: #16a34a; }")}\n\n- Add opening hours`);
  const { said, app, error, statuses, costs } = await run("make the order button green");
  assert.equal(error, undefined);
  assert.equal(app?.html, PAGE.replace("#d97706", "#16a34a"), "the full file, with only that line changed");
  assert.equal(app?.title, "Golden Crumb");
  assert.equal(said, "Made the button green.\n\n\n\n- Add opening hours", "the pieces themselves are never shown");
  assert.ok(statuses.includes("Changing your app…"));
  assert.ok(statuses.includes("Changing 1 place in your app…"));
  assert.equal(sent.length, 1, "one call");
  assert.equal(costs.length, 1);
  assert.match(sent[0].system, /flash-edit/, "the builder is told it may send pieces");
});

test("pieces that don't fit the file are never guessed: the whole file is asked for once", async () => {
  sent.length = 0;
  const bigger = PAGE.replace("<h1>", '<h1 style="font-size:52px">');
  answers.push(`Made the heading bigger.\n\n${edit("    <h2>Fresh since 1998</h2>", "    <h2>Fresh every day</h2>")}`);
  answers.push(`Here it is.\n\n\`\`\`html\n${bigger}\n\`\`\``);
  const { said, app, error, costs } = await run("make the heading bigger");
  assert.equal(error, undefined);
  assert.equal(app?.html, bigger);
  assert.equal(said, "Made the heading bigger.\n\n", "said once, not twice");
  assert.equal(sent.length, 2);
  assert.equal(costs.length, 2, "both calls are paid for");
  assert.match(sent[1].messages, /send the COMPLETE file/);
  assert.match(sent[1].messages, /Fresh since 1998/, "the second call sees what didn't fit");
  assert.ok(!sent[1].system.includes("flash-edit"), "and is told to send the whole file only");
});

test("with too few credits left for the whole file, Flash stops instead of running at a loss", async () => {
  sent.length = 0;
  answers.push(`Made the heading bigger.\n\n${edit("    <h2>Nope</h2>", "    <h2>Yes</h2>")}`);
  // The first call costs 1.8 cents and reading everything again 1.4, leaving nothing to write with.
  const { app, error } = await run("make the heading bigger", { maxTokens: 4000, capCents: 3.2 });
  assert.equal(app, undefined);
  assert.match(error ?? "", /couldn't fit that change/);
  assert.equal(sent.length, 1, "no second call");
});

test("the second call may only write what the held credits still pay for", async () => {
  sent.length = 0;
  answers.push(`Done.\n\n${edit("    <h2>Nope</h2>", "    <h2>Yes</h2>")}`);
  answers.push(`\`\`\`html\n${PAGE}\n\`\`\``);
  await run("change the tagline", { maxTokens: 64000, capCents: 20 });
  assert.equal(sent.length, 2);
  // 20 cents, less the first call (3000 in, 300 out) and reading 3,500 tokens again, at Opus prices.
  const firstCall = (3000 * 400 + 300 * 2000) / 1e6;
  const reread = (3500 * 400) / 1e6;
  assert.equal(sent[1].maxTokens, Math.floor(((20 - firstCall - reread) * 1e6) / 2000));
});

test("a whole file is still taken as it always was, and a first build never hears about pieces", async () => {
  sent.length = 0;
  answers.push(`Rebuilt it as a shop.\n\n\`\`\`html\n${PAGE}\n\`\`\`\n\n- Add prices`);
  const { said, app } = await run("turn it into a whole online shop");
  assert.equal(app?.html, PAGE);
  assert.equal(said, "Rebuilt it as a shop.\n\n\n\n- Add prices");

  sent.length = 0;
  answers.push(`Here's your page.\n\n\`\`\`html\n${PAGE}\n\`\`\``);
  const first: Event[] = [];
  for await (const e of streamBuild([{ role: "user", content: "build me a bakery page" }], "", "app")) first.push(e as Event);
  assert.ok(first.some((e) => e.type === "status" && e.message === "Designing your app…"));
  assert.ok(!sent[0].system.includes("flash-edit"));
});

test("an answer with no file and no pieces is just words, as before", async () => {
  sent.length = 0;
  answers.push("Which colour would you like for the button?");
  const { said, app, error } = await run("change the button");
  assert.equal(said, "Which colour would you like for the button?");
  assert.equal(app, undefined);
  assert.equal(error, undefined);
  assert.equal(sent.length, 1);
});

test("an html snippet quoted next to the pieces never replaces the app", async () => {
  sent.length = 0;
  answers.push(
    `Made the button green.\n\n${edit("      .order { background: #d97706; }", "      .order { background: #16a34a; }")}\n\nThe button now looks like:\n\n\`\`\`html\n<button class="order">Order a loaf</button>\n\`\`\``,
  );
  const { said, app, error } = await run("make the order button green");
  assert.equal(error, undefined);
  assert.equal(app?.html, PAGE.replace("#d97706", "#16a34a"));
  assert.match(said, /The button now looks like/);
  assert.equal(sent.length, 1);

  sent.length = 0;
  answers.push("Use this:\n\n```html\n<button class=\"order big\">Order</button>\n```\n\nShall I add it?");
  const asked = await run("how would a bigger button look?");
  assert.equal(asked.app, undefined, "a snippet on its own is words, not the app");
  assert.match(asked.said, /Shall I add it\?/);
  assert.match(asked.said, /order big/);
});

test("pieces sent in an html block change the app instead of becoming it", async () => {
  sent.length = 0;
  answers.push(`Renamed it.\n\n\`\`\`html\n<<<<<<< FIND\n    <h1>Golden Crumb</h1>\n=======\n    <h1>Golden Crumb Bakery</h1>\n>>>>>>> REPLACE\n\`\`\``);
  const { said, app, error } = await run("rename the heading");
  assert.equal(error, undefined);
  assert.equal(app?.html, PAGE.replace("<h1>Golden Crumb</h1>", "<h1>Golden Crumb Bakery</h1>"));
  assert.equal(said, "Renamed it.\n\n");
});

test("a block with no readable pieces asks for the whole file", async () => {
  for (const block of ["```flash-edit\n```", "```flash-edit\n<<<<<<< FIND\n    <h1>Golden Crumb</h1>\n>>>>>>> REPLACE\n```"]) {
    sent.length = 0;
    answers.push(`Done.\n\n${block}`);
    answers.push(`\`\`\`html\n${PAGE}\n\`\`\``);
    const { app, error } = await run("change the heading");
    assert.equal(error, undefined);
    assert.equal(sent.length, 2, block);
    assert.equal(app?.html, PAGE);
  }
});

test("a half-written file on the second go never replaces the app", async () => {
  sent.length = 0;
  answers.push(`Done.\n\n${edit("    <h2>Nope</h2>", "    <h2>Yes</h2>")}`);
  answers.push({ text: `\`\`\`html\n${PAGE.slice(0, 120)}`, stop: "max_tokens" });
  const { app, error } = await run("change the tagline");
  assert.equal(app, undefined);
  assert.ok(error, "the user is told it didn't finish");
  assert.equal(sent.length, 2);

  // A cut-off set of pieces is never made either.
  sent.length = 0;
  answers.push({ text: `Done.\n\n${edit("      .order { background: #d97706; }", "      .order { background: #16a34a; }")}`, stop: "max_tokens" });
  const cut = await run("make the order button green");
  assert.equal(cut.app, undefined);
  assert.ok(cut.error);
  assert.equal(sent.length, 1);
});

test("pressing Stop before the second go never starts it", async () => {
  sent.length = 0;
  answers.push(`Done.\n\n${edit("    <h2>Nope</h2>", "    <h2>Yes</h2>")}`);
  const events = streamBuild(history("change the tagline"), "", "app");
  for await (const e of events) {
    if (e.type === "status" && e.message === "Writing your app…") break;
  }
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, 1, "the whole file was never asked for");
  answers.length = 0;
});

test("the second go leaves room to think before writing the whole file", async () => {
  sent.length = 0;
  answers.push(`Done.\n\n${edit("    <h2>Nope</h2>", "    <h2>Yes</h2>")}`);
  // Enough for the file itself (about 110 tokens) but not for thinking first.
  const { error } = await run("change the tagline", { maxTokens: 64000, capCents: 3.2 + 2000 * 0.002 });
  assert.match(error ?? "", /couldn't fit that change/);
  assert.equal(sent.length, 1);
});
