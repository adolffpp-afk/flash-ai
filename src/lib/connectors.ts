import { msg } from "./i18n.ts";

/*
 * Connectors: the user's own accounts that Flash's replies can use (see the connectors plan). This
 * file is safe for the browser: the services Flash offers ready-made, and the shapes the chat and
 * Settings share. Secrets never come here; the server keeps them (see server/connections.ts).
 *
 * Every preset is the service's own official MCP server, signed in with a key or token the user
 * makes in that service. Only services whose servers take such a key are listed, so every card works.
 */

export type Preset = {
  id: string;
  name: string;
  // The service's official MCP server.
  url: string;
  // What the user pastes, and where to make one (the service's own page about its MCP server).
  keyName: string;
  help: string;
  // One line on what it gives Flash, marked msg() and shown with t().
  blurb: string;
  // The tile's colour and letter: Flash draws no logos from other servers.
  color: string;
  // Tools that spend the user's own paid quota at scale: off until the user turns them on, and always
  // asked about, like writes.
  costly?: RegExp;
};

export const PRESETS: Preset[] = [
  {
    id: "linear",
    name: "Linear",
    url: "https://mcp.linear.app/mcp",
    keyName: msg("Personal API key"),
    help: "https://linear.app/docs/mcp",
    blurb: msg("Find, read and update issues and projects."),
    color: "#5e6ad2",
  },
  {
    id: "airtable",
    name: "Airtable",
    url: "https://mcp.airtable.com/mcp",
    keyName: msg("Personal access token"),
    help: "https://airtable.com/developers/agents/mcp/getting-started",
    blurb: msg("Read and change records in your bases."),
    color: "#f82b60",
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
  status: "ok" | "needs_reconnect";
  createdAt: number;
  tools: ToolView[];
};

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
