import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { register } from "node:module";
import type { AddressInfo } from "node:net";

/*
 * Figma and Canva in chat (see app-signin.ts, figma.ts and canva.ts), through Flash's own routes:
 * Connect (each service's sign-in and the callback), who may see them (Flash's owners only until the
 * service has reviewed Flash's app), the tools a reply runs, renewing and removing, and Open in Canva,
 * against stand-ins for Figma's and Canva's APIs made here. Nothing here reaches a real service.
 */
register("./support/route-hooks.mjs", import.meta.url);

const ORIGIN = "http://flash.test";
const b64url = (b: Buffer) => b.toString("base64url");
const challengeOf = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());

// ---------------------------------------------------------------------------------------------
// The stand-ins: /figma/www (www.figma.com), /figma/api (api.figma.com), /canva/www (www.canva.com),
// /canva/api (api.canva.com) and /canva/files (Canva's export links).

const FIGMA = { id: "figma-client", secret: "figma-secret" };
const CANVA = { id: "canva-client", secret: "canva-secret" };
const state = {
  figmaRate: "" as "" | "low" | "high",
  figmaRefuseRefresh: false,
  canvaBusy: false,
};
const log = {
  figmaTokens: 0,
  figmaRefreshes: 0,
  figmaFiles: [] as string[],
  canvaTokens: 0,
  canvaRefreshes: 0,
  canvaRevoked: [] as string[],
  canvaExports: [] as unknown[],
  uploads: [] as { name: string; bytes: Buffer }[],
  designsMade: [] as unknown[],
};
const codes = new Map<string, { service: string; challenge: string; redirect: string }>();
const access = new Map<string, { service: string; expires: number }>();
const refreshes = new Map<string, string>();
let issued = 0;

const FILE_KEY = "AbCdEf1234567890";
const FILE = {
  name: "Shop app",
  editorType: "figma",
  lastModified: "2026-10-20T10:00:00Z",
  document: {
    id: "0:0",
    type: "DOCUMENT",
    children: [
      {
        id: "0:1",
        name: "Screens",
        type: "CANVAS",
        children: [
          { id: "1:2", name: "Home", type: "FRAME", absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 844 } },
          { id: "1:3", name: "Hidden", type: "FRAME", visible: false, absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } },
        ],
      },
    ],
  },
};
const HOME = {
  id: "1:2",
  name: "Home",
  type: "FRAME",
  absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 844 },
  layoutMode: "VERTICAL",
  itemSpacing: 16,
  paddingTop: 24,
  paddingRight: 24,
  paddingBottom: 24,
  paddingLeft: 24,
  counterAxisAlignItems: "CENTER",
  fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
  cornerRadius: 12,
  children: [
    {
      id: "1:4",
      name: "Title",
      type: "TEXT",
      characters: "Welcome back",
      absoluteBoundingBox: { x: 24, y: 24, width: 342, height: 34 },
      style: { fontFamily: "Inter", fontWeight: 600, fontSize: 28, lineHeightPx: 34, textAlignHorizontal: "CENTER" },
      fills: [{ type: "SOLID", color: { r: 0.0667, g: 0.0667, b: 0.0667, a: 1 } }],
    },
    {
      id: "1:5",
      name: "Button",
      type: "INSTANCE",
      absoluteBoundingBox: { x: 24, y: 100, width: 342, height: 48 },
      fills: [{ type: "SOLID", color: { r: 0.427, g: 0.157, b: 0.851, a: 1 } }],
      cornerRadius: 24,
      effects: [{ type: "DROP_SHADOW", visible: true, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 8 }],
      children: [{ id: "1:6", name: "Label", type: "TEXT", characters: "Get started", style: { fontFamily: "Inter", fontSize: 16 }, fills: [] }],
    },
    { id: "1:7", name: "Secret layer", type: "RECTANGLE", visible: false },
  ],
};

const { page, pagesPdf } = await import("./support/pdfs.ts");
const DESIGN_PDF = Buffer.from(pagesPdf([page("Summer sale 50 percent off"), page("Visit our shop")]));

const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function basicOk(req: IncomingMessage, client: { id: string; secret: string }) {
  return req.headers.authorization === `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}`;
}

/** The bearer token of a request, if it is one this stand-in issued for the service and still good. */
function bearer(req: IncomingMessage, service: string) {
  const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
  const a = access.get(token);
  return a && a.service === service && a.expires > Date.now() ? token : null;
}

function issue(service: string, withRefresh = true) {
  issued++;
  const token = `${service}-access-${issued}-${randomBytes(4).toString("hex")}`;
  access.set(token, { service, expires: Date.now() + 3600_000 });
  const refresh = withRefresh ? `${service}-refresh-${issued}-${randomBytes(4).toString("hex")}` : "";
  if (refresh) refreshes.set(refresh, service);
  return { token, refresh };
}

let mockOrigin = "";
const jobs = new Map<string, { polls: number; body: Record<string, unknown> }>();

const mock = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://mock");
  const path = url.pathname;
  const body = await readBody(req);
  // Sign-in pages: the user says yes at once.
  if (path === "/figma/www/oauth" || path === "/canva/www/api/oauth/authorize") {
    const service = path.startsWith("/figma") ? "figma" : "canva";
    const code = `${service}-code-${randomBytes(6).toString("hex")}`;
    codes.set(code, { service, challenge: url.searchParams.get("code_challenge") ?? "", redirect: url.searchParams.get("redirect_uri") ?? "" });
    const back = new URL(url.searchParams.get("redirect_uri") ?? "");
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { location: back.href });
    return res.end();
  }
  const form = new URLSearchParams(body.toString());
  // Figma
  if (path === "/figma/api/v1/oauth/token") {
    if (!basicOk(req, FIGMA)) return json(res, 401, { error: true, status: 401 });
    const c = codes.get(form.get("code") ?? "");
    codes.delete(form.get("code") ?? "");
    if (!c || c.service !== "figma" || form.get("grant_type") !== "authorization_code" || challengeOf(form.get("code_verifier") ?? "") !== c.challenge || form.get("redirect_uri") !== c.redirect) {
      return json(res, 400, { error: true, status: 400, message: "Invalid code" });
    }
    log.figmaTokens++;
    const t = issue("figma");
    return json(res, 200, { user_id_string: "777", access_token: t.token, refresh_token: t.refresh, expires_in: 7776000, token_type: "bearer" });
  }
  if (path === "/figma/api/v1/oauth/refresh") {
    if (!basicOk(req, FIGMA)) return json(res, 401, { error: true });
    log.figmaRefreshes++;
    if (state.figmaRefuseRefresh || refreshes.get(form.get("refresh_token") ?? "") !== "figma") return json(res, 400, { error: true, status: 400, message: "Invalid refresh token" });
    return json(res, 200, { access_token: issue("figma", false).token, expires_in: 7776000, token_type: "bearer" });
  }
  if (path.startsWith("/figma/api/")) {
    if (!bearer(req, "figma")) return json(res, 403, { status: 403, err: "Invalid token" }), undefined;
    if (path === "/figma/api/v1/me") return json(res, 200, { id: "777", email: "designer@example.com", handle: "Dee" });
    log.figmaFiles.push(path + url.search);
    if (state.figmaRate) return json(res, 429, { status: 429, err: "Rate limit exceeded" }, { "retry-after": "432000", "x-figma-rate-limit-type": state.figmaRate });
    if (path === `/figma/api/v1/files/${FILE_KEY}`) return json(res, 200, FILE);
    if (path === `/figma/api/v1/files/${FILE_KEY}/nodes`) {
      const id = url.searchParams.get("ids") ?? "";
      return json(res, 200, { name: FILE.name, nodes: { [id]: id === "1:2" ? { document: HOME } : null } });
    }
    return json(res, 404, { status: 404, err: "Not found" });
  }
  // Canva
  if (path === "/canva/api/rest/v1/oauth/token") {
    if (!basicOk(req, CANVA)) return json(res, 401, { error: "invalid_client" });
    if (form.get("grant_type") === "authorization_code") {
      const c = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      if (!c || c.service !== "canva" || challengeOf(form.get("code_verifier") ?? "") !== c.challenge) return json(res, 400, { error: "invalid_grant" });
      log.canvaTokens++;
      const t = issue("canva");
      return json(res, 200, { access_token: t.token, refresh_token: t.refresh, expires_in: 14400, token_type: "Bearer", scope: "design:meta:read design:content:read" });
    }
    if (form.get("grant_type") === "refresh_token") {
      log.canvaRefreshes++;
      const old = form.get("refresh_token") ?? "";
      if (refreshes.get(old) !== "canva") return json(res, 400, { error: "invalid_grant" });
      // Each refresh token works once.
      refreshes.delete(old);
      const t = issue("canva");
      return json(res, 200, { access_token: t.token, refresh_token: t.refresh, expires_in: 14400, token_type: "Bearer" });
    }
    return json(res, 400, { error: "unsupported_grant_type" });
  }
  if (path === "/canva/api/rest/v1/oauth/revoke") {
    if (!basicOk(req, CANVA)) return json(res, 401, { error: "invalid_client" });
    log.canvaRevoked.push(form.get("token") ?? "");
    refreshes.delete(form.get("token") ?? "");
    return json(res, 200, {});
  }
  if (path === "/canva/files/design.pdf") {
    res.writeHead(200, { "content-type": "application/pdf" });
    return res.end(DESIGN_PDF);
  }
  if (path.startsWith("/canva/api/rest/")) {
    if (!bearer(req, "canva")) return json(res, 401, { code: "invalid_access_token", message: "Bad token" });
    const api = path.slice("/canva/api/rest".length);
    if (api === "/v1/users/me") return json(res, 200, { team_user: { user_id: "canvaUser1", team_id: "team1" } });
    if (api === "/v1/users/me/profile") return json(res, 200, { profile: { display_name: "Dana Designer" } });
    const design = (id: string) => ({ id, title: "Summer sale flyer", page_count: 2, updated_at: 1_790_000_000, urls: { edit_url: `https://www.canva.com/design/${id}/edit`, view_url: "https://www.canva.com/x" } });
    if (api === "/v1/designs" && req.method === "GET") {
      const q = url.searchParams.get("query") ?? "";
      return json(res, 200, { items: q === "nothing" ? [] : [design("DAGsale001"), design("DAGsale002")] });
    }
    if (api === "/v1/designs/DAGsale001") return json(res, 200, { design: design("DAGsale001") });
    if (api.startsWith("/v1/designs/")) return json(res, 404, { code: "not_found", message: "Design not found" });
    const start = (kind: string, done: Record<string, unknown>) => {
      const id = `${kind}-job-${jobs.size + 1}`;
      jobs.set(id, { polls: 0, body: done });
      return json(res, 200, { job: { id, status: "in_progress" } });
    };
    const poll = (id: string) => {
      const job = jobs.get(id);
      if (!job) return json(res, 404, { code: "not_found" });
      job.polls++;
      if (state.canvaBusy || job.polls < 2) return json(res, 200, { job: { id, status: "in_progress" } });
      return json(res, 200, { job: { id, status: "success", ...job.body } });
    };
    if (api === "/v1/exports" && req.method === "POST") {
      const asked = JSON.parse(body.toString()) as { design_id: string; format: { type: string; pages?: number[] } };
      log.canvaExports.push(asked);
      if (asked.design_id !== "DAGsale001") return json(res, 404, { code: "not_found", message: "Design not found" });
      const urls = asked.format.type === "pdf" ? [`${mockOrigin}/canva/files/design.pdf`] : (asked.format.pages ?? [1, 2]).map((p) => `${mockOrigin}/canva/files/page-${p}.${asked.format.type}`);
      return start("export", { urls });
    }
    if (api.startsWith("/v1/exports/")) return poll(api.slice("/v1/exports/".length));
    if (api === "/v1/asset-uploads" && req.method === "POST") {
      const meta = JSON.parse(String(req.headers["asset-upload-metadata"] ?? "{}")) as { name_base64?: string };
      if (req.headers["content-type"] !== "application/octet-stream" || !meta.name_base64) return json(res, 400, { code: "bad_request", message: "Bad upload" });
      log.uploads.push({ name: Buffer.from(meta.name_base64, "base64").toString(), bytes: body });
      return start("upload", { asset: { id: "asset-123", name: "x" } });
    }
    if (api.startsWith("/v1/asset-uploads/")) return poll(api.slice("/v1/asset-uploads/".length));
    if (api === "/v1/designs" && req.method === "POST") {
      const asked = JSON.parse(body.toString()) as { asset_id?: string };
      log.designsMade.push(asked);
      return json(res, 200, { design: { id: "DAGnew0001", urls: { edit_url: "https://www.canva.com/design/DAGnew0001/edit?token=abc" } } });
    }
    return json(res, 404, { code: "not_found" });
  }
  json(res, 404, { error: "no such stand-in" });
});
await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
mockOrigin = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

process.env.DATABASE_URL = ":memory:";
process.env.CONNECTOR_KEYS = JSON.stringify({ v1: randomBytes(32).toString("base64") });
process.env.FLASH_APP_URL = ORIGIN;
process.env.FLASH_CONNECT_MOCK = mockOrigin;
process.env.FLASH_ADMIN_EMAILS = Array.from({ length: 10 }, (_, i) => `owner${i + 1}@example.com`).join(",");
process.env.FIGMA_CONNECT_CLIENT_ID = FIGMA.id;
process.env.FIGMA_CONNECT_CLIENT_SECRET = FIGMA.secret;
process.env.CANVA_CONNECT_CLIENT_ID = CANVA.id;
process.env.CANVA_CONNECT_CLIENT_SECRET = CANVA.secret;
delete process.env.FIGMA_CONNECT_PUBLIC;
delete process.env.CANVA_CONNECT_PUBLIC;
delete process.env.VERCEL_ENV;
delete process.env.RESEND_API_KEY;
after(async () => {
  mock.closeAllConnections();
  mock.close();
});

const { one, run: sql } = await import("../src/lib/server/db.ts");
const { chatKit } = await import("../src/lib/server/connections.ts");
const { parseFigmaLink } = await import("../src/lib/server/figma.ts");
const { parseCanvaDesign } = await import("../src/lib/server/canva.ts");
const { adminStats } = await import("../src/lib/server/admin-stats.ts");
const connectRoute = await import("../src/app/api/connect/route.ts");
const routes = {
  figma: { start: await import("../src/app/api/connect/figma/start/route.ts"), callback: await import("../src/app/api/connect/figma/callback/route.ts") },
  canva: { start: await import("../src/app/api/connect/canva/start/route.ts"), callback: await import("../src/app/api/connect/canva/callback/route.ts") },
};
const sendRoute = await import("../src/app/api/connect/canva/send/route.ts");

beforeEach(() => {
  state.figmaRate = "";
  state.figmaRefuseRefresh = false;
  state.canvaBusy = false;
  log.figmaFiles.length = 0;
  log.canvaExports.length = 0;
  log.uploads.length = 0;
  log.designsMade.length = 0;
});

/** A user with a session (confirmed unless told otherwise); owner1@… to owner10@… are Flash's owners. */
async function account(id: string, { email = `${id}@example.com`, verified = true } = {}) {
  const token = `tok_${id}_${randomBytes(6).toString("hex")}`;
  await sql("INSERT INTO users (id, email, name, password_hash, preferences, created_at, last_free_grant, verified_at) VALUES (?, ?, '', 'x', '', 0, 0, ?)", [id, email, verified ? 1 : 0]);
  await sql("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [createHash("sha256").update(token).digest("hex"), id, Date.now() + 3600_000]);
  return { id, cookie: `flash_session=${token}` };
}
type Account = Awaited<ReturnType<typeof account>>;

const request = (method: string, path: string, user: Account, body?: object, origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie: user.cookie, ...(origin !== null && { origin }) },
    ...(body && { body: JSON.stringify(body) }),
  });

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const keep = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, keep);
  }
};

async function start(service: "figma" | "canva", user: Account, body: object = {}, origin: string | null = ORIGIN) {
  const res = await quiet(() => routes[service].start.POST(request("POST", `/api/connect/${service}/start`, user, body, origin)));
  return { status: res.status, body: (await res.json()) as { url?: string; error?: string } };
}

async function callback(service: "figma" | "canva", user: Account, search: string) {
  const res = await quiet(() => routes[service].callback.GET(new Request(`${ORIGIN}/api/connect/${service}/callback${search}`, { headers: { cookie: user.cookie } })));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  return new URL(res.headers.get("location")!).searchParams.get("connect");
}

/** The browser at the service's sign-in page: the address it sends the browser back to. */
async function visit(url: string) {
  const res = await fetch(url, { redirect: "manual" });
  assert.equal(res.status, 302);
  return new URL(res.headers.get("location")!);
}

async function connect(service: "figma" | "canva", user: Account) {
  const started = await start(service, user);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return callback(service, user, (await visit(started.body.url!)).search);
}

const rowOf = (userId: string, provider: string) => one<Record<string, unknown>>("SELECT * FROM connections WHERE user_id = ? AND provider = ?", [userId, provider]);

async function listed(user: Account) {
  const res = await connectRoute.GET(request("GET", "/api/connect", user));
  return (await res.json()) as { figma: boolean; canva: boolean; connections: { provider: string; account?: string; revocable: boolean; signIn: boolean; tools: { name: string; kind: string }[] }[] };
}

/** Runs one of a connection's tools as a reply would. */
async function runTool(userId: string, connectionId: string, tool: string, input: Record<string, unknown>) {
  const kit = (await chatKit(userId, [connectionId]))!;
  try {
    const t = kit.tools.find((x) => x.tool === tool);
    assert.ok(t, `no tool ${tool}`);
    return await quiet(() => kit.run(t, input));
  } finally {
    await kit.close();
  }
}

test("links: Figma and Canva links are read for their file, frame and design, and anything else is refused", () => {
  assert.deepEqual(parseFigmaLink(`https://www.figma.com/design/${FILE_KEY}/Shop-app?node-id=1-2&t=x`), { key: FILE_KEY, node: "1:2" });
  assert.deepEqual(parseFigmaLink(`https://figma.com/file/${FILE_KEY}/Shop`), { key: FILE_KEY, node: "" });
  assert.deepEqual(parseFigmaLink(`https://www.figma.com/design/${FILE_KEY}/branch/BrAnCh123456/Shop`), { key: "BrAnCh123456", node: "" });
  assert.deepEqual(parseFigmaLink(FILE_KEY, "1:2"), { key: FILE_KEY, node: "1:2" });
  assert.equal(parseFigmaLink(`https://evil.example/design/${FILE_KEY}/x`), null);
  assert.equal(parseFigmaLink(`http://www.figma.com/design/${FILE_KEY}/x`), null);
  assert.equal(parseFigmaLink(`https://www.figma.com/design/${FILE_KEY}/x?node-id=../../me`), null);
  assert.equal(parseFigmaLink("../../v1/me"), null);
  assert.equal(parseCanvaDesign("https://www.canva.com/design/DAGsale001/abc/edit"), "DAGsale001");
  assert.equal(parseCanvaDesign("DAGsale001"), "DAGsale001");
  assert.equal(parseCanvaDesign("https://canva.evil.example/design/DAGsale001/edit"), null);
  assert.equal(parseCanvaDesign("../users/me"), null);
});

test("before the review, only Flash's owners see Figma and Canva; the rest get 404", async () => {
  const user = await account("fc-user");
  const owner = await account("fc-owner", { email: "owner1@example.com" });
  const asUser = await listed(user);
  assert.equal(asUser.figma, false);
  assert.equal(asUser.canva, false);
  assert.equal((await start("figma", user)).status, 404);
  assert.equal((await start("canva", user)).status, 404);
  const asOwner = await listed(owner);
  assert.equal(asOwner.figma, true);
  assert.equal(asOwner.canva, true);
  // Once a service says yes, everyone may connect it.
  process.env.CANVA_CONNECT_PUBLIC = "true";
  try {
    assert.equal((await listed(user)).canva, true);
    assert.equal((await listed(user)).figma, false);
  } finally {
    delete process.env.CANVA_CONNECT_PUBLIC;
  }
  // From another page, never.
  assert.equal((await start("figma", owner, {}, "https://evil.example")).status, 403);
  const stats = await adminStats(7);
  assert.deepEqual(stats.connectors.figma, { setUp: true, missing: [], open: false });
});

test("Connect Figma: its sign-in with PKCE S256 and read scopes only; the account is the one Figma names; tools only read; Figma can't be asked to cancel", async () => {
  const owner = await account("figma-owner", { email: "owner2@example.com" });
  const started = await start("figma", owner);
  const page = new URL(started.body.url!);
  assert.equal(page.origin + page.pathname, `${mockOrigin}/figma/www/oauth`);
  assert.equal(page.searchParams.get("client_id"), FIGMA.id);
  assert.equal(page.searchParams.get("redirect_uri"), `${ORIGIN}/api/connect/figma/callback`);
  assert.equal(page.searchParams.get("scope"), "current_user:read file_content:read");
  assert.equal(page.searchParams.get("code_challenge_method"), "S256");
  assert.ok(!started.body.url!.includes(FIGMA.secret));
  assert.equal(await callback("figma", owner, (await visit(page.href)).search), "ok");
  const row = (await rowOf(owner.id, "figma"))!;
  assert.equal(row.kind, "figma");
  assert.equal(row.account_id, "777");
  assert.equal(row.resource, "designer@example.com");
  assert.ok(row.enc_refresh);
  assert.ok(!String(row.enc_access).includes("figma-access"), "tokens are sealed");
  const c = (await listed(owner)).connections.find((x) => x.provider === "figma")!;
  assert.deepEqual([c.account, c.signIn, c.revocable], ["designer@example.com", true, false]);
  assert.deepEqual(c.tools.map((t) => `${t.name}:${t.kind}`), ["read_file:read", "read_frame:read"]);
  // Another user's state trades nothing.
  const other = await account("figma-other", { email: "owner3@example.com" });
  const theirs = await start("figma", owner);
  assert.equal(await callback("figma", other, (await visit(theirs.body.url!)).search), "expired");
});

test("Figma tools: a file's pages and frames, then a frame as a spec; Figma's limit said plainly; a refused refresh asks for Reconnect", async () => {
  const owner = await account("figma-tools", { email: "owner4@example.com" });
  assert.equal(await connect("figma", owner), "ok");
  const id = (await rowOf(owner.id, "figma"))!.id as string;
  const file = await runTool(owner.id, id, "read_file", { link: `https://www.figma.com/design/${FILE_KEY}/Shop-app` });
  assert.equal(file.isError, false, file.text);
  assert.match(file.text, /"Shop app"/);
  assert.match(file.text, /FRAME "Home" \[1:2\] 390×844/);
  assert.ok(!file.text.includes("Hidden"), "hidden frames are left out");
  assert.deepEqual(log.figmaFiles, [`/figma/api/v1/files/${FILE_KEY}?depth=2`]);

  const frame = await runTool(owner.id, id, "read_frame", { link: `https://www.figma.com/design/${FILE_KEY}/Shop-app?node-id=1-2` });
  assert.equal(frame.isError, false, frame.text);
  assert.match(frame.text, /auto layout vertical, gap 16, padding 24 24 24 24, align start \/ center/);
  assert.match(frame.text, /fill #FFFFFF/);
  assert.match(frame.text, /radius 12/);
  assert.match(frame.text, /TEXT "Title" \[1:4\] text "Welcome back" .*Inter 600 28px\/34px .*colour #111111 .*align center/);
  assert.match(frame.text, /shadow 0 4 8 #000000 25%/);
  assert.match(frame.text, /Colours used: .*#6D28D9/);
  assert.ok(!frame.text.includes("Secret layer"), "hidden layers are left out");

  const bad = await runTool(owner.id, id, "read_frame", { link: "https://evil.example/x" });
  assert.equal(bad.isError, true);
  const noFrame = await runTool(owner.id, id, "read_frame", { link: `https://www.figma.com/design/${FILE_KEY}/Shop-app` });
  assert.equal(noFrame.isError, true);
  assert.match(noFrame.text, /name the frame/);
  const missing = await runTool(owner.id, id, "read_frame", { link: FILE_KEY, node_id: "9:9" });
  assert.equal(missing.isError, true);

  state.figmaRate = "low";
  const limited = await runTool(owner.id, id, "read_file", { link: FILE_KEY });
  assert.equal(limited.isError, true);
  assert.match(limited.text, /only a few file reads a month for a View or Collab seat/);
  assert.match(limited.text, /about 5 days/);
  state.figmaRate = "";

  // An access token that ran out is renewed with the same refresh token.
  const before = log.figmaRefreshes;
  await sql("UPDATE connections SET expires_at = 1 WHERE id = ?", [id]);
  const renewed = await runTool(owner.id, id, "read_file", { link: FILE_KEY });
  assert.equal(renewed.isError, false, renewed.text);
  assert.equal(log.figmaRefreshes, before + 1);
  // A refresh Figma refuses: the account waits for Reconnect.
  state.figmaRefuseRefresh = true;
  await sql("UPDATE connections SET expires_at = 1 WHERE id = ?", [id]);
  const kit = await chatKit(owner.id, [id]);
  if (kit) {
    const t = kit.tools.find((x) => x.tool === "read_file")!;
    await quiet(() => kit.run(t, { link: FILE_KEY }));
    await kit.close();
  }
  assert.equal((await rowOf(owner.id, "figma"))!.status, "needs_reconnect");
});

test("Canva: connect, find, read (its words from a PDF export) and export designs; refresh tokens rotate; removing cancels the grant", async () => {
  const owner = await account("canva-owner", { email: "owner5@example.com" });
  const started = await start("canva", owner);
  const page = new URL(started.body.url!);
  assert.equal(page.origin + page.pathname, `${mockOrigin}/canva/www/api/oauth/authorize`);
  assert.equal(page.searchParams.get("redirect_uri"), `${ORIGIN}/api/connect/canva/callback`);
  assert.match(page.searchParams.get("scope") ?? "", /design:content:read/);
  assert.equal(await callback("canva", owner, (await visit(page.href)).search), "ok");
  const row = (await rowOf(owner.id, "canva"))!;
  const id = row.id as string;
  assert.equal(row.account_id, "canvaUser1");
  assert.equal(row.resource, "Dana Designer");
  const c = (await listed(owner)).connections.find((x) => x.provider === "canva")!;
  assert.equal(c.revocable, true);
  assert.deepEqual(c.tools.map((t) => `${t.name}:${t.kind}`), ["search_designs:read", "read_design:read", "export_design:read"]);

  const found = await runTool(owner.id, id, "search_designs", {});
  assert.equal(found.isError, false, found.text);
  assert.match(found.text, /"Summer sale flyer" \(id DAGsale001, 2 pages/);
  assert.match((await runTool(owner.id, id, "search_designs", { query: "nothing" })).text, /No Canva design/);

  const read = await runTool(owner.id, id, "read_design", { design: "https://www.canva.com/design/DAGsale001/x/edit" });
  assert.equal(read.isError, false, read.text);
  assert.match(read.text, /Summer sale 50 percent off/);
  assert.match(read.text, /Visit our shop/);
  assert.deepEqual(log.canvaExports, [{ design_id: "DAGsale001", format: { type: "pdf" } }]);

  const png = await runTool(owner.id, id, "export_design", { design: "DAGsale001", pages: [2] });
  assert.equal(png.isError, false, png.text);
  assert.match(png.text, /Page 2: .*page-2\.png/);
  const wrong = await runTool(owner.id, id, "export_design", { design: "DAGsale001", format: "gif" });
  assert.equal(wrong.isError, true);
  state.canvaBusy = true;
  const busy = await runTool(owner.id, id, "export_design", { design: "DAGsale001" });
  assert.equal(busy.isError, true);
  assert.match(busy.text, /still preparing/);
  state.canvaBusy = false;

  // A new refresh token each time, kept in place of the one used.
  const oldRefresh = (await rowOf(owner.id, "canva"))!.enc_refresh;
  await sql("UPDATE connections SET expires_at = 1 WHERE id = ?", [id]);
  assert.equal((await runTool(owner.id, id, "search_designs", {})).isError, false);
  assert.notEqual((await rowOf(owner.id, "canva"))!.enc_refresh, oldRefresh);
  assert.equal((await runTool(owner.id, id, "search_designs", {})).isError, false, "the new one keeps working");

  const revokedBefore = log.canvaRevoked.length;
  const res = await quiet(() => connectRoute.DELETE(request("DELETE", "/api/connect", owner, { id })));
  assert.equal(res.status, 200);
  assert.equal(log.canvaRevoked.length, revokedBefore + 1);
  assert.match(log.canvaRevoked.at(-1)!, /^canva-refresh-/, "the refresh token, which cancels the whole grant");
  assert.equal(await rowOf(owner.id, "canva"), null);
});

test("Open in Canva: only the user's own picture goes to their Canva, from Flash's own page, and a design is made with it", async () => {
  const owner = await account("canva-send", { email: "owner6@example.com" });
  const other = await account("canva-send-other");
  const noCanva = await account("canva-send-none", { email: "owner7@example.com" });
  assert.equal(await connect("canva", owner), "ok");
  const picture = randomBytes(2048);
  await sql("INSERT INTO files (id, user_id, mime, name, data, created_at) VALUES (?, ?, ?, ?, ?, ?)", ["fileMine000000001", owner.id, "image/png", "sunset.png", picture, Date.now()]);
  await sql("INSERT INTO files (id, user_id, mime, name, data, created_at) VALUES (?, ?, ?, ?, ?, ?)", ["fileOther00000001", other.id, "image/png", "theirs.png", randomBytes(10), Date.now()]);
  await sql("INSERT INTO files (id, user_id, mime, name, data, created_at) VALUES (?, ?, ?, ?, ?, ?)", ["fileSong000000001", owner.id, "audio/mpeg", "song.mp3", randomBytes(10), Date.now()]);
  const send = async (user: Account, fileId: string, origin: string | null = ORIGIN) => {
    const res = await quiet(() => sendRoute.POST(request("POST", "/api/connect/canva/send", user, { fileId }, origin)));
    return { status: res.status, body: (await res.json()) as { url?: string; error?: string } };
  };
  const sent = await send(owner, "fileMine000000001");
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.url, "https://www.canva.com/design/DAGnew0001/edit?token=abc");
  assert.equal(log.uploads.length, 1);
  assert.equal(log.uploads[0].name, "sunset.png");
  assert.ok(log.uploads[0].bytes.equals(picture), "the picture's exact bytes");
  assert.deepEqual(log.designsMade, [{ asset_id: "asset-123", title: "sunset.png" }]);

  assert.equal((await send(owner, "fileOther00000001")).status, 400, "someone else's picture");
  assert.equal((await send(owner, "fileSong000000001")).status, 400, "not a picture");
  assert.equal((await send(owner, "fileMine000000001", "https://evil.example")).status, 403);
  assert.equal((await send(noCanva, "fileMine000000001")).status, 404, "no Canva connected");
  assert.equal(log.uploads.length, 1);
});
