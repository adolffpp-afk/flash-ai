import { createHash } from "node:crypto";
import { RESULT_BYTES, METADATA_BYTES, SafeFetchError, safeFetch, type SafeRequest, type SafeResponse } from "./safe-fetch.ts";

/*
 * A small client for remote MCP servers (Streamable HTTP), written for Flash rather than taken from
 * the SDK so every request goes through safeFetch. It speaks both eras of the protocol:
 * - 2026-07-28 ("modern"): stateless; every request carries the version and the client's
 *   capabilities in _meta and the MCP-Protocol-Version, Mcp-Method and Mcp-Name headers, and tool
 *   parameters marked x-mcp-header are mirrored into Mcp-Param-* headers.
 * - 2025-11-25 and the two before it ("legacy"): an initialize handshake, then the session id the
 *   server gives (Mcp-Session-Id) on every request.
 * It tries a modern server/discover first and falls back to initialize when the answer isn't a modern
 * error, as the 2026-07-28 transport page says.
 *
 * It asks for nothing but tools. Flash offers no sampling, elicitation or roots: a server asking for
 * any of them (a request on the answer stream, or an input_required result) gets a tool error, so a
 * server can never make Flash run, and bill, a model call the user didn't ask for.
 */

export const MODERN = "2026-07-28";
export const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26"];
const CLIENT_INFO = { name: "Flash AI", version: "1.0.0" };

// What Flash keeps of a server's tool list (see S-4 in the connectors plan).
export const MAX_TOOLS = 30;
export const MAX_DESCRIPTION_CHARS = 1000;
const MAX_PAGES = 5;
const LIST_TIMEOUT_MS = 15_000;
export const CALL_TIMEOUT_MS = 20_000;

export type ToolAnnotations = { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };

/** A tool as the server lists it, with its description cut to MAX_DESCRIPTION_CHARS and the hash of what it said in full. */
export type McpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  hash: string;
};

export type McpErrorCode = "auth" | "unreachable" | "protocol" | "asks_input" | "tool" | "too_large" | "timeout";

/** Why a server couldn't be used, with an English message that holds nothing from the request. */
export class McpError extends Error {
  code: McpErrorCode;
  constructor(code: McpErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** JSON with object keys sorted, so a server that only reorders a schema's keys keeps its tool's hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The pin of a tool: a hash of its name, its full description and its input schema. */
export const toolHash = (name: string, description: string, inputSchema: unknown) =>
  createHash("sha256").update(canonicalJson([name, description, inputSchema ?? {}])).digest("hex");

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * The x-mcp-header parameters of a schema, as [path, header name], or null when one breaks the
 * spec's rules (the tool must then be left out): a header name that isn't a plain token or repeats,
 * one on a value that isn't a string, integer or boolean, or one not reached through properties alone.
 */
export function headerParams(schema: unknown): [string[], string][] | null {
  const found: [string[], string][] = [];
  let valid = true;
  const walk = (node: unknown, path: string[] | null) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, null);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (Object.hasOwn(obj, "x-mcp-header")) {
      const name = obj["x-mcp-header"];
      const type = obj.type;
      if (!path || !path.length || typeof name !== "string" || !TOKEN.test(name) || !["string", "integer", "boolean"].includes(String(type))) valid = false;
      else found.push([path, name]);
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
        for (const [prop, sub] of Object.entries(value as Record<string, unknown>)) walk(sub, path ? [...path, prop] : null);
      } else if (key !== "x-mcp-header") {
        walk(value, null);
      }
    }
  };
  walk(schema, []);
  const names = found.map(([, n]) => n.toLowerCase());
  if (new Set(names).size !== names.length) valid = false;
  return valid ? found : null;
}

/** A header value as the spec says: plain visible ASCII as it is, anything else in the base64 sentinel. */
export function headerValue(value: string): string {
  const plain = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(value) && !(value.startsWith("=?base64?") && value.endsWith("?="));
  return plain ? value : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

type JsonRpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };

/** The JSON-RPC answer to request `id` in a response body (JSON or an event stream). */
export function answerIn(res: SafeResponse, id: number): JsonRpcMessage | null {
  const messages: unknown[] = [];
  if (res.contentType === "text/event-stream") {
    for (const event of res.body.replace(/\r\n?/g, "\n").split("\n\n")) {
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      try {
        messages.push(JSON.parse(data));
      } catch {
        // Not JSON: skipped, like a comment.
      }
    }
  } else if (res.body.trim()) {
    try {
      const parsed: unknown = JSON.parse(res.body);
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      return null;
    }
  }
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const msg = m as JsonRpcMessage;
    // A request from the server (sampling, elicitation, roots): Flash answers none of them.
    if (typeof msg.method === "string" && msg.id !== undefined && msg.id !== null) {
      throw new McpError("asks_input", "The server asked Flash for more input, which Flash doesn't give servers.");
    }
    if (msg.id === id && (msg.result !== undefined || msg.error !== undefined)) return msg;
  }
  // An error without an id, as a server sends for a request it couldn't read.
  return (messages.find((m) => m && typeof m === "object" && (m as JsonRpcMessage).error && (m as JsonRpcMessage).id == null) as JsonRpcMessage) ?? null;
}

// Modern errors that mean the server speaks 2026-07-28 or later (see the versioning page).
const MODERN_ERRORS = new Set([-32020, -32021, -32022]);

export type McpServer = {
  url: string;
  // The Bearer token, or "" for a server with no sign-in.
  token?: string;
  // The version the server answered with before, to skip finding it again.
  protocol?: string;
};

type Fetch = (url: string, req: SafeRequest) => Promise<SafeResponse>;

/** One conversation with an MCP server. */
export class McpClient {
  private server: McpServer;
  private fetch: Fetch;
  private signal?: AbortSignal;
  private version = "";
  private session = "";
  private nextId = 1;

  constructor(server: McpServer, { fetch = (url, req) => safeFetch(url, req), signal }: { fetch?: Fetch; signal?: AbortSignal } = {}) {
    this.server = server;
    this.fetch = fetch;
    this.signal = signal;
  }

  /** The protocol version agreed on, once connected. */
  get protocol(): string {
    return this.version;
  }

  private get modern() {
    return this.version === MODERN;
  }

  private meta() {
    return {
      "io.modelcontextprotocol/protocolVersion": MODERN,
      "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
      "io.modelcontextprotocol/clientCapabilities": {},
    };
  }

  /** Sends one JSON-RPC message and returns the HTTP answer. */
  private async post(body: Record<string, unknown>, { headers = {}, maxBytes = METADATA_BYTES, timeoutMs = LIST_TIMEOUT_MS, version = this.version } = {}) {
    try {
      return await this.fetch(this.server.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "user-agent": "FlashAI/1.0 (+https://www.flash-app.dev)",
          ...(version && { "mcp-protocol-version": version }),
          ...(this.session && { "mcp-session-id": this.session }),
          ...(this.server.token && { authorization: `Bearer ${this.server.token}` }),
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...body }),
        maxBytes,
        timeoutMs,
        signal: this.signal,
      });
    } catch (err) {
      if (err instanceof SafeFetchError) {
        if (err.code === "timeout") throw new McpError("timeout", "The server took too long to answer.");
        if (err.code === "too_large") throw new McpError("too_large", "The server's answer was too large.");
        throw new McpError("unreachable", err.message);
      }
      throw err;
    }
  }

  /** Sends a request and returns its result, or throws McpError. */
  private async request(method: string, params: Record<string, unknown>, o: { headers?: Record<string, string>; maxBytes?: number; timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const modern = this.modern;
    const res = await this.post(
      { id, method, params: modern ? { ...params, _meta: this.meta() } : params },
      { ...o, headers: { ...(modern && { "mcp-method": method }), ...o.headers } },
    );
    if (res.status === 401 || res.status === 403) throw new McpError("auth", "The server didn't accept the key or token.");
    const answer = answerIn(res, id);
    if (answer?.error) {
      throw new McpError("tool", `The server answered with an error: ${String(answer.error.message ?? "unknown error").slice(0, 300)}`);
    }
    if (res.status >= 400 || !answer || !answer.result || typeof answer.result !== "object") {
      throw new McpError("protocol", `The server didn't answer as an MCP server (HTTP ${res.status}).`);
    }
    return answer.result as Record<string, unknown>;
  }

  /** Finds which era the server speaks, and opens a session with a legacy one. */
  async connect(): Promise<void> {
    if (this.version) return;
    if (this.server.protocol !== MODERN && LEGACY.includes(this.server.protocol ?? "")) return this.initialize();
    const id = this.nextId++;
    const res = await this.post(
      { id, method: "server/discover", params: { _meta: this.meta() } },
      { headers: { "mcp-method": "server/discover" }, version: MODERN },
    );
    if (res.status === 401 || res.status === 403) throw new McpError("auth", "The server didn't accept the key or token.");
    let answer: JsonRpcMessage | null = null;
    try {
      answer = answerIn(res, id);
    } catch (err) {
      if (!(err instanceof McpError) || res.status < 400) throw err;
    }
    const result = answer?.result as { supportedVersions?: unknown } | undefined;
    if (res.status < 300 && result && Array.isArray(result.supportedVersions) && result.supportedVersions.includes(MODERN)) {
      this.version = MODERN;
      return;
    }
    const code = answer?.error?.code;
    if (code === -32022) {
      // A modern server that doesn't take 2026-07-28: one of the older versions it lists, or nothing.
      const supported = (answer?.error?.data as { supported?: unknown } | undefined)?.supported;
      if (!(Array.isArray(supported) && LEGACY.some((v) => supported.includes(v)))) {
        throw new McpError("protocol", "The server speaks a version of MCP Flash doesn't know yet.");
      }
    } else if (code !== undefined && MODERN_ERRORS.has(code)) {
      throw new McpError("protocol", "The server refused Flash's request.");
    }
    // Anything else is a server from before 2026-07-28.
    return this.initialize();
  }

  private async initialize(): Promise<void> {
    const id = this.nextId++;
    const res = await this.post({
      id,
      method: "initialize",
      params: { protocolVersion: LEGACY[0], capabilities: {}, clientInfo: CLIENT_INFO },
    }, { version: "" });
    if (res.status === 401 || res.status === 403) throw new McpError("auth", "The server didn't accept the key or token.");
    const answer = answerIn(res, id);
    const result = answer?.result as { protocolVersion?: unknown } | undefined;
    const version = String(result?.protocolVersion ?? "");
    if (res.status >= 400 || !result || !LEGACY.includes(version)) {
      throw new McpError("protocol", answer?.error ? "The server refused to start a session." : `The server didn't answer as an MCP server (HTTP ${res.status}).`);
    }
    const session = String(res.headers["mcp-session-id"] ?? "");
    this.session = /^[\x21-\x7e]{1,256}$/.test(session) ? session : "";
    this.version = version;
    const done = await this.post({ method: "notifications/initialized" });
    if (done.status >= 400) throw new McpError("protocol", "The server refused to start a session.");
  }

  /** The server's tools: the first MAX_TOOLS that are usable, in the server's order. */
  async listTools(): Promise<McpTool[]> {
    await this.connect();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES && tools.length < MAX_TOOLS; page++) {
      const result = await this.request("tools/list", cursor ? { cursor } : {});
      for (const raw of Array.isArray(result.tools) ? result.tools : []) {
        const tool = readTool(raw, this.modern);
        if (tool && !tools.some((t) => t.name === tool.name)) tools.push(tool);
        if (tools.length >= MAX_TOOLS) break;
      }
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  /**
   * Calls a tool and returns its result as text for Claude. tool is the tool as listed, for the
   * headers a modern server maps from its arguments. A result that needs more input is an error.
   */
  async callTool(tool: Pick<McpTool, "name" | "inputSchema">, args: Record<string, unknown>): Promise<ToolOutput> {
    await this.connect();
    const headers: Record<string, string> = {};
    if (this.modern) {
      headers["mcp-name"] = headerValue(tool.name);
      for (const [path, name] of headerParams(tool.inputSchema) ?? []) {
        let value: unknown = args;
        for (const key of path) value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
        if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isSafeInteger(value))) {
          headers[`mcp-param-${name.toLowerCase()}`] = headerValue(String(value));
        }
      }
    }
    const result = await this.request("tools/call", { name: tool.name, arguments: args }, { headers, maxBytes: RESULT_BYTES, timeoutMs: CALL_TIMEOUT_MS });
    if (result.resultType === "input_required") throw new McpError("asks_input", "The server asked Flash for more input, which Flash doesn't give servers.");
    return toolOutput(result);
  }

  /** Ends a legacy session, if the server gave one. Never throws. */
  async close(): Promise<void> {
    if (!this.session) return;
    const session = this.session;
    this.session = "";
    await this.fetch(this.server.url, {
      method: "DELETE",
      headers: {
        "mcp-session-id": session,
        "mcp-protocol-version": this.version,
        ...(this.server.token && { authorization: `Bearer ${this.server.token}` }),
      },
      timeoutMs: 3000,
    }).catch(() => {});
  }
}

/** A tool from a tools/list result, checked and cut, or null when it can't be used. */
export function readTool(raw: unknown, modern = true): McpTool | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.name !== "string" || !/^[\w.\-/]{1,128}$/.test(t.name)) return null;
  const schema = t.inputSchema && typeof t.inputSchema === "object" && !Array.isArray(t.inputSchema) ? (t.inputSchema as Record<string, unknown>) : { type: "object" };
  // A tool whose header parameters break the rules is left out, as the spec says.
  if (modern && headerParams(schema) === null) return null;
  const description = typeof t.description === "string" ? t.description : "";
  const a = t.annotations && typeof t.annotations === "object" ? (t.annotations as Record<string, unknown>) : {};
  const flag = (key: string) => (typeof a[key] === "boolean" ? (a[key] as boolean) : undefined);
  const title = typeof t.title === "string" ? t.title : typeof a.title === "string" ? a.title : "";
  return {
    name: t.name,
    title: title.slice(0, 100),
    description: description.slice(0, MAX_DESCRIPTION_CHARS),
    inputSchema: { ...schema, type: "object" },
    annotations: {
      readOnlyHint: flag("readOnlyHint"),
      destructiveHint: flag("destructiveHint"),
      idempotentHint: flag("idempotentHint"),
      openWorldHint: flag("openWorldHint"),
    },
    hash: toolHash(t.name, description, t.inputSchema ?? {}),
  };
}

/** A tool's result as Claude reads it: text, and whether the tool said it failed. */
export type ToolOutput = { text: string; isError: boolean };

/**
 * Text as is, embedded text resources as their text, structured content as JSON when there is no
 * text. Pictures, sound and files are left out with a note: a tool result is never a picture Flash
 * would have to count, and nothing in it is drawn on the page.
 */
export function toolOutput(result: Record<string, unknown>): ToolOutput {
  const parts: string[] = [];
  for (const block of Array.isArray(result.content) ? result.content : []) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "image") parts.push("[A picture was left out.]");
    else if (b.type === "audio") parts.push("[A sound file was left out.]");
    else if (b.type === "resource_link") parts.push(`[Link: ${String(b.name ?? "").slice(0, 200)} ${String(b.uri ?? "").slice(0, 500)}]`);
    else if (b.type === "resource" && b.resource && typeof b.resource === "object") {
      const r = b.resource as Record<string, unknown>;
      parts.push(typeof r.text === "string" ? r.text : "[A file was left out.]");
    }
  }
  if (!parts.some((p) => !p.startsWith("[")) && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  return { text: parts.join("\n\n"), isError: result.isError === true };
}
