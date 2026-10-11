import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { headerParams, headerValue, LEGACY, McpClient, McpError, MODERN, readTool, toolHash, toolOutput } from "../src/lib/server/mcp-client.ts";
import { tokensAtMost } from "../src/lib/tokens.ts";
import { cut } from "../src/lib/engines/connect.ts";
import { POISON, startMockConnectors } from "../scripts/mock-connectors.ts";

let mock: Awaited<ReturnType<typeof startMockConnectors>>;
const env = { mock: process.env.FLASH_CONNECT_MOCK, vercel: process.env.VERCEL_ENV };

before(async () => {
  mock = await startMockConnectors(0);
  // The mock is on 127.0.0.1, which safeFetch lets through only as the dev mock origin.
  process.env.FLASH_CONNECT_MOCK = mock.origin;
  delete process.env.VERCEL_ENV;
});
after(async () => {
  await mock.close();
  if (env.mock === undefined) delete process.env.FLASH_CONNECT_MOCK;
  else process.env.FLASH_CONNECT_MOCK = env.mock;
  if (env.vercel !== undefined) process.env.VERCEL_ENV = env.vercel;
});

test("speaks 2026-07-28 to a modern server, statelessly, with the request headers", async () => {
  mock.reset();
  const client = new McpClient({ url: `${mock.origin}/modern/mcp` });
  const tools = await client.listTools();
  assert.equal(client.protocol, MODERN);
  assert.deepEqual(tools.map((t) => t.name), ["echo", "send_note", "changing", "big", "poisoned", "ask", "region"]);
  const out = await client.callTool(tools.find((t) => t.name === "echo")!, { text: "hi" });
  assert.deepEqual(out, { text: "hi", isError: false });
  const call = mock.calls.at(-1)!;
  assert.equal(call.era, "modern");
  assert.equal(call.headers["mcp-method"], "tools/call");
  assert.equal(call.headers["mcp-name"], "echo");
  assert.equal(call.headers["mcp-protocol-version"], MODERN);
  assert.equal(call.headers["mcp-session-id"], undefined);
  // A parameter the tool marks x-mcp-header goes in its own header too.
  await client.callTool(tools.find((t) => t.name === "region")!, { region: "us-west1", query: "x" });
  assert.equal(mock.calls.at(-1)!.headers["mcp-param-region"], "us-west1");
});

test("falls back to 2025-11-25 with a session for a server from before", async () => {
  mock.reset();
  const client = new McpClient({ url: `${mock.origin}/legacy/mcp` });
  const tools = await client.listTools();
  assert.equal(client.protocol, LEGACY[0]);
  assert.ok(!tools.some((t) => t.name === "region"));
  await client.callTool(tools[0], { text: "old" });
  const call = mock.calls.at(-1)!;
  assert.equal(call.era, "legacy");
  assert.match(call.headers["mcp-session-id"], /^session-/);
  assert.equal(call.headers["mcp-protocol-version"], LEGACY[0]);
  await client.close();
  // A version found before skips finding it again.
  const again = new McpClient({ url: `${mock.origin}/legacy/mcp`, protocol: LEGACY[0] });
  assert.equal((await again.listTools()).length, 6);
});

test("answers read from an event stream as well as JSON", async () => {
  mock.state.sse = true;
  try {
    const client = new McpClient({ url: `${mock.origin}/mcp` });
    const tools = await client.listTools();
    assert.equal((await client.callTool(tools[0], { text: "streamed" })).text, "streamed");
  } finally {
    mock.state.sse = false;
  }
});

test("a wrong token is an auth error, a right one works, and the token is sent only as a Bearer header", async () => {
  await assert.rejects(new McpClient({ url: `${mock.origin}/secure/mcp`, token: "bad" }).listTools(), (e: unknown) => e instanceof McpError && e.code === "auth");
  await assert.rejects(new McpClient({ url: `${mock.origin}/secure/mcp` }).listTools(), (e: unknown) => e instanceof McpError && e.code === "auth");
  mock.reset();
  const client = new McpClient({ url: `${mock.origin}/secure/mcp`, token: "good-token" });
  const tools = await client.listTools();
  await client.callTool(tools[0], { text: "x" });
  assert.equal(mock.calls[0].headers.authorization, "Bearer good-token");
});

test("Flash offers servers no sampling, elicitation or roots, and a server asking for input gets an error", async () => {
  // The capabilities sent: none.
  const sent: unknown[] = [];
  const recording = new McpClient(
    { url: `${mock.origin}/mcp` },
    {
      fetch: async (url, req) => {
        sent.push(JSON.parse(req.body ?? "{}"));
        const { safeFetch } = await import("../src/lib/server/safe-fetch.ts");
        return safeFetch(url, req);
      },
    },
  );
  await recording.listTools();
  for (const body of sent as { params?: { _meta?: Record<string, unknown>; capabilities?: unknown } }[]) {
    const caps = body.params?._meta?.["io.modelcontextprotocol/clientCapabilities"] ?? body.params?.capabilities;
    if (caps !== undefined) assert.deepEqual(caps, {});
  }
  // 2026-07-28: an input_required result. 2025-11-25: a request of the server's own on the stream.
  for (const path of ["/modern/mcp", "/legacy/mcp"]) {
    const client = new McpClient({ url: `${mock.origin}${path}` });
    const ask = (await client.listTools()).find((t) => t.name === "ask")!;
    await assert.rejects(client.callTool(ask, {}), (e: unknown) => e instanceof McpError && e.code === "asks_input", path);
  }
});

test("results become text: pictures and files left out, structured content as JSON, and long ones cut", async () => {
  assert.deepEqual(
    toolOutput({
      content: [
        { type: "text", text: "one" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "resource", resource: { uri: "x://a", text: "two" } },
        { type: "resource", resource: { uri: "x://b", blob: "AAAA" } },
      ],
    }),
    { text: "one\n\n[A picture was left out.]\n\ntwo\n\n[A file was left out.]", isError: false },
  );
  assert.deepEqual(toolOutput({ content: [], structuredContent: { a: 1 }, isError: true }), { text: '{"a":1}', isError: true });
  const client = new McpClient({ url: `${mock.origin}/mcp` });
  const big = (await client.listTools()).find((t) => t.name === "big")!;
  const out = await client.callTool(big, {});
  assert.ok(out.text.length >= 200_000);
  const short = cut(out.text, 6000);
  assert.ok(tokensAtMost(short) <= 6000);
  assert.match(short, /\[Cut: the rest was too long\.\]$/);
  assert.equal(cut("short", 6000), "short");
  assert.ok(tokensAtMost(cut("界".repeat(50_000), 6000)) <= 6000, "text in any script is cut to fit");
  // A poisoned result is only text: what the client does with it is up to the loop (see connect-loop tests).
  const poisoned = (await client.listTools()).find((t) => t.name === "poisoned")!;
  assert.match((await client.callTool(poisoned, {})).text, new RegExp(POISON.slice(0, 20)));
});

test("pinning: a changed description changes the tool's hash, reordered schema keys don't", async () => {
  mock.reset();
  const first = (await new McpClient({ url: `${mock.origin}/mcp` }).listTools()).find((t) => t.name === "changing")!;
  const second = (await new McpClient({ url: `${mock.origin}/mcp` }).listTools()).find((t) => t.name === "changing")!;
  assert.notEqual(first.hash, second.hash);
  const echo = (await new McpClient({ url: `${mock.origin}/mcp` }).listTools()).find((t) => t.name === "echo")!;
  assert.equal(echo.hash, toolHash("echo", "Says back the text it is given.", { required: ["text"], properties: { text: { type: "string" } }, type: "object" }));
});

test("tools are checked as they're read: names, long descriptions, x-mcp-header rules, at most 30", () => {
  assert.equal(readTool({ name: "bad name!" }), null);
  const long = readTool({ name: "t", description: "x".repeat(5000) })!;
  assert.equal(long.description.length, 1000);
  assert.notEqual(long.hash, toolHash("t", "x".repeat(1000), {}), "the pin is of the full description");
  assert.equal(readTool({ name: "t", inputSchema: { type: "object", properties: { a: { type: "number", "x-mcp-header": "A" } } } }), null, "number isn't allowed");
  assert.equal(readTool({ name: "t", inputSchema: { type: "object", properties: { a: { type: "array", items: { type: "string", "x-mcp-header": "A" } } } } }), null);
  assert.equal(readTool({ name: "t", inputSchema: { type: "object", properties: { a: { type: "string", "x-mcp-header": "Bad Name" } } } }), null);
  assert.equal(
    readTool({ name: "t", inputSchema: { type: "object", properties: { a: { type: "string", "x-mcp-header": "X" }, b: { type: "string", "x-mcp-header": "x" } } } }),
    null,
    "header names must differ case-insensitively",
  );
  assert.deepEqual(headerParams({ type: "object", properties: { o: { type: "object", properties: { r: { type: "string", "x-mcp-header": "R" } } } } }), [[["o", "r"], "R"]]);
  assert.equal(headerValue("us-west1"), "us-west1");
  assert.equal(headerValue("Hello, 世界"), "=?base64?SGVsbG8sIOS4lueVjA==?=");
  assert.equal(headerValue(" padded "), "=?base64?IHBhZGRlZCA=?=");
  assert.equal(headerValue("line1\nline2"), "=?base64?bGluZTEKbGluZTI=?=");
  assert.equal(headerValue("=?base64?literal?="), "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
});

test("a server's address is still checked: the client can't reach a private address", async () => {
  await assert.rejects(new McpClient({ url: "https://127.0.0.1/mcp" }).listTools(), (e: unknown) => e instanceof McpError && e.code === "unreachable");
  await assert.rejects(new McpClient({ url: "http://example.com/mcp" }).listTools(), (e: unknown) => e instanceof McpError && e.code === "unreachable");
});
