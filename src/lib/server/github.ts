import { db, now, all, run } from "./db.ts";
import { randomId, sha256 } from "./ids.ts";
import { pkceChallenge } from "./oauth.ts";
import { FLOW_TTL_MS, OAuthError, flowPlace, type FlowRow, type Tokens } from "./mcp-oauth.ts";
import { CALL_TIMEOUT_MS, McpError, toolHash, type McpTool, type ToolOutput } from "./mcp-client.ts";
import { RESULT_BYTES, SafeFetchError, mockOrigin, safeFetch, type SafeResponse } from "./safe-fetch.ts";
import { connectorsReady, seal } from "./secret-box.ts";
import { msg } from "../i18n.ts";

/*
 * GitHub in chat (the connectors plan, PR 3), through Flash's own GitHub App and seven of Flash's own
 * tools over GitHub's REST API: list repositories, read a file, search code, list issues and pull
 * requests, read a pull request (reads, which run by themselves), and create an issue or open a pull
 * request from a branch that exists (writes, which wait for the user's Approve like every write).
 *
 * Connect starts with GitHub's authorize step (state and PKCE). When the user's token sees no
 * installation of the app yet, the browser goes on to the app's installation page, where the user
 * picks the repositories; the app asks for the user's authorization during installation, so GitHub
 * sends the browser back to the callback, and the authorize step runs once more (GitHub answers it at
 * once). Starting with the authorize step means someone who already has the app installed (they
 * removed Flash's access, or an organization of theirs installed it) is never stuck on GitHub's page
 * for changing an installation, which doesn't send anyone back. The app's user tokens expire
 * (8 hours, refresh tokens 6 months, renewed one at a time as connections.ts does for every sign-in).
 * A token reaches only what both the user and the app can reach.
 *
 * The callback (src/app/api/connect/github/callback) trusts nothing in its address:
 * - a code is traded for tokens only when it comes back with the state of a flow this signed-in user
 *   started at the authorize step, with PKCE (taken once, see takeGithubFlow);
 * - GitHub's redirect after an installation carries a code but not Flash's state, so that code is
 *   never traded. If the user was just sent to the installation page (a live install flow of theirs),
 *   the authorize step starts again, with a new state and PKCE. Anyone else's link redeems nothing;
 * - the installation_id in that redirect is only a hint: once Flash has the user's token, it lists the
 *   installations that token can see (GET /user/installations), refuses a hint that isn't one of them,
 *   and keeps only ids from that list.
 *
 * Tokens are sealed (secret-box.ts) on the connection and in nothing else; they are never logged, put
 * in an address or returned by an API, and are taken out of every result (see scrub in
 * connections.ts). The app's client secret is read from the environment and sent only to GitHub's
 * token endpoint and its revocation API. Every request goes through safeFetch: GitHub's two fixed
 * hosts (or, in development only, the stand-in at FLASH_CONNECT_MOCK), with time and size limits.
 * Nothing here calls a model or moves credits.
 */

const env = (name: string) => process.env[name]?.trim() ?? "";

/** The environment variables the GitHub App needs: until all three are set, GitHub is hidden everywhere. */
export const GITHUB_KEYS = ["GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_SLUG"] as const;

/** Whether users can connect GitHub: connectors are set up (CONNECTOR_KEYS) and so is the GitHub App. */
export const githubReady = () => connectorsReady() && GITHUB_KEYS.every((name) => Boolean(env(name)));

export const GITHUB_API = "https://api.github.com";
export const GITHUB_ISSUER = "https://github.com";
/** GitHub's API and its web pages (sign-in, installation, tokens); the dev stand-in's when FLASH_CONNECT_MOCK is on. */
export const githubApi = () => (mockOrigin() ? `${mockOrigin()}/github/api` : GITHUB_API);
export const githubWeb = () => (mockOrigin() ? `${mockOrigin()}/github/web` : GITHUB_ISSUER);
/** Where GitHub sends the browser back: the GitHub App's callback URL. */
export const githubCallbackUrl = (origin: string) => `${origin}/api/connect/github/callback`;

const API_VERSION = "2022-11-28";
const USER_AGENT = "FlashAI/1.0 (+https://www.flash-app.dev)";
const TOKEN_MS = 10_000;
const REVOKE_MS = 5000;
const TOKEN_MAX = 64 * 1024;
const TOKEN_CHARS = /^[\x21-\x7e]{1,8192}$/;
const INSTALLATION_ID = /^\d{1,20}$/;
// The most installations a connection keeps, and lists repositories from.
const MAX_INSTALLATIONS = 10;
const LISTED_INSTALLATIONS = 5;

// ---------------------------------------------------------------------------------------------
// Connecting: the flows, the tokens and the installations

/**
 * Which step a GitHub flow is: installing the app, or the authorize step with PKCE. An authorize step
 * that follows an installation keeps the installation it named (a hint, checked against GitHub's list)
 * and doesn't send the browser to the installation page again.
 */
export type GithubStep = { step: "install" | "authorize"; installation: string; afterInstall: boolean };

/** A GitHub flow's step, kept in its endpoints_json (a GitHub flow has no endpoints of its own to keep). */
export function githubStep(flow: Pick<FlowRow, "provider" | "endpoints_json">): GithubStep | null {
  if (flow.provider !== "github") return null;
  try {
    const value = JSON.parse(flow.endpoints_json) as { github?: unknown; installation?: unknown; after?: unknown };
    if (value.github !== "install" && value.github !== "authorize") return null;
    const installation = typeof value.installation === "string" && INSTALLATION_ID.test(value.installation) ? value.installation : "";
    return { step: value.github, installation, afterInstall: value.after === "install" };
  } catch {
    return null;
  }
}

/** An installation id as GitHub writes it, or "" for anything else. */
export const installationHint = (value: string | null | undefined) => (value && INSTALLATION_ID.test(value) ? value : "");

/**
 * Starts a GitHub flow (10 minutes, single use, bound to the user) and returns the page to send the
 * browser to: the app's installation page, or GitHub's authorize page with state and PKCE (S256).
 */
export async function beginGithubFlow(userId: string, origin: string, { step, installation = "", afterInstall = false }: Partial<GithubStep> & Pick<GithubStep, "step">): Promise<string> {
  const state = randomId(24);
  const verifier = randomId(48);
  const stateHash = sha256(state);
  const redirectUri = githubCallbackUrl(origin);
  const at = now();
  await (await db()).batch(
    [
      // Old flows go whenever a new one starts (Flash has no scheduled jobs).
      { sql: "DELETE FROM connect_flows WHERE expires_at < ?", args: [at] },
      {
        sql: `INSERT INTO connect_flows (state_hash, user_id, enc_verifier, provider, connection_id, label, enc_url, issuer, resource, client_reg_id, scopes, redirect_uri, endpoints_json, created_at, expires_at)
              VALUES (?, ?, ?, 'github', '', 'GitHub', '', ?, '', '', '', ?, ?, ?, ?)`,
        args: [
          stateHash,
          userId,
          seal(verifier, flowPlace(stateHash, userId, "verifier")).stored,
          GITHUB_ISSUER,
          redirectUri,
          JSON.stringify({ github: step, installation: installationHint(installation), ...(afterInstall && { after: "install" }) }),
          at,
          at + FLOW_TTL_MS,
        ],
      },
    ],
    "write",
  );
  if (step === "install") {
    const page = new URL(`${githubWeb()}/apps/${encodeURIComponent(env("GITHUB_APP_SLUG"))}/installations/new`);
    page.searchParams.set("state", state);
    return page.href;
  }
  const page = new URL(`${githubWeb()}/login/oauth/authorize`);
  page.searchParams.set("client_id", env("GITHUB_APP_CLIENT_ID"));
  page.searchParams.set("redirect_uri", redirectUri);
  page.searchParams.set("state", state);
  page.searchParams.set("code_challenge", pkceChallenge(verifier));
  page.searchParams.set("code_challenge_method", "S256");
  return page.href;
}

/** Takes the user's own GitHub flow for a state, once, before it expires (see takeFlow for the other services). */
export async function takeGithubFlow(userId: string, state: string): Promise<FlowRow | null> {
  if (!state || state.length > 200) return null;
  const taken = await run("DELETE FROM connect_flows WHERE state_hash = ? AND user_id = ? AND provider = 'github' AND expires_at > ? RETURNING *", [sha256(state), userId, now()]);
  return (taken.rows[0] as unknown as FlowRow) ?? null;
}

/**
 * Takes the user's newest live install flow, once: what GitHub's redirect after an installation
 * answers to, since it doesn't carry Flash's state. Null unless Flash has just sent this user to the
 * installation page.
 */
export async function takeInstallFlow(userId: string): Promise<FlowRow | null> {
  const live = await all<FlowRow>("SELECT * FROM connect_flows WHERE user_id = ? AND provider = 'github' AND expires_at > ? ORDER BY created_at DESC", [userId, now()]);
  const newest = live.find((f) => githubStep(f)?.step === "install");
  if (!newest) return null;
  const taken = await run("DELETE FROM connect_flows WHERE state_hash = ? AND user_id = ? AND expires_at > ? RETURNING *", [newest.state_hash, userId, now()]);
  return (taken.rows[0] as unknown as FlowRow) ?? null;
}

/**
 * GitHub's token endpoint's answer: tokens, or an OAuthError ("invalid_grant" for a code or refresh
 * token it refuses). GitHub answers most errors with 200 and an `error` field. Its own words are never kept.
 */
function readTokens(res: SafeResponse): Tokens {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(res.body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: refused below.
  }
  const error = typeof body.error === "string" ? body.error : "";
  if (error === "bad_refresh_token" || error === "bad_verification_code") throw new OAuthError("invalid_grant");
  if (res.status >= 500) throw new OAuthError("unreachable");
  if (error || res.status !== 200) throw new OAuthError("token");
  const access = body.access_token;
  if (typeof access !== "string" || !TOKEN_CHARS.test(access)) throw new OAuthError("token");
  if (body.token_type !== undefined && String(body.token_type).toLowerCase() !== "bearer") throw new OAuthError("token");
  const refresh = typeof body.refresh_token === "string" && TOKEN_CHARS.test(body.refresh_token) ? body.refresh_token : "";
  const seconds = Number(body.expires_in);
  return { access, refresh, expiresAt: Number.isFinite(seconds) && seconds > 0 ? now() + Math.min(seconds, 400 * 24 * 3600) * 1000 : 0, scope: "" };
}

/** A form to GitHub's token endpoint, with the app's client ID and secret. Never follows a redirect: the form holds a secret. */
async function tokenRequest(form: Record<string, string>): Promise<Tokens> {
  let res: SafeResponse;
  try {
    res = await safeFetch(`${githubWeb()}/login/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": USER_AGENT },
      body: new URLSearchParams({ client_id: env("GITHUB_APP_CLIENT_ID"), client_secret: env("GITHUB_APP_CLIENT_SECRET"), ...form }).toString(),
      accept: ["json"],
      maxBytes: TOKEN_MAX,
      timeoutMs: TOKEN_MS,
      followRedirects: false,
    });
  } catch {
    throw new OAuthError("unreachable", "GitHub couldn't be reached.");
  }
  return readTokens(res);
}

/** Trades the authorize step's code for the user's tokens, with the flow's PKCE verifier. */
export const exchangeGithubCode = (code: string, verifier: string, redirectUri: string) => {
  if (!code || code.length > 512 || !TOKEN_CHARS.test(code)) throw new OAuthError("token");
  return tokenRequest({ code, redirect_uri: redirectUri, code_verifier: verifier });
};

/** New tokens for a refresh token (GitHub retires the old refresh and access tokens at once; connections.ts runs one at a time). */
export const refreshGithubToken = (refresh: string) => tokenRequest({ grant_type: "refresh_token", refresh_token: refresh });

/** A request to GitHub's OAuth-app API, with the app's client ID and secret (basic auth) and a user's token in the body. */
async function appRequest(path: "grant" | "token", access: string): Promise<boolean> {
  if (!access) return false;
  const basic = Buffer.from(`${env("GITHUB_APP_CLIENT_ID")}:${env("GITHUB_APP_CLIENT_SECRET")}`).toString("base64");
  try {
    const res = await safeFetch(`${githubApi()}/applications/${encodeURIComponent(env("GITHUB_APP_CLIENT_ID"))}/${path}`, {
      method: "DELETE",
      headers: {
        authorization: `Basic ${basic}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": API_VERSION,
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({ access_token: access }),
      accept: ["json"],
      maxBytes: TOKEN_MAX,
      timeoutMs: REVOKE_MS,
      followRedirects: false,
    });
    return res.status === 204;
  } catch {
    return false;
  }
}

/** Removing GitHub: cancels the user's whole authorization of the app (every token it gave). Never throws. */
export const revokeGithubGrant = (access: string) => appRequest("grant", access);
/** Gives back one token Flash won't keep (a sign-in that failed, or a renewal a Reconnect overtook). Never throws. */
export const dropGithubToken = (access: string) => appRequest("token", access);

/**
 * The ids of the app's installations a user token can see (GET /user/installations): the only ones
 * Flash keeps, whatever an address said. Throws OAuthError when GitHub doesn't answer with the list.
 */
export async function githubInstallations(access: string): Promise<string[]> {
  let res: SafeResponse;
  try {
    res = await safeFetch(`${githubApi()}/user/installations?per_page=100`, {
      headers: { authorization: `Bearer ${access}`, accept: "application/vnd.github+json", "x-github-api-version": API_VERSION, "user-agent": USER_AGENT },
      accept: ["json"],
      maxBytes: RESULT_BYTES,
      timeoutMs: TOKEN_MS,
    });
  } catch {
    throw new OAuthError("unreachable", "GitHub couldn't be reached.");
  }
  if (res.status !== 200) throw new OAuthError("token");
  const body = parse(res) as { installations?: unknown } | null;
  if (!body || !Array.isArray(body.installations)) throw new OAuthError("token");
  const ids = body.installations
    .map((i) => (i && typeof i === "object" ? String((i as { id?: unknown }).id ?? "") : ""))
    .filter((id) => INSTALLATION_ID.test(id));
  return [...new Set(ids)].slice(0, MAX_INSTALLATIONS);
}

/** The installations a connection keeps (in its resource column, as ids checked at sign-in). */
export const installationsOf = (resource: string) => resource.split(/\s+/).filter((id) => INSTALLATION_ID.test(id)).slice(0, MAX_INSTALLATIONS);

// ---------------------------------------------------------------------------------------------
// The tools

/**
 * Why a call failed, in Flash's words, shown on an approved action's card in the user's language (see
 * failedText in connections.ts). Claude gets them in English.
 */
export const GITHUB_PROBLEMS = {
  rate: msg("GitHub's rate limit for this account was reached, so Flash didn't try again. Wait a few minutes, then ask again."),
  notFound: msg("GitHub didn't find that. The repository, branch, file or number may be wrong, or the Flash AI app isn't installed on that repository."),
  refused: msg("GitHub refused this. The Flash AI app may not have access to that repository: add it on GitHub, under Settings > Applications."),
};

const REPO = { type: "string", description: "The repository, as owner/name (for example octocat/hello-world)." };

type Definition = { name: string; title: string; description: string; inputSchema: Record<string, unknown>; read: boolean };

/** The tools, as Claude and Settings get them. Titles and descriptions are Flash's own, so the page shows them translated. */
const DEFINITIONS: Definition[] = [
  {
    name: "list_repos",
    title: msg("List repositories"),
    description: msg("Lists the GitHub repositories the user gave Flash access to, with their default branch."),
    inputSchema: { type: "object", properties: {} },
    read: true,
  },
  {
    name: "read_file",
    title: msg("Read a file"),
    description: msg("Reads a file in a repository, or lists a folder. Leave path empty for the top folder."),
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO,
        path: { type: "string", description: "The file or folder, like src/index.ts." },
        ref: { type: "string", description: "A branch, tag or commit. Leave it out for the default branch." },
      },
      required: ["repo", "path"],
    },
    read: true,
  },
  {
    name: "search_code",
    title: msg("Search code"),
    description: msg("Searches code on the default branch, in one repository or in all the user can reach."),
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for (GitHub code search; at least one word, not only qualifiers)." },
        repo: { ...REPO, description: "Only this repository, as owner/name. Leave it out to search everywhere the user can reach." },
      },
      required: ["query"],
    },
    read: true,
  },
  {
    name: "list_issues",
    title: msg("List issues and pull requests"),
    description: msg("Lists a repository's 30 most recently updated issues and pull requests."),
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO,
        state: { type: "string", enum: ["open", "closed", "all"], description: "Which ones: open (the default), closed or all." },
        kind: { type: "string", enum: ["all", "issues", "pull_requests"], description: "Issues, pull requests or both (the default)." },
      },
      required: ["repo"],
    },
    read: true,
  },
  {
    name: "read_pull_request",
    title: msg("Read a pull request"),
    description: msg("Reads a pull request: its title, branches and description, and the changes in each file."),
    inputSchema: {
      type: "object",
      properties: { repo: REPO, number: { type: "integer", description: "The pull request's number." } },
      required: ["repo", "number"],
    },
    read: true,
  },
  {
    name: "create_issue",
    title: msg("Create an issue"),
    description: msg("Creates an issue in a repository. It waits for the user to approve it."),
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO,
        title: { type: "string", description: "The issue's title." },
        body: { type: "string", description: "The issue's text, in Markdown (empty for none)." },
      },
      required: ["repo", "title", "body"],
    },
    read: false,
  },
  {
    name: "open_pull_request",
    title: msg("Open a pull request"),
    description: msg("Opens a pull request from a branch that already exists. It waits for the user to approve it."),
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO,
        title: { type: "string", description: "The pull request's title." },
        body: { type: "string", description: "Its description, in Markdown (empty for none)." },
        head: { type: "string", description: "The branch with the changes (owner:branch for one in a fork)." },
        base: { type: "string", description: "The branch to merge into, like main." },
      },
      required: ["repo", "title", "body", "head", "base"],
    },
    read: false,
  },
];

/** The tools as a server would list them, pinned by the same hash as any connector's tools. */
export const GITHUB_TOOLS: McpTool[] = DEFINITIONS.map((d) => {
  const annotations = { readOnlyHint: d.read, destructiveHint: false };
  return { name: d.name, title: d.title, description: d.description, inputSchema: d.inputSchema, annotations, hash: toolHash(d.name, d.description, d.inputSchema, { title: d.title, annotations }) };
});

const parse = (res: SafeResponse): unknown => {
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
};

const failed = (text: string): ToolOutput => ({ text, isError: true });
const unusable = (why: string) => failed(`That input wasn't usable: ${why}.`);
/** One line of GitHub's text, cut. */
const oneLine = (value: unknown, max = 200) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const field = (value: unknown, key: string): unknown => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined);

/**
 * A repository as owner/name, checked, or null. Nothing a call sends is tidied up first: what is sent
 * is exactly what the card showed (see pending-actions.ts), so a value that isn't usable as it is fails.
 */
function repoOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(value);
  return m && m[2] !== "." && m[2] !== ".." ? value : null;
}

/** A branch, tag or commit name as git allows one: no spaces, control characters, ~ ^ : ? * [ \ or "..". */
const refOf = (value: unknown) => (typeof value === "string" && /^[^\s\x00-\x1f\x7f~^:?*[\\]{1,250}$/.test(value) && !value.includes("..") ? value : null);
/** A pull request's head: a branch, or owner:branch for a branch in a fork. */
function headOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const fork = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}:(.+)$/.exec(value);
  return refOf(fork ? fork[1] : value) ? value : null;
}

/**
 * What a GitHub answer that isn't a success means for the call: a 401 is a token GitHub refused
 * (thrown, so the sign-in is renewed once and the call sent again); a rate limit, a refusal, a 404
 * or a validation error is the call's own failure, said plainly. Nothing is retried here.
 */
function problemOf(res: SafeResponse): ToolOutput | null {
  if (res.status >= 200 && res.status < 300) return null;
  if (res.status === 401) throw new McpError("auth", "GitHub didn't accept the sign-in.", { status: 401 });
  const body = parse(res);
  const message = oneLine(field(body, "message"), 300);
  const limited =
    (res.status === 403 || res.status === 429) &&
    (String(res.headers["x-ratelimit-remaining"] ?? "") === "0" || res.headers["retry-after"] !== undefined || /rate limit/i.test(message));
  if (limited) return failed(GITHUB_PROBLEMS.rate);
  if (res.status === 403) return failed(GITHUB_PROBLEMS.refused);
  if (res.status === 404) return failed(GITHUB_PROBLEMS.notFound);
  if (res.status >= 300 && res.status < 400) return failed("GitHub says this repository moved. Ask again with its new name.");
  if (res.status >= 500) return failed("GitHub couldn't answer right now. Try again later.");
  const errors = field(body, "errors");
  const details = Array.isArray(errors)
    ? errors
        .slice(0, 3)
        .map((e) => oneLine(field(e, "message") ?? [field(e, "field"), field(e, "code")].filter(Boolean).join(" "), 200))
        .filter(Boolean)
    : [];
  return failed(`GitHub didn't accept this${message || details.length ? `: ${[message, ...details].filter(Boolean).join("; ")}` : ` (HTTP ${res.status})`}.`);
}

/** File text as Claude reads it: decoded, or a note for a binary or too-large file. */
function fileText(item: Record<string, unknown>): string {
  const size = Number(item.size ?? 0);
  if (item.encoding !== "base64" || typeof item.content !== "string" || (!item.content && size > 0)) return `[This file is too large to read here (${size} bytes).]`;
  const bytes = Buffer.from(item.content, "base64");
  if (bytes.subarray(0, 8000).includes(0)) return "[A binary file was left out.]";
  return bytes.toString("utf8");
}

/**
 * A connected GitHub account, as connections.ts calls any connector: listTools and callTool, like an
 * MCP client's, so pins, the per-account limit, approvals, renewal and scrubbing work the same way.
 * It holds the user's access token for one reply or one approved action, and the installations kept
 * at sign-in.
 */
export class GitHubClient {
  readonly protocol = "";
  private readonly token: string;
  private readonly installations: string[];
  private readonly signal?: AbortSignal;
  // When the call being made must be done: every request of one call shares one call's time.
  private deadline = 0;

  constructor(token: string, installations: string[], signal?: AbortSignal) {
    this.token = token;
    this.installations = installations;
    this.signal = signal;
  }

  /** Flash's own tools: always the same list, so it costs no request. */
  async listTools(): Promise<McpTool[]> {
    return GITHUB_TOOLS.map((t) => ({ ...t, inputSchema: structuredClone(t.inputSchema), annotations: { ...t.annotations } }));
  }

  async close(): Promise<void> {}

  /** One request to GitHub's API with the user's token: within what is left of the call's time, at most 2 MB, a write never redirected. */
  private async api(path: string, { method = "GET", body, accept }: { method?: "GET" | "POST"; body?: unknown; accept?: string } = {}): Promise<SafeResponse> {
    const left = (this.deadline || Date.now() + CALL_TIMEOUT_MS) - Date.now();
    if (left < 500) throw new McpError("timeout", "GitHub took too long to answer.");
    try {
      return await safeFetch(`${githubApi()}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: accept ?? "application/vnd.github+json",
          "x-github-api-version": API_VERSION,
          "user-agent": USER_AGENT,
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        accept: ["json"],
        maxBytes: RESULT_BYTES,
        timeoutMs: left,
        signal: this.signal,
        ...(method !== "GET" && { followRedirects: false as const }),
      });
    } catch (err) {
      if (this.signal?.aborted || !(err instanceof SafeFetchError)) throw err;
      if (err.code === "timeout") throw new McpError("timeout", "GitHub took too long to answer.");
      if (err.code === "too_large") throw new McpError("too_large", "GitHub's answer was too large.");
      throw new McpError("unreachable", "GitHub couldn't be reached.");
    }
  }

  async callTool(tool: Pick<McpTool, "name">, args: Record<string, unknown>): Promise<ToolOutput> {
    this.deadline = Date.now() + CALL_TIMEOUT_MS;
    switch (tool.name) {
      case "list_repos":
        return this.listRepos();
      case "read_file":
        return this.readFile(args);
      case "search_code":
        return this.searchCode(args);
      case "list_issues":
        return this.listIssues(args);
      case "read_pull_request":
        return this.readPullRequest(args);
      case "create_issue":
        return this.createIssue(args);
      case "open_pull_request":
        return this.openPullRequest(args);
      default:
        return failed("Flash has no such GitHub tool.");
    }
  }

  private async listRepos(): Promise<ToolOutput> {
    const lines: string[] = [];
    let problem: ToolOutput | null = null;
    for (const id of this.installations.slice(0, LISTED_INSTALLATIONS)) {
      const res = await this.api(`/user/installations/${id}/repositories?per_page=100`);
      problem = problemOf(res);
      if (problem) continue;
      const body = parse(res);
      const repos = field(body, "repositories");
      for (const r of Array.isArray(repos) ? repos : []) {
        const description = oneLine(field(r, "description"), 150);
        lines.push(`${oneLine(field(r, "full_name"), 140)}${field(r, "private") ? " (private)" : ""}, default branch ${oneLine(field(r, "default_branch"), 100)}${description ? `: ${description}` : ""}`);
      }
      const total = Number(field(body, "total_count") ?? 0);
      if (total > (Array.isArray(repos) ? repos.length : 0)) lines.push(`(${total} in all in this installation; the first 100 are listed.)`);
    }
    if (!lines.length) return problem ?? { text: "No repositories: the Flash AI app isn't installed on any repository the user can reach. They can pick some on GitHub, under Settings > Applications.", isError: false };
    return { text: lines.join("\n"), isError: false };
  }

  private async readFile(args: Record<string, unknown>): Promise<ToolOutput> {
    const repo = repoOf(args.repo);
    if (!repo) return unusable("repo must be owner/name");
    const path = typeof args.path === "string" ? args.path.trim().replace(/^\/+|\/+$/g, "") : "";
    const parts = path ? path.split("/") : [];
    if (path.length > 1000 || parts.some((p) => !p || p === "." || p === ".." || /[\x00-\x1f\x7f]/.test(p))) return unusable("path must be a path in the repository");
    const ref = args.ref === undefined || args.ref === "" ? "" : refOf(args.ref);
    if (ref === null) return unusable("ref must be a branch, tag or commit");
    const res = await this.api(`/repos/${repo}/contents${parts.length ? `/${parts.map(encodeURIComponent).join("/")}` : ""}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`);
    const problem = problemOf(res);
    if (problem) return problem;
    const body = parse(res);
    const where = `${repo}/${path}${ref ? ` at ${ref}` : ""}`;
    if (Array.isArray(body)) {
      const entries = body.slice(0, 300).map((e) => `${field(e, "type") === "dir" ? "folder" : oneLine(field(e, "type"), 20)} ${oneLine(field(e, "path"), 300)}`);
      return { text: `Folder ${where} (${body.length} entries${body.length > 300 ? ", the first 300 listed" : ""}):\n${entries.join("\n")}`, isError: false };
    }
    if (!body || typeof body !== "object") return failed("GitHub's answer couldn't be read.");
    const item = body as Record<string, unknown>;
    if (item.type === "file") return { text: `File ${where}:\n\n${fileText(item)}`, isError: false };
    if (item.type === "symlink") return { text: `${where} is a link to ${oneLine(item.target, 300)}.`, isError: false };
    if (item.type === "submodule") return { text: `${where} is a submodule (${oneLine(item.submodule_git_url, 300)}).`, isError: false };
    return failed("GitHub's answer couldn't be read.");
  }

  private async searchCode(args: Record<string, unknown>): Promise<ToolOutput> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query || query.length > 200 || /[\x00-\x1f\x7f]/.test(query)) return unusable("query must be 1 to 200 characters");
    let repo = "";
    if (args.repo !== undefined && args.repo !== "") {
      const checked = repoOf(args.repo);
      if (!checked) return unusable("repo must be owner/name");
      repo = checked;
    }
    const q = repo ? `${query} repo:${repo}` : query;
    const res = await this.api(`/search/code?q=${encodeURIComponent(q)}&per_page=20`, { accept: "application/vnd.github.text-match+json" });
    const problem = problemOf(res);
    if (problem) return problem;
    const body = parse(res);
    const items = field(body, "items");
    const list = Array.isArray(items) ? items : [];
    const found = list.map((item) => {
      const matches = field(item, "text_matches");
      const fragments = (Array.isArray(matches) ? matches : [])
        .filter((m) => field(m, "property") === "content")
        .slice(0, 2)
        .map((m) => `    ${String(field(m, "fragment") ?? "").slice(0, 300).replace(/\n/g, "\n    ")}`);
      return [`${oneLine(field(field(item, "repository"), "full_name"), 140)} ${oneLine(field(item, "path"), 300)}`, ...fragments].join("\n");
    });
    const total = Number(field(body, "total_count") ?? 0);
    const head = `${total} result${total === 1 ? "" : "s"}${field(body, "incomplete_results") ? " (GitHub's search was incomplete)" : ""}${found.length < total ? `, the first ${found.length} shown` : ""}.`;
    return { text: [head, ...found].join("\n"), isError: false };
  }

  private async listIssues(args: Record<string, unknown>): Promise<ToolOutput> {
    const repo = repoOf(args.repo);
    if (!repo) return unusable("repo must be owner/name");
    const state = args.state ?? "open";
    if (state !== "open" && state !== "closed" && state !== "all") return unusable("state must be open, closed or all");
    const kind = args.kind ?? "all";
    if (kind !== "all" && kind !== "issues" && kind !== "pull_requests") return unusable("kind must be all, issues or pull_requests");
    const res = await this.api(`/repos/${repo}/issues?state=${state}&sort=updated&per_page=30`);
    const problem = problemOf(res);
    if (problem) return problem;
    const body = parse(res);
    const lines = (Array.isArray(body) ? body : [])
      .filter((i) => kind === "all" || (field(i, "pull_request") !== undefined) === (kind === "pull_requests"))
      .map((i) => {
        const labels = field(i, "labels");
        const names = (Array.isArray(labels) ? labels : []).map((l) => oneLine(field(l, "name"), 50)).filter(Boolean);
        return `#${Number(field(i, "number"))} ${field(i, "pull_request") !== undefined ? "pull request" : "issue"} [${oneLine(field(i, "state"), 20)}] ${oneLine(field(i, "title"), 200)} (by ${oneLine(field(field(i, "user"), "login"), 60)}, updated ${oneLine(field(i, "updated_at"), 10)}${names.length ? `, labels: ${names.join(", ")}` : ""}) ${oneLine(field(i, "html_url"), 300)}`;
      });
    return { text: lines.length ? lines.join("\n") : `No ${state === "all" ? "" : `${state} `}issues or pull requests in ${repo}.`, isError: false };
  }

  private async readPullRequest(args: Record<string, unknown>): Promise<ToolOutput> {
    const repo = repoOf(args.repo);
    if (!repo) return unusable("repo must be owner/name");
    const number = args.number;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return unusable("number must be a pull request's number");
    const res = await this.api(`/repos/${repo}/pulls/${number}`);
    const problem = problemOf(res);
    if (problem) return problem;
    const pr = parse(res);
    const files = await this.api(`/repos/${repo}/pulls/${number}/files?per_page=50`);
    const fileProblem = problemOf(files);
    const list = fileProblem ? [] : (parse(files) as unknown[]);
    const changes = (Array.isArray(list) ? list : []).map((f) => {
      const patch = field(f, "patch");
      return `--- ${oneLine(field(f, "filename"), 300)} (${oneLine(field(f, "status"), 20)}, +${Number(field(f, "additions") ?? 0)} -${Number(field(f, "deletions") ?? 0)})\n${typeof patch === "string" ? patch.slice(0, 6000) : "[No text changes to show.]"}`;
    });
    const text = [
      `Pull request #${number} in ${repo}: ${oneLine(field(pr, "title"), 300)}`,
      `State: ${field(pr, "merged") ? "merged" : oneLine(field(pr, "state"), 20)}${field(pr, "draft") ? " (draft)" : ""}, by ${oneLine(field(field(pr, "user"), "login"), 60)}`,
      `From ${oneLine(field(field(pr, "head"), "label"), 200)} into ${oneLine(field(field(pr, "base"), "ref"), 200)}, ${Number(field(pr, "changed_files") ?? 0)} files changed`,
      oneLine(field(pr, "html_url"), 300),
      "",
      String(field(pr, "body") ?? "").slice(0, 8000) || "(No description.)",
      "",
      ...(fileProblem ? [`The changes couldn't be read: ${fileProblem.text}`] : changes),
    ].join("\n");
    return { text, isError: false };
  }

  private async createIssue(args: Record<string, unknown>): Promise<ToolOutput> {
    const repo = repoOf(args.repo);
    if (!repo) return unusable("repo must be owner/name");
    const title = typeof args.title === "string" && args.title.trim() && args.title.length <= 256 ? args.title : "";
    if (!title) return unusable("title must be 1 to 256 characters");
    if (typeof args.body !== "string") return unusable("body must be text");
    const res = await this.api(`/repos/${repo}/issues`, { method: "POST", body: { title, body: args.body } });
    const problem = problemOf(res);
    if (problem) return problem;
    const issue = parse(res);
    return { text: `Created issue #${Number(field(issue, "number"))} in ${repo}: ${oneLine(field(issue, "html_url"), 300)}`, isError: false };
  }

  private async openPullRequest(args: Record<string, unknown>): Promise<ToolOutput> {
    const repo = repoOf(args.repo);
    if (!repo) return unusable("repo must be owner/name");
    const title = typeof args.title === "string" && args.title.trim() && args.title.length <= 256 ? args.title : "";
    if (!title) return unusable("title must be 1 to 256 characters");
    if (typeof args.body !== "string") return unusable("body must be text");
    const head = headOf(args.head);
    const base = refOf(args.base);
    if (!head || !base) return unusable("head and base must be branch names");
    const res = await this.api(`/repos/${repo}/pulls`, { method: "POST", body: { title, body: args.body, head, base } });
    const problem = problemOf(res);
    if (problem) return problem;
    const pr = parse(res);
    return { text: `Opened pull request #${Number(field(pr, "number"))} in ${repo} (${head} into ${base}): ${oneLine(field(pr, "html_url"), 300)}`, isError: false };
  }
}
