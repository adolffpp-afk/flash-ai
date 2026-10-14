import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * Web search (SearXNG), SEC EDGAR and FRED as the models' tools, against local stand-ins for the three
 * services: every https address Flash would call is sent to the stand-in below instead, with its
 * headers as they are. Nothing here reaches a real service. What shows only here: the password and
 * the FRED key never reach a log line or an answer, the caps and the cache, the SEC's 5 a second, the
 * trimming to one tool answer, and FRED's copyrighted series.
 */

const PASSWORD = "s3cret-Pass-word-for-tests";
const FRED_KEY = "abcdef0123456789abcdef0123456789";
const BASIC = `Basic ${Buffer.from(`flash:${PASSWORD}`).toString("base64")}`;
process.env.DATABASE_URL = ":memory:";
process.env.SEARXNG_URL = "https://searx.test";
process.env.SEARXNG_USERNAME = "flash";
process.env.SEARXNG_PASSWORD = PASSWORD;
process.env.FRED_API_KEY = FRED_KEY;
process.env.FLASH_CONTACT_EMAIL = "ops@example.com";
delete process.env.VERCEL_ENV;
delete process.env.FLASH_TEST_SEC_URL;
delete process.env.FLASH_TEST_FRED_URL;

// What the server logs, kept to look for secrets in.
const logged: string[] = [];
for (const level of ["log", "error", "warn", "info"] as const) {
  console[level] = (...args: unknown[]) => void logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
}

// ---------------------------------------------------------------------------------------------
// The stand-ins

type Seen = { at: number; service: string; path: string; query: URLSearchParams; headers: IncomingMessage["headers"]; url: string };
const seen: Seen[] = [];
// Answers held open (SearXNG answering nothing at all), ended after their test.
const hanging = new Set<import("node:http").ServerResponse>();
// How SearXNG answers next: its results, an error status, a redirect, a body too big, or nothing at all.
let searx: { status?: number; results?: object[]; unresponsive?: string[]; redirect?: boolean; huge?: boolean; hang?: boolean } = {};
let fredStatus = 0;

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const COMPANIES = [
  { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
  { cik_str: 789019, ticker: "MSFT", title: "MICROSOFT CORP" },
  { cik_str: 1067983, ticker: "BRK-B", title: "BERKSHIRE HATHAWAY INC" },
  { cik_str: 1318605, ticker: "TSLA", title: "Tesla, Inc." },
  ...Array.from({ length: 30 }, (_, i) => ({ cik_str: 1_000_001 + i, ticker: `ZZ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? "X" : ""}`, title: `Filler Company ${i}` })),
];

/** Apple's submissions: 300 filings, newest first, with long descriptions. */
function submissions(cik: string) {
  const forms = ["8-K", "4", "10-Q", "4", "8-K", "10-Q", "4", "10-Q", "10-K", "SC 13G"];
  const recent: Record<string, unknown[]> = { accessionNumber: [], filingDate: [], reportDate: [], form: [], primaryDocument: [], primaryDocDescription: [] };
  for (let i = 0; i < 300; i++) {
    recent.accessionNumber.push(`0000320193-${String(24 - Math.floor(i / 40)).padStart(2, "0")}-${String(900 - i).padStart(6, "0")}`);
    recent.filingDate.push(iso(Date.UTC(2024, 10, 1) - i * 9 * DAY));
    recent.reportDate.push(iso(Date.UTC(2024, 8, 28) - i * 9 * DAY));
    recent.form.push(forms[i % forms.length]);
    // A file name that would climb out of the filing's folder is never linked as it is.
    recent.primaryDocument.push(i === 1 ? "../../evil.htm" : `aapl-${i}.htm`);
    recent.primaryDocDescription.push(`${forms[i % forms.length]} ${"long description ".repeat(10)}`);
  }
  return { cik, name: "Apple Inc.", tickers: ["AAPL"], filings: { recent } };
}

/** One reported value as EDGAR lists it. */
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
// Apple's revenue: under one tag since 2018, under an older one before; FY2023 restated in a later 10-K.
const REVENUE = [
  fact("2023-10-01", "2024-09-28", 391_035_000_000, "10-K", "2024-11-01"),
  fact("2022-09-25", "2023-09-30", 383_285_000_000, "10-K", "2024-11-01"),
  fact("2022-09-25", "2023-09-30", 383_000_000_000, "10-K", "2023-11-03", "0000320193-23-000106"),
  fact("2021-09-26", "2022-09-24", 394_328_000_000, "10-K", "2023-11-03", "0000320193-23-000106"),
  fact("2020-09-27", "2021-09-25", 365_817_000_000, "10-K", "2022-10-28", "0000320193-22-000108"),
  fact("2024-06-30", "2024-09-28", 94_930_000_000, "10-K", "2024-11-01"),
  fact("2024-03-31", "2024-06-29", 85_777_000_000, "10-Q", "2024-08-02", "0000320193-24-000081"),
  fact("2023-10-01", "2024-06-29", 296_105_000_000, "10-Q", "2024-08-02", "0000320193-24-000081"),
  // Many more quarters, so the trimming shows.
  ...Array.from({ length: 200 }, (_, i) => fact(iso(Date.UTC(2014, 0, 1) + i * 9 * DAY), iso(Date.UTC(2014, 0, 1) + i * 9 * DAY + 90 * DAY), 50_000_000_000 + i, "10-Q", iso(Date.UTC(2014, 3, 1) + i * 9 * DAY), `0000320193-${String(14 + Math.floor(i / 25)).padStart(2, "0")}-${String(i).padStart(6, "0")}`)),
];
const OLD_REVENUE = [fact("2017-10-01", "2018-09-29", 265_595_000_000, "10-K", "2018-11-05", "0000320193-18-000145")];
const companyfacts = (cik: string) => ({
  cik: Number(cik),
  entityName: "Apple Inc.",
  facts: {
    "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: { label: "Revenue from Contract with Customer", units: { USD: REVENUE } },
      SalesRevenueNet: { label: "Sales Revenue, Net", units: { USD: OLD_REVENUE } },
      NetIncomeLoss: { label: "Net Income (Loss)", units: { USD: [fact("2023-10-01", "2024-09-28", 93_736_000_000, "10-K", "2024-11-01")] } },
      EarningsPerShareDiluted: { label: "EPS, Diluted", units: { "USD/shares": [fact("2023-10-01", "2024-09-28", 6.08, "10-K", "2024-11-01")] } },
    },
  },
});

// FRED's series: one public, one a third party's.
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
  SP500: {
    id: "SP500",
    title: "S&P 500",
    units: "Index",
    frequency: "Daily, Close",
    observation_start: "2016-10-11",
    observation_end: "2026-10-09",
    last_updated: "2026-10-09",
    popularity: 83,
    notes: "Copyright © 2026, S&P Dow Jones Indices LLC. All rights reserved.",
  },
};

const stand = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://stand.in");
  const [, service, ...rest] = url.pathname.split("/");
  const path = `/${rest.join("/")}`;
  seen.push({ at: Date.now(), service, path, query: url.searchParams, headers: req.headers, url: req.url ?? "" });
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (service === "searx") {
    if (req.headers.authorization !== BASIC) return json({ error: "unauthorized" }, 401);
    if (searx.hang) return void hanging.add(res);
    if (searx.redirect) {
      res.writeHead(302, { location: "https://elsewhere.test/" });
      return res.end();
    }
    if (searx.status) return json({ error: "scripted" }, searx.status);
    if (searx.huge) return json({ results: [{ url: "https://x.test/", title: "x", content: "y".repeat(2_100_000) }] });
    const q = url.searchParams.get("q") ?? "";
    return json({
      query: q,
      results: searx.results ?? [
        { url: "https://news.example.com/a", title: `First on ${q}`, content: "What happened today, in short.", engine: "duckduckgo", publishedDate: "2026-10-12T08:00:00" },
        { url: "https://news.example.org/b", title: "Second <b>story</b>", content: "Another short summary.", engine: "bing" },
        { url: "javascript:alert(1)", title: "Not a web link", content: "dropped" },
        { url: "https://news.example.com/a", title: "Same link again", content: "dropped as a repeat" },
        { url: "https://user:pw@news.example.net/c", title: "Link with a password", content: "dropped" },
      ],
      unresponsive_engines: searx.unresponsive ?? [],
    });
  }
  if (service === "sec") {
    if (path === "/files/company_tickers.json") return json(Object.fromEntries(COMPANIES.map((c, i) => [String(i), c])));
    const sub = /^\/submissions\/CIK(\d{10})\.json$/.exec(path);
    if (sub) return sub[1] === "0000320193" || sub[1] === "0000789019" ? json(submissions(sub[1])) : json({}, 404);
    const facts = /^\/api\/xbrl\/companyfacts\/CIK(\d{10})\.json$/.exec(path);
    if (facts) return facts[1] === "0000320193" ? json(companyfacts(facts[1])) : json({ facts: {} });
    const concept = /^\/api\/xbrl\/companyconcept\/CIK(\d{10})\/([\w-]+)\/(\w+)\.json$/.exec(path);
    if (concept) {
      const found = (companyfacts(concept[1]).facts as Record<string, Record<string, object>>)[concept[2]]?.[concept[3]];
      return concept[1] === "0000320193" && found ? json(found) : json({}, 404);
    }
    return json({}, 404);
  }
  if (service === "fred") {
    if (url.searchParams.get("api_key") !== FRED_KEY || url.searchParams.get("file_type") !== "json")
      return json({ error_code: 400, error_message: "Bad Request.  The value for variable api_key is not registered.  Read https://fred.stlouisfed.org/docs/api/api_key.html for more information." }, 400);
    if (path === "/series/observations" && url.searchParams.get("frequency") === "d")
      return json({ error_code: 400, error_message: "Bad Request.  Variable frequency can not be higher than the series' native frequency." }, 400);
    if (fredStatus) return json({ error_message: "scripted" }, fredStatus);
    const id = url.searchParams.get("series_id") ?? "";
    if (path === "/series") return SERIES[id] ? json({ seriess: [SERIES[id]] }) : json({ error_code: 400, error_message: "Bad Request. The series does not exist." }, 400);
    if (path === "/series/observations") {
      const limit = Number(url.searchParams.get("limit") ?? 1000);
      const observations = Array.from({ length: 60 }, (_, i) => ({ date: iso(Date.UTC(2026, 8 - i, 1)), value: i === 1 ? "." : (4.3 - i * 0.01).toFixed(2) }));
      return json({ units: url.searchParams.get("units"), observations: observations.slice(0, limit) });
    }
    if (path === "/series/search") return json({ seriess: [SERIES.UNRATE, SERIES.SP500, { ...SERIES.UNRATE, id: "U6RATE", title: "Total Unemployed, U-6" }] });
    return json({}, 404);
  }
  json({}, 404);
});
await new Promise<void>((r) => stand.listen(0, "127.0.0.1", r));
const port = (stand.address() as AddressInfo).port;
after(() => {
  stand.closeAllConnections();
  stand.close();
});

// Every https address of the three services goes to the stand-in, with the request as it is.
const realFetch = globalThis.fetch;
const ROUTES: [string, string][] = [
  ["https://searx.test", "searx"],
  ["https://www.sec.gov", "sec"],
  ["https://data.sec.gov", "sec"],
  ["https://api.stlouisfed.org/fred", "fred"],
];
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  for (const [from, service] of ROUTES) if (url.startsWith(`${from}/`)) return realFetch(`http://127.0.0.1:${port}/${service}${url.slice(from.length)}`, init);
  return realFetch(input, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const { run: sql, all } = await import("../src/lib/server/db.ts");
const { searxngConfig, searxngReady, searxngUrlProblem, searchesToday, webSearchTool } = await import("../src/lib/server/searxng.ts");
const { forgetTickers, secFactsTool, secFilingsTool, secUserAgent, SEC_PER_SECOND } = await import("../src/lib/server/sec.ts");
const { fredKeyProblem, fredReady, fredSearchTool, fredSeriesTool } = await import("../src/lib/server/fred.ts");
const { dataTools } = await import("../src/lib/server/research-tools.ts");
const { fetchJson, SourceError, takeSlot } = await import("../src/lib/server/source-fetch.ts");
const R = await import("../src/lib/research.ts");
const { WEATHER_TOOL } = await import("../src/lib/weather.ts");
const { tokensAtMost } = await import("../src/lib/tokens.ts");

beforeEach(async () => {
  seen.length = 0;
  searx = {};
  fredStatus = 0;
  forgetTickers();
  for (const table of ["source_cache", "free_quota", "free_user_quota", "rate_limits"]) await sql(`DELETE FROM ${table}`);
  delete process.env.FLASH_FREE_DAILY_SEARCHES;
  delete process.env.FLASH_SEARXNG_DAILY_REQUESTS;
});

/** No secret anywhere in what a test can see: the log, and what it's given. */
function noSecrets(...shown: unknown[]) {
  const text = [...logged, ...shown.map((s) => JSON.stringify(s))].join("\n");
  for (const secret of [PASSWORD, FRED_KEY, BASIC, Buffer.from(`flash:${PASSWORD}`).toString("base64")]) assert.equal(text.includes(secret), false, "a secret was shown or logged");
}

// ---------------------------------------------------------------------------------------------
// Web search

test("web search is hidden until all three SearXNG variables are set, and an http address is refused", () => {
  const full = { SEARXNG_URL: "https://searx.example.app/", SEARXNG_USERNAME: "flash", SEARXNG_PASSWORD: "pw" };
  assert.deepEqual(searxngConfig(full), { base: "https://searx.example.app", authorization: `Basic ${Buffer.from("flash:pw").toString("base64")}` });
  for (const name of Object.keys(full)) assert.equal(searxngReady({ ...full, [name]: "" }), false, `${name} missing`);
  assert.equal(searxngReady({ ...full, SEARXNG_URL: "http://searx.example.app" }), false, "http would send the password in the clear");
  assert.equal(searxngUrlProblem({ SEARXNG_URL: "http://searx.example.app" }), "SEARXNG_URL must start with https://");
  assert.equal(searxngReady({ ...full, SEARXNG_URL: "https://flash:pw@searx.example.app" }), false, "no password in the address");
  assert.equal(searxngReady({ ...full, SEARXNG_URL: "https://searx.example.app/?q=x" }), false);
  assert.equal(searxngReady({ ...full, SEARXNG_USERNAME: "a:b" }), false, "Basic auth can't carry a colon in the name");
  const saved = process.env.SEARXNG_PASSWORD;
  delete process.env.SEARXNG_PASSWORD;
  try {
    assert.equal(webSearchTool("u1"), null);
    assert.deepEqual(dataTools({ search: true }, { userId: "u1" }), []);
  } finally {
    process.env.SEARXNG_PASSWORD = saved;
  }
  process.env.SEARXNG_URL = "http://searx.test";
  try {
    assert.equal(webSearchTool("u1"), null, "an http address hides it");
  } finally {
    process.env.SEARXNG_URL = "https://searx.test";
  }
  assert.deepEqual(
    dataTools({ search: true, filings: true, economy: true }, { userId: "u1" }).map((t) => t.name),
    ["web_search", "sec_company_filings", "sec_financial_facts", "fred_series_search", "fred_series"],
  );
});

test("a web search signs in with Basic auth, sends the query encoded, and never logs or returns the password", async () => {
  const tool = webSearchTool("u-auth", { language: "fr" })!;
  assert.equal(tool.status({ query: "café & co" }), "Searching the web for café & co…");
  const result = await tool.run({ query: "café & co? <script>", recent: "week" });
  const request = seen.find((s) => s.service === "searx")!;
  assert.equal(request.headers.authorization, BASIC);
  assert.equal(request.query.get("q"), "café & co? script", "angle brackets are dropped, the rest is sent as written");
  assert.match(request.url, /q=caf%C3%A9\+%26\+co%3F\+script/);
  assert.equal(request.query.get("format"), "json");
  assert.equal(request.query.get("safesearch"), "1");
  assert.equal(request.query.get("language"), "fr");
  assert.equal(request.query.get("time_range"), "week");
  assert.equal(request.url.includes(PASSWORD), false);
  assert.equal(result.used, true);
  // Only web links, each once, without a password in them, and the HTML in a title is dropped.
  assert.deepEqual(
    result.web?.results.map((r) => [r.url, r.title]),
    [
      ["https://news.example.com/a", "First on café & co? script"],
      ["https://news.example.org/b", "Second b story /b"],
    ],
  );
  const ledger = new R.ToolLedger();
  const text = ledger.settle("web_search", result);
  const read = JSON.parse(text) as { results: { n: number; url: string; date?: string }[] };
  assert.deepEqual(read.results.map((r) => r.n), [1, 2]);
  assert.equal(read.results[0].date, "2026-10-12");
  assert.deepEqual(ledger.sources().map((s) => s.url), ["https://news.example.com/a", "https://news.example.org/b"]);
  noSecrets(result, text);
});

test("the same search is answered from the cache, and each user's daily searches and Flash's daily total hold", async () => {
  const tool = webSearchTool("u-cap")!;
  await tool.run({ query: "Lagos weather news" });
  await tool.run({ query: "lagos weather NEWS" });
  assert.equal(seen.filter((s) => s.service === "searx").length, 1, "the second came from the cache");
  assert.equal(await searchesToday("u-cap"), 2, "a search from the cache still counts");

  process.env.FLASH_FREE_DAILY_SEARCHES = "3";
  assert.equal((await tool.run({ query: "third" })).used, true);
  const over = await tool.run({ query: "fourth" });
  assert.deepEqual([over.text, over.isError, over.used], [R.SEARCH_USED_UP, true, false]);
  assert.equal(seen.filter((s) => s.service === "searx").length, 2, "the fourth never reached SearXNG");
  // Another user still has theirs.
  assert.equal((await webSearchTool("u-other")!.run({ query: "fourth" })).used, true);

  // Flash's own day: once it's used up, a search that isn't cached fails, and the user's is given back.
  const sent = seen.filter((s) => s.service === "searx").length;
  process.env.FLASH_SEARXNG_DAILY_REQUESTS = String(sent);
  const before = await searchesToday("u-other");
  const capped = await webSearchTool("u-other")!.run({ query: "something new" });
  assert.deepEqual([capped.text, capped.used], [R.SEARCH_FAILED, false]);
  assert.equal(await searchesToday("u-other"), before);
  assert.equal(seen.filter((s) => s.service === "searx").length, sent);
});

test("SearXNG failing, redirecting, too big or with every engine down: the model is told it couldn't search, and the search is given back", async () => {
  const tool = webSearchTool("u-fail")!;
  const cases: [string, typeof searx][] = [
    ["an error", { status: 500 }],
    ["a redirect", { redirect: true }],
    ["a body over the cap", { huge: true }],
    ["every engine down", { results: [], unresponsive: ["google", "bing"] }],
  ];
  for (const [label, how] of cases) {
    searx = how;
    const result = await tool.run({ query: `query ${label}` });
    assert.deepEqual([result.text, result.isError, result.used], [R.SEARCH_FAILED, true, false], label);
  }
  assert.equal(await searchesToday("u-fail"), 0, "every failed search was given back");
  assert.equal(seen.some((s) => s.service !== "searx"), false, "a redirect isn't followed");
  // Found nothing, with the engines answering: the model may try other words.
  searx = { results: [] };
  const empty = await tool.run({ query: "nothing at all" });
  assert.equal(new R.ToolLedger().settle("web_search", empty), R.SEARCH_EMPTY);
  // A wrong password is a failure the owner can read in the log, by status only.
  process.env.SEARXNG_PASSWORD = "wrong";
  try {
    const denied = await webSearchTool("u-fail")!.run({ query: "denied" });
    assert.equal(denied.text, R.SEARCH_FAILED);
    assert.ok(logged.some((l) => l.includes("web search failed: source request failed: status 401 (check SEARXNG_USERNAME and SEARXNG_PASSWORD)")));
  } finally {
    process.env.SEARXNG_PASSWORD = PASSWORD;
  }
  // SearXNG with its JSON answers off (its default) refuses with 403: the log says what to turn on.
  searx = { status: 403 };
  assert.equal((await tool.run({ query: "json off" })).text, R.SEARCH_FAILED);
  assert.ok(logged.some((l) => l.includes("status 403 (turn on SearXNG's json format")));
  // A model's input that isn't a query.
  for (const input of [null, {}, { query: "   " }, { query: 42 }]) assert.equal((await tool.run(input)).isError, true);
  noSecrets();
});

test("every fetch has a timeout, and a stopped reply stops it", async () => {
  searx = { hang: true };
  const begun = Date.now();
  await assert.rejects(fetchJson(`https://searx.test/search?q=x`, { headers: { Authorization: BASIC }, timeoutMs: 300, maxBytes: 1000 }), (err: unknown) => err instanceof SourceError && err.reason === "timeout");
  assert.ok(Date.now() - begun < 3000);
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 100);
  await assert.rejects(fetchJson(`https://searx.test/search?q=y`, { headers: { Authorization: BASIC }, timeoutMs: 5000, maxBytes: 1000, signal: stop.signal }), SourceError);
  for (const res of hanging) res.destroy();
  hanging.clear();
});

test("a reply makes at most two searches, numbered in the order they came, and a repeated link keeps its number", () => {
  const ledger = new R.ToolLedger();
  assert.deepEqual([ledger.take("web"), ledger.take("web"), ledger.take("web")], [true, true, false]);
  assert.equal(R.limitText("web"), R.SEARCH_LIMIT);
  const result = (urls: string[]) => ({ text: "", isError: false, used: true, web: { query: "q", results: urls.map((url) => ({ title: url, url, snippet: "s" })) } });
  ledger.settle("web_search", result(["https://a.test/1", "https://b.test/2"]));
  const second = JSON.parse(ledger.settle("web_search", result(["https://c.test/3", "https://a.test/1"]))) as { results: { n: number }[] };
  assert.deepEqual(second.results.map((r) => r.n), [3, 1]);
  ledger.settle("sec_financial_facts", { text: "{}", isError: false, used: true, sources: [{ title: "SEC EDGAR · Apple Inc. · 10-K · 2024-11-01", url: "https://www.sec.gov/x" }] });
  assert.deepEqual(ledger.sources().map((s) => s.url), ["https://a.test/1", "https://b.test/2", "https://c.test/3", "https://www.sec.gov/x"]);
  // A search is cut to fit one tool answer before it's numbered: every number listed was read.
  const many = Array.from({ length: 6 }, (_, i) => ({ title: "t".repeat(150), url: `https://long.test/${i}`, snippet: "s".repeat(300) }));
  const fresh = new R.ToolLedger();
  const text = fresh.settle("web_search", { text: "", isError: false, used: true, web: { query: "q".repeat(200), results: many } });
  assert.ok(R.fits(text));
  assert.equal((JSON.parse(text) as { results: unknown[] }).results.length, fresh.sources().length);
});

// ---------------------------------------------------------------------------------------------
// SEC EDGAR

test("SEC EDGAR: a ticker or a name becomes the company's CIK, every request names Flash with a contact address, and inputs are checked", async () => {
  assert.equal(secUserAgent(), "Flash AI ops@example.com");
  const filings = secFilingsTool();
  const byTicker = JSON.parse((await filings.run({ company: "AAPL", forms: ["10-K"] })).text) as { cik: string; company: string; filings: { form: string; url: string }[] };
  assert.equal(byTicker.cik, "0000320193");
  assert.equal(byTicker.company, "Apple Inc.");
  assert.ok(byTicker.filings.every((f) => f.form === "10-K"));
  assert.match(byTicker.filings[0].url, /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/320193\/\d{18}\/aapl-\d+\.htm$/);
  for (const company of ["apple", "Apple Inc", "$AAPL", "320193"]) {
    assert.equal((JSON.parse((await filings.run({ company, limit: 1 })).text) as { cik: string }).cik, "0000320193", company);
  }
  const brk = await secFactsTool().run({ ticker: "BRK.B", concepts: ["revenue"] });
  assert.match(brk.text, /"cik":"0001067983"/, "a share class is found with a dot or a dash");
  const sec = seen.filter((s) => s.service === "sec");
  assert.ok(sec.length >= 3);
  for (const s of sec) assert.equal(s.headers["user-agent"], "Flash AI ops@example.com");
  assert.equal(seen.filter((s) => s.path === "/files/company_tickers.json").length, 1, "the ticker list is read once");
  // A file name that would leave the filing's folder links to the filing's index instead.
  const all8k = JSON.parse((await filings.run({ company: "AAPL", forms: ["4"], limit: 1 })).text) as { filings: { url: string }[] };
  assert.equal(all8k.filings[0].url, "https://www.sec.gov/Archives/edgar/data/320193/000032019324000899/0000320193-24-000899-index.htm");
  for (const [input, label] of [
    [{ company: "<script>alert(1)</script>" }, "markup"],
    [{ company: "" }, "empty"],
    [{ company: "AAPL", forms: ["10-K; DROP TABLE"] }, "a form that isn't one"],
    [{ company: "AAPL", limit: 50 }, "too many"],
    [{ company: "AAPL", limit: "5" }, "a limit in words"],
  ] as const) {
    const r = await filings.run(input);
    assert.equal(r.isError, true, label);
  }
  assert.equal((await filings.run({ company: "Nonexistent Widgets Corp" })).isError, true);
  for (const input of [{ ticker: "AAPL", concepts: ["../etc/passwd"] }, { ticker: "AAPL", concepts: [] }, { ticker: "AAPL", concepts: ["revenue", "a", "b", "c", "d"] }, { ticker: "AAPL", concepts: ["revenue"], count: 11 }]) {
    assert.equal((await secFactsTool().run(input)).isError, true, JSON.stringify(input));
  }
});

test("SEC EDGAR: filings and figures are cut to fit one tool answer, figures merge their tags, and the latest filing of a period wins", async () => {
  const filings = await secFilingsTool().run({ company: "AAPL", limit: 20 });
  assert.ok(R.fits(filings.text), "the filings fit one tool answer");
  assert.ok(filings.used && (filings.sources ?? []).length <= 3);
  assert.match(filings.sources![0].title, /^SEC EDGAR · Apple Inc\. · /);

  const annual = await secFactsTool().run({ ticker: "AAPL", concepts: ["revenue", "net_income", "eps_diluted"], count: 3 });
  assert.ok(R.fits(annual.text));
  const read = JSON.parse(annual.text) as { facts: { concept: string; unit: string; values: { start: string; end: string; value: number; form: string }[] }[] };
  const revenue = read.facts.find((f) => f.concept === "revenue")!;
  assert.equal(revenue.unit, "USD");
  assert.deepEqual(
    revenue.values.map((v) => [v.end, v.value]),
    [
      ["2024-09-28", 391_035_000_000],
      ["2023-09-30", 383_285_000_000],
      ["2022-09-24", 394_328_000_000],
    ],
    "fiscal years only (no quarters), the restated value, newest first",
  );
  assert.equal(read.facts.find((f) => f.concept === "eps_diluted")!.unit, "USD/shares");
  assert.equal(annual.sources![0].title, "SEC EDGAR · Apple Inc. · 10-K · 2024-11-01");
  assert.equal(annual.sources![0].url, "https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/0000320193-24-000123-index.htm");
  assert.equal(seen.filter((s) => s.path.startsWith("/api/xbrl/companyfacts/")).length, 1, "several tags: one companyfacts request");

  // Older years come from the older tag.
  const tenYears = JSON.parse((await secFactsTool().run({ ticker: "AAPL", concepts: ["revenue"], count: 10 })).text) as { facts: { values: { end: string; tag?: string }[] }[] };
  const ends = tenYears.facts[0].values.map((v) => v.end);
  assert.ok(ends.includes("2018-09-29"));
  assert.equal(tenYears.facts[0].values.find((v) => v.end === "2018-09-29")!.tag, "us-gaap:SalesRevenueNet");

  // Quarters: about three months each, never the nine months to date.
  const quarterly = JSON.parse((await secFactsTool().run({ ticker: "AAPL", concepts: ["revenue"], period: "quarterly", count: 10 })).text) as { facts: { values: { start: string; end: string; value: number }[] }[] };
  const q = quarterly.facts[0].values;
  assert.deepEqual(q.slice(0, 2).map((v) => v.value), [94_930_000_000, 85_777_000_000]);
  assert.ok(q.every((v) => (Date.parse(v.end) - Date.parse(v.start)) / DAY <= 100));
  assert.ok(R.fits(JSON.stringify(quarterly)));

  // One exact tag: companyconcept. A tag the company never used: said, with nothing made up.
  seen.length = 0;
  await sql("DELETE FROM source_cache");
  const one = await secFactsTool().run({ ticker: "AAPL", concepts: ["us-gaap:NetIncomeLoss"], count: 1 });
  assert.match(one.text, /93736000000/);
  assert.ok(seen.some((s) => s.path === "/api/xbrl/companyconcept/CIK0000320193/us-gaap/NetIncomeLoss.json"));
  const none = await secFactsTool().run({ ticker: "AAPL", concepts: ["us-gaap:MadeUpThing"] });
  assert.equal(none.used, false);
  assert.match(none.text, /EDGAR has no annual values/);
});

test("SEC EDGAR: Flash sends at most 5 requests a second across every server, and a reply makes at most 3 look-ups", async () => {
  assert.equal(SEC_PER_SECOND, 5);
  // Twelve look-ups at once, each of a company not looked up before: the ticker list, then a request each.
  const tool = secFactsTool();
  const begun = Date.now();
  await Promise.all(COMPANIES.slice(4, 16).map((c) => tool.run({ ticker: c.ticker, concepts: ["revenue"] })));
  const elapsed = Date.now() - begun;
  const windows = await all<{ key: string; count: number }>("SELECT key, count FROM rate_limits WHERE key LIKE 'source:sec:%'");
  assert.ok(windows.every((w) => Number(w.count) <= 5), JSON.stringify(windows));
  const sent = seen.filter((s) => s.service === "sec").length;
  assert.equal(windows.reduce((sum, w) => sum + Number(w.count), 0), sent, "every request took a slot");
  // 13 requests at 5 a second take three windows at least.
  assert.ok(sent >= 13 && elapsed >= 1000, `${sent} requests in ${elapsed} ms`);
  // The same with a stand-in clock: twelve takers at once fill one second, then the next, then wait.
  await sql("DELETE FROM rate_limits");
  let clock = 5_000_000;
  const waits: number[] = [];
  const taken = await Promise.all(
    Array.from({ length: 12 }, () =>
      takeSlot("clocked", 5, 1000, {
        waitMs: 3000,
        now: () => clock,
        wait: async (ms) => {
          waits.push(ms);
          clock += ms;
        },
      }),
    ),
  );
  assert.equal(taken.filter(Boolean).length, 12);
  const per = await all<{ count: number }>("SELECT count FROM rate_limits WHERE key LIKE 'source:clocked:%' ORDER BY key");
  assert.ok(per.every((w) => Number(w.count) <= 5));
  // A full window that won't free up in time: no request, never over.
  await sql("DELETE FROM rate_limits");
  for (let i = 0; i < 5; i++) assert.equal(await takeSlot("full", 5, 60_000, { waitMs: 100, now: () => 0 }), true);
  assert.equal(await takeSlot("full", 5, 60_000, { waitMs: 100, now: () => 0 }), false);

  const ledger = new R.ToolLedger();
  assert.deepEqual([ledger.take("sec"), ledger.take("sec"), ledger.take("sec"), ledger.take("sec")], [true, true, true, false]);
});

// ---------------------------------------------------------------------------------------------
// FRED

test("FRED is hidden without a usable key", () => {
  assert.equal(fredReady({}), false);
  assert.equal(fredReady({ FRED_API_KEY: "not-a-key" }), false);
  assert.equal(fredKeyProblem({ FRED_API_KEY: "not-a-key" }), "FRED_API_KEY must be the 32 letters and digits FRED shows");
  assert.equal(fredReady({ FRED_API_KEY: FRED_KEY }), true);
  delete process.env.FRED_API_KEY;
  try {
    assert.deepEqual(dataTools({ economy: true }, { userId: "u" }), []);
  } finally {
    process.env.FRED_API_KEY = FRED_KEY;
  }
});

test("FRED: a series comes with its units, frequency, link and notice; the key goes only to FRED, never to a log or an answer", async () => {
  const tool = fredSeriesTool();
  const result = await tool.run({ series_id: "unrate", count: 12 });
  assert.equal(result.used, true);
  assert.equal(result.notice, "fred");
  assert.deepEqual(result.sources, [{ title: "FRED® · Unemployment Rate (UNRATE)", url: "https://fred.stlouisfed.org/series/UNRATE" }]);
  const read = JSON.parse(result.text) as { series: { units: string; frequency: string }; observations: { date: string; value: number | null }[] };
  assert.equal(read.series.units, "Percent");
  assert.equal(read.series.frequency, "Monthly");
  assert.equal(read.observations.length, 12);
  assert.deepEqual(read.observations[0], { date: "2026-09-01", value: 4.3 });
  assert.equal(read.observations[1].value, null, "a missing value is null, never made up");
  const request = seen.find((s) => s.path === "/series/observations")!;
  assert.equal(request.query.get("api_key"), FRED_KEY);
  assert.equal(request.query.get("sort_order"), "desc");
  assert.equal(request.query.get("limit"), "12");
  // A change from a year ago, monthly averages.
  const yoy = JSON.parse((await tool.run({ series_id: "UNRATE", units: "pc1", frequency: "q", start: "2020-01-01", end: "2026-09-01" })).text) as { series: { units: string; frequency: string } };
  assert.equal(yoy.series.units, "Percent, percent change from a year ago");
  assert.equal(yoy.series.frequency, "quarterly (averaged)");
  // Inputs are checked before anything is sent.
  for (const input of [{ series_id: "UNRATE&api_key=x" }, { series_id: "../../x" }, { series_id: "" }, { series_id: "UNRATE", start: "2020-13-01" }, { series_id: "UNRATE", start: "2024-01-01", end: "2020-01-01" }, { series_id: "UNRATE", frequency: "hourly" }, { series_id: "UNRATE", units: "x" }, { series_id: "UNRATE", count: 61 }]) {
    assert.equal((await tool.run(input)).isError, true, JSON.stringify(input));
  }
  assert.equal((await tool.run({ series_id: "NOSUCHSERIES" })).isError, true);
  fredStatus = 500;
  await sql("DELETE FROM source_cache");
  const failed = await tool.run({ series_id: "UNRATE" });
  assert.deepEqual([failed.text, failed.used], [R.FRED_FAILED, false]);
  assert.ok(logged.some((l) => l.includes("FRED look-up failed: source request failed: status 500")));
  noSecrets(result, failed);
});

test("FRED refusing the key is a failure, never 'no such series' or 'bad options', and isn't remembered", async () => {
  await sql("DELETE FROM source_cache");
  const tool = fredSeriesTool();
  process.env.FRED_API_KEY = "0123456789abcdef0123456789abcdef";
  try {
    const refused = await tool.run({ series_id: "UNRATE" });
    assert.deepEqual([refused.text, refused.isError, refused.used], [R.FRED_FAILED, true, false]);
    assert.ok(logged.some((l) => l.includes("FRED look-up failed: source request failed: status 400")));
    assert.equal(logged.some((l) => l.includes("api_key")), false, "FRED's error text isn't logged");
  } finally {
    process.env.FRED_API_KEY = FRED_KEY;
  }
  // With the right key again, the series is there at once: nothing said it was missing.
  const fixed = await tool.run({ series_id: "UNRATE", count: 3 });
  assert.equal(fixed.used, true);
  // A series FRED doesn't have, and options it refuses, are told to the model as such.
  const missing = await tool.run({ series_id: "NOSUCHSERIES" });
  assert.match(missing.text, /FRED has no series with the id NOSUCHSERIES/);
  const daily = await tool.run({ series_id: "UNRATE", frequency: "d" });
  assert.match(daily.text, /FRED refused these options/);
  noSecrets(fixed, missing, daily);
});

test("FRED: a series a third party owns is refused before its values are fetched, and left out of a search", async () => {
  const refused = await fredSeriesTool().run({ series_id: "SP500" });
  assert.deepEqual([refused.text, refused.isError, refused.used, refused.notice], [R.FRED_COPYRIGHT, true, false, undefined]);
  assert.equal(seen.some((s) => s.path === "/series/observations"), false, "its values were never asked for");
  const search = await fredSearchTool().run({ query: "unemployment" });
  const read = JSON.parse(search.text) as { series: { id: string }[]; note: string };
  assert.deepEqual(read.series.map((s) => s.id), ["UNRATE", "U6RATE"]);
  assert.match(read.note, /1 copyrighted series left out/);
  assert.equal(search.notice, "fred");
  assert.ok(fredSearchTool().finder);
});

test("FRED's notice is the exact wording its terms ask for, with a link to them", () => {
  assert.equal(R.FRED_NOTICE, "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.");
  assert.ok(R.FRED_NOTE.includes(R.FRED_NOTICE) && R.FRED_NOTE.includes("(https://fred.stlouisfed.org/docs/api/terms_of_use.html)"));
  const ledger = new R.ToolLedger();
  ledger.settle("fred_series", { text: "{}", isError: false, used: true, notice: "fred", sources: [] });
  assert.equal(ledger.fred, true);
  const unused = new R.ToolLedger();
  unused.settle("fred_series", { text: R.FRED_COPYRIGHT, isError: true, used: false });
  assert.equal(unused.fred, false);
});

test("Claude's tools together fit the room a reply's hold leaves for tools (the data tools are counted on top of it too, see dataRoom)", () => {
  const all = [WEATHER_TOOL, ...[R.SEC_FILINGS, R.SEC_FACTS, R.FRED_SEARCH, R.FRED_SERIES].map(R.claudeTool)];
  assert.ok(tokensAtMost(JSON.stringify(all)) <= 2400, `${tokensAtMost(JSON.stringify(all))} tokens at most`);
  // At most 1,500 tokens counted high (2.5 characters a token), and 4,500 characters: priced as a forecast is.
  assert.equal(R.MAX_RESULT_TOKENS, 1500);
  assert.ok(R.fits("x".repeat(3750)) && !R.fits("x".repeat(3751)));
  assert.ok(!R.fits("天".repeat(600)), "a token for every byte of other scripts");
});
