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
const { account, assistant, file, share, chatWith, getProject, putProject, one, run, db, stand } = kit;
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
