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
  { cik_str: 19617, ticker: "JPM", title: "JPMORGAN CHASE & CO" },
  { cik_str: 2_000_001, ticker: "MANY", title: "Many Forms Corp" },
  { cik_str: 3_000_001, ticker: "DISC", title: "Divest Corp" },
  { cik_str: 3_000_002, ticker: "RECL", title: "Reclass Corp" },
  { cik_str: 3_000_003, ticker: "FLOT", title: "Float Corp" },
  { cik_str: 3_000_004, ticker: "DECI", title: "Decimal Corp" },
  { cik_str: 3_000_005, ticker: "ONCE", title: "Reclass Once Corp" },
  { cik_str: 3_000_006, ticker: "PREC", title: "Precision Corp" },
  { cik_str: 3_000_007, ticker: "OLDR", title: "Old Restatement Corp" },
  { cik_str: 3_000_008, ticker: "TWCE", title: "Twice Restated Corp" },
  { cik_str: 3_000_009, ticker: "TWQS", title: "Restated In 10-Qs Corp" },
  { cik_str: 3_000_010, ticker: "AMND", title: "Amended 10-K Corp" },
  { cik_str: 3_000_011, ticker: "QAMD", title: "Amended 10-Q Corp" },
  { cik_str: 3_000_012, ticker: "MIDA", title: "Amended Between Corp" },
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

/** A submissions block from [form, filed] rows, newest first, as EDGAR lists them. */
function recentOf(cik: string, name: string, rows: [string, string][]) {
  const recent: Record<string, unknown[]> = { accessionNumber: [], filingDate: [], reportDate: [], form: [], primaryDocument: [], primaryDocDescription: [] };
  rows.forEach(([form, filed], i) => {
    recent.accessionNumber.push(`${cik}-24-${String(i + 1).padStart(6, "0")}`);
    recent.filingDate.push(filed);
    recent.reportDate.push("");
    recent.form.push(form);
    recent.primaryDocument.push(`doc-${i}.htm`);
    recent.primaryDocDescription.push(form);
  });
  return { cik, name, tickers: [], filings: { recent } };
}
/** A bank's: 500 424B2s (five a day), then, older, its 30 8-Ks, three 10-Qs and a 10-K. */
const bankSubmissions = (cik: string) =>
  recentOf(cik, "JPMORGAN CHASE & CO", [
    ...Array.from({ length: 500 }, (_, i): [string, string] => ["424B2", iso(Date.UTC(2024, 10, 1) - Math.floor(i / 5) * DAY)]),
    ...Array.from({ length: 30 }, (_, i): [string, string] => ["8-K", iso(Date.UTC(2024, 6, 20) - i * 7 * DAY)]),
    ["10-Q", iso(Date.UTC(2024, 6, 15))],
    ["10-Q", iso(Date.UTC(2024, 3, 15))],
    ["10-Q", iso(Date.UTC(2023, 10, 1))],
    ["10-K", iso(Date.UTC(2024, 1, 20))],
  ]);
/** 40 forms of 30 filings each (more than are kept in all), and, oldest of all, one 10-K. */
const manyFormsSubmissions = (cik: string) =>
  recentOf(cik, "Many Forms Corp", [
    ...Array.from({ length: 1200 }, (_, i): [string, string] => [`F-${i % 40}`, iso(Date.UTC(2024, 10, 1) - Math.floor(i / 40) * DAY)]),
    ["10-K", iso(Date.UTC(2024, 0, 2))],
  ]);

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
// Apple's operating cash flow, FY2023 to the third quarter of FY2026, as its filings report it: to date
// from the fiscal year's start (3, 6 and 9 months in each 10-Q, the year in the 10-K), never by quarter.
const B = 1_000_000;
const OPERATING_CASH = [
  ...(
    [
      ["2022-09-25", ["2022-12-31", "2023-04-01", "2023-07-01", "2023-09-30"], [34_005, 62_565, 88_945, 110_543], ["2023-02-03", "2023-05-05", "2023-08-04", "2023-11-03"]],
      ["2023-10-01", ["2023-12-30", "2024-03-30", "2024-06-29", "2024-09-28"], [39_895, 62_585, 91_443, 118_254], ["2024-02-02", "2024-05-03", "2024-08-02", "2024-11-01"]],
      ["2024-09-29", ["2024-12-28", "2025-03-29", "2025-06-28", "2025-09-27"], [29_935, 53_887, 81_754, 111_482], ["2025-01-31", "2025-05-02", "2025-08-01", "2025-10-31"]],
      ["2025-09-28", ["2025-12-27", "2026-03-28", "2026-06-27"], [41_000, 64_000, 92_000], ["2026-01-30", "2026-05-01", "2026-07-31"]],
    ] as const
  ).flatMap(([start, ends, values, filed], y) =>
    ends.map((end, k) => fact(start, end, values[k] * B, k === 3 ? "10-K" : "10-Q", filed[k], `0000320193-${23 + y}-${String(k + 1).padStart(6, "0")}`)),
  ),
  // The latest 10-Q repeats last year's nine months, as every 10-Q does: a value repeated unchanged
  // still lets its quarters be worked out.
  fact("2024-09-29", "2025-06-28", 81_754 * B, "10-Q", "2026-07-31", "0000320193-26-000003"),
];
// Companies whose filings restated figures, by CIK: quarters are never worked out across two bases.
const RESTATED: Record<string, Record<string, { label: string; units: { USD: object[] } }>> = {};
const at = (cik: number) => (y: number, k: number) => `${String(cik).padStart(10, "0")}-${String(y).slice(2)}-${String(k).padStart(6, "0")}`;
{
  // A segment (250 a quarter) is discontinued from the second quarter of 2026: that 10-Q and the next
  // restate 2025's comparatives, while 2025's year is still the old 10-K's.
  const n = at(3_000_001);
  RESTATED["0003000001"] = {
    Revenues: {
      label: "Revenues",
      units: {
        USD: [
          fact("2025-01-01", "2025-03-31", 2500 * B, "10-Q", "2025-05-01", n(2025, 1)),
          fact("2025-04-01", "2025-06-30", 2500 * B, "10-Q", "2025-08-01", n(2025, 2)),
          fact("2025-01-01", "2025-06-30", 5000 * B, "10-Q", "2025-08-01", n(2025, 2)),
          fact("2025-07-01", "2025-09-30", 2500 * B, "10-Q", "2025-11-01", n(2025, 3)),
          fact("2025-01-01", "2025-09-30", 7500 * B, "10-Q", "2025-11-01", n(2025, 3)),
          fact("2025-01-01", "2025-12-31", 10_000 * B, "10-K", "2026-02-20", n(2026, 4)),
          fact("2026-01-01", "2026-03-31", 2300 * B, "10-Q", "2026-05-01", n(2026, 5)),
          fact("2025-01-01", "2025-03-31", 2500 * B, "10-Q", "2026-05-01", n(2026, 5)),
          fact("2026-04-01", "2026-06-30", 2300 * B, "10-Q", "2026-08-01", n(2026, 6)),
          fact("2026-01-01", "2026-06-30", 4600 * B, "10-Q", "2026-08-01", n(2026, 6)),
          fact("2025-04-01", "2025-06-30", 2250 * B, "10-Q", "2026-08-01", n(2026, 6)),
          fact("2025-01-01", "2025-06-30", 4500 * B, "10-Q", "2026-08-01", n(2026, 6)),
          fact("2026-07-01", "2026-09-30", 2300 * B, "10-Q", "2026-10-30", n(2026, 7)),
          fact("2026-01-01", "2026-09-30", 6900 * B, "10-Q", "2026-10-30", n(2026, 7)),
          fact("2025-07-01", "2025-09-30", 2250 * B, "10-Q", "2026-10-30", n(2026, 7)),
          fact("2025-01-01", "2025-09-30", 6750 * B, "10-Q", "2026-10-30", n(2026, 7)),
        ],
      },
    },
  };
  // A change first shown in the 2025 10-K, which restates 2024's year with it; 2025's nine months are the old basis.
  const r = at(3_000_002);
  RESTATED["0003000002"] = {
    NetCashProvidedByUsedInOperatingActivities: {
      label: "Operating cash flow",
      units: {
        USD: [
          fact("2024-01-01", "2024-12-31", 1000 * B, "10-K", "2025-02-20", r(2025, 1)),
          fact("2025-01-01", "2025-03-31", 250 * B, "10-Q", "2025-05-01", r(2025, 2)),
          fact("2025-01-01", "2025-06-30", 500 * B, "10-Q", "2025-08-01", r(2025, 3)),
          fact("2025-01-01", "2025-09-30", 750 * B, "10-Q", "2025-11-01", r(2025, 4)),
          fact("2025-01-01", "2025-12-31", 900 * B, "10-K", "2026-02-20", r(2026, 5)),
          fact("2024-01-01", "2024-12-31", 900 * B, "10-K", "2026-02-20", r(2026, 5)),
        ],
      },
    },
  };
  // Cash flows reclassified from the third-quarter 10-Q of 2026 on (40 a quarter moves out), with 2025's nine months restated.
  const f = at(3_000_003);
  RESTATED["0003000003"] = {
    NetCashProvidedByUsedInOperatingActivities: {
      label: "Operating cash flow",
      units: {
        USD: [
          fact("2025-01-01", "2025-03-31", 300 * B, "10-Q", "2025-05-01", f(2025, 1)),
          fact("2025-01-01", "2025-06-30", 600 * B, "10-Q", "2025-08-01", f(2025, 2)),
          fact("2025-01-01", "2025-09-30", 900 * B, "10-Q", "2025-11-01", f(2025, 3)),
          fact("2025-01-01", "2025-12-31", 1200 * B, "10-K", "2026-02-20", f(2026, 4)),
          fact("2026-01-01", "2026-03-31", 300 * B, "10-Q", "2026-05-01", f(2026, 5)),
          fact("2025-01-01", "2025-03-31", 300 * B, "10-Q", "2026-05-01", f(2026, 5)),
          fact("2026-01-01", "2026-06-30", 600 * B, "10-Q", "2026-08-01", f(2026, 6)),
          fact("2025-01-01", "2025-06-30", 600 * B, "10-Q", "2026-08-01", f(2026, 6)),
          fact("2026-01-01", "2026-09-30", 780 * B, "10-Q", "2026-10-30", f(2026, 7)),
          fact("2025-01-01", "2025-09-30", 780 * B, "10-Q", "2026-10-30", f(2026, 7)),
        ],
      },
    },
  };
  /**
   * A calendar-year filer's operating cash flow as EDGAR lists it, filed up to `until`: each 10-Q its
   * year to date and last year's, each 10-K its year and the two before. ytd(y, k, shownIn) is year y's
   * value after k quarters as a filing made in year shownIn presents it.
   */
  const filer = (cik: number, ytd: (y: number, k: number, shownIn: number) => number, until = "2026-10-31") => {
    const id = at(cik);
    const rows: object[] = [];
    const ends = (y: number) => [`${y}-03-31`, `${y}-06-30`, `${y}-09-30`, `${y}-12-31`];
    for (const y of [2022, 2023, 2024, 2025, 2026]) {
      for (let k = 1; k <= 4; k++) {
        const filed = k < 4 ? `${y}-${["05", "08", "11"][k - 1]}-01` : `${y + 1}-02-20`;
        if (filed > until) continue;
        const shownIn = k < 4 ? y : y + 1;
        const [form, accn] = [k < 4 ? "10-Q" : "10-K", id(shownIn, k)];
        rows.push(fact(`${y}-01-01`, ends(y)[k - 1], ytd(y, k, shownIn) * B, form, filed, accn));
        if (k < 4) rows.push(fact(`${y - 1}-01-01`, ends(y - 1)[k - 1], ytd(y - 1, k, shownIn) * B, form, filed, accn));
        else for (const back of [1, 2]) rows.push(fact(`${y - back}-01-01`, ends(y - back)[3], ytd(y - back, 4, shownIn) * B, form, filed, accn));
      }
    }
    RESTATED[String(cik).padStart(10, "0")] = { NetCashProvidedByUsedInOperatingActivities: { label: "Operating cash flow", units: { USD: rows } } };
  };
  // 100 a quarter as first reported; from the 2025 10-K on, 10 a quarter is shown elsewhere (2024 and 2025 restated).
  filer(3_000_005, (y, k, shownIn) => (shownIn >= 2026 && y >= 2024 ? 90 : 100) * k);
  // In thousands at first (100.123 a quarter); from 2026's filings on in millions, the comparatives re-rounded.
  filer(3_000_006, (_y, k, shownIn) => (shownIn >= 2026 ? Math.round(100.123 * k) : Math.round(100.123 * k * 1000) / 1000));
  // The 2023 10-K restated 2022's year (400 to 395); the 2024 10-K repeats it as restated. Filed up to June 2025.
  filer(3_000_007, (y, k, shownIn) => (y === 2022 && k === 4 && shownIn >= 2024 ? 395 : 100 * k), "2025-06-01");
  /** An amendment filed on `filed` that repeats the figures of the filing `accn` unchanged. */
  const amend = (cik: number, accn: string, form: string, filed: string) => {
    const rows = RESTATED[String(cik).padStart(10, "0")].NetCashProvidedByUsedInOperatingActivities.units.USD as { accn: string }[];
    rows.push(...rows.filter((r) => r.accn === accn).map((r) => ({ ...r, form, filed, accn: at(cik)(Number(filed.slice(0, 4)), 99) })));
  };
  // Restated twice: by the 2024 10-K (90 a quarter, carried into 2025's 10-Qs), then by the 2025 10-K (80).
  filer(3_000_008, (_y, k, shownIn) => (shownIn >= 2026 ? 80 : shownIn >= 2025 ? 90 : 100) * k);
  // The same, the first change made in 2025's 10-Qs (the 2024 10-K was as first reported).
  filer(3_000_009, (_y, k, shownIn) => (shownIn >= 2026 ? 80 : shownIn === 2025 && k < 4 ? 90 : 100) * k);
  // ONCE, with a 10-K/A in April 2026 that re-files the 2025 10-K unchanged.
  filer(3_000_010, (y, k, shownIn) => (shownIn >= 2026 && y >= 2024 ? 90 : 100) * k);
  amend(3_000_010, at(3_000_010)(2026, 4), "10-K/A", "2026-04-15");
  // Restated from the 2026 Q2 10-Q on (90 a quarter in 2025 and 2026), with a 10-Q/A in September that re-files it unchanged.
  filer(3_000_011, (y, k, shownIn) => (shownIn >= 2026 && y >= 2025 && k >= 2 && k <= 3 ? 90 : 100) * k);
  amend(3_000_011, at(3_000_011)(2026, 2), "10-Q/A", "2026-09-15");
  // A 10-K/A for 2024, filed in December 2025 after the Q3 10-Q, restates 2022 to 2024 (90 a quarter); the
  // 2025 10-K repeats them as restated, and 2026's 10-Qs restate 2025.
  filer(3_000_012, (_y, k, shownIn) => (shownIn >= 2026 ? 90 : 100) * k);
  for (const y of [2022, 2023, 2024]) {
    (RESTATED["0003000012"].NetCashProvidedByUsedInOperatingActivities.units.USD as object[]).push(fact(`${y}-01-01`, `${y}-12-31`, 360 * B, "10-K/A", "2025-12-01", at(3_000_012)(2025, 99)));
  }
  // Amounts with cents.
  const d = at(3_000_004);
  RESTATED["0003000004"] = {
    NetCashProvidedByUsedInOperatingActivities: {
      label: "Operating cash flow",
      units: {
        USD: [
          fact("2026-01-01", "2026-03-31", 1_000_000.12, "10-Q", "2026-05-01", d(2026, 1)),
          fact("2026-01-01", "2026-06-30", 1_234_567.89, "10-Q", "2026-08-01", d(2026, 2)),
        ],
      },
    },
  };
}
const companyfacts = (cik: string) => ({
  cik: Number(cik),
  entityName: "Apple Inc.",
  facts: {
    "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: { label: "Revenue from Contract with Customer", units: { USD: REVENUE } },
      SalesRevenueNet: { label: "Sales Revenue, Net", units: { USD: OLD_REVENUE } },
      NetIncomeLoss: { label: "Net Income (Loss)", units: { USD: [fact("2023-10-01", "2024-09-28", 93_736_000_000, "10-K", "2024-11-01")] } },
      EarningsPerShareDiluted: {
        label: "EPS, Diluted",
        units: {
          "USD/shares": [
            fact("2023-10-01", "2024-09-28", 6.08, "10-K", "2024-11-01"),
            fact("2023-10-01", "2023-12-30", 2.18, "10-Q", "2024-02-02", "0000320193-24-000006"),
            fact("2023-10-01", "2024-03-30", 3.71, "10-Q", "2024-05-03", "0000320193-24-000069"),
          ],
        },
      },
      NetCashProvidedByUsedInOperatingActivities: { label: "Net Cash Provided by (Used in) Operating Activities", units: { USD: OPERATING_CASH } },
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
  // A third party's series whose notes don't say so: only FRED's tags do.
  OBMMIJUMBO30YF: {
    id: "OBMMIJUMBO30YF",
    title: "30-Year Fixed Rate Jumbo Mortgage Index",
    units: "Percent",
    frequency: "Daily",
    observation_start: "2017-01-03",
    observation_end: "2026-10-09",
    last_updated: "2026-10-10",
    popularity: 60,
    notes: "Data provided by Optimal Blue. Rate locks for 30-year fixed jumbo loans.",
  },
};
// FRED's tags for each series, as /series/tags lists them (lower case).
const TAGS: Record<string, string[]> = {
  UNRATE: ["bls", "monthly", "nation", "public domain: citation requested", "sa", "unemployment", "usa"],
  SP500: ["copyrighted: pre-approval required", "daily", "s&p"],
  OBMMIJUMBO30YF: ["30-year", "copyrighted: citation required", "daily", "jumbo", "mortgage", "optimal blue"],
};
// How /series/tags answers next: as listed, an error, or a reply without a list.
let fredTags: "ok" | "fail" | "malformed" = "ok";

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
    if (sub) {
      if (sub[1] === "0000019617") return json(bankSubmissions(sub[1]));
      if (sub[1] === "0002000001") return json(manyFormsSubmissions(sub[1]));
      return sub[1] === "0000320193" || sub[1] === "0000789019" ? json(submissions(sub[1])) : json({}, 404);
    }
    const facts = /^\/api\/xbrl\/companyfacts\/CIK(\d{10})\.json$/.exec(path);
    if (facts && RESTATED[facts[1]]) return json({ cik: Number(facts[1]), facts: { "us-gaap": RESTATED[facts[1]] } });
    if (facts) return facts[1] === "0000320193" ? json(companyfacts(facts[1])) : json({ facts: {} });
    const concept = /^\/api\/xbrl\/companyconcept\/CIK(\d{10})\/([\w-]+)\/(\w+)\.json$/.exec(path);
    if (concept && RESTATED[concept[1]]) {
      const found = concept[2] === "us-gaap" ? RESTATED[concept[1]][concept[3]] : undefined;
      return found ? json(found) : json({}, 404);
    }
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
    if (path === "/series/tags") {
      if (fredTags === "fail") return json({ error_message: "scripted" }, 500);
      if (fredTags === "malformed") return json({ count: 3 });
      if (!TAGS[id]) return json({ error_code: 400, error_message: "Bad Request. The series does not exist." }, 400);
      return json({ count: TAGS[id].length, tags: TAGS[id].map((name) => ({ name, group_id: "gen", notes: "", popularity: 50, series_count: 10 })) });
    }
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
  fredTags = "ok";
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

test("SEC EDGAR: a bank's hundreds of 424B2s don't crowd out its 10-K, 10-Q and 8-K, and each form keeps its newest", async () => {
  const filings = secFilingsTool();
  type Listed = { filings: { form: string; filed: string }[] };
  const read = async (input: object) => JSON.parse((await filings.run(input)).text) as Listed;
  // The usual forms, newest first: its 10-Qs and 8-Ks (its 10-K is older than the newest 20 of them).
  const usual = await read({ company: "JPM", limit: 20 });
  assert.equal(usual.filings.length, 20);
  for (const form of ["10-Q", "8-K"]) assert.ok(usual.filings.some((f) => f.form === form), `${form} is listed`);
  assert.deepEqual((await read({ company: "JPM", forms: ["10-K"] })).filings.map((f) => f.filed), ["2024-02-20"]);
  assert.equal((await read({ company: "JPM", forms: ["10-Q"] })).filings.length, 3);
  // As many of a form as one answer lists: the newest 20.
  const eightK = (await read({ company: "JPM", forms: ["8-K"], limit: 20 })).filings;
  assert.equal(eightK.length, 20);
  assert.equal(eightK[0].filed, "2024-07-20");
  const prospectuses = (await read({ company: "JPM", forms: ["424B2"], limit: 20 })).filings;
  assert.equal(prospectuses.length, 20);
  assert.equal(prospectuses[0].filed, "2024-11-01");
  assert.equal(seen.filter((s) => s.path === "/submissions/CIK0000019617.json").length, 1, "the list is read once, then kept");

  // More forms than fit in all: each keeps its newest, and a lone 10-K older than all of them is still there.
  const many = await read({ company: "MANY", forms: ["F-7"], limit: 20 });
  assert.ok(many.filings.length >= 12 && many.filings.length < 20, `${many.filings.length} kept`);
  assert.equal(many.filings[0].filed, "2024-11-01");
  assert.deepEqual((await read({ company: "MANY", forms: ["10-K"] })).filings.map((f) => f.filed), ["2024-01-02"]);
});

test("SEC EDGAR: quarters of a cash flow reported only to date are worked out, marked computed, and shares' values never are", async () => {
  type Values = { facts: { values: { start: string; end: string; value: number; form: string; filed: string; computed?: boolean }[] }[]; note: string };
  const run = async (input: object) => JSON.parse((await secFactsTool().run({ ticker: "AAPL", period: "quarterly", ...input })).text) as Values;
  const last4 = await run({ concepts: ["operating_cash_flow"] });
  assert.deepEqual(
    last4.facts[0].values.map((v) => [v.start, v.end, v.value / B, v.form, v.computed ?? false]),
    [
      ["2026-03-29", "2026-06-27", 28_000, "10-Q", true],
      ["2025-12-28", "2026-03-28", 23_000, "10-Q", true],
      ["2025-09-28", "2025-12-27", 41_000, "10-Q", false],
      // The year less its nine months.
      ["2025-06-29", "2025-09-27", 111_482 - 81_754, "10-K", true],
    ],
  );
  assert.match(last4.note, /computed: a quarter worked out/);
  assert.match(last4.note, /never call values consecutive quarters/);
  // Ten in a row, each starting the day after the one before it ends.
  const ten = (await run({ concepts: ["operating_cash_flow"], count: 10 })).facts[0].values;
  assert.equal(ten.length, 10);
  for (let k = 1; k < ten.length; k++) assert.equal(Date.parse(ten[k - 1].start) - Date.parse(ten[k].end), DAY, `${ten[k].end} then ${ten[k - 1].start}`);
  assert.deepEqual(
    ten.slice(4).map((v) => v.value / B),
    [81_754 - 53_887, 53_887 - 29_935, 29_935, 118_254 - 91_443, 91_443 - 62_585, 62_585 - 39_895],
  );
  // A value a share doesn't add up over quarters: only the quarter reported as one.
  const eps = await run({ concepts: ["eps_diluted"] });
  assert.deepEqual(eps.facts[0].values.map((v) => [v.end, v.value, v.computed ?? false]), [["2023-12-30", 2.18, false]]);
  // A quarter reported as one wins over the same quarter worked out (Apple's fourth quarter of revenue).
  const revenue = await run({ concepts: ["revenue"], count: 1 });
  assert.deepEqual(revenue.facts[0].values.map((v) => [v.start, v.value, v.computed ?? false]), [["2024-06-30", 94_930_000_000, false]]);
});

test("SEC EDGAR: no quarter is worked out from figures a later filing restated, as no such quarter was ever true; cents stay cents", async () => {
  type Value = { start: string; end: string; value: number; computed?: boolean };
  const quarters = async (ticker: string, concept: string) =>
    (JSON.parse((await secFactsTool().run({ ticker, concepts: [concept], period: "quarterly", count: 10 })).text) as { facts: { values: Value[] }[] }).facts[0].values.map(
      (v) => [v.start, v.end, v.value / B, v.computed ?? false],
    );
  // A business sold: 2025's fourth quarter would be the old year less restated nine months (3,250), never true.
  assert.deepEqual(await quarters("DISC", "revenue"), [
    ["2026-07-01", "2026-09-30", 2300, false],
    ["2026-04-01", "2026-06-30", 2300, false],
    ["2026-01-01", "2026-03-31", 2300, false],
    ["2025-07-01", "2025-09-30", 2250, false],
    ["2025-04-01", "2025-06-30", 2250, false],
    ["2025-01-01", "2025-03-31", 2500, false],
  ]);
  // A change first in the 10-K: its year less the old nine months (150) isn't shown; the 10-Qs' own quarters are.
  assert.deepEqual(await quarters("RECL", "operating_cash_flow"), [
    ["2025-07-01", "2025-09-30", 250, true],
    ["2025-04-01", "2025-06-30", 250, true],
    ["2025-01-01", "2025-03-31", 250, false],
  ]);
  // Reclassified from a third quarter on: neither third quarter (180) nor 2025's fourth (420) is shown.
  assert.deepEqual(await quarters("FLOT", "operating_cash_flow"), [
    ["2026-04-01", "2026-06-30", 300, true],
    ["2026-01-01", "2026-03-31", 300, false],
    ["2025-04-01", "2025-06-30", 300, true],
    ["2025-01-01", "2025-03-31", 300, false],
  ]);
  // 1,234,567.89 less 1,000,000.12 is 234,567.77, not 234,567.76999….
  const cents = JSON.parse((await secFactsTool().run({ ticker: "DECI", concepts: ["operating_cash_flow"], period: "quarterly" })).text) as { facts: { values: Value[] }[] };
  assert.deepEqual(cents.facts[0].values.map((v) => [v.end, v.value, v.computed ?? false]), [
    ["2026-06-30", 234_567.77, true],
    ["2026-03-31", 1_000_000.12, false],
  ]);
});

/** A company's newest quarters of operating cash flow, as "end:value", with * for one worked out. */
const cashQuarters = async (ticker: string, count = 10) =>
  (JSON.parse((await secFactsTool().run({ ticker, concepts: ["operating_cash_flow"], period: "quarterly", count })).text) as { facts: { values: { end: string; value: number; computed?: boolean }[] }[] }).facts[0].values.map(
    (v) => `${v.end}:${v.value / B}${v.computed ? "*" : ""}`,
  );

test("SEC EDGAR: a filing that repeats an earlier restatement changes nothing, but no quarter is worked out across one that changed figures", async () => {
  // A reclassification carried into 2026's comparatives: each 2026 10-Q changes 2025's figures, as a
  // second restatement would, so 2026's six months less its first quarter stays out too. 2025's
  // restated quarters, and 2024's fourth, stay out; 2023's fourth, which no filing changed, is worked out.
  assert.deepEqual(await cashQuarters("ONCE"), [
    "2026-03-31:90",
    "2025-03-31:90",
    "2024-09-30:100*",
    "2024-06-30:100*",
    "2024-03-31:100",
    "2023-12-31:100*",
    "2023-09-30:100*",
    "2023-06-30:100*",
    "2023-03-31:100",
    "2022-12-31:100*",
  ]);
  // Thousands re-rounded to millions change figures too: 2026's second quarter stays out, and every
  // other is 100 a quarter in 2026 and 100.123 before.
  assert.deepEqual(await cashQuarters("PREC", 2), ["2026-03-31:100", "2025-03-31:100"]);
  assert.ok((await cashQuarters("PREC")).every((q) => /:100(\.123)?\*?$/.test(q)));
  // A 10-K that repeats an old year as already restated changes nothing: its own fourth quarter is worked out.
  assert.deepEqual(await cashQuarters("OLDR", 4), ["2025-03-31:100", "2024-12-31:100*", "2024-09-30:100*", "2024-06-30:100*"]);
});

test("SEC EDGAR: no quarter is worked out across a second restatement, one an amendment repeats, or one filed between its two values", async () => {
  // 2025's fourth quarter would be its year restated again (320) less its nine months restated once
  // (270): 50, true on no basis (90 as first reported, 80 restated). The same when the first change
  // was made in 2025's 10-Qs.
  for (const ticker of ["TWCE", "TWQS"]) assert.deepEqual(await cashQuarters(ticker, 4), ["2026-03-31:80", "2025-03-31:80", "2024-03-31:90", "2023-09-30:100*"], ticker);
  // A 10-K/A that re-files the restating 10-K: its year (360) less the old nine months (300) would be 60.
  assert.deepEqual(await cashQuarters("AMND", 4), ["2026-03-31:90", "2025-03-31:90", "2024-09-30:100*", "2024-06-30:100*"]);
  // A 10-Q/A that re-files the restating Q2 10-Q: its six months (180) less the old first quarter (100)
  // would be 80. 2025's fourth quarter, which no filing between its year and nine months changed, is shown.
  assert.deepEqual(await cashQuarters("QAMD", 4), ["2026-03-31:100", "2025-12-31:100*", "2025-03-31:100", "2024-12-31:100*"]);
  // A restating 10-K/A filed between the nine months and the year's 10-K, which repeats it: 360 less 300 would be 60.
  assert.deepEqual(await cashQuarters("MIDA", 4), ["2026-03-31:90", "2025-03-31:90", "2024-09-30:100*", "2024-06-30:100*"]);
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
  // A reply stopped while it waits for the next window stops waiting at once.
  const stop = new AbortController();
  const waiting = Date.now();
  setTimeout(() => stop.abort(), 50);
  assert.equal(await takeSlot("full", 5, 60_000, { waitMs: 120_000, now: () => 0, signal: stop.signal }), false);
  assert.ok(Date.now() - waiting < 1000, `${Date.now() - waiting} ms`);
  // One already stopped takes no slot, even a free one.
  assert.equal(await takeSlot("free-window", 5, 60_000, { signal: stop.signal }), false);
  assert.deepEqual(await all("SELECT key FROM rate_limits WHERE key LIKE 'source:free-window:%'"), []);

  const ledger = new R.ToolLedger();
  assert.deepEqual([ledger.take("sec"), ledger.take("sec"), ledger.take("sec"), ledger.take("sec")], [true, true, true, false]);
});

test("a stopped reply asks SearXNG, the SEC and FRED nothing and takes none of their daily requests, also when it stops while it waits its turn", async () => {
  // The company is known already, from an earlier reply.
  await secFilingsTool().run({ company: "AAPL" });
  await sql("DELETE FROM source_cache WHERE key LIKE 'sec:filings:%'");
  for (const table of ["free_quota", "rate_limits"]) await sql(`DELETE FROM ${table}`);
  seen.length = 0;
  const daily = () => all("SELECT provider, requests FROM free_quota");
  const [search, filings, series] = [webSearchTool("u-stop")!, secFilingsTool(), fredSeriesTool()];
  const look = (signal: AbortSignal) =>
    Promise.all([search.run({ query: "news today" }, signal), filings.run({ company: "AAPL" }, signal), series.run({ series_id: "UNRATE" }, signal)]).then((r) => r.map((x) => x.text));
  const failed = [R.SEARCH_FAILED, R.SEC_FAILED, R.FRED_FAILED];
  const stopped = new AbortController();
  stopped.abort("stop");
  assert.deepEqual(await look(stopped.signal), failed);
  assert.deepEqual(seen, []);
  assert.deepEqual(await daily(), []);
  assert.deepEqual(await all("SELECT key FROM rate_limits"), [], "no slot either");
  // Every slot taken for the next 12 seconds: stopped while it waits for one, each ends at once, with none of the day's requests.
  const second = Math.floor(Date.now() / 1000);
  for (const [source, per] of [["searxng", 5], ["sec", 5], ["fred", 1]] as const) {
    for (let w = second; w <= second + 12; w++) await sql("INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)", [`source:${source}:${w}`, per, (w + 1) * 1000]);
  }
  const stop = new AbortController();
  setTimeout(() => stop.abort("stop"), 100);
  const begun = Date.now();
  assert.deepEqual(await look(stop.signal), failed);
  assert.ok(Date.now() - begun < 2000, `${Date.now() - begun} ms`);
  assert.deepEqual(seen, []);
  assert.deepEqual(await daily(), []);
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

test("FRED: a series FRED tags as copyrighted is refused though its notes don't say so, and one whose tags can't be read isn't shown", async () => {
  const tool = fredSeriesTool();
  // FRED's 1 a second is shown elsewhere: each step here starts with it free.
  const fresh = async () => {
    await sql("DELETE FROM rate_limits");
    seen.length = 0;
  };
  const refused = await tool.run({ series_id: "OBMMIJUMBO30YF" });
  assert.deepEqual([refused.text, refused.isError, refused.used, refused.notice], [R.FRED_COPYRIGHT, true, false, undefined]);
  assert.equal(seen.find((s) => s.path === "/series/tags")!.query.get("series_id"), "OBMMIJUMBO30YF");
  assert.equal(seen.some((s) => s.path === "/series/observations"), false, "its values were never asked for");
  // Kept with the series' details: asked again, FRED isn't.
  await fresh();
  assert.equal((await tool.run({ series_id: "OBMMIJUMBO30YF" })).text, R.FRED_COPYRIGHT);
  assert.equal(seen.length, 0);
  // What the tags say is kept a day, longer than the details: once the details are read again, the tags aren't.
  await sql("DELETE FROM source_cache WHERE key LIKE 'fred:series:%'");
  assert.equal((await tool.run({ series_id: "OBMMIJUMBO30YF" })).text, R.FRED_COPYRIGHT);
  assert.deepEqual(seen.map((s) => s.path), ["/series"]);
  // Copyrighted by its notes already: the tags aren't asked for.
  await fresh();
  await tool.run({ series_id: "SP500" });
  assert.equal(seen.some((s) => s.path === "/series/tags"), false);
  // Tags that fail, or come back without a list: a public series isn't shown either, nor remembered as checked.
  for (const how of ["fail", "malformed"] as const) {
    await sql("DELETE FROM source_cache");
    await fresh();
    fredTags = how;
    const unchecked = await tool.run({ series_id: "UNRATE" });
    assert.deepEqual([unchecked.text, unchecked.isError, unchecked.used], [R.FRED_FAILED, true, false], how);
    assert.equal(seen.some((s) => s.path === "/series/observations"), false, how);
  }
  fredTags = "ok";
  await fresh();
  assert.equal((await tool.run({ series_id: "UNRATE", count: 3 })).used, true);
  // FRED marks it a third party's: once the day the tags are kept for is over, it's refused, though its
  // details (which say nothing of the tags) are still kept.
  const was = TAGS.UNRATE;
  TAGS.UNRATE = [...was, "copyrighted: citation required"];
  try {
    await sql("DELETE FROM source_cache WHERE key LIKE 'fred:tags:%'");
    await fresh();
    assert.equal((await tool.run({ series_id: "UNRATE", count: 3 })).text, R.FRED_COPYRIGHT);
    assert.deepEqual(seen.map((s) => s.path), ["/series/tags"], "the details came from the cache");
  } finally {
    TAGS.UNRATE = was;
  }
  // A reply already stopped asks FRED nothing, and takes no slot and none of the day's requests.
  await sql("DELETE FROM source_cache");
  await fresh();
  const stopped = new AbortController();
  stopped.abort("stop");
  assert.equal((await tool.run({ series_id: "UNRATE" }, stopped.signal)).text, R.FRED_FAILED);
  assert.equal(seen.length, 0);
  assert.deepEqual(await all("SELECT key FROM rate_limits WHERE key LIKE 'source:fred:%'"), []);
  noSecrets(refused);
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
