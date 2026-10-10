import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";

process.env.DATABASE_URL = ":memory:";
process.env.FLASH_CONTACT_EMAIL = "owner@example.com";
const { forecast, reserveMet, weatherTool, weatherSources, MET_DAILY_REQUESTS } = await import("../src/lib/server/weather.ts");
const { all, one, run } = await import("../src/lib/server/db.ts");
const { LOCATION_UNKNOWN, NO_DATA } = await import("../src/lib/weather.ts");

// A stand-in for MET Norway's Locationforecast: each request gets the reply set for it.
const fixture = readFileSync(new URL("./fixtures/met-complete.json", import.meta.url), "utf8");
type Reply = { status: number; expires?: string; lastModified?: string } | "drop";
let reply: Reply = { status: 200 };
const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
const server = createServer((req, res) => {
  seen.push({ url: req.url!, headers: req.headers });
  if (reply === "drop") return req.socket.destroy();
  const { status, expires, lastModified } = reply;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (expires) headers.Expires = expires;
  if (lastModified) headers["Last-Modified"] = lastModified;
  res.writeHead(status, headers).end(status === 200 || status === 203 ? fixture : "");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const now = Date.parse("2026-10-10T13:05:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const http = (ms: number) => new Date(ms).toUTCString();

test("the first ask fetches from MET as Flash, rounded to 2 decimals, and keeps only what's used", async () => {
  // An old row nobody asked for in two days: the first write prunes it.
  await run("INSERT INTO weather_cache (cell, series, updated_at, expires_at, fetched_at) VALUES ('1.00,1.00', '[]', 0, 0, ?)", [now - 3 * 24 * HOUR]);
  reply = { status: 200, expires: http(now + 30 * MIN), lastModified: http(now - 5 * MIN) };
  const got = await forecast(6.45449, 3.40051, now, base);
  assert.ok(got && got.series.length === 87 && !got.stale);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/complete?lat=6.45&lon=3.4");
  assert.match(seen[0].headers["user-agent"]!, /^FlashAI\/1\.0 \(\+https:\/\/www\.flash-app\.dev; .+@.+\)$/);
  assert.equal(seen[0].headers["user-agent"], "FlashAI/1.0 (+https://www.flash-app.dev; owner@example.com)");
  assert.equal(seen[0].headers["if-modified-since"], undefined);
  const row = await one<{ cell: string; series: string; expires_at: number; last_modified: string }>("SELECT * FROM weather_cache WHERE cell = '6.45,3.40'");
  assert.equal(row!.expires_at, now + 30 * MIN);
  assert.equal(row!.last_modified, http(now - 5 * MIN));
  assert.ok(row!.series.length < fixture.length / 2, "MET's whole reply isn't stored");
  assert.equal(await one("SELECT cell FROM weather_cache WHERE cell = '1.00,1.00'"), null, "old rows are pruned");
  const index = await all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'weather_cache'");
  assert.ok(index.some((i) => i.name === "weather_cache_fetched"));
});

test("nothing is asked again before Expires; after it, If-Modified-Since, and a 304 keeps the forecast", async () => {
  seen.length = 0;
  const cached = await forecast(6.45, 3.4, now + 29 * MIN, base);
  assert.equal(seen.length, 0, "no request before Expires");
  assert.equal(cached!.series.length, 87);
  // A nearby point in the same cell shares it.
  await forecast(6.4521, 3.3962, now + 10 * MIN, base);
  assert.equal(seen.length, 0);
  reply = { status: 304, expires: http(now + 90 * MIN) };
  const kept = await forecast(6.45, 3.4, now + 31 * MIN, base);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers["if-modified-since"], http(now - 5 * MIN));
  assert.equal(kept!.series.length, 87);
  const row = await one<{ expires_at: number; fetched_at: number }>("SELECT expires_at, fetched_at FROM weather_cache WHERE cell = '6.45,3.40'");
  assert.deepEqual([Number(row!.expires_at), Number(row!.fetched_at)], [now + 90 * MIN, now + 31 * MIN]);
  // Without an Expires header, half an hour.
  reply = { status: 200 };
  await forecast(6.45, 3.4, now + 91 * MIN, base);
  const fresh = await one<{ expires_at: number }>("SELECT expires_at FROM weather_cache WHERE cell = '6.45,3.40'");
  assert.equal(Number(fresh!.expires_at), now + 121 * MIN);
});

test("when MET fails, a forecast up to 6 hours old is used, marked stale; older than that, none", async () => {
  // Fetched at now + 91 minutes (above), expired at now + 121 minutes.
  const fetchedAt = now + 91 * MIN;
  for (const failure of [{ status: 500 }, { status: 429 }, "drop"] as Reply[]) {
    reply = failure;
    seen.length = 0;
    const stale = await forecast(6.45, 3.4, fetchedAt + 3 * HOUR, base);
    assert.equal(seen.length, 1);
    assert.deepEqual(stale!.stale, { fetchedAt }, JSON.stringify(failure));
  }
  reply = { status: 500 };
  assert.equal(await forecast(6.45, 3.4, fetchedAt + 6 * HOUR + MIN, base), null);
  // A place never fetched has nothing to fall back on.
  assert.equal(await forecast(48.85, 2.35, now, base), null);
});

test("once today's MET allowance is used, nothing more is fetched", async () => {
  const day = new Date(now).toISOString().slice(0, 10);
  await run("UPDATE free_quota SET requests = ? WHERE day = ? AND provider = 'met'", [MET_DAILY_REQUESTS - 1, day]);
  assert.equal(await reserveMet(now), true);
  assert.equal(await reserveMet(now), false);
  seen.length = 0;
  reply = { status: 200 };
  assert.equal(await forecast(59.91, 10.75, now, base), null);
  assert.equal(seen.length, 0);
  // Tomorrow is a new day.
  assert.equal(await reserveMet(now + 24 * HOUR), true);
});

test("old rows are pruned at most once an hour on a server", async () => {
  const later = now + 3 * 24 * HOUR;
  reply = { status: 200 };
  await run("INSERT INTO weather_cache (cell, series, updated_at, expires_at, fetched_at) VALUES ('2.00,2.00', '[]', 0, 0, ?)", [later - 3 * 24 * HOUR]);
  await forecast(10, 10, later, base);
  assert.equal(await one("SELECT cell FROM weather_cache WHERE cell = '2.00,2.00'"), null);
  await run("INSERT INTO weather_cache (cell, series, updated_at, expires_at, fetched_at) VALUES ('3.00,3.00', '[]', 0, 0, ?)", [later - 3 * 24 * HOUR]);
  await forecast(11, 11, later + 10 * MIN, base);
  assert.ok(await one("SELECT cell FROM weather_cache WHERE cell = '3.00,3.00'"), "not again within the hour");
  await forecast(12, 12, later + HOUR + MIN, base);
  assert.equal(await one("SELECT cell FROM weather_cache WHERE cell = '3.00,3.00'"), null);
  // An answer from the cache prunes too, so old places go even when nothing new is fetched.
  reply = { status: 200, expires: http(later + 10 * HOUR) };
  await forecast(13, 13, later + HOUR + 2 * MIN, base);
  await run("INSERT INTO weather_cache (cell, series, updated_at, expires_at, fetched_at) VALUES ('4.00,4.00', '[]', 0, 0, ?)", [later - 3 * 24 * HOUR]);
  const asked = seen.length;
  await forecast(13, 13, later + 2 * HOUR + 2 * MIN, base);
  assert.equal(seen.length, asked, "from the cache");
  assert.equal(await one("SELECT cell FROM weather_cache WHERE cell = '4.00,4.00'"), null);
});

test("the tool never throws, says what it's checking, and credits MET", async () => {
  const t = (text: string, blanks?: Record<string, string | number>) => `[${text}]${blanks ? JSON.stringify(blanks) : ""}`;
  const lagos = { timeZone: "Africa/Lagos", city: "Lagos", country: "NG", latitude: 6.45, longitude: 3.4 };
  const tool = weatherTool(lagos, t, { now: () => now, base: "http://127.0.0.1:1" });
  assert.equal(tool.status({ where: "user_location" }), "[Checking the forecast where you are…]");
  assert.equal(tool.status({ where: "named_place", place: "Paris,\nFrance <b>" }), '[Checking the forecast for {place}…]{"place":"Paris, France b"}');
  assert.equal(tool.status("nonsense"), "[Checking the forecast where you are…]");
  assert.deepEqual(tool.sources, [
    { title: "[Based on data from MET Norway]", url: "https://www.met.no/en" },
    { title: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
  ]);
  assert.deepEqual(weatherSources()[0].title, "Based on data from MET Norway");
  // Nothing listens at port 1, and Paris was never fetched: no data, no throw.
  assert.deepEqual(await tool.run({ where: "named_place", place: "Paris", latitude: 48.85, longitude: 2.35, timezone: "Europe/Paris" }), {
    text: NO_DATA,
    isError: true,
    used: false,
  });
  // From the stand-in, with today's allowance (used up above) back.
  const live = weatherTool(lagos, t, { now: () => now, base });
  reply = { status: 200, expires: http(now + 30 * MIN) };
  await run("DELETE FROM weather_cache");
  await run("DELETE FROM free_quota WHERE provider = 'met'");
  const answer = await live.run({ where: "user_location" });
  assert.equal(answer.isError, false);
  assert.equal(answer.used, true);
  assert.match(answer.text, /^Forecast for Lagos, Nigeria \(where the user is/);
  const nowhere = weatherTool({ timeZone: "UTC" }, t, { now: () => now, base });
  assert.deepEqual(await nowhere.run({ where: "user_location" }), { text: LOCATION_UNKNOWN, isError: true, used: false });
  const bad = await live.run({ where: "named_place", place: "Nowhere", latitude: 200, longitude: 0 });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /latitude must be a number from -90 to 90/);
});
