import { db, now, one, all, run } from "./db.ts";
import { randomId, sha256 } from "./ids.ts";
import { decodeJwtPayload, pkceChallenge } from "./oauth.ts";
import { FLOW_TTL_MS, OAuthError, flowPlace, scopeList, type FlowRow, type Tokens } from "./mcp-oauth.ts";
import { CALL_TIMEOUT_MS, McpError, toolHash, type McpTool, type ToolOutput } from "./mcp-client.ts";
import { RESULT_BYTES, SafeFetchError, mockOrigin, safeFetch, type SafeRequest, type SafeResponse } from "./safe-fetch.ts";
import { connectorsReady, seal } from "./secret-box.ts";
import { PdfNotNow, pdfTextOnServer } from "./pdf-server.ts";
import { msg } from "../i18n.ts";
import { GOOGLE_TOOL_WORDS } from "../connectors.ts";
import { MAX_INPUT_CHARS } from "../engines/connect.ts";

/*
 * Google Drive, Docs, Sheets and Slides in chat (the connectors plan, PR 4), with the drive.file
 * scope only: Flash can open only the files the user picks with Google's Picker (in Settings >
 * Connectors, "Add from Drive") and the ones it creates, never the rest of their Drive, and it can't
 * search it. Six of Flash's own tools over Google's REST APIs: list the picked files and read one
 * (reads, which run by themselves), and create a Doc, a Sheet or a Slides deck, or add rows to a
 * picked Sheet (writes, which wait for the user's Approve like every write).
 *
 * Connect is Google's authorize step with state, PKCE (S256), access_type=offline,
 * include_granted_scopes=true and the scopes openid, email and drive.file; prompt=consent when Flash
 * holds no refresh token for the user yet (the first Connect, or after Google refused the old one),
 * since Google sends one only when it asks for consent. The callback (src/app/api/connect/google)
 * trusts nothing in its address: a code is traded only with the state of a flow this signed-in user
 * started (taken once, see takeGoogleFlow); the scopes Google granted are read from its token
 * answer, and without drive.file the account is kept as needing Reconnect; the account's label is
 * the email in the ID token Google's token endpoint returned (its issuer, audience and expiry checked).
 *
 * The picked files are rows in connection_files, written only after Google confirmed each id with
 * the user's own token (files.get, which also proves the Picker gave Flash access to it), with the
 * name and type Google gave. Every tool checks a file id against those rows before any request, so
 * the model can never name another file.
 *
 * Tokens are sealed (secret-box.ts) on the connection and in nothing else. They are never logged,
 * put in an address or returned by an API, with one exception by design: the user's own browser gets
 * the access token from POST /api/connect/google/picker-token, because Google's Picker runs there.
 * The client secret is read from the environment and sent only to Google's token endpoint. Every
 * request goes through safeFetch: Google's fixed hosts (or, in development only, the stand-in at
 * FLASH_CONNECT_MOCK), with time and size limits. Nothing here calls a model or moves credits.
 */

const env = (name: string) => process.env[name]?.trim() ?? "";

/** The environment variables Google Drive needs: until all four are set (and CONNECTOR_KEYS), it is hidden everywhere. */
export const GOOGLE_KEYS = ["GOOGLE_CONNECT_CLIENT_ID", "GOOGLE_CONNECT_CLIENT_SECRET", "GOOGLE_PICKER_API_KEY", "GOOGLE_CONNECT_PROJECT_NUMBER"] as const;

/** A Cloud project number is digits (its project ID, letters and dashes, isn't what Picker's setAppId takes). */
const PROJECT_NUMBER = /^\d{4,20}$/;

/** The variables that aren't usable yet, by name (never a value): unset, only spaces, or a project number that isn't digits. */
export const googleMissing = () => GOOGLE_KEYS.filter((name) => !env(name) || (name === "GOOGLE_CONNECT_PROJECT_NUMBER" && !PROJECT_NUMBER.test(env(name))));

/** Whether users can connect Google Drive: connectors are set up (CONNECTOR_KEYS) and so is Flash's Google Cloud project. */
export const googleReady = () => connectorsReady() && googleMissing().length === 0;

export const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_SCOPES = ["openid", "email", DRIVE_FILE];

const HOSTS = {
  accounts: "https://accounts.google.com",
  oauth2: "https://oauth2.googleapis.com",
  www: "https://www.googleapis.com",
  docs: "https://docs.googleapis.com",
  sheets: "https://sheets.googleapis.com",
  slides: "https://slides.googleapis.com",
} as const;

/** One of Google's hosts; the dev stand-in's when FLASH_CONNECT_MOCK is on. */
export const googleHost = (name: keyof typeof HOSTS) => (mockOrigin() ? `${mockOrigin()}/google/${name}` : HOSTS[name]);
export const GOOGLE_API = HOSTS.www;
export const GOOGLE_ISSUER = HOSTS.accounts;
/** Where Google sends the browser back: the OAuth client's redirect URI. */
export const googleCallbackUrl = (origin: string) => `${origin}/api/connect/google/callback`;

const TOKEN_MS = 10_000;
const REVOKE_MS = 5000;
const TOKEN_MAX = 64 * 1024;
const TOKEN_CHARS = /^[\x21-\x7e]{1,8192}$/;

/** A Drive file id as Google writes them. Anything else is refused before it reaches a request or the database. */
export const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;

/** What can be picked and read: Docs, Sheets, Slides, PDFs and plain text (the Picker shows only these). */
export const DRIVE_TYPES: Record<string, "doc" | "sheet" | "slides" | "pdf" | "text"> = {
  "application/vnd.google-apps.document": "doc",
  "application/vnd.google-apps.spreadsheet": "sheet",
  "application/vnd.google-apps.presentation": "slides",
  "application/pdf": "pdf",
  "text/plain": "text",
};

/** The most files one account keeps, and one pick adds. */
export const MAX_FILES = 100;
export const MAX_PICK = 20;

// ---------------------------------------------------------------------------------------------
// Connecting: the flow, the tokens and the account

/**
 * Starts a Google flow (10 minutes, single use, bound to the user; for Reconnect, the connection it
 * renews) and returns Google's authorize page to send the browser to.
 */
export async function beginGoogleFlow(userId: string, origin: string, { connectionId = "", consent }: { connectionId?: string; consent: boolean }): Promise<string> {
  const state = randomId(24);
  const verifier = randomId(48);
  const stateHash = sha256(state);
  const redirectUri = googleCallbackUrl(origin);
  const at = now();
  await (await db()).batch(
    [
      // Old flows go whenever a new one starts (Flash has no scheduled jobs).
      { sql: "DELETE FROM connect_flows WHERE expires_at < ?", args: [at] },
      {
        sql: `INSERT INTO connect_flows (state_hash, user_id, enc_verifier, provider, connection_id, label, enc_url, issuer, resource, client_reg_id, scopes, redirect_uri, endpoints_json, created_at, expires_at)
              VALUES (?, ?, ?, 'google-drive', ?, 'Google Drive', '', ?, '', '', ?, ?, '{}', ?, ?)`,
        args: [stateHash, userId, seal(verifier, flowPlace(stateHash, userId, "verifier")).stored, connectionId, GOOGLE_ISSUER, GOOGLE_SCOPES.join(" "), redirectUri, at, at + FLOW_TTL_MS],
      },
    ],
    "write",
  );
  const page = new URL(`${googleHost("accounts")}/o/oauth2/v2/auth`);
  page.searchParams.set("client_id", env("GOOGLE_CONNECT_CLIENT_ID"));
  page.searchParams.set("redirect_uri", redirectUri);
  page.searchParams.set("response_type", "code");
  page.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  page.searchParams.set("access_type", "offline");
  page.searchParams.set("include_granted_scopes", "true");
  page.searchParams.set("state", state);
  page.searchParams.set("code_challenge", pkceChallenge(verifier));
  page.searchParams.set("code_challenge_method", "S256");
  if (consent) page.searchParams.set("prompt", "consent");
  return page.href;
}

/** Who started the Google Drive sign-in for a state that is still under way (null for none). */
export async function googleFlowOwner(state: string | null): Promise<string | null> {
  if (!state || state.length > 200) return null;
  const row = await one<{ user_id: string }>("SELECT user_id FROM connect_flows WHERE state_hash = ? AND provider = 'google-drive' AND expires_at > ?", [sha256(state), now()]);
  return row?.user_id ?? null;
}

/** Takes the user's own Google flow for a state, once, before it expires (the other services' callbacks never take it). */
export async function takeGoogleFlow(userId: string, state: string | null): Promise<FlowRow | null> {
  if (!state || state.length > 200) return null;
  const taken = await run("DELETE FROM connect_flows WHERE state_hash = ? AND user_id = ? AND provider = 'google-drive' AND expires_at > ? RETURNING *", [sha256(state), userId, now()]);
  return (taken.rows[0] as unknown as FlowRow) ?? null;
}

/** Tokens from Google's token endpoint, with the ID token that came with them (at sign-in). */
export type GoogleTokens = Tokens & { idToken: string };

/**
 * Google's token endpoint's answer: tokens, or an OAuthError ("invalid_grant" for a code or refresh
 * token it refuses). Google's own words are never kept. A refused client (a wrong secret in Vercel)
 * isn't the user's grant ending, so it doesn't send anyone to Reconnect.
 */
function readTokens(res: SafeResponse): GoogleTokens {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(res.body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: refused below.
  }
  if (res.status !== 200) {
    if (body.error === "invalid_grant") throw new OAuthError("invalid_grant");
    throw new OAuthError(res.status >= 500 ? "unreachable" : "token");
  }
  const access = body.access_token;
  if (typeof access !== "string" || !TOKEN_CHARS.test(access)) throw new OAuthError("token");
  if (body.token_type !== undefined && String(body.token_type).toLowerCase() !== "bearer") throw new OAuthError("token");
  const refresh = typeof body.refresh_token === "string" && TOKEN_CHARS.test(body.refresh_token) ? body.refresh_token : "";
  const seconds = Number(body.expires_in);
  return {
    access,
    refresh,
    expiresAt: Number.isFinite(seconds) && seconds > 0 ? now() + Math.min(seconds, 24 * 3600) * 1000 : 0,
    scope: typeof body.scope === "string" ? scopeList(body.scope).join(" ") : "",
    idToken: typeof body.id_token === "string" && body.id_token.length < 8192 ? body.id_token : "",
  };
}

/** A form to Google's token endpoint, with the client ID and secret. Never follows a redirect: the form holds a secret. */
async function tokenRequest(form: Record<string, string>): Promise<GoogleTokens> {
  let res: SafeResponse;
  try {
    res = await safeFetch(`${googleHost("oauth2")}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: env("GOOGLE_CONNECT_CLIENT_ID"), client_secret: env("GOOGLE_CONNECT_CLIENT_SECRET"), ...form }).toString(),
      accept: ["json"],
      maxBytes: TOKEN_MAX,
      timeoutMs: TOKEN_MS,
      followRedirects: false,
    });
  } catch {
    throw new OAuthError("unreachable", "Google couldn't be reached.");
  }
  return readTokens(res);
}

/** Trades the authorize step's code for the user's tokens, with the flow's PKCE verifier. */
export const exchangeGoogleCode = (code: string, verifier: string, redirectUri: string) => {
  if (!code || code.length > 2048 || !TOKEN_CHARS.test(code)) throw new OAuthError("token");
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
};

/** Whether a token answer's scope holds drive.file (what every tool needs). */
export const grantsDrive = (scope: string) => scopeList(scope).includes(DRIVE_FILE);

/**
 * New tokens for a refresh token (Google keeps the same refresh token; connections.ts runs one
 * refresh at a time). A token without drive.file any more can't do anything here: that is a grant
 * the user must give again, like a refused one.
 */
export async function refreshGoogleToken(refresh: string): Promise<Tokens> {
  const tokens = await tokenRequest({ grant_type: "refresh_token", refresh_token: refresh });
  if (tokens.scope && !grantsDrive(tokens.scope)) throw new OAuthError("invalid_grant");
  return tokens;
}

/**
 * Asks Google to cancel a token (POST https://oauth2.googleapis.com/revoke). Google cancels the
 * whole grant with it: every token it gave Flash for this user. Never throws; true when Google confirmed it.
 */
export async function revokeGoogleToken(token: string): Promise<boolean> {
  if (!token) return false;
  try {
    const res = await safeFetch(`${googleHost("oauth2")}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ token }).toString(),
      accept: ["json"],
      maxBytes: TOKEN_MAX,
      timeoutMs: REVOKE_MS,
      followRedirects: false,
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** The Google account a sign-in is for: its stable id (sub) and its email, when Google says it is confirmed. */
export type GoogleAccount = { sub: string; email: string };

const SUB = /^[\w-]{1,255}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}$/;

/**
 * The account in the ID token Google's token endpoint sent with the tokens. It came straight from
 * Google over TLS, which OpenID Connect accepts in place of checking its signature; its issuer,
 * audience (Flash's client) and expiry are still checked. Null when any of that is wrong.
 */
export function accountOf(idToken: string, at = Date.now()): GoogleAccount | null {
  const claims = idToken ? decodeJwtPayload(idToken) : null;
  if (!claims) return null;
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") return null;
  const client = env("GOOGLE_CONNECT_CLIENT_ID");
  if (!(claims.aud === client || (Array.isArray(claims.aud) && claims.aud.includes(client)))) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 + 5 * 60_000 < at) return null;
  const sub = typeof claims.sub === "string" && SUB.test(claims.sub) ? claims.sub : "";
  if (!sub) return null;
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  const confirmed = claims.email_verified === true || claims.email_verified === "true";
  return { sub, email: confirmed && EMAIL.test(email) && email.length <= 254 ? email : "" };
}

/** The account from Google's userinfo endpoint, for an ID token without a confirmed email. Null when Google doesn't say. */
export async function userinfo(access: string): Promise<GoogleAccount | null> {
  try {
    const res = await safeFetch(`${googleHost("www")}/oauth2/v3/userinfo`, {
      headers: { authorization: `Bearer ${access}`, accept: "application/json" },
      accept: ["json"],
      maxBytes: TOKEN_MAX,
      timeoutMs: TOKEN_MS,
    });
    if (res.status !== 200) return null;
    const body = JSON.parse(res.body) as Record<string, unknown>;
    const sub = typeof body.sub === "string" && SUB.test(body.sub) ? body.sub : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const confirmed = body.email_verified === true || body.email_verified === "true";
    return sub ? { sub, email: confirmed && EMAIL.test(email) && email.length <= 254 ? email : "" } : null;
  } catch {
    return null;
  }
}

/** What the Picker needs besides the user's token: the API key and the Cloud project's number (setAppId). Both are public by design. */
export const pickerSettings = () => ({ apiKey: env("GOOGLE_PICKER_API_KEY"), appId: env("GOOGLE_CONNECT_PROJECT_NUMBER") });

// ---------------------------------------------------------------------------------------------
// The picked files

/** A picked file as Flash keeps it: what Google said its name and type were when it was picked. */
export type PickedFile = { file_id: string; name: string; mime: string; picked_at: number };

/** The connection's picked files, newest first. */
export const pickedFiles = (connectionId: string) =>
  all<PickedFile>("SELECT file_id, name, mime, picked_at FROM connection_files WHERE connection_id = ? ORDER BY picked_at DESC, name", [connectionId]);

/** One picked file of the connection, or null: the only way a tool finds a file. */
export const pickedFile = (connectionId: string, fileId: unknown) =>
  typeof fileId === "string" && FILE_ID.test(fileId)
    ? one<PickedFile>("SELECT file_id, name, mime, picked_at FROM connection_files WHERE connection_id = ? AND file_id = ?", [connectionId, fileId])
    : Promise.resolve(null);

/** A file's name as Flash keeps and shows it: one line, without control characters, cut. */
export const cleanName = (value: unknown) =>
  String(value ?? "")
    .replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

// ---------------------------------------------------------------------------------------------
// The tools

/**
 * Why a call failed, in Flash's words, shown on an approved action's card in the user's language (see
 * failedText in connections.ts). Claude gets them in English.
 */
export const GOOGLE_PROBLEMS = {
  notPicked: msg("That file isn't one you picked for Flash. Add it with Add from Drive in Settings > Connectors first."),
  notFound: msg("Google Drive didn't find that file, or Flash no longer has access to it. Pick it again with Add from Drive."),
  rate: msg("Google's limit for this account was reached, so Flash didn't try again. Wait a few minutes, then ask again."),
  // A PDF Flash didn't read for a reason that has nothing to do with the file (see PdfNotNow).
  pdfBusy: msg("Flash is busy reading other PDFs. Try again in a minute."),
  pdfLater: msg("Flash can't read PDFs right now. Try again later."),
  noEdit: msg("Google didn't let Flash change that file: you may only be able to view it, or you no longer have access. Ask its owner for edit access."),
};

// How much of a file is read: the start of a text or an export (Claude gets far less, see
// CONNECT_RESULT_TOKENS), a whole PDF up to Drive's own export limit, and a sheet's first rows.
const TEXT_BYTES = 512 * 1024;
const PDF_BYTES = 10 * 1024 * 1024;
const READ_CHARS = 100_000;
const SHEET_ROWS = 1000;
// What a write may hold: rows (and their cells), slides, and the length of a title or a cell.
const MAX_ROWS = 1000;
const MAX_COLUMNS = 200;
const MAX_SLIDES = 50;
const MAX_TITLE = 200;
const MAX_CELL = 50_000;

const FILE = { type: "string", description: "The file's id, from list_files." };
// What one call may hold: Flash refuses a call longer than MAX_INPUT_CHARS as JSON, a text with a maxLength
// counted by its characters (inputProblem, engines/connect.ts), so each schema tells Claude, with room for
// the call's other fields, and says how to write more in parts.
const PART_CHARS = MAX_INPUT_CHARS - 1_000;
const ROWS = {
  type: "array",
  description:
    "The rows, top to bottom. Each row is a list of cells, left to right: text, or a number. Cells are written as they are, never as formulas. " +
    `All the rows of one call together must stay under ${PART_CHARS.toLocaleString("en-US")} characters as JSON (a few hundred short rows). For more, ` +
    "send the first rows in this call, tell the user the rest will follow once they approve it and continue, then add the rest with append_rows, in calls of that size.",
  items: { type: "array", items: { type: ["string", "number"] } },
};
const TEXT_PART = { type: "string", maxLength: PART_CHARS };
const SHEET = { type: "string", description: "The sheet's name (a tab in the file). Leave it out for the first sheet." };

type Definition = { name: string; title: string; description: string; inputSchema: Record<string, unknown>; read: boolean };

/** The tools, as Claude and Settings get them. Titles and descriptions are Flash's own, so the page shows them translated. */
const DEFINITIONS: Definition[] = [
  {
    name: "list_files",
    title: GOOGLE_TOOL_WORDS.list_files.title,
    description: GOOGLE_TOOL_WORDS.list_files.description,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    read: true,
  },
  {
    name: "read_file",
    title: GOOGLE_TOOL_WORDS.read_file.title,
    description: GOOGLE_TOOL_WORDS.read_file.description,
    inputSchema: { type: "object", properties: { file_id: FILE, sheet: SHEET }, required: ["file_id"], additionalProperties: false },
    read: true,
  },
  {
    name: "create_doc",
    title: GOOGLE_TOOL_WORDS.create_doc.title,
    description: GOOGLE_TOOL_WORDS.create_doc.description,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The document's name." },
        text: {
          ...TEXT_PART,
          description:
            `The document's text, as plain text, at most ${PART_CHARS.toLocaleString("en-US")} characters. For a longer document, write its start here, tell the user ` +
            "the rest will follow once they approve it and continue, then add the rest with append_text, in parts of that size.",
        },
      },
      required: ["title", "text"],
      additionalProperties: false,
    },
    read: false,
  },
  {
    name: "create_sheet",
    title: GOOGLE_TOOL_WORDS.create_sheet.title,
    description: GOOGLE_TOOL_WORDS.create_sheet.description,
    inputSchema: { type: "object", properties: { title: { type: "string", description: "The spreadsheet's name." }, rows: ROWS }, required: ["title", "rows"], additionalProperties: false },
    read: false,
  },
  {
    name: "create_slides",
    title: GOOGLE_TOOL_WORDS.create_slides.title,
    description: GOOGLE_TOOL_WORDS.create_slides.description,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The deck's name." },
        slides: {
          type: "array",
          description: `The slides, in order: 1 to ${MAX_SLIDES}, all of them together under ${PART_CHARS.toLocaleString("en-US")} characters as JSON. A deck can't be added to later, so keep its slides short.`,
          maxItems: MAX_SLIDES,
          items: {
            type: "object",
            properties: { title: { type: "string", description: "The slide's title." }, body: { type: "string", description: "The slide's text, as plain text (one point per line)." } },
            required: ["title", "body"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "slides"],
      additionalProperties: false,
    },
    read: false,
  },
  {
    name: "append_rows",
    title: GOOGLE_TOOL_WORDS.append_rows.title,
    description: GOOGLE_TOOL_WORDS.append_rows.description,
    inputSchema: { type: "object", properties: { file_id: FILE, rows: ROWS, sheet: SHEET }, required: ["file_id", "rows"], additionalProperties: false },
    read: false,
  },
  {
    name: "append_text",
    title: GOOGLE_TOOL_WORDS.append_text.title,
    description: GOOGLE_TOOL_WORDS.append_text.description,
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "The Doc's id: from list_files, or the one create_doc's result gave." },
        text: {
          ...TEXT_PART,
          description:
            `The text to add after the Doc's last character, as plain text, at most ${PART_CHARS.toLocaleString("en-US")} characters: start it with a line break ` +
            "to begin a new paragraph. For more, use several calls, in order.",
        },
      },
      required: ["file_id", "text"],
      additionalProperties: false,
    },
    read: false,
  },
];

/** The tools as a server would list them, pinned by the same hash as any connector's tools. */
export const GOOGLE_TOOLS: McpTool[] = DEFINITIONS.map((d) => {
  const annotations = { readOnlyHint: d.read, destructiveHint: false };
  return { name: d.name, title: d.title, description: d.description, inputSchema: d.inputSchema, annotations, hash: toolHash(d.name, d.description, d.inputSchema, { title: d.title, annotations }) };
});

/** Each tool's fields, as its schema lists them (what inputProblem checks too): a call with any other is refused (see callTool). */
const FIELDS = new Map(DEFINITIONS.map((d) => [d.name, Object.keys(d.inputSchema.properties as Record<string, unknown>)]));

/** How a type is named to Claude. */
const KIND_NAMES = { doc: "Google Doc", sheet: "Google Sheet", slides: "Google Slides", pdf: "PDF", text: "text file" } as const;

const parse = (res: SafeResponse): unknown => {
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
};

const failed = (text: string): ToolOutput => ({ text, isError: true });
const unusable = (why: string) => failed(`That input wasn't usable: ${why}.`);
/** One line of Google's text, cut. */
const oneLine = (value: unknown, max = 200) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const field = (value: unknown, key: string): unknown => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined);

/** A title for a new file: text, 1 to 200 characters, one line. Sent exactly as the card showed it, or refused. */
const titleOf = (value: unknown) => (typeof value === "string" && value.trim() && value.length <= MAX_TITLE && !/[\x00-\x1f\x7f]/.test(value) ? value : null);

/** A sheet's name: 1 to 100 characters, one line. */
const sheetOf = (value: unknown) => (typeof value === "string" && value.trim() && value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value) ? value : null);

/** A sheet's name in A1 notation: quoted, its quotes doubled. */
const quoted = (sheet: string) => `'${sheet.replace(/'/g, "''")}'`;

type Cell = string | number;

/** Rows to write, checked: at least one, each a list of text or finite numbers. What is sent is exactly what the card showed. */
function rowsOf(value: unknown): Cell[][] | null {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ROWS) return null;
  for (const row of value) {
    if (!Array.isArray(row) || row.length > MAX_COLUMNS) return null;
    for (const cell of row) if (!((typeof cell === "string" && cell.length <= MAX_CELL) || (typeof cell === "number" && Number.isFinite(cell)))) return null;
  }
  return value as Cell[][];
}

/** A value as one CSV cell: quoted when it holds a comma, a quote or a line break. */
const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** The address of a file Flash made, from Google's id for it (checked). */
const fileUrl = (kind: "document" | "spreadsheets" | "presentation", id: string) => `https://docs.google.com/${kind}/d/${id}/edit`;

/**
 * What a Google answer that isn't a success means for the call: a 401 is a token Google refused
 * (thrown, so the sign-in is renewed once and a read sent again); a rate limit, a file Flash can't
 * reach, an export that is too large or a refused input is the call's own failure, said plainly.
 * Nothing is retried here.
 */
function problemOf(res: SafeResponse): ToolOutput | null {
  if (res.status >= 200 && res.status < 300) return null;
  if (res.status === 401) throw new McpError("auth", "Google didn't accept the sign-in.", { status: 401 });
  const error = field(parse(res), "error");
  const message = oneLine(field(error, "message"), 300);
  const errors = field(error, "errors");
  const reasons = (Array.isArray(errors) ? errors : []).map((e) => String(field(e, "reason") ?? ""));
  if (res.status === 429 || field(error, "status") === "RESOURCE_EXHAUSTED" || reasons.some((r) => /rateLimitExceeded|quotaExceeded/.test(r))) return failed(GOOGLE_PROBLEMS.rate);
  if (reasons.includes("exportSizeLimitExceeded")) return failed("Google can't export this file: it is over Google's 10 MB export limit.");
  if (res.status === 404 || reasons.some((r) => r === "appNotAuthorizedToFile" || r === "insufficientFilePermissions" || r === "notFound")) return failed(GOOGLE_PROBLEMS.notFound);
  if (res.status >= 500) return failed("Google couldn't answer right now. Try again later.");
  if (res.status === 403) return failed(`Google refused this${message ? `: ${message}` : ""}.`);
  return failed(`Google didn't accept this${message ? `: ${message}` : ` (HTTP ${res.status})`}.`);
}

/**
 * Whether Google's answer is the Docs or Sheets API's own "no" for a file: 403 PERMISSION_DENIED and
 * nothing more (Drive names a reason; an API the project hasn't turned on, or a missing scope, comes
 * with details, and stays in Google's own words). For a read it means the user can't open the file
 * any more; for a write, also that they may only view it.
 */
function deniedFile(res: SafeResponse): boolean {
  const error = field(parse(res), "error");
  return res.status === 403 && field(error, "status") === "PERMISSION_DENIED" && field(error, "errors") === undefined && field(error, "details") === undefined;
}

/** What a failed write to a picked file means: Google's "no" for the file said plainly (deniedFile), or as problemOf says. */
const writeProblem = (res: SafeResponse): ToolOutput | null => (deniedFile(res) ? failed(GOOGLE_PROBLEMS.noEdit) : problemOf(res));

/**
 * A connected Google account, as connections.ts calls any connector: listTools and callTool, like an
 * MCP client's, so pins, the per-account limit, approvals, renewal and scrubbing work the same way.
 * It holds the user's access token for one reply or one approved action, and finds files only among
 * the connection's picked ones, read from the database at each call (so a file forgotten meanwhile
 * can't be used).
 */
export class GoogleClient {
  readonly protocol = "";
  private readonly token: string;
  private readonly connectionId: string;
  // Whose connection it is: the Flash user, and the Google account (its sub) the token is for.
  private readonly owner: { userId: string; accountId: string };
  private readonly signal?: AbortSignal;
  // When the call being made must be done: every request of one call shares one call's time.
  private deadline = 0;

  constructor(token: string, connectionId: string, owner: { userId: string; accountId: string }, signal?: AbortSignal) {
    this.token = token;
    this.connectionId = connectionId;
    this.owner = owner;
    this.signal = signal;
  }

  /** Flash's own tools: always the same list, so it costs no request. */
  async listTools(): Promise<McpTool[]> {
    return GOOGLE_TOOLS.map((t) => ({ ...t, inputSchema: structuredClone(t.inputSchema), annotations: { ...t.annotations } }));
  }

  async close(): Promise<void> {}

  /** One request to Google with the user's token, within what is left of the call's time; a write never redirected. */
  private async api(
    url: string,
    { method = "GET", body, accept = ["json"], raw, truncate, maxBytes = RESULT_BYTES }: { method?: "GET" | "POST"; body?: unknown; accept?: SafeRequest["accept"]; raw?: boolean; truncate?: boolean; maxBytes?: number } = {},
  ): Promise<SafeResponse> {
    const left = (this.deadline || Date.now() + CALL_TIMEOUT_MS) - Date.now();
    if (left < 500) throw new McpError("timeout", "Google took too long to answer.");
    try {
      return await safeFetch(url, {
        method,
        headers: { authorization: `Bearer ${this.token}`, accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        accept,
        maxBytes,
        raw,
        truncate,
        timeoutMs: left,
        signal: this.signal,
        ...(method !== "GET" && { followRedirects: false as const }),
      });
    } catch (err) {
      if (this.signal?.aborted || !(err instanceof SafeFetchError)) throw err;
      if (err.code === "timeout") throw new McpError("timeout", "Google took too long to answer.");
      if (err.code === "too_large") throw new McpError("too_large", "Google's answer was too large.");
      throw new McpError("unreachable", "Google couldn't be reached.");
    }
  }

  /**
   * What Google says a file is (files.get with the user's token), to record a pick: its id, name and
   * type, or null when Google doesn't let Flash open it (a file the Picker didn't give Flash), it is in
   * the trash, or it isn't a type Flash reads. A refused token is thrown (renewed once by the caller).
   */
  async describe(fileId: string): Promise<{ id: string; name: string; mime: string } | null> {
    if (!FILE_ID.test(fileId)) return null;
    this.deadline = Date.now() + CALL_TIMEOUT_MS;
    const res = await this.api(`${googleHost("www")}/drive/v3/files/${fileId}?fields=id,name,mimeType,trashed&supportsAllDrives=true`, { maxBytes: 64 * 1024 });
    if (res.status === 401) throw new McpError("auth", "Google didn't accept the sign-in.", { status: 401 });
    if (res.status !== 200) return null;
    const body = parse(res);
    const id = field(body, "id");
    const mime = String(field(body, "mimeType") ?? "");
    if (id !== fileId || field(body, "trashed") === true || !DRIVE_TYPES[mime]) return null;
    return { id: fileId, name: cleanName(field(body, "name")) || fileId, mime };
  }

  async callTool(tool: Pick<McpTool, "name">, args: Record<string, unknown>): Promise<ToolOutput> {
    this.deadline = Date.now() + CALL_TIMEOUT_MS;
    // A field the tool doesn't have is refused, never dropped, so what is sent is exactly what the card
    // showed. Every schema says additionalProperties: false (a slide's too), so inputProblem
    // (engines/connect.ts) refuses these, in the same words, before Claude's call runs or a card is
    // made; this is the backstop, as GitHub's is. A slide's own fields are checked in createSlides.
    const fields = FIELDS.get(tool.name);
    const extra = fields && Object.keys(args).find((key) => !fields.includes(key));
    if (extra !== undefined) return unusable(`${extra.slice(0, 60)} isn't a field of this tool`);
    switch (tool.name) {
      case "list_files":
        return this.listFiles();
      case "read_file":
        return this.readFile(args);
      case "create_doc":
        return this.createDoc(args);
      case "create_sheet":
        return this.createSheet(args);
      case "create_slides":
        return this.createSlides(args);
      case "append_rows":
        return this.appendRows(args);
      case "append_text":
        return this.appendText(args);
      default:
        return failed("Flash has no such Google Drive tool.");
    }
  }

  private async listFiles(): Promise<ToolOutput> {
    const files = await pickedFiles(this.connectionId);
    if (!files.length) {
      return { text: "The user hasn't picked any files for Flash yet. They can add some with Add from Drive in Settings > Connectors.", isError: false };
    }
    const lines = files.map((f) => `- "${f.name}" (${KIND_NAMES[DRIVE_TYPES[f.mime] ?? "text"]}), id ${f.file_id}`);
    return { text: `The files the user picked for Flash, and the ones Flash made for them (use the id with read_file, append_rows or append_text):\n${lines.join("\n")}`, isError: false };
  }

  /** A picked file of this connection, or the reason it can't be used. */
  private async picked(value: unknown): Promise<PickedFile | ToolOutput> {
    if (typeof value !== "string" || !FILE_ID.test(value)) return unusable("file_id must be the id of a file from list_files");
    return (await pickedFile(this.connectionId, value)) ?? failed(GOOGLE_PROBLEMS.notPicked);
  }

  private async readFile(args: Record<string, unknown>): Promise<ToolOutput> {
    const file = await this.picked(args.file_id);
    if ("isError" in file) return file;
    const kind = DRIVE_TYPES[file.mime];
    if (args.sheet !== undefined && args.sheet !== "" && kind !== "sheet") return unusable("sheet is only for a Google Sheet");
    const id = file.file_id;
    const name = `"${file.name}"`;
    const startOnly = "\n\n[Only the start of this file was read.]";
    if (kind === "doc" || kind === "slides") {
      const res = await this.api(`${googleHost("www")}/drive/v3/files/${id}/export?mimeType=text%2Fplain`, { accept: ["text"], truncate: true, maxBytes: TEXT_BYTES });
      const problem = problemOf(res);
      if (problem) return problem;
      return { text: `${KIND_NAMES[kind]} ${name}:\n\n${res.body.replace(/^\ufeff/, "").slice(0, READ_CHARS)}${res.truncated ? startOnly : ""}`, isError: false };
    }
    if (kind === "sheet") return this.readSheet(file, args.sheet);
    if (kind === "text") {
      const res = await this.api(`${googleHost("www")}/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { accept: ["text"], truncate: true, maxBytes: TEXT_BYTES });
      const problem = problemOf(res);
      if (problem) return problem;
      return { text: `Text file ${name}:\n\n${res.body.replace(/^\ufeff/, "").slice(0, READ_CHARS)}${res.truncated ? startOnly : ""}`, isError: false };
    }
    if (kind === "pdf") {
      let res: SafeResponse;
      try {
        res = await this.api(`${googleHost("www")}/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { accept: ["pdf"], raw: true, maxBytes: PDF_BYTES });
      } catch (err) {
        if (err instanceof McpError && err.code === "too_large") return failed("This PDF is larger than the 10 MB Flash reads.");
        throw err;
      }
      const problem = problemOf(res);
      if (problem) return problem;
      let pdf: Awaited<ReturnType<typeof pdfTextOnServer>>;
      try {
        // One PDF at a time for each user, so one account can't hold every reader.
        pdf = await pdfTextOnServer(new Uint8Array(Buffer.from(res.body, "latin1")), { maxChars: READ_CHARS, deadline: this.deadline - 500, user: this.owner.userId });
      } catch (err) {
        // The server was busy or low on memory: nothing is wrong with the file, so it isn't blamed.
        if (err instanceof PdfNotNow) return failed(err.why === "busy" ? GOOGLE_PROBLEMS.pdfBusy : GOOGLE_PROBLEMS.pdfLater);
        return failed("Flash couldn't read this PDF.");
      }
      if (!pdf.text.replace(/--- Page \d+ ---/g, "").trim()) return failed("This PDF has no text Flash can read: it may be scanned pages.");
      const pages = `${pdf.pages} page${pdf.pages === 1 ? "" : "s"}${pdf.read < pdf.pages ? `, the first ${pdf.read} read` : ""}`;
      const cutOff = pdf.stopped ? `\n\n[Reading stopped at its time limit after page ${pdf.read}: the rest of this PDF wasn't read.]` : "";
      return { text: `PDF ${name} (${pages}):\n\n${pdf.text.slice(0, READ_CHARS)}${cutOff}`, isError: false };
    }
    return failed("Flash can't read this type of file.");
  }

  /** A Sheet as CSV: its first sheet through Drive's export, or a named one through the Sheets API; with the names of its sheets. */
  private async readSheet(file: PickedFile, sheetArg: unknown): Promise<ToolOutput> {
    let sheet = "";
    if (sheetArg !== undefined && sheetArg !== "") {
      const checked = sheetOf(sheetArg);
      if (!checked) return unusable("sheet must be a sheet's name");
      sheet = checked;
    }
    const id = file.file_id;
    const info = await this.api(`${googleHost("sheets")}/v4/spreadsheets/${id}?fields=sheets.properties(title,index)`, { maxBytes: 256 * 1024 });
    // The Sheets API says a file the user can't open any more only this way (Drive says notFound).
    const infoProblem = deniedFile(info) ? failed(GOOGLE_PROBLEMS.notFound) : problemOf(info);
    if (infoProblem) return infoProblem;
    const listed = field(parse(info), "sheets");
    const names = (Array.isArray(listed) ? listed : [])
      .map((s) => ({ title: String(field(field(s, "properties"), "title") ?? ""), index: Number(field(field(s, "properties"), "index") ?? 0) }))
      .sort((a, b) => a.index - b.index)
      .map((s) => s.title);
    const every = names.map((n) => oneLine(n, 100)).join(", ");
    if (sheet && !names.includes(sheet)) return failed(`This spreadsheet has no sheet named "${oneLine(sheet, 100)}". Its sheets: ${every}.`);
    const head = (which: string) => `Google Sheet "${file.name}", sheet "${oneLine(which, 100)}", as CSV. Its sheets: ${every}.\n\n`;
    if (!sheet) {
      const res = await this.api(`${googleHost("www")}/drive/v3/files/${id}/export?mimeType=text%2Fcsv`, { accept: ["text"], truncate: true, maxBytes: TEXT_BYTES });
      const problem = problemOf(res);
      if (problem) return problem;
      return { text: `${head(names[0] ?? "")}${res.body.replace(/^\ufeff/, "").slice(0, READ_CHARS)}${res.truncated ? "\n\n[Only the start of this sheet was read.]" : ""}`, isError: false };
    }
    const res = await this.api(`${googleHost("sheets")}/v4/spreadsheets/${id}/values/${encodeURIComponent(`${quoted(sheet)}!1:${SHEET_ROWS}`)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`);
    const problem = deniedFile(res) ? failed(GOOGLE_PROBLEMS.notFound) : problemOf(res);
    if (problem) return problem;
    const values = field(parse(res), "values");
    const rows = Array.isArray(values) ? values : [];
    const csv = rows.map((r) => (Array.isArray(r) ? r.map(csvCell).join(",") : "")).join("\n");
    return { text: `${head(sheet)}${csv.slice(0, READ_CHARS)}${rows.length >= SHEET_ROWS ? `\n\n[Only the first ${SHEET_ROWS} rows were read.]` : ""}`, isError: false };
  }

  /**
   * The second request of a write (the content of a file just made): its failure, or Google refusing
   * the token by then, is said plainly with the file's address; nothing is tried again.
   */
  private async content(made: string, request: () => Promise<SafeResponse>): Promise<ToolOutput | null> {
    try {
      const problem = problemOf(await request());
      return problem && failed(`${made}, but its content couldn't be added: ${problem.text}`);
    } catch (err) {
      if (this.signal?.aborted || !(err instanceof McpError)) throw err;
      return failed(`${made}, but its content couldn't be added: ${err.message}`);
    }
  }

  private async createDoc(args: Record<string, unknown>): Promise<ToolOutput> {
    const title = titleOf(args.title);
    if (!title) return unusable(`title must be 1 to ${MAX_TITLE} characters on one line`);
    if (typeof args.text !== "string") return unusable("text must be text");
    const text = args.text;
    const res = await this.api(`${googleHost("docs")}/v1/documents`, { method: "POST", body: { title } });
    const problem = problemOf(res);
    if (problem) return problem;
    const id = String(field(parse(res), "documentId") ?? "");
    if (!FILE_ID.test(id)) return failed("Google's answer couldn't be read.");
    await this.keepMade(id, title, "application/vnd.google-apps.document");
    const made = `Created the Google Doc "${title}" (id ${id}): ${fileUrl("document", id)}`;
    if (text) {
      const later = await this.content(made, () => this.api(`${googleHost("docs")}/v1/documents/${id}:batchUpdate`, { method: "POST", body: { requests: [{ insertText: { location: { index: 1 }, text } }] } }));
      if (later) return later;
    }
    return { text: made, isError: false };
  }

  /** Rows added to a sheet as plain values (RAW: a cell like =IMPORTXML(…) stays text and never runs as a formula), as new rows after its table. */
  private appendRequest(id: string, rows: Cell[][], sheet = "") {
    const range = sheet ? `${quoted(sheet)}!A1` : "A1";
    return this.api(`${googleHost("sheets")}/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: "POST",
      body: { range, majorDimension: "ROWS", values: rows },
    });
  }

  private async createSheet(args: Record<string, unknown>): Promise<ToolOutput> {
    const title = titleOf(args.title);
    if (!title) return unusable(`title must be 1 to ${MAX_TITLE} characters on one line`);
    const rows = rowsOf(args.rows);
    if (!rows) return unusable(`rows must be 1 to ${MAX_ROWS} lists of text or numbers`);
    const res = await this.api(`${googleHost("sheets")}/v4/spreadsheets`, { method: "POST", body: { properties: { title } } });
    const problem = problemOf(res);
    if (problem) return problem;
    const id = String(field(parse(res), "spreadsheetId") ?? "");
    if (!FILE_ID.test(id)) return failed("Google's answer couldn't be read.");
    await this.keepMade(id, title, "application/vnd.google-apps.spreadsheet");
    const made = `Created the Google Sheet "${title}" (id ${id}) with ${rows.length} row${rows.length === 1 ? "" : "s"}: ${fileUrl("spreadsheets", id)}`;
    return (await this.content(made, () => this.appendRequest(id, rows))) ?? { text: made, isError: false };
  }

  private async createSlides(args: Record<string, unknown>): Promise<ToolOutput> {
    const title = titleOf(args.title);
    if (!title) return unusable(`title must be 1 to ${MAX_TITLE} characters on one line`);
    const slides = args.slides;
    if (
      !Array.isArray(slides) ||
      !slides.length ||
      slides.length > MAX_SLIDES ||
      slides.some((s) => !s || typeof s !== "object" || typeof field(s, "title") !== "string" || typeof field(s, "body") !== "string" || String(field(s, "body")).length > MAX_CELL)
    ) {
      return unusable(`slides must be 1 to ${MAX_SLIDES} items, each with a title and a body`);
    }
    if (slides.some((s) => Object.keys(s as object).some((key) => key !== "title" && key !== "body"))) return unusable("a slide has only a title and a body");
    const res = await this.api(`${googleHost("slides")}/v1/presentations`, { method: "POST", body: { title } });
    const problem = problemOf(res);
    if (problem) return problem;
    const created = parse(res);
    const id = String(field(created, "presentationId") ?? "");
    if (!FILE_ID.test(id)) return failed("Google's answer couldn't be read.");
    // A new deck may start with a slide of its own: Flash's slides are added, then that one goes.
    const start = field(created, "slides");
    const first = (Array.isArray(start) ? start : []).map((s) => String(field(s, "objectId") ?? "")).filter((o) => /^[\w:-]{1,100}$/.test(o));
    const requests: unknown[] = [];
    slides.forEach((s, i) => {
      const slide = `flash_slide_${i + 1}`;
      const heading = `${slide}_title`;
      const text = `${slide}_body`;
      requests.push({
        createSlide: {
          objectId: slide,
          insertionIndex: i,
          slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
          placeholderIdMappings: [
            { layoutPlaceholder: { type: "TITLE", index: 0 }, objectId: heading },
            { layoutPlaceholder: { type: "BODY", index: 0 }, objectId: text },
          ],
        },
      });
      const words = { title: String(field(s, "title")), body: String(field(s, "body")) };
      if (words.title) requests.push({ insertText: { objectId: heading, insertionIndex: 0, text: words.title } });
      if (words.body) requests.push({ insertText: { objectId: text, insertionIndex: 0, text: words.body } });
    });
    for (const objectId of first) requests.push({ deleteObject: { objectId } });
    await this.keepMade(id, title, "application/vnd.google-apps.presentation");
    const made = `Created the Google Slides deck "${title}" (id ${id}) with ${slides.length} slide${slides.length === 1 ? "" : "s"}: ${fileUrl("presentation", id)}`;
    return (await this.content(made, () => this.api(`${googleHost("slides")}/v1/presentations/${id}:batchUpdate`, { method: "POST", body: { requests } }))) ?? { text: made, isError: false };
  }

  /**
   * A file Flash just made, kept with the picked ones (drive.file lets Flash open the files it makes),
   * so a later reply can read it or add to it: while the connection is still this user's and this
   * Google account's, and has room. The file is made either way.
   */
  private async keepMade(id: string, title: string, mime: string): Promise<void> {
    try {
      await run(
        `INSERT OR IGNORE INTO connection_files (connection_id, file_id, name, mime, picked_at)
         SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM connections WHERE id = ? AND user_id = ? AND account_id = ?)
           AND (SELECT COUNT(*) FROM connection_files WHERE connection_id = ?) < ?`,
        [this.connectionId, id, cleanName(title) || id, mime, now(), this.connectionId, this.owner.userId, this.owner.accountId, this.connectionId, MAX_FILES],
      );
    } catch {
      console.error("[flash] keeping a file Flash made failed");
    }
  }

  /** Text added at the end of a picked (or made) Doc's body, as plain text. */
  private async appendText(args: Record<string, unknown>): Promise<ToolOutput> {
    const file = await this.picked(args.file_id);
    if ("isError" in file) return file;
    if (DRIVE_TYPES[file.mime] !== "doc") return unusable("file_id must be a Google Doc");
    if (typeof args.text !== "string" || !args.text) return unusable("text must be text");
    const text = args.text;
    const res = await this.api(`${googleHost("docs")}/v1/documents/${file.file_id}:batchUpdate`, {
      method: "POST",
      body: { requests: [{ insertText: { endOfSegmentLocation: {}, text } }] },
    });
    const problem = writeProblem(res);
    if (problem) return problem;
    return { text: `Added ${text.length.toLocaleString("en-US")} characters at the end of "${file.name}": ${fileUrl("document", file.file_id)}`, isError: false };
  }

  private async appendRows(args: Record<string, unknown>): Promise<ToolOutput> {
    const file = await this.picked(args.file_id);
    if ("isError" in file) return file;
    if (DRIVE_TYPES[file.mime] !== "sheet") return unusable("file_id must be a Google Sheet");
    let sheet = "";
    if (args.sheet !== undefined && args.sheet !== "") {
      const checked = sheetOf(args.sheet);
      if (!checked) return unusable("sheet must be a sheet's name");
      sheet = checked;
    }
    const rows = rowsOf(args.rows);
    if (!rows) return unusable(`rows must be 1 to ${MAX_ROWS} lists of text or numbers`);
    const res = await this.appendRequest(file.file_id, rows, sheet);
    const problem = writeProblem(res);
    if (problem) return problem;
    const where = oneLine(field(field(parse(res), "updates"), "updatedRange"), 200);
    return { text: `Added ${rows.length} row${rows.length === 1 ? "" : "s"} to "${file.name}"${where ? ` (${where})` : ""}: ${fileUrl("spreadsheets", file.file_id)}`, isError: false };
  }
}
