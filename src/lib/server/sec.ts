import { cacheGet, cacheKey, cachePut, envCount, failureNote, fetchJson, reserveDaily, SourceError, takeSlot, testBase } from "./source-fetch.ts";
import {
  asObject,
  badInput,
  CONCEPT,
  cleanText,
  companyRef,
  FACT_NAMES,
  fittedWith,
  intIn,
  SEC_FACTS,
  SEC_FAILED,
  SEC_FILINGS,
  validDate,
  type ClientTool,
  type CompanyRef,
  type ToolResult,
} from "../research.ts";
import { english, type Translate } from "../i18n.ts";
import type { Source } from "../types.ts";

/*
 * SEC EDGAR, the SEC's free database of what US public companies file: no key and no account. Its
 * fair-access rules ask for at most 10 requests a second from everyone at Flash together, and a
 * User-Agent naming who asks with a contact address. Flash keeps to 5 a second across every server
 * (see takeSlot) and FLASH_SEC_DAILY_REQUESTS a day (20,000), and keeps what it reads: the ticker
 * list for a day in each server's memory, companies found for a day, filings lists for an hour and
 * reported figures for six hours, in source_cache.
 */

const SEC_WWW = "https://www.sec.gov";
const SEC_DATA = "https://data.sec.gov";
/** The SEC asks for under 10 a second; Flash keeps to half. */
export const SEC_PER_SECOND = 5;
const TIMEOUT_MS = 10_000;
const HOUR = 3_600_000;
const TICKERS_FOR = 24 * HOUR;
const FILINGS_FOR = HOUR;
const FACTS_FOR = 6 * HOUR;
// The most each reply may read: the ticker list is about 1 MB, a big company's facts about 20 MB.
const TICKERS_BYTES = 8_000_000;
const SUBMISSIONS_BYTES = 12_000_000;
const CONCEPT_BYTES = 6_000_000;
const FACTS_BYTES = 40_000_000;
// Filings kept from a company's list, and years of figures kept.
const KEEP_FILINGS = 300;
const KEEP_YEARS = 12;

/** Who Flash is to the SEC, as its fair-access rules ask: a name and a contact address. */
export function secUserAgent(): string {
  const email = (process.env.FLASH_CONTACT_EMAIL ?? "").trim();
  const usable = email.length <= 100 && email.includes("@") && !/[\s<>"(),;]/.test(email);
  return `Flash AI ${usable ? email : "support@flash-app.dev"}`;
}

/** The SEC's addresses: www for the ticker list, data for the APIs (one stand-in for both in a local check). */
function bases(): { www: string; data: string } {
  const test = testBase("FLASH_TEST_SEC_URL");
  return test ? { www: test, data: test } : { www: SEC_WWW, data: SEC_DATA };
}

/** One request to the SEC, within Flash's daily allowance and 5 a second. */
async function secGet(url: string, maxBytes: number, signal?: AbortSignal): Promise<unknown> {
  if (!(await reserveDaily("sec", envCount("FLASH_SEC_DAILY_REQUESTS", 20_000)))) throw new SourceError("busy");
  if (!(await takeSlot("sec", SEC_PER_SECOND, 1000))) throw new SourceError("busy");
  return fetchJson(url, { headers: { "User-Agent": secUserAgent() }, timeoutMs: TIMEOUT_MS, maxBytes, signal });
}

// ---------------------------------------------------------------------------------------------
// Companies

export type Company = { cik: string; ticker: string; name: string };
type Listed = Company & { plain: string };

// Words a company's name may or may not carry: "Apple Inc." and "apple" are the same company.
const NAME_FILLER = new Set(["inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "limited", "plc", "holdings", "holding", "group", "the", "sa", "nv", "ag", "se", "llc", "lp", "de", "com"]);
/** A name as Flash compares it: lower case, letters and digits, without "Inc", "Corp" and the like. */
export const plainName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w && !NAME_FILLER.has(w))
    .join(" ");

const pad = (cik: number | string) => String(cik).padStart(10, "0");

let tickers: { list: Listed[]; at: number } | null = null;
let loading: Promise<Listed[]> | null = null;

/** Forgets the ticker list (for tests). */
export const forgetTickers = () => {
  tickers = null;
  loading = null;
};

/** The SEC's list of companies and their tickers, biggest first, read at most once a day on each server. */
async function tickerList(at: number): Promise<Listed[]> {
  if (tickers && at - tickers.at < TICKERS_FOR) return tickers.list;
  // Shared by the calls waiting for it, so it isn't stopped by one reply's signal.
  loading ??= (async () => {
    const json = asObject(await secGet(`${bases().www}/files/company_tickers.json`, TICKERS_BYTES));
    const list: Listed[] = [];
    for (const raw of Object.values(json ?? {})) {
      const row = asObject(raw);
      const cik = Number(row?.cik_str);
      const ticker = typeof row?.ticker === "string" ? row.ticker.toUpperCase() : "";
      const name = cleanText(row?.title, 120);
      if (!Number.isInteger(cik) || cik <= 0 || cik >= 1e10 || !ticker || !name) continue;
      list.push({ cik: pad(cik), ticker, name, plain: plainName(name) });
    }
    if (!list.length) throw new SourceError("bad_json");
    return list;
  })().finally(() => {
    loading = null;
  });
  const list = await loading;
  tickers = { list, at };
  return list;
}

const strip = ({ cik, ticker, name }: Listed): Company => ({ cik, ticker, name });

/** The company a name means: the same name, then a name that starts with it, then one that has it as words; the biggest first. */
export function findByName(list: Listed[], name: string): Company | null {
  const want = plainName(name);
  if (!want) return null;
  const hit = list.find((c) => c.plain === want) ?? list.find((c) => c.plain.startsWith(`${want} `)) ?? list.find((c) => ` ${c.plain} `.includes(` ${want} `));
  return hit ? strip(hit) : null;
}

/** The company a model named, or null when EDGAR has none by that ticker, CIK or name. */
export async function resolveCompany(ref: CompanyRef, at = Date.now()): Promise<Company | null> {
  const key = cacheKey("sec:company", ref.kind, ref.kind === "name" ? plainName(ref.value) : ref.value);
  const cached = await cacheGet<Company>(key, at);
  if (cached) return cached;
  const list = await tickerList(at);
  let found: Company | null = null;
  if (ref.kind === "cik") {
    const hit = list.find((c) => c.cik === ref.value);
    found = hit ? strip(hit) : { cik: ref.value, ticker: "", name: "" };
  } else if (ref.kind === "ticker") {
    // The list writes share classes with a dash: BRK-B.
    const ticker = ref.value.replace(".", "-");
    const hit = list.find((c) => c.ticker === ticker);
    // A short word in lower case may be a name ("apple"), not a ticker.
    found = hit ? strip(hit) : findByName(list, ref.value);
  } else {
    found = findByName(list, ref.value);
  }
  if (found && found.name) await cachePut(key, found, TICKERS_FOR, at);
  return found;
}

// ---------------------------------------------------------------------------------------------
// Filings

type Filing = { form: string; filed: string; period: string; accession: string; doc: string; about: string };
type FilingList = { name: string; tickers: string[]; filings: Filing[] };

const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const DOCUMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
const FORM = /^[A-Z0-9][A-Z0-9 /-]{0,14}$/;

/** A filing's page on EDGAR: its main document, or its index when the document's name is unusual. */
export function filingUrl(cik: string, accession: string, doc = ""): string {
  const folder = `${SEC_WWW}/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}`;
  return DOCUMENT.test(doc) && !doc.includes("..") ? `${folder}/${doc}` : `${folder}/${accession}-index.htm`;
}

const column = (recent: Record<string, unknown> | null, name: string): unknown[] => (Array.isArray(recent?.[name]) ? (recent![name] as unknown[]) : []);

/** A company's name and recent filings, newest first, from the cache or EDGAR. Throws a SourceError. */
async function filingsOf(cik: string, at: number, signal?: AbortSignal): Promise<FilingList> {
  const key = `sec:filings:${cik}`;
  const cached = await cacheGet<FilingList>(key, at);
  if (cached) return cached;
  const json = asObject(await secGet(`${bases().data}/submissions/CIK${cik}.json`, SUBMISSIONS_BYTES, signal));
  const recent = asObject(asObject(json?.filings)?.recent);
  const forms = column(recent, "form");
  const filed = column(recent, "filingDate");
  const periods = column(recent, "reportDate");
  const accessions = column(recent, "accessionNumber");
  const docs = column(recent, "primaryDocument");
  const abouts = column(recent, "primaryDocDescription");
  const filings: Filing[] = [];
  for (let i = 0; i < forms.length && filings.length < KEEP_FILINGS; i++) {
    const form = typeof forms[i] === "string" ? (forms[i] as string).toUpperCase() : "";
    const date = validDate(filed[i]);
    const accession = typeof accessions[i] === "string" ? (accessions[i] as string) : "";
    if (!FORM.test(form) || !date || !ACCESSION.test(accession)) continue;
    filings.push({
      form,
      filed: date,
      period: validDate(periods[i]) ?? "",
      accession,
      doc: typeof docs[i] === "string" ? (docs[i] as string) : "",
      about: cleanText(abouts[i], 80),
    });
  }
  filings.sort((a, b) => b.filed.localeCompare(a.filed));
  const list: FilingList = {
    name: cleanText(json?.name, 120),
    tickers: (Array.isArray(json?.tickers) ? json.tickers : []).filter((x): x is string => typeof x === "string").slice(0, 5).map((x) => cleanText(x, 10)),
    filings,
  };
  await cachePut(key, list, FILINGS_FOR, at);
  return list;
}

// ---------------------------------------------------------------------------------------------
// Reported figures (XBRL)

/** One reported value, compact: [start ("" for a point in time), end, value, form, filed, accession]. */
type Row = [string, string, number, string, string, string];
/** A tag's values by unit, or none when the company never reported it. */
type Series = { label: string; units: Record<string, Row[]> } | { none: true };

const ANNUAL_FORMS = new Set(["10-K", "10-K/A", "10-KT", "20-F", "20-F/A", "40-F", "40-F/A"]);
const QUARTER_FORMS = new Set(["10-Q", "10-Q/A", "10-K", "10-K/A", "10-KT"]);
const ALL_FORMS = new Set([...ANNUAL_FORMS, ...QUARTER_FORMS]);
const UNIT = /^[A-Za-z][A-Za-z0-9/_-]{0,30}$/;
const MAX_UNITS = 3;

/** A tag's data as EDGAR sends it (companyconcept, or one entry of companyfacts), cut to what Flash reads. */
function readSeries(raw: unknown, at: number): Series {
  const concept = asObject(raw);
  const units = asObject(concept?.units);
  if (!concept || !units) return { none: true };
  const since = `${new Date(at).getUTCFullYear() - KEEP_YEARS}-01-01`;
  const kept: Record<string, Row[]> = {};
  for (const [unit, list] of Object.entries(units)) {
    if (Object.keys(kept).length >= MAX_UNITS || !UNIT.test(unit) || !Array.isArray(list)) continue;
    const rows: Row[] = [];
    for (const item of list) {
      const r = asObject(item);
      const end = validDate(r?.end);
      const start = r?.start === undefined ? "" : validDate(r.start);
      const form = typeof r?.form === "string" ? r.form : "";
      const filed = validDate(r?.filed);
      const accn = typeof r?.accn === "string" && ACCESSION.test(r.accn) ? r.accn : "";
      const val = r?.val;
      if (!end || start === null || end < since || !ALL_FORMS.has(form) || !filed || !accn || typeof val !== "number" || !Number.isFinite(val)) continue;
      rows.push([start, end, val, form, filed, accn]);
    }
    if (rows.length) kept[unit] = rows;
  }
  return Object.keys(kept).length ? { label: cleanText(concept.label, 120), units: kept } : { none: true };
}

/** A tag as taxonomy and name: "us-gaap:Revenues" → ["us-gaap", "Revenues"]. */
function splitTag(tag: string): [string, string] {
  const m = CONCEPT.exec(tag);
  return m ? [m[1] ?? "us-gaap", m[2]] : ["us-gaap", tag];
}

const seriesKey = (cik: string, tag: string) => `sec:tag:${cik}:${tag}`;

/**
 * The data of each tag for a company, from the cache, else from EDGAR: one tag from companyconcept,
 * several from companyfacts in one request (or one by one when that is too big). Throws a SourceError.
 */
async function seriesOf(cik: string, tags: string[], at: number, signal?: AbortSignal): Promise<Map<string, Series>> {
  const found = new Map<string, Series>();
  const cached = await Promise.all(tags.map((tag) => cacheGet<Series>(seriesKey(cik, tag), at)));
  tags.forEach((tag, i) => cached[i] && found.set(tag, cached[i]));
  let missing = tags.filter((tag) => !found.has(tag));
  const keep = async (tag: string, series: Series) => {
    found.set(tag, series);
    await cachePut(seriesKey(cik, tag), series, FACTS_FOR, at);
  };
  if (missing.length > 1) {
    try {
      const facts = asObject(asObject(await secGet(`${bases().data}/api/xbrl/companyfacts/CIK${cik}.json`, FACTS_BYTES, signal))?.facts);
      await Promise.all(
        missing.map((tag) => {
          const [taxonomy, name] = splitTag(tag);
          return keep(tag, readSeries(asObject(facts?.[taxonomy])?.[name], at));
        }),
      );
      missing = [];
    } catch (err) {
      // A company that never filed figures has none; one whose figures are too big to read at once is read tag by tag.
      if (err instanceof SourceError && err.status === 404) {
        await Promise.all(missing.map((tag) => keep(tag, { none: true })));
        missing = [];
      } else if (!(err instanceof SourceError && err.reason === "too_big")) throw err;
    }
  }
  for (const tag of missing) {
    const [taxonomy, name] = splitTag(tag);
    try {
      await keep(tag, readSeries(await secGet(`${bases().data}/api/xbrl/companyconcept/CIK${cik}/${taxonomy}/${name}.json`, CONCEPT_BYTES, signal), at));
    } catch (err) {
      if (err instanceof SourceError && err.status === 404) await keep(tag, { none: true });
      else throw err;
    }
  }
  return found;
}

const DAY = 86_400_000;
const days = (start: string, end: string) => (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY;

/** Whether a value covers a fiscal year (or is a balance at a year's end), or a quarter (or a balance at a quarter's end). */
function fitsPeriod([start, end, , form]: Row, period: "annual" | "quarterly"): boolean {
  if (period === "annual") return ANNUAL_FORMS.has(form) && (!start || (days(start, end) >= 340 && days(start, end) <= 390));
  return start ? days(start, end) >= 80 && days(start, end) <= 100 : QUARTER_FORMS.has(form);
}

// The unit to show when a tag has several: dollars, dollars a share, shares, then the first.
const UNIT_ORDER = ["USD", "USD/shares", "shares"];
const unitOf = (units: Record<string, Row[]>) => UNIT_ORDER.find((u) => units[u]) ?? Object.keys(units)[0];

type Picked = { concept: string; tags: string[]; label: string; unit: string; rows: Row[]; tagOf: string[] };

/**
 * The newest values of one figure: the candidates' values in their order (an earlier tag wins a
 * period both report), one per period end, the latest filing of each, newest first.
 */
function pickFigure(concept: string, candidates: string[], series: Map<string, Series>, period: "annual" | "quarterly", count: number): Picked {
  const byEnd = new Map<string, { row: Row; tag: string }>();
  let unit = "";
  let label = "";
  for (const tag of candidates) {
    const s = series.get(tag);
    if (!s || "none" in s) continue;
    unit ||= unitOf(s.units);
    label ||= s.label;
    const rows = (s.units[unit] ?? []).filter((r) => fitsPeriod(r, period));
    const latest = new Map<string, Row>();
    for (const r of rows) {
      const was = latest.get(r[1]);
      if (!was || r[4] > was[4]) latest.set(r[1], r);
    }
    for (const [end, row] of latest) if (!byEnd.has(end)) byEnd.set(end, { row, tag });
  }
  const newest = [...byEnd.values()].sort((a, b) => b.row[1].localeCompare(a.row[1])).slice(0, count);
  return { concept, tags: [...new Set(newest.map((x) => x.tag))], label, unit, rows: newest.map((x) => x.row), tagOf: newest.map((x) => x.tag) };
}

/** What a model asked for, as tags to look for: a name Flash knows, or an exact tag. */
export function conceptTags(value: unknown): { concept: string; tags: string[] } | null {
  if (typeof value !== "string") return null;
  const asked = value.trim();
  const named = asked.toLowerCase().replace(/[\s-]+/g, "_");
  if (FACT_NAMES[named]) return { concept: named, tags: FACT_NAMES[named] };
  const m = CONCEPT.exec(asked);
  if (!m) return null;
  const tag = `${m[1] ?? "us-gaap"}:${m[2]}`;
  return { concept: tag, tags: [tag] };
}

// ---------------------------------------------------------------------------------------------
// The tools

/** What the model reads when a company can't be found. */
const notFound = (ref: CompanyRef) =>
  `SEC EDGAR has no company matching "${ref.value}". Ask the user for the stock ticker, or answer without SEC data (and say you couldn't find it there).`;

/** A failure, logged without the address, as the model reads it. */
function failed(err: unknown): ToolResult {
  console.error(`[flash] SEC EDGAR look-up failed: ${failureNote(err)}`);
  return { text: SEC_FAILED, isError: true, used: false };
}

const filingSource = (name: string, cik: string, f: { form: string; filed: string; accession: string; doc?: string }): Source => ({
  title: `SEC EDGAR · ${name} · ${f.form} · ${f.filed}`,
  url: filingUrl(cik, f.accession, f.doc),
});

/** The forms a model asked for, or the default; null when they aren't form names. */
function formsOf(value: unknown): string[] | null {
  if (value === undefined || value === null) return ["10-K", "10-Q", "8-K"];
  if (!Array.isArray(value) || !value.length || value.length > 8) return null;
  const forms = value.map((f) => (typeof f === "string" ? f.trim().toUpperCase() : ""));
  return forms.every((f) => FORM.test(f)) ? [...new Set(forms)] : null;
}

/** sec_company_filings for one reply. now is for tests. */
export function secFilingsTool(t: Translate = english, { now = Date.now }: { now?: () => number } = {}): ClientTool {
  return {
    ...SEC_FILINGS,
    family: "sec",
    status: (input) => {
      const company = cleanText(asObject(input)?.company, 40);
      return company ? t("Looking up {company} on SEC EDGAR…", { company }) : t("Looking…");
    },
    run: async (input, signal) => {
      const i = asObject(input);
      const ref = companyRef(i?.company);
      if (!ref) return { text: badInput(SEC_FILINGS.name, "company must be a stock ticker like AAPL, a company's name or a CIK"), isError: true, used: false };
      const forms = formsOf(i?.forms);
      if (!forms) return { text: badInput(SEC_FILINGS.name, 'forms must be a list of form names like ["10-K", "8-K"]'), isError: true, used: false };
      const limit = intIn(i?.limit, 1, 20, 10);
      if (limit === null) return { text: badInput(SEC_FILINGS.name, "limit must be a whole number from 1 to 20"), isError: true, used: false };
      const at = now();
      try {
        const company = await resolveCompany(ref, at);
        if (!company) return { text: notFound(ref), isError: true, used: false };
        const data = await filingsOf(company.cik, at, signal);
        const name = data.name || company.name || `CIK ${company.cik}`;
        const ticker = company.ticker || data.tickers[0] || "";
        const list = data.filings.filter((f) => forms.includes(f.form)).slice(0, limit);
        const head = { company: name, cik: company.cik, ...(ticker && { ticker }) };
        if (!list.length) {
          return { text: JSON.stringify({ ...head, filings: [], note: `None of its recent filings on EDGAR is a ${forms.join(", ")}.` }), isError: false, used: false };
        }
        const fit = fittedWith(list.length, (n) =>
          JSON.stringify({
            ...head,
            filings: list.slice(0, n).map((f) => ({
              form: f.form,
              filed: f.filed,
              ...(f.period && { period: f.period }),
              ...(f.about && { about: f.about }),
              url: filingUrl(company.cik, f.accession, f.doc),
            })),
            note: "Newest first, from SEC EDGAR. Link a filing with its url.",
          }),
        );
        if (!fit?.n) return failed(new SourceError("too_big"));
        return {
          text: fit.text,
          isError: false,
          used: true,
          sources: list.slice(0, Math.min(fit.n, 3)).map((f) => filingSource(name, company.cik, f)),
        };
      } catch (err) {
        if (err instanceof SourceError && err.status === 404) return { text: `SEC EDGAR has no filings for ${ref.value}.`, isError: true, used: false };
        return failed(err);
      }
    },
  };
}

/** sec_financial_facts for one reply. now is for tests. */
export function secFactsTool(t: Translate = english, { now = Date.now }: { now?: () => number } = {}): ClientTool {
  return {
    ...SEC_FACTS,
    family: "sec",
    status: (input) => {
      const company = cleanText(asObject(input)?.ticker, 40);
      return company ? t("Getting {company}'s reported figures from SEC EDGAR…", { company }) : t("Looking…");
    },
    run: async (input, signal) => {
      const i = asObject(input);
      const bad = (reason: string): ToolResult => ({ text: badInput(SEC_FACTS.name, reason), isError: true, used: false });
      const ref = companyRef(i?.ticker);
      if (!ref) return bad("ticker must be a stock ticker like AAPL, a company's name or a CIK");
      const asked = Array.isArray(i?.concepts) ? i.concepts : typeof i?.concepts === "string" ? [i.concepts] : [];
      if (!asked.length || asked.length > 4) return bad(`concepts must be 1 to 4 of ${Object.keys(FACT_NAMES).join(", ")}, or exact tags like "us-gaap:Revenues"`);
      const concepts = asked.map(conceptTags);
      if (concepts.some((c) => !c)) return bad(`each concept must be one of ${Object.keys(FACT_NAMES).join(", ")}, or an exact tag like "us-gaap:Revenues"`);
      const period = i?.period === "quarterly" ? "quarterly" : i?.period === undefined || i.period === "annual" ? "annual" : null;
      if (!period) return bad('period must be "annual" or "quarterly"');
      const count = intIn(i?.count, 1, 10, period === "annual" ? 5 : 4);
      if (count === null) return bad("count must be a whole number from 1 to 10");
      const at = now();
      try {
        const company = await resolveCompany(ref, at);
        if (!company) return { text: notFound(ref), isError: true, used: false };
        const wanted = concepts as { concept: string; tags: string[] }[];
        const tags = [...new Set(wanted.flatMap((c) => c.tags))];
        const series = await seriesOf(company.cik, tags, at, signal);
        const figures = wanted.map((c) => pickFigure(c.concept, c.tags, series, period, count));
        const name = company.name || `CIK ${company.cik}`;
        if (figures.every((f) => !f.rows.length)) {
          return {
            text: JSON.stringify({
              company: name,
              cik: company.cik,
              period,
              facts: [],
              note: `EDGAR has no ${period} values of ${wanted.map((c) => c.concept).join(", ")} for this company (it may report them under other tags, or not as a US filer). Say so; give no figures from memory as if they were checked.`,
            }),
            isError: false,
            used: false,
          };
        }
        const fit = fittedWith(count, (n) =>
          JSON.stringify({
            company: name,
            cik: company.cik,
            ...(company.ticker && { ticker: company.ticker }),
            period,
            facts: figures.map((f) => ({
              concept: f.concept,
              ...(f.label && { label: f.label }),
              ...(f.tags.length === 1 && { tag: f.tags[0] }),
              unit: f.unit,
              values: f.rows.slice(0, n).map((r, k) => ({
                ...(r[0] && { start: r[0] }),
                end: r[1],
                value: r[2],
                form: r[3],
                filed: r[4],
                ...(f.tags.length > 1 && { tag: f.tagOf[k] }),
              })),
              ...(!f.rows.length && { note: "Not reported under these tags." }),
            })),
            note:
              "As reported to the SEC (XBRL), newest first; amounts in the unit shown (USD is dollars, not thousands). The period is start to end: " +
              "a fiscal year may not match the calendar year." +
              (period === "quarterly" ? " A fourth quarter is often only in the annual report, so it may be missing." : ""),
          }),
        );
        if (!fit?.n) return failed(new SourceError("too_big"));
        // The filings the values shown came from, the latest first.
        const filings = new Map<string, Row>();
        for (const f of figures) for (const r of f.rows.slice(0, fit.n)) if (!filings.has(r[5])) filings.set(r[5], r);
        const sources = [...filings.values()]
          .sort((a, b) => b[4].localeCompare(a[4]))
          .slice(0, 3)
          .map((r) => filingSource(name, company.cik, { form: r[3], filed: r[4], accession: r[5] }));
        return { text: fit.text, isError: false, used: true, sources };
      } catch (err) {
        return failed(err);
      }
    },
  };
}
