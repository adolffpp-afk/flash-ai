import { cacheGet, cacheKey, cachePut, envCount, failureNote, fetchJson, reserveDaily, SourceError, takeSlot, testBase } from "./source-fetch.ts";
import {
  asObject,
  badInput,
  cleanText,
  fittedWith,
  FREQUENCIES,
  FRED_COPYRIGHT,
  FRED_FAILED,
  FRED_SEARCH,
  FRED_SERIES,
  intIn,
  SERIES_ID,
  TRANSFORMS,
  validDate,
  type ClientTool,
  type ToolResult,
} from "../research.ts";
import { english, type Translate } from "../i18n.ts";

/*
 * FRED, the Federal Reserve Bank of St. Louis's economic data, through its free API: switched on by
 * FRED_API_KEY. Its terms (https://fred.stlouisfed.org/docs/api/terms_of_use.html) are kept: every
 * reply that shows FRED data carries its notice (FRED_NOTE in research.ts), a series a third party
 * owns (its notes say "Copyright") is never shown, nothing suggests the Federal Reserve endorses
 * Flash, and requests stay well under its rate limit: 1 a second across Flash and
 * FLASH_FRED_DAILY_REQUESTS a day (10,000), with series details kept six hours and values an hour.
 * FRED's API takes the key only in the address, so addresses are never logged or shown: a failure
 * is logged by what went wrong alone (see SourceError).
 */

const FRED_BASE = "https://api.stlouisfed.org/fred";
const TIMEOUT_MS = 8000;
const MAX_BYTES = 2_000_000;
const HOUR = 3_600_000;
const SERIES_FOR = 6 * HOUR;
const VALUES_FOR = HOUR;
const SEARCH_FOR = 6 * HOUR;
/** FRED's keys: 32 lower-case letters and digits. */
const KEY = /^[a-z0-9]{32}$/;
const COPYRIGHT = /copyright/i;

/** The FRED key, or null when it isn't set or isn't a FRED key. */
const fredKey = (env: Record<string, string | undefined> = process.env) => {
  const key = env.FRED_API_KEY?.trim() ?? "";
  return KEY.test(key) ? key : null;
};

export const fredReady = (env: Record<string, string | undefined> = process.env) => fredKey(env) !== null;

/** Why FRED_API_KEY can't be used, for the owner dashboard: "" when it can (or isn't set). */
export const fredKeyProblem = (env: Record<string, string | undefined> = process.env) =>
  env.FRED_API_KEY?.trim() && !fredKey(env) ? "FRED_API_KEY must be the 32 letters and digits FRED shows" : "";

/** One request to FRED's API, within Flash's daily allowance and 1 a second. Throws a SourceError. */
async function fredGet(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  const key = fredKey();
  if (!key) throw new SourceError("busy");
  if (!(await reserveDaily("fred", envCount("FLASH_FRED_DAILY_REQUESTS", 10_000)))) throw new SourceError("busy");
  if (!(await takeSlot("fred", 1, 1000, { waitMs: 4000 }))) throw new SourceError("busy");
  const query = new URLSearchParams({ ...params, api_key: key, file_type: "json" });
  return asObject(await fetchJson(`${testBase("FLASH_TEST_FRED_URL") ?? FRED_BASE}${path}?${query}`, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, signal }));
}

/** What Flash keeps of a series' details. copyrighted: its notes say a third party owns it. */
type SeriesInfo = {
  id: string;
  title: string;
  units: string;
  frequency: string;
  adjustment: string;
  from: string;
  to: string;
  updated: string;
  popularity: number;
  copyrighted: boolean;
};

function readInfo(raw: unknown): SeriesInfo | null {
  const s = asObject(raw);
  const id = typeof s?.id === "string" ? s.id : "";
  if (!s || !SERIES_ID.test(id)) return null;
  return {
    id,
    title: cleanText(s.title, 200),
    units: cleanText(s.units, 120),
    frequency: cleanText(s.frequency, 40),
    adjustment: cleanText(s.seasonal_adjustment_short, 20),
    from: validDate(s.observation_start) ?? "",
    to: validDate(s.observation_end) ?? "",
    updated: cleanText(s.last_updated, 30),
    popularity: typeof s.popularity === "number" ? s.popularity : 0,
    copyrighted: COPYRIGHT.test(typeof s.notes === "string" ? s.notes : "") || COPYRIGHT.test(typeof s.title === "string" ? s.title : ""),
  };
}

/** A series' details from the cache or FRED, or null when FRED has no such series. Throws a SourceError. */
async function seriesInfo(id: string, at: number, signal?: AbortSignal): Promise<SeriesInfo | null> {
  const key = `fred:series:${id}`;
  const cached = await cacheGet<SeriesInfo | { none: true }>(key, at);
  if (cached) return "none" in cached ? null : cached;
  let json: Record<string, unknown> | null;
  try {
    json = await fredGet("/series", { series_id: id }, signal);
  } catch (err) {
    // FRED answers an unknown series with 400 ("The series does not exist") or 404.
    if (err instanceof SourceError && (err.status === 400 || err.status === 404)) {
      await cachePut(key, { none: true }, HOUR, at);
      return null;
    }
    throw err;
  }
  const info = readInfo(Array.isArray(json?.seriess) ? json.seriess[0] : null);
  if (!info) throw new SourceError("bad_json");
  await cachePut(key, info, SERIES_FOR, at);
  return info;
}

const FREQUENCY_NAMES: Record<string, string> = { d: "daily", w: "weekly", bw: "biweekly", m: "monthly", q: "quarterly", sa: "semiannual", a: "annual" };
const TRANSFORM_NAMES: Record<string, string> = {
  lin: "",
  chg: "change from the previous value",
  ch1: "change from a year ago",
  pch: "percent change from the previous value",
  pc1: "percent change from a year ago",
  pca: "compounded annual rate of change",
  cch: "continuously compounded rate of change",
  cca: "continuously compounded annual rate of change",
  log: "natural log",
};

type Asked = { id: string; start?: string; end?: string; frequency?: string; units: string; count: number };

/** What the model asked fred_series for, checked, or why it can't be used. */
export function seriesInput(input: unknown): Asked | string {
  const i = asObject(input);
  const id = typeof i?.series_id === "string" ? i.series_id.trim().toUpperCase() : "";
  if (!SERIES_ID.test(id)) return "series_id must be a FRED series id like UNRATE (capitals, digits and _)";
  const start = i?.start === undefined || i.start === null || i.start === "" ? undefined : validDate(i.start);
  const end = i?.end === undefined || i.end === null || i.end === "" ? undefined : validDate(i.end);
  if (start === null || end === null) return "start and end must be dates as YYYY-MM-DD";
  if (start && end && start > end) return "start must be before end";
  const frequency = i?.frequency === undefined || i.frequency === null ? undefined : FREQUENCIES.find((f) => f === i.frequency);
  if (frequency === undefined && i?.frequency !== undefined && i.frequency !== null) return `frequency must be one of ${FREQUENCIES.join(", ")}`;
  const units = i?.units === undefined || i.units === null ? "lin" : TRANSFORMS.find((u) => u === i.units);
  if (!units) return `units must be one of ${TRANSFORMS.join(", ")}`;
  const count = intIn(i?.count, 1, 60, 24);
  if (count === null) return "count must be a whole number from 1 to 60";
  return { id, ...(start && { start }), ...(end && { end }), ...(frequency && { frequency }), units, count };
}

/** A failure, logged without the address (it holds the key), as the model reads it. */
function failed(err: unknown): ToolResult {
  console.error(`[flash] FRED look-up failed: ${failureNote(err)}`);
  return { text: FRED_FAILED, isError: true, used: false };
}

const seriesPage = (id: string) => `https://fred.stlouisfed.org/series/${id}`;

/** fred_series for one reply. now is for tests. */
export function fredSeriesTool(t: Translate = english, { now = Date.now }: { now?: () => number } = {}): ClientTool {
  return {
    ...FRED_SERIES,
    family: "fred",
    status: (input) => {
      const series = cleanText(asObject(input)?.series_id, 40);
      return series ? t("Getting {series} from FRED…", { series }) : t("Looking…");
    },
    run: async (input, signal) => {
      const asked = seriesInput(input);
      if (typeof asked === "string") return { text: badInput(FRED_SERIES.name, asked), isError: true, used: false };
      const at = now();
      try {
        const info = await seriesInfo(asked.id, at, signal);
        if (!info) {
          return { text: `FRED has no series with the id ${asked.id}. Find the id with fred_series_search, or answer without FRED data.`, isError: true, used: false };
        }
        if (info.copyrighted) return { text: FRED_COPYRIGHT, isError: true, used: false };
        const key = cacheKey("fred:values", asked.id, asked.start ?? "", asked.end ?? "", asked.frequency ?? "", asked.units, String(asked.count));
        let values = await cacheGet<[string, number | null][]>(key, at);
        if (!values) {
          let json: Record<string, unknown> | null;
          try {
            json = await fredGet(
              "/series/observations",
              {
                series_id: asked.id,
                sort_order: "desc",
                limit: String(asked.count),
                units: asked.units,
                ...(asked.start && { observation_start: asked.start }),
                ...(asked.end && { observation_end: asked.end }),
                ...(asked.frequency && { frequency: asked.frequency }),
              },
              signal,
            );
          } catch (err) {
            if (err instanceof SourceError && err.status === 400) {
              return {
                text: badInput(FRED_SERIES.name, "FRED refused these options (a frequency can only be lower than the series' own, and the dates must be in its range)"),
                isError: true,
                used: false,
              };
            }
            throw err;
          }
          const list = Array.isArray(json?.observations) ? json.observations : null;
          if (!list) throw new SourceError("bad_json");
          values = [];
          for (const raw of list.slice(0, asked.count)) {
            const o = asObject(raw);
            const date = validDate(o?.date);
            if (!date) continue;
            // FRED writes "." for a date it has no value for.
            const n = typeof o?.value === "string" && o.value !== "." ? Number(o.value) : NaN;
            values.push([date, Number.isFinite(n) ? n : null]);
          }
          await cachePut(key, values, VALUES_FOR, at);
        }
        const shown = values;
        const transform = TRANSFORM_NAMES[asked.units];
        const fit = fittedWith(shown.length, (n) =>
          JSON.stringify({
            series: {
              id: info.id,
              title: info.title,
              units: transform ? `${info.units}, ${transform}` : info.units,
              frequency: asked.frequency ? `${FREQUENCY_NAMES[asked.frequency]} (averaged)` : info.frequency,
              ...(info.adjustment && { seasonal_adjustment: info.adjustment }),
              covers: `${info.from} to ${info.to}`,
              last_updated: info.updated,
            },
            observations: shown.slice(0, n).map(([date, value]) => ({ date, value })),
            note: shown.length
              ? "Newest first, from FRED. null: no value for that date. Give the latest date the data covers."
              : "FRED has no values for these dates. Say so; give no figures from memory as if they were checked.",
          }),
        );
        if (!fit) return failed(new SourceError("too_big"));
        return {
          text: fit.text,
          isError: false,
          used: true,
          sources: [{ title: `FRED® · ${info.title} (${info.id})`, url: seriesPage(info.id) }],
          notice: "fred",
        };
      } catch (err) {
        return failed(err);
      }
    },
  };
}

/** fred_series_search for one reply. now is for tests. */
export function fredSearchTool(t: Translate = english, { now = Date.now }: { now?: () => number } = {}): ClientTool {
  return {
    ...FRED_SEARCH,
    family: "fred",
    finder: true,
    status: (input) => {
      const query = cleanText(asObject(input)?.query, 60);
      return query ? t("Searching FRED for {query}…", { query }) : t("Looking…");
    },
    run: async (input, signal) => {
      const i = asObject(input);
      const query = cleanText(i?.query, 100);
      if (!query) return { text: badInput(FRED_SEARCH.name, "query must be a few words, like unemployment rate"), isError: true, used: false };
      const limit = intIn(i?.limit, 1, 10, 6);
      if (limit === null) return { text: badInput(FRED_SEARCH.name, "limit must be a whole number from 1 to 10"), isError: true, used: false };
      const at = now();
      try {
        const key = cacheKey("fred:search", query.toLowerCase());
        let found = await cacheGet<SeriesInfo[]>(key, at);
        if (!found) {
          const json = await fredGet("/series/search", { search_text: query, limit: "20", order_by: "popularity", sort_order: "desc" }, signal);
          const list = Array.isArray(json?.seriess) ? json.seriess : null;
          if (!list) throw new SourceError("bad_json");
          found = list.map(readInfo).filter((s): s is SeriesInfo => s !== null);
          await cachePut(key, found, SEARCH_FOR, at);
        }
        // Series a third party owns are left out: Flash can't show them.
        const open = found.filter((s) => !s.copyrighted).slice(0, limit);
        const leftOut = found.filter((s) => s.copyrighted).length;
        const fit = fittedWith(open.length, (n) =>
          JSON.stringify({
            query,
            series: open.slice(0, n).map((s) => ({
              id: s.id,
              title: s.title,
              units: s.units,
              frequency: s.frequency,
              ...(s.adjustment && { seasonal_adjustment: s.adjustment }),
              covers: `${s.from} to ${s.to}`,
            })),
            note:
              (open.length ? "Most used first. Call fred_series with an id for its values." : "FRED found no series for this; try other words, or answer without FRED data.") +
              (leftOut ? ` ${leftOut} copyrighted series left out: Flash can't show them.` : ""),
          }),
        );
        if (!fit) return failed(new SourceError("too_big"));
        return { text: fit.text, isError: false, used: open.length > 0, ...(open.length > 0 && { notice: "fred" as const }) };
      } catch (err) {
        return failed(err);
      }
    },
  };
}
