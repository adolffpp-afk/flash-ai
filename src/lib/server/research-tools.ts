import { webSearchTool } from "./searxng.ts";
import { secFactsTool, secFilingsTool } from "./sec.ts";
import { fredReady, fredSearchTool, fredSeriesTool } from "./fred.ts";
import { english, type Translate } from "../i18n.ts";
import type { ClientTool } from "../research.ts";

export { searxngReady } from "./searxng.ts";
export { fredReady } from "./fred.ts";

/** Which data tools a reply asked for (see route.ts): web search (free models only), SEC EDGAR, FRED. */
export type DataAsk = { search?: boolean; filings?: boolean; economy?: boolean };

/**
 * The data tools for one reply, as asked for and set up: web search only when SearXNG is (see
 * searxng.ts), FRED only with FRED_API_KEY; SEC EDGAR needs nothing. userId counts the free searches,
 * language is the user's answer language, t the language of the progress lines.
 */
export function dataTools(ask: DataAsk, { userId, language = "", t = english }: { userId: string; language?: string; t?: Translate }): ClientTool[] {
  const tools: ClientTool[] = [];
  const web = ask.search ? webSearchTool(userId, { language, t }) : null;
  if (web) tools.push(web);
  if (ask.filings) tools.push(secFilingsTool(t), secFactsTool(t));
  if (ask.economy && fredReady()) tools.push(fredSearchTool(t), fredSeriesTool(t));
  return tools;
}
