import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, register } from "node:module";
import type { AddressInfo } from "node:net";

/*
 * The assistant API for owners, through its own routes, with assistants switched on for the test
 * (see support/assistants-on.mjs; as shipped they're off, assistants-api-off.test.ts), on a libSQL
 * file database with foreign keys off, as Turso runs, and a stand-in for Anthropic's free token
 * count. What's over a limit is refused with its reason and nothing is cut or written; only the
 * owner reaches an assistant; a change made since an editor read it is refused, not lost; and
 * deleting leaves nothing behind.
 */
register("./support/route-hooks.mjs", import.meta.url);
register("./support/assistants-on.mjs", import.meta.url);

// The stand-in count: a quarter of the text's bytes, times a weight of the model's own, so each
// level's model counts differently. What was asked is kept; while countDown is set, counting fails;
// while holdFor is set, no count is answered until that many have been asked.
const asked: { model: string; text: string }[] = [];
let countDown = false;
let weights: Record<string, number> = {};
let holdFor = 0;
const held: (() => void)[] = [];
const countOf = (model: string, text: string) => Math.ceil(Buffer.byteLength(text) / 4) * (weights[model] ?? 1) + 3;
const counter = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}") as { model: string; messages: { content: string }[] };
    if (!req.url?.includes("count_tokens")) {
      res.writeHead(404);
      return res.end();
    }
    asked.push({ model: body.model, text: body.messages[0].content });
    const answer = () => {
      if (countDown) {
        res.writeHead(529, { "content-type": "application/json", "x-should-retry": "false" });
        return res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: countOf(body.model, body.messages[0].content) }));
    };
    if (!holdFor) return answer();
    held.push(answer);
    if (held.length >= holdFor) {
      holdFor = 0;
      for (const go of held.splice(0)) go();
    }
  });
});
await new Promise<void>((r) => counter.listen(0, "127.0.0.1", r));

const dir = mkdtempSync(join(tmpdir(), "flash-assistants-api-"));
process.env.DATABASE_URL = `file:${join(dir, "api.db")}`;
process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(counter.address() as AddressInfo).port}`;
delete process.env.FLASH_APP_URL;
delete process.env.VERCEL_ENV;
after(() => {
  counter.closeAllConnections();
  counter.close();
  rmSync(dir, { recursive: true, force: true });
});

const { db, run, one, all, mendAssistantIndex } = await import("../src/lib/server/db.ts");
const { createSession } = await import("../src/lib/server/auth.ts");
const { LEVEL_MODELS, countTextTokens } = await import("../src/lib/engines/claude.ts");
const { FREE_STORAGE_BYTES, saveUpload, usedStorage } = await import("../src/lib/server/site-files.ts");
const lib = await import("../src/lib/assistants.ts");
const { ASSISTANTS_ON, ASSISTANT_COLORS } = lib;
const { CUT_NOTE } = await import("../src/lib/office.ts");
const server = await import("../src/lib/server/assistants.ts");
const { ASSISTANT_TABLES, DAILY_TEXT_FREE, DAILY_TEXT_PAID, EXACT_CHARS, countInstructionTokens, createAssistant, deleteUserAssistants, fileTokens } = server;
const { UPLOAD_CAP } = await import("../src/lib/server/assistant-routes.ts");
const listRoute = await import("../src/app/api/assistants/route.ts");
const oneRoute = await import("../src/app/api/assistants/[id]/route.ts");
const filesRoute = await import("../src/app/api/assistants/[id]/files/route.ts");
const fileRoute = await import("../src/app/api/assistants/[id]/files/[fileId]/route.ts");
const chatsRoute = await import("../src/app/api/assistants/[id]/chats/route.ts");
const { afterwards } = await import("./support/next-server.mjs");

await db();
await run("PRAGMA foreign_keys = OFF");

// Every level's model, each once, with a weight of its own: the largest isn't the first or last asked.
const MODELS = [...new Set(Object.values(LEVEL_MODELS))];
const WEIGHTS = MODELS.map((_, i) => (i === Math.floor(MODELS.length / 2) ? 3 : 1 + i / 10));
beforeEach(() => {
  asked.length = 0;
  countDown = false;
  holdFor = 0;
  weights = Object.fromEntries(MODELS.map((m, i) => [m, WEIGHTS[i]]));
});
const largest = (text: string) => Math.max(...MODELS.map((m) => countOf(m, text)));
const bytes = (text: string) => Buffer.byteLength(text);
const DAY = 24 * 3600_000;

let users = 0;
/** A signed-in user with a session; on a paid plan when one is given. */
async function account(plan = "") {
  const id = `user${++users}`;
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'x', 0)", [id, `${id}@example.com`]);
  if (plan) {
    await run(
      "INSERT INTO subscriptions (id, user_id, plan, interval, status, amount_cents, anchor, paid_until, test, created_at, updated_at) VALUES (?, ?, ?, 'month', 'active', 0, 0, ?, 1, 0, 0)",
      [`sub_${id}`, id, plan, Date.now() + 30 * DAY],
    );
  }
  return { id, cookie: (await createSession(id, true)).split(";")[0] };
}
type Who = Awaited<ReturnType<typeof account>>;

const ORIGIN = "http://localhost";
type Sent = { json?: unknown; form?: FormData; origin?: string | null; type?: string; headers?: Record<string, string> };
/** A request as Flash's own page sends it, unless told otherwise. */
function request(method: string, path: string, who: Who | null, o: Sent = {}): Request {
  const headers: Record<string, string> = { ...(who && { cookie: who.cookie }), ...o.headers };
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  let body: BodyInit | undefined;
  if (o.json !== undefined) {
    headers["content-type"] = o.type ?? "application/json";
    body = JSON.stringify(o.json);
  } else if (o.form) body = o.form;
  return new Request(`${ORIGIN}${path}`, { method, headers, body });
}
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
type Reply = { status: number; body: Record<string, unknown> & { error?: string; code?: string } };
const read = async (res: Response): Promise<Reply> => ({ status: res.status, body: (await res.json()) as Reply["body"] });

type Made = { id: string; name: string; version: number; color: string; files: { id: string; name: string }[] };
const make = async (who: Who, fields: Record<string, unknown>, o: Sent = {}) => read(await listRoute.POST(request("POST", "/api/assistants", who, { json: fields, ...o })));
async function made(who: Who, fields: Record<string, unknown> = {}): Promise<Made> {
  const r = await make(who, { name: "Bakery helper", ...fields });
  assert.equal(r.status, 200, r.body.error);
  return r.body.assistant as Made;
}
const get = async (who: Who | null, id: string) => read(await oneRoute.GET(request("GET", `/api/assistants/${id}`, who), ctx({ id })));
const put = async (who: Who | null, id: string, json: Record<string, unknown>, o: Sent = {}) =>
  read(await oneRoute.PUT(request("PUT", `/api/assistants/${id}`, who, { json, ...o }), ctx({ id })));
const remove = async (who: Who | null, id: string, o: Sent = {}) => read(await oneRoute.DELETE(request("DELETE", `/api/assistants/${id}`, who, o), ctx({ id })));

/** An upload as the editor sends it: the file's text as a part of its own, with its name, kind and pages. */
function form(text: string | Blob, o: { name?: string; kind?: string; pages?: number } = {}) {
  const f = new FormData();
  f.set("name", o.name ?? "Notes.txt");
  f.set("kind", o.kind ?? "text");
  f.set("pages", String(o.pages ?? 0));
  f.set("text", typeof text === "string" ? new Blob([text], { type: "text/plain" }) : text, "text.txt");
  return f;
}
async function upload(who: Who | null, id: string, text: string, o: { name?: string; kind?: string; pages?: number } & Sent = {}) {
  const res = await filesRoute.POST(request("POST", `/api/assistants/${id}/files`, who, { form: form(text, o), ...o }), ctx({ id }));
  await afterwards();
  return read(res);
}
const fileText = (who: Who | null, id: string, fileId: string) => fileRoute.GET(request("GET", `/api/assistants/${id}/files/${fileId}`, who), ctx({ id, fileId }));
const removeFile = async (who: Who | null, id: string, fileId: string, o: Sent = {}) =>
  read(await fileRoute.DELETE(request("DELETE", `/api/assistants/${id}/files/${fileId}`, who, o), ctx({ id, fileId })));
const startChat = async (who: Who | null, id: string, o: Sent = {}) => read(await chatsRoute.POST(request("POST", `/api/assistants/${id}/chats`, who, { json: {}, ...o }), ctx({ id })));
const row = (id: string) =>
  one<{ name: string; description: string; instructions: string; starters: string; level: string; version: number; instr_tokens: number }>("SELECT * FROM assistants WHERE id = ?", [id]);
const sqlText = (s: unknown) => (typeof s === "string" ? s : (s as { sql: string }).sql);
const count = async (sql: string, args: (string | number)[] = []) => Number((await one<{ n: number }>(sql, args))?.n ?? 0);
const used = (key: string) => count("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits WHERE key = ?", [key]);
/** Sets a limit's count for this hour (or day) as if that many had been asked. */
const spent = (key: string, n: number, window = 3600_000) => run("INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)", [key, n, Date.now() + window]);
// Text of a given length that no other file in the test has.
let texts = 0;
const fresh = (chars: number) => {
  const head = `File ${++texts}. `;
  return (head + "Bread and butter. ".repeat(Math.ceil(chars / 18))).slice(0, chars);
};

test("assistants are on here only through the test's loader, and off as shipped", async () => {
  assert.equal(ASSISTANTS_ON, true, "support/assistants-on.mjs turned the switch on for this test");
  assert.equal(Number((await one<{ foreign_keys: number }>("PRAGMA foreign_keys"))?.foreign_keys), 0, "foreign keys off, as on Turso");
});

test("a text's tokens are Anthropic's free count on every level's model, each asked once, the largest kept; its bytes when counting fails", async () => {
  assert.ok(MODELS.length >= 2, "the levels run on more than one model");
  const text = "Answer in French, kindly, about our breads.";
  assert.equal(await countTextTokens(MODELS[0], text), countOf(MODELS[0], text), "one model's count, as Anthropic gives it");
  assert.deepEqual(asked, [{ model: MODELS[0], text }]);
  asked.length = 0;

  assert.equal(await countInstructionTokens(text), largest(text));
  assert.deepEqual(asked.map((a) => a.model).sort(), [...MODELS].sort(), "every level's model, each once");
  assert.ok(largest(text) > countOf(MODELS[0], text) && largest(text) > countOf(MODELS.at(-1)!, text), "the largest is neither the first nor the last asked");

  asked.length = 0;
  assert.equal(await countInstructionTokens(""), 0, "nothing to count");
  assert.equal(asked.length, 0, "and nothing asked");
  countDown = true;
  const hindi = "हिंदी में जवाब दें";
  assert.equal(await countInstructionTokens(hindi), bytes(hindi), "its UTF-8 bytes, which a count never goes over");
});

test("a file's tokens: counted whole up to 50,000 characters; a longer one by its start, scaled by what grows more, never over its bytes", async () => {
  const short = fresh(EXACT_CHARS);
  assert.deepEqual(await fileTokens(short), { tokens: largest(short), exact: true });
  assert.ok(asked.every((a) => a.text === short));

  // Latin first, then Chinese: three bytes a character, so its bytes grow twice as fast as its characters.
  asked.length = 0;
  const start = fresh(EXACT_CHARS);
  const long = start + "面包".repeat(EXACT_CHARS / 2);
  const est = await fileTokens(long);
  assert.ok(asked.every((a) => a.text === start), "only its first 50,000 characters are sent");
  assert.deepEqual(est, { tokens: Math.min(bytes(long), Math.ceil(largest(start) * (bytes(long) / bytes(start)))), exact: false });
  assert.ok(bytes(long) / bytes(start) > long.length / start.length);

  // A start that counts high is held to the text's bytes.
  weights = Object.fromEntries(MODELS.map((m) => [m, 50]));
  assert.deepEqual(await fileTokens(long), { tokens: bytes(long), exact: false });

  // The start never ends between the two halves of an emoji.
  asked.length = 0;
  const emoji = "a".repeat(EXACT_CHARS - 1) + "🍞" + "b".repeat(10);
  await fileTokens(emoji);
  assert.equal(asked[0].text, "a".repeat(EXACT_CHARS - 1));

  countDown = true;
  assert.deepEqual(await fileTokens(short), { tokens: bytes(short), exact: false }, "its bytes when counting fails");
});

test("making an assistant: cleaned, refused with its reason at every limit and never cut, and nothing written when refused", async () => {
  const owner = await account();
  const before = await count("SELECT COUNT(*) AS n FROM assistants WHERE user_id = ?", [owner.id]);
  const refusals: [Record<string, unknown>, string][] = [
    [{ name: "  \u200B " }, "Give your assistant a name."],
    [{ name: "x".repeat(61) }, "Names can be up to 60 characters."],
    [{ name: "Flash Support" }, "That name is kept for Flash itself. Pick another."],
    [{ name: "Flаsh help" }, "That name is kept for Flash itself. Pick another."],
    // Flash's levels are Flash's own names too.
    [{ name: "Flash Summit" }, "That name is kept for Flash itself. Pick another."],
    [{ name: "Official Flash Vision" }, "That name is kept for Flash itself. Pick another."],
    [{ name: "Flash Sonic support" }, "That name is kept for Flash itself. Pick another."],
    [{ description: "x".repeat(301) }, "Descriptions can be up to 300 characters."],
    [{ instructions: "x".repeat(8001) }, "Instructions can be up to 8,000 characters. Yours has 8,001."],
    [{ starters: ["1", "2", "3", "4", "5", "6", "7"] }, "Up to 6 conversation starters, each up to 200 characters."],
    [{ starters: ["x".repeat(201)] }, "Up to 6 conversation starters, each up to 200 characters."],
    // A level Flash doesn't have is a bad request, not Auto ("Vision" is a name; the id is "vision").
    [{ level: "Vision" }, "Something went wrong. Please try again."],
  ];
  for (const [fields, error] of refusals) {
    const r = await make(owner, { name: "Bakery helper", ...fields });
    assert.equal(r.status, 400, error);
    assert.equal(r.body.error, error);
  }
  assert.equal(await count("SELECT COUNT(*) AS n FROM assistants WHERE user_id = ?", [owner.id]), before, "nothing was written");
  assert.equal(asked.length, 0, "and nothing counted");

  // At each limit exactly, it's made, all of it.
  const instructions = `${"Answer about bread. ".repeat(400).slice(0, 7999)}!`;
  assert.equal(instructions.length, 8000);
  const a = await made(owner, { name: "x".repeat(60), description: "d".repeat(300), instructions, starters: ["s".repeat(200), "2", "3", "4", "5", "6"], level: "vision" });
  const saved = (await row(a.id))!;
  assert.equal(saved.instructions, instructions);
  assert.equal(JSON.parse(saved.starters).length, 6);
  assert.match(a.id, /^[0-9a-f]{32}$/);
  assert.ok((ASSISTANT_COLORS as readonly string[]).includes(a.color), "a colour of its own when none was picked");
  assert.equal(a.version, 0);
  assert.equal(Number(saved.instr_tokens), largest(`${"x".repeat(60)}\n\n${instructions}`), "its name and instructions, at the largest count");
  // Changed to a level Flash doesn't have ("Summit" is what the picker calls "ultra"): refused, and
  // it keeps its level and version.
  const level = await put(owner, a.id, { version: 0, level: "summit" });
  assert.equal(level.status, 400);
  assert.deepEqual([(await row(a.id))!.level, Number((await row(a.id))!.version)], ["vision", 0]);
  assert.equal((await put(owner, a.id, { version: 0, level: "ultra" })).status, 200, "its id is taken");
  assert.equal((await made(owner, { color: "rose" })).color, "rose");
});

test("50 assistants an account, held in the statement that makes one, and 30 made an hour", async () => {
  const owner = await account();
  for (let i = 0; i < 48; i++) await createAssistant(owner.id, { name: `Helper ${i}` });
  // Two at once for the last two places: both are made; two more, and neither is.
  const both = await Promise.allSettled([createAssistant(owner.id, { name: "One" }), createAssistant(owner.id, { name: "Two" })]);
  assert.equal(both.filter((r) => r.status === "fulfilled").length, 2, "places 49 and 50");
  const last = await Promise.allSettled([createAssistant(owner.id, { name: "Three" }), createAssistant(owner.id, { name: "Four" })]);
  assert.equal(last.filter((r) => r.status === "fulfilled").length, 0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM assistants WHERE user_id = ?", [owner.id]), 50);
  asked.length = 0;
  const r = await make(owner, { name: "Fifty-one" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "You've reached 50 assistants.");
  assert.equal(asked.length, 0, "refused before its instructions are counted");

  // The race the statement holds: the count was read before another request took the last place.
  const racer = await account();
  for (let i = 0; i < 49; i++) await createAssistant(racer.id, { name: `Helper ${i}` });
  const client = await db();
  const execute = client.execute;
  client.execute = async function (this: typeof client, ...args: Parameters<typeof execute>) {
    const sql = sqlText(args[0]);
    if (sql.startsWith("INSERT INTO assistants")) {
      client.execute = execute;
      await run("INSERT INTO assistants (id, user_id, name, created_at, updated_at) VALUES (?, ?, 'Sneaked in', 0, 0)", ["f".repeat(32), racer.id]);
    }
    return execute.apply(this, args);
  } as typeof execute;
  await assert.rejects(createAssistant(racer.id, { name: "Late" }), (err: InstanceType<typeof server.AssistantError>) => err.refusal.code === "too_many_assistants");
  client.execute = execute;
  assert.equal(await count("SELECT COUNT(*) AS n FROM assistants WHERE user_id = ?", [racer.id]), 50);

  const busy = await account();
  await spent(`assistant-new:${busy.id}`, 30);
  const limited = await make(busy, { name: "Thirty-one" });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "You've made a lot of assistants. Try again in an hour.");
  assert.equal(await count("SELECT COUNT(*) AS n FROM assistants WHERE user_id = ?", [busy.id]), 0);
});

test("no two assistants share the 16 digits that tag their words: the database refuses it, and an id whose 16 are taken is made again", async () => {
  const owner = await account();
  const first = await createAssistant(owner.id, { name: "Bakery helper" });
  const head = first.id.slice(0, 16);
  const ids = [head + "0".repeat(16), "1234567890abcdef".repeat(2)];
  const tried: string[] = [];
  const second = await createAssistant(owner.id, { name: "Second" }, { newId: () => (tried.push(ids[tried.length]), ids[tried.length - 1]) });
  assert.deepEqual(tried, ids, "the first id shared its 16 digits, so another was made");
  assert.equal(second.id, ids[1]);

  // The database itself refuses a second, however it's written.
  await assert.rejects(run("INSERT INTO assistants (id, user_id, name, created_at, updated_at) VALUES (?, ?, 'Copy', 0, 0)", [head + "f".repeat(16), owner.id]), /UNIQUE/);
  // An id that keeps colliding is given up on, not used.
  await assert.rejects(createAssistant(owner.id, { name: "Third" }, { newId: () => head + "a".repeat(16) }), (err: InstanceType<typeof server.AssistantError>) => err.refusal.code === "failed");

  // Without the unique index (a database that couldn't make it), the statement that makes one still checks.
  await run("DROP INDEX assistants_tag");
  try {
    const again: string[] = [];
    const third = await createAssistant(owner.id, { name: "Third" }, { newId: () => (again.push("x"), again.length === 1 ? head + "b".repeat(16) : "fedcba0987654321".repeat(2)) });
    assert.equal(third.id, "fedcba0987654321".repeat(2));
    assert.equal(await count("SELECT COUNT(*) AS n FROM assistants WHERE substr(id, 1, 16) = ?", [head]), 1);

    // A database where two already share them: making the index fails, and the rest of the
    // setup still runs (here the trigger, made after it).
    await run("INSERT INTO assistants (id, user_id, name, created_at, updated_at) VALUES (?, ?, 'Old twin', 0, 0)", [head + "c".repeat(16), owner.id]);
    await run("DROP TRIGGER assistant_chunks_gone");
    const other = (await import(`../src/lib/server/db.ts?${"again"}`)) as typeof import("../src/lib/server/db.ts");
    (await other.db()).close();
    assert.equal(await count("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'assistant_chunks_gone'"), 1, "setup went on past the index it couldn't make");
    assert.equal(await count("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'assistants_tag'"), 0);
  } finally {
    await run("DELETE FROM assistants WHERE id = ?", [head + "c".repeat(16)]);
    await run("CREATE UNIQUE INDEX IF NOT EXISTS assistants_tag ON assistants(substr(id, 1, 16))");
    await mendAssistantIndex(await db());
  }
});

test("only the owner reads, changes, deletes or chats with an assistant, or its files", async () => {
  const owner = await account();
  const stranger = await account();
  const a = await made(owner, { instructions: "Secret recipe: rye and honey." });
  const up = await upload(owner, a.id, fresh(500));
  assert.equal(up.status, 200, up.body.error);
  const fileId = (up.body.file as { id: string }).id;

  for (const r of [
    await get(stranger, a.id),
    await put(stranger, a.id, { version: 1, name: "Mine now" }),
    await remove(stranger, a.id),
    await upload(stranger, a.id, fresh(300)),
    // Not theirs is said before anything else is.
    await upload(stranger, a.id, fresh(300), { kind: "doc" }),
    await read(await fileText(stranger, a.id, fileId)),
    await removeFile(stranger, a.id, fileId),
    await startChat(stranger, a.id),
  ]) {
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "Not found");
  }
  assert.deepEqual(((await read(await listRoute.GET(request("GET", "/api/assistants", stranger)))).body.assistants as unknown[]), []);
  const kept = await get(owner, a.id);
  assert.equal(kept.status, 200);
  const assistant = kept.body.assistant as Made & { instructions: string };
  assert.equal(assistant.name, "Bakery helper");
  assert.equal(assistant.instructions, "Secret recipe: rye and honey.");
  assert.equal(assistant.files.length, 1);
  assert.equal(await count("SELECT COUNT(*) AS n FROM projects WHERE assistant_id = ?", [a.id]), 0);

  // Signed out: nobody.
  for (const r of [await get(null, a.id), await put(null, a.id, { version: 1 }), await remove(null, a.id), await upload(null, a.id, fresh(10)), await startChat(null, a.id)]) {
    assert.equal(r.status, 401);
  }
  const list = (await read(await listRoute.GET(request("GET", "/api/assistants", owner)))).body.assistants as { id: string; files: number }[];
  assert.deepEqual(list.map((x) => [x.id, x.files]), [[a.id, 1]]);
});

test("once assistants are on, a method a route doesn't take is a 405, OPTIONS too, without saying which it takes; HEAD is GET", async () => {
  const owner = await account();
  const a = await made(owner);
  const routes = { "/api/assistants": listRoute, "/api/assistants/[id]": oneRoute, "/api/assistants/[id]/files": filesRoute, "/api/assistants/[id]/files/[fileId]": fileRoute, "/api/assistants/[id]/chats": chatsRoute };
  const taken: Record<string, string[]> = {
    "/api/assistants": ["GET", "HEAD", "POST"],
    "/api/assistants/[id]": ["GET", "HEAD", "PUT", "DELETE"],
    "/api/assistants/[id]/files": ["POST"],
    "/api/assistants/[id]/files/[fileId]": ["GET", "HEAD", "DELETE"],
    "/api/assistants/[id]/chats": ["POST"],
  };
  for (const [path, route] of Object.entries(routes)) {
    const handlers = route as unknown as Record<string, (r: Request, c: unknown) => Promise<Response>>;
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].filter((m) => !taken[path].includes(m))) {
      const res = await handlers[method](request(method, path.replace("[id]", a.id).replace("[fileId]", "f1"), owner), ctx({ id: a.id, fileId: "f1" }));
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.get("allow"), null);
    }
  }
  const head = await oneRoute.HEAD(request("HEAD", `/api/assistants/${a.id}`, owner), ctx({ id: a.id }));
  assert.equal(head.status, 200);
  assert.equal((await oneRoute.HEAD(request("HEAD", `/api/assistants/${a.id}`, null), ctx({ id: a.id }))).status, 401);
});

test("changing an assistant: only what's sent, with the version it was read at, and a change made since is refused with the version now", async () => {
  const owner = await account();
  const a = await made(owner, { description: "Bread questions", instructions: "Be brief." });

  const r1 = await put(owner, a.id, { version: 0, name: "Rye and spelt helper" });
  assert.equal(r1.status, 200, r1.body.error);
  const changed = r1.body.assistant as Made & { description: string; instructions: string };
  assert.deepEqual([changed.name, changed.description, changed.instructions, changed.version], ["Rye and spelt helper", "Bread questions", "Be brief.", 1]);
  assert.notEqual(largest("Rye and spelt helper\n\nBe brief."), largest("Bakery helper\n\nBe brief."));
  assert.equal(Number((await row(a.id))!.instr_tokens), largest("Rye and spelt helper\n\nBe brief."), "counted again with its new name");

  // Another device still has version 0.
  asked.length = 0;
  const stale = await put(owner, a.id, { version: 0, instructions: "Overwritten?" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "Someone changed this assistant on another device. Reload to see their change.");
  assert.equal(stale.body.code, "version_conflict");
  assert.equal(stale.body.version, 1);
  assert.equal((await row(a.id))!.instructions, "Be brief.", "nothing written");
  assert.equal(asked.length, 0, "nor counted");

  // A description isn't counted again; sending what it has changes nothing.
  asked.length = 0;
  assert.equal((await put(owner, a.id, { version: 1, description: "Rye only" })).status, 200);
  assert.equal(asked.length, 0);
  const same = await put(owner, a.id, { version: 2, name: "Rye and spelt helper", description: "Rye only" });
  assert.equal((same.body.assistant as Made).version, 2, "no new version for no change");

  // Over a limit: refused, not cut.
  const long = await put(owner, a.id, { version: 2, instructions: "y".repeat(8001) });
  assert.equal(long.status, 400);
  assert.equal(long.body.error, "Instructions can be up to 8,000 characters. Yours has 8,001.");
  assert.equal((await row(a.id))!.instructions, "Be brief.");
  assert.equal((await put(owner, a.id, { version: 2, name: "Flash Team" })).body.error, "That name is kept for Flash itself. Pick another.");
  assert.equal((await put(owner, a.id, { name: "No version" })).status, 400, "the version it was read at is needed");

  // An upload gives a new version, which comes back with it for the editor's next save.
  const up = await upload(owner, a.id, fresh(200));
  assert.equal(up.body.version, 3);
  assert.equal((await put(owner, a.id, { version: 2, level: "sonic" })).status, 409);
  assert.equal((await put(owner, a.id, { version: 3, level: "sonic" })).status, 200);

  // Changed between the read and the write: the write itself checks.
  const client = await db();
  const execute = client.execute;
  client.execute = async function (this: typeof client, ...args: Parameters<typeof execute>) {
    const sql = sqlText(args[0]);
    if (sql.trimStart().startsWith("UPDATE assistants SET name")) {
      client.execute = execute;
      await run("UPDATE assistants SET version = version + 1 WHERE id = ?", [a.id]);
    }
    return execute.apply(this, args);
  } as typeof execute;
  const raced = await put(owner, a.id, { version: 4, description: "Raced" });
  client.execute = execute;
  assert.equal(raced.status, 409);
  assert.equal(raced.body.version, 5);
  assert.equal((await row(a.id))!.description, "Rye only");

  await spent(`assistant-save:${owner.id}`, 300);
  const limited = await put(owner, a.id, { version: 5, description: "Too many" });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "Too many updates. Try again in an hour.");
});

test("a file: kept as its text with its counts, readable back as plain text, and never cut", async () => {
  const owner = await account();
  const a = await made(owner);
  const text = `${fresh(3000)}\nUn pain au levain, s'il vous plaît.${CUT_NOTE}`;
  const r = await upload(owner, a.id, text, { name: "C:\\Users\\me\\Recettes\u202E\u0000 d'hiver.pdf", kind: "pdf", pages: 3 });
  assert.equal(r.status, 200, r.body.error);
  const file = r.body.file as { id: string; name: string; kind: string; pages: number; chars: number; bytes: number; stored: number; tokens: number; exact: boolean; cut: boolean };
  assert.deepEqual(
    { ...file, id: "", createdAt: 0 },
    { id: "", name: "Recettes d'hiver.pdf", kind: "pdf", pages: 3, chars: text.length, bytes: bytes(text), stored: 3 * bytes(text), tokens: largest(text), exact: true, cut: true, createdAt: 0 },
  );
  const res = await fileText(owner, a.id, file.id);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("content-security-policy"), "sandbox");
  assert.equal(await res.text(), text, "its text as it was sent");

  const name = `${"Très long nom ".repeat(12)}.docx`;
  const long = await upload(owner, a.id, fresh(100), { name, kind: "docx" });
  const kept = (long.body.file as { name: string }).name;
  assert.equal([...kept].length, 120);
  assert.ok(kept.endsWith(".docx"), "a long name is cut before its extension");

  for (const [t, o, error] of [
    ["   \n ", {}, "Couldn't read the attached files."],
    [fresh(100), { kind: "doc" }, "Couldn't read the attached files."],
  ] as [string, { kind?: string }, string][]) {
    const bad = await upload(owner, a.id, t, o);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, error);
  }
  assert.equal(await count("SELECT COUNT(*) AS n FROM assistant_files WHERE assistant_id = ?", [a.id]), 2);
});

test("files are refused, never cut: over 1,000,000 characters, over 2,000,000 for the assistant, a 21st, or the same text twice", async () => {
  const owner = await account("lite");
  const a = await made(owner);
  const over = await upload(owner, a.id, fresh(1_000_001));
  assert.equal(over.status, 413);
  assert.equal(over.body.error, "A file can keep up to 1,000,000 characters.");
  assert.equal(await count("SELECT COUNT(*) AS n FROM assistant_files WHERE assistant_id = ?", [a.id]), 0);

  const million = fresh(1_000_000);
  const one1 = await upload(owner, a.id, million);
  assert.equal(one1.status, 200, one1.body.error);
  assert.equal((one1.body.file as { exact: boolean }).exact, false, "a long file's count is an estimate");
  const twice = await upload(owner, a.id, million, { name: "Copy of notes.txt" });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.error, "This file is already in this assistant.");
  assert.equal((await upload(owner, a.id, fresh(1_000_000))).status, 200);
  const full = await upload(owner, a.id, fresh(1));
  assert.equal(full.status, 409);
  assert.equal(full.body.error, "This assistant's files are full: up to 2,000,000 characters in all.");
  assert.equal(await count("SELECT COALESCE(SUM(chars), 0) AS n FROM assistant_files WHERE assistant_id = ?", [a.id]), 2_000_000);
  const chunks = await all<{ body: string }>("SELECT body FROM assistant_chunks WHERE assistant_id = ? AND file_id = ? ORDER BY seq", [a.id, (one1.body.file as { id: string }).id]);
  assert.equal(chunks.map((c) => c.body).join(""), million, "all of it, in chunks");

  // The same text in another assistant is its own file.
  const b = await made(owner, { name: "Second helper" });
  assert.equal((await upload(owner, b.id, million)).status, 200);

  const c = await made(owner, { name: "Twenty files" });
  for (let i = 0; i < 20; i++) assert.equal((await upload(owner, c.id, fresh(50))).status, 200);
  const more = await upload(owner, c.id, fresh(50));
  assert.equal(more.status, 409);
  assert.equal(more.body.error, "This assistant already has 20 files.");
  assert.equal(await count("SELECT COUNT(*) AS n FROM assistant_files WHERE assistant_id = ?", [c.id]), 20);
});

test("storage: an assistant's text counts three times its bytes against the owner's room, checked in the statement that adds it", async () => {
  const owner = await account();
  const a = await made(owner);
  const b = await made(owner, { name: "Big helper" });
  // Another of the owner's assistants already takes all but 2 MB.
  await run(
    "INSERT INTO assistant_files (id, assistant_id, name, kind, chars, bytes, stored, tokens, hash, created_at) VALUES ('hog', ?, 'big.txt', 'text', 1, 1, ?, 1, 'hog', 0)",
    [b.id, FREE_STORAGE_BYTES - 2 * 1024 * 1024],
  );
  const big = fresh(700_000);
  asked.length = 0;
  const refused = await upload(owner, a.id, big);
  assert.equal(refused.status, 507);
  assert.equal(refused.body.error, "Not enough storage for this file: 98 MB of 100 MB used.");
  assert.equal(asked.length, 0, "refused before it's counted");
  assert.equal(await used(`assistant-chars:${owner.id}`), 0, "nor does it use the day's text");
  assert.equal((await upload(owner, a.id, fresh(690_000))).status, 200, "3 × 690,000 bytes fit in 2 MB");

  // Two uploads that each fit alone: the one that comes second is refused by the statement itself.
  const racer = await account();
  const r = await made(racer);
  const hogged = await made(racer, { name: "Hog" });
  const client = await db();
  const execute = client.execute;
  client.execute = async function (this: typeof client, ...args: Parameters<typeof execute>) {
    if (sqlText(args[0]).trimStart().startsWith("INSERT INTO assistant_files")) {
      client.execute = execute;
      await run(
        "INSERT INTO assistant_files (id, assistant_id, name, kind, chars, bytes, stored, tokens, hash, created_at) VALUES ('hog2', ?, 'big.txt', 'text', 1, 1, ?, 1, 'hog2', 0)",
        [hogged.id, FREE_STORAGE_BYTES - 1000],
      );
    }
    return execute.apply(this, args);
  } as typeof execute;
  const late = await upload(racer, r.id, fresh(1000));
  client.execute = execute;
  assert.equal(late.status, 507);
  assert.equal(await count("SELECT COUNT(*) AS n FROM assistant_files WHERE assistant_id = ?", [r.id]), 0);
  assert.equal(await used(`assistant-chars:${racer.id}`), 0, "and the day's text it took is given back");

  // A paid plan's room is bigger.
  const paid = await account("lite");
  const p = await made(paid);
  const pb = await made(paid, { name: "Big helper" });
  await run(
    "INSERT INTO assistant_files (id, assistant_id, name, kind, chars, bytes, stored, tokens, hash, created_at) VALUES ('hog3', ?, 'big.txt', 'text', 1, 1, ?, 1, 'hog3', 0)",
    [pb.id, FREE_STORAGE_BYTES],
  );
  assert.equal((await upload(paid, p.id, big)).status, 200);
  const room = (await get(paid, p.id)).body.assistant as { storage: { used: number; limit: number } };
  assert.deepEqual(room.storage, { used: FREE_STORAGE_BYTES + 3 * bytes(big), limit: 1024 * 1024 * 1024 });

  // An app's files share the room too, and its upload checks it in the statement that keeps the
  // file: an assistant file added while the app's file was being scanned can't take the two past it.
  const shop = await account();
  const s1 = await made(shop);
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at, uploads_on) VALUES ('race-shop', ?, 'Shop', '<p>', 0, 0, 1)", [shop.id]);
  await run("INSERT INTO site_uploads (id, site_slug, owner, mime, name, data, size, created_at) VALUES ('old', 'race-shop', '', 'text/plain', 'old.txt', x'00', ?, 0)", [FREE_STORAGE_BYTES - 1024 * 1024]);
  const notes = fresh(200_000);
  const photo = { name: "photo.txt", type: "text/plain", bytes: Buffer.alloc(600 * 1024, 97) };
  assert.ok(3 * bytes(notes) <= 1024 * 1024 && photo.bytes.length <= 1024 * 1024 && 3 * bytes(notes) + photo.bytes.length > 1024 * 1024, "each fits alone, not both");
  /** saveUpload, with `first` run just before it keeps the file. */
  const appUpload = (file: typeof photo, first: () => Promise<unknown>) => {
    client.execute = async function (this: typeof client, ...args: Parameters<typeof execute>) {
      if (sqlText(args[0]).trimStart().startsWith("INSERT INTO site_uploads")) {
        client.execute = execute;
        await first();
      }
      return execute.apply(this, args);
    } as typeof execute;
    return saveUpload("race-shop", file, "").finally(() => (client.execute = execute));
  };
  const app = await appUpload(photo, async () => assert.equal((await upload(shop, s1.id, notes)).status, 200, "the assistant's file came first"));
  assert.equal(app.status, 507);
  assert.deepEqual(app.body, { error: "This app can't hold more files. Its owner can remove some in Flash." });
  assert.ok((await usedStorage(shop.id)) <= FREE_STORAGE_BYTES, "within the plan's room");
  assert.equal(await count("SELECT COUNT(*) AS n FROM site_uploads WHERE site_slug = 'race-shop'"), 1);
  // It still takes a file that fits; one sent as the owner turns files off still isn't found.
  assert.equal((await saveUpload("race-shop", { ...photo, bytes: Buffer.alloc(1000, 97) }, "")).status, 201);
  const off = await appUpload({ ...photo, bytes: Buffer.alloc(1000, 98) }, () => run("UPDATE sites SET uploads_on = 0 WHERE slug = 'race-shop'"));
  assert.deepEqual([off.status, off.body], [404, { error: "App not found." }]);
});

test("the day's text: 2,000,000 characters free and 10,000,000 on a paid plan, refused before it's counted", async () => {
  const owner = await account();
  const a = await made(owner);
  const key = `assistant-chars:${owner.id}`;
  await spent(key, DAILY_TEXT_FREE - 10, DAY);
  asked.length = 0;
  const over = await upload(owner, a.id, fresh(11));
  assert.equal(over.status, 429);
  assert.equal(over.body.error, "You've added a lot of text today. Try again tomorrow.");
  assert.equal(asked.length, 0, "nothing counted");
  assert.equal(await used(key), DAILY_TEXT_FREE - 10, "a refused file doesn't use the day's text");
  assert.equal((await upload(owner, a.id, fresh(10))).status, 200);
  assert.equal(await used(key), DAILY_TEXT_FREE);
  // A refused file (here the same one again) doesn't use any either.
  const paid = await account("pro");
  const p = await made(paid);
  const pkey = `assistant-chars:${paid.id}`;
  await spent(pkey, DAILY_TEXT_FREE + 500_000, DAY);
  const text = fresh(1000);
  assert.equal((await upload(paid, p.id, text)).status, 200, "a paid plan has more");
  assert.equal((await upload(paid, p.id, text)).status, 409);
  assert.equal(await used(pkey), DAILY_TEXT_FREE + 501_000);
  await spent(pkey, DAILY_TEXT_PAID - 10, DAY);
  assert.equal((await upload(paid, p.id, fresh(11))).status, 429);

  await spent(`assistant-file:${owner.id}`, 60);
  const many = await upload(owner, a.id, fresh(10));
  assert.equal(many.status, 429);
  assert.equal(many.body.error, "You've added a lot of files. Try again in an hour.");
});

test("the day's text is taken in the statement that counts it: two uploads at once take it one at a time, and a file that isn't kept gives it back", async () => {
  const owner = await account();
  const a = await made(owner);
  const key = `assistant-chars:${owner.id}`;
  const outcome = (r: PromiseSettledResult<unknown>) => (r.status === "fulfilled" ? "kept" : (r.reason as InstanceType<typeof server.AssistantError>).refusal.code);

  // The same file twice at once, both inside what's left: one is kept, the other is the duplicate,
  // and only the one kept counts. Neither is counted until both have taken their characters.
  await spent(key, DAILY_TEXT_FREE - 2500, DAY);
  const same = fresh(1000);
  holdFor = 2 * MODELS.length;
  const twice = await Promise.allSettled([0, 1].map(() => server.addAssistantFile(owner.id, a.id, { name: "Notes.txt", kind: "text", text: same })));
  assert.deepEqual(twice.map(outcome).sort(), ["duplicate", "kept"]);
  assert.equal(await used(key), DAILY_TEXT_FREE - 1500, "1,000 characters added, 1,000 counted");
  assert.equal((await upload(owner, a.id, fresh(1400))).status, 200, "so 1,400 more still fit");

  // Two files at once that each fit in what's left, but not both: the first is kept and the other
  // refused, with only the first counted, so a small file still fits after.
  await spent(key, DAILY_TEXT_FREE - 1500, DAY);
  const both = await Promise.allSettled([fresh(1000), fresh(1000)].map((text) => server.addAssistantFile(owner.id, a.id, { name: "Notes.txt", kind: "text", text })));
  assert.deepEqual(both.map(outcome).sort(), ["daily_text", "kept"]);
  assert.equal(await used(key), DAILY_TEXT_FREE - 500);
  assert.equal((await upload(owner, a.id, fresh(500))).status, 200);

  // Storing fails: the upload is refused, nothing is kept, the day's text is given back, and the
  // assistant is as the editor read it, so the editor's next save goes through.
  const client = await db();
  const batch = client.batch;
  /** An upload whose batch with a statement starting `at` fails (its chunks, unless told), after `first` runs. */
  const failing = async (who: Who, id: string, first: () => Promise<unknown> = async () => {}, at = "INSERT INTO assistant_chunks") => {
    client.batch = async function (this: typeof client, ...args: Parameters<typeof batch>) {
      if (!args[0].some((st) => sqlText(st).startsWith(at))) return batch.apply(this, args);
      await first();
      throw new Error("database busy");
    } as typeof batch;
    return upload(who, id, fresh(5000)).finally(() => (client.batch = batch));
  };
  await spent(key, 0, DAY);
  const read1 = (await get(owner, a.id)).body.assistant as Made;
  const files = await count("SELECT COUNT(*) AS n FROM assistant_files WHERE assistant_id = ?", [a.id]);
  const failed = await failing(owner, a.id);
  assert.equal(failed.status, 500);
  assert.equal(failed.body.error, "Something went wrong. Please try again.");
  assert.equal(await count("SELECT COUNT(*) AS n FROM assistant_files WHERE assistant_id = ?", [a.id]), files, "nothing kept");
  assert.equal(await count("SELECT COUNT(*) AS n FROM assistant_chunks WHERE assistant_id = ? AND file_id NOT IN (SELECT id FROM assistant_files)", [a.id]), 0);
  assert.equal(await used(key), 0, "the day's text it took is given back");
  const after = (await get(owner, a.id)).body.assistant as Made;
  assert.equal(after.version, read1.version, "no new version for a file that isn't there");
  const saved = await put(owner, a.id, { version: read1.version, description: "Saved after a failed upload" });
  assert.equal(saved.status, 200, saved.body.error);

  // Stored, but its new version can't be written: the file and all its chunks go too.
  const chunks = await count("SELECT COUNT(*) AS n FROM assistant_chunks WHERE assistant_id = ?", [a.id]);
  const unversioned = await failing(owner, a.id, async () => {}, "UPDATE assistants SET version");
  assert.equal(unversioned.status, 500);
  assert.equal(await count("SELECT COUNT(*) AS n FROM assistant_files WHERE assistant_id = ?", [a.id]), files);
  assert.equal(await count("SELECT COUNT(*) AS n FROM assistant_chunks WHERE assistant_id = ?", [a.id]), chunks);
  assert.equal(await used(key), 0);

  // What's given back goes to the day it was taken from only: if the day ends while the file is
  // stored (and the next has had 100 characters), the new day isn't given more.
  const lost = await failing(owner, a.id, () => run("UPDATE rate_limits SET count = 100, reset_at = ? WHERE key = ?", [Date.now() + 2 * DAY, key]));
  assert.equal(lost.status, 500);
  assert.equal(await used(key), 100, "the new day keeps its 100");
});

// A body that never ends would hang a request that reads it all: this fails instead.
test("an upload over 3,000,000 bytes is refused before it's read, however it comes", { timeout: 60_000 }, async () => {
  const owner = await account("lite");
  const a = await made(owner);
  const path = `/api/assistants/${a.id}/files`;
  /** A body that counts what's read of it, and never ends unless told to. */
  const endless = (limit = Infinity) => {
    const pulled = { bytes: 0 };
    const chunk = new Uint8Array(64 * 1024).fill(97);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled.bytes >= limit) return controller.close();
        pulled.bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    return { pulled, body };
  };
  const streamed = (body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { cookie: owner.cookie, origin: ORIGIN, "content-type": "multipart/form-data; boundary=x", ...headers },
      body,
      duplex: "half",
    } as RequestInit);

  asked.length = 0;
  // It says it's bigger: nothing is read.
  const said = endless();
  const r1 = await read(await filesRoute.POST(streamed(said.body, { "content-length": String(UPLOAD_CAP + 1) }), ctx({ id: a.id })));
  assert.equal(r1.status, 413);
  assert.equal(r1.body.error, "Files must be 3 MB or smaller.");
  assert.ok(said.pulled.bytes <= 64 * 1024 * 2, `read ${said.pulled.bytes} bytes`);

  // It doesn't say, and goes on far past the cap: stopped once it's over.
  const quiet = endless(4 * UPLOAD_CAP);
  const r2 = await read(await filesRoute.POST(streamed(quiet.body), ctx({ id: a.id })));
  assert.equal(r2.status, 413);
  assert.ok(quiet.pulled.bytes <= UPLOAD_CAP + 3 * 64 * 1024, `read ${quiet.pulled.bytes} bytes`);

  // The form fits, its text doesn't: measured, not read.
  const big = new Blob([new Uint8Array(lib.MAX_UPLOAD_BYTES + 1).fill(97)], { type: "text/plain" });
  const blobText = Blob.prototype.text;
  let readParts = 0;
  Blob.prototype.text = function (this: Blob) {
    readParts++;
    return blobText.call(this);
  };
  const r3 = await read(await filesRoute.POST(request("POST", path, owner, { form: form(big) }), ctx({ id: a.id }))).finally(() => (Blob.prototype.text = blobText));
  assert.equal(readParts, 0, "the text part wasn't read");
  assert.equal(r3.status, 413);
  assert.equal(r3.body.error, "Files must be 3 MB or smaller.");
  assert.equal(asked.length, 0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM assistant_files WHERE assistant_id = ?", [a.id]), 0);
  assert.equal(await used(`assistant-chars:${owner.id}`), 0);

  // Asked of directly, the same holds: more bytes than that is refused as too big.
  await assert.rejects(server.addAssistantFile(owner.id, a.id, { name: "big.txt", kind: "text", text: "面".repeat(1_000_001) }), (err: InstanceType<typeof server.AssistantError>) => err.refusal.code === "upload_big");
  // 3,000,000 bytes of Chinese is 1,000,000 characters: it fits.
  const chinese = "面".repeat(1_000_000);
  assert.equal(bytes(chinese), lib.MAX_UPLOAD_BYTES);
  assert.equal((await upload(owner, a.id, chinese)).status, 200);

  // Before a proxy runs, Next reads the request's whole body (see src/proxy.ts), so the upload is
  // left out of it, as Next itself reads the matcher: the route gets the body unread.
  const { config } = await import("../src/proxy.ts");
  const { getMiddlewareMatchers } = createRequire(import.meta.url)("next/dist/build/analysis/get-page-static-info.js");
  const matchers = (getMiddlewareMatchers(config.matcher, {}) as { regexp: string }[]).map((m) => new RegExp(m.regexp));
  const proxied = (p: string) => matchers.some((m) => m.test(p));
  assert.equal(proxied(path), false, "an upload isn't read before its route");
  for (const p of ["/", "/api/assistants", `/api/assistants/${a.id}`, `/api/assistants/${a.id}/files/f1`, `/api/assistants/${a.id}/chats`, "/api/sites/shop/files", "/p/shop", "/oauth/authorize"]) {
    assert.ok(proxied(p), `the proxy still runs for ${p}`);
  }
  assert.equal(proxied("/_next/static/app.js"), false);
});

test("deleting a file takes its chunks and their index rows, and gives the assistant a new version", async () => {
  const owner = await account();
  const stranger = await account();
  const a = await made(owner);
  const keep = await upload(owner, a.id, fresh(5000));
  const gone = await upload(owner, a.id, fresh(5000));
  const fileId = (gone.body.file as { id: string }).id;
  const ids = (await all<{ id: number }>("SELECT id FROM assistant_chunks WHERE file_id = ?", [fileId])).map((c) => Number(c.id));
  assert.ok(ids.length > 1);
  const indexed = () => count(`SELECT COUNT(*) AS n FROM assistant_chunks_fts WHERE rowid IN (${ids.join(",")})`);
  assert.equal(await indexed(), ids.length);

  assert.equal((await removeFile(stranger, a.id, fileId)).status, 404);
  assert.equal(await count("SELECT COUNT(*) AS n FROM assistant_chunks WHERE file_id = ?", [fileId]), ids.length);
  const r = await removeFile(owner, a.id, fileId);
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 3, "made, two uploads, a delete");
  assert.equal(await count("SELECT COUNT(*) AS n FROM assistant_chunks WHERE file_id = ?", [fileId]), 0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM assistant_files WHERE id = ?", [fileId]), 0);
  assert.equal(await indexed(), 0);
  assert.equal((await removeFile(owner, a.id, fileId)).status, 404, "it's gone");
  assert.equal(await count("SELECT COUNT(*) AS n FROM assistant_files WHERE id = ?", [(keep.body.file as { id: string }).id]), 1);
});

test("deleting an assistant, or all of an account's, leaves no row behind with foreign keys off, in every table that keeps one", async () => {
  assert.equal(Number((await one<{ foreign_keys: number }>("PRAGMA foreign_keys"))?.foreign_keys), 0);
  // Every table with an assistant_id column, read from the database itself, so one added later
  // without being listed in ASSISTANT_TABLES fails here. A chat keeps its messages on purpose.
  const tables: string[] = [];
  for (const { name } of await all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")) {
    if ((await all<{ name: string }>(`PRAGMA table_info(${name})`)).some((c) => c.name === "assistant_id")) tables.push(name);
  }
  assert.deepEqual([...ASSISTANT_TABLES, "projects"].sort(), tables, "deleting knows every table that keeps something for an assistant");

  /** A row for the assistant in a table, with something in each column that must have a value. */
  let n = 0;
  const seed = async (table: string, assistantId: string, extra: Record<string, string> = {}) => {
    const columns = await all<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>(`PRAGMA table_info(${table})`);
    // Every column that must have a value, and a primary key that isn't a row number.
    const filled = columns.filter((c) => c.name === "assistant_id" || c.name in extra || ((Number(c.notnull) || (Number(c.pk) && !/INT/i.test(c.type))) && c.dflt_value === null));
    const value = (c: { name: string; type: string }) => (c.name === "assistant_id" ? assistantId : c.name in extra ? extra[c.name] : /INT/i.test(c.type) ? ++n : `${table}-${c.name}-${++n}`);
    await run(`INSERT INTO ${table} (${filled.map((c) => c.name).join(", ")}) VALUES (${filled.map(() => "?").join(", ")})`, filled.map(value));
  };
  const rowsFor = async (ids: string[]) => {
    const out: Record<string, number> = {};
    for (const table of ASSISTANT_TABLES) out[table] = await count(`SELECT COUNT(*) AS n FROM ${table} WHERE assistant_id IN (${ids.map(() => "?").join(",")})`, ids);
    out.assistants = await count(`SELECT COUNT(*) AS n FROM assistants WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
    return out;
  };
  const none = Object.fromEntries([...ASSISTANT_TABLES, "assistants"].map((t) => [t, 0]));

  const owner = await account();
  const other = await account();
  const a = await made(owner);
  await upload(owner, a.id, fresh(4000));
  for (const table of ASSISTANT_TABLES) await seed(table, a.id);
  const chat = await startChat(owner, a.id);
  const theirs = await made(other);
  await upload(other, theirs.id, fresh(4000));
  const chunkIds = (await all<{ id: number }>("SELECT id FROM assistant_chunks WHERE assistant_id = ?", [a.id])).map((c) => Number(c.id));

  assert.equal((await remove(other, a.id)).status, 404);
  assert.notDeepEqual(await rowsFor([a.id]), none);
  const r = await remove(owner, a.id);
  assert.equal(r.status, 200);
  assert.deepEqual(await rowsFor([a.id]), none);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM assistant_chunks_fts WHERE rowid IN (${chunkIds.join(",")})`), 0, "and its index rows");
  assert.equal(await count("SELECT COUNT(*) AS n FROM projects WHERE id = ?", [(chat.body.project as { id: string }).id]), 1, "the chat keeps its messages");
  assert.equal((await rowsFor([theirs.id])).assistant_files, 1, "someone else's assistant is as it was");
  assert.equal((await get(owner, a.id)).status, 404);

  // An account's: every assistant it has and everything kept for them, and its own visits to other people's.
  const leaving = await account();
  const mine = [await made(leaving), await made(leaving, { name: "Second helper" })];
  for (const m of mine) {
    await upload(leaving, m.id, fresh(3000));
    for (const table of ASSISTANT_TABLES) await seed(table, m.id);
  }
  await seed("assistant_visitors", theirs.id, { user_id: leaving.id });
  await seed("assistant_visitors", mine[0].id, { user_id: other.id });
  const before = await rowsFor([theirs.id]);
  await deleteUserAssistants(leaving.id);
  assert.deepEqual(await rowsFor(mine.map((m) => m.id)), none);
  assert.equal(await count("SELECT COUNT(*) AS n FROM assistant_visitors WHERE user_id = ?", [leaving.id]), 0);
  assert.deepEqual(await rowsFor([theirs.id]), { ...before, assistant_visitors: before.assistant_visitors - 1 }, "only the leaving account's visit to it went");
});

test("starting a chat with an assistant makes a chat that keeps its id, named after it", async () => {
  const owner = await account();
  const a = await made(owner, { name: "Sourdough coach" });
  const r = await startChat(owner, a.id);
  assert.equal(r.status, 200, r.body.error);
  const project = r.body.project as { id: string; name: string; assistantId: string };
  assert.equal(project.assistantId, a.id);
  const saved = await one<{ user_id: string; name: string; assistant_id: string; messages: string }>("SELECT * FROM projects WHERE id = ?", [project.id]);
  assert.deepEqual({ ...saved }, { ...saved, user_id: owner.id, name: "Sourdough coach", assistant_id: a.id, messages: "[]" });
  await spent(`assistant-start:${owner.id}`, 30);
  const limited = await startChat(owner, a.id);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "Too many requests. Try again in an hour.");
});

test("every write is taken only from Flash's own page, with its exact Origin and the body it sends", async () => {
  const owner = await account();
  const a = await made(owner);
  const up = await upload(owner, a.id, fresh(300));
  const fileId = (up.body.file as { id: string }).id;
  const wrong: Sent[] = [
    { origin: "https://evil.example" },
    { origin: null },
    { origin: "null" },
    { headers: { "sec-fetch-site": "cross-site" } },
  ];
  for (const o of wrong) {
    const results = [
      await make(owner, { name: "Planted" }, o),
      await put(owner, a.id, { version: 1, name: "Planted" }, o),
      await remove(owner, a.id, o),
      await upload(owner, a.id, fresh(100), o),
      await removeFile(owner, a.id, fileId, o),
      await startChat(owner, a.id, o),
    ];
    for (const r of results) {
      assert.equal(r.status, 403, JSON.stringify(o));
      assert.equal(r.body.error, "Please use Flash's own page.");
    }
  }
  // A form on another page can send text, not JSON; an upload is a form with a file, nothing else.
  assert.equal((await make(owner, { name: "Planted" }, { type: "text/plain" })).status, 403);
  assert.equal((await put(owner, a.id, { version: 1, name: "Planted" }, { type: "application/x-www-form-urlencoded" })).status, 403);
  const asJson = await read(await filesRoute.POST(request("POST", `/api/assistants/${a.id}/files`, owner, { json: { name: "x", kind: "text", text: "planted" } }), ctx({ id: a.id })));
  assert.equal(asJson.status, 403);

  const kept = (await get(owner, a.id)).body.assistant as Made;
  assert.deepEqual([kept.name, kept.version, kept.files.length], ["Bakery helper", 1, 1], "nothing changed");
  assert.equal(await count("SELECT COUNT(*) AS n FROM assistants WHERE user_id = ?", [owner.id]), 1);
  assert.equal(await count("SELECT COUNT(*) AS n FROM projects WHERE assistant_id = ?", [a.id]), 0);
});

test("every refusal has its words in every language, with numbers written the way that language writes them", async () => {
  const { english, localeOf, translate } = await import("../src/lib/i18n.ts");
  const { refusalText } = await import("../src/lib/server/assistant-routes.ts");
  type T = Parameters<typeof refusalText>[1];
  const tableOf = (id: string) => JSON.parse(readFileSync(new URL(`../src/lib/i18n/${id}.json`, import.meta.url), "utf8")) as Record<string, string>;
  const tIn = (id: string, table: Record<string, string>): T => Object.assign((text: string, blanks?: Record<string, string | number>) => translate(table, text, blanks), { language: id, locale: localeOf(id) });
  const MB = 1024 * 1024;
  const samples: Parameters<typeof refusalText>[0][] = [
    { code: "name_missing" },
    { code: "name_long", max: 60 },
    { code: "name_kept" },
    { code: "description_long", max: 300 },
    { code: "instructions_long", max: 8000, count: 8001 },
    { code: "starters", max: 6, chars: 200 },
    { code: "too_many_assistants", max: 50 },
    { code: "version_conflict", version: 3 },
    { code: "too_many_files", max: 20 },
    { code: "duplicate" },
    { code: "assistant_full", chars: 2_000_000 },
    { code: "file_long", chars: 1_000_000 },
    { code: "upload_big", bytes: 3_000_000 },
    { code: "bad_file" },
    { code: "storage", used: 98.5 * MB, limit: 100 * MB },
    { code: "daily_text" },
    { code: "not_found" },
    { code: "failed" },
  ];
  // The phrase each refusal is written with, as English has it.
  const phrases: string[] = [];
  const spy = Object.assign((text: string, blanks?: Record<string, string | number>) => (phrases.push(text), english(text, blanks)), { language: "en", locale: "en-US" }) as T;
  for (const r of samples) refusalText(r, spy);
  assert.equal(new Set(phrases.filter((p) => !/^\{size\} [KM]B$/.test(p))).size, samples.length, "each refusal says something of its own");
  const ids = readdirSync(new URL("../src/lib/i18n/", import.meta.url)).map((f) => f.replace(/\.json$/, ""));
  assert.equal(ids.length, 29);
  for (const id of ids) {
    const table = tableOf(id);
    const missing = phrases.filter((p) => !table[p]?.trim());
    assert.deepEqual(missing, [], `${id} has every refusal's words`);
  }
  const de = tIn("de", tableOf("de"));
  assert.equal(refusalText({ code: "instructions_long", max: 8000, count: 8001 }, de), "Anweisungen dürfen höchstens 8.000 Zeichen lang sein. Deine haben 8.001.");
  assert.equal(refusalText({ code: "storage", used: 98.5 * MB, limit: 100 * MB }, de), "Nicht genug Speicherplatz für diese Datei: 98,5 MB von 100 MB belegt.");
  assert.equal(refusalText({ code: "storage", used: 2048, limit: 100 * MB }, spy), "Not enough storage for this file: 2 KB of 100 MB used.");
  const hi = tIn("hi", tableOf("hi"));
  assert.equal(refusalText({ code: "assistant_full", chars: 2_000_000 }, hi), tableOf("hi")["This assistant's files are full: up to {chars} characters in all."].replace("{chars}", (2_000_000).toLocaleString(localeOf("hi"))));
});
