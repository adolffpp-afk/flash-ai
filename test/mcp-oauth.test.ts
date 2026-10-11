import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import type { AddressInfo } from "node:net";

/*
 * One-click sign-in for MCP servers (OAuth 2.1, see mcp-oauth.ts), run against the stand-in
 * authorization server of scripts/mock-connectors.ts and through Flash's own routes (start, callback,
 * the Client ID Metadata Document, Settings > Connectors). Nothing here reaches a real service, and no
 * model is called: signing in, refreshing and signing out cost nothing.
 */
register("./support/route-hooks.mjs", import.meta.url);

process.env.DATABASE_URL = ":memory:";
process.env.CONNECTOR_KEYS = JSON.stringify({ v1: randomBytes(32).toString("base64") });
delete process.env.VERCEL_ENV;
delete process.env.RESEND_API_KEY;

const { startMockConnectors } = await import("../scripts/mock-connectors.ts");
const mock = await startMockConnectors(0);
process.env.FLASH_CONNECT_MOCK = mock.origin;

// Flash's own address in these tests: it serves the Client ID Metadata Document (through its route)
// that the stand-in authorization server fetches.
const cimdRoute = await import("../src/app/oauth/mcp-client.json/route.ts");
const flashServer = createServer(async (req, res) => {
  if (req.url !== "/oauth/mcp-client.json") return void res.writeHead(404).end();
  const answer = cimdRoute.GET(new Request(`${FLASH}${req.url}`));
  res.writeHead(answer.status, { "content-type": "application/json" });
  res.end(await answer.text());
});
await new Promise<void>((r) => flashServer.listen(0, "127.0.0.1", r));
const FLASH = `http://127.0.0.1:${(flashServer.address() as AddressInfo).port}`;
process.env.FLASH_APP_URL = FLASH;
after(async () => {
  flashServer.close();
  await mock.close();
});

const { all, one, run: sql } = await import("../src/lib/server/db.ts");
const oauth = await import("../src/lib/server/mcp-oauth.ts");
const { chatKit, failedText, listConnections } = await import("../src/lib/server/connections.ts");
const { translate } = await import("../src/lib/i18n.ts");
const startRoute = await import("../src/app/api/connect/mcp/start/route.ts");
const callbackRoute = await import("../src/app/api/connect/mcp/callback/route.ts");
const connectRoute = await import("../src/app/api/connect/route.ts");
const connectIdRoute = await import("../src/app/api/connect/[id]/route.ts");
const actionRoute = await import("../src/app/api/connect/actions/[id]/route.ts");

const SERVER = `${mock.origin}/oauth/mcp`;
const ISSUER = `${mock.origin}/as`;

beforeEach(() => mock.reset());

/** A user with a session (confirmed unless told otherwise). */
async function account(id: string, { verified = true } = {}) {
  const token = `tok_${id}_${randomBytes(6).toString("hex")}`;
  await sql("INSERT INTO users (id, email, name, password_hash, preferences, created_at, last_free_grant, verified_at) VALUES (?, ?, '', 'x', '', 0, 0, ?)", [
    id,
    `${id}@example.com`,
    verified ? 1 : 0,
  ]);
  await sql("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [createHash("sha256").update(token).digest("hex"), id, Date.now() + 3600_000]);
  return { id, cookie: `flash_session=${token}` };
}
type Account = Awaited<ReturnType<typeof account>>;

const post = (path: string, user: Account, body: object, origin: string | null = FLASH) =>
  new Request(`${FLASH}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: user.cookie, ...(origin !== null && { origin }) },
    body: JSON.stringify(body),
  });

/** POST /api/connect/mcp/start: the sign-in page's address, or the refusal. */
async function start(user: Account, body: object, origin: string | null = FLASH) {
  const res = await startRoute.POST(post("/api/connect/mcp/start", user, body, origin));
  return { status: res.status, body: (await res.json()) as { url?: string; error?: string; code?: string } };
}

/** The stand-in's sign-in page, which says yes at once: where it sends the browser back. */
async function authorize(url: string): Promise<URL> {
  const res = await fetch(url, { redirect: "manual" });
  assert.equal(res.status, 302, `the authorize page answered ${res.status}: ${await res.text()}`);
  return new URL(res.headers.get("location")!);
}

/** GET /api/connect/mcp/callback as the browser comes back, as `user`: how it ended (?connect=). */
async function callback(user: Account, back: URL) {
  const res = await callbackRoute.GET(new Request(`${FLASH}/api/connect/mcp/callback${back.search}`, { headers: { cookie: user.cookie } }));
  assert.equal(res.status, 303);
  const location = res.headers.get("location")!;
  return { outcome: new URL(location).searchParams.get("connect"), location };
}

/** Start, sign in, come back: how it ended. */
async function connect(user: Account, body: object) {
  const started = await start(user, body);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return (await callback(user, await authorize(started.body.url!))).outcome;
}

const connectionsOf = (userId: string) => all<Record<string, unknown>>("SELECT * FROM connections WHERE user_id = ? ORDER BY created_at", [userId]);
const flowsOf = async (userId: string) => Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM connect_flows WHERE user_id = ?", [userId]))!.n);
/** Everything the database holds, as text, to look for what must never be there. */
async function databaseText() {
  const tables = await all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
  const parts: string[] = [];
  for (const { name } of tables) parts.push(JSON.stringify(await all(`SELECT * FROM ${name}`)));
  return parts.join("\n");
}
/** What Flash logs while fn runs. */
async function logsOf(fn: () => Promise<unknown>) {
  const lines: string[] = [];
  const keep = { log: console.log, error: console.error };
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    Object.assign(console, keep);
  }
  return lines.join("\n");
}

test("Flash's Client ID Metadata Document: its own address as client_id, the callback, and no secret", async () => {
  const res = cimdRoute.GET(new Request(`${FLASH}/oauth/mcp-client.json`));
  const doc = (await res.json()) as Record<string, unknown>;
  assert.equal(doc.client_id, `${FLASH}/oauth/mcp-client.json`);
  assert.deepEqual(doc.redirect_uris, [`${FLASH}/api/connect/mcp/callback`]);
  assert.equal(doc.token_endpoint_auth_method, "none");
  assert.deepEqual(doc.grant_types, ["authorization_code", "refresh_token"]);
  assert.ok(!("client_secret" in doc));
});

test("a preset connects with no key: sign-in, a read in a chat, and no token anywhere it shouldn't be", async () => {
  const user = await account("preset-user");
  const log = await logsOf(async () => assert.equal(await connect(user, { provider: "notion" }), "ok"));
  const [row] = await connectionsOf(user.id);
  assert.equal(row.kind, "oauth");
  assert.equal(row.status, "ok");
  assert.equal(row.issuer, ISSUER);
  assert.equal(row.resource, `${mock.origin}/presets/notion/mcp`);
  assert.ok(String(row.enc_access).startsWith("v1:") && String(row.enc_refresh).startsWith("v1:"), "both tokens are sealed");
  assert.equal(await flowsOf(user.id), 0, "the flow was used up");

  // Settings shows it signed in, with its tools, and never a token.
  const listed = await connectRoute.GET(new Request(`${FLASH}/api/connect`, { headers: { cookie: user.cookie } }));
  const text = await listed.text();
  const view = (JSON.parse(text) as { connections: { signIn: boolean; status: string; tools: unknown[]; last4: string }[] }).connections[0];
  assert.equal(view.signIn, true);
  assert.equal(view.status, "ok");
  assert.equal(view.last4, "");
  assert.ok(view.tools.length > 3);

  // A reply reads with it: the server gets the access token, and only in its Authorization header.
  const kit = (await chatKit(user.id, [String(row.id)]))!;
  const { tools, changed } = await kit.check();
  // Its tools are as they were when it was signed in, but for the mock's "changing" tool, which says
  // something new after its first listing on purpose.
  assert.deepEqual(changed, ["Notion"]);
  assert.equal(tools.length, view.tools.length - 1);
  assert.ok(!tools.some((t) => t.tool === "changing"));
  const echo = tools.find((t) => t.tool === "echo")!;
  assert.deepEqual(await kit.run(echo, { text: "hello" }), { text: "hello", isError: false });
  await kit.close();
  const call = mock.calls.find((c) => c.name === "echo")!;
  assert.match(call.headers.authorization, /^Bearer at_/);

  const tokens = mock.tokens();
  assert.ok(tokens.length >= 2);
  const db = await databaseText();
  for (const token of tokens) {
    assert.ok(!db.includes(token), "no token in the database");
    assert.ok(!text.includes(token), "none in what Settings gets");
    assert.ok(!log.includes(token), "none in the logs");
  }
});

test("discovery order: the protected resource from WWW-Authenticate, else its path, else the root", async () => {
  mock.state.oauth.prm = "header";
  await oauth.planSignIn(SERVER);
  assert.deepEqual(mock.oauthLog.metadata.slice(0, 2), ["/meta/prm/oauth/mcp", "/.well-known/oauth-authorization-server/as"]);

  mock.reset();
  mock.state.oauth.prm = "path";
  await oauth.planSignIn(SERVER);
  assert.deepEqual(mock.oauthLog.metadata.slice(0, 2), ["/.well-known/oauth-protected-resource/oauth/mcp", "/.well-known/oauth-authorization-server/as"]);

  mock.reset();
  mock.state.oauth.prm = "root";
  const plan = await oauth.planSignIn(SERVER);
  assert.deepEqual(mock.oauthLog.metadata.slice(0, 3), [
    "/.well-known/oauth-protected-resource/oauth/mcp",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server/as",
  ]);
  assert.equal(plan.resource.resource, mock.origin, "a resource that is the server's origin is its own");
});

test("discovery order: the authorization server's three metadata addresses, in the spec's order", async () => {
  assert.deepEqual(oauth.metadataUrls("https://auth.example.com/tenant1"), [
    "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
    "https://auth.example.com/.well-known/openid-configuration/tenant1",
    "https://auth.example.com/tenant1/.well-known/openid-configuration",
  ]);
  assert.deepEqual(oauth.metadataUrls("https://auth.example.com"), [
    "https://auth.example.com/.well-known/oauth-authorization-server",
    "https://auth.example.com/.well-known/openid-configuration",
  ]);
  mock.state.oauth.metadataAt = 3;
  const server = await oauth.findAuthServer(ISSUER);
  assert.equal(server.issuer, ISSUER);
  assert.deepEqual(mock.oauthLog.metadata, [
    "/.well-known/oauth-authorization-server/as",
    "/.well-known/openid-configuration/as",
    "/as/.well-known/openid-configuration",
  ]);
  mock.reset();
  mock.state.oauth.metadataAt = 2;
  await oauth.findAuthServer(ISSUER);
  assert.deepEqual(mock.oauthLog.metadata, ["/.well-known/oauth-authorization-server/as", "/.well-known/openid-configuration/as"]);
});

test("discovery goes on past an address that answers with a web page instead of metadata", async () => {
  // An app's own page for any address (200, HTML) at the addresses tried first, the metadata at the last.
  mock.state.oauth.htmlPages = true;
  mock.state.oauth.prm = "root";
  mock.state.oauth.metadataAt = 3;
  const plan = await oauth.planSignIn(SERVER);
  assert.equal(plan.server.issuer, ISSUER);
  assert.equal(plan.resource.resource, mock.origin);
  assert.deepEqual(mock.oauthLog.metadata, [
    "/.well-known/oauth-protected-resource/oauth/mcp",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server/as",
    "/.well-known/openid-configuration/as",
    "/as/.well-known/openid-configuration",
  ]);
  // With no metadata anywhere, it says so (no sign-in), never that the page was the wrong kind.
  mock.state.oauth.prm = "header";
  await assert.rejects(oauth.planSignIn(SERVER, { challenge: "Bearer" }), (e: Error & { code?: string }) => e.code === "no_signin");
});

test("a resource that isn't the server's own is refused, and no sign-in starts", async () => {
  const user = await account("resource-user");
  for (const claimed of ["https://other.example/mcp", `${mock.origin}/other/mcp`]) {
    mock.state.oauth.resource = claimed;
    await assert.rejects(oauth.planSignIn(SERVER), (e: Error & { code?: string }) => e.code === "resource");
    const refused = await start(user, { provider: "custom", url: SERVER });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "no_signin");
  }
  assert.equal(await flowsOf(user.id), 0);
  assert.equal(oauth.resourceMatches("https://mcp.example.com/mcp", "https://mcp.example.com"), true);
  assert.equal(oauth.resourceMatches("https://mcp.example.com/mcp", "https://mcp.example.com/mcp/"), true);
  assert.equal(oauth.resourceMatches("https://mcp.example.com/mcp", "https://mcp.example.com/mcpx"), false);
  assert.equal(oauth.resourceMatches("https://mcp.example.com/mcp", "https://evil.example.com/mcp"), false);
  assert.equal(oauth.resourceMatches("https://mcp.example.com/mcp", "http://mcp.example.com/mcp"), false);
});

test("an authorization server without PKCE S256 is refused", async () => {
  const user = await account("pkce-user");
  mock.state.oauth.s256 = false;
  await assert.rejects(oauth.findAuthServer(ISSUER), (e: Error & { code?: string }) => e.code === "no_s256");
  const refused = await start(user, { provider: "notion" });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "no_signin");
  assert.equal(await flowsOf(user.id), 0);
});

test("CIMD is preferred over DCR: Flash's metadata address is its client_id, and nothing is registered", async () => {
  await sql("DELETE FROM mcp_client_registrations");
  const user = await account("cimd-user");
  mock.state.oauth.cimd = true;
  mock.state.oauth.dcr = true;
  const started = await start(user, { provider: "linear" });
  const url = new URL(started.body.url!);
  assert.equal(url.searchParams.get("client_id"), `${FLASH}/oauth/mcp-client.json`);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("resource"), `${mock.origin}/presets/linear/mcp`);
  assert.equal(url.searchParams.get("redirect_uri"), `${FLASH}/api/connect/mcp/callback`);
  assert.equal(mock.oauthLog.registrations.length, 0);
  assert.equal((await callback(user, await authorize(url.href))).outcome, "ok");
  assert.equal(mock.oauthLog.cimdFetches, 1, "the server read Flash's document");
  const rows = await all<{ method: string; owner_user_id: string | null }>("SELECT method, owner_user_id FROM mcp_client_registrations");
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ method: "cimd", owner_user_id: null }]);
});

test("a DCR registration is made once per issuer, as a web app, and shared", async () => {
  await sql("DELETE FROM mcp_client_registrations");
  mock.state.oauth.cimd = false;
  const one1 = await account("dcr-one");
  const two = await account("dcr-two");
  const first = new URL((await start(one1, { provider: "notion" })).body.url!);
  const second = new URL((await start(two, { provider: "airtable" })).body.url!);
  assert.equal(mock.oauthLog.registrations.length, 1, "registered once");
  assert.equal(mock.oauthLog.registrations[0].application_type, "web");
  assert.equal(mock.oauthLog.registrations[0].token_endpoint_auth_method, "none");
  assert.equal(first.searchParams.get("client_id"), second.searchParams.get("client_id"));
  assert.match(first.searchParams.get("client_id")!, /^dcr-client-/);
  assert.equal((await callback(two, await authorize(second.href))).outcome, "ok");
  const rows = await all<{ issuer: string; method: string; owner_user_id: string | null }>("SELECT issuer, method, owner_user_id FROM mcp_client_registrations");
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ issuer: ISSUER, method: "dcr", owner_user_id: null }]);
});

test("an iss that isn't the authorization server's is refused, without its words", async () => {
  const user = await account("iss-user");
  mock.state.oauth.iss = "wrong";
  let ended: { outcome: string | null; location: string } | undefined;
  const log = await logsOf(async () => {
    const started = await start(user, { provider: "notion" });
    ended = await callback(user, await authorize(started.body.url!));
  });
  assert.equal(ended!.outcome, "failed");
  assert.equal(ended!.location, `${FLASH}/?connect=failed`);
  assert.equal(mock.oauthLog.codes, 0, "the code was never traded");
  assert.ok(!log.includes("evil") && !log.includes("MOCK"), "nothing the server said is logged");
  assert.equal((await connectionsOf(user.id)).length, 0);

  // A server that says it sends iss must send it.
  mock.state.oauth.iss = "none";
  assert.equal(await connect(user, { provider: "notion" }), "failed");
  // One that doesn't say so may leave it out.
  mock.state.oauth.issAdvertised = false;
  assert.equal(await connect(user, { provider: "notion" }), "ok");

  // The user saying no comes back as cancelled, never with the server's own text.
  mock.state.oauth.deny = true;
  const started = await start(user, { provider: "notion" });
  const back = await authorize(started.body.url!);
  assert.match(back.search, /MOCK-SAYS-NO/);
  const cancelled = await callback(user, back);
  assert.equal(cancelled.location, `${FLASH}/?connect=cancelled`);
});

test("mix-up: a server the user added can't have another authorization server's code and verifier sent to it", async () => {
  const user = await account("mixup-user");
  // The honest authorization server doesn't send iss; the attacker's server sends the browser on to it.
  mock.state.oauth.iss = "none";
  mock.state.oauth.issAdvertised = false;
  const EVIL = `${mock.origin}/evil/mcp`;
  /** The browser through the attacker's sign-in page, the honest one, and back: where it lands. */
  const bounce = async (url: string) => authorize((await authorize(url)).href);

  // An attacker's authorization server that says it doesn't send iss is refused before any sign-in.
  const preview = await connectRoute.POST(post("/api/connect", user, { action: "preview", provider: "custom", url: EVIL }));
  assert.equal(preview.status, 400);
  assert.equal(((await preview.json()) as { code: string }).code, "no_iss");
  const refused = await start(user, { provider: "custom", url: EVIL });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "no_iss");
  assert.equal(refused.body.error, "That server's sign-in doesn't identify itself when it sends you back, so Flash can't use it safely.");
  assert.equal(await flowsOf(user.id), 0);

  // One that says it sends iss starts, but the honest server's code comes back without the attacker's iss: refused.
  mock.state.oauth.evilIss = true;
  let started = await start(user, { provider: "custom", url: EVIL });
  assert.equal(started.status, 200);
  assert.equal(new URL(started.body.url!).pathname, "/evil/authorize");
  let back = await bounce(started.body.url!);
  assert.ok(back.searchParams.get("code"), "the honest server gave a code");
  assert.equal(back.searchParams.get("iss"), null);
  assert.equal((await callback(user, back)).outcome, "failed");

  // Nor with the honest server's own iss.
  mock.state.oauth.iss = "right";
  started = await start(user, { provider: "custom", url: EVIL });
  back = await bounce(started.body.url!);
  assert.equal(back.searchParams.get("iss"), ISSUER);
  assert.equal((await callback(user, back)).outcome, "failed");

  // A flow stored before this rule (its server said it sends no iss) is held to it too.
  mock.state.oauth.iss = "none";
  started = await start(user, { provider: "custom", url: EVIL });
  await sql("UPDATE connect_flows SET endpoints_json = json_set(endpoints_json, '$.iss', json('false')) WHERE user_id = ?", [user.id]);
  back = await bounce(started.body.url!);
  assert.equal((await callback(user, back)).outcome, "failed");

  assert.deepEqual(mock.oauthLog.stolen, [], "no code or verifier reached the attacker's token endpoint");
  assert.equal((await connectionsOf(user.id)).length, 0);
  // A preset whose own authorization server says it sends no iss still signs in without it.
  assert.equal(await connect(user, { provider: "notion" }), "ok");
});

test("two refreshes at once make exactly one token call, and both get the new token", async () => {
  const user = await account("race-user");
  mock.state.oauth.accessTtl = 30; // always within a minute of running out: every use renews it
  assert.equal(await connect(user, { provider: "notion" }), "ok");
  const [row] = await connectionsOf(user.id);
  mock.state.oauth.refreshDelayMs = 300;
  const kits = [(await chatKit(user.id, [String(row.id)]))!, (await chatKit(user.id, [String(row.id)]))!];
  const checks = await Promise.all(kits.map((k) => k.check()));
  for (const c of checks) {
    assert.deepEqual(c.unreachable, []);
    assert.ok(c.tools.length > 3);
  }
  assert.equal(mock.oauthLog.refreshes, 1, "one token call");
  await Promise.all(kits.map((k) => k.close()));
  const after = (await connectionsOf(user.id))[0];
  assert.notEqual(after.enc_access, row.enc_access);
  assert.notEqual(after.enc_refresh, row.enc_refresh, "the rotated refresh token was kept");
  assert.equal(after.refreshing_until, null);
});

test("a refresh after the access token runs out, saved before it is used", async () => {
  const user = await account("expiry-user");
  mock.state.oauth.accessTtl = 30;
  assert.equal(await connect(user, { provider: "linear" }), "ok");
  const [row] = await connectionsOf(user.id);
  const kit = (await chatKit(user.id, [String(row.id)]))!;
  const { tools } = await kit.check();
  assert.equal(mock.oauthLog.refreshes, 1);
  // The server only takes live tokens: the call went through with the new one.
  assert.deepEqual(await kit.run(tools.find((t) => t.tool === "echo")!, { text: "fresh" }), { text: "fresh", isError: false });
  await kit.close();
});

test("a token that runs out while a reply goes on is renewed once, for all of its calls, and the calls go through", async () => {
  const user = await account("midchat-user");
  assert.equal(await connect(user, { provider: "linear" }), "ok");
  const [row] = await connectionsOf(user.id);
  const kit = (await chatKit(user.id, [String(row.id)]))!;
  const { tools } = await kit.check();
  const echo = tools.find((t) => t.tool === "echo")!;
  assert.deepEqual(await kit.run(echo, { text: "one" }), { text: "one", isError: false });
  assert.equal(mock.oauthLog.refreshes, 0);
  // The access token runs out at the server while Flash still holds it as good.
  mock.expireTokens();
  mock.state.oauth.refreshDelayMs = 200;
  const answers = await Promise.all(["two", "three", "four"].map((text) => kit.run(echo, { text })));
  assert.deepEqual(answers, ["two", "three", "four"].map((text) => ({ text, isError: false })));
  assert.equal(mock.oauthLog.refreshes, 1, "one renewal for the three calls");
  await kit.close();
  const [now] = await connectionsOf(user.id);
  assert.equal(now.status, "ok");
  assert.notEqual(now.enc_access, row.enc_access);
});

test("Stop while a sign-in is being renewed: the renewal is still kept, and the next reply works", async () => {
  const user = await account("stop-renew-user");
  mock.state.oauth.accessTtl = 30;
  assert.equal(await connect(user, { provider: "notion" }), "ok");
  const [row] = await connectionsOf(user.id);
  const grants = mock.live().grants;
  mock.state.oauth.refreshDelayMs = 300;
  const stop = new AbortController();
  const kit = (await chatKit(user.id, [String(row.id)], { signal: stop.signal }))!;
  const checking = kit.check();
  // The server has the refresh token (and retires it); the user presses Stop before its answer comes.
  while (mock.oauthLog.refreshes === 0) await new Promise((r) => setTimeout(r, 5));
  stop.abort("stop");
  await assert.rejects(checking);
  await kit.close();
  const [after] = await connectionsOf(user.id);
  assert.notEqual(after.enc_refresh, row.enc_refresh, "the rotated refresh token was saved");
  assert.equal(after.status, "ok");
  assert.equal(after.refreshing_until, null);

  mock.state.oauth.refreshDelayMs = 0;
  const next = (await chatKit(user.id, [String(row.id)]))!;
  assert.deepEqual((await next.check()).unreachable, []);
  await next.close();
  assert.equal((await connectionsOf(user.id))[0].status, "ok");
  assert.equal(mock.live().grants, grants, "the sign-in is still alive at the server");
});

test("a Reconnect that lands while a refresh is under way wins: the refresh's tokens go back to the server, not into the row", async () => {
  const user = await account("reconnect-race-user");
  mock.state.oauth.accessTtl = 30;
  assert.equal(await connect(user, { provider: "notion" }), "ok");
  const [row] = await connectionsOf(user.id);
  mock.state.oauth.refreshDelayMs = 400;
  const kit = (await chatKit(user.id, [String(row.id)]))!;
  const checking = kit.check();
  await new Promise((r) => setTimeout(r, 100));
  assert.ok((await connectionsOf(user.id))[0].refreshing_until, "the refresh is under way");
  // The user presses Reconnect meanwhile; its sign-in finishes first.
  const started = await start(user, { connectionId: row.id });
  assert.equal((await callback(user, await authorize(started.body.url!))).outcome, "ok");
  const reconnected = (await connectionsOf(user.id))[0];
  const checked = await checking;
  await kit.close();
  assert.deepEqual(checked.unreachable, []);
  assert.equal(mock.oauthLog.refreshes, 1);
  const [now] = await connectionsOf(user.id);
  assert.equal(now.enc_access, reconnected.enc_access, "the Reconnect's tokens stay");
  assert.equal(now.enc_refresh, reconnected.enc_refresh);
  assert.equal(now.status, "ok");
  assert.deepEqual(mock.oauthLog.revoked, ["refresh_token", "access_token"], "the refresh's tokens were handed back");
});

test("a refresh seals the tokens with the newest key version, and a preset's row records it", async () => {
  const user = await account("rotate-user");
  mock.state.oauth.accessTtl = 30;
  assert.equal(await connect(user, { provider: "notion" }), "ok");
  const [row] = await connectionsOf(user.id);
  assert.equal(row.key_version, "v1");
  const keep = process.env.CONNECTOR_KEYS!;
  process.env.CONNECTOR_KEYS = JSON.stringify({ ...JSON.parse(keep), v2: randomBytes(32).toString("base64") });
  try {
    const kit = (await chatKit(user.id, [String(row.id)]))!;
    assert.deepEqual((await kit.check()).unreachable, []);
    await kit.close();
    const [now] = await connectionsOf(user.id);
    assert.equal(now.key_version, "v2");
    assert.match(String(now.enc_access), /^v2:/);
    assert.match(String(now.enc_refresh), /^v2:/);
  } finally {
    process.env.CONNECTOR_KEYS = keep;
  }
});

test("key rotation reaches Flash's registrations: a secret is sealed again as it is used, so the old version can go", async () => {
  const { adminStats } = await import("../src/lib/server/admin-stats.ts");
  const older = async () => (await adminStats(30)).connectors.older.filter((o: { version: string }) => o.version === "v1");
  await sql("DELETE FROM mcp_client_registrations");
  // This server's DCR gives a client secret and a registration token.
  mock.state.oauth.cimd = false;
  mock.state.oauth.dcrSecret = true;
  const user = await account("rotate-reg-user");
  mock.state.oauth.accessTtl = 30;
  assert.equal(await connect(user, { provider: "notion" }), "ok");
  type Reg = { id: string; key_version: string; enc_client_secret: string; enc_registration_token: string; auth_method: string };
  const regs = () => all<Reg>("SELECT id, key_version, enc_client_secret, enc_registration_token, auth_method FROM mcp_client_registrations");
  let [reg] = await regs();
  assert.equal(reg.auth_method, "client_secret_basic");
  assert.equal(reg.key_version, "v1");
  assert.match(reg.enc_client_secret, /^v1:/);
  assert.equal(reg.enc_registration_token, "", "the registration token Flash never uses isn't kept");

  const keep = process.env.CONNECTOR_KEYS!;
  const v2 = randomBytes(32).toString("base64");
  process.env.CONNECTOR_KEYS = JSON.stringify({ ...JSON.parse(keep), v2 });
  try {
    assert.ok((await older()).length > 0, "/admin lists what v1 still seals");
    // A renewal at that server opens the registration: its secret is sealed again with v2.
    const [row] = await connectionsOf(user.id);
    let kit = (await chatKit(user.id, [String(row.id)]))!;
    assert.deepEqual((await kit.check()).unreachable, []);
    await kit.close();
    [reg] = await regs();
    assert.equal(reg.key_version, "v2");
    assert.match(reg.enc_client_secret, /^v2:/);
    // The connection moved with its renewal too; nothing is left on v1 for this user and server.
    assert.equal((await connectionsOf(user.id))[0].key_version, "v2");
    const left = await all<{ n: number }>("SELECT COUNT(*) AS n FROM mcp_client_registrations WHERE key_version = 'v1'");
    assert.equal(Number(left[0].n), 0);

    // With v1 dropped, signing in and renewing there still work.
    process.env.CONNECTOR_KEYS = JSON.stringify({ v2 });
    await sql("UPDATE connections SET expires_at = 1 WHERE id = ?", [String(row.id)]);
    kit = (await chatKit(user.id, [String(row.id)]))!;
    assert.deepEqual((await kit.check()).unreachable, []);
    await kit.close();
    const other = await account("rotate-reg-other");
    assert.equal(await connect(other, { provider: "notion" }), "ok");
  } finally {
    process.env.CONNECTOR_KEYS = keep;
    // Later tests start from Flash's own registration again (this one is sealed with v2 only).
    await sql("DELETE FROM mcp_client_registrations");
  }
});

test("a registration from before that kept only an unused registration token stops counting as sealed", async () => {
  await sql("DELETE FROM mcp_client_registrations");
  mock.state.oauth.cimd = false;
  const user = await account("legacy-reg-user");
  assert.equal(await connect(user, { provider: "notion" }), "ok");
  await sql("UPDATE mcp_client_registrations SET enc_registration_token = 'v1:old:old:old', key_version = 'v1'");
  const other = await account("legacy-reg-other");
  assert.equal(await connect(other, { provider: "notion" }), "ok");
  const [reg] = await all<{ key_version: string; enc_registration_token: string }>("SELECT key_version, enc_registration_token FROM mcp_client_registrations");
  assert.deepEqual({ ...reg }, { key_version: "", enc_registration_token: "" });
  await sql("DELETE FROM mcp_client_registrations");
});

test("a token endpoint that redirects gets no code, verifier or refresh token sent on", async () => {
  const user = await account("redirect-user");
  mock.state.oauth.tokenRedirect = true;
  assert.equal(await connect(user, { provider: "notion" }), "failed");
  assert.deepEqual(mock.oauthLog.elsewhere, [], "the code and its verifier stayed with the token endpoint");
  assert.equal((await connectionsOf(user.id)).length, 0);

  mock.state.oauth.tokenRedirect = false;
  mock.state.oauth.accessTtl = 30;
  assert.equal(await connect(user, { provider: "notion" }), "ok");
  const [row] = await connectionsOf(user.id);
  await sql("UPDATE connections SET expires_at = 1 WHERE id = ?", [String(row.id)]);
  mock.state.oauth.tokenRedirect = true;
  const kit = (await chatKit(user.id, [String(row.id)]))!;
  assert.deepEqual((await kit.check()).unreachable, ["Notion"]);
  await kit.close();
  assert.deepEqual(mock.oauthLog.elsewhere, [], "nor the refresh token");
  const [now] = await connectionsOf(user.id);
  assert.equal(now.status, "ok", "a refresh that didn't work isn't a refused grant");
  assert.equal(now.enc_refresh, row.enc_refresh);
  assert.equal(now.refreshing_until, null);
});

test("an old refresh token sent again ends the sign-in: Reconnect, with no retry", async () => {
  const user = await account("replay-user");
  mock.state.oauth.accessTtl = 30;
  assert.equal(await connect(user, { provider: "notion" }), "ok");
  const [row] = await connectionsOf(user.id);
  // One refresh rotates the refresh token.
  let kit = (await chatKit(user.id, [String(row.id)]))!;
  await kit.check();
  await kit.close();
  assert.equal(mock.oauthLog.refreshes, 1);
  const grantsBefore = mock.live().grants;
  // The old one comes back (as a lost write would bring it back) and is sent: the server revokes the whole grant.
  await sql("UPDATE connections SET enc_refresh = ?, expires_at = 1 WHERE id = ?", [String(row.enc_refresh), String(row.id)]);
  mock.reset();
  mock.state.oauth.accessTtl = 30;
  kit = (await chatKit(user.id, [String(row.id)]))!;
  const checked = await kit.check();
  await kit.close();
  assert.deepEqual(checked.unreachable, ["Notion"]);
  assert.equal(mock.oauthLog.refreshes, 1, "no retry loop");
  assert.equal(mock.live().grants, grantsBefore - 1, "the server revoked the grant");
  const [now] = await connectionsOf(user.id);
  assert.equal(now.status, "needs_reconnect");
  assert.equal(now.enc_access, "");
  assert.equal(now.enc_refresh, "");
  const [view] = await listConnections(user.id);
  assert.equal(view.status, "needs_reconnect");
  assert.equal(view.signIn, true);
  assert.equal(await chatKit(user.id, [String(row.id)]), null, "it is left out of chats");

  // Reconnect signs in again, and the account works.
  assert.equal(await connect(user, { connectionId: row.id }), "ok");
  assert.equal((await connectionsOf(user.id))[0].status, "ok");
});

test("a callback with another user's flow, or a flow already used, is refused", async () => {
  const owner = await account("flow-owner");
  const other = await account("flow-other");
  const started = await start(owner, { provider: "notion" });
  const back = await authorize(started.body.url!);
  // Someone else coming back with the owner's state and code: nothing happens to either of them.
  assert.equal((await callback(other, back)).outcome, "expired");
  assert.equal((await connectionsOf(other.id)).length, 0);
  assert.equal(mock.oauthLog.codes, 0);
  assert.equal(await flowsOf(owner.id), 1, "the owner's flow is still there");
  assert.equal((await callback(owner, back)).outcome, "ok");
  // The same answer again: the flow is gone.
  assert.equal((await callback(owner, back)).outcome, "expired");
  assert.equal(mock.oauthLog.codes, 1, "the code was traded once");
  assert.equal((await connectionsOf(owner.id)).length, 1);
  // Signed out, a callback does nothing.
  const res = await callbackRoute.GET(new Request(`${FLASH}/api/connect/mcp/callback${back.search}`));
  assert.equal(new URL(res.headers.get("location")!).searchParams.get("connect"), "failed");
  // An expired flow is refused too.
  const late = await start(owner, { provider: "notion" });
  await sql("UPDATE connect_flows SET expires_at = 1 WHERE user_id = ?", [owner.id]);
  assert.equal((await callback(owner, await authorize(late.body.url!))).outcome, "expired");
});

test("a client ID and secret one user typed in are never used for another user", async () => {
  await sql("DELETE FROM mcp_client_registrations");
  mock.state.oauth.cimd = false;
  mock.state.oauth.dcr = false;
  const a = await account("typed-a");
  const b = await account("typed-b");
  const preview = async (user: Account) => {
    const res = await connectRoute.POST(post("/api/connect", user, { action: "preview", provider: "custom", url: SERVER }));
    return (await res.json()) as { host: string; tools: unknown[]; signIn?: { authHost: string; needsClient: boolean; callback: string } };
  };
  const seen = await preview(a);
  assert.deepEqual(seen.signIn, { authHost: new URL(mock.origin).host, needsClient: true, callback: `${FLASH}/api/connect/mcp/callback` });
  assert.equal((await start(a, { provider: "custom", url: SERVER })).body.code, "needs_client");

  const started = await start(a, { provider: "custom", url: SERVER, clientId: "pre-client", clientSecret: "pre-secret" });
  assert.equal(new URL(started.body.url!).searchParams.get("client_id"), "pre-client");
  assert.equal((await callback(a, await authorize(started.body.url!))).outcome, "review", "the secret was sent, and taken");
  const rows = await all<{ id: string; owner_user_id: string; method: string; enc_client_secret: string }>("SELECT * FROM mcp_client_registrations");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner_user_id, a.id);
  assert.equal(rows[0].method, "pre");
  assert.ok(!rows[0].enc_client_secret.includes("pre-secret"), "the secret is sealed");

  // B sees no client there, can't start without one of their own, and can't use A's.
  assert.equal((await preview(b)).signIn!.needsClient, true);
  const refused = await start(b, { provider: "custom", url: SERVER });
  assert.equal(refused.body.code, "needs_client");
  assert.equal(await oauth.usableClient(b.id, rows[0].id), null);
  assert.equal(await flowsOf(b.id), 0);
  // B's own client is B's own row.
  const own = await start(b, { provider: "custom", url: SERVER, clientId: "b-client" });
  assert.equal(new URL(own.body.url!).searchParams.get("client_id"), "b-client");
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM mcp_client_registrations WHERE owner_user_id = ?", [b.id]))!.n), 1);
  // A connects again without typing it: their own client is used, nobody else's.
  const again = await start(a, { provider: "custom", url: SERVER });
  assert.equal(new URL(again.body.url!).searchParams.get("client_id"), "pre-client");
});

test("an authorization endpoint on a Flash host, or one that isn't https, is refused", async () => {
  const user = await account("host-user");
  for (const bad of ["https://www.flash-app.dev/api/connect", "https://flash-app.dev/x", "https://flash-ai-git-main.vercel.app/x", "http://auth.example.com/authorize", "javascript:alert(1)", "https://localhost/authorize", "https://10.0.0.1/authorize"]) {
    assert.throws(() => oauth.checkAuthorizeUrl(bad), (e: Error & { code?: string }) => e.code === "endpoint", bad);
    mock.state.oauth.authorizeAt = bad;
    const refused = await start(user, { provider: "notion" });
    assert.equal(refused.status, 400, bad);
    assert.equal(refused.body.code, "no_signin", bad);
    assert.equal(refused.body.url, undefined);
  }
  assert.equal(await flowsOf(user.id), 0);
  assert.equal(oauth.checkAuthorizeUrl("https://auth.example.com/authorize?x=1").host, "auth.example.com");
});

test("every address found while signing in goes through the guard", async () => {
  // A resource_metadata that points inside, an authorization server or endpoint that isn't public https.
  await assert.rejects(oauth.planSignIn(SERVER, { challenge: 'Bearer resource_metadata="https://169.254.169.254/latest"' }), (e: Error & { code?: string }) => e.code === "endpoint");
  await assert.rejects(oauth.findAuthServer("https://10.0.0.1/as"), (e: Error & { code?: string }) => e.code === "endpoint");
  await assert.rejects(oauth.findAuthServer("http://auth.example.com"), (e: Error & { code?: string }) => e.code === "endpoint");
  await assert.rejects(oauth.findAuthServer("https://www.flash-app.dev"), (e: Error & { code?: string }) => e.code === "endpoint");
});

test("starting a sign-in takes Flash's exact Origin and a confirmed email", async () => {
  const user = await account("origin-user");
  for (const origin of [null, "null", "https://evil.example"]) {
    const refused = await start(user, { provider: "notion" }, origin);
    assert.equal(refused.status, 403, String(origin));
  }
  // Confirming an email is needed only where Flash sends email (demo emails stand in for it here).
  process.env.FLASH_DEMO_EMAILS = "true";
  const unconfirmed = await account("origin-unconfirmed", { verified: false });
  try {
    const refused = await start(unconfirmed, { provider: "notion" });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "unverified");
  } finally {
    delete process.env.FLASH_DEMO_EMAILS;
  }
  assert.equal((await flowsOf(user.id)) + (await flowsOf(unconfirmed.id)), 0);
  // A service that takes no key can't be added with one.
  const res = await connectRoute.POST(post("/api/connect", user, { action: "add", provider: "notion", token: "secret-token-123456" }));
  assert.equal(res.status, 400);
});

test("a server the user added signs in, waits for them to look at its tools, then is added", async () => {
  const user = await account("custom-user");
  assert.equal(await connect(user, { provider: "custom", url: SERVER, label: "My server" }), "review");
  const [row] = await connectionsOf(user.id);
  assert.equal(row.status, "review");
  assert.equal(row.url, mock.origin, "only its origin is kept as it is");
  assert.equal(await chatKit(user.id, [String(row.id)]), null, "no chat uses it yet");
  const [view] = await listConnections(user.id);
  assert.ok(view.tools.some((t) => t.name === "admin_report"), "its tools are shown");
  // Adding it is a change that takes Flash's exact Origin.
  const patch = (origin: string | null) =>
    connectIdRoute.PATCH(
      new Request(`${FLASH}/api/connect/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: user.cookie, ...(origin !== null && { origin }) },
        body: JSON.stringify({ confirm: true }),
      }),
      { params: Promise.resolve({ id: String(row.id) }) } as never,
    );
  assert.equal((await patch("null")).status, 403);
  assert.equal((await patch(FLASH)).status, 200);
  assert.equal((await connectionsOf(user.id))[0].status, "ok");
  assert.ok(await chatKit(user.id, [String(row.id)]));
});

test("step-up: a tool that needs more access asks for Reconnect, which asks for the union of scopes", async () => {
  const user = await account("scope-user");
  assert.equal(await connect(user, { provider: "custom", url: SERVER }), "review");
  const [row] = await connectionsOf(user.id);
  await sql("UPDATE connections SET status = 'ok' WHERE id = ?", [String(row.id)]);
  assert.equal(row.scopes, "read offline_access");
  let kit = (await chatKit(user.id, [String(row.id)]))!;
  let { tools } = await kit.check();
  const report = tools.find((t) => t.tool === "admin_report")!;
  const refused = await kit.run(report, {});
  await kit.close();
  assert.equal(refused.isError, true);
  assert.match(refused.text, /Reconnect/);
  const [after] = await connectionsOf(user.id);
  assert.equal(after.scopes, "read offline_access admin");
  assert.equal(after.status, "ok", "the account still works for everything else");

  const started = await start(user, { connectionId: row.id });
  assert.equal(new URL(started.body.url!).searchParams.get("scope"), "read offline_access admin");
  assert.equal((await callback(user, await authorize(started.body.url!))).outcome, "ok");
  kit = (await chatKit(user.id, [String(row.id)]))!;
  ({ tools } = await kit.check());
  assert.deepEqual(await kit.run(tools.find((t) => t.tool === "admin_report")!, {}), { text: "The admin report is fine.", isError: false });
  await kit.close();
  assert.deepEqual(oauth.unionScopes("read write", ["write", "admin"]), ["read", "write", "admin"]);
});

test("step-up: scopes two tools of one reply ask for are both kept", async () => {
  const user = await account("scopes-race-user");
  assert.equal(await connect(user, { provider: "custom", url: SERVER }), "review");
  const [row] = await connectionsOf(user.id);
  await sql("UPDATE connections SET status = 'ok' WHERE id = ?", [String(row.id)]);
  const kit = (await chatKit(user.id, [String(row.id)]))!;
  const { tools } = await kit.check();
  // Another tool of this reply (or another reply) asked for "files:write" after this reply read the row.
  await sql("UPDATE connections SET scopes = 'read offline_access files:write' WHERE id = ?", [String(row.id)]);
  const report = tools.find((t) => t.tool === "admin_report")!;
  assert.equal((await kit.run(report, {})).isError, true);
  assert.equal((await connectionsOf(user.id))[0].scopes, "read offline_access files:write admin");
  // A second refusal in the same reply builds on that.
  assert.equal((await kit.run(report, {})).isError, true);
  await kit.close();
  assert.equal((await connectionsOf(user.id))[0].scopes, "read offline_access files:write admin");
});

test("step-up on an approved action: its card says so in Flash's words for the user, translated, not in Claude's", async () => {
  const user = await account("scope-card-user");
  assert.equal(await connect(user, { provider: "custom", url: SERVER }), "review");
  const [row] = await connectionsOf(user.id);
  await sql("UPDATE connections SET status = 'ok' WHERE id = ?", [String(row.id)]);
  const kit = (await chatKit(user.id, [String(row.id)]))!;
  const { tools } = await kit.check();
  const report = tools.find((t) => t.tool === "admin_report")!;
  const card = await kit.propose(report, {});
  // In a chat, Claude is told what to tell the user.
  assert.match((await kit.run(report, {})).text, /Tell the user/);
  await kit.close();
  const ctx = { params: Promise.resolve({ id: card.id }) } as never;
  const headers = { "content-type": "application/json", cookie: user.cookie, origin: FLASH };
  const res = await actionRoute.POST(
    new Request(`${FLASH}/api/connect/actions/${card.id}`, { method: "POST", headers, body: JSON.stringify({ decision: "approve", inputHash: card.inputHash }) }),
    ctx,
  );
  const words = "This needs more access than the account gave Flash. Press Reconnect on this account in Settings > Connectors and allow it, then ask again.";
  assert.deepEqual(await res.json(), { status: "failed", result: words });
  const shown = await actionRoute.GET(new Request(`${FLASH}/api/connect/actions/${card.id}`, { headers }), ctx);
  assert.equal(((await shown.json()) as { result: string }).result, words, "and so it stays when the card is shown again");
  // The routes show it with failedText, so a German user reads it in German (Node here can't load the tables the routes import).
  const german = JSON.parse(readFileSync(new URL("../src/lib/i18n/de.json", import.meta.url), "utf8")) as Record<string, string>;
  assert.ok(german[words]);
  assert.equal(failedText(words, (text, blanks) => translate(german, text, blanks)), german[words]);
  assert.equal((await connectionsOf(user.id))[0].scopes, "read offline_access admin", "Reconnect asks for what it needs");
});

test("removing an account that signed in asks its server to cancel the tokens, where it offers a way to", async () => {
  const user = await account("revoke-user");
  assert.equal(await connect(user, { provider: "notion" }), "ok");
  const [row] = await connectionsOf(user.id);
  assert.equal((await listConnections(user.id))[0].revocable, true, "Settings says removing it cancels the access");
  const grants = mock.live().grants;
  const res = await connectRoute.DELETE(
    new Request(`${FLASH}/api/connect`, { method: "DELETE", headers: { "content-type": "application/json", origin: FLASH, cookie: user.cookie }, body: JSON.stringify({ id: row.id }) }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual([...mock.oauthLog.revoked].sort(), ["access_token", "refresh_token"]);
  assert.equal(mock.live().grants, grants - 1);
  assert.equal((await connectionsOf(user.id)).length, 0);
  // A server with no revocation endpoint: Settings says Flash can't cancel the access there, and it is removed all the same.
  mock.reset();
  mock.state.oauth.revocation = false;
  assert.equal(await connect(user, { provider: "notion" }), "ok");
  const [second] = await connectionsOf(user.id);
  assert.equal((await listConnections(user.id))[0].revocable, false);
  await connectRoute.DELETE(
    new Request(`${FLASH}/api/connect`, { method: "DELETE", headers: { "content-type": "application/json", origin: FLASH, cookie: user.cookie }, body: JSON.stringify({ id: second.id }) }),
  );
  assert.equal((await connectionsOf(user.id)).length, 0);
  assert.deepEqual(mock.oauthLog.revoked, [], "nothing was sent");
});

test("parsing a server's challenge", () => {
  assert.deepEqual(oauth.parseChallenge('Bearer resource_metadata="https://x.example/.well-known/oauth-protected-resource", scope="a b"'), {
    resourceMetadata: "https://x.example/.well-known/oauth-protected-resource",
    scope: "a b",
    error: "",
  });
  assert.deepEqual(oauth.parseChallenge('Basic realm="x", Bearer error="insufficient_scope", scope="files:read files:write"'), {
    resourceMetadata: "",
    scope: "files:read files:write",
    error: "insufficient_scope",
  });
  assert.deepEqual(oauth.parseChallenge('Bearer realm="say \\"hi\\""'), { resourceMetadata: "", scope: "", error: "" });
  assert.deepEqual(oauth.parseChallenge(""), { resourceMetadata: "", scope: "", error: "" });
  assert.deepEqual(oauth.scopeList('read "bad" write\nadmin'), ["read", "write", "admin"]);
});
