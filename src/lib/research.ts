import type Anthropic from "@anthropic-ai/sdk";
import { tokensAtMost } from "./tokens.ts";
import type { Source } from "./types.ts";

/*
 * Official data and web search for the models, as tools they call while they answer (like get_weather,
 * see weather.ts): web_search (the owner's own SearXNG, for the free models), SEC EDGAR's filings and
 * reported figures, and FRED's economic data. This file holds what is pure: the tools' definitions,
 * the checks on what a model asks for, the texts it gets back and how they're cut to fit, and a reply's
 * ledger of calls and sources. The fetching is in server/searxng.ts, server/sec.ts and server/fred.ts.
 * The texts the model reads are English: it answers in the user's language.
 */

// ---------------------------------------------------------------------------------------------
// Sizes and caps

/**
 * The most one tool answer may be, as for a forecast (MAX_FORECAST_CHARS and WEATHER_RESULT_TOKENS):
 * a reply's hold plans each tool round at this many tokens, so these tools are priced as get_weather is.
 */
export const MAX_RESULT_CHARS = 4500;
export const MAX_RESULT_TOKENS = 1500;
/** Calls a reply may make of each kind of tool: web searches, SEC look-ups, FRED look-ups. */
export const CALL_CAPS: Record<ToolFamily, number> = { web: 2, sec: 3, fred: 3 };
/** Results kept from one web search, and the most of a snippet or title the model reads. */
export const SEARCH_RESULTS = 6;
const SNIPPET_CHARS = 300;
const TITLE_CHARS = 150;
const URL_CHARS = 500;
/** Sources listed under a reply, at most. */
export const MAX_SOURCES = 14;

export type ToolFamily = "web" | "sec" | "fred";

// ---------------------------------------------------------------------------------------------
// What a tool is to the engines

/** One web result, as the model reads it once it has its number. */
export type WebResult = { title: string; url: string; snippet: string; published?: string };

/**
 * What a tool call gives back. text is what the model reads (for a search, the results numbered when
 * the round ends, see ToolLedger.settle); used says real data came back; sources go under the reply;
 * notice "fred" adds FRED's notice to the reply.
 */
export type ToolResult = {
  text: string;
  isError: boolean;
  used: boolean;
  sources?: Source[];
  notice?: "fred";
  web?: { query: string; results: WebResult[] };
};

/** A tool for the models: its definition, the progress line for a call (in the user's language), and the call itself, which never throws. */
export type ClientTool = {
  name: string;
  family: ToolFamily;
  description: string;
  schema: { type: "object"; properties: Record<string, unknown>; required: string[] };
  status: (input: unknown) => string;
  run: (input: unknown, signal?: AbortSignal) => Promise<ToolResult>;
  // A tool that only finds where to look (FRED's search): on the free lane, a round of it may be followed by one more.
  finder?: boolean;
};

type Definition = Pick<ClientTool, "name" | "description" | "schema">;
/** The tool as Claude gets it (no eager_input_streaming, as for get_weather). */
export const claudeTool = (tool: Definition): Anthropic.Beta.BetaTool => ({ name: tool.name, description: tool.description, input_schema: tool.schema });
/** The same tool as a function, for the free models' function calling. */
export const functionTool = (tool: Definition) => ({ name: tool.name, description: tool.description, parameters: tool.schema });

// ---------------------------------------------------------------------------------------------
// Definitions

export const WEB_SEARCH = {
  name: "web_search",
  description:
    "Searches the web with Flash's own search engine. Returns up to 6 results (title, address, snippet, date when known), each with a " +
    "number to cite as [n]. Call it for anything that may have changed since your training: news, today's events, prices, scores, " +
    "schedules, who holds an office, the latest version of something. Use a short, specific query. At most 2 searches per answer.",
  schema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "What to search for, in a few words." },
      language: { type: "string", description: 'Two-letter language code of the results to prefer, like "en" or "fr", or "all".' },
      recent: { type: "string", enum: ["day", "week", "month", "year"], description: "Only results from the last day, week, month or year." },
    },
    required: ["query"],
  },
};

export const SEC_FILINGS = {
  name: "sec_company_filings",
  description:
    "A US public company's recent filings from SEC EDGAR, the SEC's official database: form, filing date, period and link, newest first. " +
    "company: the stock ticker (like AAPL), the company's name or its CIK. forms: which forms to list (default 10-K, 10-Q and 8-K).",
  schema: {
    type: "object" as const,
    properties: {
      company: { type: "string", description: "Ticker (best), name or CIK." },
      forms: { type: "array", items: { type: "string" }, description: 'Forms, like ["10-K"] or ["8-K"].' },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "How many filings (default 10)." },
    },
    required: ["company"],
  },
};

/** The figures sec_financial_facts knows by name, each with the tags it looks for, the most used first. */
export const FACT_NAMES: Record<string, string[]> = {
  revenue: ["us-gaap:Revenues", "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "us-gaap:SalesRevenueNet", "us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax", "ifrs-full:Revenue"],
  net_income: ["us-gaap:NetIncomeLoss", "us-gaap:ProfitLoss", "ifrs-full:ProfitLoss"],
  operating_income: ["us-gaap:OperatingIncomeLoss", "ifrs-full:ProfitLossFromOperatingActivities"],
  gross_profit: ["us-gaap:GrossProfit", "ifrs-full:GrossProfit"],
  eps_basic: ["us-gaap:EarningsPerShareBasic", "ifrs-full:BasicEarningsLossPerShare"],
  eps_diluted: ["us-gaap:EarningsPerShareDiluted", "ifrs-full:DilutedEarningsLossPerShare"],
  assets: ["us-gaap:Assets", "ifrs-full:Assets"],
  liabilities: ["us-gaap:Liabilities", "ifrs-full:Liabilities"],
  equity: ["us-gaap:StockholdersEquity", "us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", "ifrs-full:Equity"],
  cash: ["us-gaap:CashAndCashEquivalentsAtCarryingValue", "us-gaap:CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "ifrs-full:CashAndCashEquivalents"],
  operating_cash_flow: ["us-gaap:NetCashProvidedByUsedInOperatingActivities", "ifrs-full:CashFlowsFromUsedInOperatingActivities"],
  long_term_debt: ["us-gaap:LongTermDebtNoncurrent", "us-gaap:LongTermDebt"],
  r_and_d: ["us-gaap:ResearchAndDevelopmentExpense"],
  shares_outstanding: ["dei:EntityCommonStockSharesOutstanding"],
};

export const SEC_FACTS = {
  name: "sec_financial_facts",
  description:
    "Figures a US public company reported to the SEC (XBRL data from EDGAR), by fiscal year or quarter, with units and period dates. " +
    `ticker: the stock ticker (like AAPL), CIK or name. concepts: up to 4 of ${Object.keys(FACT_NAMES).join(", ")}, or an exact ` +
    'tag like "us-gaap:Revenues". period: annual (default) or quarterly. count: how many periods, newest first (default 5 years or 4 quarters).',
  schema: {
    type: "object" as const,
    properties: {
      ticker: { type: "string", description: "Ticker (best), CIK or name." },
      concepts: { type: "array", items: { type: "string" }, description: 'Like ["revenue", "net_income"].' },
      period: { type: "string", enum: ["annual", "quarterly"] },
      count: { type: "integer", minimum: 1, maximum: 10 },
    },
    required: ["ticker", "concepts"],
  },
};

export const FRED_SEARCH = {
  name: "fred_series_search",
  description:
    "Searches FRED, economic data from the Federal Reserve Bank of St. Louis, for data series: ids, titles, units, frequency and dates. " +
    "Use it when you don't know a series' id.",
  schema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: 'Like "unemployment rate" or "consumer price index".' },
      limit: { type: "integer", minimum: 1, maximum: 10 },
    },
    required: ["query"],
  },
};

export const FREQUENCIES = ["d", "w", "bw", "m", "q", "sa", "a"] as const;
export const TRANSFORMS = ["lin", "chg", "ch1", "pch", "pc1", "pca", "cch", "cca", "log"] as const;

export const FRED_SERIES = {
  name: "fred_series",
  description:
    "Values of one FRED series, newest first, with its title, units, frequency and last update. Common ids: UNRATE (US unemployment " +
    "rate), CPIAUCSL (consumer prices; units pc1 gives inflation over a year), CPILFESL (core CPI), GDP, GDPC1 (real GDP), " +
    "A191RL1Q225SBEA (real GDP growth), FEDFUNDS (fed funds rate), DGS10 (10-year Treasury yield), PAYEMS (payrolls).",
  schema: {
    type: "object" as const,
    properties: {
      series_id: { type: "string" },
      start: { type: "string", description: "YYYY-MM-DD" },
      end: { type: "string", description: "YYYY-MM-DD" },
      frequency: { type: "string", enum: [...FREQUENCIES], description: "A lower frequency to average to (m monthly, q quarterly, a annual)." },
      units: { type: "string", enum: [...TRANSFORMS], description: "lin as published, ch1 change from a year ago, pc1 percent change from a year ago." },
      count: { type: "integer", minimum: 1, maximum: 60, description: "How many values (default 24)." },
    },
    required: ["series_id"],
  },
};

// ---------------------------------------------------------------------------------------------
// What the model is told. Model-facing, so English.

export const SEARCH_FAILED =
  "The web search couldn't be done just now. Tell the user in one sentence that you couldn't search the web for this, then give what " +
  "you know and roughly when it dates from, and never present it as current or checked.";
export const SEARCH_EMPTY =
  "The web search found nothing for that query. You may try once more with other words; otherwise tell the user you couldn't find it " +
  "on the web, and never present anything as current or checked.";
export const SEARCH_LIMIT = "No more web searches fit in this answer. Answer with the results you have, citing them by number.";
export const SEARCH_USED_UP =
  "The user has used today's free web searches. Tell them in one sentence that free web search is used up for today (it resets " +
  "tomorrow, and Research with credits searches the web), then give what you know and roughly when it dates from, and never present it as current.";
export const SEC_FAILED =
  "SEC EDGAR couldn't be reached just now. Tell the user in one sentence that you couldn't get the SEC data, give no figures from it, " +
  "and suggest trying again in a minute.";
export const FRED_FAILED =
  "FRED couldn't be reached just now. Tell the user in one sentence that you couldn't get the FRED data, give no figures from it, and " +
  "suggest trying again in a minute.";
export const FRED_COPYRIGHT =
  "This FRED series is a third party's copyrighted data, so Flash can't show it. Tell the user so in one sentence and give no " +
  "figures from it. Other series on the same subject may be a third party's too: fred_series_search doesn't tell, and fred_series " +
  "refuses them the same way.";
export const DATA_LIMIT = "No more look-ups of this kind fit in this answer. Answer with what you have.";
export const badInput = (tool: string, reason: string) => `That input wasn't usable: ${reason}. Call ${tool} again with a corrected input, or answer without it.`;

/** FRED's notice, as its terms ask, shown wherever its data is: legal text, so always in English. */
export const FRED_NOTICE = "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.";
export const FRED_TERMS_URL = "https://fred.stlouisfed.org/docs/api/terms_of_use.html";
/** The note added under a reply that showed FRED data: the notice and a link to FRED's API terms. */
export const FRED_NOTE = `\n\n_${FRED_NOTICE} [FRED® API Terms of Use](${FRED_TERMS_URL})_`;

// ---------------------------------------------------------------------------------------------
// Checks on what a model asks for

type Obj = Record<string, unknown>;
export const asObject = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);

/** A short text a model wrote, made safe to send and to show: no control characters or angle brackets, one line, at most max characters. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // Only the start is read: what's kept is at most max characters.
  return value
    .slice(0, max * 4 + 100)
    .replace(/[\u0000-\u001f\u007f-\u009f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/** A stock ticker: 1 to 5 letters, with a class after a dot or dash ("BRK.B"). Upper-cased. */
export const TICKER = /^[A-Z]{1,5}(?:[.-][A-Z]{1,2})?$/;
/** A CIK, the SEC's number for a filer: 1 to 10 digits. */
export const CIK = /^\d{1,10}$/;
/** A company name as people write it. */
const COMPANY_NAME = /^[\p{L}\p{N}][\p{L}\p{N} &.,'’()-]{1,79}$/u;
/** An XBRL tag, with or without its taxonomy ("us-gaap:Revenues", "Revenues"). */
export const CONCEPT = /^(?:(us-gaap|ifrs-full|dei|srt):)?([A-Za-z][A-Za-z0-9]{1,150})$/;
/** A FRED series id: capitals, digits and underscores. */
export const SERIES_ID = /^[A-Z0-9][A-Z0-9_]{0,39}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Who a company is, as a model named it: a ticker, a CIK or a name. */
export type CompanyRef = { kind: "ticker" | "cik" | "name"; value: string };

export function companyRef(value: unknown): CompanyRef | null {
  const text = cleanText(value, 80).replace(/^\$/, "");
  if (!text) return null;
  if (CIK.test(text)) return { kind: "cik", value: text.padStart(10, "0") };
  const upper = text.toUpperCase();
  if (TICKER.test(upper) && (text === upper || text.length <= 5)) return { kind: "ticker", value: upper };
  return COMPANY_NAME.test(text) ? { kind: "name", value: text } : null;
}

/** A date as YYYY-MM-DD that is a real day, or null. */
export function validDate(value: unknown): string | null {
  if (typeof value !== "string" || !DATE.test(value)) return null;
  const at = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value ? value : null;
}

/** A whole number from min to max, or the default when none was given; null when one was given wrong. */
export function intIn(value: unknown, min: number, max: number, fallback: number): number | null {
  if (value === undefined || value === null) return fallback;
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/** Only https and http links, without a user name or password, of a sensible length, go under a reply. */
export function sourceUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > URL_CHARS) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.hostname.includes(".")) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** One result from SearXNG's results[], kept to what the model reads, or null when it has no usable link. */
export function webResult(raw: unknown): WebResult | null {
  const r = asObject(raw);
  const url = r && sourceUrl(r.url);
  if (!r || !url) return null;
  const title = cleanText(r.title, TITLE_CHARS) || new URL(url).hostname;
  const snippet = cleanText(r.content, SNIPPET_CHARS);
  const date = typeof r.publishedDate === "string" ? r.publishedDate.slice(0, 10) : "";
  return { title, url, snippet, ...(validDate(date) && { published: date }) };
}

// ---------------------------------------------------------------------------------------------
// Fitting an answer to its budget

/** Whether a text fits one tool answer. */
export const fits = (text: string) => text.length <= MAX_RESULT_CHARS && tokensAtMost(text) <= MAX_RESULT_TOKENS;

/**
 * The longest version of an answer that fits: build(n) makes it with n items, from all of them down to
 * none; null when even that is too long.
 */
export function fitted(count: number, build: (n: number) => string): string | null {
  return fittedWith(count, build)?.text ?? null;
}

/** fitted, with how many items the text kept. */
export function fittedWith(count: number, build: (n: number) => string): { text: string; n: number } | null {
  for (let n = count; n >= 0; n--) {
    const text = build(n);
    if (fits(text)) return { text, n };
  }
  return null;
}

/** A search's results as the model reads them, numbered. */
const searchText = (query: string, results: (WebResult & { n: number })[]) =>
  JSON.stringify({
    query,
    results: results.map((r) => ({ n: r.n, title: r.title, url: r.url, ...(r.snippet && { snippet: r.snippet }), ...(r.published && { date: r.published }) })),
    note: "Cite these as [n]. Snippets are short: say only what they show.",
  });

// ---------------------------------------------------------------------------------------------
// A reply's ledger

/**
 * What one reply's tools did: how many calls of each kind it made (at most CALL_CAPS), the web
 * results it read, numbered in the order they came (the model cites them as [n], and they're listed
 * under the reply in that order), the other sources, and whether FRED's notice is due. One for each
 * attempt at a reply: a free provider that takes over starts a new one.
 */
export class ToolLedger {
  private calls = new Map<ToolFamily, number>();
  private cited: Source[] = [];
  private other: Source[] = [];
  /** FRED data was shown, so its notice goes under the reply. */
  fred = false;
  /** The tools whose data the reply used, by name. */
  readonly used = new Set<string>();

  /** Takes one call of a tool's kind, or returns false when the reply has made all it may. */
  take(family: ToolFamily): boolean {
    const n = this.calls.get(family) ?? 0;
    if (n >= CALL_CAPS[family]) return false;
    this.calls.set(family, n + 1);
    return true;
  }

  /** The number a link is cited by: the one it already has, or the next. */
  private cite(source: Source): number {
    const at = this.cited.findIndex((s) => s.url === source.url);
    if (at >= 0) return at + 1;
    this.cited.push(source);
    return this.cited.length;
  }

  /**
   * What the model reads for one call, once the round's calls have all come back (called in their
   * order, so numbers don't depend on which search answered first), noting what it used.
   */
  settle(name: string, result: ToolResult): string {
    if (result.web) {
      const { query, results } = result.web;
      // Cut to fit before numbering, so every number listed is one the model read.
      const keep = fittedWith(results.length, (n) => searchText(query, results.slice(0, n).map((r, i) => ({ ...r, n: this.cited.length + i + 1 }))));
      const kept = results.slice(0, keep?.n ?? 0);
      if (!kept.length) return SEARCH_EMPTY;
      this.used.add(name);
      return searchText(query, kept.map((r) => ({ ...r, n: this.cite({ title: r.title, url: r.url }) })));
    }
    if (result.used) {
      this.used.add(name);
      for (const s of result.sources ?? []) if (!this.other.some((o) => o.url === s.url)) this.other.push(s);
      if (result.notice === "fred") this.fred = true;
    }
    return result.text;
  }

  /** The sources to list under the reply: the web results by number, then the data sources. */
  sources(): Source[] {
    return [...this.cited, ...this.other.filter((s) => !this.cited.some((c) => c.url === s.url))].slice(0, MAX_SOURCES);
  }
}

/** What a model asked of a tool it may not call any more this reply. */
export const limitText = (family: ToolFamily) => (family === "web" ? SEARCH_LIMIT : DATA_LIMIT);

/** What a model reads when a tool failed in a way its own checks didn't catch. */
export const failText = (family: ToolFamily) => (family === "web" ? SEARCH_FAILED : family === "sec" ? SEC_FAILED : FRED_FAILED);

/** What a reply's tools tell its system prompt (see SystemOptions in engines/claude.ts). */
export const toolFlags = (tools: readonly Pick<ClientTool, "family">[] = []) => ({
  ...(tools.some((x) => x.family === "web") && { search: true }),
  ...(tools.some((x) => x.family === "sec") && { filings: true }),
  ...(tools.some((x) => x.family === "fred") && { economy: true }),
});

/** Each kind of tool's definitions, for a reply's hold to count them before the tools are made. */
export const FAMILY_TOOLS: Record<ToolFamily, Definition[]> = {
  web: [WEB_SEARCH],
  sec: [SEC_FILINGS, SEC_FACTS],
  fred: [FRED_SEARCH, FRED_SERIES],
};
