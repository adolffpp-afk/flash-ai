import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const w = await import("../src/lib/weather.ts");
const { tokensAtMost } = await import("../src/lib/tokens.ts");

const fixture = JSON.parse(readFileSync(new URL("./fixtures/met-complete.json", import.meta.url), "utf8"));
// MET's forecast for Lagos (a synthetic reply in MET's shape), read at 14:05 in Lagos.
const met = w.parseMet(fixture)!;
const now = Date.parse("2026-10-10T13:05:00Z");
const lagos = { timeZone: "Africa/Lagos", city: "Lagos", country: "NG", latitude: 6.45, longitude: 3.4 };
const query = (input: unknown, where: Parameters<typeof w.validateWeatherInput>[1] = lagos) => {
  const v = w.validateWeatherInput(input, where);
  assert.ok(v.ok, v.ok ? "" : v.error);
  return v.query;
};
const mine = query({ where: "user_location" });

test("MET's reply is kept to the values Flash uses", () => {
  assert.equal(met.series.length, 87);
  assert.equal(met.updatedAt, Date.parse("2026-10-10T12:31:05Z"));
  const first = met.series[0];
  assert.equal(first.time, Date.parse("2026-10-10T13:00:00Z"));
  assert.equal(first.temperature, 30.9);
  assert.equal(first.symbol1h, "partlycloudy_day");
  assert.equal(typeof first.max6h, "number");
  assert.ok(!("dew_point_temperature" in first) && !("cloud" in first), "only what's used is stored");
  // The 6-hourly steps have no next hour.
  const late = met.series.at(-2)!;
  assert.equal(late.symbol1h, undefined);
  assert.equal(typeof late.rain6h, "number");
  assert.equal(w.parseMet({ properties: { timeseries: "nope" } }), null);
  assert.equal(w.parseMet({ properties: { timeseries: [{ time: "x", data: {} }] } }), null);
  assert.equal(w.parseMet(null), null);
});

test("the forecast text: the place, now, hour by hour, then every 3 hours, then the days, within its size", () => {
  const text = w.summariseForecast(met, mine, now)!;
  const lines = text.split("\n");
  assert.equal(
    lines[0],
    "Forecast for Lagos, Nigeria (where the user is, from their internet connection, so approximate). Time zone Africa/Lagos (UTC+01:00).",
  );
  assert.equal(lines[1], "MET Norway forecast made Sat 10 Oct 13:31. Units: °C, km/h, mm. These are forecasts, not measurements.");
  assert.equal(lines[2], "Now (forecast for 14:00): 31°C, partly cloudy, humidity 70%, wind from SW 19 km/h (gusts 34), UV (clear sky) 8.");
  // Hourly for 12 hours, the day named when it changes.
  const next = lines[3];
  assert.match(next, /^Next hours: 15:00 31° cloudy · 16:00 31° light rain showers 0\.4 mm \(40%\) · /);
  assert.equal(next.split(" · ").length, 12);
  assert.match(next, /· Sun 00:00 24° fair ·/);
  assert.match(next, / 02:00 23° partly cloudy$/);
  // Then every 3 hours up to 48 hours from now's step (14:00 Monday).
  const three = lines[4];
  assert.match(three, /^Then every 3 hours: Sun 05:00 /);
  assert.equal(three.split(" · ").length, 12);
  assert.match(three, / Mon 02:00 /);
  assert.match(three, / 14:00 30° partly cloudy$/);
  assert.equal(lines[5], "Days:");
  const days = lines.slice(6);
  assert.equal(days.length, 9, "at most 9 days");
  assert.equal(days[0], "Sat 10 Oct (rest of today): 23–31°C, mostly partly cloudy, rain 2.1 mm (chance up to 60%), wind up to 19 km/h (gusts 34), thunder possible");
  // The 6-hour amounts count once, after the hourly ones end.
  assert.match(days[4], /^Wed 14 Oct: 22–30°C, .*rain 2\.4 mm \(chance up to 70%\)/);
  assert.match(days[2], /^Mon 12 Oct: .*, dry, /);
  assert.ok(text.length <= w.MAX_FORECAST_CHARS && tokensAtMost(text) <= w.MAX_FORECAST_TOKENS, `${text.length} chars`);
});

test("a named place shows its coordinates and zone, and a zone that isn't real comes from the longitude", () => {
  const kumasi = query({ where: "named_place", place: "Kumasi, Ashanti, Ghana", latitude: 6.6885, longitude: -1.6244, country: "GH", timezone: "Africa/Accra" });
  assert.equal(kumasi.timeZone, "Africa/Accra");
  assert.equal(kumasi.approximateTime, false);
  // Lagos's data read as if it were Kumasi's: only the header matters here.
  assert.match(w.summariseForecast(met, kumasi, now)!, /^Forecast for Kumasi, Ashanti, Ghana \(6\.69, -1\.62, as given in the request\)\. Time zone Africa\/Accra \(UTC\+00:00\)\.\n/);
  const guessed = query({ where: "named_place", place: "Somewhere", latitude: 6.45, longitude: 3.4, timezone: "Not/AZone" });
  assert.equal(guessed.timeZone, "Etc/GMT");
  assert.match(w.summariseForecast(met, guessed, now)!, /Time zone Etc\/GMT \(UTC\+00:00\); local times are approximate\./);
  assert.equal(w.zoneFromLongitude(30), "Etc/GMT-2", "east of Greenwich is GMT minus, as the tz database writes it");
  assert.equal(w.zoneFromLongitude(-75), "Etc/GMT+5");
  assert.equal(w.zoneFromLongitude(180), "Etc/GMT-12");
  // The user's own place never shows coordinates.
  assert.doesNotMatch(w.summariseForecast(met, mine, now)!, /6\.45|3\.40/);
  // Without a city, it still says roughly where.
  const unnamed = query({ where: "user_location" }, { timeZone: "Africa/Lagos", latitude: 6.45, longitude: 3.4 });
  assert.match(w.summariseForecast(met, unnamed, now)!, /^Forecast for where the user is \(from their internet connection, so approximate\)\./);
});

test("a stale forecast says so, and data that doesn't cover now is no forecast", () => {
  const stale = w.summariseForecast({ ...met, stale: { fetchedAt: Date.parse("2026-10-10T12:40:00Z") } }, mine, now)!;
  assert.match(stale, /This forecast was fetched at Sat 13:40; the live update failed just now, so say it may be a few hours old\./);
  // Starting more than 3 hours ahead, or ended.
  assert.equal(w.summariseForecast(met, mine, Date.parse("2026-10-10T09:59:00Z")), null);
  assert.ok(w.summariseForecast(met, mine, Date.parse("2026-10-10T10:30:00Z")), "under 3 hours ahead, the first step is now");
  assert.equal(w.summariseForecast(met, mine, Date.parse("2026-10-19T20:00:00Z")), null);
  assert.deepEqual(w.weatherAnswer(null, mine, now), { text: w.NO_DATA, isError: true, used: false });
  const answer = w.weatherAnswer(met, mine, now);
  assert.equal(answer.isError, false);
  assert.equal(answer.used, true);
});

test("a place name in a long script still fits: the furthest days go first", () => {
  const long = query({ where: "named_place", place: "北".repeat(200), latitude: 39.9, longitude: 116.4, timezone: "Asia/Shanghai" });
  assert.equal(long.place.length, 80, "names are cut to 80 characters");
  const text = w.summariseForecast(met, long, now)!;
  assert.ok(tokensAtMost(text) <= w.MAX_FORECAST_TOKENS);
  assert.ok(text.length <= w.MAX_FORECAST_CHARS);
  assert.match(text, /^Forecast for 北/);
});

test("daylight saving: steps across 25 October 2026 land on Oslo's own days and hours", () => {
  // Hourly steps from 20:00 UTC on the 24th to 12:00 UTC on the 26th, 0.1 mm each.
  const start = Date.parse("2026-10-24T20:00:00Z");
  const series = Array.from({ length: 41 }, (_, i) => ({ time: start + i * 3_600_000, temperature: 5, rain1h: 0.1, symbol1h: "cloudy" }));
  const oslo = query({ where: "named_place", place: "Oslo, Norway", latitude: 59.91, longitude: 10.75, country: "NO", timezone: "Europe/Oslo" }, {
    timeZone: "Europe/Oslo",
    country: "NO",
  });
  const text = w.summariseForecast({ series, updatedAt: start }, oslo, Date.parse("2026-10-24T21:30:00Z"))!;
  assert.match(text, /Time zone Europe\/Oslo \(UTC\+02:00\)/, "summer time at the moment of asking");
  assert.match(text, /^Now \(forecast for 23:00\)/m);
  // 00:00 UTC is 02:00 summer time, and 01:00 UTC is 02:00 again, in winter time.
  assert.match(text, /Sun 00:00 5° cloudy 0\.1 mm · 01:00 5° cloudy 0\.1 mm · 02:00 5° cloudy 0\.1 mm · 02:00 5° cloudy 0\.1 mm · 03:00/);
  // Sunday has 25 hours of 0.1 mm.
  assert.match(text, /^Sun 25 Oct: 5–5°C, cloudy, rain 2\.5 mm$/m);
  assert.match(text, /^Sat 24 Oct \(rest of today\): /m);
  assert.match(text, /^Mon 26 Oct: /m);
});

test("units follow the user's country unless they ask, and convert exactly", () => {
  assert.deepEqual(w.unitsFor("US"), { temperature: "F", wind: "mph", rain: "in" });
  assert.deepEqual(w.unitsFor("GB"), { temperature: "C", wind: "mph", rain: "mm" });
  assert.deepEqual(w.unitsFor("NG"), { temperature: "C", wind: "km/h", rain: "mm" });
  assert.deepEqual(w.unitsFor(undefined), { temperature: "C", wind: "km/h", rain: "mm" });
  assert.deepEqual(w.unitsFor("US", "metric"), { temperature: "C", wind: "km/h", rain: "mm" });
  assert.deepEqual(w.unitsFor("NG", "imperial"), { temperature: "F", wind: "mph", rain: "in" });
  const f = w.unitsFor("US");
  const c = w.unitsFor("NG");
  assert.equal(w.temperatureIn(0, f), 32);
  assert.equal(w.temperatureIn(100, f), 212);
  assert.equal(w.temperatureIn(-40, f), -40);
  assert.equal(w.temperatureIn(31.4, c), 31);
  assert.equal(w.windIn(10, c), 36);
  assert.equal(w.windIn(10, f), 22);
  assert.equal(w.rainIn(25.4, f), "1.00");
  assert.equal(w.rainIn(2.04, c), "2.0");
  // The user's units for a named place too: an American asking about Lagos gets °F.
  const text = w.summariseForecast(met, query({ where: "named_place", place: "Lagos, Nigeria", latitude: 6.45, longitude: 3.4, timezone: "Africa/Lagos" }, { timeZone: "America/New_York", country: "US" }), now)!;
  assert.match(text, /Units: °F, mph, inches\./);
  assert.match(text, /Now \(forecast for 14:00\): 88°F, partly cloudy, humidity 70%, wind from SW 12 mph \(gusts 21\)/);
  assert.match(text, /16:00 88° light rain showers 0\.02 in \(40%\)/);
});

test("MET's symbols and wind directions in words", () => {
  assert.equal(w.symbolWords("lightssleetshowersandthunder_day"), "light sleet showers and thunder");
  assert.equal(w.symbolWords("lightssnow"), "light snow");
  assert.equal(w.symbolWords("heavyrainandthunder"), "heavy rain and thunder");
  assert.equal(w.symbolWords("sleet"), "sleet");
  assert.equal(w.symbolWords("snowshowers_polartwilight"), "snow showers");
  assert.equal(w.symbolWords("partlycloudy_night"), "partly cloudy");
  assert.equal(w.symbolWords("clearsky_day"), "clear sky");
  assert.equal(w.symbolWords("volcanic_ash"), "volcanic ash", "an unknown code is still readable");
  assert.equal(w.compass(0), "N");
  assert.equal(w.compass(225.3), "SW");
  assert.equal(w.compass(359), "N");
  assert.equal(w.compass(-90), "W");
});

test("what a model sends is checked, with a reason it can act on", () => {
  const bad = (input: unknown, where = lagos) => {
    const v = w.validateWeatherInput(input, where);
    assert.ok(!v.ok);
    return v.error;
  };
  assert.match(bad({ where: "named_place", place: "Paris", latitude: 95, longitude: 2.35 }), /^That input wasn't usable: latitude must be a number from -90 to 90\. Call get_weather again/);
  assert.match(bad({ where: "named_place", place: "Paris", latitude: 48.85, longitude: -181 }), /longitude must be a number from -180 to 180/);
  assert.match(bad({ where: "named_place", place: "Paris", latitude: "48.85", longitude: 2.35 }), /latitude must be a number/);
  assert.match(bad({ where: "named_place", place: "Null Island", latitude: 0, longitude: 0.001 }), /0,0 isn't a place/);
  assert.match(bad({ where: "named_place", latitude: 48.85, longitude: 2.35 }), /place is missing/);
  assert.match(bad({ where: "somewhere" }), /where must be "user_location" or "named_place"/);
  assert.match(bad("Paris"), /the input must be an object/);
  // No position for the user: the model asks for the city.
  assert.equal(bad({ where: "user_location" }, { timeZone: "UTC" } as typeof lagos), w.LOCATION_UNKNOWN);
  // A place name is cleaned before it is shown or read.
  const named = query({ where: "named_place", place: "  Paris\n<b>Île-de-France</b>\u0007 France ", latitude: 48.85, longitude: 2.35, country: "fr", units: "kelvin" });
  assert.equal(named.place, "Paris b Île-de-France /b France");
  assert.deepEqual(named.units, w.unitsFor("NG"), "unknown units are auto, by the user's country");
  // The user's own place, with no usable zone, takes the longitude's.
  const noZone = query({ where: "user_location" }, { timeZone: "UTC", latitude: 6.45, longitude: 3.4 });
  assert.deepEqual([noZone.timeZone, noZone.approximateTime], ["Etc/GMT", true]);
  const east = query({ where: "user_location" }, { timeZone: "UTC", latitude: 1.29, longitude: 103.85 });
  assert.deepEqual([east.timeZone, east.approximateTime], ["Etc/GMT-7", true]);
});

test("the tool is defined once for Claude and the free models, without eager input streaming", () => {
  assert.equal(w.WEATHER_TOOL.name, "get_weather");
  assert.ok(!("eager_input_streaming" in w.WEATHER_TOOL));
  assert.ok(!("strict" in w.WEATHER_TOOL));
  assert.deepEqual(w.WEATHER_TOOL.input_schema.required, ["where"]);
  assert.match(w.WEATHER_TOOL.description, /^Live weather forecast from MET Norway for one place: the next 48 hours hour by hour/);
  assert.match(w.WEATHER_TOOL.description, /It has no past weather, climate or monthly averages, sea temperatures, air quality or official warnings\./);
  assert.equal(w.WEATHER_FUNCTION.description, w.WEATHER_TOOL.description);
  assert.equal(w.WEATHER_FUNCTION.parameters, w.WEATHER_TOOL.input_schema);
  assert.equal(w.WEATHER_ROUNDS, 2);
  assert.equal(w.MAX_FORECASTS, 3);
});
