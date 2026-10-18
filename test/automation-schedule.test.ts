import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./support/route-hooks.mjs", import.meta.url);

/*
 * When an automation runs (src/lib/schedule.ts): every kind of schedule, the time zone's own rules
 * across daylight saving (a time that doesn't exist runs later by the gap, one that happens twice runs
 * once, at the first), zones with half and quarter hours, short months, and the sentences that say a
 * schedule in the reader's language.
 */
const S = await import("../src/lib/schedule.ts");
const A = await import("../src/lib/automations.ts");
const { validTimeZone } = await import("../src/lib/context-note.ts");
const { translatorIn } = await import("../src/lib/server/i18n.ts");

const at = (iso: string) => Date.parse(iso);
const iso = (t: number) => new Date(t).toISOString().replace(".000Z", "Z");
const next = (when: Parameters<typeof S.nextFire>[0], tz: string, after: string) => iso(S.nextFire(when, tz, at(after)));
const nexts = (when: Parameters<typeof S.nextFire>[0], tz: string, after: string, n: number) => S.nextFires(when, tz, at(after), n).map(iso);

test("every kind of schedule gives its next run in its own zone", () => {
  assert.equal(next({ kind: "daily", at: "08:00" }, "America/Toronto", "2026-10-18T13:00:00Z"), "2026-10-19T12:00:00Z");
  assert.equal(next({ kind: "daily", at: "08:00" }, "America/Toronto", "2026-10-18T11:59:00Z"), "2026-10-18T12:00:00Z", "later the same day");
  // Weekdays skip Saturday and Sunday.
  assert.deepEqual(nexts({ kind: "daily", at: "08:00", weekdays: true }, "UTC", "2026-10-16T09:00:00Z", 3), ["2026-10-19T08:00:00Z", "2026-10-20T08:00:00Z", "2026-10-21T08:00:00Z"]);
  // Mondays and Wednesdays in Paris, across the change back to winter time on 25 October.
  assert.deepEqual(nexts({ kind: "weekly", days: [1, 3], at: "08:00" }, "Europe/Paris", "2026-10-18T00:00:00Z", 4), [
    "2026-10-19T06:00:00Z",
    "2026-10-21T06:00:00Z",
    "2026-10-26T07:00:00Z",
    "2026-10-28T07:00:00Z",
  ]);
  assert.equal(next({ kind: "monthly", day: 15, at: "09:30" }, "Asia/Tokyo", "2026-10-18T00:00:00Z"), "2026-11-15T00:30:00Z");
  assert.deepEqual(nexts({ kind: "hourly", every: 2, from: "08:00", to: "12:00" }, "UTC", "2026-10-18T07:00:00Z", 4), [
    "2026-10-18T08:00:00Z",
    "2026-10-18T10:00:00Z",
    "2026-10-18T12:00:00Z",
    "2026-10-19T08:00:00Z",
  ]);
  const once = { kind: "once" as const, date: "2026-12-24", at: "18:00" };
  assert.equal(next(once, "Asia/Tokyo", "2026-10-18T00:00:00Z"), "2026-12-24T09:00:00Z");
  assert.equal(S.nextFire(once, "Asia/Tokyo", at("2026-12-24T09:00:00Z")), 0, "a one-off never runs again");
});

test("Toronto: 02:30 on the night clocks spring forward runs at 03:30, and 01:30 on the night they fall back runs once", () => {
  // 14 March 2027: 02:00 becomes 03:00, so 02:30 doesn't exist and runs at 03:30 EDT.
  assert.equal(next({ kind: "daily", at: "02:30" }, "America/Toronto", "2027-03-13T12:00:00Z"), "2027-03-14T07:30:00Z");
  assert.equal(next({ kind: "daily", at: "02:30" }, "America/Toronto", "2027-03-14T07:30:00Z"), "2027-03-15T06:30:00Z");
  // 1 November 2026: 02:00 EDT becomes 01:00 EST, so 01:30 happens twice: it runs at the first.
  assert.equal(next({ kind: "daily", at: "01:30" }, "America/Toronto", "2026-10-31T12:00:00Z"), "2026-11-01T05:30:00Z");
  assert.equal(next({ kind: "daily", at: "01:30" }, "America/Toronto", "2026-11-01T05:30:00Z"), "2026-11-02T06:30:00Z", "not again an hour later");
});

test("Paris: the same on 25 October 2026 and 28 March 2027", () => {
  assert.equal(next({ kind: "daily", at: "02:30" }, "Europe/Paris", "2026-10-24T12:00:00Z"), "2026-10-25T00:30:00Z");
  assert.equal(next({ kind: "daily", at: "02:30" }, "Europe/Paris", "2026-10-25T00:30:00Z"), "2026-10-26T01:30:00Z");
  assert.equal(next({ kind: "daily", at: "02:30" }, "Europe/Paris", "2027-03-27T12:00:00Z"), "2027-03-28T01:30:00Z");
});

test("zones on half and quarter hours, and a half-hour daylight saving change", () => {
  assert.equal(next({ kind: "daily", at: "08:00" }, "Asia/Kolkata", "2026-10-18T00:00:00Z"), "2026-10-18T02:30:00Z");
  assert.equal(next({ kind: "daily", at: "08:00" }, "Asia/Kathmandu", "2026-10-18T00:00:00Z"), "2026-10-18T02:15:00Z");
  // Lord Howe Island moves its clocks by 30 minutes: 02:15 on 4 October 2026 doesn't exist (runs at 02:45),
  // and 01:45 on 4 April 2027 happens twice (runs once, at the first).
  assert.equal(next({ kind: "daily", at: "02:15" }, "Australia/Lord_Howe", "2026-10-03T00:00:00Z"), "2026-10-03T15:45:00Z");
  assert.deepEqual(nexts({ kind: "daily", at: "01:45" }, "Australia/Lord_Howe", "2027-04-03T00:00:00Z", 2), ["2027-04-03T14:45:00Z", "2027-04-04T15:15:00Z"]);
  // The Chatham Islands are 12:45 ahead in winter and 13:45 in summer.
  assert.equal(next({ kind: "daily", at: "08:00" }, "Pacific/Chatham", "2026-07-01T00:00:00Z"), "2026-07-01T19:15:00Z");
  assert.equal(next({ kind: "daily", at: "08:00" }, "Pacific/Chatham", "2027-01-10T00:00:00Z"), "2027-01-10T18:15:00Z");
});

test("day 31 is a short month's last day, and 'last' is the last day", () => {
  assert.equal(next({ kind: "monthly", day: 31, at: "09:00" }, "UTC", "2027-02-01T00:00:00Z"), "2027-02-28T09:00:00Z");
  assert.equal(next({ kind: "monthly", day: 31, at: "09:00" }, "UTC", "2028-02-01T00:00:00Z"), "2028-02-29T09:00:00Z");
  assert.equal(next({ kind: "monthly", day: 31, at: "09:00" }, "UTC", "2027-03-01T00:00:00Z"), "2027-03-31T09:00:00Z");
  assert.equal(next({ kind: "monthly", day: "last", at: "09:00" }, "UTC", "2027-04-01T00:00:00Z"), "2027-04-30T09:00:00Z");
});

test("an hourly window is counted in local time across a daylight saving change", () => {
  // Falling back: 01:00 happens twice and runs once; there are still four runs, two hours apart in the middle.
  assert.deepEqual(nexts({ kind: "hourly", every: 1, from: "00:00", to: "03:00" }, "America/Toronto", "2026-11-01T00:00:00Z", 5), [
    "2026-11-01T04:00:00Z",
    "2026-11-01T05:00:00Z",
    "2026-11-01T07:00:00Z",
    "2026-11-01T08:00:00Z",
    "2026-11-02T05:00:00Z",
  ]);
  // Springing forward: 02:00 doesn't exist and runs at 03:00, with the 03:00 run, once.
  assert.deepEqual(nexts({ kind: "hourly", every: 1, from: "00:00", to: "04:00" }, "America/Toronto", "2027-03-14T00:00:00Z", 5), [
    "2027-03-14T05:00:00Z",
    "2027-03-14T06:00:00Z",
    "2027-03-14T07:00:00Z",
    "2027-03-14T08:00:00Z",
    "2027-03-15T04:00:00Z",
  ]);
});

test("a bad zone is refused, so is more often than hourly, and a day has at most 24 runs", () => {
  assert.equal(validTimeZone("Mars/Olympus_Mons"), null);
  assert.equal(validTimeZone("America/Toronto"), "America/Toronto");
  const hourly = (every: number) => A.parseSpec({ v: 1, trigger: { type: "schedule", when: { kind: "hourly", every, from: "08:00", to: "20:00" } }, steps: [{ id: "a1", do: "ai", mode: "write", level: "sonic", prompt: "Hi" }] });
  assert.deepEqual(hourly(0.5), { error: A.SPEC_HOURLY });
  assert.deepEqual(hourly(0), { error: A.SPEC_HOURLY });
  assert.ok("spec" in hourly(1));
  const all = { kind: "hourly" as const, every: 1, from: "00:00", to: "23:59" };
  assert.equal(S.hourlySlots(all).length, 24);
  assert.equal(S.firesBetween(all, "Europe/Paris", at("2026-10-24T21:59:00Z"), at("2026-10-25T22:59:00Z")), 24, "even on the day with 25 hours");
  assert.ok(S.firesBetween(all, "Europe/Paris", at("2027-03-27T23:00:00Z"), at("2027-03-28T21:59:00Z")) <= 24);
});

test("only a schedule that runs more than once a day counts against the three sub-daily automations", () => {
  assert.equal(A.MAX_SUB_DAILY, 3);
  assert.equal(S.subDaily({ kind: "hourly", every: 2, from: "08:00", to: "18:00" }), true);
  assert.equal(S.subDaily({ kind: "hourly", every: 12, from: "08:00", to: "08:00" }), false, "one slot a day");
  assert.equal(S.subDaily({ kind: "daily", at: "08:00" }), false);
  assert.equal(S.subDaily({ kind: "weekly", days: [1, 2, 3, 4, 5, 6, 7], at: "08:00" }), false);
});

test("grace windows: hourly slots 15 minutes, daily ones 3 hours, a one-off a day", () => {
  assert.equal(S.graceFor({ kind: "hourly", every: 1, from: "08:00", to: "10:00" }), 15 * 60_000);
  assert.equal(S.graceFor({ kind: "daily", at: "08:00" }), 3 * 3600_000);
  assert.equal(S.graceFor({ kind: "monthly", day: 1, at: "08:00" }), 3 * 3600_000);
  assert.equal(S.graceFor({ kind: "once", date: "2027-01-01", at: "08:00" }), 24 * 3600_000);
});

test("schedules said in English, French, Arabic and Japanese, with the zone named in that language", async () => {
  const weekly = { kind: "weekly" as const, days: [1, 3], at: "08:00" };
  for (const language of ["en", "fr", "ar", "ja"]) {
    const t = await translatorIn(language);
    const { sentence, zone } = A.describeWhen(weekly, "America/Toronto", t, t.locale);
    const time = new Intl.DateTimeFormat(t.locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(Date.UTC(2000, 0, 1, 8, 0));
    const days = new Intl.ListFormat(t.locale, { type: "conjunction" }).format(
      [1, 3].map((d) => new Intl.DateTimeFormat(t.locale, { weekday: "long", timeZone: "UTC" }).format(Date.UTC(2024, 0, d))),
    );
    assert.equal(sentence, t("Every {days} at {time}", { days, time }), language);
    assert.ok(sentence.includes(days) && sentence.includes(time), language);
    if (language !== "en") assert.notEqual(t("Every {days} at {time}"), "Every {days} at {time}", `${language} has its own words`);
    assert.ok(!zone.includes("America/Toronto") && !zone.includes("Toronto"), `${language}: the zone is named, not its id (${zone})`);
    if (language === "ar") assert.match(zone + sentence, /^[^A-Za-z]*$/, "no Latin letters inside the Arabic");
    if (language === "ja") assert.match(zone, /[぀-ヿ一-鿿]/);
    if (language === "fr") assert.match(zone, /heure/i);
    if (language === "en") assert.equal(zone, "Eastern Time");
  }
  const fr = await translatorIn("fr");
  assert.equal(A.describeWhen({ kind: "daily", at: "08:00" }, "Europe/Paris", fr, fr.locale).sentence, `Tous les jours à ${A.clockText("08:00", fr.locale)}`);
  const ar = await translatorIn("ar");
  assert.equal(A.describeWhen({ kind: "daily", at: "08:00", weekdays: true }, "Asia/Riyadh", ar, ar.locale).sentence, `من الاثنين إلى الجمعة الساعة ${A.clockText("08:00", ar.locale)}`, "weekdays named, as Arabic weekends differ");
  const en = await translatorIn("en");
  assert.equal(A.describeWhen({ kind: "monthly", day: "last", at: "17:30" }, "UTC", en, en.locale).sentence, "On the last day of every month at 5:30 PM");
  assert.equal(A.describeWhen({ kind: "hourly", every: 1, from: "09:00", to: "17:00" }, "UTC", en, en.locale).sentence, "Every hour from 9:00 AM to 5:00 PM");
  assert.equal(A.describeWhen({ kind: "hourly", every: 3, from: "09:00", to: "18:00" }, "UTC", en, en.locale).sentence, "Every 3 hours from 9:00 AM to 6:00 PM");
  assert.equal(A.describeWhen({ kind: "once", date: "2026-12-24", at: "18:00" }, "UTC", en, en.locale).sentence, "Once, on December 24, 2026 at 6:00 PM");
  assert.equal(A.describeNext([at("2026-10-19T12:00:00Z"), at("2026-10-20T12:00:00Z")], "America/Toronto", en, en.locale), "Next: Mon, Oct 19, 8:00 AM and Tue, Oct 20, 8:00 AM");
});
