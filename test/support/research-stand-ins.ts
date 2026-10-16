import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { AddressInfo } from "node:net";

/*
 * Stand-ins for everything a reply with the data tools talks to, on one local server: Claude
 * (/anthropic, set ANTHROPIC_BASE_URL to it), a free model (/groq, OpenAI-style, for GROQ_BASE_URL),
 * SearXNG (/searx), SEC EDGAR (/sec) and FRED (/fred). install() sends Flash's https requests to
 * SearXNG, the SEC and FRED here, with their headers as they are. With tls, it serves https (for a
 * built app, which takes the stand-ins' addresses from FLASH_TEST_SEC_URL and FLASH_TEST_FRED_URL).
 * Every request is kept, to check what was sent; nothing reaches a real service. port is any free
 * one unless given.
 */

export const PASSWORD = "s3cret-Pass-word-for-tests";
export const FRED_KEY = "abcdef0123456789abcdef0123456789";
export const BASIC = `Basic ${Buffer.from(`flash:${PASSWORD}`).toString("base64")}`;

export type Block =
  | { type: "text"; text: string }
  | { type: "tool_use" | "server_tool_use"; id: string; name: string; input: object }
  | { type: "web_search_tool_result"; tool_use_id: string; content: object[] };
/** Claude's reply, streamed; hold: the stream waits for it after its first words (to press Stop then). */
export type ClaudeReply = { blocks: Block[]; stop: string; usage?: { input_tokens: number; output_tokens: number }; hold?: Promise<unknown> };
/**
 * A free model's reply: the calls it asks for (one reply at once), or words (streamed, or at once); cut:
 * the stream breaks after the words; hold: the stream waits for it after the words.
 */
export type FreeReply = { calls?: { name: string; args: object }[]; text?: string; cut?: boolean; hold?: Promise<unknown> };
export type Seen = { service: string; path: string; query: URLSearchParams; headers: IncomingMessage["headers"]; url: string; body: Record<string, unknown> };

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const fact = (start: string | null, end: string, val: number, form: string, filed: string, accn = "0000320193-24-000123") => ({
  ...(start && { start }),
  end,
  val,
  accn,
  fy: 2024,
  fp: form === "10-K" ? "FY" : "Q3",
  form,
  filed,
});
const APPLE_FACTS = {
  cik: 320193,
  entityName: "Apple Inc.",
  facts: {
    "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        label: "Revenue from Contract with Customer",
        units: {
          USD: [
            fact("2023-10-01", "2024-09-28", 391_035_000_000, "10-K", "2024-11-01"),
            fact("2022-09-25", "2023-09-30", 383_285_000_000, "10-K", "2024-11-01"),
            fact("2021-09-26", "2022-09-24", 394_328_000_000, "10-K", "2023-11-03", "0000320193-23-000106"),
          ],
        },
      },
      NetIncomeLoss: { label: "Net Income (Loss)", units: { USD: [fact("2023-10-01", "2024-09-28", 93_736_000_000, "10-K", "2024-11-01")] } },
    },
  },
};
const SERIES: Record<string, object> = {
  UNRATE: {
    id: "UNRATE",
    title: "Unemployment Rate",
    units: "Percent",
    frequency: "Monthly",
    seasonal_adjustment_short: "SA",
    observation_start: "1948-01-01",
    observation_end: "2026-09-01",
    last_updated: "2026-10-03 07:48:02-05",
    popularity: 94,
    notes: "The unemployment rate represents the number of unemployed as a percentage of the labor force.",
  },
  SP500: { id: "SP500", title: "S&P 500", units: "Index", frequency: "Daily", observation_start: "2016-10-11", observation_end: "2026-10-09", notes: "Copyright © 2026, S&P Dow Jones Indices LLC." },
};
// FRED's tags for each series, as /series/tags lists them: a third party's says "copyrighted: …".
const TAGS: Record<string, string[]> = { UNRATE: ["bls", "monthly", "nation", "public domain: citation requested", "unemployment"], SP500: ["copyrighted: pre-approval required", "s&p"] };

export async function startStandIns({ tls, port: fixedPort = 0 }: { tls?: { key: string; cert: string }; port?: number } = {}) {
  const state = {
    claude: { replies: [] as ClaudeReply[], sent: [] as Record<string, unknown>[], router: "text" },
    free: { replies: [] as FreeReply[], sent: [] as Record<string, unknown>[] },
    searx: { status: 0, results: undefined as object[] | undefined },
    seen: [] as Seen[],
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://stand.in");
      const [, service, ...rest] = url.pathname.split("/");
      const path = `/${rest.join("/")}`;
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        // Not JSON: kept as nothing.
      }
      state.seen.push({ service, path, query: url.searchParams, headers: req.headers, url: req.url ?? "", body });
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (service === "anthropic") return claude(path, body, res, json);
      if (service === "groq") return free(body, res, json);
      if (service === "searx") {
        if (req.headers.authorization !== BASIC) return json({ error: "unauthorized" }, 401);
        if (state.searx.status) return json({ error: "scripted" }, state.searx.status);
        const q = url.searchParams.get("q") ?? "";
        return json({
          query: q,
          results: state.searx.results ?? [
            { url: "https://news.example.com/today", title: `Top story: ${q}`, content: "The main thing that happened today.", engine: "duckduckgo", publishedDate: "2026-10-12T08:00:00" },
            { url: "https://news.example.org/markets", title: "Markets close higher", content: "Stocks rose on Monday.", engine: "bing" },
          ],
          unresponsive_engines: [],
        });
      }
      if (service === "sec") {
        if (path === "/files/company_tickers.json")
          return json({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." }, 1: { cik_str: 789019, ticker: "MSFT", title: "MICROSOFT CORP" } });
        if (path === "/submissions/CIK0000320193.json") {
          const forms = ["10-K", "8-K", "10-Q", "10-Q", "10-Q", "8-K"];
          const recent: Record<string, unknown[]> = { accessionNumber: [], filingDate: [], reportDate: [], form: [], primaryDocument: [], primaryDocDescription: [] };
          forms.forEach((form, i) => {
            recent.accessionNumber.push(`0000320193-24-${String(123 - i).padStart(6, "0")}`);
            recent.filingDate.push(iso(Date.UTC(2024, 10, 1) - i * 60 * 86_400_000));
            recent.reportDate.push(iso(Date.UTC(2024, 8, 28) - i * 60 * 86_400_000));
            recent.form.push(form);
            recent.primaryDocument.push(`aapl-${i}.htm`);
            recent.primaryDocDescription.push(form);
          });
          return json({ cik: "320193", name: "Apple Inc.", tickers: ["AAPL"], filings: { recent } });
        }
        if (path === "/api/xbrl/companyfacts/CIK0000320193.json") return json(APPLE_FACTS);
        const concept = /^\/api\/xbrl\/companyconcept\/CIK0000320193\/([\w-]+)\/(\w+)\.json$/.exec(path);
        const found = concept && (APPLE_FACTS.facts as Record<string, Record<string, object>>)[concept[1]]?.[concept[2]];
        return found ? json(found) : json({}, 404);
      }
      if (service === "fred") {
        if (url.searchParams.get("api_key") !== FRED_KEY)
          return json({ error_code: 400, error_message: "Bad Request.  The value for variable api_key is not registered.  Read https://fred.stlouisfed.org/docs/api/api_key.html for more information." }, 400);
        const id = url.searchParams.get("series_id") ?? "";
        if (path === "/series") return SERIES[id] ? json({ seriess: [SERIES[id]] }) : json({ error_message: "Bad Request. The series does not exist." }, 400);
        if (path === "/series/observations") {
          const limit = Number(url.searchParams.get("limit") ?? 24);
          const observations = Array.from({ length: 36 }, (_, i) => ({ date: iso(Date.UTC(2026, 8 - i, 1)), value: (4.3 - i * 0.02).toFixed(1) }));
          return json({ observations: observations.slice(0, limit) });
        }
        if (path === "/series/search") return json({ seriess: [SERIES.UNRATE, SERIES.SP500] });
        if (path === "/series/tags") return TAGS[id] ? json({ tags: TAGS[id].map((name) => ({ name, group_id: "gen" })) }) : json({ error_message: "Bad Request. The series does not exist." }, 400);
      }
      json({}, 404);
    });
  };

  /** Claude: count_tokens, the router (one reply at once), and replies streamed as Claude streams them. */
  function claude(path: string, body: Record<string, unknown>, res: ServerResponse, json: (v: unknown, s?: number) => void) {
    if (path.endsWith("/count_tokens")) return json({ input_tokens: 3000 });
    const usage = { input_tokens: 3000, output_tokens: 200 };
    if (body.stream !== true) {
      // The router, and any other helper asked for one reply at once.
      return json({ id: "msg_router", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: state.claude.router }], stop_reason: "end_turn", usage: { input_tokens: 400, output_tokens: 2 } });
    }
    state.claude.sent.push(body);
    const reply = state.claude.replies.shift() ?? { blocks: [{ type: "text", text: "done" }], stop: "end_turn" };
    const used = reply.usage ?? usage;
    const events: object[] = [{ type: "message_start", message: { id: `msg_${state.claude.sent.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: used } }];
    reply.blocks.forEach((b, index) => {
      if (b.type === "text") {
        events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
        events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
      } else if (b.type === "tool_use" || b.type === "server_tool_use") {
        events.push({ type: "content_block_start", index, content_block: { ...b, input: {} } });
        events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
      } else events.push({ type: "content_block_start", index, content_block: b });
      events.push({ type: "content_block_stop", index });
    });
    events.push({ type: "message_delta", delta: { stop_reason: reply.stop }, usage: used }, { type: "message_stop" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const write = (list: object[]) => {
      for (const e of list) res.write(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    // Held: the rest is sent once the hold ends, unless the reply was stopped (its connection closed) by then.
    const held = reply.hold ? events.findIndex((e) => (e as { type: string }).type === "content_block_delta") + 1 : 0;
    if (held > 0) {
      let closed = false;
      res.on("close", () => (closed = true));
      write(events.slice(0, held));
      void reply.hold!.then(() => {
        if (closed) return;
        write(events.slice(held));
        res.end();
      });
      return;
    }
    write(events);
    res.end();
  }

  /** A free model, OpenAI-style: the next scripted reply, or an answer that says what it read. */
  function free(body: Record<string, unknown>, res: ServerResponse, json: (v: unknown, s?: number) => void) {
    state.free.sent.push(body);
    const messages = (body.messages as { role: string; content: string }[]) ?? [];
    if (body.stream === false) {
      const reply = state.free.replies.shift() ?? { text: "Answered at once." };
      const message = reply.calls
        ? { role: "assistant", content: null, tool_calls: reply.calls.map((c, i) => ({ id: `call_${state.free.sent.length}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
        : { role: "assistant", content: reply.text ?? "" };
      return json({ choices: [{ message }], usage: { prompt_tokens: 900, completion_tokens: 40 } });
    }
    const results = messages.filter((m) => m.role === "tool").length;
    const reply = state.free.replies.shift();
    const text = reply?.text ?? `Here is what I found${results ? " [1]" : ""}.`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    if (reply?.cut) {
      setTimeout(() => res.destroy(), 20);
      return;
    }
    const end = () => {
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2000, completion_tokens: 30 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    };
    if (reply?.hold) {
      let closed = false;
      res.on("close", () => (closed = true));
      void reply.hold.then(() => !closed && end());
    } else end();
  }

  const server = tls ? createSecureServer(tls, handle) : createServer(handle);
  await new Promise<void>((r) => server.listen(fixedPort, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const origin = `${tls ? "https" : "http"}://127.0.0.1:${port}`;

  const realFetch = globalThis.fetch;
  const ROUTES: [string, string][] = [
    ["https://searx.test", "searx"],
    ["https://www.sec.gov", "sec"],
    ["https://data.sec.gov", "sec"],
    ["https://api.stlouisfed.org/fred", "fred"],
  ];
  return {
    state,
    port,
    origin,
    /** Sends Flash's requests to SearXNG (at https://searx.test), the SEC and FRED here. */
    install() {
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        for (const [from, service] of ROUTES) if (url.startsWith(`${from}/`)) return realFetch(`${origin}/${service}${url.slice(from.length)}`, init);
        return realFetch(input, init);
      }) as typeof fetch;
    },
    reset() {
      state.claude.replies.length = 0;
      state.claude.sent.length = 0;
      state.claude.router = "text";
      state.free.replies.length = 0;
      state.free.sent.length = 0;
      state.searx.status = 0;
      state.searx.results = undefined;
      state.seen.length = 0;
    },
    async close() {
      globalThis.fetch = realFetch;
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
