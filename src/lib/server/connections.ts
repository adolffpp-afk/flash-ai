import { isVerified } from "./account.ts";
import { db, now, one, all, run } from "./db.ts";
import { randomId } from "./ids.ts";
import { overLimit } from "./limits.ts";
import { connectorsReady, lastFour, seal, unseal, type SecretPlace } from "./secret-box.ts";
import { McpClient, McpError, type McpTool } from "./mcp-client.ts";
import { checkUrl, mockOrigin, SafeFetchError } from "./safe-fetch.ts";
import {
  OAuthError,
  beginSignIn,
  canRegister,
  callbackUrl,
  exchangeCode,
  findAuthServer,
  findResource,
  flowSecret,
  issMatches,
  requireIss,
  parseChallenge,
  planSignIn,
  readEndpoints,
  refreshGrant,
  revokeGrant,
  scopeList,
  takeFlow,
  typedClient,
  unionScopes,
  type FlowRow,
  type Grant,
  type Tokens,
} from "./mcp-oauth.ts";
import { claimAction, finishAction, proposeAction, type ActionRow } from "./pending-actions.ts";
import {
  GITHUB_API,
  GITHUB_ISSUER,
  GITHUB_PROBLEMS,
  GITHUB_TOOLS,
  GitHubClient,
  beginGithubFlow,
  dropGithubToken,
  exchangeGithubCode,
  githubAccount,
  githubApi,
  githubInstallations,
  githubReady,
  githubStep,
  installationHint,
  installationsOf,
  refreshGithubToken,
  revokeGithubGrant,
  takeGithubFlow,
  takeInstallFlow,
  type GithubAccount,
} from "./github.ts";
import {
  FILE_ID,
  GOOGLE_API,
  GOOGLE_PROBLEMS,
  GOOGLE_TOOLS,
  MAX_FILES,
  MAX_PICK,
  GoogleClient,
  accountOf,
  beginGoogleFlow,
  cleanName,
  exchangeGoogleCode,
  googleHost,
  googleReady,
  grantsDrive,
  pickedFile,
  pickedFiles,
  refreshGoogleToken,
  revokeGoogleToken,
  takeGoogleFlow,
  userinfo,
  type GoogleAccount,
  type GoogleTokens,
} from "./google.ts";
import { CONNECTION_ID, MAX_CONNECTIONS, presetById, type ConnectionView, type PickedFileView, type Preset, type ToolKind, type ToolPreview } from "../connectors.ts";
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
  // review: a server the user added and signed in to, whose tools they haven't looked at yet (not used in chats).
  status: "ok" | "needs_reconnect" | "review";
  enc_secret: string;
  key_version: string;
  last4: string;
  protocol: string;
  created_at: number;
  last_used_at: number;
  // Signed in with OAuth (kind "oauth", see mcp-oauth.ts), to GitHub (kind "github", see github.ts) or
  // to Google Drive (kind "google", see google.ts).
  enc_access: string;
  enc_refresh: string;
  expires_at: number;
  issuer: string;
  // For GitHub: the ids of the app's installations its token could see at sign-in (see github.ts).
  // For Google Drive: the Google account's email, the account's label in Settings.
  resource: string;
  client_reg_id: string;
  scopes: string;
  // For Google Drive: {"sub": the Google account's id}, to tell a Reconnect to another account.
  endpoints_json: string;
  refreshing_until: number | null;
  // For GitHub: the number of the GitHub account its tokens are for (see keepGithub).
  account_id: string;
};

/** Signed in, with tokens Flash renews: at an MCP server's authorization server, to GitHub or to Google. */
const signsIn = (row: Pick<ConnectionRow, "kind">) => row.kind === "oauth" || row.kind === "github" || row.kind === "google";

/** A GitHub or Google Drive connection while Flash's app for it isn't set up: hidden everywhere, and never used. */
const hidden = (row: Pick<ConnectionRow, "provider">) => (row.provider === "github" && !githubReady()) || (row.provider === "google-drive" && !googleReady());

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
export type ConnectProblem =
  | "blocked"
  | "auth"
  | "unreachable"
  | "protocol"
  | "limit"
  | "too_many"
  | "changed"
  | "no_tools"
  | "bad_input"
  | "gone"
  | "unverified"
  // A sign-in Flash won't do: no usable OAuth metadata, another server's resource, no PKCE S256, or
  // an endpoint that isn't https or is one of Flash's own hosts (see mcp-oauth.ts).
  | "no_signin"
  // The server has neither a Client ID Metadata Document nor Dynamic Client Registration.
  | "needs_client"
  // A server the user added whose sign-in doesn't send iss, which Flash needs to know whose code came back.
  | "no_iss"
  // Flash's registration at that server can't be opened (its key version left CONNECTOR_KEYS too soon).
  | "unreadable"
  // The account's sign-in ended (or never gave the access Flash needs): only Reconnect helps.
  | "reconnect"
  // A Google Drive account keeps at most MAX_FILES picked files.
  | "too_many_files";

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
    case "no_signin":
      return t("That server asks for a sign-in Flash can't use safely.");
    case "needs_client":
      return t("This server needs a client ID from its own settings. Fill it in under Advanced.");
    case "no_iss":
      return t("That server's sign-in doesn't identify itself when it sends you back, so Flash can't use it safely.");
    case "unreadable":
      return t("Flash can't open its sign-in details for that server right now. Try again later.");
    case "reconnect":
      return t("This account needs to be connected again.");
    case "too_many_files":
      return t("Flash keeps at most {count} files for one account. Forget some first.", { count: MAX_FILES });
  }
}

/** A problem from the client or the guard, as a ConnectError. Anything else (Stop included) goes on as it is. */
function asProblem(err: unknown): unknown {
  if (err instanceof ConnectError) return err;
  if (err instanceof OAuthError) {
    const code: ConnectProblem = err.code === "needs_client" || err.code === "unreachable" || err.code === "no_iss" || err.code === "unreadable" ? err.code : "no_signin";
    return new ConnectError(code, err.message);
  }
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

const place = (row: Pick<ConnectionRow, "id" | "user_id" | "provider">, field: "token" | "url" | "access" | "refresh" = "token"): SecretPlace => ({
  id: row.id,
  userId: row.user_id,
  provider: row.provider,
  field,
});

/** The address Flash connects to: a preset's own server (the dev mock's stand-in for it, when on), else the one the user gave. */
export function serverUrl(provider: string, url: string): string {
  const preset = presetById(provider);
  if (!preset) return url;
  if (preset.rest) return preset.id === "google-drive" ? googleHost("www") : githubApi();
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
    if (row.enc_access) unseal(row.enc_access, place(row, "access"));
    if (row.enc_refresh) unseal(row.enc_refresh, place(row, "refresh"));
    return true;
  } catch {
    return false;
  }
}

function view(row: ConnectionRow, tools: ToolRow[], files: (PickedFileView & { connectionId: string })[] = []): ConnectionView {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    host: hostOf(serverUrl(row.provider, row.url)),
    custom: !presetById(row.provider),
    last4: row.last4,
    signIn: signsIn(row),
    // GitHub's authorization of the app, and Google's grant, are always cancelled on removal (see revokeGithub and revokeGoogle).
    revocable: row.kind === "github" || row.kind === "google" || (row.kind === "oauth" && readEndpoints(row.endpoints_json).revocation !== ""),
    status: row.status !== "needs_reconnect" && !opens(row) ? "needs_reconnect" : row.status,
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
    ...(row.kind === "google" && {
      account: row.resource,
      files: files.filter((f) => f.connectionId === row.id).map(({ id, name, mime, pickedAt }) => ({ id, name, mime, pickedAt })),
    }),
  };
}

/** The user's connections, without their secrets (GitHub and Google Drive only while Flash's app for each is set up), with Google Drive's picked files. */
export async function listConnections(userId: string): Promise<ConnectionView[]> {
  const rows = (await all<ConnectionRow>("SELECT * FROM connections WHERE user_id = ? ORDER BY created_at", [userId])).filter((r) => !hidden(r));
  if (!rows.length) return [];
  const tools = await all<ToolRow>(
    "SELECT t.* FROM connection_tools t JOIN connections c ON c.id = t.connection_id WHERE c.user_id = ?",
    [userId],
  );
  const files = rows.some((r) => r.kind === "google")
    ? (
        await all<{ connection_id: string; file_id: string; name: string; mime: string; picked_at: number }>(
          "SELECT f.* FROM connection_files f JOIN connections c ON c.id = f.connection_id WHERE c.user_id = ? ORDER BY f.picked_at DESC, f.name",
          [userId],
        )
      ).map((f) => ({ connectionId: f.connection_id, id: f.file_id, name: f.name, mime: f.mime, pickedAt: Number(f.picked_at) }))
    : [];
  return rows.map((r) => view(r, tools, files));
}


/** What the user adds: a preset (its id) or "custom" with an https address, and its key or token (or none). */
export type NewConnection = { provider: string; url?: string; token?: string; label?: string };

function target(input: NewConnection): { preset?: Preset; url: string } {
  const preset = presetById(input.provider);
  if (preset) {
    // A service that only signs in takes no key (see startSignIn and startGithub).
    if (!input.token?.trim() || !preset.keyName || preset.rest) throw new ConnectError("bad_input", "This service needs its key or token.");
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

/**
 * What a server that asks for a sign-in would be signed in at: its authorization server's host, and
 * whether the user must type a client ID made there (it offers Flash no way to register itself).
 */
export type SignInPreview = { authHost: string; needsClient: boolean; callback: string };

/**
 * Lists a server's tools before it is added, so the user sees its host and every tool first. A
 * server the user added that refuses a request without a key (401) and says how to sign in gets its
 * sign-in instead (signIn), shown before the browser goes there; its tools are shown once signed in.
 */
export async function previewServer(userId: string, input: NewConnection, origin = ""): Promise<{ host: string; tools: ToolPreview[]; signIn?: SignInPreview }> {
  const { preset, url } = target(input);
  await confirmedOnly(userId);
  await tryLimit(userId);
  const token = input.token?.trim() || "";
  const client = new McpClient({ url, token });
  try {
    const tools = await client.listTools();
    return { host: hostOf(url), tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, kind: kindOf(t, preset), hash: t.hash })) };
  } catch (err) {
    if (!preset && !token && origin && err instanceof McpError && err.code === "auth" && err.status === 401) {
      try {
        const found = await findResource(url, parseChallenge(err.challenge));
        const server = await findAuthServer(found.authorizationServers[0]);
        requireIss("custom", server);
        const callback = callbackUrl(origin);
        return { host: hostOf(url), tools: [], signIn: { authHost: new URL(server.authorizationEndpoint).host, needsClient: !(await canRegister(userId, server, callback)), callback } };
      } catch (problem) {
        // No sign-in described at all: it wants a key or token, as before.
        throw asProblem(problem instanceof OAuthError && problem.code === "no_signin" ? err : problem);
      }
    }
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
      ...toolInserts(id, tools, preset),
    ],
    "write",
  );
  return (await listConnections(userId)).find((c) => c.id === id)!;
}

/** A connection's tools, pinned as its server listed them; a preset's costly tools start off. */
const toolInserts = (id: string, tools: McpTool[], preset?: Preset) =>
  tools.map((t, i) => ({
    sql: `INSERT INTO connection_tools (connection_id, name, title, description, schema, hash, kind, enabled, trusted, changed, position)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    args: [id, t.name, t.title, t.description, JSON.stringify(t.inputSchema), t.hash, kindOf(t, preset), preset?.costly?.test(t.name) ? 0 : 1, i],
  }));

/**
 * Removes a connection of the user's, with its tools, waiting actions and picked files, each deleted
 * by hand in one batch (Turso runs with foreign keys off). An account signed in with OAuth is signed
 * out at its authorization server first, where it has a revocation endpoint (S-7), GitHub's
 * authorization of the app is cancelled, and so is Google's grant; it is removed either way. A key
 * needs no revoking here: the user deletes it in the service, as Settings says.
 */
export async function removeConnection(userId: string, id: string): Promise<boolean> {
  const row = await one<ConnectionRow>("SELECT * FROM connections WHERE id = ? AND user_id = ?", [id, userId]);
  if (!row) return false;
  if (row.kind === "oauth") await revokeConnection(row);
  if (row.kind === "github") await revokeGithub(row);
  if (row.kind === "google") await revokeGoogle(row);
  await (await db()).batch(
    [
      { sql: "DELETE FROM pending_actions WHERE connection_id = ? AND user_id = ?", args: [id, userId] },
      { sql: "DELETE FROM connection_tools WHERE connection_id = ?", args: [id] },
      { sql: "DELETE FROM connection_files WHERE connection_id = ?", args: [id] },
      { sql: "DELETE FROM connections WHERE id = ? AND user_id = ?", args: [id, userId] },
    ],
    "write",
  );
  return true;
}

/** What refreshing and revoking a connection's sign-in need. */
const grantOf = (row: Pick<ConnectionRow, "user_id" | "client_reg_id" | "resource" | "endpoints_json">): Grant => ({
  userId: row.user_id,
  clientRegId: row.client_reg_id,
  resource: row.resource,
  endpoints: readEndpoints(row.endpoints_json),
});

/** Asks a connection's authorization server to cancel its tokens. Never throws; logs only whether it was confirmed. */
async function revokeConnection(row: ConnectionRow): Promise<void> {
  let tokens: { access: string; refresh: string };
  try {
    tokens = {
      access: row.enc_access ? unseal(row.enc_access, place(row, "access")) : "",
      refresh: row.enc_refresh ? unseal(row.enc_refresh, place(row, "refresh")) : "",
    };
  } catch {
    return;
  }
  if (!tokens.access && !tokens.refresh) return;
  const done = await revokeGrant(grantOf(row), tokens).catch(() => false);
  console.log(`[flash] connector ${row.id} ${row.provider} revoke ${done ? "ok" : "not confirmed"}`);
}

/**
 * Cancels the user's authorization of Flash's GitHub App (DELETE /applications/{client_id}/grant,
 * which needs a token that still works: one about to run out is renewed first, at no cost). Never
 * throws; logs only whether GitHub confirmed it. Without the app's settings there is no way to ask.
 */
async function revokeGithub(row: ConnectionRow): Promise<void> {
  if (!githubReady()) return;
  let token = "";
  try {
    token = (await accessToken(row)).token;
  } catch {
    try {
      token = row.enc_access ? unseal(row.enc_access, place(row, "access")) : "";
    } catch {
      return;
    }
  }
  const done = await revokeGithubGrant(token);
  console.log(`[flash] connector ${row.id} ${row.provider} revoke ${done ? "ok" : "not confirmed"}`);
}

/**
 * Cancels the user's grant to Flash at Google (POST https://oauth2.googleapis.com/revoke). The refresh
 * token is sent when there is one: Google then cancels the whole grant, and every access token it
 * gave. Without one, the access token. It needs no working token and no client secret, so nothing is
 * renewed first, and it is asked even while Google Drive is hidden. Never throws; logs only whether
 * Google confirmed it.
 */
async function revokeGoogle(row: ConnectionRow): Promise<void> {
  let token = "";
  try {
    token = row.enc_refresh ? unseal(row.enc_refresh, place(row, "refresh")) : row.enc_access ? unseal(row.enc_access, place(row, "access")) : "";
  } catch {
    console.log(`[flash] connector ${row.id} ${row.provider} revoke skipped: key unreadable`);
    return;
  }
  if (!token) return;
  const done = await revokeGoogleToken(token);
  console.log(`[flash] connector ${row.id} ${row.provider} revoke ${done ? "ok" : "not confirmed"}`);
}

async function owned(userId: string, id: string): Promise<ConnectionRow> {
  const row = await one<ConnectionRow>("SELECT * FROM connections WHERE id = ? AND user_id = ?", [id, userId]);
  if (!row) throw new ConnectError("gone", "That account isn't connected.");
  return row;
}

/**
 * A connection's server, opened to call it: the client, its secret (the key, or the OAuth access
 * token), what of its address to hide (see scrub), and for OAuth the sealed token it used, so a
 * refusal of that very token can be told from one already renewed.
 */
type Opened = { client: ToolClient; secret: string; parts: string[]; sealed: string };

/** What a connection is called through: an MCP server's client, or Flash's own GitHub or Google tools (the same calls). */
type ToolClient = Pick<McpClient, "listTools" | "callTool" | "close" | "protocol">;

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

/** An OAuth sign-in that ended: its refresh was refused, or there is nothing to renew it with. Stored as needing Reconnect. */
class SignInEnded extends McpError {
  constructor() {
    super("auth", "This account needs to be signed in again.");
  }
}

/**
 * The scopes a server says a token lacks (403 insufficient_scope): a step-up, which only the user can
 * agree to, with Reconnect. Null for any other answer.
 */
function stepUp(err: unknown): string[] | null {
  if (!(err instanceof McpError) || err.code !== "auth" || err.status !== 403) return null;
  const challenge = parseChallenge(err.challenge);
  return challenge.error === "insufficient_scope" ? scopeList(challenge.scope) : null;
}

/** The account's own server refused its key or sign-in (401 or 403, not a step-up): it must be connected again, and that is stored. */
const refusedKey = (err: unknown) => err instanceof McpError && err.code === "auth" && !(err instanceof KeyUnreadable) && !stepUp(err);

/** A refusal Flash can try once more after renewing the sign-in: a 401 to an OAuth connection's token. */
const renewable = (row: ConnectionRow, err: unknown) => signsIn(row) && err instanceof McpError && err.code === "auth" && err.status === 401 && !(err instanceof SignInEnded);

/**
 * Keeps the scopes a server asked for (step-up) with the ones asked for before, so Reconnect asks for
 * their union. Only the user starts that sign-in; nothing happens by itself. The union is made with
 * what is stored now, never with the row as a reply read it: another tool of the same reply, another
 * reply or a Reconnect may have added scopes since. It is written only if those are still what is
 * stored (else read again), and kept on the row for the reply's later calls.
 */
async function addScopes(row: ConnectionRow, scopes: string[]) {
  for (let tries = 0; tries < 3; tries++) {
    const stored = await one<{ scopes: string }>("SELECT scopes FROM connections WHERE id = ? AND user_id = ?", [row.id, row.user_id]);
    if (!stored) return;
    const all = unionScopes(stored.scopes, scopes).join(" ");
    row.scopes = all;
    if (all === stored.scopes) return;
    const done = await run("UPDATE connections SET scopes = ? WHERE id = ? AND user_id = ? AND scopes = ?", [all, row.id, row.user_id, stored.scopes]);
    if (done.rowsAffected) return;
  }
}

// An access token is renewed this long before it runs out; one refresh may hold a connection this
// long (longer than the token request may take); others wait for it at most this long.
const REFRESH_EARLY_MS = 60_000;
const REFRESH_LOCK_MS = 30_000;
const REFRESH_WAIT_MS = 15_000;

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * An OAuth connection's access token, renewed first when it runs out within a minute (or within
 * `early`), or when it is `stale` (the sealed token its server just refused). Refreshes run one at a
 * time per connection: the one that takes refreshing_until (only while the row still holds the
 * tokens it read) refreshes; the others wait for it and read what it stored. So a rotated refresh
 * token is never sent twice.
 */
async function accessToken(row: ConnectionRow, stale = "", signal?: AbortSignal, early = REFRESH_EARLY_MS): Promise<{ token: string; sealed: string }> {
  let current: ConnectionRow | null = row;
  const first = row.enc_access;
  const until = Date.now() + REFRESH_WAIT_MS;
  for (;;) {
    if (!current || current.status === "needs_reconnect" || !current.enc_access) throw new SignInEnded();
    const expires = Number(current.expires_at);
    const usable = current.enc_access !== stale && !(expires > 0 && expires <= now());
    // A token another request renewed while this one waited is used as long as it lasts, not renewed again.
    const fresh = usable && (current.enc_access !== first || !(expires > 0 && expires - early < now()));
    const open = (c: ConnectionRow) => {
      try {
        return { token: unseal(c.enc_access, place(c, "access")), sealed: c.enc_access };
      } catch {
        throw new KeyUnreadable();
      }
    };
    if (fresh) return open(current);
    if (!current.enc_refresh) {
      if (usable) return open(current);
      await run("UPDATE connections SET status = 'needs_reconnect', enc_access = '', expires_at = 0 WHERE id = ? AND user_id = ? AND enc_access = ?", [
        current.id,
        current.user_id,
        current.enc_access,
      ]);
      throw new SignInEnded();
    }
    const at = now();
    const took = await run(
      `UPDATE connections SET refreshing_until = ?
       WHERE id = ? AND user_id = ? AND status <> 'needs_reconnect' AND enc_access = ? AND enc_refresh = ? AND (refreshing_until IS NULL OR refreshing_until < ?)`,
      [at + REFRESH_LOCK_MS, current.id, current.user_id, current.enc_access, current.enc_refresh, at],
    );
    if (took.rowsAffected) {
      const renewed = await refreshNow(current, at + REFRESH_LOCK_MS, usable, signal);
      if (renewed) return renewed;
      current = await one<ConnectionRow>("SELECT * FROM connections WHERE id = ? AND user_id = ?", [row.id, row.user_id]);
      continue;
    }
    if (signal?.aborted) throw stopError(signal);
    if (Date.now() > until) throw new McpError("unreachable", "The account's sign-in couldn't be renewed in time.");
    await pause(200, signal);
    current = await one<ConnectionRow>("SELECT * FROM connections WHERE id = ? AND user_id = ?", [row.id, row.user_id]);
  }
}

/**
 * Refreshes a connection's tokens, holding its refresh (lock). The new access and refresh tokens are
 * stored in one write before the access token is used: a server that rotates refresh tokens may
 * revoke the whole sign-in if an old one is sent again. A refused grant marks the account for
 * Reconnect, with no retry. Any other failure frees the refresh; the old token is used while it lasts.
 * Both writes land only while the row still holds the grant that was renewed: when a Reconnect replaced
 * it meanwhile, the renewed tokens are given back to the server and null asks the caller to read the row again.
 */
async function refreshNow(row: ConnectionRow, lock: number, usable: boolean, signal?: AbortSignal): Promise<{ token: string; sealed: string } | null> {
  const free = () => run("UPDATE connections SET refreshing_until = NULL WHERE id = ? AND refreshing_until = ?", [row.id, lock]);
  let refreshToken: string;
  try {
    refreshToken = unseal(row.enc_refresh, place(row, "refresh"));
  } catch {
    await free();
    throw new KeyUnreadable();
  }
  let tokens: Tokens;
  try {
    // Never cut short by Stop or the reply's deadline (only by its own time limit, REQUEST_MS): a server
    // that rotates refresh tokens has retired the one sent as soon as it has it, so its answer must be
    // read and kept. Stop takes effect once the new tokens are saved.
    tokens = await (row.kind === "github" ? refreshGithubToken(refreshToken) : row.kind === "google" ? refreshGoogleToken(refreshToken) : refreshGrant(grantOf(row), refreshToken));
  } catch (err) {
    if (err instanceof OAuthError && err.code === "invalid_grant") {
      const ended = await run(
        `UPDATE connections SET status = 'needs_reconnect', enc_access = '', enc_refresh = '', expires_at = 0, refreshing_until = NULL
         WHERE id = ? AND user_id = ? AND enc_refresh = ?`,
        [row.id, row.user_id, row.enc_refresh],
      );
      if (!ended.rowsAffected) return null;
      console.log(`[flash] connector ${row.id} ${row.provider} refresh refused`);
      throw new SignInEnded();
    }
    await free();
    if (signal?.aborted) throw stopError(signal);
    console.log(`[flash] connector ${row.id} ${row.provider} refresh failed`);
    if (!usable) throw new McpError("unreachable", "The account's sign-in couldn't be renewed.");
    try {
      return { token: unseal(row.enc_access, place(row, "access")), sealed: row.enc_access };
    } catch {
      throw new KeyUnreadable();
    }
  }
  // Both tokens are sealed again with the newest key version (a refresh token the server didn't rotate
  // too), so a preset's row, which holds nothing else sealed, records that version (see key rotation).
  const access = seal(tokens.access, place(row, "access"));
  const refresh = seal(tokens.refresh || refreshToken, place(row, "refresh")).stored;
  const saved = await run(
    `UPDATE connections SET enc_access = ?, enc_refresh = ?, expires_at = ?, refreshing_until = NULL,
       key_version = CASE WHEN COALESCE(enc_url, '') = '' AND COALESCE(enc_secret, '') = '' THEN ? ELSE key_version END
     WHERE id = ? AND user_id = ? AND enc_refresh = ? AND status <> 'needs_reconnect'`,
    [access.stored, refresh, tokens.expiresAt, access.version, row.id, row.user_id, row.enc_refresh],
  );
  if (!saved.rowsAffected) {
    // Only these tokens: for GitHub, the whole grant would also end the sign-in that replaced them.
    // Google cancels the whole grant for any token it is sent, so its tokens are only dropped (they
    // run out within the hour).
    if (row.kind === "github") await dropGithubToken(tokens.access);
    else if (row.kind !== "google") await revokeGrant(grantOf(row), { access: tokens.access, refresh: tokens.refresh }).catch(() => false);
    return null;
  }
  console.log(`[flash] connector ${row.id} ${row.provider} refreshed`);
  if (signal?.aborted) throw stopError(signal);
  return { token: tokens.access, sealed: access.stored };
}

/**
 * A client for one of the user's connections, with its secret (and a server it added, its whole
 * address) opened. An OAuth connection's access token is renewed first when needed (see accessToken).
 */
async function openServer(row: ConnectionRow, signal?: AbortSignal, stale = ""): Promise<Opened> {
  if (row.kind === "github") {
    const { token, sealed } = await accessToken(row, stale, signal);
    return { client: new GitHubClient(token, installationsOf(row.resource), signal), secret: token, parts: [], sealed };
  }
  if (row.kind === "google") {
    const { token, sealed } = await accessToken(row, stale, signal);
    return { client: new GoogleClient(token, row.id, signal), secret: token, parts: [], sealed };
  }
  let secret = "";
  let url: string;
  let sealed = "";
  try {
    if (row.kind !== "oauth") secret = row.enc_secret ? unseal(row.enc_secret, place(row)) : "";
    url = row.enc_url ? unseal(row.enc_url, place(row, "url")) : serverUrl(row.provider, row.url);
  } catch {
    throw new KeyUnreadable();
  }
  if (row.kind === "oauth") ({ token: secret, sealed } = await accessToken(row, stale, signal));
  return { client: new McpClient({ url, token: secret, protocol: row.protocol }, { signal }), secret, parts: row.enc_url ? addressSecrets(url) : [], sealed };
}

/**
 * Runs fn with the connection's server open, and closes it after. A server that refuses an OAuth
 * connection's token (401) gets it renewed once, and fn is tried once more.
 */
async function withServer<T>(row: ConnectionRow, fn: (opened: Opened) => Promise<T>): Promise<T> {
  let opened = await openServer(row);
  try {
    return await fn(opened);
  } catch (err) {
    if (!renewable(row, err)) throw err;
    await opened.client.close();
    opened = await openServer(row, undefined, opened.sealed);
    return await fn(opened);
  } finally {
    await opened.client.close();
  }
}

/** Marks a connection to be connected again: its server refused its key. */
const needsReconnect = (id: string) => run("UPDATE connections SET status = 'needs_reconnect' WHERE id = ?", [id]);

/** One tool of a connection as its server lists it now (null when it no longer has it). */
async function liveTool(userId: string, row: ConnectionRow, name: string): Promise<McpTool | null> {
  await tryLimit(userId);
  try {
    return (await withServer(row, (opened) => opened.client.listTools())).find((t) => t.name === name) ?? null;
  } catch (err) {
    const more = stepUp(err);
    if (more && row.kind === "oauth") await addScopes(row, more);
    else if (refusedKey(err)) await needsReconnect(row.id);
    throw asProblem(err);
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
 * Adds a server the user added and signed in to, once they've looked at its tools (see
 * finishSignIn): until then it is in review and no chat uses it.
 */
export async function confirmConnection(userId: string, id: string): Promise<ConnectionView> {
  await confirmedOnly(userId);
  const done = await run("UPDATE connections SET status = 'ok' WHERE id = ? AND user_id = ? AND status = 'review'", [id, userId]);
  if (!done.rowsAffected) throw new ConnectError("gone", "That account isn't connected.");
  return (await listConnections(userId)).find((c) => c.id === id)!;
}

/**
 * Calls one tool on a connection, under the per-account limit, and returns its text without the
 * secret or the address's secret-looking parts. Stop (signal) ends it and goes on as it is; any other
 * failure is a tool error in Flash's own words, so nothing that could hold the address is ever passed
 * on or logged. A tool its server says needs more access (step-up) keeps the scopes it names for the
 * next sign-in, and tells the user to Reconnect. The log has the connection's id, service, tool,
 * outcome and time only.
 */
async function callOn(
  row: ConnectionRow,
  opened: Opened,
  tool: Pick<ToolRow, "name" | "schema">,
  input: Record<string, unknown>,
  signal?: AbortSignal,
  renew?: (stale: string) => Promise<Opened>,
) {
  if (signal?.aborted) throw stopError(signal);
  if (await overLimit(`conn:${row.user_id}:${row.id}`, CALLS_PER_HOUR, HOUR)) {
    return { text: "Flash's limit of 120 calls an hour to this account was reached. Tell the user to try again later.", isError: true };
  }
  const started = Date.now();
  let status = "ok";
  const send = (o: Opened) => o.client.callTool({ name: tool.name, inputSchema: JSON.parse(tool.schema) as Record<string, unknown> }, input);
  try {
    let out: Awaited<ReturnType<typeof send>>;
    try {
      out = await send(opened);
    } catch (err) {
      // A sign-in's token that ran out while the reply went on: its server refused it before running
      // anything, so it is renewed (once for all of the reply's calls) and the call sent once more.
      if (!renew || signal?.aborted || !renewable(row, err)) throw err;
      opened = await renew(opened.sealed);
      out = await send(opened);
    }
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
    const more = stepUp(err);
    if (more && row.kind === "oauth") {
      status = "needs_scope";
      await addScopes(row, more);
      // Written for Claude (a chat's tool result); an approved action's card says it in the user's words (runApproved).
      return {
        text: "This tool needs more access than the account gave Flash. Tell the user to press Reconnect on this account in Settings > Connectors and allow it, then try again.",
        isError: true,
        needsScope: true,
      };
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
  const rows = (await all<ConnectionRow>(`SELECT * FROM connections WHERE user_id = ? AND id IN (${marks}) AND status = 'ok' ORDER BY created_at`, [userId, ...wanted])).filter((r) => !hidden(r));
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
  // Each connection's server, opened once for the reply (an OAuth one with its token renewed first when needed).
  const open = new Map<string, Promise<Opened>>();
  // A renewal under way, by connection: calls refused with the same token wait for it.
  const renewing = new Map<string, { stale: string; opening: Promise<Opened> }>();
  // Every client this reply opened, all closed at its end (one replaced by a renewal may still be in use).
  const made: Promise<Opened>[] = [];
  const connect = (row: ConnectionRow, stale = ""): Promise<Opened> => {
    const opened = open.get(row.id);
    if (opened && !stale) return opened;
    const pending = renewing.get(row.id);
    if (stale && pending?.stale === stale) return pending.opening;
    const opening = openServer(row, signal, stale);
    // Read when used; a failure is answered there (a tool error), never left unhandled.
    opening.catch(() => {});
    open.set(row.id, opening);
    made.push(opening);
    if (stale) renewing.set(row.id, { stale, opening });
    return opening;
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
            let opened = await connect(row);
            let live: McpTool[];
            try {
              live = await opened.client.listTools();
            } catch (err) {
              // A token its server refused: renewed once, and listed again.
              if (!renewable(row, err)) throw err;
              await opened.client.close();
              opened = await connect(row, opened.sealed);
              live = await opened.client.listTools();
            }
            const { client } = opened;
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
            const more = stepUp(err);
            if (more && row.kind === "oauth") await addScopes(row, more);
            else if (refusedKey(err)) await needsReconnect(row.id);
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
        opened = await connect(row);
      } catch (err) {
        if (!(err instanceof McpError)) throw err;
        if (refusedKey(err)) await needsReconnect(row.id);
        return { text: err.message, isError: true };
      }
      return callOn(row, opened, { name: pinned.tool, schema: pinned.schemaJson }, input, signal, (stale) => connect(row, stale));
    },
    async propose(tool, input) {
      const pinned = tools.find((t) => t.name === tool.name)!;
      // A picked Google Drive file is shown by the name Google gave it, beside its id.
      const file = rowOf(tool.connectionId).kind === "google" ? await pickedFile(tool.connectionId, input.file_id) : null;
      return proposeAction({
        userId,
        connectionId: tool.connectionId,
        // The account this reply read: a card is never stored for another one (see keepGithub).
        accountId: rowOf(tool.connectionId).account_id,
        connection: tool.connection,
        host: tool.host,
        tool: tool.tool,
        title: tool.title,
        toolHash: pinned.hash,
        kind: tool.kind,
        custom: tool.custom,
        input,
        ...(file && { labels: { file_id: file.name } }),
        replyId,
      });
    },
    async close() {
      const opening = [...new Set(made)];
      open.clear();
      renewing.clear();
      made.length = 0;
      await Promise.all(
        opening.map(async (o) => {
          try {
            await (await o).client.close();
          } catch {
            // Never opened.
          }
        }),
      );
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
  scope: msg("This needs more access than the account gave Flash. Press Reconnect on this account in Settings > Connectors and allow it, then ask again."),
};
const PROBLEMS: ConnectProblem[] = ["blocked", "auth", "unreachable", "protocol", "limit", "too_many", "changed", "no_tools", "bad_input", "gone", "unverified", "no_signin", "needs_client", "no_iss", "unreadable", "reconnect", "too_many_files"];
const OWN_WORDS = new Set<string>([...Object.values(NOT_RUN), ...Object.values(GITHUB_PROBLEMS), ...Object.values(GOOGLE_PROBLEMS), ...PROBLEMS.map((code) => problemText(code, english))]);

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
  if (!row || hidden(row)) return fail(NOT_RUN.gone);
  const pinned = await one<ToolRow>("SELECT * FROM connection_tools WHERE connection_id = ? AND name = ?", [row.id, action.tool]);
  if (!pinned || pinned.changed || pinned.hash !== action.tool_hash) return fail(NOT_RUN.changed);
  let out: { text: string; isError: boolean; needsScope?: boolean } | "changed" | "gone";
  try {
    out = await withServer(row, async (opened) => {
      const live = await opened.client.listTools();
      if (live.find((t) => t.name === action.tool)?.hash !== action.tool_hash) return "changed" as const;
      // Still waiting, now that the token is in hand: a sign-in as another GitHub account removes the
      // account's actions in the same write as it keeps its tokens (see keepGithub), so a token of the
      // new account never runs what was asked of the old one.
      if (!(await one("SELECT id FROM pending_actions WHERE id = ? AND user_id = ?", [action.id, userId]))) return "gone" as const;
      return callOn(row, opened, pinned, JSON.parse(action.input_json) as Record<string, unknown>);
    });
  } catch (err) {
    if (err instanceof KeyUnreadable || err instanceof SignInEnded) return fail(NOT_RUN.reconnect);
    const problem = asProblem(err);
    if (problem instanceof ConnectError) {
      if (refusedKey(err)) await needsReconnect(row.id);
      return fail(problemText(problem.code, english));
    }
    return fail(NOT_RUN.failed);
  }
  if (out === "gone") return fail(NOT_RUN.gone);
  if (out === "changed") {
    await run("UPDATE connection_tools SET changed = 1 WHERE connection_id = ? AND name = ?", [row.id, action.tool]);
    return fail(NOT_RUN.changed);
  }
  if (out.needsScope) return fail(NOT_RUN.scope);
  // Kept for the card, and for Continue, cut as a step's results are.
  const kept = cut(out.text, CONNECT_RESULT_TOKENS);
  await finishAction(action.id, !out.isError, kept);
  return { status: out.isError ? "failed" : "done", result: kept.slice(0, CARD_RESULT_CHARS) };
}

/** For a reply continued with approved results: each one's tool as the reply knows it, or nothing when it isn't on. */
export function continuedCalls(kit: ConnectorKit, rows: ActionRow[]) {
  return rows.flatMap((row) => {
    const tool = kit.tools.find((t) => t.connectionId === row.connection_id && t.tool === row.tool);
    return tool ? [{ row, tool }] : [];
  });
}

/** What starts a sign-in: a preset that signs in, a server the user added, or Reconnect of an account that signed in. */
export type SignInRequest = { provider?: string; url?: string; label?: string; connectionId?: string; clientId?: string; clientSecret?: string };

/**
 * Starts signing in to a server (see mcp-oauth.ts): finds how, registers Flash there when needed,
 * keeps the flow for the callback, and returns the authorization server's page for the browser.
 * Reconnect asks for the scopes asked before, with any a tool said it needs since (step-up). A client
 * ID and secret the user typed in are kept for them alone. Costs nothing and calls no model.
 */
export async function startSignIn(userId: string, input: SignInRequest, origin: string): Promise<string> {
  await confirmedOnly(userId);
  let provider: string;
  let url: string;
  let label: string;
  let more: string[] = [];
  let reuse = "";
  if (input.connectionId) {
    const row = await owned(userId, input.connectionId);
    if (row.kind !== "oauth") throw new ConnectError("bad_input", "That account doesn't sign in.");
    try {
      url = row.enc_url ? unseal(row.enc_url, place(row, "url")) : serverUrl(row.provider, row.url);
    } catch {
      throw new ConnectError("gone", "That account isn't connected any more.");
    }
    ({ provider, label } = row);
    more = scopeList(row.scopes);
    reuse = row.client_reg_id;
  } else {
    const preset = presetById(input.provider ?? "");
    if (preset) {
      // GitHub connects through its own route (see startGithub).
      if (!preset.signIn || preset.rest) throw new ConnectError("bad_input", "This service needs its key or token.");
      provider = preset.id;
      url = serverUrl(preset.id, preset.url);
      label = preset.name;
    } else if (input.provider === "custom" && typeof input.url === "string") {
      try {
        url = checkUrl(input.url.trim()).href;
      } catch (err) {
        throw asProblem(err);
      }
      provider = "custom";
      label = (input.label?.trim() || hostOf(url)).slice(0, 60);
    } else {
      throw new ConnectError("bad_input", "Unknown service.");
    }
    const count = await one<{ n: number }>("SELECT COUNT(*) AS n FROM connections WHERE user_id = ?", [userId]);
    if (Number(count?.n ?? 0) >= MAX_CONNECTIONS) throw new ConnectError("too_many", "You have the most connections Flash keeps. Remove one first.");
  }
  await tryLimit(userId);
  try {
    const typed = typedClient(input.clientId, input.clientSecret);
    const plan = await planSignIn(url, { more });
    // A server the user added (also on Reconnect, which keeps the row's provider) signs in only where
    // its authorization server sends iss; see issMatches.
    requireIss(provider, plan.server);
    return await beginSignIn(userId, { provider, serverUrl: url, label, origin, plan, connectionId: input.connectionId, typed, reuse });
  } catch (err) {
    throw asProblem(err);
  }
}

/** How a sign-in ended, for the page it comes back to (never the authorization server's own words). */
export type SignInOutcome = "ok" | "review" | "cancelled" | "expired" | "failed";

/**
 * Finishes a sign-in at the callback: takes the flow once (only the signed-in user's own, see
 * takeFlow), checks iss, trades the code for tokens and keeps them sealed on the connection. A
 * preset is ready at once; a server the user added waits in review until they've seen its tools.
 * Nothing is stored unless all of it worked, and tokens that can't be kept are given back.
 */
export async function finishSignIn(userId: string, params: { state: string | null; code: string | null; iss: string | null; error: string | null }): Promise<SignInOutcome> {
  const flow = await takeFlow(userId, params.state);
  if (!flow) return "expired";
  const failed = (why: string): SignInOutcome => {
    console.log(`[flash] connector sign-in ${flow.provider} failed: ${why}`);
    return "failed";
  };
  if (params.error) return "cancelled";
  if (!issMatches(flow, params.iss)) return failed("iss");
  if (!params.code) return failed("no code");
  let tokens: Tokens;
  try {
    tokens = await exchangeCode(userId, flow, params.code);
  } catch (err) {
    return failed(err instanceof OAuthError ? err.code : "token");
  }
  try {
    return await keepSignIn(userId, flow, tokens);
  } catch (err) {
    await revokeGrant({ userId, clientRegId: flow.client_reg_id, resource: flow.resource, endpoints: readEndpoints(flow.endpoints_json) }, tokens).catch(() => false);
    return failed(err instanceof ConnectError || err instanceof McpError ? err.code : "store");
  }
}

/** Keeps a finished sign-in: a new connection with its tools pinned, or new tokens for one being reconnected. */
async function keepSignIn(userId: string, flow: FlowRow, tokens: Tokens): Promise<"ok" | "review"> {
  const url = flowSecret(flow, "url");
  const preset = presetById(flow.provider);
  const client = new McpClient({ url, token: tokens.access });
  let tools: McpTool[];
  try {
    tools = await client.listTools();
  } finally {
    await client.close();
  }
  const signedIn = (where: Pick<ConnectionRow, "id" | "user_id" | "provider">) => ({
    access: seal(tokens.access, place(where, "access")),
    refresh: tokens.refresh ? seal(tokens.refresh, place(where, "refresh")).stored : "",
  });
  if (flow.connection_id) {
    const row = await one<ConnectionRow>("SELECT * FROM connections WHERE id = ? AND user_id = ? AND kind = 'oauth'", [flow.connection_id, userId]);
    if (!row) throw new ConnectError("gone", "That account isn't connected any more.");
    const sealed = signedIn(row);
    await run(
      `UPDATE connections SET enc_access = ?, enc_refresh = ?, expires_at = ?, issuer = ?, resource = ?, client_reg_id = ?, scopes = ?, endpoints_json = ?,
         protocol = ?, refreshing_until = NULL, status = CASE status WHEN 'review' THEN 'review' ELSE 'ok' END,
         key_version = CASE WHEN COALESCE(enc_url, '') = '' AND COALESCE(enc_secret, '') = '' THEN ? ELSE key_version END
       WHERE id = ? AND user_id = ?`,
      [
        sealed.access.stored,
        sealed.refresh,
        tokens.expiresAt,
        flow.issuer,
        flow.resource,
        flow.client_reg_id,
        flow.scopes,
        flow.endpoints_json,
        client.protocol,
        sealed.access.version,
        row.id,
        userId,
      ],
    );
    return row.status === "review" ? "review" : "ok";
  }
  if (!tools.length) throw new ConnectError("no_tools", "That server has no tools Flash can use.");
  const count = await one<{ n: number }>("SELECT COUNT(*) AS n FROM connections WHERE user_id = ?", [userId]);
  if (Number(count?.n ?? 0) >= MAX_CONNECTIONS) throw new ConnectError("too_many", "You have the most connections Flash keeps. Remove one first.");
  const id = randomId(12);
  const where = { id, user_id: userId, provider: flow.provider };
  const sealed = signedIn(where);
  // A server the user added: only its origin is kept as it is, since its path or query may hold a secret.
  const address = preset ? null : seal(url, place(where, "url"));
  await (await db()).batch(
    [
      {
        sql: `INSERT INTO connections (id, user_id, provider, kind, label, url, enc_url, status, enc_secret, key_version, last4, protocol, created_at,
                enc_access, enc_refresh, expires_at, issuer, resource, client_reg_id, scopes, endpoints_json)
              VALUES (?, ?, ?, 'oauth', ?, ?, ?, ?, '', ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          userId,
          flow.provider,
          flow.label || preset?.name || hostOf(url),
          preset ? preset.url : new URL(url).origin,
          address?.stored ?? "",
          preset ? "ok" : "review",
          sealed.access.version,
          client.protocol,
          now(),
          sealed.access.stored,
          sealed.refresh,
          tokens.expiresAt,
          flow.issuer,
          flow.resource,
          flow.client_reg_id,
          flow.scopes,
          flow.endpoints_json,
        ],
      },
      ...toolInserts(id, tools, preset),
    ],
    "write",
  );
  return preset ? "ok" : "review";
}

/**
 * Connect GitHub, or Reconnect it (see github.ts): GitHub's authorize step, and the app's installation
 * page after it only when the user's token sees no installation. A user keeps one GitHub account
 * here: connecting again updates it (new tokens, and the installations its token sees). With install,
 * for a connected account (Add repositories on GitHub): the app's installation page itself, where the
 * user can install it on their own account or another organization, or pick more repositories; its
 * flow brings them back through the authorize step, so new installations are kept. Only from a
 * confirmed account; costs nothing and calls no model.
 */
export async function startGithub(userId: string, input: { connectionId?: string; install?: boolean }, origin: string): Promise<string> {
  await confirmedOnly(userId);
  const existing = await one<ConnectionRow>("SELECT * FROM connections WHERE user_id = ? AND provider = 'github' ORDER BY created_at LIMIT 1", [userId]);
  if ((input.connectionId || input.install) && (!existing || (input.connectionId && existing.id !== input.connectionId))) {
    throw new ConnectError("gone", "That account isn't connected any more.");
  }
  if (!existing) {
    const count = await one<{ n: number }>("SELECT COUNT(*) AS n FROM connections WHERE user_id = ?", [userId]);
    if (Number(count?.n ?? 0) >= MAX_CONNECTIONS) throw new ConnectError("too_many", "You have the most connections Flash keeps. Remove one first.");
  }
  await tryLimit(userId);
  if (input.install) return beginGithubFlow(userId, origin, { step: "install" });
  // The authorize step first: the installation page comes next only when the user has none (see github.ts).
  return beginGithubFlow(userId, origin, { step: "authorize" });
}

/** How GitHub's callback ends: back to Flash with an outcome, or on to GitHub's authorize step. */
export type GithubOutcome = { outcome: SignInOutcome | "github_install" } | { redirect: string };

/**
 * GitHub's callback (see github.ts for the rules). Trades a code only for the authorize step of a flow
 * this user started, taken once by its state, with its PKCE verifier. A redirect without Flash's state
 * (GitHub's after an installation) or with an install flow's state redeems nothing: it starts the
 * authorize step again when Flash has just sent this user to the installation page, and fails
 * otherwise. A token that sees no installation goes on to the installation page (once). The
 * installation the install named must be one the new token sees; only ids GitHub lists for that
 * token are kept. Tokens that can't be kept are given back.
 */
export async function finishGithub(
  userId: string,
  params: { state: string | null; code: string | null; error: string | null; installationId: string | null },
  origin: string,
): Promise<GithubOutcome> {
  const failed = (why: string): GithubOutcome => {
    console.log(`[flash] connector sign-in github failed: ${why}`);
    return { outcome: "failed" };
  };
  if (!params.state) {
    const install = await takeInstallFlow(userId);
    if (!install) return failed("no state");
    if (params.error) return { outcome: "cancelled" };
    return { redirect: await beginGithubFlow(userId, origin, { step: "authorize", installation: installationHint(params.installationId), afterInstall: true }) };
  }
  const flow = await takeGithubFlow(userId, params.state);
  const step = flow && githubStep(flow);
  if (!flow || !step) return { outcome: "expired" };
  if (params.error) return { outcome: "cancelled" };
  // GitHub passed Flash's state through the installation: its code still isn't the authorize step's.
  if (step.step === "install") return { redirect: await beginGithubFlow(userId, origin, { step: "authorize", installation: installationHint(params.installationId), afterInstall: true }) };
  if (!params.code) return failed("no code");
  try {
    await confirmedOnly(userId);
  } catch {
    return failed("unverified");
  }
  let tokens: Tokens;
  try {
    tokens = await exchangeGithubCode(params.code, flowSecret(flow, "verifier"), flow.redirect_uri);
  } catch (err) {
    return failed(err instanceof OAuthError ? err.code : "token");
  }
  try {
    const [account, installations] = await Promise.all([githubAccount(tokens.access), githubInstallations(tokens.access)]);
    if (!installations.length) {
      // Nothing installed yet: on to the app's installation page, unless the user has just been there.
      await dropGithubToken(tokens.access);
      console.log("[flash] connector sign-in github: no installation");
      if (step.afterInstall) return { outcome: "github_install" };
      return { redirect: await beginGithubFlow(userId, origin, { step: "install" }) };
    }
    if (step.installation && !installations.includes(step.installation)) {
      await dropGithubToken(tokens.access);
      return failed("installation");
    }
    await keepGithub(userId, tokens, installations, account);
    return { outcome: "ok" };
  } catch (err) {
    await dropGithubToken(tokens.access);
    return failed(err instanceof ConnectError ? err.code : err instanceof OAuthError ? err.code : "store");
  }
}

/**
 * Keeps a GitHub sign-in: new tokens and installations for the user's GitHub account, or a new one
 * with Flash's GitHub tools pinned, named with the GitHub login it is for (GitHub · login). Of two
 * sign-ins finishing at once, only one adds the account. A sign-in as another GitHub account (another
 * number) replaces the one kept, so the actions waiting for an Approve on it are removed in the same
 * write, and a reply that read the old one can't store a card after it (see proposeAction): nothing
 * asked of one GitHub account ever runs as another (see runApproved).
 */
async function keepGithub(userId: string, tokens: Tokens, installations: string[], account: GithubAccount): Promise<void> {
  const preset = presetById("github")!;
  const label = `${preset.name} · ${account.login}`.slice(0, 60);
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await one<ConnectionRow>("SELECT * FROM connections WHERE user_id = ? AND provider = 'github' ORDER BY created_at LIMIT 1", [userId]);
    if (existing) {
      const access = seal(tokens.access, place(existing, "access"));
      const refresh = tokens.refresh ? seal(tokens.refresh, place(existing, "refresh")).stored : "";
      await (await db()).batch(
        [
          // Read in the same write as the new tokens, so of two sign-ins at once neither misses it.
          {
            sql: `DELETE FROM pending_actions WHERE connection_id = ? AND user_id = ?
                  AND EXISTS (SELECT 1 FROM connections WHERE id = ? AND user_id = ? AND account_id != ?)`,
            args: [existing.id, userId, existing.id, userId, account.id],
          },
          {
            sql: `UPDATE connections SET enc_access = ?, enc_refresh = ?, expires_at = ?, resource = ?, refreshing_until = NULL, status = 'ok', key_version = ?,
                    label = ?, account_id = ?
                  WHERE id = ? AND user_id = ?`,
            args: [access.stored, refresh, tokens.expiresAt, installations.join(" "), access.version, label, account.id, existing.id, userId],
          },
        ],
        "write",
      );
      return;
    }
    const count = await one<{ n: number }>("SELECT COUNT(*) AS n FROM connections WHERE user_id = ?", [userId]);
    if (Number(count?.n ?? 0) >= MAX_CONNECTIONS) throw new ConnectError("too_many", "You have the most connections Flash keeps. Remove one first.");
    const id = randomId(12);
    const where = { id, user_id: userId, provider: "github" };
    const access = seal(tokens.access, place(where, "access"));
    const refresh = tokens.refresh ? seal(tokens.refresh, place(where, "refresh")).stored : "";
    // One write: the account only if the user has none yet, and its tools only if it was added.
    await (await db()).batch(
      [
        {
          sql: `INSERT INTO connections (id, user_id, provider, kind, label, url, enc_url, status, enc_secret, key_version, last4, protocol, created_at,
                  enc_access, enc_refresh, expires_at, issuer, resource, client_reg_id, scopes, endpoints_json, account_id)
                SELECT ?, ?, 'github', 'github', ?, ?, '', 'ok', '', ?, '', '', ?, ?, ?, ?, ?, ?, '', '', '', ?
                WHERE NOT EXISTS (SELECT 1 FROM connections WHERE user_id = ? AND provider = 'github')`,
          args: [id, userId, label, GITHUB_API, access.version, now(), access.stored, refresh, tokens.expiresAt, GITHUB_ISSUER, installations.join(" "), account.id, userId],
        },
        ...GITHUB_TOOLS.map((t, i) => ({
          sql: `INSERT INTO connection_tools (connection_id, name, title, description, schema, hash, kind, enabled, trusted, changed, position)
                SELECT ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ? WHERE EXISTS (SELECT 1 FROM connections WHERE id = ? AND user_id = ?)`,
          args: [id, t.name, t.title, t.description, JSON.stringify(t.inputSchema), t.hash, kindOf(t, preset), i, id, userId],
        })),
      ],
      "write",
    );
    if (await one("SELECT id FROM connections WHERE id = ? AND user_id = ?", [id, userId])) return;
  }
  throw new ConnectError("gone", "That account isn't connected any more.");
}

// ---------------------------------------------------------------------------------------------
// Google Drive (see google.ts)

/** The user's Google Drive connection: one per user, like GitHub. */
const googleRowOf = (userId: string) => one<ConnectionRow>("SELECT * FROM connections WHERE user_id = ? AND provider = 'google-drive' ORDER BY created_at LIMIT 1", [userId]);

/** The Google account (its sub) a Google Drive connection signed in as, or "". */
function subOf(row: Pick<ConnectionRow, "endpoints_json">): string {
  try {
    const value = JSON.parse(row.endpoints_json) as { sub?: unknown };
    return typeof value.sub === "string" ? value.sub : "";
  } catch {
    return "";
  }
}

/**
 * Connect Google Drive, or Reconnect it (see google.ts): Google's authorize step. A user keeps one
 * Google Drive account here: connecting again updates it. Google is asked to show its consent page
 * (and so send a refresh token) whenever Flash holds none for the user: the first Connect, or after
 * Google refused the old one. Only from a confirmed account; costs nothing and calls no model.
 */
export async function startGoogle(userId: string, input: { connectionId?: string }, origin: string): Promise<string> {
  await confirmedOnly(userId);
  const existing = await googleRowOf(userId);
  if (input.connectionId && existing?.id !== input.connectionId) throw new ConnectError("gone", "That account isn't connected any more.");
  if (!existing) {
    const count = await one<{ n: number }>("SELECT COUNT(*) AS n FROM connections WHERE user_id = ?", [userId]);
    if (Number(count?.n ?? 0) >= MAX_CONNECTIONS) throw new ConnectError("too_many", "You have the most connections Flash keeps. Remove one first.");
  }
  await tryLimit(userId);
  return beginGoogleFlow(userId, origin, { connectionId: existing?.id ?? "", consent: !existing || !usableRefresh(existing) });
}

/** Whether Flash holds a refresh token it can use for a connection (kept, readable, and the account not waiting for Reconnect). */
function usableRefresh(row: ConnectionRow): boolean {
  if (row.status !== "ok" || !row.enc_refresh) return false;
  try {
    unseal(row.enc_refresh, place(row, "refresh"));
    return true;
  } catch {
    return false;
  }
}

/** How Google's callback ends: as any sign-in, or with the sign-in but without access to the files the user picks. */
export type GoogleOutcome = SignInOutcome | "google_scope";

/**
 * Google's callback (see google.ts for the rules). Trades a code only for a flow this user started,
 * taken once by its state, with its PKCE verifier. The account is the one in the ID token from
 * Google's token endpoint (or its userinfo). Google's answer must grant drive.file: if the user left
 * it out, those tokens go back to Google and the account is kept as needing Reconnect (a connection
 * to another Google account stays as it was). Tokens that can't be kept go back to Google, unless
 * they belong to the grant the user's connection already uses (Google would end that one too).
 */
export async function finishGoogle(userId: string, params: { state: string | null; code: string | null; error: string | null }): Promise<GoogleOutcome> {
  const failed = (why: string): GoogleOutcome => {
    console.log(`[flash] connector sign-in google-drive failed: ${why}`);
    return "failed";
  };
  const flow = await takeGoogleFlow(userId, params.state);
  if (!flow) return "expired";
  if (params.error) return "cancelled";
  if (!params.code) return failed("no code");
  try {
    await confirmedOnly(userId);
  } catch {
    return failed("unverified");
  }
  let tokens: GoogleTokens;
  try {
    tokens = await exchangeGoogleCode(params.code, flowSecret(flow, "verifier"), flow.redirect_uri);
  } catch (err) {
    return failed(err instanceof OAuthError ? err.code : "token");
  }
  const existing = await googleRowOf(userId);
  let account: GoogleAccount | null = tokens.idToken ? accountOf(tokens.idToken) : null;
  if (!account?.email) {
    const info = await userinfo(tokens.access);
    if (info && (!account || info.sub === account.sub)) account = info;
  }
  // Tokens Flash won't keep: given back, unless they may be the grant the user's connection uses.
  const giveBack = async () => {
    if (!existing || (account && subOf(existing) && subOf(existing) !== account.sub)) await revokeGoogleToken(tokens.refresh || tokens.access);
  };
  if (!account) {
    await giveBack();
    return failed("account");
  }
  if (!grantsDrive(tokens.scope)) {
    // Signed in, but without the files the user picks: a grant that can't do anything here.
    await revokeGoogleToken(tokens.refresh || tokens.access);
    console.log("[flash] connector sign-in google-drive: drive.file not granted");
    if (!existing || subOf(existing) === account.sub || !subOf(existing)) await keepGoogle(userId, null, account).catch(() => {});
    return "google_scope";
  }
  try {
    await keepGoogle(userId, tokens, account);
    return "ok";
  } catch (err) {
    await giveBack();
    return failed(err instanceof ConnectError ? err.code : "store");
  }
}

/**
 * Keeps a Google sign-in on the user's Google Drive connection, or adds one with Flash's Google tools
 * pinned. Without tokens (drive.file wasn't granted), it is kept as needing Reconnect, with none.
 * Google sends a refresh token only with its consent page: the one kept goes on for the same account
 * (sealed again with the newest key). Another Google account than before forgets the files picked in
 * the old one, and its waiting actions, and Flash's access to the old one is cancelled at Google. Of
 * two sign-ins finishing at once, only one adds the account.
 */
async function keepGoogle(userId: string, tokens: GoogleTokens | null, account: GoogleAccount): Promise<void> {
  const preset = presetById("google-drive")!;
  const meta = JSON.stringify({ sub: account.sub });
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await googleRowOf(userId);
    if (existing) {
      const other = subOf(existing) !== account.sub;
      const access = tokens ? seal(tokens.access, place(existing, "access")) : null;
      let refresh = "";
      if (tokens?.refresh) refresh = seal(tokens.refresh, place(existing, "refresh")).stored;
      else if (tokens && !other && existing.enc_refresh) {
        try {
          refresh = seal(unseal(existing.enc_refresh, place(existing, "refresh")), place(existing, "refresh")).stored;
        } catch {
          refresh = "";
        }
      }
      const at = now();
      await (await db()).batch(
        [
          {
            sql: `UPDATE connections SET enc_access = ?, enc_refresh = ?, expires_at = ?, resource = ?, scopes = ?, endpoints_json = ?, refreshing_until = NULL,
                    status = ?, key_version = ? WHERE id = ? AND user_id = ?`,
            args: [access?.stored ?? "", refresh, tokens?.expiresAt ?? 0, account.email, tokens?.scope ?? "", meta, tokens ? "ok" : "needs_reconnect", access?.version ?? existing.key_version, existing.id, userId],
          },
          ...(other
            ? [
                { sql: "DELETE FROM connection_files WHERE connection_id = ?", args: [existing.id] },
                { sql: "UPDATE pending_actions SET status = 'cancelled', finished_at = ? WHERE connection_id = ? AND user_id = ? AND status = 'pending'", args: [at, existing.id, userId] },
              ]
            : []),
        ],
        "write",
      );
      // The old account's grant isn't used any more: Google is asked to cancel it (its tokens, as they were read).
      if (other) await revokeGoogle(existing);
      return;
    }
    const count = await one<{ n: number }>("SELECT COUNT(*) AS n FROM connections WHERE user_id = ?", [userId]);
    if (Number(count?.n ?? 0) >= MAX_CONNECTIONS) throw new ConnectError("too_many", "You have the most connections Flash keeps. Remove one first.");
    const id = randomId(12);
    const where = { id, user_id: userId, provider: "google-drive" };
    const access = tokens ? seal(tokens.access, place(where, "access")) : null;
    const refresh = tokens?.refresh ? seal(tokens.refresh, place(where, "refresh")).stored : "";
    // One write: the account only if the user has none yet, and its tools only if it was added.
    await (await db()).batch(
      [
        {
          sql: `INSERT INTO connections (id, user_id, provider, kind, label, url, enc_url, status, enc_secret, key_version, last4, protocol, created_at,
                  enc_access, enc_refresh, expires_at, issuer, resource, client_reg_id, scopes, endpoints_json)
                SELECT ?, ?, 'google-drive', 'google', ?, ?, '', ?, '', ?, '', '', ?, ?, ?, ?, ?, ?, '', ?, ?
                WHERE NOT EXISTS (SELECT 1 FROM connections WHERE user_id = ? AND provider = 'google-drive')`,
          args: [
            id,
            userId,
            preset.name,
            GOOGLE_API,
            tokens ? "ok" : "needs_reconnect",
            access?.version ?? "",
            now(),
            access?.stored ?? "",
            refresh,
            tokens?.expiresAt ?? 0,
            "https://accounts.google.com",
            account.email,
            tokens?.scope ?? "",
            meta,
            userId,
          ],
        },
        ...GOOGLE_TOOLS.map((t, i) => ({
          sql: `INSERT INTO connection_tools (connection_id, name, title, description, schema, hash, kind, enabled, trusted, changed, position)
                SELECT ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ? WHERE EXISTS (SELECT 1 FROM connections WHERE id = ? AND user_id = ?)`,
          args: [id, t.name, t.title, t.description, JSON.stringify(t.inputSchema), t.hash, kindOf(t, preset), i, id, userId],
        })),
      ],
      "write",
    );
    if (await one("SELECT id FROM connections WHERE id = ? AND user_id = ?", [id, userId])) return;
  }
  throw new ConnectError("gone", "That account isn't connected any more.");
}

// Picker tokens and picks, per user and hour. A Picker token is renewed first when it has less than
// this left, so Google's Picker doesn't lose it while the user looks for files.
const PICKER_PER_HOUR = 60;
const PICKS_PER_HOUR = 30;
const PICKER_EARLY_MS = 10 * 60_000;

/** The user's own Google Drive connection, ready to use, or why not. */
async function usableGoogle(userId: string, connectionId: string): Promise<ConnectionRow> {
  const row = await owned(userId, connectionId);
  if (row.kind !== "google" || hidden(row)) throw new ConnectError("gone", "That account isn't connected any more.");
  if (row.status !== "ok") throw new ConnectError("reconnect", "This account needs to be connected again.");
  return row;
}

/**
 * The access token Google's Picker needs, for the user's own browser only (see the picker-token
 * route): the connection's own token, renewed first when it has less than 10 minutes left. Only from
 * a confirmed account, at most 60 times an hour. It is never logged. Costs nothing and calls no model.
 */
export async function googlePickerToken(userId: string, connectionId: string): Promise<{ token: string }> {
  await confirmedOnly(userId);
  if (await overLimit(`google-picker:${userId}`, PICKER_PER_HOUR, HOUR)) throw new ConnectError("limit", "Too many attempts. Try again in an hour.");
  const row = await usableGoogle(userId, connectionId);
  try {
    const { token } = await accessToken(row, "", undefined, PICKER_EARLY_MS);
    console.log(`[flash] connector ${row.id} ${row.provider} picker token`);
    return { token };
  } catch (err) {
    if (err instanceof KeyUnreadable || err instanceof SignInEnded) throw new ConnectError("reconnect", "This account needs to be connected again.");
    throw asProblem(err);
  }
}

/**
 * Records files the user picked with Google's Picker. Nothing the browser says is believed: each id
 * is looked up with files.get and the user's own token, which works only for a file the Picker gave
 * Flash (or one Flash made), and the name and type kept are the ones Google answers with. A file
 * Google doesn't show, one in the trash, or one that isn't a Doc, Sheet, Slides deck, PDF or text
 * file is left out (refused). At most MAX_PICK at a time, MAX_FILES in all. Costs nothing.
 */
export async function addPickedFiles(userId: string, connectionId: string, ids: string[]): Promise<{ files: PickedFileView[]; added: number; refused: number }> {
  await confirmedOnly(userId);
  const wanted = [...new Set(ids)];
  if (!wanted.length || wanted.length > MAX_PICK) throw new ConnectError("bad_input", "Pick between 1 and 20 files at a time.");
  if (await overLimit(`google-pick:${userId}`, PICKS_PER_HOUR, HOUR)) throw new ConnectError("limit", "Too many attempts. Try again in an hour.");
  const row = await usableGoogle(userId, connectionId);
  const kept = await pickedFiles(row.id);
  const valid = wanted.filter((id) => FILE_ID.test(id));
  if (kept.length + valid.filter((id) => !kept.some((f) => f.file_id === id)).length > MAX_FILES) {
    throw new ConnectError("too_many_files", "Flash keeps at most 100 files for one account.");
  }
  let found: ({ id: string; name: string; mime: string } | null)[];
  try {
    found = await withServer(row, async (opened) => {
      if (!(opened.client instanceof GoogleClient)) throw new ConnectError("gone", "That account isn't connected any more.");
      const out: ({ id: string; name: string; mime: string } | null)[] = [];
      for (const id of valid) out.push(await opened.client.describe(id));
      return out;
    });
  } catch (err) {
    if (err instanceof KeyUnreadable || err instanceof SignInEnded) throw new ConnectError("reconnect", "This account needs to be connected again.");
    if (refusedKey(err)) await needsReconnect(row.id);
    throw asProblem(err);
  }
  const good = found.filter((f): f is { id: string; name: string; mime: string } => f !== null);
  const at = now();
  if (good.length) {
    await (await db()).batch(
      good.flatMap((f) => [
        { sql: "DELETE FROM connection_files WHERE connection_id = ? AND file_id = ?", args: [row.id, f.id] },
        {
          // Only while the connection is still the user's (it may have been removed meanwhile).
          sql: `INSERT INTO connection_files (connection_id, file_id, name, mime, picked_at)
                SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM connections WHERE id = ? AND user_id = ?)`,
          args: [row.id, f.id, cleanName(f.name) || f.id, f.mime, at, row.id, userId],
        },
      ]),
      "write",
    );
  }
  console.log(`[flash] connector ${row.id} ${row.provider} picked: ${good.length} kept, ${wanted.length - good.length} refused`);
  const files = (await pickedFiles(row.id)).map((f) => ({ id: f.file_id, name: f.name, mime: f.mime, pickedAt: Number(f.picked_at) }));
  return { files, added: good.length, refused: wanted.length - good.length };
}

/**
 * Forgets a picked file: Flash can't open it in chat any more. (Google keeps the access the Picker
 * gave to that one file until the user removes Flash's access to their account; drive.file has no
 * way to give one file back.) Costs nothing.
 */
export async function forgetPickedFile(userId: string, connectionId: string, fileId: string): Promise<PickedFileView[]> {
  const row = await owned(userId, connectionId);
  if (row.kind !== "google") throw new ConnectError("gone", "That account isn't connected any more.");
  await run("DELETE FROM connection_files WHERE connection_id = ? AND file_id = ?", [row.id, fileId]);
  return (await pickedFiles(row.id)).map((f) => ({ id: f.file_id, name: f.name, mime: f.mime, pickedAt: Number(f.picked_at) }));
}
