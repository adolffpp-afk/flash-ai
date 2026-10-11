import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { blockedAddress, checkUrl, mockOrigin, safeFetch, sendTo, SafeFetchError, type Resolver, type SafeRequest } from "../src/lib/server/safe-fetch.ts";

const resolver =
  (map: Record<string, string[]>): Resolver =>
  async (host) => {
    const found = map[host];
    if (!found) throw new Error("ENOTFOUND");
    return found.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };

const isBlocked = (err: unknown) => err instanceof SafeFetchError && err.code === "blocked";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

test("private, local and reserved addresses are blocked, IPv4-mapped and translated ones too", () => {
  for (const a of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "0:0:0:0:0:ffff:7f00:1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "2002:7f00:1::1", // 6to4 of 127.0.0.1
    "64:ff9b::7f00:1", // NAT64 of 127.0.0.1
    "2001::1", // Teredo
    "ff02::1",
    "not-an-ip",
  ]) {
    assert.equal(blockedAddress(a), true, a);
  }
  for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4001::1"]) assert.equal(blockedAddress(a), false, a);
});

test("only https on 443 to a public-looking name, never Flash's own", () => {
  for (const url of [
    "http://example.com/mcp",
    "https://example.com:8443/mcp",
    "https://user:pw@example.com/mcp",
    "https://127.0.0.1/mcp",
    "https://[::1]/mcp",
    "https://2130706433/mcp",
    "https://0x7f.1/mcp",
    "https://localhost/mcp",
    "https://intranet/mcp",
    "https://printer.local/mcp",
    "https://db.internal/mcp",
    "https://www.flash-app.dev/api/me",
    "https://flash-app.dev/mcp",
    "file:///etc/passwd",
    "ftp://example.com",
    "nonsense",
  ]) {
    assert.throws(() => checkUrl(url), isBlocked, url);
  }
  assert.equal(checkUrl("https://mcp.linear.app/mcp").hostname, "mcp.linear.app");
  assert.equal(checkUrl("https://example.com:443/x").href, "https://example.com/x");
});

test("a name is used only when every address it has is public, and only a checked one is connected to", async () => {
  const sent: { host: string; to: string }[] = [];
  const send: typeof sendTo = async (url, to) => {
    sent.push({ host: url.hostname, to: to!.address });
    return { status: 200, headers: {}, contentType: "application/json", body: "{}", url: url.href };
  };
  const resolve = resolver({
    "public.example.com": ["93.184.216.34"],
    "mixed.example.com": ["93.184.216.34", "10.0.0.5"],
    "inside.example.com": ["169.254.169.254"],
    "mapped.example.com": ["::ffff:127.0.0.1"],
    "nat64.example.com": ["64:ff9b::a00:1"],
  });
  for (const host of ["mixed", "inside", "mapped", "nat64"]) {
    await assert.rejects(safeFetch(`https://${host}.example.com/mcp`, {}, { resolve, send }), isBlocked, host);
  }
  await assert.rejects(safeFetch("https://missing.example.com/", {}, { resolve, send }), (e: unknown) => e instanceof SafeFetchError && e.code === "network");
  assert.equal(sent.length, 0, "nothing was sent to a blocked name");
  const res = await safeFetch("https://public.example.com/mcp", {}, { resolve, send });
  assert.equal(res.status, 200);
  assert.deepEqual(sent, [{ host: "public.example.com", to: "93.184.216.34" }]);
});

test("redirects are checked again, the key is dropped for another server, and at most 3 are followed", async () => {
  const resolve = resolver({ "a.example.com": ["93.184.216.34"], "b.example.com": ["93.184.216.35"], "evil.example.com": ["10.0.0.1"] });
  const seen: { url: string; headers: Record<string, string>; method: string }[] = [];
  const routes: Record<string, string> = {};
  const send: typeof sendTo = async (url, _to, req, headers) => {
    seen.push({ url: url.href, headers, method: req.method ?? "GET" });
    const location = routes[url.href];
    return location
      ? { status: 307, headers: { location }, contentType: "", body: "", url: url.href }
      : { status: 200, headers: {}, contentType: "application/json", body: "{}", url: url.href };
  };
  const req: SafeRequest = { method: "POST", body: "{}", headers: { authorization: "Bearer k", "content-type": "application/json", "mcp-session-id": "s" } };

  routes["https://a.example.com/1"] = "/2";
  routes["https://a.example.com/2"] = "https://b.example.com/3";
  await safeFetch("https://a.example.com/1", req, { resolve, send });
  assert.equal(seen[1].headers.authorization, "Bearer k", "same server keeps the key");
  assert.equal(seen[2].url, "https://b.example.com/3");
  assert.equal(seen[2].headers.authorization, undefined, "another server never gets the key");
  assert.equal(seen[2].headers["mcp-session-id"], undefined);
  assert.equal(seen[2].method, "POST", "307 keeps the method");

  seen.length = 0;
  routes["https://a.example.com/to-evil"] = "https://evil.example.com/x";
  await assert.rejects(safeFetch("https://a.example.com/to-evil", req, { resolve, send }), isBlocked);
  routes["https://a.example.com/to-local"] = "http://127.0.0.1/admin";
  await assert.rejects(safeFetch("https://a.example.com/to-local", req, { resolve, send }), isBlocked);
  assert.ok(seen.every((s) => new URL(s.url).hostname === "a.example.com"), "nothing was sent past a blocked redirect");

  for (let i = 0; i < 5; i++) routes[`https://a.example.com/loop${i}`] = `/loop${i + 1}`;
  await assert.rejects(safeFetch("https://a.example.com/loop0", {}, { resolve, send }), (e: unknown) => e instanceof SafeFetchError && e.code === "redirects");
});

test("a request connects only to the checked address, whatever the name says", async () => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ host: req.headers.host }));
  });
  const port = await listen(server);
  try {
    // The name doesn't exist; the connection goes to the address Flash checked (here, a local test server).
    const url = new URL(`http://made-up-name.example:${port}/x`);
    const res = await sendTo(url, { address: "127.0.0.1", family: 4 }, {}, {}, new AbortController().signal, 1000);
    assert.equal(JSON.parse(res.body).host, `made-up-name.example:${port}`);
  } finally {
    server.close();
  }
});

test("answers are capped in size and time, and must be JSON or an event stream", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/big") {
      res.setHeader("content-type", "application/json");
      res.end("x".repeat(5000));
    } else if (req.url === "/slow") {
      res.setHeader("content-type", "application/json");
      res.write("{");
      setTimeout(() => res.end("}"), 3000);
    } else if (req.url === "/html") {
      res.setHeader("content-type", "text/html");
      res.end("<html></html>");
    } else if (req.url === "/sse") {
      res.setHeader("content-type", "text/event-stream");
      res.end('data: {"ok":true}\n\n');
    } else if (req.url === "/untyped") {
      res.end("hello");
    } else if (req.url === "/accepted") {
      res.statusCode = 202;
      res.end();
    } else {
      res.statusCode = 401;
      res.setHeader("content-type", "text/plain");
      res.end("no ".repeat(50_000));
    }
  });
  const port = await listen(server);
  const before = { mock: process.env.FLASH_CONNECT_MOCK, vercel: process.env.VERCEL_ENV };
  process.env.FLASH_CONNECT_MOCK = `http://127.0.0.1:${port}`;
  delete process.env.VERCEL_ENV;
  const base = `http://127.0.0.1:${port}`;
  try {
    await assert.rejects(safeFetch(`${base}/big`, { maxBytes: 1000 }), (e: unknown) => e instanceof SafeFetchError && e.code === "too_large");
    assert.equal((await safeFetch(`${base}/big`, { maxBytes: 10_000 })).body.length, 5000);
    const started = Date.now();
    await assert.rejects(safeFetch(`${base}/slow`, { timeoutMs: 300 }), (e: unknown) => e instanceof SafeFetchError && e.code === "timeout");
    assert.ok(Date.now() - started < 2000);
    await assert.rejects(safeFetch(`${base}/html`), (e: unknown) => e instanceof SafeFetchError && e.code === "bad_type");
    await assert.rejects(safeFetch(`${base}/untyped`), (e: unknown) => e instanceof SafeFetchError && e.code === "bad_type");
    assert.equal((await safeFetch(`${base}/sse`)).contentType, "text/event-stream");
    assert.equal((await safeFetch(`${base}/accepted`, { method: "POST", body: "{}" })).status, 202);
    const denied = await safeFetch(`${base}/denied`);
    assert.equal(denied.status, 401);
    assert.ok(denied.body.length <= 16 * 1024, "an error's start is read, not all of it");
    // Stop: the caller's signal ends the request with its own reason.
    const stop = new AbortController();
    setTimeout(() => stop.abort(new Error("stopped")), 100);
    await assert.rejects(safeFetch(`${base}/slow`, { signal: stop.signal }), /stopped/);
  } finally {
    server.close();
    if (before.mock === undefined) delete process.env.FLASH_CONNECT_MOCK;
    else process.env.FLASH_CONNECT_MOCK = before.mock;
    if (before.vercel !== undefined) process.env.VERCEL_ENV = before.vercel;
  }
});

test("the dev mock origin is let through only off Vercel, and only that one origin", () => {
  const before = { mock: process.env.FLASH_CONNECT_MOCK, vercel: process.env.VERCEL_ENV };
  try {
    process.env.FLASH_CONNECT_MOCK = "http://127.0.0.1:7788";
    delete process.env.VERCEL_ENV;
    assert.equal(mockOrigin(), "http://127.0.0.1:7788");
    assert.equal(checkUrl("http://127.0.0.1:7788/mcp").port, "7788");
    assert.throws(() => checkUrl("http://127.0.0.1:7789/mcp"), isBlocked);
    assert.throws(() => checkUrl("http://127.0.0.1/mcp"), isBlocked);
    for (const env of ["production", "preview", "development"]) {
      process.env.VERCEL_ENV = env;
      assert.equal(mockOrigin(), "", env);
      assert.throws(() => checkUrl("http://127.0.0.1:7788/mcp"), isBlocked, env);
    }
    delete process.env.VERCEL_ENV;
    process.env.FLASH_CONNECT_MOCK = "http://10.0.0.1:7788";
    assert.equal(mockOrigin(), "", "only a loopback origin can be the mock");
  } finally {
    if (before.mock === undefined) delete process.env.FLASH_CONNECT_MOCK;
    else process.env.FLASH_CONNECT_MOCK = before.mock;
    if (before.vercel === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = before.vercel;
  }
});
