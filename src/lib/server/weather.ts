import { one, run } from "./db.ts";
import { cleanPlace, NO_DATA, parseMet, validateWeatherInput, weatherAnswer, type Forecast, type MetStep, type WeatherTool } from "../weather.ts";
import type { Where } from "../context-note.ts";
import { english, type Translate } from "../i18n.ts";
import type { Source } from "../types.ts";

/*
 * MET Norway's Locationforecast 2.0, fetched on the server for the get_weather tool. It's free, needs
 * no key or account (so it can't bill), and its terms allow commercial use with credit. Its terms are
 * kept: an identifying User-Agent, no new request for a place before the last reply's Expires, and
 * If-Modified-Since after it. Replies are kept in Turso (weather_cache), shared by every server and
 * every user in the same ~1 km cell, and a daily cap well above real use guards against a runaway loop.
 */

const MET_BASE = "https://api.met.no/weatherapi/locationforecast/2.0";
/** At most this many requests to MET a day across Flash (MET asks for under 20 a second; the cache keeps real use far below). */
export const MET_DAILY_REQUESTS = 50_000;
const HOUR = 3_600_000;
// A cached forecast may stand in for a failed update for this long, marked as old.
const STALE_FOR = 6 * HOUR;
// Rows nobody asked for in this long are deleted, at most once an hour on each server.
const KEEP_FOR = 48 * HOUR;
const PRUNE_EVERY = HOUR;
let prunedAt = 0;
let warnedDeprecated = false;

/** Who Flash is to MET: without an identifying User-Agent MET refuses the request. */
export const metUserAgent = () => `FlashAI/1.0 (+https://www.flash-app.dev; ${process.env.FLASH_CONTACT_EMAIL || "support@flash-app.dev"})`;

/** Coordinates rounded to 2 decimals: a ~1 km cell, shared by everyone in it (MET allows at most 4). */
const round2 = (n: number) => Math.round(n * 100) / 100 || 0;

/** Takes one request from MET's daily allowance, or returns false when it's used up. */
export async function reserveMet(now = Date.now()): Promise<boolean> {
  const day = new Date(now).toISOString().slice(0, 10);
  await run("INSERT OR IGNORE INTO free_quota (day, provider) VALUES (?, 'met')", [day]);
  const r = await run("UPDATE free_quota SET requests = requests + 1 WHERE day = ? AND provider = 'met' AND requests < ?", [day, MET_DAILY_REQUESTS]);
  return r.rowsAffected === 1;
}

type Row = { series: string; updated_at: number; expires_at: number; last_modified: string; fetched_at: number };

function readRow(row: Row): Forecast | null {
  try {
    const series = JSON.parse(row.series) as MetStep[];
    return Array.isArray(series) && series.length ? { series, updatedAt: Number(row.updated_at) } : null;
  } catch {
    return null;
  }
}

/** When to ask MET again: its Expires, or in 30 minutes when it sent none, and never sooner than a minute. */
function expiresAt(header: string | null, now: number): number {
  const at = header ? Date.parse(header) : NaN;
  return Math.max(now + 60_000, Number.isFinite(at) ? at : now + 30 * 60_000);
}

async function prune(now: number) {
  if (now - prunedAt < PRUNE_EVERY) return;
  prunedAt = now;
  await run("DELETE FROM weather_cache WHERE fetched_at < ?", [now - KEEP_FOR]).catch((err) => console.error("[flash] pruning weather_cache failed", err));
}

/**
 * The forecast for a place: from the cache until MET's Expires, then from MET (a 304 keeps the cached
 * steps). When MET can't be reached, is busy or failing, or today's cap is reached, a forecast fetched
 * in the last 6 hours is used, marked stale; otherwise null. base is MET's address (a stand-in in tests).
 */
export async function forecast(latitude: number, longitude: number, now = Date.now(), base = MET_BASE): Promise<Forecast | null> {
  const lat = round2(latitude);
  const lon = round2(longitude);
  const cell = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  // On every ask, cached or not, so old places go even when nobody new is fetched.
  await prune(now);
  const row = await one<Row>("SELECT series, updated_at, expires_at, last_modified, fetched_at FROM weather_cache WHERE cell = ?", [cell]).catch(
    (err) => (console.error("[flash] reading weather_cache failed", err), null),
  );
  const cached = row ? readRow(row) : null;
  if (row && cached && now < Number(row.expires_at)) return cached;
  const fallback = () => (row && cached && now - Number(row.fetched_at) <= STALE_FOR ? { ...cached, stale: { fetchedAt: Number(row.fetched_at) } } : null);
  if (!(await reserveMet(now).catch(() => false))) return fallback();

  let res: Response;
  try {
    res = await fetch(`${base}/complete?lat=${lat}&lon=${lon}`, {
      headers: { "User-Agent": metUserAgent(), ...(cached && row?.last_modified && { "If-Modified-Since": row.last_modified }) },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return fallback();
  }
  const expires = expiresAt(res.headers.get("expires"), now);
  if (res.status === 304 && cached) {
    await run("UPDATE weather_cache SET expires_at = ?, fetched_at = ? WHERE cell = ?", [expires, now, cell]).catch((err) =>
      console.error("[flash] updating weather_cache failed", err),
    );
    return cached;
  }
  if (res.status !== 200 && res.status !== 203) {
    await res.body?.cancel().catch(() => {});
    return fallback();
  }
  if (res.status === 203 && !warnedDeprecated) {
    // MET's sign that this version of the product will be retired: it still answers.
    warnedDeprecated = true;
    console.error("[flash] MET Norway marked Locationforecast 2.0 deprecated (203): move to the version it names");
  }
  const parsed = parseMet(await res.json().catch(() => null));
  if (!parsed) return fallback();
  await run(
    `INSERT INTO weather_cache (cell, series, updated_at, expires_at, last_modified, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(cell) DO UPDATE SET series = excluded.series, updated_at = excluded.updated_at, expires_at = excluded.expires_at,
       last_modified = excluded.last_modified, fetched_at = excluded.fetched_at`,
    [cell, JSON.stringify(parsed.series), parsed.updatedAt, expires, res.headers.get("last-modified") ?? "", now],
  ).catch((err) => console.error("[flash] saving to weather_cache failed", err));
  return parsed;
}

/** The credit shown under a reply that used MET's data: MET's own wording for changed data, and the licence. */
export const weatherSources = (t: Translate = english): Source[] => [
  { title: t("Based on data from MET Norway"), url: "https://www.met.no/en" },
  { title: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
];

/**
 * The get_weather tool for one request: where is the user's rough place (see where.ts), t the language
 * of the progress line. run never throws: every problem is a text the model can act on. now and base
 * are for tests.
 */
export function weatherTool(where: Where, t: Translate = english, { now = Date.now, base = MET_BASE }: { now?: () => number; base?: string } = {}): WeatherTool {
  return {
    status: (input) => {
      const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
      const place = i.where === "named_place" ? cleanPlace(i.place) : "";
      return place ? t("Checking the forecast for {place}…", { place }) : t("Checking the forecast where you are…");
    },
    run: async (input) => {
      try {
        const checked = validateWeatherInput(input, where);
        if (!checked.ok) return { text: checked.error, isError: true, used: false };
        const at = now();
        return weatherAnswer(await forecast(checked.query.latitude, checked.query.longitude, at, base), checked.query, at);
      } catch (err) {
        console.error("[flash] weather lookup failed", err);
        return { text: NO_DATA, isError: true, used: false };
      }
    },
    sources: weatherSources(t),
  };
}
