import { msg } from "./i18n.ts";

/*
 * Connectors: the user's own accounts that Flash's replies can use (see the connectors plan). This
 * file is safe for the browser: the services Flash offers ready-made, and the shapes the chat and
 * Settings share. Secrets never come here; the server keeps them (see server/connections.ts).
 *
 * Every preset is the service's own official MCP server. Some sign in with one click (OAuth, see
 * server/mcp-oauth.ts: the service's own page, where Flash registers itself, so the user only says
 * yes); some take a key or token the user makes in that service; Linear and Airtable do both, with
 * sign-in first. Only services whose servers work this way are listed, so every card works.
 */

export type Preset = {
  id: string;
  name: string;
  // The service's official MCP server.
  url: string;
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
  // review: a server the user added and signed in to, waiting for them to look at its tools and add it.
  status: "ok" | "needs_reconnect" | "review";
  createdAt: number;
  tools: ToolView[];
};

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
