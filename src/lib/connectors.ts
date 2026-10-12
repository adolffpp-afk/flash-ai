import { msg } from "./i18n.ts";

/*
 * Connectors: the user's own accounts that Flash's replies can use (see the connectors plan). This
 * file is safe for the browser: the services Flash offers ready-made, and the shapes the chat and
 * Settings share. Secrets never come here; the server keeps them (see server/connections.ts).
 *
 * Every preset but GitHub is the service's own official MCP server. Some sign in with one click
 * (OAuth, see server/mcp-oauth.ts: the service's own page, where Flash registers itself, so the user
 * only says yes); some take a key or token the user makes in that service; Linear and Airtable do
 * both, with sign-in first. GitHub signs in through Flash's own GitHub App and uses Flash's own tools
 * over GitHub's API (see server/github.ts); Google Drive signs in through Flash's own Google Cloud
 * project, with access only to the files the user picks, and uses Flash's own tools over Google's
 * APIs (see server/google.ts). Each is listed only once it is set up. Only services that work this
 * way are listed, so every card works.
 */

export type Preset = {
  id: string;
  name: string;
  // The service's official MCP server (GitHub: its API, see rest).
  url: string;
  // Not an MCP server: Flash's own tools over the service's API, with its own Connect (GitHub and Google Drive, see server/github.ts and server/google.ts).
  rest?: boolean;
  // Connect signs in on the service's own page (OAuth). A preset with a keyName also takes a key.
  signIn?: boolean;
  // What the user pastes, and where to make one (the service's own page about its MCP server); none for a service that only signs in.
  keyName?: string;
  help: string;
  // One line on what it gives Flash, marked msg() and shown with t().
  blurb: string;
  // Something the user must know before connecting (marked msg(), shown with t()).
  note?: string;
  // The tile's colour and letter: Flash draws no logos from other servers.
  color: string;
  // Tools that spend the user's own paid quota at scale: off until the user turns them on, and always
  // asked about, like writes.
  costly?: RegExp;
};

export const PRESETS: Preset[] = [
  {
    id: "notion",
    name: "Notion",
    url: "https://mcp.notion.com/mcp",
    signIn: true,
    help: "https://developers.notion.com/guides/mcp/build-mcp-client",
    blurb: msg("Search, read and edit your pages and databases."),
    color: "#37352f",
  },
  {
    id: "linear",
    name: "Linear",
    url: "https://mcp.linear.app/mcp",
    signIn: true,
    keyName: msg("Personal API key"),
    help: "https://linear.app/docs/mcp",
    blurb: msg("Find, read and update issues and projects."),
    color: "#5e6ad2",
  },
  {
    id: "airtable",
    name: "Airtable",
    url: "https://mcp.airtable.com/mcp",
    signIn: true,
    keyName: msg("Personal access token"),
    help: "https://airtable.com/developers/agents/mcp/getting-started",
    blurb: msg("Read and change records in your bases."),
    color: "#f82b60",
  },
  {
    id: "klaviyo",
    name: "Klaviyo",
    url: "https://mcp.klaviyo.com/mcp",
    signIn: true,
    help: "https://www.klaviyo.com/solutions/ai/klaviyo-mcp-server",
    blurb: msg("Your lists, profiles, campaigns and flows."),
    note: msg("You need the Owner, Admin or Manager role in Klaviyo."),
    color: "#1f6f5f",
  },
  {
    id: "github",
    name: "GitHub",
    url: "https://api.github.com",
    rest: true,
    signIn: true,
    help: "https://docs.github.com/en/apps/using-github-apps/authorizing-github-apps",
    blurb: msg("Read code, issues and pull requests. Create issues and pull requests after you approve each one."),
    note: msg("On GitHub, you pick the repositories Flash can use. To add more later, press Add repositories on GitHub here, in Settings > Connectors."),
    color: "#24292f",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    url: "https://www.googleapis.com",
    rest: true,
    signIn: true,
    help: "https://support.google.com/accounts/answer/13533235",
    blurb: msg("Read the Docs, Sheets, Slides, PDFs and text files you pick. Create Docs, Sheets and Slides, or add rows to a Sheet, after you approve each one."),
    note: msg("Flash sees only the files you pick with Add from Drive, never the rest of your Drive."),
    color: "#1a73e8",
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    url: "https://mcp.firecrawl.dev/v2/mcp",
    keyName: msg("API key"),
    help: "https://docs.firecrawl.dev/mcp-server",
    blurb: msg("Read web pages and search the web with your Firecrawl account."),
    color: "#fa5d19",
    costly: /crawl|batch|extract|research|agent/i,
  },
  {
    id: "perplexity",
    name: "Perplexity",
    url: "https://api.perplexity.ai/mcp",
    keyName: msg("API key"),
    help: "https://docs.perplexity.ai/docs/getting-started/integrations/mcp-server",
    blurb: msg("Search the web with your Perplexity account."),
    color: "#1fb8cd",
    costly: /research|deep/i,
  },
  {
    id: "resend",
    name: "Resend",
    url: "https://mcp.resend.com/mcp",
    keyName: msg("API key"),
    help: "https://resend.com/docs/mcp-server",
    blurb: msg("Send email from your own domain, after you approve each one."),
    color: "#777777",
  },
  {
    id: "brevo",
    name: "Brevo",
    url: "https://mcp.brevo.com/v1/brevo/mcp",
    keyName: msg("MCP token"),
    help: "https://developers.brevo.com/docs/mcp-protocol",
    blurb: msg("Contacts, lists and campaigns in your Brevo account."),
    color: "#0b996e",
  },
];

export const presetById = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id);

/**
 * The titles and descriptions of Flash's own GitHub tools (see server/github.ts). Flash wrote them, so
 * they are shown translated. Every other tool's words come from its server and are shown as they are:
 * they are never looked up as a phrase (see toolWords).
 */
export const GITHUB_TOOL_WORDS = {
  list_repos: {
    title: msg("List repositories"),
    description: msg("Lists the GitHub repositories the user gave Flash access to, with their default branch."),
  },
  read_file: {
    title: msg("Read a file"),
    description: msg("Reads a file in a repository, or lists a folder. Leave path empty for the top folder."),
  },
  search_code: {
    title: msg("Search code"),
    description: msg("Searches code on the default branch, in one repository or in all the user can reach."),
  },
  list_issues: {
    title: msg("List issues and pull requests"),
    description: msg("Lists a repository's 30 most recently updated issues and pull requests."),
  },
  read_pull_request: {
    title: msg("Read a pull request"),
    description: msg("Reads a pull request: its title, branches and description, and the changes in each file."),
  },
  create_issue: {
    title: msg("Create an issue"),
    description: msg("Creates an issue in a repository. It waits for the user to approve it."),
  },
  open_pull_request: {
    title: msg("Open a pull request"),
    description: msg("Opens a pull request from a branch that already exists. It waits for the user to approve it."),
  },
} as const;

/**
 * The titles and descriptions of Flash's own Google Drive tools (see server/google.ts). Flash wrote
 * them, so they are shown in the user's language.
 */
export const GOOGLE_TOOL_WORDS = {
  list_files: {
    title: msg("List picked files"),
    description: msg("Lists the Google Drive files the user picked for Flash, with their type and id. Flash can use no other file in their Drive."),
  },
  read_file: {
    title: msg("Read a file"),
    description: msg("Reads a picked file: a Doc or a Slides deck as text, a Sheet as CSV (its first sheet, or the one named), a PDF's text, or a text file."),
  },
  create_doc: {
    title: msg("Create a Google Doc"),
    description: msg("Creates a new Google Doc in the user's Drive with a title and text. It waits for the user to approve it."),
  },
  create_sheet: {
    title: msg("Create a Google Sheet"),
    description: msg("Creates a new Google Sheet in the user's Drive with a title and rows. It waits for the user to approve it."),
  },
  create_slides: {
    title: msg("Create a Google Slides deck"),
    description: msg("Creates a new Google Slides deck in the user's Drive, one slide for each item, each with a title and text. It waits for the user to approve it."),
  },
  append_rows: {
    title: msg("Add rows to a Sheet"),
    description: msg("Adds rows at the end of a picked Google Sheet (its first sheet, or the one named). It waits for the user to approve it."),
  },
} as const;

const OWN_TOOL_WORDS = new Set<string>(Object.values(GITHUB_TOOL_WORDS).flatMap((w) => [w.title, w.description]));

/** A tool's title or description as shown: in the user's language when Flash wrote it (GitHub's tools), else as its server wrote it. */
export const toolWords = (t: (text: string) => string, text: string): string => (OWN_TOOL_WORDS.has(text) ? t(text) : text);

/** What a tool does, as far as Flash can tell: a read runs by itself; anything else asks the user first. */
export type ToolKind = "read" | "write" | "unknown";

/** A connection as Settings shows it: never its secret, only the last 4 characters of it. */
export type ConnectionView = {
  id: string;
  provider: string;
  label: string;
  host: string;
  custom: boolean;
  last4: string;
  // Signed in with OAuth: Reconnect signs in again (and asks for any access a tool said it needs).
  signIn: boolean;
  // Signed in, at a service that offers a way to cancel Flash's access (a revocation endpoint): removing it asks for that.
  revocable: boolean;
  // review: a server the user added and signed in to, waiting for them to look at its tools and add it.
  status: "ok" | "needs_reconnect" | "review";
  createdAt: number;
  tools: ToolView[];
  // The account it signed in as, where Flash knows it (Google Drive: the Google account's email).
  account?: string;
  // Google Drive: the files the user picked, the only ones a reply can open there.
  files?: PickedFileView[];
};

/** A Google Drive file the user picked, with the name and type Google gave when it was picked. */
export type PickedFileView = { id: string; name: string; mime: string; pickedAt: number };

/** A server's tool as the user is shown it before adding it (or using it again after it changed), with its pin. */
export type ToolPreview = { name: string; title: string; description: string; kind: ToolKind; hash: string };

export type ToolView = {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  enabled: boolean;
  trusted: boolean;
  // The server changed it since the user added it: it's left out until they look at it again.
  changed: boolean;
};

/** A tool a reply used, shown under the reply (never what it returned). */
export type ConnectorUse = { connection: string; tool: string };

/** What Flash asks the user to approve, drawn from what Claude asked for, never from Claude's words. */
export type ActionCard = {
  id: string;
  // The user's own connection it is for (to always allow its tool from the card).
  connectionId: string;
  connection: string;
  host: string;
  tool: string;
  title: string;
  // Every field of the input, as it will be sent.
  input: Record<string, unknown>;
  // What Flash knows an input's value as, by field (a picked file's name for its id), shown with it. Never sent.
  labels?: Record<string, string>;
  inputHash: string;
  kind: ToolKind;
  // A server the user added themselves: its tools can be always allowed.
  custom: boolean;
  expiresAt: number;
  status?: "pending" | "done" | "failed" | "cancelled" | "expired";
  // What the tool answered, once approved, cut short.
  result?: string;
  // The answer was continued with this result.
  continued?: boolean;
};

/** The ids of connections a chat request may name. */
export const CONNECTION_ID = /^[\w-]{8,40}$/;
export const MAX_CONNECTIONS = 20;

/**
 * The approved results a Continue asks for (the ids of their cards, at most 4): sent with the
 * request, and kept on its message so Retry sends them again, after a reload too.
 */
export const continuedIds = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && /^[\w-]{10,40}$/.test(id)))].slice(0, 4) : [];
