import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { register } from "node:module";
import type { AddressInfo } from "node:net";

/*
 * GitHub in chat (see github.ts), through Flash's own routes: Connect (the authorize step, the app's
 * installation when there is none, and the authorize step again), the callback, Settings > Connectors, a chat reply with a stand-in Claude, the
 * approval route and removal, against the stand-in GitHub of scripts/mock-connectors.ts. Nothing here
 * reaches a real service. Connecting, renewing, approving and removing cost nothing.
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
process.env.GITHUB_APP_CLIENT_ID = "mock-github-client";
process.env.GITHUB_APP_CLIENT_SECRET = "mock-github-secret";
process.env.GITHUB_APP_SLUG = "flash-ai-test";
delete process.env.VERCEL_ENV;
delete process.env.RESEND_API_KEY;

const { startMockConnectors } = await import("../scripts/mock-connectors.ts");
const mock = await startMockConnectors(0);
process.env.FLASH_CONNECT_MOCK = mock.origin;
mock.github.callback = `${ORIGIN}/api/connect/github/callback`;
after(async () => {
  claude.closeAllConnections();
  claude.close();
  await mock.close();
});

const { afterwards } = await import("./support/next-server.mjs");
const { all, one, run: sql } = await import("../src/lib/server/db.ts");
const { chatKit, runApproved, failedText } = await import("../src/lib/server/connections.ts");
const { GITHUB_PROBLEMS, githubReady } = await import("../src/lib/server/github.ts");
const { adminStats } = await import("../src/lib/server/admin-stats.ts");
const { translate } = await import("../src/lib/i18n.ts");
const startRoute = await import("../src/app/api/connect/github/start/route.ts");
const callbackRoute = await import("../src/app/api/connect/github/callback/route.ts");
const mcpCallbackRoute = await import("../src/app/api/connect/mcp/callback/route.ts");
const mcpStartRoute = await import("../src/app/api/connect/mcp/start/route.ts");
const connectRoute = await import("../src/app/api/connect/route.ts");
const actionRoute = await import("../src/app/api/connect/actions/[id]/route.ts");
const chatRoute = await import("../src/app/api/chat/route.ts");

beforeEach(() => {
  replies.length = 0;
  sent.length = 0;
  mock.reset();
  // Each test starts with a GitHub user who hasn't installed the app yet.
  mock.uninstallGithub();
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
  await sql("INSERT INTO projects (id, user_id, name, messages, updated_at) VALUES (?, ?, 'Code', '[]', 0)", [`proj_${id}`, id]);
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

// Everything a route answered in these tests, to look for tokens in.
const answers: string[] = [];
async function read(res: Response) {
  const text = await res.text();
  answers.push(text, JSON.stringify([...res.headers]));
  return text;
}

/** POST /api/connect/github/start: the page to open, or the refusal. */
async function start(user: Account, body: object = {}, origin: string | null = ORIGIN) {
  const res = await startRoute.POST(request("POST", "/api/connect/github/start", user, body, origin));
  return { status: res.status, body: JSON.parse(await read(res)) as { url?: string; error?: string; code?: string } };
}

/** The browser at one of the stand-in GitHub's pages: where it sends the browser next. */
async function visit(url: string): Promise<URL> {
  const res = await fetch(url, { redirect: "manual" });
  assert.equal(res.status, 302, `GitHub's page answered ${res.status}: ${await res.text()}`);
  return new URL(res.headers.get("location")!);
}

/** The browser back at Flash's GitHub callback, as `user`: where Flash sends it next. */
async function callback(user: Account, back: URL | string) {
  const search = typeof back === "string" ? back : back.search;
  const res = await callbackRoute.GET(new Request(`${ORIGIN}/api/connect/github/callback${search}`, { headers: { cookie: user.cookie } }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  answers.push(JSON.stringify([...res.headers]));
  const location = new URL(res.headers.get("location")!);
  return { location, outcome: location.origin === ORIGIN ? location.searchParams.get("connect") : null };
}

/** Connect GitHub all the way, as the browser would: from GitHub's page to Flash's callback and on, until Flash says how it went. */
async function connect(user: Account) {
  const started = await start(user);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  let next = new URL(started.body.url!);
  for (let step = 0; step < 4; step++) {
    const back = await callback(user, await visit(next.href));
    if (back.outcome !== null) return back.outcome;
    next = back.location;
  }
  throw new Error("Connect never ended");
}

/** Connect up to GitHub's installation page (the user has none yet): where Flash sends the browser after the first authorize step. */
async function toInstall(user: Account) {
  const started = await start(user);
  assert.equal(new URL(started.body.url!).pathname, "/github/web/login/oauth/authorize");
  const next = await callback(user, await visit(started.body.url!));
  assert.equal(next.location.pathname, "/github/web/apps/flash-ai-test/installations/new");
  return next.location;
}

const githubRow = (userId: string) => one<Record<string, unknown>>("SELECT * FROM connections WHERE user_id = ? AND provider = 'github'", [userId]);
const flowsOf = async (userId: string) => Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM connect_flows WHERE user_id = ?", [userId]))!.n);

let n = 0;
const newId = () => `m${Date.now().toString(36)}${n++}`;
type ChatEvent = { type: string; message?: string; items?: unknown[]; credits?: number; action?: Record<string, unknown> & { id: string; inputHash: string; input: Record<string, unknown> } };
/** A chat request as the page sends it, with GitHub on, read to its end. */
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

test("Connect: the authorize step first, the installation page when nothing is installed, the installation's code never redeemed, and only installations GitHub lists kept", async () => {
  const user = await account("gh-connect");
  const b0 = await balance(user.id);
  const started = await logsOf(() => start(user));
  assert.equal(started.status, 200);
  const authorize = new URL(started.body.url!);
  assert.equal(authorize.pathname, "/github/web/login/oauth/authorize");
  const p = authorize.searchParams;
  assert.equal(p.get("client_id"), "mock-github-client");
  assert.equal(p.get("redirect_uri"), `${ORIGIN}/api/connect/github/callback`);
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.match(p.get("code_challenge") ?? "", /^[\w-]{43}$/);
  assert.ok(p.get("state"));

  // The user has no installation yet: that token is given back, and the browser goes on to the installation page.
  const first = await logsOf(async () => callback(user, await visit(authorize.href)));
  assert.equal(first.outcome, null);
  assert.equal(mock.githubLog.codes, 1);
  assert.deepEqual(mock.githubLog.revoked, ["token"], "the token that saw no installation was given back");
  assert.equal(await githubRow(user.id), null);
  const install = first.location;
  assert.equal(install.pathname, "/github/web/apps/flash-ai-test/installations/new");
  assert.ok(install.searchParams.get("state"), "the installation page gets a state too");

  // GitHub installs the app and sends the browser back with a code, the installation and no state.
  const back = await visit(install.href);
  assert.equal(back.searchParams.get("installation_id"), "4242");
  assert.equal(back.searchParams.get("state"), null);
  assert.ok(back.searchParams.get("code"));
  const bounced = await logsOf(() => callback(user, back));
  assert.equal(mock.githubLog.codes, 1, "the installation's code was never traded");
  assert.equal(bounced.location.pathname, "/github/web/login/oauth/authorize");
  const q = bounced.location.searchParams;
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.ok(q.get("state") && q.get("state") !== p.get("state") && q.get("state") !== install.searchParams.get("state"), "a new state for the authorize step");

  const done = await logsOf(async () => callback(user, await visit(bounced.location.href)));
  assert.equal(done.outcome, "ok");
  assert.equal(mock.githubLog.codes, 2, "only the authorize steps' codes were traded");
  const row = (await githubRow(user.id))!;
  assert.equal(row.kind, "github");
  assert.equal(row.status, "ok");
  assert.equal(row.resource, "4242", "the installation GitHub listed for the token");
  assert.ok(String(row.enc_access).startsWith("v1:") && String(row.enc_refresh).startsWith("v1:"), "both tokens sealed");
  assert.ok(Math.abs(Number(row.expires_at) - (Date.now() + 8 * 3600_000)) < 60_000, "it runs out in 8 hours");
  assert.equal(await flowsOf(user.id), 0, "all three flows were used up");
  const tools = await all<{ name: string; kind: string; enabled: number }>("SELECT name, kind, enabled FROM connection_tools WHERE connection_id = ? ORDER BY position", [row.id as string]);
  assert.deepEqual(
    tools.map((t) => `${t.name}:${t.kind}`),
    ["list_repos:read", "read_file:read", "search_code:read", "list_issues:read", "read_pull_request:read", "create_issue:write", "open_pull_request:write"],
  );

  // Settings lists it, signed in and revocable, offers GitHub, and shows no token.
  const listed = JSON.parse(await read(await connectRoute.GET(request("GET", "/api/connect", user)))) as {
    github: boolean;
    connections: { provider: string; signIn: boolean; revocable: boolean; host: string; last4: string }[];
  };
  assert.equal(listed.github, true);
  assert.equal(listed.connections.length, 1);
  assert.deepEqual(
    { ...listed.connections[0], host: undefined },
    { ...listed.connections[0], provider: "github", signIn: true, revocable: true, last4: "", host: undefined },
  );
  assert.equal(await balance(user.id), b0, "connecting costs nothing");
  assert.equal(sent.length, 0, "and calls no model");

  // Connecting again goes through the authorize step only (GitHub's page for an installed app sends
  // nobody back), and updates the same account.
  assert.equal(await connect(user), "ok");
  assert.equal(mock.githubLog.installs, 1, "the installation page wasn't opened again");
  assert.equal((await all("SELECT id FROM connections WHERE user_id = ?", [user.id])).length, 1);
});

test("a callback without the state of this user's authorize step redeems nothing", async () => {
  const victim = await account("gh-victim");
  const other = await account("gh-other");
  // Someone authorizes Flash's app on their own GitHub and sends the code in a link.
  const theirs = await visit(`${mock.origin}/github/web/login/oauth/authorize?client_id=mock-github-client`);
  const code = theirs.searchParams.get("code")!;
  const sendLink = (search: string) => logsOf(() => callback(victim, search));

  assert.equal((await sendLink(`?code=${code}`)).outcome, "failed", "no state, and Flash didn't just send the user to the installation page");
  assert.equal((await sendLink(`?code=${code}&installation_id=4242&setup_action=install`)).outcome, "failed", "nor as an installation");
  assert.equal((await sendLink(`?code=${code}&state=made-up`)).outcome, "expired");
  // Nor while the user is at the authorize step of their own Connect: that step has its own state.
  const pressed = await start(victim);
  assert.equal(pressed.status, 200);
  assert.equal((await sendLink(`?code=${code}&installation_id=4242&setup_action=install`)).outcome, "failed");
  assert.equal(mock.githubLog.codes, 0);
  assert.equal(await githubRow(victim.id), null);
  assert.equal(await flowsOf(victim.id), 1, "only the user's own authorize step is waiting");

  // Another user's authorize step: its state doesn't work for the victim, and stays usable for its owner.
  assert.equal(await connect(other), "ok");
  const codes = mock.githubLog.codes;
  const reconnect = await start(other, { connectionId: (await githubRow(other.id))!.id as string });
  const step = new URL(reconnect.body.url!);
  assert.equal(step.pathname, "/github/web/login/oauth/authorize", "Reconnect goes to the authorize step");
  const state = step.searchParams.get("state")!;
  assert.equal((await sendLink(`?code=${code}&state=${state}`)).outcome, "expired");
  assert.equal(mock.githubLog.codes, codes, "only the other user's own connect traded codes");
  const back = await visit(step.href);
  assert.equal((await callback(other, back)).outcome, "ok");
  // The same answer again: used up.
  assert.equal((await callback(other, back)).outcome, "expired");
  assert.equal(mock.githubLog.codes, codes + 1);

  // An install flow's state with a code (GitHub passing it on) redeems nothing either: the authorize step starts.
  mock.uninstallGithub();
  mock.github.passState = true;
  const install = await toInstall(victim);
  const installed = await visit(install.href);
  assert.equal(installed.searchParams.get("state"), install.searchParams.get("state"));
  const traded = mock.githubLog.codes;
  const bounced = await callback(victim, installed);
  assert.equal(bounced.location.pathname, "/github/web/login/oauth/authorize");
  assert.equal(mock.githubLog.codes, traded);
  assert.equal((await callback(victim, await visit(bounced.location.href))).outcome, "ok");

  // GitHub flows are never taken by the other services' callback.
  const flow = await start(victim);
  const githubState = new URL(flow.body.url!).searchParams.get("state");
  const res = await mcpCallbackRoute.GET(new Request(`${ORIGIN}/api/connect/mcp/callback?state=${githubState}&code=${code}`, { headers: { cookie: victim.cookie } }));
  assert.equal(new URL(res.headers.get("location")!).searchParams.get("connect"), "expired");
  assert.equal(await flowsOf(victim.id), 2, "the GitHub flows are still there (this one, and the one pressed earlier)");
});

test("an installation that comes back without state starts the authorize step, only for a user Flash just sent to the installation page", async () => {
  const user = await account("gh-install");
  const installed = await visit((await toInstall(user)).href);
  assert.equal(installed.searchParams.get("state"), null);
  const codes = mock.githubLog.codes;
  const first = await callback(user, installed);
  assert.equal(first.location.origin + first.location.pathname, `${mock.origin}/github/web/login/oauth/authorize`);
  // The install flow was used: the same redirect again (or a copy of it) starts nothing more.
  const again = await callback(user, installed);
  assert.equal(again.outcome, "failed");
  assert.equal(mock.githubLog.codes, codes, "neither code was traded");
  // Cancelling at GitHub's authorize page connects nothing.
  mock.github.deny = true;
  assert.equal((await callback(user, await visit(first.location.href))).outcome, "cancelled");
  assert.equal(await githubRow(user.id), null);
  assert.equal(mock.githubLog.codes, codes);

  // The installation went away before the authorize step came back: Flash says so, and doesn't send
  // the browser round to the installation page again.
  mock.github.deny = false;
  mock.uninstallGithub();
  const back = await visit((await toInstall(user)).href);
  const step = await callback(user, back);
  mock.uninstallGithub();
  const done = await callback(user, await visit(step.location.href));
  assert.equal(done.outcome, "github_install");
  assert.equal(await githubRow(user.id), null);
  assert.equal(await flowsOf(user.id), 0);
});

test("a spoofed installation_id is refused, and its token given back; an installation the token sees is kept", async () => {
  const user = await account("gh-spoof");
  const installed = await visit((await toInstall(user)).href);
  installed.searchParams.set("installation_id", "9999");
  const bounced = await callback(user, installed);
  const codes = mock.githubLog.codes;
  const done = await logsOf(async () => callback(user, await visit(bounced.location.href)));
  assert.equal(done.outcome, "failed");
  assert.equal(mock.githubLog.codes, codes + 1, "the token was got, to check the installation");
  assert.deepEqual(mock.githubLog.revoked, ["token", "token"], "and given back (as was the first step's, which saw no installation)");
  assert.equal(await githubRow(user.id), null, "nothing was kept");
  assert.ok(logs.some((l) => l.includes("connector sign-in github failed: installation")));

  // An id that isn't a number is no hint at all; the installations the token sees are what is kept.
  mock.uninstallGithub();
  const back = await visit((await toInstall(user)).href);
  back.searchParams.set("installation_id", "4242 OR 1=1");
  const step = await callback(user, back);
  assert.equal((await callback(user, await visit(step.location.href))).outcome, "ok");
  assert.equal((await githubRow(user.id))!.resource, "4242");
});

test("token refresh: one at a time, rotated and saved before use; a refused refresh token asks for Reconnect", async () => {
  const user = await account("gh-refresh");
  assert.equal(await connect(user), "ok");
  const row = (await githubRow(user.id))!;
  const before = { access: row.enc_access, refresh: row.enc_refresh };
  mock.expireGithubTokens();
  mock.github.refreshDelayMs = 300;
  // Two replies at once, both needing the token renewed.
  const [a, b] = await Promise.all([chatKit(user.id, [row.id as string]), chatKit(user.id, [row.id as string])]);
  const list = (kit: NonNullable<typeof a>) => kit.run(kit.tools.find((t) => t.tool === "list_repos")!, {});
  const [ra, rb] = await logsOf(() => Promise.all([list(a!), list(b!)]));
  await a!.close();
  await b!.close();
  assert.equal(mock.githubLog.refreshes, 1, "exactly one refresh");
  for (const r of [ra, rb]) {
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /octo\/hello \(private\), default branch main/);
  }
  const renewed = (await githubRow(user.id))!;
  assert.notEqual(renewed.enc_access, before.access);
  assert.notEqual(renewed.enc_refresh, before.refresh, "the rotated refresh token was saved");
  assert.equal(renewed.refreshing_until, null);
  assert.ok(logs.some((l) => l.includes(`connector ${row.id} github refreshed`)));

  // GitHub refuses the refresh token (the user cancelled the app there): Reconnect, with no retry.
  mock.github.refreshDelayMs = 0;
  await sql("UPDATE connections SET expires_at = 1 WHERE id = ?", [row.id as string]);
  const revoked = await fetch(`${mock.origin}/github/api/applications/mock-github-client/grant`, { method: "DELETE" });
  assert.equal(revoked.status, 404, "only with the app's secret");
  // The grant goes at GitHub, as when the user cancels the app's authorization there.
  const live = mock.githubTokens();
  const access = live[live.length - 2];
  const basic = Buffer.from("mock-github-client:mock-github-secret").toString("base64");
  await fetch(`${mock.origin}/github/api/applications/mock-github-client/grant`, { method: "DELETE", headers: { authorization: `Basic ${basic}` }, body: JSON.stringify({ access_token: access }) });
  mock.reset();
  const kit = (await chatKit(user.id, [row.id as string]))!;
  const result = await kit.run(kit.tools.find((t) => t.tool === "list_repos")!, {});
  await kit.close();
  assert.equal(result.isError, true);
  assert.equal(mock.githubLog.refreshes, 1);
  assert.equal((await githubRow(user.id))!.status, "needs_reconnect");
  const view = JSON.parse(await read(await connectRoute.GET(request("GET", "/api/connect", user)))) as { connections: { status: string; signIn: boolean }[] };
  assert.deepEqual([view.connections[0].status, view.connections[0].signIn], ["needs_reconnect", true]);

  // Reconnect: the authorize step at once, and the account works again.
  const reconnect = await start(user, { connectionId: row.id as string });
  assert.equal(new URL(reconnect.body.url!).pathname, "/github/web/login/oauth/authorize");
  assert.equal((await callback(user, await visit(reconnect.body.url!))).outcome, "ok");
  assert.equal((await githubRow(user.id))!.status, "ok");
  assert.equal(mock.githubLog.installs, 0, "no installation needed");
});

test("a read in chat runs by itself and Claude gets its result; nothing is written before Approve, and an approved issue is written exactly once", async () => {
  const user = await account("gh-chat");
  assert.equal(await connect(user), "ok");
  const id = (await githubRow(user.id))!.id as string;
  const b0 = await balance(user.id);
  replies.push(
    { blocks: [{ type: "tool_use", id: "toolu_1", name: "github__read_file", input: { repo: "octo/hello", path: "README.md" } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "Your README says hello." }], stop: "end_turn" },
  );
  const read1 = await chat(user, "What does my README say?", [id]);
  assert.match(JSON.stringify(sent[1].messages), /tool_result.*Hello from the mock repo/);
  assert.deepEqual(read1.find((e) => e.type === "connector_used")?.items, [{ connection: "GitHub", tool: "Read a file" }]);
  assert.ok(!read1.some((e) => e.type === "approve_action"), "a read asks nothing");
  assert.ok(b0 - (await balance(user.id)) > 0, "a reply that used GitHub is paid, like any reply");

  // A write: a card with every field, and nothing written.
  replies.push(
    { blocks: [{ type: "tool_use", id: "toolu_2", name: "github__create_issue", input: { repo: "octo/hello", title: "Fix the README", body: "It only says hello." } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "The issue is waiting for your approval." }], stop: "end_turn" },
  );
  const events = await chat(user, "Open an issue about the README", [id]);
  const card = events.find((e) => e.type === "approve_action")!.action!;
  assert.deepEqual(card.input, { repo: "octo/hello", title: "Fix the README", body: "It only says hello." });
  assert.equal(card.host, new URL(mock.origin).host);
  assert.equal(card.title, "Create an issue");
  assert.equal(mock.githubLog.writes.length, 0, "nothing written before Approve");

  // Not from Flash's own page, not with another input: nothing written.
  const b1 = await balance(user.id);
  assert.equal((await answer(user, card, "approve", null)).status, 403);
  assert.equal((await answer(user, card, "approve", "https://evil.example")).status, 403);
  assert.equal((await answer(user, { ...card, inputHash: "0".repeat(64) })).status, 409);
  assert.equal(mock.githubLog.writes.length, 0);

  const approved = await answer(user, card);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, "done");
  assert.match(approved.body.result!, /^Created issue #\d+ in octo\/hello: https:\/\/github\.com\/octo\/hello\/issues\/\d+$/);
  assert.deepEqual(mock.githubLog.writes, [{ kind: "issue", repo: "octo/hello", body: { title: "Fix the README", body: "It only says hello." } }]);
  // Twice is once.
  assert.equal((await answer(user, card)).status, 409);
  assert.equal(mock.githubLog.writes.length, 1);
  assert.equal(await balance(user.id), b1, "approving costs nothing");
});

test("open a pull request: the card shows repo, title, body, head and base; approved, it is opened once; cancelled, never", async () => {
  const user = await account("gh-pull");
  assert.equal(await connect(user), "ok");
  const id = (await githubRow(user.id))!.id as string;
  const kit = (await chatKit(user.id, [id], { replyId: "r1" }))!;
  const pull = kit.tools.find((t) => t.tool === "open_pull_request")!;
  assert.equal(pull.kind, "write");
  const input = { repo: "octo/hello", title: "Add a wave", body: "Waves back.", head: "feature", base: "main" };
  const card = await kit.propose(pull, input);
  const cancelled = await kit.propose(pull, { ...input, title: "Never" });
  await kit.close();
  assert.deepEqual(card.input, input);
  assert.equal(mock.githubLog.writes.length, 0);
  assert.equal((await answer(user, cancelled, "cancel")).body.status, "cancelled");
  assert.equal((await answer(user, cancelled)).status, 409);
  const done = await answer(user, card);
  assert.equal(done.body.status, "done", done.body.result);
  assert.match(done.body.result!, /^Opened pull request #\d+ in octo\/hello \(feature into main\)/);
  assert.deepEqual(mock.githubLog.writes, [{ kind: "pull", repo: "octo/hello", body: { title: "Add a wave", body: "Waves back.", head: "feature", base: "main" } }]);
  assert.equal(mock.githubLog.calls.filter((c) => c.method === "POST" && c.path.startsWith("/github/api")).length, 1, "one write request, no retry");

  // A branch GitHub doesn't have: its own words, once, and nothing written.
  const kit2 = (await chatKit(user.id, [id]))!;
  const bad = await kit2.propose(kit2.tools.find((t) => t.tool === "open_pull_request")!, { ...input, head: "nope" });
  await kit2.close();
  const failed = await answer(user, bad);
  assert.equal(failed.body.status, "failed");
  assert.match(failed.body.result!, /GitHub didn't accept this: Validation Failed; head invalid/);
  assert.equal(mock.githubLog.writes.length, 1);
});

test("the reads: repositories, files and folders, code search, issues and a pull request, with bad input refused before any request", async () => {
  const user = await account("gh-reads");
  assert.equal(await connect(user), "ok");
  const kit = (await chatKit(user.id, [(await githubRow(user.id))!.id as string]))!;
  const call = (tool: string, input: Record<string, unknown>) => kit.run(kit.tools.find((t) => t.tool === tool)!, input);
  assert.match((await call("read_file", { repo: "octo/hello", path: "" })).text, /Folder octo\/hello\/ \(2 entries\):\nfile README\.md\nfolder src/);
  assert.match((await call("read_file", { repo: "octo/hello", path: "src/app.ts", ref: "main" })).text, /File octo\/hello\/src\/app\.ts at main:\n\nexport const greet/);
  assert.match((await call("search_code", { query: "greet", repo: "octo/hello" })).text, /1 result\.\nocto\/hello src\/app\.ts\n {4}export const greet/);
  assert.deepEqual(mock.githubLog.searches, ["greet repo:octo/hello"]);
  const issues = await call("list_issues", { repo: "octo/hello", kind: "issues" });
  assert.match(issues.text, /^#1 issue \[open\] Bug: it breaks \(by octo, updated 2026-10-01, labels: bug\)/);
  assert.ok(!issues.text.includes("#2"));
  const pr = await call("read_pull_request", { repo: "octo/hello", number: 2 });
  assert.match(pr.text, /From octo:feature into main/);
  assert.match(pr.text, /--- src\/app\.ts \(modified, \+1 -0\)\n@@/);
  assert.equal((await call("read_file", { repo: "octo/elsewhere", path: "x" })).text, GITHUB_PROBLEMS.notFound);
  // A repository the app may not touch: said plainly, and the sign-in is fine (no Reconnect).
  assert.deepEqual(await call("list_issues", { repo: "octo/site" }), { text: GITHUB_PROBLEMS.refused, isError: true });
  assert.equal((await githubRow(user.id))!.status, "ok");

  const before = mock.githubLog.calls.length;
  for (const [tool, input] of [
    ["read_file", { repo: "octo/hello/../../user", path: "x" }],
    ["read_file", { repo: "octo/hello", path: "../secrets" }],
    ["read_file", { repo: " octo/hello", path: "README.md" }],
    ["list_issues", { repo: "octo/hello", state: "everything" }],
    ["search_code", { query: "" }],
  ] as const) {
    const out = await call(tool, input);
    assert.equal(out.isError, true, `${tool} ${JSON.stringify(input)}`);
    assert.match(out.text, /^That input wasn't usable/);
  }
  assert.equal(mock.githubLog.calls.length, before, "no request was sent for them");
  await kit.close();
});

test("GitHub's rate limit: a clear note, in the user's language on a card, and no retry", async () => {
  const user = await account("gh-limit");
  assert.equal(await connect(user), "ok");
  const id = (await githubRow(user.id))!.id as string;
  mock.reset();
  mock.github.rateLimited = true;
  const kit = (await chatKit(user.id, [id]))!;
  const out = await kit.run(kit.tools.find((t) => t.tool === "list_issues")!, { repo: "octo/hello" });
  assert.deepEqual(out, { text: GITHUB_PROBLEMS.rate, isError: true });
  assert.equal(mock.githubLog.calls.length, 1, "asked once");
  const card = await kit.propose(kit.tools.find((t) => t.tool === "create_issue")!, { repo: "octo/hello", title: "T", body: "" });
  await kit.close();
  const done = (await runApproved(user.id, card.id, card.inputHash))!;
  assert.equal(done.status, "failed");
  assert.equal(done.result, GITHUB_PROBLEMS.rate);
  const fr = JSON.parse((await import("node:fs")).readFileSync(new URL("../src/lib/i18n/fr.json", import.meta.url), "utf8")) as Record<string, string>;
  assert.equal(failedText(done.result, (text) => translate(fr, text)), fr[GITHUB_PROBLEMS.rate]);
  assert.equal(mock.githubLog.writes.length, 0);
});

test("GitHub is hidden everywhere until all three of its variables are set", async () => {
  const user = await account("gh-hidden");
  assert.equal(await connect(user), "ok");
  const id = (await githubRow(user.id))!.id as string;
  const kit = (await chatKit(user.id, [id], { replyId: "h1" }))!;
  const card = await kit.propose(kit.tools.find((t) => t.tool === "create_issue")!, { repo: "octo/hello", title: "Hidden", body: "" });
  await kit.close();
  for (const name of ["GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_SLUG"]) {
    const kept = process.env[name];
    process.env[name] = name === "GITHUB_APP_SLUG" ? "  " : "";
    try {
      assert.equal(githubReady(), false, name);
      const listed = JSON.parse(await read(await connectRoute.GET(request("GET", "/api/connect", user)))) as { github: boolean; connections: unknown[] };
      assert.equal(listed.github, false, name);
      assert.deepEqual(listed.connections, [], `${name}: the account isn't listed`);
      assert.equal((await start(user)).status, 404, name);
      assert.equal((await mcpStartRoute.POST(request("POST", "/api/connect/mcp/start", user, { provider: "github" }))).status, 400, `${name}: nor through the other sign-in`);
      assert.equal(await chatKit(user.id, [id]), null, `${name}: no chat uses it`);
      const back = await callback(user, "?code=x&state=y");
      assert.equal(back.outcome, "failed", name);
      const stats = await adminStats(30);
      assert.deepEqual(stats.connectors.github, { setUp: false, missing: [name] }, name);
    } finally {
      process.env[name] = kept;
    }
  }
  assert.equal(githubReady(), true);
  // Without CONNECTOR_KEYS, too.
  const keys = process.env.CONNECTOR_KEYS;
  delete process.env.CONNECTOR_KEYS;
  try {
    assert.equal(githubReady(), false);
    assert.deepEqual((await adminStats(30)).connectors.github, { setUp: false, missing: ["CONNECTOR_KEYS"] });
  } finally {
    process.env.CONNECTOR_KEYS = keys;
  }
  // A card made before it was hidden doesn't run while it is.
  const slug = process.env.GITHUB_APP_SLUG;
  delete process.env.GITHUB_APP_SLUG;
  try {
    const done = await answer(user, card);
    assert.equal(done.body.status, "failed");
  } finally {
    process.env.GITHUB_APP_SLUG = slug;
  }
  assert.equal(mock.githubLog.writes.length, 0);
  assert.deepEqual((await adminStats(30)).connectors.github, { setUp: true, missing: [] });
});

test("only a confirmed account, from Flash's own page, starts Connect", async () => {
  const unconfirmed = await account("gh-unconfirmed", { verified: false });
  process.env.FLASH_DEMO_EMAILS = "true";
  try {
    const refused = await start(unconfirmed);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "unverified");
    assert.equal(await flowsOf(unconfirmed.id), 0);
  } finally {
    delete process.env.FLASH_DEMO_EMAILS;
  }
  const user = await account("gh-origin");
  assert.equal((await start(user, {}, null)).status, 403);
  assert.equal((await start(user, {}, "null")).status, 403);
  assert.equal((await start(user, {}, "https://evil.example")).status, 403);
  assert.equal(await flowsOf(user.id), 0);
  // Adding an account with a key needs the exact Origin too (and GitHub isn't added that way at all).
  for (const origin of [null, "null", "https://evil.example"]) {
    assert.equal((await connectRoute.POST(request("POST", "/api/connect", user, { action: "add", provider: "linear", token: "lin_api_ORIGINORIGIN1234" }, origin))).status, 403);
  }
  assert.equal((await connectRoute.POST(request("POST", "/api/connect", user, { action: "add", provider: "github", token: "ghp_x" }))).status, 400);
  // Reconnect only for the user's own GitHub account.
  const owner = await account("gh-owner");
  assert.equal(await connect(owner), "ok");
  assert.equal((await start(user, { connectionId: (await githubRow(owner.id))!.id as string })).status, 404);
});

test("removing GitHub cancels the app's authorization at GitHub, renewing a token that ran out first; only from Flash's own page", async () => {
  const user = await account("gh-remove");
  assert.equal(await connect(user), "ok");
  const id = (await githubRow(user.id))!.id as string;
  const b0 = await balance(user.id);
  const remove = (origin: string | null = ORIGIN) => connectRoute.DELETE(request("DELETE", "/api/connect", user, { id }, origin));
  assert.equal((await remove(null)).status, 403);
  assert.equal((await remove("https://evil.example")).status, 403);
  assert.ok(await githubRow(user.id));
  assert.deepEqual(mock.githubLog.revoked, ["token"], "only Connect's first token, which saw no installation");

  mock.expireGithubTokens();
  await sql("UPDATE connections SET expires_at = 1 WHERE id = ?", [id]);
  const res = await logsOf(() => remove());
  assert.equal(res.status, 200);
  assert.equal(mock.githubLog.refreshes, 1, "a token that works was got first");
  assert.deepEqual(mock.githubLog.revoked, ["token", "grant"]);
  assert.deepEqual(mock.githubLive(), { access: 0, refresh: 0 }, "nothing GitHub gave works any more");
  assert.equal(await githubRow(user.id), null);
  assert.equal((await all("SELECT * FROM connection_tools WHERE connection_id = ?", [id])).length, 0);
  assert.ok(logs.some((l) => l.includes(`connector ${id} github revoke ok`)));
  assert.equal(await balance(user.id), b0, "removing costs nothing");

  // The app stays installed at GitHub: connecting again needs only the authorize step.
  const installs = mock.githubLog.installs;
  assert.equal(await connect(user), "ok");
  assert.equal(mock.githubLog.installs, installs);
  assert.equal((await githubRow(user.id))!.resource, "4242");
});

test("no token or client secret in any answer, log, the database or the stand-in Claude's requests", async () => {
  const user = await account("gh-secrets");
  // One more full round, logged, so this test stands on its own too.
  await logsOf(async () => {
    assert.equal(await connect(user), "ok");
    const id = (await githubRow(user.id))!.id as string;
    replies.push(
      { blocks: [{ type: "tool_use", id: "toolu_1", name: "github__list_repos", input: {} }], stop: "tool_use" },
      { blocks: [{ type: "text", text: "Two repositories." }], stop: "end_turn" },
    );
    await chat(user, "Which repositories can you see?", [id]);
    await connectRoute.DELETE(request("DELETE", "/api/connect", user, { id }));
  });
  const tokens = mock.githubTokens();
  assert.ok(tokens.length >= 4);
  const tables = await all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
  const database: string[] = [];
  for (const { name } of tables) database.push(JSON.stringify(await all(`SELECT * FROM ${name}`)));
  const claudeSaw = JSON.stringify(sent);
  const places = { answers: answers.join("\n"), logs: logs.join("\n"), database: database.join("\n"), claude: claudeSaw };
  assert.ok(claudeSaw.includes("octo/hello"), "Claude got the result");
  for (const secret of [...tokens, "mock-github-secret"]) {
    for (const [where, text] of Object.entries(places)) assert.ok(!text.includes(secret), `${secret.slice(0, 4)}… in ${where}`);
  }
});
