import type Anthropic from "@anthropic-ai/sdk";
import { offsetLabel, placeName, validTimeZone, type Where } from "./context-note.ts";
import { tokensAtMost } from "./tokens.ts";
import type { Source } from "./types.ts";

/*
 * Live weather for the models: the get_weather tool's definition, the checks on what a model asks
 * for, and the short text it gets back, made from MET Norway's Locationforecast 2.0 (free, no key,
 * CC BY 4.0; see server/weather.ts for the fetching and caching). Everything here is pure, so it's
 * tested without a network. The texts the model reads are English: it answers in the user's language.
 */

const WEATHER_DESCRIPTION =
  "Live weather forecast from MET Norway for one place: the next 48 hours hour by hour, then each day's high, low, rain, wind and " +
  "conditions for about 9 days, in the place's local time. Call it for any question about the weather now, today or in the coming days " +
  "(temperature, rain, snow, wind, storms, humidity, UV), or about what the weather means for plans (what to wear, an umbrella, a run, a " +
  "trip, a match). It has no past weather, climate or monthly averages, sea temperatures, air quality or official warnings. With no place " +
  'named, use where "user_location": Flash knows roughly where the user is. For a named place, use where "named_place" with the place\'s ' +
  "English name, region and country, its coordinates, its two-letter country code and its IANA time zone. For several places, call it " +
  "once for each.";

const WEATHER_SCHEMA = {
  type: "object" as const,
  properties: {
    where: {
      type: "string",
      enum: ["user_location", "named_place"],
      description: "user_location when the user names no place; named_place for a place they named.",
    },
    place: {
      type: "string",
      description: 'named_place only: the place\'s name in English with its region and country, like "Kumasi, Ashanti, Ghana".',
    },
    latitude: { type: "number", description: "named_place only: latitude in decimal degrees." },
    longitude: { type: "number", description: "named_place only: longitude in decimal degrees." },
    country: { type: "string", description: "named_place only: two-letter ISO country code, like GH." },
    timezone: { type: "string", description: "named_place only: IANA time zone, like Africa/Accra." },
    units: {
      type: "string",
      enum: ["auto", "metric", "imperial"],
      description: "auto unless the user asked for metric (°C, km/h, mm) or imperial (°F, mph, inches).",
    },
  },
  required: ["where"],
};

/*
 * The tool as Claude gets it. No eager_input_streaming: the input is about 60 tokens, and with it the
 * API skips checking the input, so a broken one would end the stream before the call can be metered.
 */
export const WEATHER_TOOL = {
  name: "get_weather",
  description: WEATHER_DESCRIPTION,
  input_schema: WEATHER_SCHEMA,
} satisfies Anthropic.Beta.BetaTool;

/** The same tool as a function, for the free models' function calling (OpenAI-style and Gemini). */
export const WEATHER_FUNCTION = { name: "get_weather", description: WEATHER_DESCRIPTION, parameters: WEATHER_SCHEMA };

/** Rounds of tool calls a reply may make (the credit hold plans for this many results), and forecasts per reply. */
export const WEATHER_ROUNDS = 2;
export const MAX_FORECASTS = 3;
/** The most a forecast text may be: whole lines, about 1,500 tokens (what the hold counts for each, WEATHER_RESULT_TOKENS). */
export const MAX_FORECAST_CHARS = 4500;
export const MAX_FORECAST_TOKENS = 1500;

// What the model is told when it can't have a forecast. Model-facing, so English.
export const LOCATION_UNKNOWN =
  "Flash doesn't know where the user is. Ask which city or town they want the forecast for, in one short question, and give no weather figures.";
export const NO_DATA =
  "The live forecast couldn't be fetched just now. Tell the user in one sentence that you couldn't get the live forecast, give no " +
  "weather figures, and suggest trying again in a minute.";
export const TOO_MANY = "Only three forecasts fit in one answer. Answer with the ones you have.";
export const badInput = (reason: string) =>
  `That input wasn't usable: ${reason}. Call get_weather again with where "named_place" and the place's name, latitude, longitude, ` +
  'country code and time zone, or with where "user_location".';

/** What a forecast lookup gives the model: its text, whether that is an error, and whether MET's data was used. */
export type WeatherAnswer = { text: string; isError: boolean; used: boolean };

/**
 * A request's forecast tool: the progress line for a call (in the user's language), the lookup itself
 * (which never throws), and the credit for MET's data, shown under a reply that used it.
 */
export type WeatherTool = { status: (input: unknown) => string; run: (input: unknown) => Promise<WeatherAnswer>; sources: Source[] };

// ---------------------------------------------------------------------------------------------
// Units

export type Units = { temperature: "C" | "F"; wind: "km/h" | "mph"; rain: "mm" | "in" };

// The countries that use °F (the US and the places that follow it); the UK gives wind in mph.
const FAHRENHEIT = new Set(["US", "BS", "BZ", "KY", "PW", "FM", "MH", "LR", "PR", "GU", "VI", "AS", "MP"]);

/** The units for a forecast: what the user asked for, else what the user's country uses. */
export function unitsFor(country: string | undefined, asked: unknown = "auto"): Units {
  if (asked === "metric") return { temperature: "C", wind: "km/h", rain: "mm" };
  if (asked === "imperial") return { temperature: "F", wind: "mph", rain: "in" };
  const c = (country ?? "").toUpperCase();
  if (FAHRENHEIT.has(c)) return { temperature: "F", wind: "mph", rain: "in" };
  if (c === "GB") return { temperature: "C", wind: "mph", rain: "mm" };
  return { temperature: "C", wind: "km/h", rain: "mm" };
}

export const temperatureIn = (celsius: number, u: Units) => Math.round(u.temperature === "F" ? (celsius * 9) / 5 + 32 : celsius);
export const windIn = (metresPerSecond: number, u: Units) => Math.round(metresPerSecond * (u.wind === "mph" ? 2.23694 : 3.6));
export const rainIn = (mm: number, u: Units) => (u.rain === "in" ? (mm / 25.4).toFixed(2) : mm.toFixed(1));
const unitsLine = (u: Units) => `°${u.temperature}, ${u.wind}, ${u.rain === "in" ? "inches" : "mm"}`;

// ---------------------------------------------------------------------------------------------
// MET's symbols and directions

const PLAIN_SYMBOLS: Record<string, string> = {
  clearsky: "clear sky",
  fair: "fair",
  partlycloudy: "partly cloudy",
  cloudy: "cloudy",
  fog: "fog",
};

/** MET's symbol_code in words: "lightssleetshowersandthunder_day" is "light sleet showers and thunder". */
export function symbolWords(code: string): string {
  const base = code.replace(/_(day|night|polartwilight)$/, "");
  if (PLAIN_SYMBOLS[base]) return PLAIN_SYMBOLS[base];
  // MET writes "lightssleet" and "lightssnow" with a double s.
  const m = base.match(/^(light|heavy)?s?(rain|sleet|snow)(showers)?(andthunder)?$/);
  if (m) return [m[1], m[2], m[3], m[4] && "and thunder"].filter(Boolean).join(" ");
  return base.replace(/_/g, " ").trim() || code;
}

const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
/** Where the wind comes from, as one of 8 compass points. */
export const compass = (degrees: number) => POINTS[Math.round((((degrees % 360) + 360) % 360) / 45) % 8];

// ---------------------------------------------------------------------------------------------
// MET's reply, kept to what Flash uses

/** One forecast step: the moment's values, and the next hour's and the next 6 hours' when MET gives them. */
export type MetStep = {
  time: number;
  temperature?: number;
  humidity?: number;
  windFrom?: number;
  wind?: number;
  gust?: number;
  uv?: number;
  symbol1h?: string;
  rain1h?: number;
  chance1h?: number;
  thunder1h?: number;
  symbol6h?: string;
  rain6h?: number;
  chance6h?: number;
  max6h?: number;
  min6h?: number;
};

/** A forecast for one place: its steps, when MET made it, and, when the live update failed, when Flash last had it. */
export type Forecast = { series: MetStep[]; updatedAt: number; stale?: { fetchedAt: number } };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && /^[a-z_]{1,60}$/.test(v) ? v : undefined);
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

/** Reads MET's Locationforecast "complete" reply, keeping only the values Flash uses; null when it has none. */
export function parseMet(json: unknown): { series: MetStep[]; updatedAt: number } | null {
  const properties = obj(obj(json).properties);
  const timeseries = properties.timeseries;
  if (!Array.isArray(timeseries)) return null;
  const series: MetStep[] = [];
  for (const raw of timeseries) {
    const step = obj(raw);
    const time = typeof step.time === "string" ? Date.parse(step.time) : NaN;
    if (!Number.isFinite(time)) continue;
    const data = obj(step.data);
    const now = obj(obj(data.instant).details);
    const h1 = obj(data.next_1_hours);
    const h6 = obj(data.next_6_hours);
    const d1 = obj(h1.details);
    const d6 = obj(h6.details);
    const s: MetStep = {
      time,
      temperature: num(now.air_temperature),
      humidity: num(now.relative_humidity),
      windFrom: num(now.wind_from_direction),
      wind: num(now.wind_speed),
      gust: num(now.wind_speed_of_gust),
      uv: num(now.ultraviolet_index_clear_sky),
      symbol1h: str(obj(h1.summary).symbol_code),
      rain1h: num(d1.precipitation_amount),
      chance1h: num(d1.probability_of_precipitation),
      thunder1h: num(d1.probability_of_thunder),
      symbol6h: str(obj(h6.summary).symbol_code),
      rain6h: num(d6.precipitation_amount),
      chance6h: num(d6.probability_of_precipitation),
      max6h: num(d6.air_temperature_max),
      min6h: num(d6.air_temperature_min),
    };
    // Left-out values aren't stored.
    for (const k of Object.keys(s) as (keyof MetStep)[]) if (s[k] === undefined) delete s[k];
    if (s.temperature !== undefined) series.push(s);
  }
  if (!series.length) return null;
  series.sort((a, b) => a.time - b.time);
  const updated = typeof obj(properties.meta).updated_at === "string" ? Date.parse(obj(properties.meta).updated_at as string) : NaN;
  return { series, updatedAt: Number.isFinite(updated) ? updated : series[0].time };
}

// ---------------------------------------------------------------------------------------------
// What the model asked for

/** A checked forecast request: where, in which time zone, and in which units. */
export type WeatherQuery = {
  // The user's own (approximate) location, or a place they named.
  mine: boolean;
  // The place's name: as the model gave it, or the user's city and country ("" when only the position is known).
  place: string;
  latitude: number;
  longitude: number;
  timeZone: string;
  // The time zone was worked out from the longitude, so local times are approximate.
  approximateTime: boolean;
  units: Units;
};

/** The time zone a longitude is roughly in: Etc/GMT-1 is UTC+01:00 (the sign is inverted). */
export function zoneFromLongitude(longitude: number): string {
  const hours = Math.max(-12, Math.min(12, Math.round(longitude / 15)));
  return hours === 0 ? "Etc/GMT" : `Etc/GMT${hours > 0 ? "-" : "+"}${Math.abs(hours)}`;
}

/** A place name a model wrote, made safe to show and to read: no control characters or angle brackets, one line, at most 80 characters. */
export function cleanPlace(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f-\u009f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80).trim();
}

/**
 * Checks what a model sent get_weather. The user's location comes from where (their connection), and
 * a named place from the model's own coordinates, checked; the units follow the user's country unless
 * they asked otherwise. A problem comes back as text for the model, which may try once more.
 */
export function validateWeatherInput(raw: unknown, where: Where): { ok: true; query: WeatherQuery } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: badInput("the input must be an object") };
  const input = raw as Obj;
  const units = unitsFor(where.country, input.units);
  if (input.where === "user_location") {
    if (where.latitude === undefined || where.longitude === undefined) return { ok: false, error: LOCATION_UNKNOWN };
    // The browser's zone, or the connection's; a connection with neither gets the longitude's.
    const named = validTimeZone(where.timeZone);
    const guessed = !named || named === "UTC";
    return {
      ok: true,
      query: {
        mine: true,
        place: placeName(where),
        latitude: where.latitude,
        longitude: where.longitude,
        timeZone: guessed ? zoneFromLongitude(where.longitude) : (named ?? "UTC"),
        approximateTime: guessed,
        units,
      },
    };
  }
  if (input.where !== "named_place") return { ok: false, error: badInput('where must be "user_location" or "named_place"') };
  const place = cleanPlace(input.place);
  if (!place) return { ok: false, error: badInput("place is missing") };
  const latitude = num(input.latitude);
  const longitude = num(input.longitude);
  if (latitude === undefined || Math.abs(latitude) > 90) return { ok: false, error: badInput("latitude must be a number from -90 to 90") };
  if (longitude === undefined || Math.abs(longitude) > 180) return { ok: false, error: badInput("longitude must be a number from -180 to 180") };
  if (Math.abs(latitude) < 0.01 && Math.abs(longitude) < 0.01) return { ok: false, error: badInput("0,0 isn't a place") };
  const zone = validTimeZone(input.timezone);
  return {
    ok: true,
    query: {
      mine: false,
      place,
      latitude,
      longitude,
      timeZone: zone ?? zoneFromLongitude(longitude),
      approximateTime: !zone,
      units,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The text the model reads

const HOUR = 3_600_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
/** A moment's local date and time in a zone. */
function local(time: number, timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(time)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, date: `${p.day} ${p.month}`, hour: Number(p.hour), clock: `${p.hour}:${p.minute}` };
}

const symbolOf = (s: MetStep) => s.symbol1h ?? s.symbol6h;
const chanceOf = (s: MetStep) => s.chance1h ?? s.chance6h;

/** A temperature in the user's units: "31°" short, "31°C" in full. */
const temp = (c: number, u: Units, full = false) => `${temperatureIn(c, u)}°${full ? u.temperature : ""}`;
const rain = (mm: number, u: Units) => `${rainIn(mm, u)} ${u.rain}`;
/** Whether an amount of rain shows as more than nothing in the user's units. */
const wet = (mm: number | undefined, u: Units) => mm !== undefined && Number(rainIn(mm, u)) > 0;

/** One step in the hour-by-hour lists: "16:00 30° light rain showers 0.4 mm (40%)", with the weekday when the day changes. */
function stepText(s: MetStep, u: Units, zone: string, lastDay: { day: string }, rainMm?: number, chance?: number): string {
  const when = local(s.time, zone);
  const day = when.day !== lastDay.day ? `${when.weekday} ` : "";
  lastDay.day = when.day;
  const parts = [`${day}${when.clock}`, temp(s.temperature!, u)];
  const symbol = symbolOf(s);
  if (symbol) parts.push(symbolWords(symbol));
  if (wet(rainMm, u)) parts.push(rain(rainMm!, u) + (chance !== undefined ? ` (${Math.round(chance)}%)` : ""));
  return parts.join(" ");
}

type Day = { key: string; label: string; steps: MetStep[]; covered: number };

/** A day's line: "Sun 11 Oct: 24–30°C, mostly rain showers, rain 5.0 mm (chance up to 70%), wind up to 20 km/h (gusts 35)". */
function dayText(d: Day, u: Units, zone: string, today: boolean): string {
  const temps: number[] = [];
  const winds: number[] = [];
  const gusts: number[] = [];
  const chances: number[] = [];
  const symbols: string[] = [];
  const allSymbols: string[] = [];
  let thunder = false;
  let total = 0;
  // Rain: the hourly amounts while steps are an hour apart, then the 6-hour ones, so nothing counts twice.
  let coveredUntil = -Infinity;
  d.steps.forEach((s, i) => {
    temps.push(s.temperature!);
    if (s.max6h !== undefined) temps.push(s.max6h);
    if (s.min6h !== undefined) temps.push(s.min6h);
    if (s.wind !== undefined) winds.push(s.wind);
    if (s.gust !== undefined) gusts.push(s.gust);
    const chance = chanceOf(s);
    if (chance !== undefined) chances.push(chance);
    if ((s.thunder1h ?? 0) >= 20 || /thunder/.test(symbolOf(s) ?? "")) thunder = true;
    const symbol = symbolOf(s);
    if (symbol) {
      const words = symbolWords(symbol);
      allSymbols.push(words);
      const hour = local(s.time, zone).hour;
      if (hour >= 6 && hour < 18) symbols.push(words);
    }
    if (s.time < coveredUntil) return;
    const next = d.steps[i + 1]?.time;
    const hourly = s.rain1h !== undefined && (next === undefined ? s.rain6h === undefined : next - s.time <= HOUR);
    if (hourly) {
      total += s.rain1h!;
      coveredUntil = s.time + HOUR;
    } else if (s.rain6h !== undefined) {
      total += s.rain6h;
      coveredUntil = s.time + 6 * HOUR;
    } else if (s.rain1h !== undefined) {
      total += s.rain1h;
      coveredUntil = s.time + HOUR;
    }
  });
  const parts = [`${temperatureIn(Math.min(...temps), u)}–${temp(Math.max(...temps), u, true)}`];
  // The most common conditions in the daytime (06:00 to 18:00), else over the whole day.
  const pool = symbols.length ? symbols : allSymbols;
  if (pool.length) {
    const counts = new Map<string, number>();
    for (const w of pool) counts.set(w, (counts.get(w) ?? 0) + 1);
    const [common, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
    parts.push(n < pool.length ? `mostly ${common}` : common);
  }
  const chance = chances.length ? Math.round(Math.max(...chances)) : undefined;
  const word = allSymbols.some((w) => /snow|sleet/.test(w)) ? "precipitation" : "rain";
  if (wet(total, u) || (chance ?? 0) >= 20) parts.push(`${word} ${rain(total, u)}${chance !== undefined ? ` (chance up to ${chance}%)` : ""}`);
  else parts.push("dry");
  if (winds.length) {
    const wind = windIn(Math.max(...winds), u);
    const gust = gusts.length ? windIn(Math.max(...gusts), u) : 0;
    parts.push(`wind up to ${wind} ${u.wind}${gust > wind ? ` (gusts ${gust})` : ""}`);
  }
  if (thunder) parts.push("thunder possible");
  return `${d.label}${today ? " (rest of today)" : ""}: ${parts.join(", ")}`;
}

/**
 * The forecast as the model reads it, in the place's local time: a header (the place, its zone, when
 * MET made the forecast, the units), the forecast for now, every hour for 12 hours, every 3 hours to
 * 48 hours, then up to 9 days. At most MAX_FORECAST_CHARS and MAX_FORECAST_TOKENS: the furthest days go
 * first. null when the data doesn't cover now (it starts over 3 hours ahead or has ended).
 */
export function summariseForecast(forecast: Forecast, q: WeatherQuery, now: number): string | null {
  const series = forecast.series.filter((s) => s.temperature !== undefined);
  if (!series.length) return null;
  const first = series[0];
  const last = series[series.length - 1];
  if (first.time > now + 3 * HOUR || last.time < now - HOUR) return null;
  // The step at or just before now, else the first one (under 3 hours ahead).
  let at = 0;
  for (let i = 0; i < series.length; i++) if (series[i].time <= now) at = i;
  const current = series[at];
  const upcoming = series.slice(at);
  const zone = q.timeZone;
  const u = q.units;

  const where = q.mine
    ? q.place
      ? `Forecast for ${q.place} (where the user is, from their internet connection, so approximate).`
      : "Forecast for where the user is (from their internet connection, so approximate)."
    : `Forecast for ${q.place} (${q.latitude.toFixed(2)}, ${q.longitude.toFixed(2)}, as given in the request).`;
  const made = local(forecast.updatedAt, zone);
  const header = [
    `${where} Time zone ${zone} (${offsetLabel(zone, new Date(now))})${q.approximateTime ? "; local times are approximate" : ""}.`,
    `MET Norway forecast made ${made.weekday} ${made.date} ${made.clock}. Units: ${unitsLine(u)}. These are forecasts, not measurements.`,
  ];
  if (forecast.stale) {
    const fetched = local(forecast.stale.fetchedAt, zone);
    header.push(`This forecast was fetched at ${fetched.weekday} ${fetched.clock}; the live update failed just now, so say it may be a few hours old.`);
  }

  // Now.
  const nowParts = [temp(current.temperature!, u, true)];
  const symbol = symbolOf(current);
  if (symbol) nowParts.push(symbolWords(symbol));
  if (current.humidity !== undefined) nowParts.push(`humidity ${Math.round(current.humidity)}%`);
  if (current.wind !== undefined) {
    const wind = windIn(current.wind, u);
    const gust = current.gust !== undefined ? windIn(current.gust, u) : 0;
    const from = current.windFrom !== undefined ? `from ${compass(current.windFrom)} ` : "";
    nowParts.push(`wind ${from}${wind} ${u.wind}${gust > wind ? ` (gusts ${gust})` : ""}`);
  }
  if (current.uv !== undefined) nowParts.push(`UV (clear sky) ${Math.round(current.uv)}`);
  if (wet(current.rain1h, u)) {
    nowParts.push(`${rain(current.rain1h!, u)} in the next hour${current.chance1h !== undefined ? ` (${Math.round(current.chance1h)}%)` : ""}`);
  }
  const nowLine = `Now (forecast for ${local(current.time, zone).clock}): ${nowParts.join(", ")}.`;

  // Every hour for 12 hours, then every 3 hours to 48 hours, counted from the step for now.
  const lastDay = { day: local(current.time, zone).day };
  const hourly = upcoming.filter((s) => s.time > current.time && s.time <= current.time + 12 * HOUR);
  const hourlyItems = hourly.map((s) => stepText(s, u, zone, lastDay, s.rain1h, s.chance1h));
  const threeHourly = upcoming.filter(
    (s) => s.time > current.time + 12 * HOUR && s.time <= current.time + 48 * HOUR && (s.time - current.time) % (3 * HOUR) === 0,
  );
  // The 3-hour list opens with its weekday.
  lastDay.day = "";
  const threeItems = threeHourly.map((s) => {
    // The rain in the 3 hours from this step, from the hourly amounts, when MET gives them all.
    const window = upcoming.filter((x) => x.time >= s.time && x.time < s.time + 3 * HOUR);
    const hours = window.filter((x) => x.rain1h !== undefined);
    const mm = hours.length === 3 ? hours.reduce((sum, x) => sum + x.rain1h!, 0) : undefined;
    const chances = window.map((x) => x.chance1h).filter((c): c is number => c !== undefined);
    return stepText(s, u, zone, lastDay, mm, chances.length ? Math.max(...chances) : undefined);
  });

  // The days, in the place's own dates.
  const days: Day[] = [];
  for (const s of upcoming) {
    const when = local(s.time, zone);
    let d = days.at(-1);
    if (!d || d.key !== when.day) {
      d = { key: when.day, label: `${when.weekday} ${when.date}`, steps: [], covered: 0 };
      days.push(d);
    }
    d.steps.push(s);
  }
  // A last day with under 12 hours of data says too little about it.
  const lastDayOf = days.at(-1);
  if (days.length > 1 && lastDayOf) {
    const steps = lastDayOf.steps;
    const end = steps.at(-1)!;
    const span = end.time - steps[0].time + (end.rain6h !== undefined || end.symbol6h !== undefined ? 6 * HOUR : HOUR);
    if (span < 12 * HOUR) days.pop();
  }
  const today = local(now, zone).day;
  const dayLines = days
    .slice(0, 9)
    .map((d, i) => dayText(d, u, zone, i === 0 && d.key === today && local(d.steps[0].time, zone).hour > 0));

  const build = (dayCount: number, hourCount: number, threeCount: number) =>
    [
      ...header,
      nowLine,
      ...(hourCount ? [`Next hours: ${hourlyItems.slice(0, hourCount).join(" · ")}`] : []),
      ...(threeCount ? [`Then every 3 hours: ${threeItems.slice(0, threeCount).join(" · ")}`] : []),
      ...(dayCount ? ["Days:", ...dayLines.slice(0, dayCount)] : []),
    ].join("\n");
  const fits = (text: string) => text.length <= MAX_FORECAST_CHARS && tokensAtMost(text) <= MAX_FORECAST_TOKENS;
  // Too long (a place name in a long script, say): the furthest days go first, then the furthest hours.
  let [dayCount, hourCount, threeCount] = [dayLines.length, hourlyItems.length, threeItems.length];
  let text = build(dayCount, hourCount, threeCount);
  while (!fits(text) && dayCount > 1) text = build(--dayCount, hourCount, threeCount);
  while (!fits(text) && threeCount > 0) text = build(dayCount, hourCount, --threeCount);
  while (!fits(text) && hourCount > 0) text = build(dayCount, --hourCount, threeCount);
  return fits(text) ? text : null;
}

/** What a lookup gives the model: the forecast's text, or the no-data error. */
export function weatherAnswer(forecast: Forecast | null, q: WeatherQuery, now: number): WeatherAnswer {
  const text = forecast && summariseForecast(forecast, q, now);
  return text ? { text, isError: false, used: true } : { text: NO_DATA, isError: true, used: false };
}
