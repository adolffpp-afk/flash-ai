import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { assistantKit } from "./support/assistant-kit.ts";

/*
 * What someone else's assistant can't reach (src/app/api/chat/route.ts): its maker writes its
 * instructions and files, so in a visitor's chat with it the visitor's connected accounts, memory and
 * brand kit stay out, Research can't open pages, and a reply writes at most VISITOR_REPLY_TOKENS. What
 * the visitor is called and their language stay. In the owner's own chats, and in the visitor's chats
 * without it, everything is as before. Claude and the connected account are stand-ins.
 */
const kit = await assistantKit({ on: true });
process.env.CONNECTOR_KEYS = JSON.stringify({ v1: randomBytes(32).toString("base64") });
const { startMockConnectors } = await import("../scripts/mock-connectors.ts");
const mock = await startMockConnectors(0);
process.env.FLASH_CONNECT_MOCK = mock.origin;
after(async () => {
  await mock.close();
  await kit.close();
});
const { account, assistant, file, share, chatWith, chat, claudeSent, putProject, run, stand, PRICES } = kit;
const { addConnection } = await import("../src/lib/server/connections.ts");
const { NO_FETCH_LINE } = await import("../src/lib/engines/claude.ts");
const { VISITOR_REPLY_TOKENS } = await import("../src/lib/assistant-cost.ts");

beforeEach(async () => {
  stand.reset();
  mock.reset();
  await run("DELETE FROM rate_limits");
});

type Who = Awaited<ReturnType<typeof account>>;
/** A user with a memory, a name to be called, a brand kit and a connected account. */
async function withOwnThings(memory: string, nickname: string, business: string) {
  const who = await account(1000, { preferences: memory });
  await run("UPDATE users SET nickname = ? WHERE id = ?", [nickname, who.id]);
  await run("INSERT INTO brand_kits (user_id, name, tagline, voice, colors, updated_at) VALUES (?, ?, 'Fresh every day', 'Friendly', '[\"#123456\"]', 0)", [who.id, business]);
  const connection = (await addConnection(who.id, { provider: "linear", token: "lin_api_SECRETSECRET1234" })).id;
  return { ...who, connection };
}

async function setUp() {
  const owner = await withOwnThings("I'm the owner and bake on Sundays.", "Robin", "Golden Crumb Ltd");
  const visitor = await withOwnThings("I keep bees in Utrecht.", "Sam", "Sam's Honey Co");
  const id = await assistant(owner);
  await file(id, "Prices.txt", PRICES);
  await share(id, `safe${id.slice(0, 6)}`, visitor);
  return { owner, visitor, id, own: await chatWith(owner, id), theirs: await chatWith(visitor, id) };
}

const connectorTools = () => (claudeSent().at(-1)!.tools ?? []).filter((t) => t.name.includes("__"));
/** One reply in a chat, sent with the user's connected account on and a memory from the page. */
async function ask(who: Who & { connection: string }, chatId: string, body: Record<string, unknown> = {}) {
  stand.reset();
  mock.reset();
  const r = await chat(who, chatId, "What can you tell me?", { connectors: [who.connection], ...body });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return claudeSent().at(-1)!;
}

test("in someone else's assistant the visitor's connected accounts, memory and brand kit stay out; what they're called stays", async () => {
  const s = await setUp();
  const theirs = await ask(s.visitor, s.theirs, { assistantVersion: 3, preferences: "My PIN is 4321." });
  assert.deepEqual(connectorTools(), [], "no connected account");
  assert.deepEqual(mock.calls, [], "the account's server isn't reached");
  for (const secret of ["4321", "bees in Utrecht", "Sam's Honey Co", "brand kit", "lin_api"]) assert.ok(!JSON.stringify(theirs).includes(secret), secret);
  assert.ok(theirs.system.includes('Call the user "Sam"'), "what they're called stays");
  assert.ok(theirs.system.includes("Answer as Golden Crumb's baker."), "the assistant answers");
  // Their memory as saved, without one from the page: out too.
  assert.ok(!JSON.stringify(await ask(s.visitor, s.theirs, { assistantVersion: 3 })).includes("bees in Utrecht"));

  // The visitor's own chat: all of it, as before.
  const plain = await ask(s.visitor, s.visitor.projectId, { preferences: "My PIN is 4321." });
  assert.ok(connectorTools().length > 0, "their connected account");
  for (const own of ["4321", "Sam's Honey Co", 'Call the user "Sam"']) assert.ok(plain.system.includes(own), own);
  assert.ok(!plain.system.includes("answering as"));
  assert.ok(!JSON.stringify(await ask(s.visitor, s.visitor.projectId)).includes("Golden Crumb's baker"));
  assert.ok(claudeSent().at(-1)!.system.includes("bees in Utrecht"), "the saved memory");

  // The owner's own assistant: their own things, as in any chat of theirs.
  const own = await ask(s.owner, s.own, { assistantVersion: 3 });
  assert.ok(connectorTools().length > 0, "the owner's connected account");
  for (const mine of ["bake on Sundays", "Golden Crumb Ltd", 'Call the user "Robin"', "Answer as Golden Crumb's baker."]) assert.ok(own.system.includes(mine), mine);
});

test("Research in someone else's assistant searches without opening pages, and its replies are capped; the owner's are as before", async () => {
  const s = await setUp();
  const theirs = await ask(s.visitor, s.theirs, { assistantVersion: 3, engine: "search", connectors: [] });
  const names = (theirs.tools ?? []).map((t) => t.name);
  assert.ok(names.includes("web_search"));
  assert.ok(!names.includes("web_fetch"), "no page reader");
  assert.ok(theirs.system.includes(NO_FETCH_LINE));
  assert.ok(theirs.max_tokens <= VISITOR_REPLY_TOKENS);

  const own = await ask(s.owner, s.own, { assistantVersion: 3, engine: "search", connectors: [] });
  assert.ok((own.tools ?? []).some((t) => t.name === "web_fetch"), "the owner's reads pages");
  assert.ok(!own.system.includes(NO_FETCH_LINE));
  // The visitor's own Research, as before.
  const plain = await ask(s.visitor, s.visitor.projectId, { engine: "search", connectors: [] });
  assert.ok((plain.tools ?? []).some((t) => t.name === "web_fetch"));
  assert.ok(!plain.system.includes(NO_FETCH_LINE));

  // Every engine that answers as it writes at most a visitor's reply in someone else's; not in the owner's.
  for (const engine of ["text", "translate", "code", "docs"]) {
    assert.ok((await ask(s.visitor, s.theirs, { assistantVersion: 3, engine })).max_tokens <= VISITOR_REPLY_TOKENS, engine);
    assert.ok((await ask(s.owner, s.own, { assistantVersion: 3, engine })).max_tokens > VISITOR_REPLY_TOKENS, `${engine}: the owner's`);
  }
  // A build doesn't answer as it, and isn't capped.
  assert.ok((await ask(s.visitor, s.theirs, { assistantVersion: 3, engine: "app", connectors: [] })).max_tokens > VISITOR_REPLY_TOKENS, "app");
});

test("a capped reply in someone else's assistant still gets every look-up round: Docs, whose least answer is above the cap, asks for the forecast twice", async () => {
  const s = await setUp();
  const forecast = { type: "tool_use" as const, name: "get_weather", input: { where: "named_place", place: "Oslo", latitude: 59.91, longitude: 10.75 } };
  stand.state.claude.replies.push(
    { blocks: [{ ...forecast, id: "w1" }], stop: "tool_use" },
    { blocks: [{ ...forecast, id: "w2" }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "Here is the table." }], stop: "end_turn" },
  );
  const r = await chat(s.visitor, s.theirs, "What's the weather in Oslo tomorrow? Put it in a table.", { engine: "docs", assistantVersion: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const calls = (claudeSent() as unknown as { max_tokens: number; tool_choice?: { type: string } }[]).map((c) => [c.max_tokens, c.tool_choice?.type]);
  assert.deepEqual(calls, [
    [VISITOR_REPLY_TOKENS, "auto"],
    [VISITOR_REPLY_TOKENS, "auto"],
    [VISITOR_REPLY_TOKENS, "none"],
  ]);
});

test("after Continue without it, a chat that had someone else's assistant still keeps the visitor's own things out; the owner's own chat gets them back", async () => {
  const s = await setUp();
  await ask(s.visitor, s.theirs, { assistantVersion: 3 });
  // Its link turned off, then "Continue without it". The chat holds replies its maker's instructions shaped.
  await share(s.id, `safe2${s.id.slice(0, 6)}`);
  assert.equal((await chat(s.visitor, s.theirs, "Still there?", { assistantVersion: 3 })).json.code, "assistant_gone");
  assert.equal((await putProject(s.visitor, s.theirs, { assistantId: "" })).status, 200);
  const after = await ask(s.visitor, s.theirs, { preferences: "My PIN is 4321." });
  assert.ok(!after.system.includes("answering as"), "without the assistant");
  assert.deepEqual(connectorTools(), [], "no connected account");
  assert.deepEqual(mock.calls, []);
  for (const secret of ["4321", "bees in Utrecht", "Sam's Honey Co", "lin_api"]) assert.ok(!JSON.stringify(after).includes(secret), secret);
  assert.ok(after.system.includes('Call the user "Sam"'), "what they're called stays");
  const research = await ask(s.visitor, s.theirs, { engine: "search", connectors: [] });
  assert.ok(!(research.tools ?? []).some((t) => t.name === "web_fetch"), "no page reader");
  assert.ok(research.system.includes(NO_FETCH_LINE));
  const counted = stand.state.seen.filter((x) => x.path.endsWith("/count_tokens") && "system" in x.body).map((x) => x.body.system);
  assert.deepEqual(counted, [research.system], "the hold counts it as it's sent");
  // Continued while it's still shared, or once it's deleted: the same.
  const shared = await chatWith(s.visitor, s.id);
  await share(s.id, `safe3${s.id.slice(0, 6)}`, s.visitor);
  await ask(s.visitor, shared, { assistantVersion: 3 });
  assert.equal((await putProject(s.visitor, shared, { assistantId: "" })).status, 200);
  assert.ok(!JSON.stringify(await ask(s.visitor, shared, { preferences: "My PIN is 4321." })).includes("4321"));
  assert.deepEqual(connectorTools(), []);
  const deleted = await chatWith(s.visitor, s.id);
  await run("DELETE FROM assistants WHERE id = ?", [s.id]);
  assert.equal((await putProject(s.visitor, deleted, { assistantId: "" })).status, 200);
  assert.ok(!JSON.stringify(await ask(s.visitor, deleted, { preferences: "My PIN is 4321." })).includes("4321"));
  assert.deepEqual(connectorTools(), []);

  // The owner's own assistant, taken off their chat with it: their own things, as in any chat of theirs.
  const owner = await withOwnThings("I'm the owner and bake on Sundays.", "Robin", "Golden Crumb Ltd");
  const mine = await assistant(owner);
  const own = await chatWith(owner, mine);
  assert.equal((await putProject(owner, own, { assistantId: "" })).status, 200);
  const back = await ask(owner, own);
  assert.ok(connectorTools().length > 0, "the owner's connected account");
  for (const theirs of ["bake on Sundays", "Golden Crumb Ltd", 'Call the user "Robin"']) assert.ok(back.system.includes(theirs), theirs);
  assert.ok((await ask(owner, own, { engine: "search", connectors: [] })).tools!.some((t) => t.name === "web_fetch"));
  // And the visitor's own chat, as before.
  await ask(s.visitor, s.visitor.projectId);
  assert.ok(connectorTools().length > 0);
});
