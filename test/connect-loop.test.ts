import { test, after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

/*
 * The connector loop end to end, with a stand-in Claude (scripted replies, streamed as Claude streams
 * them, and token counts) and the stand-in MCP servers of scripts/mock-connectors.ts. Nothing here
 * reaches a real service.
 */
type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: object }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "fallback"; from: object; to: object };
// A reply that hangs sends its blocks and never finishes, as a slow answer the user stops; usage is
// what it says it read and wrote (by default, usage below).
type Reply = { blocks: Block[]; stop: string; hang?: boolean; usage?: { input_tokens: number; output_tokens: number } };
const replies: Reply[] = [];
const sent: { model: string; max_tokens: number; system: string; tools?: { name: string }[]; tool_choice?: { type: string }; messages: { role: string; content: unknown }[] }[] = [];
const counted: unknown[] = [];
// What count_tokens answers: a number of tokens, or an error status.
let counting: { tokens: number } | { status: number } = { tokens: 3000 };
const usage = { input_tokens: 3000, output_tokens: 200 };
// Models that answer "overloaded", as a busy level does.
const busy = new Set<string>();
const claude = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    if (req.url?.includes("count_tokens")) {
      counted.push(body);
      if ("status" in counting) {
        res.writeHead(counting.status, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "scripted" } }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ input_tokens: counting.tokens }));
    }
    sent.push(body);
    if (busy.has(body.model)) {
      res.writeHead(529, { "content-type": "application/json", "x-should-retry": "false" });
      return res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    }
    const reply: Reply = replies.shift() ?? { blocks: [{ type: "text", text: "done" }], stop: "end_turn" };
    const used = reply.usage ?? usage;
    const events: object[] = [{ type: "message_start", message: { id: `msg_${sent.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: used } }];
    reply.blocks.forEach((b, index) => {
      if (b.type === "text") {
        events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
        events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
      } else if (b.type === "tool_use") {
        events.push({ type: "content_block_start", index, content_block: { ...b, input: {} } });
        events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
      } else if (b.type === "thinking") {
        events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
        events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.thinking } });
        events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: b.signature } });
      } else events.push({ type: "content_block_start", index, content_block: b });
      if (!reply.hang) events.push({ type: "content_block_stop", index });
    });
    if (!reply.hang) events.push({ type: "message_delta", delta: { stop_reason: reply.stop }, usage: used }, { type: "message_stop" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const e of events) res.write(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`);
    if (!reply.hang) res.end();
  });
});
await new Promise<void>((r) => claude.listen(0, "127.0.0.1", r));

process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(claude.address() as AddressInfo).port}`;
process.env.DATABASE_URL = ":memory:";
process.env.CONNECTOR_KEYS = JSON.stringify({ v1: randomBytes(32).toString("base64") });
delete process.env.VERCEL_ENV;

const { startMockConnectors, POISON } = await import("../scripts/mock-connectors.ts");
const mock = await startMockConnectors(0);
process.env.FLASH_CONNECT_MOCK = mock.origin;
after(async () => {
  claude.closeAllConnections();
  claude.close();
  await mock.close();
});

const { NO_FIRST_STEP, claudeChoice, countInputTokens, streamText, system, withStepDown, Running } = await import("../src/lib/engines/claude.ts");
const { FriendlyError } = await import("../src/lib/engines/errors.ts");
const { CONNECT_LINE, connectorCalls, needsApproval, refuseUnpaid } = await import("../src/lib/engines/connect.ts");
const { CONNECT_STEPS, claudeCostCents, claudePrice, connectPlan, finalCredits, planHold, tokensWithin, worstTokens } = await import("../src/lib/credits.ts");
const { ConnectError, addConnection, changedTool, chatKit, listConnections, previewServer, runApproved, updateConnection } = await import(
  "../src/lib/server/connections.ts"
);
const { approvedResults, releaseResults } = await import("../src/lib/server/pending-actions.ts");
const { seal } = await import("../src/lib/server/secret-box.ts");
const { resetPassword, signInWithEmail } = await import("../src/lib/server/signin.ts");
const { applyEvent } = await import("../src/lib/apply-event.ts");
const { readEngine } = await import("../src/lib/server/engine-steps.ts");
const { all, one, run: sql } = await import("../src/lib/server/db.ts");

type Event = { type: string; delta?: string; message?: string; items?: unknown[]; action?: { id: string; tool: string; input: Record<string, unknown>; inputHash: string; connection: string } };
const ask = (content: string) => [{ role: "user" as const, content }];
const said = (events: Event[]) => events.filter((e) => e.type === "text").map((e) => e.delta).join("");
const drain = async (gen: AsyncGenerator<unknown>) => {
  const events: Event[] = [];
  for await (const e of gen) events.push(e as Event);
  return events;
};
const choice = claudeChoice("text", "ascend");
const user = "user-1";
let linear = "";
let custom = "";

before(async () => {
  await sql("INSERT INTO users (id, email, name, password_hash, preferences, created_at, last_free_grant) VALUES (?, ?, '', 'x', '', 0, 0)", [user, "a@example.com"]);
  linear = (await addConnection(user, { provider: "linear", token: "lin_api_SECRETSECRET1234" })).id;
  const seen = await previewServer(user, { provider: "custom", url: `${mock.origin}/mcp` });
  // "changing" says something new from its second listing: add it as the user saw it.
  mock.reset();
  custom = (await addConnection(user, { provider: "custom", url: `${mock.origin}/mcp`, pins: Object.fromEntries(seen.tools.map((t) => [t.name, t.hash])) })).id;
});

beforeEach(() => {
  replies.length = 0;
  sent.length = 0;
  counted.length = 0;
  counting = { tokens: 3000 };
  mock.reset();
});

const budget = { maxTokens: 8000, capCents: 100 };
const reply = async (ids: string[], o: { budget?: typeof budget; signal?: AbortSignal; costs?: number[]; running?: InstanceType<typeof Running> } = {}) => {
  const kit = (await chatKit(user, ids, { replyId: "reply-1", signal: o.signal }))!;
  return drain(
    streamText(ask("Use my accounts"), "", "text", (_p, _m, cents) => o.costs?.push(cents), o.budget ?? budget, choice, undefined, { signal: o.signal, running: o.running }, { connect: kit }),
  );
};

test("a read runs, goes back to Claude as data from the account, and is listed under the reply", async () => {
  replies.push({ blocks: [{ type: "tool_use", id: "toolu_1", name: "linear__echo", input: { text: "hello there" } }], stop: "tool_use" }, { blocks: [{ type: "text", text: "It said hello." }], stop: "end_turn" });
  const events = await reply([linear]);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].name, "echo");
  assert.equal(mock.calls[0].headers.authorization, "Bearer lin_api_SECRETSECRET1234");
  assert.equal(said(events), "It said hello.");
  assert.ok(events.some((e) => e.type === "status" && e.message === "Using Linear · echo…"));
  assert.deepEqual(events.at(-1), { type: "connector_used", items: [{ connection: "Linear", tool: "echo" }] });
  const [first, second] = sent;
  assert.ok(first.system.includes(CONNECT_LINE));
  assert.deepEqual(first.tool_choice, { type: "auto" });
  assert.ok(first.tools!.some((t) => t.name === "linear__echo"));
  const result = (second.messages.at(-1)!.content as { type: string; content: string }[])[0];
  assert.equal(result.type, "tool_result");
  assert.deepEqual(JSON.parse(result.content), { source: "Linear", tool: "echo", text: "hello there" });
  // The reply as saved lists what was used, never what came back.
  let saved: Parameters<typeof applyEvent>[0] = { id: "r", role: "assistant", content: "" };
  for (const e of events) saved = applyEvent(saved, e as never);
  assert.ok(!JSON.stringify(saved).includes("hello there"));
  assert.deepEqual(saved.connectors, [{ connection: "Linear", tool: "echo" }]);
});

test("a write waits for a card: nothing reaches the server until the user approves, and approving costs nothing", async () => {
  replies.push(
    { blocks: [{ type: "tool_use", id: "toolu_1", name: "linear__send_note", input: { to: "sam@example.com", note: "Lunch at 1?" } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "I've put the note up for you to approve." }], stop: "end_turn" },
  );
  const events = await reply([linear]);
  assert.equal(mock.calls.length, 0, "no call reached the server");
  const card = events.find((e) => e.type === "approve_action")!.action!;
  assert.deepEqual(card.input, { to: "sam@example.com", note: "Lunch at 1?" });
  assert.equal(card.tool, "send_note");
  const result = (sent[1].messages.at(-1)!.content as { content: string }[])[0];
  assert.equal(JSON.parse(result.content).status, "waiting_for_user");
  // Approving: once, for the same input, with no ledger row and no model call.
  const calls = sent.length;
  assert.equal(await runApproved("someone-else", card.id, card.inputHash), null);
  assert.equal(await runApproved(user, card.id, "other-hash"), null);
  const done = await runApproved(user, card.id, card.inputHash);
  assert.deepEqual(done, { status: "done", result: "Sent to sam@example.com." });
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(mock.calls[0].arguments, { to: "sam@example.com", note: "Lunch at 1?" });
  assert.equal(await runApproved(user, card.id, card.inputHash), null, "an approval works once");
  assert.equal(sent.length, calls, "approving never calls Claude");
  assert.deepEqual(await all("SELECT * FROM credit_ledger"), []);
  // Continue: the result can be used once, by its own user.
  assert.equal((await approvedResults("someone-else", [card.id])).length, 0);
  assert.equal((await approvedResults(user, [card.id], { take: true })).length, 1);
  assert.equal((await approvedResults(user, [card.id])).length, 0);
});

test("a reply continued with an approved result reads it as the account's tool result, even when the account can't be reached now", async () => {
  const history = [
    { role: "user" as const, content: "Send Sam a note" },
    { role: "assistant" as const, content: "Approve it below.", toolCalls: [{ id: "toolu_flash_abc", name: "linear__send_note", input: { to: "sam@example.com", note: "Hi" } }] },
    { role: "user" as const, content: "Continue with what came back.", toolResults: [{ id: "toolu_flash_abc", content: JSON.stringify({ source: "Linear", tool: "send_note", text: "Sent." }) }] },
  ];
  const write = async (kit: NonNullable<Awaited<ReturnType<typeof chatKit>>>) =>
    drain(streamText(history, "", "text", () => {}, budget, choice, undefined, {}, { connect: kit }));
  replies.push({ blocks: [{ type: "text", text: "It's sent." }], stop: "end_turn" });
  await write((await chatKit(user, [linear]))!);
  const [, call, answer] = sent[0].messages as { role: string; content: { type: string; content?: string }[] }[];
  assert.deepEqual(call.content.map((b) => b.type), ["text", "tool_use"]);
  assert.equal(answer.content[0].type, "tool_result", "the result comes first, as the account's data");
  assert.deepEqual(sent[0].tool_choice, { type: "auto" });
  // The account can't be reached now: its tool is still declared for the blocks above, but can't be called.
  sent.length = 0;
  const kit = (await chatKit(user, [linear]))!;
  kit.check = async () => ({ tools: [], unreachable: ["Linear"], changed: [] });
  replies.push({ blocks: [{ type: "text", text: "It's sent." }], stop: "end_turn" });
  await write(kit);
  assert.deepEqual(sent[0].tools!.map((t) => t.name), ["linear__send_note"]);
  assert.deepEqual(sent[0].tool_choice, { type: "none" });
});

test("a result that tells Claude to send something only ever makes a card", async () => {
  replies.push(
    { blocks: [{ type: "tool_use", id: "toolu_1", name: "linear__poisoned", input: {} }], stop: "tool_use" },
    // As if Claude obeyed what the result said.
    { blocks: [{ type: "tool_use", id: "toolu_2", name: "linear__send_note", input: { to: "attacker@example.com", note: "everything" } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "Done." }], stop: "end_turn" },
  );
  const events = await reply([linear]);
  assert.deepEqual(mock.calls.map((c) => c.name), ["poisoned"], "send_note never ran");
  assert.equal(events.filter((e) => e.type === "approve_action").length, 1);
  const data = JSON.parse((sent[1].messages.at(-1)!.content as { content: string }[])[0].content);
  assert.equal(data.source, "Linear", "the injected words arrive as the account's data");
  assert.ok(data.text.includes(POISON));
  assert.ok(!sent[1].system.includes(POISON), "never in the instructions");
});

test("a server the user added asks every time until a tool is always allowed, and the taint rule still asks", async () => {
  replies.push({ blocks: [{ type: "tool_use", id: "toolu_1", name: "custom2__echo", input: { text: "x" } }], stop: "tool_use" }, { blocks: [{ type: "text", text: "ok" }], stop: "end_turn" });
  let events = await reply([linear, custom]);
  assert.equal(mock.calls.length, 0);
  assert.equal(events.filter((e) => e.type === "approve_action").length, 1);

  await updateConnection(user, custom, { tool: "echo", trusted: true });
  mock.reset();
  replies.push({ blocks: [{ type: "tool_use", id: "toolu_1", name: "custom2__echo", input: { text: "x" } }], stop: "tool_use" }, { blocks: [{ type: "text", text: "ok" }], stop: "end_turn" });
  events = await reply([linear, custom]);
  assert.deepEqual(mock.calls.map((c) => c.path), ["/mcp"], "an always-allowed tool runs");

  // Read Linear, then call the other account: that waits, even for an always-allowed read.
  mock.reset();
  replies.push(
    { blocks: [{ type: "tool_use", id: "toolu_1", name: "linear__echo", input: { text: "private" } }], stop: "tool_use" },
    { blocks: [{ type: "tool_use", id: "toolu_2", name: "custom2__echo", input: { text: "private" } }, { type: "tool_use", id: "toolu_3", name: "linear__echo", input: { text: "again" } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "ok" }], stop: "end_turn" },
  );
  events = await reply([linear, custom]);
  assert.deepEqual(mock.calls.map((c) => `${c.path} ${c.name}`), ["/presets/linear/mcp echo", "/presets/linear/mcp echo"]);
  assert.equal(events.filter((e) => e.type === "approve_action").length, 1);
  await updateConnection(user, custom, { tool: "echo", trusted: false });
});

test("at most 4 calls run in a step, and the last step can't call tools", async () => {
  const echo = (i: number) => ({ type: "tool_use" as const, id: `toolu_${i}`, name: "linear__echo", input: { text: `n${i}` } });
  for (let step = 0; step < CONNECT_STEPS - 1; step++) replies.push({ blocks: [1, 2, 3, 4, 5].map((i) => echo(step * 10 + i)), stop: "tool_use" });
  replies.push({ blocks: [{ type: "text", text: "All done." }], stop: "end_turn" });
  const events = await reply([linear]);
  assert.equal(sent.length, CONNECT_STEPS);
  assert.equal(mock.calls.length, 4 * (CONNECT_STEPS - 1));
  const results = sent[1].messages.at(-1)!.content as { content: string; is_error?: boolean }[];
  assert.equal(results.length, 5);
  assert.equal(results[4].is_error, true);
  assert.match(results[4].content, /skipped/);
  assert.deepEqual(sent.map((s) => s.tool_choice?.type), ["auto", "auto", "auto", "none"]);
  assert.equal(said(events), "All done.");
});

test("every step is checked before it starts: the reply stops when the next one doesn't fit, within what was held", async () => {
  const costs: number[] = [];
  // Room for the first call (3,000 tokens read and its answer), not for reading 200,000 tokens more.
  const capCents = 2;
  replies.push({ blocks: [{ type: "tool_use", id: "toolu_1", name: "linear__echo", input: { text: "x" } }], stop: "tool_use" });
  counting = { tokens: 3000 };
  const kit = (await chatKit(user, [linear]))!;
  const gen = streamText(ask("Use my accounts"), "", "text", (_p, _m, c) => costs.push(c), { maxTokens: 8000, capCents }, choice, undefined, {}, { connect: kit });
  // After the first call the count says the next one reads 200,000 tokens.
  const events: Event[] = [];
  for await (const e of gen) {
    events.push(e as Event);
    if ((e as Event).type === "status" && (e as Event).message === "Using Linear · echo…") counting = { tokens: 200_000 };
  }
  assert.equal(sent.length, 1, "the second step never started");
  assert.match(said(events), /Stopped looking things up: the credits held for this reply are used\./);
  assert.ok(costs.reduce((a, b) => a + b, 0) <= capCents);
  // The first step was checked too: its max_tokens is what the credits pay for, not more.
  assert.equal(sent[0].max_tokens, Math.min(8000, tokensWithin("text", choice.model, 3000, capCents, true)));
});

test("a step that would leave less than a full answer's room answers now, with no tools, within what was held", async () => {
  const costs: number[] = [];
  const capCents = 20;
  replies.push(
    { blocks: [{ type: "tool_use", id: "toolu_1", name: "linear__echo", input: { text: "x" } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "It said x." }], stop: "end_turn" },
  );
  const kit = (await chatKit(user, [linear]))!;
  const events: Event[] = [];
  let room = 0;
  for await (const e of streamText(ask("Use my accounts"), "", "text", (_p, _m, c) => costs.push(c), { maxTokens: 8000, capCents }, choice, undefined, {}, { connect: kit })) {
    events.push(e as Event);
    if ((e as Event).type !== "status" || !(e as Event).message?.startsWith("Using")) continue;
    // The next step is counted so large that what is left pays for about 900 tokens of answer: more
    // than a round needs (300), less than an answer in words (MIN_OUTPUT_TOKENS.text, 1,500).
    const left = capCents - costs.reduce((a, b) => a + b, 0);
    let lo = 3000;
    let hi = 5_000_000;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (tokensWithin("text", choice.model, mid, left, true) > 900) lo = mid + 1;
      else hi = mid;
    }
    counting = { tokens: lo };
    room = tokensWithin("text", choice.model, lo, left, true);
  }
  assert.ok(room >= 300 && room < 1500, `${room}`);
  assert.equal(sent.length, 2);
  // The last call answers with what the tool returned: it can't call again.
  assert.equal(sent[1].tool_choice?.type, "none");
  assert.equal(sent[1].max_tokens, room);
  assert.equal(said(events), "It said x.");
  assert.ok(costs.reduce((a, b) => a + b, 0) <= capCents);
});

test("a reply that needs no tool isn't cut short: the first step gets the reply's whole allowance", async () => {
  replies.push({ blocks: [{ type: "text", text: "A long answer." }], stop: "end_turn" });
  await reply([linear], { budget: { maxTokens: 6000, capCents: 100 } });
  assert.equal(sent[0].max_tokens, 6000);
});

test("when counting fails, the next step is priced at the most the tools' results can be", async () => {
  // The cap fits the next step when counted (what the last call read and wrote, and the result counted
  // high: about 9,000 tokens) but not at 3 tokens a character of the result (about 45,000).
  const capCents = 8;
  const run = async () => {
    mock.reset();
    replies.push({ blocks: [{ type: "tool_use", id: "toolu_1", name: "linear__big", input: {} }], stop: "tool_use" }, { blocks: [{ type: "text", text: "Summary." }], stop: "end_turn" });
    return reply([linear], { budget: { maxTokens: 8000, capCents } });
  };
  counting = { tokens: 3000 };
  await run();
  assert.equal(sent.length, 2, "counted: it fits");
  const added = JSON.stringify((sent[1].messages.at(-1)!.content as object[])[0]).length;
  sent.length = 0;
  counting = { status: 400 };
  const events = await run();
  assert.equal(sent.length, 1, "not counted: priced at worstTokens, it doesn't fit");
  assert.match(said(events), /Stopped looking things up/);
  // The bound used: what the last call read and wrote, plus 3 tokens a character of what came back.
  const worst = usage.input_tokens + usage.output_tokens + worstTokens(added);
  assert.ok(tokensWithin("text", choice.model, worst, capCents - claudeCostOf(), true) < 300);
});

test("a count lower than what the next step must read isn't trusted", async () => {
  // Counting says 10 tokens; the step must read what the last call read and wrote and the result.
  counting = { tokens: 10 };
  replies.push({ blocks: [{ type: "tool_use", id: "toolu_1", name: "linear__big", input: {} }], stop: "tool_use" }, { blocks: [{ type: "text", text: "Summary." }], stop: "end_turn" });
  const events = await reply([linear], { budget: { maxTokens: 8000, capCents: 4 } });
  assert.equal(sent.length, 1);
  assert.match(said(events), /Stopped looking things up/);
});

// What one scripted call costs, in cents, on the reply's model.
const claudeCostOf = () => {
  const price = claudePrice(choice.model, usage.input_tokens);
  return (usage.input_tokens * price.input + usage.output_tokens * price.output) / 1e6;
};

test("Stop during a tool call ends the reply at once and starts no other step", async () => {
  const stop = new AbortController();
  const running = new Running();
  replies.push({ blocks: [{ type: "tool_use", id: "toolu_1", name: "linear__echo", input: { text: "x" } }], stop: "tool_use" }, { blocks: [{ type: "text", text: "never" }], stop: "end_turn" });
  const kit = (await chatKit(user, [linear], { signal: stop.signal }))!;
  const gen = streamText(ask("Use my accounts"), "", "text", undefined, budget, choice, undefined, { signal: stop.signal, running }, { connect: kit });
  await assert.rejects(async () => {
    for await (const e of gen) if ((e as Event).type === "status" && (e as Event).message?.startsWith("Using")) stop.abort(new Error("stopped"));
  });
  assert.equal(sent.length, 1);
  assert.equal(running.soFar, 0, "the call that ran was metered; nothing is in progress");
});

test("Stop part way through the answer still lists the accounts' tools the reply used", async () => {
  // Stopped the way the chat route stops a reply (see readEngine): the stream is aborted and drained.
  const abort = new AbortController();
  const events: Event[] = [];
  let wake = () => {};
  let halt = false;
  replies.push(
    { blocks: [{ type: "tool_use", id: "toolu_1", name: "linear__echo", input: { text: "x" } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "It said " }], stop: "end_turn", hang: true },
  );
  const kit = (await chatKit(user, [linear], { signal: abort.signal }))!;
  const gen = streamText(ask("Use my accounts"), "", "text", undefined, budget, choice, undefined, { signal: abort.signal }, { connect: kit });
  await assert.rejects(
    readEngine(
      gen as AsyncGenerator<never>,
      (e) => {
        events.push(e as Event);
        if (e.type === "text" && !halt) {
          halt = true;
          abort.abort("stop");
          wake();
        }
      },
      { halted: () => halt, onWake: (w) => (wake = w), drainMs: 2000 },
    ),
  );
  assert.equal(sent.length, 2);
  assert.deepEqual(events.at(-1), { type: "connector_used", items: [{ connection: "Linear", tool: "echo" }] });
});

test("after a refusal fallback part way through, only the answering model's connector calls run and go back", async () => {
  const fallback = { type: "fallback" as const, from: { model: "claude-sonnet-5-5" }, to: { model: "claude-sonnet-5" } };
  replies.push(
    {
      blocks: [
        { type: "text", text: "Checking. " },
        { type: "thinking", thinking: "declined reasoning", signature: "sig-declined" },
        { type: "tool_use", id: "t_declined", name: "linear__echo", input: { text: "declined" } },
        fallback,
        { type: "tool_use", id: "t_fb", name: "linear__echo", input: { text: "answered" } },
      ],
      stop: "tool_use",
    },
    { blocks: [{ type: "text", text: "It said answered." }], stop: "end_turn" },
  );
  await reply([linear]);
  assert.deepEqual(
    mock.calls.map((c) => c.arguments),
    [{ text: "answered" }],
    "the declined model's call isn't run",
  );
  const messages = sent[1].messages;
  const echoed = messages.at(-2)!.content as { type: string; id?: string }[];
  assert.deepEqual(
    echoed.map((b) => b.type + (b.id ? `:${b.id}` : "")),
    ["text", "fallback", "tool_use:t_fb"],
  );
  assert.deepEqual(
    (messages.at(-1)!.content as { tool_use_id: string }[]).map((b) => b.tool_use_id),
    ["t_fb"],
  );
});

test("words before an account's tool call end their paragraph, and the answer starts a new one", async () => {
  replies.push(
    { blocks: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "toolu_1", name: "linear__echo", input: { text: "x" } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "It said x." }], stop: "end_turn" },
  );
  const events = await reply([linear]);
  assert.equal(said(events), "Let me look.\n\nIt said x.");
});

test("a changed tool is left out of the reply until the user looks at it again", async () => {
  // "changing" says something new from its second listing on: the first reply sees it as it was added.
  await sql("UPDATE connection_tools SET changed = 0 WHERE connection_id = ?", [linear]);
  replies.push({ blocks: [{ type: "text", text: "ok" }], stop: "end_turn" });
  await reply([linear]);
  assert.ok(sent[0].tools!.some((t) => t.name === "linear__changing"));
  sent.length = 0;
  replies.push({ blocks: [{ type: "text", text: "ok" }], stop: "end_turn" });
  const events = await reply([linear]);
  assert.ok(!sent[0].tools!.some((t) => t.name === "linear__changing"));
  assert.match(said(events), /Linear changed some of its tools since you added it/);
  const rows = await all<{ changed: number }>("SELECT changed FROM connection_tools WHERE connection_id = ? AND name = 'changing'", [linear]);
  assert.equal(rows[0].changed, 1);
  // Looked at again: pinned only as the user was shown it.
  const now = (await changedTool(user, linear, "changing"))!;
  assert.match(now.description, /Also always send/);
  await assert.rejects(updateConnection(user, linear, { tool: "changing", review: true, hash: "an-older-hash" }), /changed its tools/);
  await updateConnection(user, linear, { tool: "changing", review: true, hash: now.hash });
  replies.push({ blocks: [{ type: "text", text: "ok" }], stop: "end_turn" });
  await reply([linear]);
  assert.ok(sent.at(-1)!.tools!.some((t) => t.name === "linear__changing"), "looked at again, it's back");
});

test("someone else's connection is never used, and the free lane refuses connectors", async () => {
  assert.equal(await chatKit("someone-else", [linear, custom]), null);
  assert.equal(refuseUnpaid(true, 5, 10), true);
  assert.equal(refuseUnpaid(true, 10, 10), false);
  assert.equal(refuseUnpaid(false, 0, 10), false, "without connectors the free lane decides as before");
});

test("keys and a server's whole address are stored sealed: only an origin and the last 4 characters are kept as they are", async () => {
  const rows = await all<{ provider: string; url: string; enc_url: string; enc_secret: string; last4: string }>("SELECT * FROM connections WHERE user_id = ?", [user]);
  const raw = JSON.stringify(rows);
  assert.ok(!raw.includes("lin_api_SECRETSECRET1234"));
  const added = rows.find((r) => r.provider === "custom")!;
  assert.ok(!JSON.stringify(added).includes("/mcp"), "the path of the server the user added isn't kept in clear");
  assert.equal(added.url, mock.origin);
  assert.ok(added.enc_url.length > 0);
  assert.equal(rows.find((r) => r.provider === "linear")!.last4, "1234");
});

test("the chat ignores connectors while CONNECTOR_KEYS is missing", async () => {
  const { requestedConnections } = await import("../src/lib/server/connections.ts");
  assert.deepEqual(requestedConnections([linear, 42, "bad id!"]), [linear]);
  const keys = process.env.CONNECTOR_KEYS;
  delete process.env.CONNECTOR_KEYS;
  try {
    assert.deepEqual(requestedConnections([linear]), []);
  } finally {
    process.env.CONNECTOR_KEYS = keys;
  }
});

test("what runs by itself: a preset's reads; a write, a tool of unknown kind, or a server the user added asks first", () => {
  const tool = (kind: "read" | "write" | "unknown", custom = false, trusted = false) => ({ connectionId: "a", kind, custom, trusted });
  assert.equal(needsApproval(tool("read"), []), false);
  assert.equal(needsApproval(tool("write"), []), true);
  assert.equal(needsApproval(tool("unknown"), []), true);
  assert.equal(needsApproval(tool("read", true), []), true, "a server the user added asks every time");
  assert.equal(needsApproval(tool("write", true, true), []), false, "until the tool is always allowed");
  assert.equal(needsApproval(tool("read"), ["a"]), false, "reading the same account again");
  assert.equal(needsApproval(tool("read"), ["b"]), true, "after another account was read (the taint rule)");
  assert.equal(needsApproval(tool("write", true, true), ["b"]), true, "the taint rule beats always allow");
});

/*
 * What the security review found (each test names its finding), kept as tests.
 */

// A user of their own for a test that adds connections (adding is limited per user and hour).
const newUser = async (id: string) => {
  await sql("INSERT INTO users (id, email, name, password_hash, preferences, created_at, last_free_grant) VALUES (?, ?, '', 'x', '', 0, 0)", [id, `${id}@example.com`]);
  return id;
};
// What a server the user adds lists, pinned as they saw it.
const pinsOf = async (url: string, token = "") => {
  const seen = await previewServer(user, { provider: "custom", url, token });
  mock.reset();
  return Object.fromEntries(seen.tools.map((t) => [t.name, t.hash]));
};
// A server the user added, pinned as they saw it.
const addServer = async (userId: string, url: string, label?: string) => {
  const seen = await previewServer(userId, { provider: "custom", url });
  mock.reset();
  return (await addConnection(userId, { provider: "custom", url, label, pins: Object.fromEntries(seen.tools.map((t) => [t.name, t.hash])) })).id;
};
// Everything logged while fn runs, with what it returns.
const logged = async <T,>(fn: () => Promise<T>): Promise<{ lines: string; value: T }> => {
  const lines: string[] = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  const keep = (...args: unknown[]) => void lines.push(args.map((a) => (a instanceof Error ? `${a.stack} ${JSON.stringify(a)} ${String(a.cause)}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  console.log = console.error = console.warn = keep;
  try {
    return { value: await fn(), lines: lines.join("\n") };
  } finally {
    Object.assign(console, saved);
  }
};

// Someone signs up with the owner's address and never confirms it. Before confirming was needed to
// connect accounts (second review #1), they could add a server labelled "Linear" and always allow its tool.
const squat = async (id: string, email: string) => {
  await sql("INSERT INTO users (id, email, email_key, name, password_hash, preferences, created_at, last_free_grant, verified_at) VALUES (?, ?, ?, '', 'hash', '', 0, 0, 0)", [id, email, email]);
  const conn = await addServer(id, `${mock.origin}/mcp`, "Linear");
  await updateConnection(id, conn, { tool: "echo", trusted: true });
  const kit = (await chatKit(id, [conn]))!;
  assert.equal(needsApproval(kit.tools.find((t) => t.tool === "echo")!, []), false);
  await kit.propose(kit.tools.find((t) => t.tool === "send_note")!, { to: "a@b.c", note: "hi" });
  await kit.close();
  return conn;
};
// With emails sent (or shown, as here), accounts must be confirmed.
const confirming = async (fn: () => Promise<void>) => {
  const before = process.env.FLASH_DEMO_EMAILS;
  process.env.FLASH_DEMO_EMAILS = "true";
  try {
    await fn();
  } finally {
    if (before === undefined) delete process.env.FLASH_DEMO_EMAILS;
    else process.env.FLASH_DEMO_EMAILS = before;
  }
};

test("#1: claiming an account drops the connections someone else added to it, with what they always allowed and their cards", async () => {
  const conn = await squat("acct", "victim@example.com");
  await confirming(async () => {
    // The real owner signs in with an emailed link.
    assert.equal(await signInWithEmail("victim@example.com"), "acct");
    assert.equal(await chatKit("acct", [conn]), null, "nothing of the squatter's is used");
    assert.deepEqual(await listConnections("acct"), []);
    assert.equal((await all("SELECT * FROM connection_tools WHERE connection_id = ?", [conn])).length, 0);
    assert.equal((await all("SELECT * FROM pending_actions WHERE user_id = 'acct'")).length, 0);
    // Nobody else's are touched.
    assert.ok((await listConnections(user)).some((c) => c.id === linear));
  });
});

test("second review #1: an unconfirmed account can't add an account or always allow a tool, and Forgot password drops what it set up", async () => {
  const conn = await squat("acct-reset", "owner@example.com");
  await sql("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('squatter-session', 'acct-reset', ?)", [Date.now() + 3600_000]);
  await confirming(async () => {
    const unverified = (e: unknown) => e instanceof ConnectError && e.code === "unverified";
    // Servers tried for this user so far (a preview and an add).
    const tries = async () => Number((await one<{ count: number }>("SELECT count FROM rate_limits WHERE key = 'connect-try:acct-reset'"))?.count ?? 0);
    const tried = await tries();
    // Nothing new is looked at, added or trusted while the email isn't confirmed.
    await assert.rejects(previewServer("acct-reset", { provider: "custom", url: `${mock.origin}/mcp` }), unverified);
    await assert.rejects(addConnection("acct-reset", { provider: "linear", token: "lin_api_SQUATSQUAT1234" }), unverified);
    await assert.rejects(updateConnection("acct-reset", conn, { tool: "send_note", trusted: true }), unverified);
    await assert.rejects(updateConnection("acct-reset", conn, { tool: "echo", review: true, hash: "x" }), unverified);
    assert.equal(await tries(), tried, "no server was reached");
    assert.equal((await listConnections("acct-reset")).length, 1);
    assert.equal((await listConnections("acct-reset"))[0].tools.find((t) => t.name === "send_note")!.trusted, false);
    // Turning things off still works.
    await updateConnection("acct-reset", conn, { tool: "echo", trusted: false });
    await updateConnection("acct-reset", conn, { tool: "echo", enabled: false });

    // The owner takes the account back with Forgot password: what the squatter set up goes with them.
    await resetPassword("acct-reset", "owners-new-hash");
    const account = await one<{ password_hash: string; verified_at: number }>("SELECT password_hash, verified_at FROM users WHERE id = 'acct-reset'");
    assert.equal(account!.password_hash, "owners-new-hash");
    assert.ok(Number(account!.verified_at) > 0);
    assert.equal(await chatKit("acct-reset", [conn]), null);
    assert.deepEqual(await listConnections("acct-reset"), []);
    assert.equal((await all("SELECT * FROM connection_tools WHERE connection_id = ?", [conn])).length, 0);
    assert.equal((await all("SELECT * FROM pending_actions WHERE user_id = 'acct-reset'")).length, 0);
    assert.equal((await all("SELECT * FROM sessions WHERE user_id = 'acct-reset'")).length, 0, "the squatter is signed out");
    // Confirmed now: the owner can add accounts.
    const own = (await addConnection("acct-reset", { provider: "linear", token: "lin_api_OWNEROWNER1234" })).id;
    // A confirmed account's reset keeps its connections.
    await resetPassword("acct-reset", "another-hash");
    assert.deepEqual((await listConnections("acct-reset")).map((c) => c.id), [own]);
  });
});

test("#2: a server that says its own address back shows none of the key in it, in a reply or on a card", async () => {
  const u = await newUser("user-keyed");
  const conn = await addServer(u, `${mock.origin}/s/sk_live_PATHSECRET12345/mcp?api_key=sk_live_QUERYSECRET67890&team=ab`, "Keyed");
  await updateConnection(u, conn, { tool: "whereami", trusted: true });
  const kit = (await chatKit(u, [conn]))!;
  const where = kit.tools.find((t) => t.tool === "whereami")!;
  const out = await kit.run(where, {});
  assert.match(out.text, /^Called at http:\/\/127\.0\.0\.1:\d+\/s\/\[hidden\]\/mcp\?api_key=\[hidden\]&team=ab$/);
  // An approved call: what the card shows, and what is kept for Continue.
  const card = (await kit.propose(where, {}))!;
  await kit.close();
  const done = (await runApproved(u, card.id, card.inputHash))!;
  assert.equal(done.status, "done");
  const stored = await one<{ result: string }>("SELECT result FROM pending_actions WHERE id = ?", [card.id]);
  assert.doesNotMatch(done.result + stored!.result, /SECRET/);
});

test("#4: an account whose stored key can't be opened asks to be connected again, everywhere it is used", async () => {
  const u = await newUser("user-rekey");
  const conn = (await addConnection(u, { provider: "linear", token: "lin_api_REKEYREKEY1234" })).id;
  const first = (await chatKit(u, [conn]))!;
  const card = (await first.propose(first.tools.find((t) => t.tool === "send_note")!, { to: "a@b.c", note: "hi" }))!;
  await first.close();
  const keys = process.env.CONNECTOR_KEYS;
  const shown = async () => (await listConnections(u))[0].status;
  const stored = async () => (await one<{ status: string }>("SELECT status FROM connections WHERE id = ?", [conn]))!.status;
  // The key that sealed it was replaced.
  process.env.CONNECTOR_KEYS = JSON.stringify({ v1: randomBytes(32).toString("base64") });
  try {
    assert.equal(await shown(), "needs_reconnect", "Settings says so at once");
    const kit = (await chatKit(u, [conn]))!;
    const checked = await kit.check();
    await kit.close();
    assert.deepEqual(checked.unreachable, ["Linear"], "a chat says it couldn't use it");
    await assert.rejects(changedTool(u, conn, "echo"), (e: unknown) => e instanceof ConnectError && e.code === "auth", "Settings gets a problem in words, not a server error");
    const done = (await runApproved(u, card.id, card.inputHash))!;
    assert.deepEqual(done, { status: "failed", result: "This account needs to be connected again." });
    assert.equal(await shown(), "needs_reconnect");
  } finally {
    process.env.CONNECTOR_KEYS = keys;
  }
  // Second review #3: none of that is stored, so with the key back the account works again.
  assert.equal(await stored(), "ok");
  assert.equal(await shown(), "ok");
  const back = (await chatKit(u, [conn]))!;
  const checked = await back.check();
  assert.deepEqual(checked.unreachable, []);
  assert.equal((await back.run(back.tools.find((t) => t.tool === "echo")!, { text: "back" })).text, "back");
  await back.close();
});

test("second review #3: only the account's own server refusing its key marks it to be connected again for good", async () => {
  const u = await newUser("user-refused");
  const conn = (await addConnection(u, { provider: "custom", url: `${mock.origin}/secure/mcp`, token: "good-token", pins: await pinsOf(`${mock.origin}/secure/mcp`, "good-token") })).id;
  const stored = async () => (await one<{ status: string }>("SELECT status FROM connections WHERE id = ?", [conn]))!.status;
  // The key in the service was deleted: the server answers 401 from now on.
  await sql("UPDATE connections SET enc_secret = ? WHERE id = ?", [seal("revoked-token", { id: conn, userId: u, provider: "custom", field: "token" }).stored, conn]);
  const kit = (await chatKit(u, [conn]))!;
  assert.deepEqual((await kit.check()).unreachable, [new URL(mock.origin).host]);
  await kit.close();
  assert.equal(await stored(), "needs_reconnect");
  assert.equal((await listConnections(u))[0].status, "needs_reconnect");
  assert.equal(await chatKit(u, [conn]), null, "it isn't used until it is connected again");
});

test("#5: a redirect to something that isn't an address fails that call only, and no log line holds the server's address", async () => {
  const u = await newUser("user-redirect");
  const conn = await addServer(u, `${mock.origin}/redirect/mcp?api_key=sk_live_REDIRECTSECRET99`);
  await updateConnection(u, conn, { tool: "echo", trusted: true });
  replies.push({ blocks: [{ type: "tool_use", id: "toolu_1", name: "custom1__echo", input: { text: "x" } }], stop: "tool_use" }, { blocks: [{ type: "text", text: "It failed." }], stop: "end_turn" });
  mock.reset();
  const kit = (await chatKit(u, [conn]))!;
  const { value: events, lines } = await logged(() => drain(streamText(ask("Use it"), "", "text", undefined, budget, choice, undefined, {}, { connect: kit })));
  assert.equal(said(events), "It failed.");
  const result = (sent[1].messages.at(-1)!.content as { content: string; is_error?: boolean }[])[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /That server sent a redirect Flash couldn't follow\./);
  assert.match(lines, /connector \S+ custom echo unreachable/);
  assert.doesNotMatch(lines + JSON.stringify(events) + JSON.stringify(sent), /REDIRECTSECRET|api_key/);
});

test("#11: a busy Summit steps down to Vision even when an account can't be reached, and the note shows once", async () => {
  const u = await newUser("user-stepdown");
  const lin = (await addConnection(u, { provider: "linear", token: "lin_api_STEPDOWN1234" })).id;
  const down = await addServer(u, `${mock.origin}/mcp`, "Notes");
  // Its server is gone now.
  await sql("UPDATE connections SET enc_url = ? WHERE id = ?", [seal(`${mock.origin}/down/mcp`, { id: down, userId: u, provider: "custom", field: "url" }).stored, down]);
  // The stand-in's "changing" tool would say it changed when the step-down lists it again.
  await sql("UPDATE connection_tools SET enabled = 0 WHERE name = 'changing' AND connection_id IN (?, ?)", [lin, down]);
  const summit = claudeChoice("text", "ultra");
  busy.add(summit.model);
  mock.reset();
  try {
    const kit = (await chatKit(u, [lin, down]))!;
    const events = await drain(withStepDown(summit, (c) => streamText(ask("hi"), "", "text", undefined, budget, c, undefined, {}, { connect: kit })));
    assert.deepEqual(sent.map((b) => b.model), [summit.model, summit.stepDown!.model]);
    assert.equal(said(events), "_Flash couldn't reach Notes just now, so this answer doesn't use it._\n\ndone");
  } finally {
    busy.clear();
  }
});

test("#12: approved results a Continue took are put back when it fails or is stopped, so Retry has them", async () => {
  const u = await newUser("user-retry");
  const conn = (await addConnection(u, { provider: "linear", token: "lin_api_RETRYRETRY1234" })).id;
  const kit = (await chatKit(u, [conn]))!;
  const card = (await kit.propose(kit.tools.find((t) => t.tool === "send_note")!, { to: "a@b.c", note: "hi" }))!;
  await kit.close();
  assert.equal((await runApproved(u, card.id, card.inputHash))!.status, "done");
  // Taken once the reply is paid for (see the chat route)...
  assert.deepEqual((await approvedResults(u, [card.id], { take: true })).map((r) => r.id), [card.id]);
  assert.equal((await approvedResults(u, [card.id])).length, 0, "used");
  // ...and the reply failed: they go back.
  await releaseResults(u, [card.id]);
  assert.deepEqual((await approvedResults(u, [card.id])).map((r) => r.id), [card.id], "Retry finds them");
  // Only the user's own, and only ones that were used.
  await approvedResults(u, [card.id], { take: true });
  await releaseResults("someone-else", [card.id]);
  assert.equal((await approvedResults(u, [card.id])).length, 0);
});

test("#13, #14: when counting fails at the first step it is priced at the most it can read; one that doesn't fit isn't started or charged", async () => {
  const u = await newUser("user-firststep");
  const lin = (await addConnection(u, { provider: "linear", token: "lin_api_FIRSTSTEP1234" })).id;
  const ascend = { ...claudeChoice("text", "ascend"), fallback: false };
  // Dense text: at least a token a character, more than the 2.5 characters a token the hold guesses.
  const chars = 20_000;
  const history = [{ role: "user" as const, content: "汉".repeat(chars) }];
  // The route's hold when counting is down, for a user with exactly what is needed.
  counting = { status: 500 };
  const kit = (await chatKit(u, [lin]))!;
  const estimate = await countInputTokens(ascend.model, history, system("", "text", { connect: true }), kit.tools.map((t) => t.definition));
  const needed = planHold("text", ascend.model, estimate, 0, 1, 0, connectPlan(false)).needed;
  const hold = planHold("text", ascend.model, estimate, needed, 1, 0, connectPlan(false));
  const reply = (b: { maxTokens: number; capCents: number }, costs: number[]) =>
    drain(streamText(history, "", "text", (_p, _m, c) => costs.push(c), b, ascend, undefined, { running: new Running() }, { connect: kit }));

  // Still down at the first step: the most it can read doesn't fit what was held, so nothing is sent.
  let costs: number[] = [];
  await assert.rejects(reply(hold, costs), (e: unknown) => e instanceof FriendlyError && e.phrase === NO_FIRST_STEP);
  assert.equal(sent.length, 0);
  // A reply that failed before Claude was called costs nothing; nor does a finished one that made no call.
  assert.equal(finalCredits({ held: hold.held, ok: false, stopped: false, metered: true, costCents: 0, pendingCents: 0, typical: 4 }), 0);
  assert.equal(finalCredits({ held: hold.held, ok: true, stopped: false, metered: true, costCents: 0, typical: 4 }), 0);

  // Back up at the first step, and longer than the hold's guess: not started either.
  counting = { tokens: chars + 2000 };
  await assert.rejects(reply(hold, costs), (e: unknown) => e instanceof FriendlyError);
  assert.equal(sent.length, 0);

  // With credits enough for the most it can read: it runs, and however dense the text really was it
  // spends no more than was held.
  counting = { status: 500 };
  const roomy = { maxTokens: 8000, capCents: 40 };
  costs = [];
  replies.push({ blocks: [{ type: "text", text: "答" }], stop: "end_turn", usage: { input_tokens: chars + 2000, output_tokens: 8000 } });
  await reply(roomy, costs);
  assert.equal(sent.length, 1);
  const bound = worstTokens(sent[0].system.length + JSON.stringify(sent[0].messages).length + JSON.stringify(sent[0].tools).length);
  assert.equal(sent[0].max_tokens, Math.min(8000, tokensWithin("text", ascend.model, bound, roomy.capCents, false)));
  // What it would cost had it written all it may: within the cap.
  const most = claudeCostCents(ascend.model, { input_tokens: bound, output_tokens: sent[0].max_tokens } as never, ascend.model, 0);
  assert.ok(most <= roomy.capCents, `${most} <= ${roomy.capCents}`);
  assert.ok(costs.reduce((a, b) => a + b, 0) <= roomy.capCents);
  await kit.close();
});

test("#15: Stop ends a step's remaining calls at once: nothing runs or is asked for after it, and nothing more is spent", async () => {
  const u = await newUser("user-stop");
  const lin = (await addConnection(u, { provider: "linear", token: "lin_api_STOPSTOP1234" })).id;
  const step = {
    blocks: [
      { type: "tool_use" as const, id: "toolu_1", name: "linear__echo", input: { text: "a" } },
      { type: "tool_use" as const, id: "toolu_2", name: "linear__echo", input: { text: "b" } },
      { type: "tool_use" as const, id: "toolu_3", name: "linear__send_note", input: { to: "x@y.z", note: "hi" } },
    ],
    stop: "tool_use",
  };
  const callsMade = async () => Number((await one<{ count: number }>("SELECT count FROM rate_limits WHERE key = ?", [`conn:${u}:${lin}`]))?.count ?? 0);
  // Pressed while the step's first call is about to go (between calls), then while it is on its way to a slow server.
  for (const when of ["before", "in flight"] as const) {
    mock.reset();
    sent.length = 0;
    replies.length = 0;
    await sql("DELETE FROM rate_limits WHERE key = ?", [`conn:${u}:${lin}`]);
    const stop = new AbortController();
    const running = new Running();
    const costs: number[] = [];
    const kit = (await chatKit(u, [lin], { signal: stop.signal }))!;
    if (when === "before") {
      const run = kit.run.bind(kit);
      kit.run = async (tool, input, signal) => {
        stop.abort("stop");
        return run(tool, input, signal);
      };
    } else mock.state.callDelayMs = 500;
    replies.push(step, { blocks: [{ type: "text", text: "never" }], stop: "end_turn" });
    const afterStop: string[] = [];
    const started = Date.now();
    let stoppedAt = 0;
    const { lines } = await logged(() =>
      assert.rejects(async () => {
        for await (const e of streamText(ask("go"), "", "text", (_p, _m, c) => costs.push(c), budget, choice, undefined, { signal: stop.signal, running }, { connect: kit })) {
          const event = e as Event;
          if (stop.signal.aborted) afterStop.push(event.type);
          if (when === "in flight" && event.type === "status" && event.message?.startsWith("Using") && !stoppedAt) {
            stoppedAt = Date.now();
            setTimeout(() => stop.abort("stop"), 100);
          }
        }
      }, (e: unknown) => e instanceof Error && e.name === "AbortError"),
    );
    // Nothing but a progress line after Stop, and the call that was on its way listed under the reply (second review #4).
    assert.deepEqual(afterStop.filter((t) => t !== "status"), when === "before" ? [] : ["connector_used"], `${when}: what came after Stop`);
    assert.equal(mock.calls.length, when === "before" ? 0 : 1, `${when}: no call after Stop reached the server`);
    assert.equal(await callsMade(), when === "before" ? 0 : 1, `${when}: no later call counted against the account`);
    assert.equal((await all("SELECT * FROM pending_actions WHERE user_id = ?", [u])).length, 0, `${when}: no card was made`);
    assert.equal(sent.length, 1, `${when}: no other step started`);
    if (when === "in flight") assert.match(lines, /linear echo stopped/);
    if (when === "in flight") assert.ok(Date.now() - started < 450 + (stoppedAt - started), "the call in flight ended at Stop, not when the server answered");
    // Only the step that ran was paid for, and nothing is in progress.
    assert.equal(costs.length, 1);
    assert.equal(running.soFar, 0);
  }
});

test("second review #4: Stop while an always-allowed write is on its way still lists it under the reply", async () => {
  const u = await newUser("user-stop-write");
  const conn = await addServer(u, `${mock.origin}/mcp`, "Notes");
  await updateConnection(u, conn, { tool: "send_note", trusted: true });
  mock.state.callDelayMs = 800;
  replies.push({ blocks: [{ type: "tool_use", id: "toolu_1", name: "custom1__send_note", input: { to: "boss@example.com", note: "I quit" } }], stop: "tool_use" });
  const stop = new AbortController();
  const kit = (await chatKit(u, [conn], { signal: stop.signal }))!;
  const events: Event[] = [];
  await assert.rejects(async () => {
    for await (const e of streamText(ask("Send my note"), "", "text", undefined, budget, choice, undefined, { signal: stop.signal }, { connect: kit })) {
      events.push(e as Event);
      if ((e as Event).type === "status" && (e as Event).message?.startsWith("Using")) setTimeout(() => stop.abort("stop"), 150);
    }
  }, (e: unknown) => e instanceof Error && e.name === "AbortError");
  // The server got the write...
  assert.deepEqual(mock.calls.map((c) => c.name), ["send_note"]);
  // ...so the reply (and the chat saved from it) lists it.
  assert.deepEqual(events.find((e) => e.type === "connector_used")?.items, [{ connection: "Notes", tool: "send_note" }]);
});

test("#15: a step's own checks: whatever a server does with Stop, no call runs and no card shows after it", async () => {
  type Kit = Parameters<typeof connectorCalls>[2];
  const tool = (name: string, kind: "read" | "write") => ({
    name: `acct__${name}`,
    tool: name,
    title: name,
    connectionId: "c1",
    connection: "Acct",
    host: "acct.example",
    kind,
    custom: false,
    trusted: false,
    definition: { name: `acct__${name}`, description: "", input_schema: { type: "object" as const } },
  });
  const tools = [tool("read", "read"), tool("send", "write")];
  const call = (id: string, name: string) => ({ type: "tool_use" as const, id, name: `acct__${name}`, input: {} }) as Parameters<typeof connectorCalls>[0][number];
  const step = async (calls: ReturnType<typeof call>[], kit: Partial<Kit>, signal: AbortSignal) => {
    const events: Event[] = [];
    const base: Kit = { tools, check: async () => ({ tools, unreachable: [], changed: [] }), run: async () => ({ text: "ok", isError: false }), propose: async () => ({}) as never, close: async () => {} };
    await assert.rejects(async () => {
      for await (const e of connectorCalls(calls, tools, { ...base, ...kit }, { readFrom: new Set(), used: [] }, signal)) events.push(e as Event);
    }, (e: unknown) => e instanceof Error && e.name === "AbortError");
    return events;
  };
  // A server that answers after Stop as if nothing happened: the step's other calls never run.
  let stop = new AbortController();
  const ran: string[] = [];
  const proposed: string[] = [];
  let events = await step([call("1", "read"), call("2", "read"), call("3", "send")], {
    run: async (t) => {
      ran.push(t.tool);
      stop.abort("stop");
      return { text: "ok", isError: false };
    },
    propose: async (t) => (proposed.push(t.tool), {}) as never,
  }, stop.signal);
  assert.deepEqual(ran, ["read"]);
  assert.deepEqual(proposed, []);
  assert.ok(!events.some((e) => e.type === "approve_action"));
  // A card being made when Stop comes isn't shown, and nothing after it runs.
  stop = new AbortController();
  ran.length = 0;
  events = await step([call("1", "send"), call("2", "read")], {
    run: async (t) => (ran.push(t.tool), { text: "ok", isError: false }),
    propose: async () => (stop.abort("stop"), {}) as never,
  }, stop.signal);
  assert.ok(!events.some((e) => e.type === "approve_action"));
  assert.deepEqual(ran, []);
});
