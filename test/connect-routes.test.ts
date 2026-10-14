import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { register } from "node:module";
import type { AddressInfo } from "node:net";

/*
 * Connectors through Flash's own routes (POST /api/chat, Settings > Connectors, Forgot password), with
 * a stand-in Claude and the stand-in MCP servers of scripts/mock-connectors.ts, for what only shows
 * there: who may add an account, what a reset drops, what Retry of a Continue sends and costs, and
 * what a stopped reply saves. Nothing here reaches a real service.
 */
register("./support/route-hooks.mjs", import.meta.url);

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: object };
const replies: { blocks: Block[]; stop: string }[] = [];
const sent: { model: string; messages: unknown[] }[] = [];
// Every model answers "overloaded" while this is set.
let busy = false;
// count_tokens answers "overloaded" while this is set.
let countDown = false;
const claude = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    if (req.url?.includes("count_tokens") && countDown) {
      res.writeHead(529, { "content-type": "application/json", "x-should-retry": "false" });
      return res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    }
    if (req.url?.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ input_tokens: 3000 }));
    }
    sent.push(body);
    if (busy) {
      res.writeHead(529, { "content-type": "application/json", "x-should-retry": "false" });
      return res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    }
    const reply = replies.shift() ?? { blocks: [{ type: "text", text: "done" }], stop: "end_turn" };
    const usage = { input_tokens: 3000, output_tokens: 200 };
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
delete process.env.RESEND_API_KEY;
delete process.env.FLASH_APP_URL;

const { startMockConnectors } = await import("../scripts/mock-connectors.ts");
const mock = await startMockConnectors(0);
process.env.FLASH_CONNECT_MOCK = mock.origin;
after(async () => {
  claude.closeAllConnections();
  claude.close();
  await mock.close();
});

const { afterwards } = await import("./support/next-server.mjs");
const { all, one, run: sql } = await import("../src/lib/server/db.ts");
const { addConnection, chatKit, previewServer, runApproved } = await import("../src/lib/server/connections.ts");
const { requestStop } = await import("../src/lib/server/stops.ts");
const chatRoute = await import("../src/app/api/chat/route.ts");
const connectRoute = await import("../src/app/api/connect/route.ts");
const connectIdRoute = await import("../src/app/api/connect/[id]/route.ts");
const signupRoute = await import("../src/app/api/auth/signup/route.ts");
const resetRequestRoute = await import("../src/app/api/auth/reset/request/route.ts");
const resetRoute = await import("../src/app/api/auth/reset/route.ts");

beforeEach(() => {
  replies.length = 0;
  sent.length = 0;
  busy = false;
  countDown = false;
  mock.reset();
});

const ORIGIN = "http://localhost";
const request = (method: string, path: string, body: object, cookie = "") =>
  new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", origin: ORIGIN, cookie }, body: JSON.stringify(body) });

/** A confirmed user with a session, exactly `credits` credits and a chat. */
async function account(id: string, credits: number) {
  const token = `tok_${id}_${randomBytes(6).toString("hex")}`;
  await sql("INSERT INTO users (id, email, name, password_hash, preferences, created_at, last_free_grant, verified_at) VALUES (?, ?, '', 'x', '', 0, 0, 1)", [id, `${id}@example.com`]);
  await sql("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [createHash("sha256").update(token).digest("hex"), id, Date.now() + 3600_000]);
  // This month's free credits count as given, so the balance is exactly what is set here.
  const d = new Date();
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, 'test', ?, 0)", [id, credits, `free:${id}:${month}`]);
  await sql("INSERT INTO projects (id, user_id, name, messages, updated_at) VALUES (?, ?, 'Notes', '[]', 0)", [`proj_${id}`, id]);
  return { id, cookie: `flash_session=${token}`, projectId: `proj_${id}` };
}
type Account = Awaited<ReturnType<typeof account>>;
const balance = async (id: string) => Number((await one<{ b: number }>("SELECT COALESCE(SUM(amount), 0) AS b FROM credit_ledger WHERE user_id = ?", [id]))!.b);
const savedMessages = async (projectId: string) =>
  JSON.parse((await one<{ messages: string }>("SELECT messages FROM projects WHERE id = ?", [projectId]))!.messages) as {
    id: string;
    role: string;
    continues?: string[];
    connectors?: unknown[];
    stopped?: boolean;
  }[];
/** What a server the user adds lists, pinned as they saw it. */
async function pins(userId: string) {
  const seen = await previewServer(userId, { provider: "custom", url: `${mock.origin}/mcp` });
  mock.reset();
  return Object.fromEntries(seen.tools.map((t) => [t.name, t.hash]));
}
let n = 0;
const newId = () => `m${Date.now().toString(36)}${n++}`;

type ChatEvent = { type: string; message?: string; items?: unknown[]; credits?: number };
/** A chat request as the page sends it, read to its end (onEvent may press Stop), with what it saved. */
async function chat(who: Account, body: Record<string, unknown>, onEvent?: (e: ChatEvent, replyId: string) => void) {
  const replyId = newId();
  const res = await chatRoute.POST(request("POST", "/api/chat", { projectId: who.projectId, replyId, engine: "text", level: "ascend", ...body }, who.cookie));
  const events: ChatEvent[] = [];
  if (!res.ok || !res.body) {
    await afterwards();
    return { status: res.status, error: ((await res.json()) as { error: string; code?: string }), events, replyId };
  }
  let buffer = "";
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter((l) => l.trim())) {
      const e = JSON.parse(line) as ChatEvent;
      events.push(e);
      onEvent?.(e, replyId);
    }
  }
  await afterwards();
  return { status: res.status, error: null, events, replyId };
}

test("second review #1: an unconfirmed account can't add accounts or always allow a tool, and Forgot password drops what it set up", async () => {
  process.env.FLASH_DEMO_EMAILS = "true";
  try {
    // Someone signs up with the owner's address and doesn't confirm it.
    const signup = await signupRoute.POST(request("POST", "/api/auth/signup", { email: "owner@example.com", password: "squatter-pass-1" }));
    assert.equal(signup.status, 200);
    const cookie = signup.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const { id } = (await one<{ id: string }>("SELECT id FROM users WHERE email = 'owner@example.com'"))!;
    for (const body of [
      { action: "preview", provider: "custom", url: `${mock.origin}/mcp` },
      { action: "add", provider: "linear", token: "lin_api_SQUATSQUAT1234" },
    ]) {
      const res = await connectRoute.POST(request("POST", "/api/connect", body, cookie));
      assert.equal(res.status, 403, body.action);
      assert.deepEqual(await res.json(), { error: "Confirm your email to connect accounts.", code: "unverified" });
    }
    assert.equal((await all("SELECT * FROM connections WHERE user_id = ?", [id])).length, 0);

    // One added before confirming was needed for it, with a tool always allowed then.
    delete process.env.FLASH_DEMO_EMAILS;
    const before = (await addConnection(id, { provider: "custom", url: `${mock.origin}/mcp`, label: "Linear", pins: await pins(id) })).id;
    process.env.FLASH_DEMO_EMAILS = "true";
    await sql("UPDATE connection_tools SET trusted = 1 WHERE connection_id = ? AND name = 'echo'", [before]);
    const patch = (body: object) => connectIdRoute.PATCH(request("PATCH", `/api/connect/${before}`, body, cookie), { params: Promise.resolve({ id: before }) } as never);
    const trust = await patch({ tool: "send_note", trusted: true });
    assert.equal(trust.status, 403);
    assert.equal(((await trust.json()) as { code: string }).code, "unverified");
    assert.equal((await patch({ tool: "echo", enabled: false })).status, 200, "turning a tool off still works");

    // The owner takes the account back with Forgot password: the squatter's account and tools go.
    const asked = await resetRequestRoute.POST(request("POST", "/api/auth/reset/request", { email: "owner@example.com" }));
    const { devLink } = (await asked.json()) as { devLink: string };
    const reset = await resetRoute.POST(request("POST", "/api/auth/reset", { token: new URL(devLink).searchParams.get("token"), password: "owners-own-pass" }));
    assert.equal(reset.status, 200);
    assert.equal((await all("SELECT * FROM connections WHERE user_id = ?", [id])).length, 0);
    assert.equal((await all("SELECT * FROM connection_tools WHERE connection_id = ?", [before])).length, 0);
    assert.equal(await chatKit(id, [before]), null);
    // Confirmed now, the owner adds their own.
    const owner = reset.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const added = await connectRoute.POST(request("POST", "/api/connect", { action: "add", provider: "linear", token: "lin_api_OWNEROWNER1234" }, owner));
    assert.equal(added.status, 200);
  } finally {
    delete process.env.FLASH_DEMO_EMAILS;
  }
});


test("second review #5: Retry of a failed Continue, after a reload, reads the approved results; one that can't read them isn't sent or charged", async () => {
  const who = await account("retry-user", 500);
  const linear = (await addConnection(who.id, { provider: "linear", token: "lin_api_RETRYRETRY1234" })).id;
  await sql("UPDATE connection_tools SET enabled = 0 WHERE name = 'changing'");
  // A card on the reply before, approved and done.
  const kit = (await chatKit(who.id, [linear], { replyId: "a0" }))!;
  const card = (await kit.propose(kit.tools.find((t) => t.tool === "send_note")!, { to: "a@b.c", note: "hi" }))!;
  await kit.close();
  assert.equal((await runApproved(who.id, card.id, card.inputHash))!.status, "done");
  const used = async () => Number((await one<{ used: number }>("SELECT used FROM pending_actions WHERE id = ?", [card.id]))!.used);
  const earlier = [
    { id: "u0", role: "user", content: "Send a note to a@b.c saying hi" },
    { id: "a0", role: "assistant", content: "Waiting for your approval." },
  ];
  await sql("UPDATE projects SET messages = ? WHERE id = ?", [JSON.stringify(earlier), who.projectId]);
  const messages = [...earlier.map(({ role, content }) => ({ role, content })), { role: "user", content: "Continue with what came back." }];
  // Continue, as the page sends it: the cards' ids on the message, and with the request.
  const userMessage = { id: newId(), role: "user", content: "Continue with what came back.", continues: [card.id] };

  // Claude is busy: the Continue fails, costs nothing, and its results go back.
  busy = true;
  const b0 = await balance(who.id);
  const failed = await chat(who, { messages, connectors: [linear], actions: [card.id], userMessage, afterId: "a0" });
  assert.ok(failed.events.some((e) => e.type === "error"));
  assert.equal(await balance(who.id), b0);
  assert.equal(await used(), 0);
  busy = false;

  // After a reload the page has only the saved chat: the Continue there still names its cards...
  const saved = (await savedMessages(who.projectId)).find((m) => m.id === userMessage.id)!;
  assert.deepEqual(saved.continues, [card.id]);
  // ...so Retry sends them, and Claude reads the approved result as the account's tool result.
  sent.length = 0;
  const retried = await chat(who, { messages, connectors: [linear], actions: saved.continues, userMessage: saved, afterId: "a0" });
  assert.equal(retried.status, 200);
  assert.match(JSON.stringify(sent[0].messages), /tool_result.*Sent to a@b\.c\./);
  const charged = b0 - (await balance(who.id));
  assert.ok(charged > 0);
  assert.equal(retried.events.find((e) => e.type === "cost")?.credits, charged, "what it showed is what it charged");
  assert.equal(await used(), 1);

  // Retry again: the results were used by that answer, so nothing is sent and nothing is charged.
  sent.length = 0;
  const again = await chat(who, { messages, connectors: [linear], actions: saved.continues, userMessage: saved, afterId: "a0" });
  assert.equal(again.status, 409);
  assert.equal(again.error?.code, "no_results");
  assert.match(again.error!.error, /nothing was sent and no credits were used/);
  // With the account turned off in the chat, the same.
  await sql("UPDATE pending_actions SET used = 0 WHERE id = ?", [card.id]);
  const off = await chat(who, { messages, actions: saved.continues, userMessage: saved, afterId: "a0" });
  assert.equal(off.status, 409);
  assert.equal(sent.length, 0, "Claude was never called");
  assert.equal(b0 - (await balance(who.id)), charged, "only the Retry that read them was paid for");
});

test("second review #4: a reply stopped while an always-allowed write is on its way saves it under the reply", async () => {
  const who = await account("stop-user", 500);
  const seen = await pins(who.id);
  const notes = (await addConnection(who.id, { provider: "custom", url: `${mock.origin}/mcp`, label: "Notes", pins: seen })).id;
  await sql("UPDATE connection_tools SET enabled = 0 WHERE name = 'changing'");
  await sql("UPDATE connection_tools SET trusted = 1 WHERE connection_id = ? AND name = 'send_note'", [notes]);
  mock.state.callDelayMs = 800;
  replies.push({ blocks: [{ type: "tool_use", id: "toolu_1", name: "custom1__send_note", input: { to: "boss@example.com", note: "I quit" } }], stop: "tool_use" });
  const userMessage = { id: newId(), role: "user", content: "Send my note" };
  let pressed = false;
  const r = await chat(who, { messages: [{ role: "user", content: userMessage.content }], connectors: [notes], userMessage, afterId: null }, (e, replyId) => {
    if (!pressed && e.type === "status" && e.message?.startsWith("Using")) {
      pressed = true;
      setTimeout(() => void requestStop(who.id, replyId), 150);
    }
  });
  assert.ok(pressed);
  assert.deepEqual(mock.calls.map((c) => c.name), ["send_note"], "the server got the write");
  assert.deepEqual(r.events.find((e) => e.type === "connector_used")?.items, [{ connection: "Notes", tool: "send_note" }]);
  const reply = (await savedMessages(who.projectId)).find((m) => m.id === r.replyId)!;
  assert.equal(reply.stopped, true);
  assert.deepEqual(reply.connectors, [{ connection: "Notes", tool: "send_note" }]);
});

test("a reply Anthropic can't count isn't sent or charged", async () => {
  const who = await account("uncounted", 500);
  countDown = true;
  const r = await chat(who, { messages: [{ role: "user", content: "ꀀ".repeat(5000) }] });
  assert.equal(r.status, 503);
  assert.equal(sent.length, 0, "nothing went to Claude");
  assert.equal(await balance(who.id), 500, "nothing was held or charged");
  countDown = false;
  const ok = await chat(who, { messages: [{ role: "user", content: "hello" }] });
  assert.equal(ok.status, 200);
});

/** A PNG of this size, as an attachment (only its header is read). */
const photo = (name: string, w = 64, h = 64) => {
  const b = Buffer.alloc(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return { name, mediaType: "image/png", data: b.toString("base64") };
};

test("photos sent to a picture edit are all priced and checked, or the request is refused", async () => {
  process.env.FAL_KEY = "fake";
  try {
    const who = await account("photos", 500);
    // A question about five photos, agreed to as a picture edit: Flash can't combine five, so nothing runs.
    const five = await chat(who, {
      engine: undefined,
      confirmed: true,
      decided: { engine: "image" },
      messages: [{ role: "user", content: "what is in these photos?", attachment: photo("a.png"), more: ["b", "c", "d", "e"].map((n) => photo(`${n}.png`)) }],
    });
    assert.equal(five.status, 400);
    // Four, one of them too big to edit: refused too, though only the first was checked before.
    const big = await chat(who, {
      engine: undefined,
      confirmed: true,
      decided: { engine: "image" },
      messages: [{ role: "user", content: "what is in these photos?", attachment: photo("a.png"), more: [photo("b.png", 8000, 8000), photo("c.png")] }],
    });
    assert.equal(big.status, 400);
    assert.equal(await balance(who.id), 500);
  } finally {
    delete process.env.FAL_KEY;
  }
});

test("someone who keeps getting the price question stops paid helpers deciding their requests", async () => {
  process.env.FAL_KEY = "fake";
  try {
    const who = await account("asker", 1000);
    const helperCalls = () => sent.filter((b) => (b as { model: string }).model.includes("haiku")).length;
    const ask = () => chat(who, { engine: undefined, messages: [{ role: "user", content: "animate this photo", attachment: photo("me.png") }] });
    for (let i = 0; i < 25; i++) {
      replies.push({ blocks: [{ type: "text", text: "edit" }], stop: "end_turn" });
      assert.equal((await ask()).status, 409);
    }
    assert.ok(helperCalls() <= 20, `the picture check ran ${helperCalls()} times`);
    assert.equal(await balance(who.id), 1000);
  } finally {
    delete process.env.FAL_KEY;
  }
});
