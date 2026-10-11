import { isVerified } from "./account.ts";
import { db, now, one, all, run } from "./db.ts";
import { randomId } from "./ids.ts";
import { overLimit } from "./limits.ts";
import { connectorsReady, lastFour, seal, unseal, type SecretPlace } from "./secret-box.ts";
import { McpClient, McpError, type McpTool } from "./mcp-client.ts";
import { checkUrl, mockOrigin, SafeFetchError } from "./safe-fetch.ts";
import { claimAction, finishAction, proposeAction, type ActionRow } from "./pending-actions.ts";
import { CONNECTION_ID, MAX_CONNECTIONS, presetById, type ConnectionView, type Preset, type ToolKind, type ToolPreview } from "../connectors.ts";
import { StoppedMidCall, cleanSchema, cut, stopError, toolName, type ConnectorKit, type ConnectorTool } from "../engines/connect.ts";
import { CONNECT_RESULT_TOKENS } from "../credits.ts";
import { english, msg, type Translate } from "../i18n.ts";

/*
 * The user's connected accounts (see connectors.ts for the presets and the plan for the rules). A
 * user only ever sees and uses their own: every read and write here is by user id. Secrets are
 * sealed in secret-box.ts and only opened to call that account's own server, through safeFetch.
 * Logs carry the connection's id, service, tool, outcome and time, never what was sent or returned.
 */

type ConnectionRow = {
  id: string;
  user_id: string;
  provider: string;
  kind: string;
  label: string;
  url: string;
  enc_url: string;
  status: "ok" | "needs_reconnect";
  enc_secret: string;
  key_version: string;
  last4: string;
  protocol: string;
  created_at: number;
  last_used_at: number;
};

type ToolRow = {
  connection_id: string;
  name: string;
  title: string;
  description: string;
  schema: string;
  hash: string;
  kind: ToolKind;
  enabled: number;
  trusted: number;
  changed: number;
  position: number;
};

/** Why a connection couldn't be added or used, as a code the routes put in the user's words. */
export type ConnectProblem = "blocked" | "auth" | "unreachable" | "protocol" | "limit" | "too_many" | "changed" | "no_tools" | "bad_input" | "gone" | "unverified";

export class ConnectError extends Error {
  code: ConnectProblem;
  constructor(code: ConnectProblem, message: string) {
    super(message);
    this.code = code;
  }
}

/** A ConnectError in the user's words. */
export function problemText(code: ConnectProblem, t: Translate): string {
  switch (code) {
    case "blocked":
      return t("Flash can only connect to public https addresses.");
    case "auth":
      return t("The server didn't accept that key or token. Check it and try again.");
    case "unreachable":
      return t("Flash couldn't reach that server. Check the address and try again.");
    case "protocol":
      return t("That address didn't answer as an MCP server.");
    case "limit":
      return t("Too many attempts. Try again in an hour.");
    case "too_many":
      return t("You have the most connections Flash keeps. Remove one first.");
    case "changed":
      return t("The server changed its tools while you were looking. Look at them again.");
    case "no_tools":
      return t("That server has no tools Flash can use.");
    case "bad_input":
      return t("Fill in the address and the key or token.");
    case "gone":
      return t("That account isn't connected any more.");
    case "unverified":
      return t("Confirm your email to connect accounts.");
  }
}

/** A problem from the client or the guard, as a ConnectError. Anything else (Stop included) goes on as it is. */
function asProblem(err: unknown): unknown {
  if (err instanceof ConnectError) return err;
  if (err instanceof SafeFetchError) return new ConnectError(err.code === "blocked" ? "blocked" : "unreachable", err.message);
  if (err instanceof McpError) {
    const code: ConnectProblem = err.code === "auth" ? "auth" : err.code === "unreachable" || err.code === "timeout" ? "unreachable" : "protocol";
    return new ConnectError(code, err.message);
  }
  return err;
}

const HOUR = 60 * 60_000;
// Calls to one account: per hour (S-6). Trying servers and adding accounts: per hour, per user.
const CALLS_PER_HOUR = 120;
const TRIES_PER_HOUR = 30;

const place = (row: Pick<ConnectionRow, "id" | "user_id" | "provider">, field: "token" | "url" = "token"): SecretPlace => ({
  id: row.id,
  userId: row.user_id,
  provider: row.provider,
  field,
});

/** The address Flash connects to: a preset's own server (the dev mock's stand-in for it, when on), else the one the user gave. */
export function serverUrl(provider: string, url: string): string {
  const preset = presetById(provider);
  if (!preset) return url;
  const mock = mockOrigin();
  return mock ? `${mock}/presets/${preset.id}/mcp` : preset.url;
}

export const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

/**
 * What a tool does, as far as Flash can tell. Only a preset vendor's annotations are believed, and
 * only "read only" makes a read; a tool that spends the user's paid quota at scale is a write. A
 * server the user added is never believed: its tools are unknown, and ask first.
 */
export function kindOf(tool: McpTool, preset?: Preset): ToolKind {
  if (!preset) return "unknown";
  if (preset.costly?.test(tool.name)) return "write";
  if (tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint !== true) return "read";
  if (tool.annotations.readOnlyHint === false || tool.annotations.destructiveHint === true) return "write";
  return "unknown";
}

/**
 * Takes out the connection's own secret (and its last 8 characters) from anything a server sends back,
 * and the parts of its address that may be one (see addressSecrets), whole.
 */
export function scrub(text: string, secret: string, parts: string[] = []): string {
  let out = text;
  if (secret) {
    out = out.split(secret).join("[hidden]");
    if (secret.length >= 12) out = out.split(secret.slice(-8)).join("[hidden]");
  }
  // Longest first, so a part inside another is never left half shown.
  for (const part of [...parts].sort((a, b) => b.length - a.length)) out = out.split(part).join("[hidden]");
  return out;
}

/**
 * The parts of a server address the user gave that may hold a key (its query values and path
 * segments of 12 characters or more), as written and decoded. A server that sends its own address
 * back can't show them.
 */
export function addressSecrets(address: string): string[] {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return [];
  }
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, " "));
    } catch {
      return s;
    }
  };
  const raw = [...url.search.slice(1).split("&").map((pair) => pair.slice(pair.indexOf("=") + 1)), ...url.pathname.split("/")];
  return [...new Set(raw.flatMap((s) => [s, decode(s)]))].filter((s) => s.length >= 12);
}

/**
 * Whether the row's sealed key and address open with the keys CONNECTOR_KEYS has now. One that
 * doesn't shows as needing to be connected again, without that being stored: putting the key back
 * brings the account back (see KeyUnreadable).
 */
function opens(row: ConnectionRow): boolean {
  try {
    if (row.enc_secret) unseal(row.enc_secret, place(row));
    if (row.enc_url) unseal(row.enc_url, place(row, "url"));
    return true;
  } catch {
    return false;
  }
}

function view(row: ConnectionRow, tools: ToolRow[]): ConnectionView {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    host: hostOf(serverUrl(row.provider, row.url)),
    custom: !presetById(row.provider),
    last4: row.last4,
    status: row.status === "ok" && !opens(row) ? "needs_reconnect" : row.status,
    createdAt: Number(row.created_at),
    tools: tools
      .filter((t) => t.connection_id === row.id)
      .sort((a, b) => a.position - b.position)
      .map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        kind: t.kind,
        enabled: Boolean(t.enabled),
        trusted: Boolean(t.trusted),
        changed: Boolean(t.changed),
      })),
  };
}

/** The user's connections, without their secrets. */
export async function listConnections(userId: string): Promise<ConnectionView[]> {
  const rows = await all<ConnectionRow>("SELECT * FROM connections WHERE user_id = ? ORDER BY created_at", [userId]);
  if (!rows.length) return [];
  const tools = await all<ToolRow>(
    "SELECT t.* FROM connection_tools t JOIN connections c ON c.id = t.connection_id WHERE c.user_id = ?",
    [userId],
  );
  return rows.map((r) => view(r, tools));
}


/** What the user adds: a preset (its id) or "custom" with an https address, and its key or token (or none). */
export type NewConnection = { provider: string; url?: string; token?: string; label?: string };

function target(input: NewConnection): { preset?: Preset; url: string } {
  const preset = presetById(input.provider);
  if (preset) {
    if (!input.token?.trim()) throw new ConnectError("bad_input", "This service needs its key or token.");
    return { preset, url: serverUrl(preset.id, preset.url) };
  }
  if (input.provider !== "custom" || typeof input.url !== "string") throw new ConnectError("bad_input", "Unknown service.");
  try {
    return { url: checkUrl(input.url.trim()).href };
  } catch (err) {
    throw asProblem(err);
  }
}

/**
 * Only an account whose email is confirmed adds a connection or lets a tool run without asking: an
 * unconfirmed one may not be its owner's, and what it set up would get the owner's tool calls once
 * they take the account back (see claim in signin.ts).
 */
async function confirmedOnly(userId: string) {
  const user = await one<{ verified_at: number }>("SELECT verified_at FROM users WHERE id = ?", [userId]);
  if (!user || !isVerified(user)) throw new ConnectError("unverified", "Confirm your email to connect accounts.");
}

async function tryLimit(userId: string) {
  if (await overLimit(`connect-try:${userId}`, TRIES_PER_HOUR, HOUR)) throw new ConnectError("limit", "Too many attempts. Try again in an hour.");
}

/** Lists a server's tools before it is added, so the user sees its host and every tool first. */
export async function previewServer(userId: string, input: NewConnection): Promise<{ host: string; tools: ToolPreview[] }> {
  const { preset, url } = target(input);
  await confirmedOnly(userId);
  await tryLimit(userId);
  const client = new McpClient({ url, token: input.token?.trim() || "" });
  try {
    const tools = await client.listTools();
    return { host: hostOf(url), tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, kind: kindOf(t, preset), hash: t.hash })) };
  } catch (err) {
    throw asProblem(err);
  } finally {
    await client.close();
  }
}

/**
 * Adds a connection: lists its tools again with the key, and pins them. For a server the user added,
 * pins are the hashes they were shown (previewServer): a tool that changed since is refused, so what
 * is pinned is what they saw. The key is sealed; only its last 4 characters are kept to show.
 */
export async function addConnection(userId: string, input: NewConnection & { pins?: Record<string, string> }): Promise<ConnectionView> {
  const { preset, url } = target(input);
  await confirmedOnly(userId);
  const count = await one<{ n: number }>("SELECT COUNT(*) AS n FROM connections WHERE user_id = ?", [userId]);
  if (Number(count?.n ?? 0) >= MAX_CONNECTIONS) throw new ConnectError("too_many", "You have the most connections Flash keeps. Remove one first.");
  await tryLimit(userId);
  const token = input.token?.trim() ?? "";
  const client = new McpClient({ url, token });
  let tools: McpTool[];
  try {
    tools = await client.listTools();
  } catch (err) {
    throw asProblem(err);
  } finally {
    await client.close();
  }
  if (!preset) {
    const pins = input.pins ?? {};
    if (tools.some((t) => pins[t.name] !== undefined && pins[t.name] !== t.hash)) {
      throw new ConnectError("changed", "The server changed its tools while you were looking. Look at them again.");
    }
    tools = tools.filter((t) => pins[t.name] === t.hash);
  }
  if (!tools.length) throw new ConnectError("no_tools", "That server has no tools Flash can use.");
  const id = randomId(12);
  const label = (preset?.name ?? (input.label?.trim() || hostOf(url))).slice(0, 60);
  const sealed = token ? seal(token, place({ id, user_id: userId, provider: input.provider })) : null;
  // A server the user added: only its origin is kept as it is, since its path or query may hold a secret.
  const address = preset ? null : seal(url, place({ id, user_id: userId, provider: input.provider }, "url"));
  const at = now();
  await (await db()).batch(
    [
      {
        sql: `INSERT INTO connections (id, user_id, provider, kind, label, url, enc_url, status, enc_secret, key_version, last4, protocol, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?, ?, ?)`,
        args: [
          id,
          userId,
          input.provider,
          preset ? "api_key" : "mcp",
          label,
          preset ? preset.url : new URL(url).origin,
          address?.stored ?? "",
          sealed?.stored ?? "",
          (sealed ?? address)?.version ?? "",
          lastFour(token),
          client.protocol,
          at,
        ],
      },
      ...tools.map((t, i) => ({
        sql: `INSERT INTO connection_tools (connection_id, name, title, description, schema, hash, kind, enabled, trusted, changed, position)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
        // A preset's costly tools start off.
        args: [id, t.name, t.title, t.description, JSON.stringify(t.inputSchema), t.hash, kindOf(t, preset), preset?.costly?.test(t.name) ? 0 : 1, i],
      })),
    ],
    "write",
  );
  return (await listConnections(userId)).find((c) => c.id === id)!;
}

/**
 * Removes a connection of the user's, with its tools and waiting actions, each deleted by hand in
 * one batch (Turso runs with foreign keys off). A key needs no revoking with these services: the
 * user deletes it in the service, as Settings says.
 */
export async function removeConnection(userId: string, id: string): Promise<boolean> {
  const row = await one<{ id: string }>("SELECT id FROM connections WHERE id = ? AND user_id = ?", [id, userId]);
  if (!row) return false;
  await (await db()).batch(
    [
      { sql: "DELETE FROM pending_actions WHERE connection_id = ? AND user_id = ?", args: [id, userId] },
      { sql: "DELETE FROM connection_tools WHERE connection_id = ?", args: [id] },
      { sql: "DELETE FROM connections WHERE id = ? AND user_id = ?", args: [id, userId] },
    ],
    "write",
  );
  return true;
}

async function owned(userId: string, id: string): Promise<ConnectionRow> {
  const row = await one<ConnectionRow>("SELECT * FROM connections WHERE id = ? AND user_id = ?", [id, userId]);
  if (!row) throw new ConnectError("gone", "That account isn't connected.");
  return row;
}

/** A connection's server, opened to call it: the client, its secret, and what of its address to hide (see scrub). */
type Opened = { client: McpClient; secret: string; parts: string[] };

/**
 * A secret that can't be opened: CONNECTOR_KEYS doesn't have the key that sealed it now. An "auth"
 * problem for the call, but not stored on the account, since the owner may put the key back (a key
 * replaced by mistake, or a rollback); until then the account shows as needing to be connected again
 * (see opens).
 */
class KeyUnreadable extends McpError {
  constructor() {
    super("auth", "The stored key can't be opened.");
  }
}

/** The account's own server refused its key (401 or 403): it must be connected again, and that is stored. */
const refusedKey = (err: unknown) => err instanceof McpError && err.code === "auth" && !(err instanceof KeyUnreadable);

/** A client for one of the user's connections, with its secret (and a server it added, its whole address) opened. */
function clientFor(row: ConnectionRow, signal?: AbortSignal): Opened {
  let secret: string;
  let url: string;
  try {
    secret = row.enc_secret ? unseal(row.enc_secret, place(row)) : "";
    url = row.enc_url ? unseal(row.enc_url, place(row, "url")) : serverUrl(row.provider, row.url);
  } catch {
    throw new KeyUnreadable();
  }
  return { client: new McpClient({ url, token: secret, protocol: row.protocol }, { signal }), secret, parts: row.enc_url ? addressSecrets(url) : [] };
}

/** Marks a connection to be connected again: its server refused its key. */
const needsReconnect = (id: string) => run("UPDATE connections SET status = 'needs_reconnect' WHERE id = ?", [id]);

/** One tool of a connection as its server lists it now (null when it no longer has it). */
async function liveTool(userId: string, row: ConnectionRow, name: string): Promise<McpTool | null> {
  await tryLimit(userId);
  let client: McpClient | null = null;
  try {
    client = clientFor(row).client;
    return (await client.listTools()).find((t) => t.name === name) ?? null;
  } catch (err) {
    if (refusedKey(err)) await needsReconnect(row.id);
    throw asProblem(err);
  } finally {
    await client?.close();
  }
}

/**
 * A tool its server changed since the user added it, as it is now, for the user to read before using
 * it again (see review in updateConnection). Null when the server no longer has it.
 */
export async function changedTool(userId: string, id: string, name: string): Promise<ToolPreview | null> {
  const row = await owned(userId, id);
  if (!(await one<ToolRow>("SELECT * FROM connection_tools WHERE connection_id = ? AND name = ?", [id, name]))) {
    throw new ConnectError("gone", "That tool isn't there any more.");
  }
  const t = await liveTool(userId, row, name);
  return t && { name: t.name, title: t.title, description: t.description, kind: kindOf(t, presetById(row.provider)), hash: t.hash };
}

/**
 * Changes one tool of a connection: on or off, always allowed (a server the user added only), or
 * looked at again after its server changed it (review: pinned as the user was shown it by
 * changedTool, whose hash it must still have, and no longer always allowed; or removed when the
 * server no longer has it).
 */
export async function updateConnection(
  userId: string,
  id: string,
  change: { tool: string; enabled?: boolean; trusted?: boolean; review?: boolean; hash?: string },
): Promise<ConnectionView> {
  const row = await owned(userId, id);
  const preset = presetById(row.provider);
  const tool = await one<ToolRow>("SELECT * FROM connection_tools WHERE connection_id = ? AND name = ?", [id, change.tool]);
  if (!tool) throw new ConnectError("gone", "That tool isn't there any more.");
  // Trusting a tool, or what its server says it does now, needs a confirmed email; turning things off doesn't.
  if (change.trusted === true || change.review) await confirmedOnly(userId);
  if (change.review) {
    const current = await liveTool(userId, row, change.tool);
    if (current && current.hash !== change.hash) {
      throw new ConnectError("changed", "The server changed its tools while you were looking. Look at them again.");
    }
    if (!current) await run("DELETE FROM connection_tools WHERE connection_id = ? AND name = ?", [id, change.tool]);
    else {
      await run(
        "UPDATE connection_tools SET title = ?, description = ?, schema = ?, hash = ?, kind = ?, trusted = 0, changed = 0 WHERE connection_id = ? AND name = ?",
        [current.title, current.description, JSON.stringify(current.inputSchema), current.hash, kindOf(current, preset), id, current.name],
      );
    }
  }
  if (typeof change.enabled === "boolean") {
    await run("UPDATE connection_tools SET enabled = ? WHERE connection_id = ? AND name = ?", [change.enabled ? 1 : 0, id, change.tool]);
  }
  // Only a server the user added asks before every call; a preset's writes always ask.
  if (typeof change.trusted === "boolean" && !preset) {
    await run("UPDATE connection_tools SET trusted = ? WHERE connection_id = ? AND name = ? AND changed = 0", [change.trusted ? 1 : 0, id, change.tool]);
  }
  return (await listConnections(userId)).find((c) => c.id === id)!;
}

/**
 * Calls one tool on a connection, under the per-account limit, and returns its text without the
 * secret or the address's secret-looking parts. Stop (signal) ends it and goes on as it is; any other
 * failure is a tool error in Flash's own words, so nothing that could hold the address is ever passed
 * on or logged. The log has the connection's id, service, tool, outcome and time only.
 */
async function callOn(row: ConnectionRow, opened: Opened, tool: Pick<ToolRow, "name" | "schema">, input: Record<string, unknown>, signal?: AbortSignal) {
  if (signal?.aborted) throw stopError(signal);
  if (await overLimit(`conn:${row.user_id}:${row.id}`, CALLS_PER_HOUR, HOUR)) {
    return { text: "Flash's limit of 120 calls an hour to this account was reached. Tell the user to try again later.", isError: true };
  }
  const started = Date.now();
  let status = "ok";
  try {
    const out = await opened.client.callTool({ name: tool.name, inputSchema: JSON.parse(tool.schema) as Record<string, unknown> }, input);
    if (out.isError) status = "tool_error";
    return { text: scrub(out.text, opened.secret, opened.parts), isError: out.isError };
  } catch (err) {
    if (signal?.aborted) {
      status = "stopped";
      // It was on its way: its server may have done it, so the reply still lists it (see connectorCalls).
      throw new StoppedMidCall(stopError(signal));
    }
    if (!(err instanceof McpError)) {
      status = "failed";
      return { text: "The tool couldn't be called.", isError: true };
    }
    status = err.code;
    return { text: scrub(err.message, opened.secret, opened.parts), isError: true };
  } finally {
    console.log(`[flash] connector ${row.id} ${row.provider} ${tool.name} ${status} ${Date.now() - started}ms`);
  }
}

/** The connection ids a chat request names, or none at all while connectors aren't set up (no CONNECTOR_KEYS). */
export function requestedConnections(value: unknown): string[] {
  if (!connectorsReady() || !Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string" && CONNECTION_ID.test(id)).slice(0, MAX_CONNECTIONS);
}

/**
 * A reply's connected accounts (see ConnectorKit in engines/connect.ts): the user's own connections
 * among ids, with the tools they have on and that haven't changed. Reads the database only; the
 * servers are reached when the reply starts (check). Null when none of the ids is the user's.
 */
export async function chatKit(userId: string, ids: string[], { replyId = "", signal }: { replyId?: string; signal?: AbortSignal } = {}): Promise<ConnectorKit | null> {
  const wanted = [...new Set(ids)].slice(0, MAX_CONNECTIONS);
  if (!wanted.length) return null;
  const marks = wanted.map(() => "?").join(",");
  const rows = await all<ConnectionRow>(`SELECT * FROM connections WHERE user_id = ? AND id IN (${marks}) AND status = 'ok' ORDER BY created_at`, [userId, ...wanted]);
  if (!rows.length) return null;
  const toolRows = await all<ToolRow>(
    `SELECT * FROM connection_tools WHERE connection_id IN (${rows.map(() => "?").join(",")}) AND enabled = 1 AND changed = 0 ORDER BY position`,
    rows.map((r) => r.id),
  );
  const taken = new Set<string>();
  const tools: (ConnectorTool & { hash: string; schemaJson: string })[] = [];
  rows.forEach((row, i) => {
    const preset = presetById(row.provider);
    const host = hostOf(serverUrl(row.provider, row.url));
    const prefix = preset ? preset.id : `custom${i + 1}`;
    for (const t of toolRows.filter((x) => x.connection_id === row.id)) {
      const name = toolName(prefix, t.name, taken);
      const title = t.title || t.name;
      tools.push({
        name,
        tool: t.name,
        title,
        connectionId: row.id,
        connection: row.label,
        host,
        kind: t.kind,
        custom: !preset,
        trusted: Boolean(t.trusted),
        hash: t.hash,
        schemaJson: t.schema,
        definition: {
          name,
          description: `${row.label} (${host}), ${title}: ${t.description}`.slice(0, 1200),
          input_schema: cleanSchema(JSON.parse(t.schema)) as { type: "object"; [k: string]: unknown },
        },
      });
    }
  });
  if (!tools.length) return null;
  const open = new Map<string, Opened>();
  const connect = (row: ConnectionRow) => {
    let c = open.get(row.id);
    if (!c) {
      c = clientFor(row, signal);
      open.set(row.id, c);
    }
    return c;
  };
  const rowOf = (id: string) => rows.find((r) => r.id === id)!;
  return {
    tools,
    async check() {
      const unreachable: string[] = [];
      const changed: string[] = [];
      const results = await Promise.all(
        rows.map(async (row) => {
          const mine = tools.filter((t) => t.connectionId === row.id);
          if (!mine.length) return [];
          try {
            const { client } = connect(row);
            const live = await client.listTools();
            if (client.protocol && client.protocol !== row.protocol) await run("UPDATE connections SET protocol = ? WHERE id = ?", [client.protocol, row.id]);
            const same = mine.filter((t) => live.find((l) => l.name === t.tool)?.hash === t.hash);
            const moved = mine.filter((t) => !same.includes(t));
            if (moved.length) {
              changed.push(row.label);
              await (await db()).batch(
                moved.map((t) => ({ sql: "UPDATE connection_tools SET changed = 1 WHERE connection_id = ? AND name = ?", args: [row.id, t.tool] })),
                "write",
              );
            }
            await run("UPDATE connections SET last_used_at = ? WHERE id = ?", [now(), row.id]);
            return same;
          } catch (err) {
            if (signal?.aborted) throw err;
            console.log(`[flash] connector ${row.id} ${row.provider} list ${err instanceof McpError ? err.code : "failed"}`);
            if (refusedKey(err)) await needsReconnect(row.id);
            unreachable.push(row.label);
            return [];
          }
        }),
      );
      return { tools: results.flat(), unreachable, changed };
    },
    async run(tool, input) {
      const row = rowOf(tool.connectionId);
      const pinned = tools.find((t) => t.name === tool.name)!;
      let opened: Opened;
      try {
        opened = connect(row);
      } catch (err) {
        if (!(err instanceof McpError)) throw err;
        if (refusedKey(err)) await needsReconnect(row.id);
        return { text: err.message, isError: true };
      }
      return callOn(row, opened, { name: pinned.tool, schema: pinned.schemaJson }, input, signal);
    },
    propose(tool, input) {
      const pinned = tools.find((t) => t.name === tool.name)!;
      return proposeAction({
        userId,
        connectionId: tool.connectionId,
        connection: tool.connection,
        host: tool.host,
        tool: tool.tool,
        title: tool.title,
        toolHash: pinned.hash,
        kind: tool.kind,
        custom: tool.custom,
        input,
        replyId,
      });
    },
    async close() {
      const clients = [...open.values()];
      open.clear();
      await Promise.all(clients.map((c) => c.client.close()));
    },
  };
}

/** What an approved result keeps to show on its card. */
const CARD_RESULT_CHARS = 4000;

/** Why an approved action didn't run, in Flash's words (shown with t() by the routes; see failedText). */
const NOT_RUN = {
  gone: msg("That account isn't connected any more."),
  changed: msg("The tool changed since this was asked, so it didn't run."),
  reconnect: msg("This account needs to be connected again."),
  failed: msg("The action couldn't run."),
};
const PROBLEMS: ConnectProblem[] = ["blocked", "auth", "unreachable", "protocol", "limit", "too_many", "changed", "no_tools", "bad_input", "gone", "unverified"];
const OWN_WORDS = new Set<string>([...Object.values(NOT_RUN), ...PROBLEMS.map((code) => problemText(code, english))]);

/** A failed action's result for the card: Flash's own reasons in the user's language, a tool's own words as they are. */
export const failedText = (result: string, t: Translate) => (OWN_WORDS.has(result) ? t(result) : result);

/**
 * Runs an approved action: claimed once (see claimAction), on the user's own connection, with the
 * tool still pinned at the hash the card was made with and still listed so by its server. No model
 * runs and no credits move. Returns how it ended and what the tool said (cut, without the secret).
 */
export async function runApproved(userId: string, id: string, hash: string): Promise<{ status: "done" | "failed"; result: string } | null> {
  const action = await claimAction(userId, id, hash);
  if (!action) return null;
  const fail = async (message: string) => {
    await finishAction(action.id, false, message);
    return { status: "failed" as const, result: message };
  };
  const row = await one<ConnectionRow>("SELECT * FROM connections WHERE id = ? AND user_id = ?", [action.connection_id, userId]);
  if (!row) return fail(NOT_RUN.gone);
  const pinned = await one<ToolRow>("SELECT * FROM connection_tools WHERE connection_id = ? AND name = ?", [row.id, action.tool]);
  if (!pinned || pinned.changed || pinned.hash !== action.tool_hash) return fail(NOT_RUN.changed);
  let opened: Opened;
  try {
    opened = clientFor(row);
  } catch {
    return fail(NOT_RUN.reconnect);
  }
  try {
    const live = await opened.client.listTools();
    if (live.find((t) => t.name === action.tool)?.hash !== action.tool_hash) {
      await run("UPDATE connection_tools SET changed = 1 WHERE connection_id = ? AND name = ?", [row.id, action.tool]);
      return fail(NOT_RUN.changed);
    }
    const out = await callOn(row, opened, pinned, JSON.parse(action.input_json) as Record<string, unknown>);
    // Kept for the card, and for Continue, cut as a step's results are.
    const kept = cut(out.text, CONNECT_RESULT_TOKENS);
    await finishAction(action.id, !out.isError, kept);
    return { status: out.isError ? "failed" : "done", result: kept.slice(0, CARD_RESULT_CHARS) };
  } catch (err) {
    const problem = asProblem(err);
    if (problem instanceof ConnectError) {
      if (refusedKey(err)) await needsReconnect(row.id);
      return fail(problemText(problem.code, english));
    }
    return fail(NOT_RUN.failed);
  } finally {
    await opened.client.close();
  }
}

/** For a reply continued with approved results: each one's tool as the reply knows it, or nothing when it isn't on. */
export function continuedCalls(kit: ConnectorKit, rows: ActionRow[]) {
  return rows.flatMap((row) => {
    const tool = kit.tools.find((t) => t.connectionId === row.connection_id && t.tool === row.tool);
    return tool ? [{ row, tool }] : [];
  });
}
