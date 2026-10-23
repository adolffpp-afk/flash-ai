import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { assistantKit } from "./support/assistant-kit.ts";

/*
 * Automations in chat (plan §1.1, PR 2b) where an automation couldn't do what the chat does: an
 * automation can't use connected accounts, nor an assistant's instructions and files, so with either
 * on an "every Monday…" ask isn't told Flash can do it on a schedule, in the reply or in what its hold
 * counted, and the page isn't told to offer Review automation. The same ask in a plain chat is. Claude
 * and the connected account are stand-ins.
 */
const kit = await assistantKit({ on: true });
process.env.CONNECTOR_KEYS = JSON.stringify({ v1: randomBytes(32).toString("base64") });
const { startMockConnectors } = await import("../scripts/mock-connectors.ts");
const mock = await startMockConnectors(0);
process.env.FLASH_CONNECT_MOCK = mock.origin;
process.env.AUTOMATIONS_DEV = "1";
process.env.CRON_SECRET = "x".repeat(40);
process.env.FLASH_APP_URL = "http://flash.test";
process.env.FLASH_ADMIN_EMAILS = ["user1", "user2", "user3", "user4"].map((id) => `${id}@example.com`).join(", ");
after(async () => {
  await mock.close();
  await kit.close();
});
const { account, bakery, chat, claudeSent, run, stand } = kit;
const { addConnection } = await import("../src/lib/server/connections.ts");
const { AUTOMATION_LINE } = await import("../src/lib/engines/claude.ts");

beforeEach(async () => {
  stand.reset();
  mock.reset();
  await run("DELETE FROM rate_limits");
});

const EVERY_MONDAY = "Every Monday morning, write me a short summary of what my team finished that week";
const told = () => claudeSent().some((b) => b.system.includes(AUTOMATION_LINE));
const marked = (events: { type: string }[]) => events.some((e) => e.type === "automation");
const counted = () =>
  stand.state.seen.filter((s) => s.service === "anthropic" && s.path.endsWith("/count_tokens")).map((s) => (typeof s.body.system === "string" ? s.body.system : JSON.stringify(s.body.system)));

test("with a connected account on, an every-Monday ask isn't told Flash can do it on a schedule; with it off, it is", async () => {
  const who = await account(1000);
  const connection = (await addConnection(who.id, { provider: "linear", token: "lin_api_SECRETSECRET1234" })).id;
  const on = await chat(who, who.projectId, EVERY_MONDAY, { connectors: [connection] });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  assert.ok(claudeSent().length > 0);
  assert.equal(told(), false, "the reply");
  assert.ok(counted().length > 0 && counted().every((s) => !s.includes(AUTOMATION_LINE)), "what its hold counted");
  assert.equal(marked(on.events), false, "the page");
  stand.reset();
  const off = await chat(who, who.projectId, EVERY_MONDAY, { connectors: [] });
  assert.equal(off.status, 200);
  assert.ok(told(), "the same ask without the account");
  assert.ok(marked(off.events));
});

test("in a chat with an assistant, its owner's or someone else's, the ask isn't told either", async () => {
  const b = await bakery();
  for (const [who, chatId] of [
    [b.owner, b.own],
    [b.visitor, b.theirs],
  ] as const) {
    stand.reset();
    const r = await chat(who, chatId, EVERY_MONDAY, { assistantVersion: 3 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(claudeSent().length > 0);
    assert.equal(told(), false, chatId);
    assert.equal(marked(r.events), false, chatId);
  }
  stand.reset();
  const plain = await chat(b.owner, b.owner.projectId, EVERY_MONDAY);
  assert.equal(plain.status, 200);
  assert.ok(told(), "the owner's plain chat");
  assert.ok(marked(plain.events));
});
