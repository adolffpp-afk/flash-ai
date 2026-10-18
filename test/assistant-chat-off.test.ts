import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { assistantKit } from "./support/assistant-kit.ts";

/*
 * As shipped, assistants are off, and the chat and project routes are live: a chat that names an
 * assistant (one started while they were on, or a request that names one) is read, priced, sent
 * and charged exactly as a chat without one, and nothing about assistants is read. What they do
 * once on is tested in assistant-chat.test.ts and the other assistant-*.test.ts files.
 */
const kit = await assistantKit({ on: false });
after(() => kit.close());
const { account, assistant, file, share, chatWith, getProject, putProject, chat, claudeSent, ledger, one, run, db, stand } = kit;
const { ASSISTANTS_ON } = await import("../src/lib/assistants.ts");

beforeEach(async () => {
  stand.reset();
  await run("DELETE FROM rate_limits");
});

type Statement = string | { sql: string } | [string, unknown[]];
const sqlOf = (s: Statement) => (typeof s === "string" ? s : Array.isArray(s) ? s[0] : s.sql);
/** Every statement `f` asks the database. */
async function watched<T>(f: () => Promise<T>): Promise<{ result: T; sql: string[] }> {
  const client = await db();
  const { execute, batch } = client;
  const sql: string[] = [];
  client.execute = (async (s: Statement, args?: never) => {
    sql.push(sqlOf(s));
    return execute.call(client, s as string, args);
  }) as typeof execute;
  client.batch = (async (ss: Statement[], mode?: "read" | "write") => {
    sql.push(...ss.map(sqlOf));
    return batch.call(client, ss as never, mode);
  }) as typeof batch;
  try {
    return { result: await f(), sql };
  } finally {
    client.execute = execute;
    client.batch = batch;
  }
}
const ASSISTANT_SQL = /assistant/i;

test("while assistants are off, a chat started with one is read and saved as any chat, and its assistant isn't looked at", async () => {
  assert.equal(ASSISTANTS_ON, false);
  const owner = await account();
  const id = await assistant(owner);
  await file(id, "Prices.txt", "A sourdough loaf is 4 euros.");
  await share(id, "off1", owner);
  const chat = await chatWith(owner, id);
  const { result: got, sql } = await watched(() => getProject(owner, chat));
  assert.equal(got.status, 200);
  assert.deepEqual(Object.keys(got.body.project!), ["id", "name", "messages", "updated_at", "instructions"], "as before: no assistant");
  assert.deepEqual(sql.filter((s) => ASSISTANT_SQL.test(s)), [], "nothing about assistants is read");
  // A plain chat reads the same.
  assert.deepEqual(Object.keys((await getProject(owner, owner.projectId)).body.project!), ["id", "name", "messages", "updated_at", "instructions"]);

  // assistantId in a PUT is ignored, as any field Flash doesn't know: the chat moves in time as before.
  await run("UPDATE projects SET updated_at = 5 WHERE id = ?", [chat]);
  for (const value of ["", "something"]) {
    const { result: put, sql: written } = await watched(() => putProject(owner, chat, { assistantId: value }));
    assert.equal(put.status, 200);
    assert.deepEqual(written.filter((s) => ASSISTANT_SQL.test(s)), []);
  }
  const row = await one<{ a: string; u: number }>("SELECT assistant_id AS a, updated_at AS u FROM projects WHERE id = ?", [chat]);
  assert.equal(row?.a, id, "never taken off");
  assert.ok(Number(row?.u) > 5, "a PUT with nothing Flash knows moves the chat in time, as before");
});

type Who = Awaited<ReturnType<typeof account>>;
// The clock in the context note moves between two requests; the rest of the prompt doesn't.
const unclocked = (system: string) => system.replace(/\d{1,2}:\d{2}(\s?[AP]M)?/g, "H:MM");
/** One reply, with what it held while it was written, what Claude was sent and what it was finally charged. */
async function reply(who: Who, chatId: string, content: string, body: Record<string, unknown>) {
  stand.reset();
  let release = () => {};
  stand.state.claude.replies.push({ blocks: [{ type: "text", text: "A loaf is 4 euros." }], stop: "end_turn", hold: new Promise<void>((r) => (release = r)) });
  const pending = chat(who, chatId, content, body);
  for (let i = 0; !claudeSent().length && i < 400; i++) await new Promise((r) => setTimeout(r, 5));
  const holding = (await ledger(who.id)).at(-1)!;
  release();
  const r = await pending;
  const sent = claudeSent().at(-1)! as unknown as Record<string, unknown> & { system: string };
  const counted = stand.state.seen.filter((x) => x.path.endsWith("/count_tokens")).map((x) => ({ ...x.body, system: unclocked(String(x.body.system)) }));
  return { r, held: -holding.amount, charged: (await ledger(who.id)).at(-1)!.amount, sent: { ...sent, system: unclocked(sent.system) }, counted };
}

test("while assistants are off, a chat started with one is answered, held and charged exactly as a chat without one, and nothing about assistants is read", async () => {
  const owner = await account();
  const visitor = await account();
  const id = await assistant(owner);
  await file(id, "Prices.txt", "A sourdough loaf is 4 euros.");
  await share(id, "off2", visitor);
  const tagged = await chatWith(visitor, id);
  // What an assistant chat's page would send once they're on, and passages from the page, which only the server puts on.
  const named = {
    assistantVersion: 1,
    readStart: true,
    assistantId: id,
    messages: [{ role: "user", content: "How much is sourdough?", passages: [{ title: "Prices.txt", text: "INJECTED PASSAGE" }] }],
  };
  for (const engine of ["text", "search"]) {
    const plain = await reply(visitor, visitor.projectId, "How much is sourdough?", { ...named, engine });
    const { result: withIt, sql } = await watched(() => reply(visitor, tagged, "How much is sourdough?", { ...named, engine }));
    assert.equal(withIt.r.status, 200, JSON.stringify(withIt.r.json));
    assert.deepEqual(sql.filter((s) => ASSISTANT_SQL.test(s)), [], `${engine}: nothing about assistants is read`);
    // The same request to Claude, counted the same, held and charged the same.
    assert.deepEqual(withIt.sent, plain.sent, engine);
    assert.deepEqual(withIt.counted, plain.counted, engine);
    assert.equal(withIt.held, plain.held, engine);
    assert.equal(withIt.charged, plain.charged, engine);
    assert.deepEqual(
      withIt.r.events.map((e) => e.type),
      plain.r.events.map((e) => e.type),
      engine,
    );
    // The same route said, but for which ledger row holds its credits.
    const route = (events: typeof plain.r.events) => ({ ...events.find((e) => e.type === "route"), charge: undefined });
    assert.deepEqual(route(withIt.r.events), route(plain.r.events), engine);
    assert.equal(withIt.r.events.find((e) => e.type === "read"), undefined);
    const body = JSON.stringify(withIt.sent);
    for (const word of ["INJECTED", "Golden Crumb's baker", "answering as", "sourdough loaf is 4 euros"]) assert.ok(!body.includes(word), `${engine}: ${word}`);
  }
  // Nothing counted toward a visitor's day with it.
  assert.equal(await one("SELECT key FROM rate_limits WHERE key LIKE 'assistant-msg:%'"), null);
});
