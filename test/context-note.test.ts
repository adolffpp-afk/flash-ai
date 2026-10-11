import { test } from "node:test";
import assert from "node:assert/strict";

const { contextNote, offsetLabel, placeName, validTimeZone } = await import("../src/lib/context-note.ts");
const { whereFrom } = await import("../src/lib/server/where.ts");
const { tokensAtMost } = await import("../src/lib/tokens.ts");
const companion = await import("../src/lib/engines/companion.ts");

// Saturday 10 October 2026, 13:05 UTC: 14:05 in Lagos.
const now = new Date("2026-10-10T13:05:00Z");
// The date as this machine's Intl writes it, so the test doesn't depend on its comma style.
const date = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now);

test("the note gives the user's date, local time, zone, UTC time and rough place", () => {
  assert.equal(
    contextNote({ timeZone: "Africa/Lagos", city: "Lagos", country: "NG", latitude: 6.45, longitude: 3.4 }, now),
    `Today is ${date}, and it's 14:05 where the user is (time zone Africa/Lagos, UTC+01:00; 13:05 UTC). ` +
      "Their approximate location, from their internet connection, is Lagos, Nigeria. It can be wrong (VPNs, mobile networks, travel), " +
      "so when an answer depends on where they are, say which place you used.",
  );
  assert.match(date, /Saturday,? 10 October 2026/);
});

test("without a place it says so, and builders get the date without the clock", () => {
  const utc = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now);
  assert.equal(
    contextNote({ timeZone: "UTC" }, now),
    `Today is ${utc}, and it's 13:05 where the user is (time zone UTC, UTC+00:00; 13:05 UTC). Their location is unknown. ` +
      "When an answer depends on where they are, give what holds generally and ask for their city in one short question.",
  );
  assert.equal(
    contextNote({ timeZone: "Africa/Lagos", city: "Lagos", country: "NG" }, now, { clock: false }),
    `Today is ${date} where the user is. Their approximate location, from their internet connection, is Lagos, Nigeria.`,
  );
  // A country alone still says roughly where.
  assert.equal(placeName({ timeZone: "UTC", country: "GH" }), "Ghana");
});

test("coordinates never reach the note, and a zone that isn't real is UTC", () => {
  const note = contextNote({ timeZone: "Europe/Paris", city: "Paris", country: "FR", latitude: 48.8566, longitude: 2.3522 }, now);
  assert.doesNotMatch(note, /48\.8|2\.35/);
  assert.match(contextNote({ timeZone: "Mars/Olympus" }, now), /time zone UTC, UTC\+00:00/);
  assert.equal(validTimeZone("Not/AZone"), null);
  assert.equal(validTimeZone(42), null);
  assert.equal(validTimeZone("Asia/Tokyo"), "Asia/Tokyo");
  assert.equal(offsetLabel("Asia/Kolkata", now), "UTC+05:30");
  assert.equal(offsetLabel("UTC", now), "UTC+00:00");
  assert.equal(offsetLabel("America/New_York", now), "UTC-04:00");
});

test("where the user is comes from Vercel's headers, checked, with the browser's zone first", () => {
  const request = (headers: Record<string, string>) => new Request("http://x", { headers });
  const where = whereFrom(
    request({
      "x-vercel-ip-city": "S%C3%A3o%20Paulo",
      "x-vercel-ip-country": "br",
      "x-vercel-ip-latitude": "-23.5475",
      "x-vercel-ip-longitude": "-46.6361",
      "x-vercel-ip-timezone": "America/Sao_Paulo",
    }),
    "Europe/Lisbon",
  );
  assert.deepEqual(where, { timeZone: "Europe/Lisbon", city: "São Paulo", country: "BR", latitude: -23.5475, longitude: -46.6361 });
  // The connection's zone when the browser sent none or a bad one; UTC when neither is usable.
  assert.equal(whereFrom(request({ "x-vercel-ip-timezone": "America/Sao_Paulo" }), "Nope/Nope").timeZone, "America/Sao_Paulo");
  assert.deepEqual(whereFrom(request({})), { timeZone: "UTC" });
  // A browser that says UTC hasn't been told its zone: the connection's real one is used, and UTC only without it.
  assert.equal(whereFrom(request({ "x-vercel-ip-timezone": "Africa/Lagos" }), "UTC").timeZone, "Africa/Lagos");
  assert.equal(whereFrom(request({}), "UTC").timeZone, "UTC");
  // Anything that isn't a place name, a country code or a coordinate in range is dropped.
  const bad = whereFrom(
    request({ "x-vercel-ip-city": "%3Cscript%3E", "x-vercel-ip-country": "Nigeria", "x-vercel-ip-latitude": "123", "x-vercel-ip-longitude": "3.4" }),
  );
  assert.deepEqual(bad, { timeZone: "UTC" });
  assert.equal(whereFrom(request({ "x-vercel-ip-city": "%E0%A4%A" })).city, undefined, "a broken encoding is dropped");
  assert.equal(whereFrom(request({ "x-vercel-ip-latitude": "6.45" })).latitude, undefined, "half a position is no position");
});

test("tokensAtMost moved to its own file, and the companion still exports it", () => {
  assert.equal(companion.tokensAtMost, tokensAtMost);
  assert.equal(tokensAtMost("hello"), 2);
});
