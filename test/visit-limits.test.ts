/*
 * The free plan's daily limits on counting (1,000 people and 100 app steps a day across all of an
 * owner's apps), paid plans' unchanged ones, the track route's rate limit on the free plan, and the
 * upgrade offer for a free owner whose counting keeps pausing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import type { InValue } from "@libsql/client";

register("./support/route-hooks.mjs", import.meta.url);
process.env.DATABASE_URL = ":memory:";
delete process.env.FLASH_APP_URL;
/** What the server log was told, for the once-only lines. */
const errors: string[] = [];
console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
console.info = () => {};
const { run, one, all, db } = await import("../src/lib/server/db.ts");
const visits = await import("../src/lib/server/visits.ts");
const { recordVisit, forgetServerMemory, dayOf, peopleCap, pruneDaily, FREE_PEOPLE_PER_DAY, FREE_STEPS_PER_DAY, PLAN_PEOPLE, NETWORK_PEOPLE, NETWORK_STEPS } = visits;
const { matchVisit, countSteps, funnelStats, TRACK_STEPS_PER_CONNECTION, TRACK_STEPS_PER_APP, PAUSED_DAYS_OFFER } = await import("../src/lib/server/funnel.ts");
const { PLANS } = await import("../src/lib/credits.ts");
const pageRoute = await import("../src/app/p/[slug]/route.ts");
const trackRoute = await import("../src/app/api/sites/[slug]/track/route.ts");
const { afterwards } = await import("./support/next-server.mjs");

const DAY = 86_400_000;
// One fixed moment, so a test never runs across midnight (UTC) and the rate limit's minute holds.
const NOW = Date.UTC(2026, 9, 18, 10);
Date.now = () => NOW;
const TODAY = dayOf(NOW);

/** A browser no other person in these tests has, on a connection of its own unless one is given. */
let people = 0;
const browser = () => `Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0 person/${++people}`;
const ipOf = (n: number) => `10.${Math.floor(n / 62_500) % 250}.${Math.floor(n / 250) % 250}.${n % 250}`;
const person = (ip = ipOf(people + 1)) => ({ "user-agent": browser(), "x-forwarded-for": ip });
const page = (slug: string, who: Record<string, string>) =>
  new Request(`https://www.flash-app.dev/p/${slug}`, { headers: { host: "www.flash-app.dev", "accept-language": "en", ...who } });
const call = (slug: string, who: Record<string, string>, body = "") =>
  new Request(`https://www.flash-app.dev/api/sites/${slug}/track`, {
    method: "POST",
    body,
    headers: { host: "www.flash-app.dev", "content-type": "text/plain", ...who },
  });
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) }) as never;
const n = async (sql: string, args: (string | number)[] = []) => Number((await one<{ n: number }>(sql, args))?.n ?? 0);
/** Rows written while fn runs (SQLite's total_changes(): every row inserted, updated or deleted). */
async function rowsWritten(fn: () => Promise<unknown>): Promise<number> {
  const before = await n("SELECT total_changes() AS n");
  await fn();
  return (await n("SELECT total_changes() AS n")) - before;
}
/** The statements sent to the database while fn runs. */
async function statementsDuring(fn: () => Promise<unknown>): Promise<string[]> {
  const client = await db();
  const sent: string[] = [];
  const [execute, batch] = [client.execute.bind(client), client.batch.bind(client)];
  client.execute = ((s: { sql: string } | string, ...rest: unknown[]) => {
    sent.push(typeof s === "string" ? s : s.sql);
    return (execute as (...a: unknown[]) => unknown)(s, ...rest);
  }) as typeof client.execute;
  client.batch = ((list: ({ sql: string } | string)[], mode?: unknown) => {
    for (const s of list) sent.push(typeof s === "string" ? s : s.sql);
    return (batch as (...a: unknown[]) => unknown)(list, mode);
  }) as typeof client.batch;
  try {
    await fn();
  } finally {
    client.execute = execute;
    client.batch = batch;
  }
  return sent;
}
async function owner(id: string, plan?: string) {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES (?, ?, 'h', 0, 1)", [id, `${id}@x.co`]);
  if (plan) {
    await run(
      `INSERT INTO subscriptions (id, user_id, plan, interval, status, amount_cents, anchor, paid_until, test, created_at, updated_at)
       VALUES (?, ?, ?, 'month', 'active', 100, 0, ?, 1, 0, 0)`,
      [`sub-${id}`, id, plan, Date.UTC(2100, 0, 1)],
    );
  }
}
const site = (slug: string, userId: string, stepNames: string[] = []) =>
  run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at, step_names) VALUES (?, ?, ?, '<p>Fresh bread every morning</p>', 0, 0, ?)", [
    slug,
    userId,
    slug,
    JSON.stringify(stepNames),
  ]);
const peopleOf = (userId: string) => n("SELECT COALESCE(SUM(people), 0) AS n FROM owner_people WHERE user_id = ? AND day = ?", [userId, TODAY]);
const stepsOf = (userId: string) => n("SELECT COALESCE(SUM(steps), 0) AS n FROM owner_people WHERE user_id = ? AND day = ?", [userId, TODAY]);
const visitorsOf = (slug: string) => n("SELECT COALESCE(SUM(n), 0) AS n FROM site_events WHERE site_slug = ? AND day = ? AND step = 'visit'", [slug, TODAY]);
const appStepsOf = (slug: string) => n("SELECT COALESCE(SUM(n), 0) AS n FROM site_events WHERE site_slug = ? AND step LIKE 'app:%'", [slug]);
const viewsOf = (slug: string) => n("SELECT COALESCE(SUM(views), 0) AS n FROM site_visits WHERE site_slug = ?", [slug]);
const markOf = (slug: string, step: string) => one<{ n: number }>("SELECT n FROM site_events WHERE site_slug = ? AND step = ?", [slug, step]).then((r) => (r ? Number(r.n) : null));
/** A person's first load of an app, and the code their requests are matched to. */
async function visitor(slug: string, ip?: string) {
  const who = person(ip);
  await recordVisit(slug, page(slug, who), null, NOW);
  return who;
}
const names = (prefix: string) => Array.from({ length: 10 }, (_, i) => `${prefix}${i}`);
const track = async (slug: string, who: Record<string, string>, body: string) => {
  const res = await trackRoute.POST(call(slug, who, body), ctx(slug));
  await afterwards();
  return res;
};

test("the free plan counts 1,000 people a day across all of an owner's apps; past it the apps still serve at once, and only views count", async () => {
  forgetServerMemory();
  assert.equal(FREE_PEOPLE_PER_DAY, 1_000);
  await owner("free1");
  await site("bakery", "free1");
  await site("cafe", "free1");
  // 600 people on one app and 400 on the other: one daily number for both.
  let written = 0;
  for (let i = 0; i < 1_000; i++) written += await rowsWritten(() => visitor(i < 600 ? "bakery" : "cafe"));
  assert.equal(await peopleOf("free1"), 1_000);
  assert.deepEqual([await visitorsOf("bakery"), await visitorsOf("cafe")], [600, 400]);
  // What the PR's cost is worked out from: 4 rows a person, plus the day's key and settings once.
  assert.ok(written <= 4 * 1_000 + 5, `${written} rows for 1,000 people`);
  assert.equal(await markOf("cafe", "capped"), null, "nobody turned away yet");

  // The 1,001st, on either app: the page comes back as always, counting runs only after it is sent,
  // and it adds a view but no person.
  for (const slug of ["cafe", "bakery"]) {
    const views = await viewsOf(slug);
    let res: Response | undefined;
    const before = await statementsDuring(async () => {
      res = await pageRoute.GET(page(slug, person()), ctx(slug));
    });
    assert.equal(res!.status, 200, slug);
    assert.match(await res!.text(), /Fresh bread every morning/, slug);
    assert.ok(!before.some((sql) => /owner_people|site_people|site_visits|site_events/.test(sql)), `${slug}: nothing counted before the page is sent`);
    await afterwards();
    assert.equal(await viewsOf(slug), views + 1, slug);
    assert.equal(await markOf(slug, "capped"), 1_000, slug);
  }
  assert.equal(await peopleOf("free1"), 1_000);
  assert.deepEqual([await visitorsOf("bakery"), await visitorsOf("cafe")], [600, 400]);
  // The paused note says the new number, on every app of the owner, with the upgrade offer.
  for (const slug of ["bakery", "cafe"]) {
    const f = (await funnelStats(slug, 30, NOW))!;
    assert.deepEqual([f.pausedToday, f.free], [1_000, true], slug);
  }
  // Tomorrow counts again.
  await recordVisit("cafe", page("cafe", person()), null, NOW + DAY);
  assert.equal(await n("SELECT people AS n FROM owner_people WHERE user_id = 'free1' AND day = ?", [dayOf(NOW + DAY)]), 1);
});

test("the free plan counts 100 app steps a day across all of an owner's apps, a tenth of its people; past them a step writes only the note", async () => {
  forgetServerMemory();
  assert.equal(FREE_STEPS_PER_DAY, 100);
  assert.equal(FREE_STEPS_PER_DAY, FREE_PEOPLE_PER_DAY / 10);
  await owner("free2");
  await site("shop-a", "free2", names("a"));
  await site("shop-b", "free2", names("b"));
  // 5 people on each app, each sending its 10 names: 100 steps.
  for (const slug of ["shop-a", "shop-b"]) {
    for (let i = 0; i < 5; i++) {
      const who = await visitor(slug);
      const match = await matchVisit(slug, call(slug, who), NOW);
      await countSteps(slug, match, names(slug === "shop-a" ? "a" : "b").map((s) => `app:${s}` as const), NOW);
    }
  }
  assert.equal(await stepsOf("free2"), 100);
  assert.deepEqual([await appStepsOf("shop-a"), await appStepsOf("shop-b")], [50, 50]);
  // The 101st: only the note saying the apps' steps stopped counting, once.
  const late = await visitor("shop-a");
  const match = await matchVisit("shop-a", call("shop-a", late), NOW);
  assert.equal(await rowsWritten(() => countSteps("shop-a", match, ["app:a0", "app:a1"], NOW)), 1);
  assert.equal(await appStepsOf("shop-a"), 50);
  assert.equal(await markOf("shop-a", "capped-app"), 100);
  assert.equal(await rowsWritten(() => countSteps("shop-a", match, ["app:a2"], NOW)), 0, "the note is written once");
  // A form still counts.
  await countSteps("shop-a", match, ["form"], NOW);
  assert.equal(await markOf("shop-a", "form"), 1);
  const f = (await funnelStats("shop-b", 30, NOW))!;
  assert.deepEqual([f.stepsPausedToday, f.pausedToday, f.free], [100, null, true]);
});

test("paid plans' daily numbers are what they were, for people and app steps alike, on every plan", async () => {
  forgetServerMemory();
  assert.deepEqual(
    { ...PLAN_PEOPLE },
    { lite: 20_000, pro: 50_000, power: 100_000, business: 150_000, max: 300_000, agency: 500_000 },
  );
  // Every plan Flash sells has its number.
  assert.deepEqual(PLANS.map((p) => p.id).sort(), Object.keys(PLAN_PEOPLE).sort());
  for (const plan of PLANS) {
    await owner(`paid-${plan.id}`, plan.id);
    assert.deepEqual(await peopleCap(`paid-${plan.id}`, NOW), { cap: PLAN_PEOPLE[plan.id], steps: PLAN_PEOPLE[plan.id], paid: true }, plan.id);
  }
  assert.deepEqual(await peopleCap("free1", NOW), { cap: 1_000, steps: 100, paid: false });

  // A Lite owner already past the free numbers today goes on counting people and app steps.
  await site("lite-1", "paid-lite", ["booked"]);
  await run("INSERT INTO owner_people (user_id, day, people, steps) VALUES ('paid-lite', ?, 1500, 150)", [TODAY]);
  const who = await visitor("lite-1");
  assert.equal(await peopleOf("paid-lite"), 1_501);
  await countSteps("lite-1", await matchVisit("lite-1", call("lite-1", who), NOW), ["app:booked"], NOW);
  assert.equal(await stepsOf("paid-lite"), 151);
  assert.equal(await appStepsOf("lite-1"), 1);
  const f = (await funnelStats("lite-1", 30, NOW))!;
  assert.deepEqual([f.pausedToday, f.stepsPausedToday, f.free, f.pausedWeek], [null, null, false, null]);
});

test("the track route's rate limit on the free plan: past it a request still answers 204 at once and writes nothing", async () => {
  forgetServerMemory();
  assert.deepEqual([TRACK_STEPS_PER_CONNECTION, TRACK_STEPS_PER_APP], [10, 30]);
  await owner("free4");
  await site("quiz", "free4", names("q"));
  const office = "10.200.0.1";
  // One connection: a person sends the app's 10 names one at a time, all counted.
  const ana = await visitor("quiz", office);
  for (const name of names("q")) assert.equal((await track("quiz", ana, name)).status, 204);
  assert.equal(await appStepsOf("quiz"), 10);
  // The 11th request from that connection within the minute, by someone else there: 204, nothing written.
  const ben = await visitor("quiz", office);
  let res: Response | undefined;
  assert.equal(await rowsWritten(async () => (res = await track("quiz", ben, "q0"))), 0);
  assert.equal(res!.status, 204);
  assert.equal(res!.headers.get("access-control-allow-origin"), "*");
  assert.equal(await appStepsOf("quiz"), 10);
  assert.equal(await stepsOf("free4"), 10);
  assert.equal(await n("SELECT COUNT(*) AS n FROM site_people WHERE site_slug = 'quiz' AND steps = '[]'"), 1, "nothing on the second person's list");
  // Another connection still counts, up to the app's 30 a minute from everyone.
  for (let c = 1; c <= 2; c++) {
    const who = await visitor("quiz", `10.200.${c}.1`);
    for (const name of names("q")) await track("quiz", who, name);
  }
  assert.equal(await appStepsOf("quiz"), 30);
  const carla = await visitor("quiz", "10.200.9.1");
  assert.equal(await rowsWritten(() => track("quiz", carla, "q5")), 0, "the app's 31st in the minute");
  assert.equal(await appStepsOf("quiz"), 30);
  // A minute later it counts again: the turned-away name was never put on the person's list. The
  // office's connection has used its share of the day on this server (see the next test), though.
  await run("UPDATE rate_limits SET reset_at = 0 WHERE key >= 'track-' AND key < 'track.'");
  await track("quiz", carla, "q5");
  await track("quiz", ben, "q0");
  assert.equal(await appStepsOf("quiz"), 31);
  // Requests that count nothing (a name already counted, one not in the app's code, or one past the
  // connection's share of the day) use none of it.
  const before = await n("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits WHERE key >= 'track-' AND key < 'track.'");
  await track("quiz", carla, "q5");
  await track("quiz", carla, "not-in-the-code");
  await track("quiz", ben, "q1");
  assert.equal(await n("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits WHERE key >= 'track-' AND key < 'track.'"), before);
  // The limit is kept under a code made with the day's key, never the address.
  const keys = (await all<{ key: string }>("SELECT key FROM rate_limits WHERE key >= 'track-' AND key < 'track.'")).map((r) => r.key);
  assert.ok(keys.length > 0 && keys.every((k) => /^track-(net:quiz:[0-9a-f]{24}|app:quiz)$/.test(k)), keys.join());

  // A limit that can't be read counts nothing (and the server log says so once, see the last test).
  const client = await db();
  const execute = client.execute.bind(client);
  client.execute = ((s: { sql: string } | string, ...rest: unknown[]) => {
    if ((typeof s === "string" ? s : s.sql).includes("rate_limits")) return Promise.reject(new Error("database busy"));
    return (execute as (...a: unknown[]) => unknown)(s, ...rest);
  }) as typeof client.execute;
  try {
    const dan = await visitor("quiz", "10.200.10.1");
    assert.equal((await track("quiz", dan, "q1")).status, 204);
  } finally {
    client.execute = execute;
  }
  assert.equal(await appStepsOf("quiz"), 31);

  // A paid plan's apps aren't limited, and keep no rate limit rows.
  await owner("pro4", "pro");
  await site("pro-quiz", "pro4", names("p"));
  const eve = await visitor("pro-quiz", "10.201.0.1");
  for (const name of names("p")) await track("pro-quiz", eve, name);
  const fay = await visitor("pro-quiz", "10.201.0.1");
  await track("pro-quiz", fay, "p0");
  assert.equal(await appStepsOf("pro-quiz"), 11);
  assert.equal(await n("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'track-%pro-quiz%'"), 0);

  // The daily prune deletes the limits whose minute is over, and nothing else in rate_limits.
  await run("INSERT INTO rate_limits (key, count, reset_at) VALUES ('funnel:someone', 1, ?)", [NOW + 3_600_000]);
  await run("UPDATE rate_limits SET reset_at = ? WHERE key >= 'track-' AND key < 'track.'", [NOW + 60_000]);
  await run("DELETE FROM settings WHERE key = 'visits_pruned'");
  assert.equal(await pruneDaily(NOW + DAY), true);
  assert.equal(await n("SELECT COUNT(*) AS n FROM rate_limits WHERE key >= 'track-' AND key < 'track.'"), 0);
  assert.equal(await n("SELECT COUNT(*) AS n FROM rate_limits WHERE key = 'funnel:someone'"), 1);
});

test("the rate limit counts app steps, not requests, and one connection counts at most a tenth of the free plan's day of them", async () => {
  forgetServerMemory();
  await run("DELETE FROM rate_limits");
  // A tenth of the free day from one connection, for people and app steps alike.
  assert.deepEqual([NETWORK_PEOPLE, NETWORK_STEPS], [FREE_PEOPLE_PER_DAY / 10, FREE_STEPS_PER_DAY / 10]);
  await owner("free6");
  await site("quiz6", "free6", names("q"));
  // One connection, 10 browsers, each sending all 10 of the app's names (anyone can read them in its
  // page) in one request: 10 steps, not 100.
  const ip = "10.210.0.1";
  for (let i = 0; i < 10; i++) assert.equal((await track("quiz6", await visitor("quiz6", ip), names("q").join("\n"))).status, 204);
  assert.equal(await appStepsOf("quiz6"), 10);
  assert.equal(await stepsOf("free6"), 10);
  assert.equal(await n("SELECT count AS n FROM rate_limits WHERE key LIKE 'track-net:quiz6:%'"), 10, "counted in steps");
  // A minute later, none more from it today on this server: it has its share of the day.
  await run("UPDATE rate_limits SET reset_at = 0 WHERE key >= 'track-' AND key < 'track.'");
  await track("quiz6", await visitor("quiz6", ip), "q0");
  assert.equal(await appStepsOf("quiz6"), 10);
  // Other connections, 30 steps a minute to the app from all of them: a request past it counts the
  // part that fits, and the rest of its names can count later.
  for (const [i, list] of [names("q"), names("q"), names("q").slice(0, 5)].entries()) await track("quiz6", await visitor("quiz6", `10.210.${i + 1}.1`), list.join("\n"));
  assert.equal(await appStepsOf("quiz6"), 35);
  const last = await visitor("quiz6", "10.210.9.1");
  await track("quiz6", last, names("q").join("\n"));
  assert.equal(await appStepsOf("quiz6"), 40);
  assert.equal(await n("SELECT count AS n FROM rate_limits WHERE key = 'track-app:quiz6'"), 30);
  await track("quiz6", await visitor("quiz6", "10.210.10.1"), "q0");
  assert.equal(await appStepsOf("quiz6"), 40, "the app's 31st step in the minute");
  await run("UPDATE rate_limits SET reset_at = 0 WHERE key >= 'track-' AND key < 'track.'");
  await track("quiz6", last, names("q").join("\n"));
  assert.equal(await appStepsOf("quiz6"), 45, "the 5 that didn't fit, a minute later");
  assert.equal(await stepsOf("free6"), 45);
});

test("track requests at the same moment never take the rate limit past its numbers, and those turned away write nothing", async () => {
  forgetServerMemory();
  await run("DELETE FROM rate_limits");
  await owner("free10");
  await site("burst", "free10", names("q"));
  // 40 connections, each sending all 10 of the app's names at once, while the app has room for 30.
  const crowd: Record<string, string>[] = [];
  for (let i = 0; i < 40; i++) crowd.push(await visitor("burst", `10.230.${i}.1`));
  const appCount = () => n("SELECT count AS n FROM rate_limits WHERE key = 'track-app:burst'");
  const burst = () =>
    rowsWritten(async () => {
      await Promise.all(crowd.map((who) => trackRoute.POST(call("burst", who, names("q").join("\n")), ctx("burst"))));
      await afterwards();
    });
  const first = await burst();
  assert.equal(await appStepsOf("burst"), 30);
  assert.equal(await stepsOf("free10"), 30);
  assert.equal(await appCount(), 30, "never past the app's 30");
  assert.equal(await n("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'track-net:burst:%'"), 3, "only the 3 requests that counted");
  // What the 3 counted wrote, and nothing for the 37 turned away: 2 limits, the list, the owner's count
  // and 10 steps each, and the day's 10 names once.
  assert.equal(first, 3 * 14 + 10);
  // Later that minute someone else's step still counts nowhere, as the app had its 30; a minute on,
  // it counts, and the crowd again writes only for the requests that count.
  const real = await visitor("burst", "10.231.0.1");
  assert.equal(await rowsWritten(() => track("burst", real, "q0")), 0);
  await run("UPDATE rate_limits SET reset_at = 0 WHERE key >= 'track-' AND key < 'track.'");
  Date.now = () => NOW + 61_000;
  try {
    await burst();
    assert.equal(await appCount(), 30);
    assert.equal(await appStepsOf("burst"), 60);
    await run("UPDATE rate_limits SET reset_at = 0 WHERE key >= 'track-' AND key < 'track.'");
    await track("burst", real, "q0");
    assert.equal(await appStepsOf("burst"), 61);
  } finally {
    Date.now = () => NOW;
  }
  // The connection's 10 taken by its request to another server after this one read the limit: nothing
  // counts here, and nothing is written but that other server's take, not even of the app's 30.
  await site("burst2", "free10", names("q"));
  const other = await visitor("burst2", "10.232.0.1");
  const client = await db();
  const batch = client.batch.bind(client);
  client.batch = (async (list: { sql: string; args: InValue[] }[], ...rest: unknown[]) => {
    const take = list.find((s) => s.sql.startsWith("INSERT INTO rate_limits"));
    const key = take?.args.find((a) => String(a).startsWith("track-net:"));
    if (key) await run("INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 10, ?) ON CONFLICT DO UPDATE SET count = 10", [key, NOW + 60_000]);
    return (batch as (...a: unknown[]) => unknown)(list, ...rest);
  }) as typeof client.batch;
  try {
    assert.equal(await rowsWritten(() => track("burst2", other, names("q").join("\n"))), 1, "only the other server's take");
  } finally {
    client.batch = batch;
  }
  assert.equal(await appStepsOf("burst2"), 0);
  assert.equal(await n("SELECT COUNT(*) AS n FROM rate_limits WHERE key = 'track-app:burst2'"), 0);
  // The same with the connection's 10 counted on another server before this one read it, though this
  // server has 9 of its share of the day left: a request it turns away writes nothing, and with 1 of
  // the 10 left, the first of 2 names counts.
  await site("burst3", "free10", names("q"));
  const near = await visitor("burst3", "10.233.0.1");
  await track("burst3", near, "q0");
  await run("UPDATE rate_limits SET count = 10 WHERE key LIKE 'track-net:burst3:%'");
  assert.equal(await rowsWritten(() => track("burst3", near, "q1")), 0);
  assert.equal(await appStepsOf("burst3"), 1);
  await run("UPDATE rate_limits SET count = 9 WHERE key LIKE 'track-net:burst3:%'");
  await track("burst3", near, "q1\nq2");
  assert.deepEqual(
    (await all<{ step: string }>("SELECT step FROM site_events WHERE site_slug = 'burst3' AND step LIKE 'app:%' ORDER BY step")).map((r) => r.step),
    ["app:q0", "app:q1"],
  );
  assert.equal(await n("SELECT count AS n FROM rate_limits WHERE key LIKE 'track-net:burst3:%'"), 10);
});

test("the same step sent many times at once by one person counts once, and the copies that lose the race write nothing", async () => {
  forgetServerMemory();
  await run("DELETE FROM rate_limits");
  await owner("free14");
  await site("dup", "free14", names("d"));
  await site("dup-once", "free14", names("d"));
  const who = await visitor("dup", "10.250.0.1");
  // A double tap, a re-run effect, or 10 copies sent on purpose, each of one name.
  const copies = (slug: string, name: string, times: number) =>
    rowsWritten(async () => {
      await Promise.all(Array.from({ length: times }, () => trackRoute.POST(call(slug, who, name), ctx(slug))));
      await afterwards();
    });
  const once = await copies("dup", "d0", 1);
  assert.equal(await copies("dup", "d1", 10), once, "10 copies write what 1 does");
  assert.equal(await appStepsOf("dup"), 2);
  assert.equal(await stepsOf("free14"), 2);
  assert.equal(await n("SELECT count AS n FROM rate_limits WHERE key = 'track-app:dup'"), 2);
  assert.equal(await n("SELECT count AS n FROM rate_limits WHERE key LIKE 'track-net:dup:%'"), 2);
  // A minute apart, the rest of the app's names, each sent 10 times at once, write what they write
  // sent once each on another app.
  let tenEach = 0;
  let oneEach = 0;
  const one = await visitor("dup-once", "10.250.1.1");
  try {
    for (const [i, name] of names("d").slice(2).entries()) {
      Date.now = () => NOW + (i + 1) * 61_000;
      tenEach += await copies("dup", name, 10);
      oneEach += await rowsWritten(() => track("dup-once", one, name));
    }
  } finally {
    Date.now = () => NOW;
  }
  assert.equal(await appStepsOf("dup"), 10);
  assert.equal(await appStepsOf("dup-once"), 8);
  assert.equal(tenEach, oneEach);
});

test("a track request that loses the race for the person's list takes nothing of the rate limit, and counts again what still fits", async () => {
  forgetServerMemory();
  await run("DELETE FROM rate_limits");
  await owner("free11");
  await site("race", "free11", names("r"));
  const who = await visitor("race", "10.240.0.1");
  // Others used 29 of the app's 30 this minute: 1 more step fits.
  await run("INSERT INTO rate_limits (key, count, reset_at) VALUES ('track-app:race', 29, ?)", [NOW + 60_000]);
  const match = await matchVisit("race", call("race", who), NOW);
  // The same person's form at the same moment changes their list first.
  await Promise.all([
    countSteps("race", match, names("r").map((s) => `app:${s}` as const), NOW, { rateLimit: true }),
    countSteps("race", match, ["form"], NOW),
  ]);
  assert.equal(await appStepsOf("race"), 1);
  assert.equal(await markOf("race", "form"), 1);
  assert.equal(await n("SELECT count AS n FROM rate_limits WHERE key = 'track-app:race'"), 30);
  // The same name twice at once: one counts it, and the other takes nothing of the limit.
  await run("DELETE FROM rate_limits");
  const again = await matchVisit("race", call("race", who), NOW);
  await Promise.all([1, 2].map(() => countSteps("race", again, ["app:r5"], NOW, { rateLimit: true })));
  assert.equal(await appStepsOf("race"), 2);
  assert.equal(await n("SELECT count AS n FROM rate_limits WHERE key = 'track-app:race'"), 1);
  assert.equal(await n("SELECT count AS n FROM rate_limits WHERE key LIKE 'track-net:race:%'"), 1);
  // Lost on the retry too: nothing counted, and nothing taken or written.
  const client = await db();
  const batch = client.batch.bind(client);
  client.batch = ((list: { sql: string }[], ...rest: unknown[]) => {
    if (list[0]?.sql.startsWith("UPDATE site_people SET steps")) return Promise.resolve(list.map(() => ({ rows: [], rowsAffected: 0 })));
    return (batch as (...a: unknown[]) => unknown)(list, ...rest);
  }) as typeof client.batch;
  try {
    const lost = await matchVisit("race", call("race", who), NOW);
    assert.equal(await rowsWritten(() => countSteps("race", lost, ["app:r6", "app:r7"], NOW, { rateLimit: true })), 0);
  } finally {
    client.batch = batch;
  }
  assert.equal(await appStepsOf("race"), 2);
  assert.equal(await n("SELECT count AS n FROM rate_limits WHERE key = 'track-app:race'"), 1);
  assert.equal(await n("SELECT count AS n FROM rate_limits WHERE key LIKE 'track-net:race:%'"), 1);
});

test("a step the rate limit turns away writes no note that the day's app steps stopped counting", async () => {
  forgetServerMemory();
  await run("DELETE FROM rate_limits");
  await owner("free12");
  await site("note", "free12", names("n"));
  const who = await visitor("note", "10.252.0.1");
  // 95 of the day's 100 counted, and the app's 30 this minute used by others.
  await run("UPDATE owner_people SET steps = 95 WHERE user_id = 'free12' AND day = ?", [TODAY]);
  await run("INSERT INTO rate_limits (key, count, reset_at) VALUES ('track-app:note', 30, ?)", [NOW + 60_000]);
  assert.equal(await rowsWritten(() => track("note", who, names("n").join("\n"))), 0);
  assert.equal(await markOf("note", "capped-app"), null);
  const f = (await funnelStats("note", 30, NOW))!;
  assert.deepEqual([f.stepsPausedToday, f.stepsPaused], [null, []]);
  // A minute later the request that reaches the 100 writes it.
  await run("UPDATE rate_limits SET reset_at = 0 WHERE key >= 'track-' AND key < 'track.'");
  await track("note", who, names("n").join("\n"));
  assert.equal(await stepsOf("free12"), 100);
  assert.equal(await markOf("note", "capped-app"), 100);
});

/** Runs fn while before() runs ahead of each batch whose first statement starts with start. */
async function beforeBatches(start: string, before: () => Promise<unknown>, fn: () => Promise<unknown>) {
  const client = await db();
  const batch = client.batch.bind(client);
  client.batch = (async (list: ({ sql: string } | string)[], ...rest: unknown[]) => {
    const first = list[0];
    if ((typeof first === "string" ? first : first?.sql)?.startsWith(start)) await before();
    return (batch as (...a: unknown[]) => unknown)(list, ...rest);
  }) as typeof client.batch;
  try {
    await fn();
  } finally {
    client.batch = batch;
  }
}

test("the note that the day's app steps stopped counting is written though the request that first had it wrote nothing", async () => {
  forgetServerMemory();
  await run("DELETE FROM rate_limits");
  await owner("free15");
  await site("mark-lost", "free15", names("m"));
  const a = await visitor("mark-lost", "10.253.0.1");
  // 99 of the day's 100 counted, and 29 of the app's 30 this minute used by others.
  await run("UPDATE owner_people SET steps = 99 WHERE user_id = 'free15' AND day = ?", [TODAY]);
  await run("INSERT INTO rate_limits (key, count, reset_at) VALUES ('track-app:mark-lost', 29, ?)", [NOW + 60_000]);
  // m0 would be the 100th and m1 past it, but another server takes the app's last place this minute
  // just before this request writes, so it writes nothing, its retry too.
  let taken = false;
  const takeLast = async () => {
    if (taken) return;
    taken = true;
    await run("UPDATE rate_limits SET count = 30 WHERE key = 'track-app:mark-lost'");
  };
  await beforeBatches("UPDATE site_people SET steps", takeLast, () => track("mark-lost", a, "m0\nm1"));
  assert.deepEqual([await stepsOf("free15"), await appStepsOf("mark-lost"), await markOf("mark-lost", "capped-app")], [99, 0, null]);
  // A minute later someone's step is the 100th, and the next request past it writes the note.
  await run("UPDATE rate_limits SET reset_at = 0 WHERE key >= 'track-' AND key < 'track.'");
  await track("mark-lost", await visitor("mark-lost", "10.253.0.2"), "m2");
  assert.equal(await stepsOf("free15"), 100);
  await track("mark-lost", await visitor("mark-lost", "10.253.0.3"), "m3\nm4");
  assert.equal(await markOf("mark-lost", "capped-app"), 100);
  assert.deepEqual((await funnelStats("mark-lost", 30, NOW + DAY))!.stepsPaused, [{ day: TODAY, steps: 100 }]);

  // A double tap on the 100th step, the copy that has the note writing after the other: its retry
  // writes the note, and the step counts once.
  forgetServerMemory();
  await owner("free16");
  await site("mark-tap", "free16", names("m"));
  const b = await visitor("mark-tap", "10.253.1.1");
  await run("UPDATE owner_people SET steps = 99 WHERE user_id = 'free16' AND day = ?", [TODAY]);
  let first = true;
  const later = async () => {
    if (!first) return;
    first = false;
    await new Promise((r) => setTimeout(r, 50));
  };
  await beforeBatches("UPDATE site_people SET steps", later, async () => {
    await Promise.all([1, 2].map(() => trackRoute.POST(call("mark-tap", b, "m0\nm1"), ctx("mark-tap"))));
    await afterwards();
  });
  assert.deepEqual([await stepsOf("free16"), await appStepsOf("mark-tap"), await markOf("mark-tap", "capped-app")], [100, 1, 100]);

  // Two people at once with the app's last place this minute: the one who gets it counts the 100th,
  // and the other, who had the note, writes it on its retry.
  forgetServerMemory();
  await run("DELETE FROM rate_limits");
  await owner("free17");
  await site("mark-two", "free17", ["a", "b"]);
  const [p1, p2] = [await visitor("mark-two", "10.253.2.1"), await visitor("mark-two", "10.253.2.2")];
  await run("UPDATE owner_people SET steps = 99 WHERE user_id = 'free17' AND day = ?", [TODAY]);
  await run("INSERT INTO rate_limits (key, count, reset_at) VALUES ('track-app:mark-two', 29, ?)", [NOW + 60_000]);
  const [m1, m2] = [await matchVisit("mark-two", call("mark-two", p1), NOW), await matchVisit("mark-two", call("mark-two", p2), NOW)];
  await Promise.all([
    countSteps("mark-two", m2, ["app:a"], NOW, { rateLimit: true }),
    countSteps("mark-two", m1, ["app:a", "app:b"], NOW, { rateLimit: true }),
  ]);
  assert.deepEqual([await stepsOf("free17"), await appStepsOf("mark-two"), await markOf("mark-two", "capped-app")], [100, 1, 100]);
  await run("DELETE FROM rate_limits");
});

test("the note that counting paused is written though the load that first had it failed to write", async () => {
  forgetServerMemory();
  await owner("free18");
  await site("paused-lost", "free18");
  await visitor("paused-lost");
  await run("UPDATE owner_people SET people = 1000 WHERE user_id = 'free18' AND day = ?", [TODAY]);
  let failed = false;
  const failOnce = async () => {
    if (failed) return;
    failed = true;
    throw new Error("the database is busy");
  };
  await beforeBatches("INSERT INTO site_events", failOnce, () => visitor("paused-lost"));
  assert.ok(failed);
  assert.equal(await markOf("paused-lost", "capped"), null);
  await visitor("paused-lost");
  assert.equal(await markOf("paused-lost", "capped"), 1_000);
  assert.equal(await peopleOf("free18"), 1_000);
});

test("one connection's rate limit has a code of its own on each app, so nothing ties its use of two apps together", async () => {
  forgetServerMemory();
  await run("DELETE FROM rate_limits");
  await owner("free7a");
  await owner("free7b");
  await site("app7a", "free7a", ["go"]);
  await site("app7b", "free7b", ["go"]);
  await site("app7c", "free7a", ["go"]);
  for (const slug of ["app7a", "app7b", "app7c"]) await track(slug, await visitor(slug, "10.220.0.1"), "go");
  const keys = (await all<{ key: string }>("SELECT key FROM rate_limits WHERE key LIKE 'track-net:%' ORDER BY key")).map((r) => r.key);
  assert.equal(keys.length, 3, keys.join());
  const codes = keys.map((k) => k.split(":")[2]);
  assert.ok(codes.every((c) => /^[0-9a-f]{24}$/.test(c)), codes.join());
  assert.equal(new Set(codes).size, 3, "a code per app, also for one owner's two apps");
});

test("a paid owner near the free number counts every new person answered at the same moment", async () => {
  forgetServerMemory();
  await owner("lite8", "lite");
  await site("big8", "lite8");
  await visitor("big8");
  // 899 people today: within a hundred of the free plan's 1,000.
  await run("UPDATE owner_people SET people = 899 WHERE user_id = 'lite8' AND day = ?", [TODAY]);
  await Promise.all(Array.from({ length: 150 }, () => recordVisit("big8", page("big8", person()), null, NOW)));
  assert.equal(await visitorsOf("big8"), 151);
  assert.equal(await peopleOf("lite8"), 1_049);
  assert.equal(await markOf("big8", "capped"), null);
});

test("new people answered at the same moment on a server that hasn't read the plan wait for one read of it", async () => {
  forgetServerMemory();
  await owner("free13");
  await site("stamp", "free13");
  await visitor("stamp");
  forgetServerMemory();
  const sent = await statementsDuring(() => Promise.all(Array.from({ length: 50 }, () => recordVisit("stamp", page("stamp", person()), null, NOW))));
  assert.equal(sent.filter((sql) => /FROM subscriptions/.test(sql)).length, 1);
  assert.equal(sent.filter((sql) => /FROM users/.test(sql)).length, 1);
  assert.equal(await visitorsOf("stamp"), 51);
  // A read that answers after the owner's view read the plan they just bought keeps nothing.
  forgetServerMemory();
  const client = await db();
  const execute = client.execute.bind(client);
  let release = () => {};
  const held = new Promise<void>((done) => (release = done));
  client.execute = ((s: { sql: string } | string, ...rest: unknown[]) => {
    const r = (execute as (...a: unknown[]) => Promise<unknown>)(s, ...rest);
    return (typeof s === "string" ? s : s.sql).includes("FROM subscriptions") ? r.then((x) => held.then(() => x)) : r;
  }) as typeof client.execute;
  try {
    const late = peopleCap("free13", NOW);
    await new Promise((done) => setTimeout(done, 20));
    await run(
      `INSERT INTO subscriptions (id, user_id, plan, interval, status, amount_cents, anchor, paid_until, test, created_at, updated_at)
       VALUES ('sub-free13', 'free13', 'lite', 'month', 'active', 100, 0, ?, 1, 0, 0)`,
      [Date.UTC(2100, 0, 1)],
    );
    const bought = peopleCap("free13", NOW, true);
    release();
    assert.equal((await bought).paid, true);
    assert.equal((await late).paid, false, "read before the purchase");
  } finally {
    client.execute = execute;
  }
  assert.deepEqual(await peopleCap("free13", NOW + 1_000), { cap: PLAN_PEOPLE.lite, steps: PLAN_PEOPLE.lite, paid: true });
});

test("a free owner whose counting paused on 2 or more of the last 7 days is offered an upgrade, on every app; one day, older days, other notes or a paid plan aren't", async () => {
  forgetServerMemory();
  assert.equal(PAUSED_DAYS_OFFER, 2);
  await owner("free5");
  await site("w-a", "free5");
  await site("w-b", "free5");
  await site("w-c", "free5");
  await owner("other5");
  await site("w-x", "other5");
  const mark = (slug: string, daysAgo: number, step = "capped", value = 1_000) =>
    run("INSERT INTO site_events (site_slug, day, step, source, medium, campaign, n) VALUES (?, ?, ?, '', '', '', ?)", [slug, dayOf(NOW - daysAgo * DAY), step, value]);
  const week = async (slug: string) => {
    const f = (await funnelStats(slug, 30, NOW))!;
    return [f.pausedWeek, f.free];
  };
  // One day, and no plan read for it.
  await mark("w-a", 1);
  const reads = await statementsDuring(async () => assert.deepEqual(await week("w-c"), [null, false]));
  assert.ok(!reads.some((sql) => /subscriptions|FROM users/.test(sql)), "no plan read");
  // The steps' and one connection's notes, a day 7 days back, a day paused under a lower number than
  // the free plan's (as if it were raised), and another owner's days don't count.
  await mark("w-b", 2, "capped-app", 1_000);
  await mark("w-b", 3, "capped-net", 1_000);
  await mark("w-b", 7);
  await mark("w-b", 4, "capped", 500);
  await mark("w-x", 2);
  await mark("w-x", 3);
  assert.deepEqual(await week("w-c"), [null, false]);
  assert.deepEqual(await week("w-x"), [{ days: 2, people: 1_000 }, true], "the other owner's own two days");
  // A second day in the last 7, on another of their apps: offered on each of their apps, the one with
  // no paused day among them.
  await mark("w-b", 6);
  for (const slug of ["w-a", "w-b", "w-c"]) assert.deepEqual(await week(slug), [{ days: 2, people: 1_000 }, true], slug);
  // Two apps paused the same day is one day; today counts too.
  await mark("w-a", 6);
  assert.deepEqual(await week("w-c"), [{ days: 2, people: 1_000 }, true]);
  await mark("w-c", 0);
  assert.deepEqual(await week("w-c"), [{ days: 3, people: 1_000 }, true]);

  // On a paid plan the same days offer nothing.
  await run(
    `INSERT INTO subscriptions (id, user_id, plan, interval, status, amount_cents, anchor, paid_until, test, created_at, updated_at)
     VALUES ('sub-free5', 'free5', 'lite', 'month', 'active', 100, 0, ?, 1, 0, 0)`,
    [Date.UTC(2100, 0, 1)],
  );
  forgetServerMemory();
  for (const slug of ["w-a", "w-b", "w-c"]) assert.deepEqual(await week(slug), [null, false], slug);
});

test("the upgrade offer goes away as soon as the owner buys a plan, though this server read their plan a moment before", async () => {
  forgetServerMemory();
  await owner("free9");
  await site("w9", "free9");
  for (const daysAgo of [1, 3]) {
    await run("INSERT INTO site_events (site_slug, day, step, source, medium, campaign, n) VALUES ('w9', ?, 'capped', '', '', '', 1000)", [dayOf(NOW - daysAgo * DAY)]);
  }
  // Paused today too, on this server: the 1,001st person wasn't counted.
  await visitor("w9");
  await run("UPDATE owner_people SET people = 1000 WHERE user_id = 'free9' AND day = ?", [TODAY]);
  await visitor("w9");
  assert.equal(await peopleOf("free9"), 1_000);
  const before = (await funnelStats("w9", 30, NOW))!;
  assert.deepEqual([before.pausedWeek, before.pausedToday, before.free], [{ days: 3, people: 1_000 }, 1_000, true]);
  // Lite, bought right after: the view offers nothing, and this server counts by Lite from now on.
  await run(
    `INSERT INTO subscriptions (id, user_id, plan, interval, status, amount_cents, anchor, paid_until, test, created_at, updated_at)
     VALUES ('sub-free9', 'free9', 'lite', 'month', 'active', 100, 0, ?, 1, 0, 0)`,
    [Date.UTC(2100, 0, 1)],
  );
  const after = (await funnelStats("w9", 30, NOW + 1_000))!;
  assert.deepEqual([after.pausedWeek, after.pausedToday, after.free], [null, null, false]);
  // Today's mark stays, for the note that counting paused earlier today (see funnel-notes.test.ts).
  assert.deepEqual(after.paused[0], { day: TODAY, people: 1_000 });
  assert.deepEqual(await peopleCap("free9", NOW + 2_000), { cap: PLAN_PEOPLE.lite, steps: PLAN_PEOPLE.lite, paid: true });
  const visitors = await visitorsOf("w9");
  await recordVisit("w9", page("w9", person()), null, NOW + 3_000);
  assert.equal(await peopleOf("free9"), 1_001, "the next new person counts at once");
  assert.equal(await visitorsOf("w9"), visitors + 1);
});

/** Makes the database refuse the statements fails picks while fn runs, as if it were down for them. */
async function failing(fails: (sql: string, args: unknown) => boolean, fn: () => Promise<unknown>): Promise<void> {
  const client = await db();
  const execute = client.execute.bind(client);
  client.execute = ((s: { sql: string; args?: unknown } | string, ...rest: unknown[]) => {
    const sql = typeof s === "string" ? s : s.sql;
    if (fails(sql, typeof s === "string" ? [] : s.args)) return Promise.reject(new Error("database unavailable"));
    return (execute as (...a: unknown[]) => unknown)(s, ...rest);
  }) as typeof client.execute;
  try {
    await fn();
  } finally {
    client.execute = execute;
  }
}

test("an owner's plan that can't be read counts new people and app steps by the free plan's numbers rather than none, without the note that counting paused", async () => {
  forgetServerMemory();
  await owner("unread-free");
  await site("unread-loaf", "unread-free", ["go"]);
  await owner("unread-lite", "lite");
  await site("unread-big", "unread-lite");
  await visitor("unread-big");
  // The paid owner has counted 1,500 people today, past the free plan's 1,000.
  await run("UPDATE owner_people SET people = 1500 WHERE user_id = 'unread-lite' AND day = ?", [TODAY]);
  forgetServerMemory();
  const views = await viewsOf("unread-big");
  await failing(
    (sql) => sql.includes("FROM subscriptions"),
    async () => {
      // The free owner's new person and their app step count.
      const who = await visitor("unread-loaf");
      assert.deepEqual([await visitorsOf("unread-loaf"), await peopleOf("unread-free"), await viewsOf("unread-loaf")], [1, 1, 1]);
      await track("unread-loaf", who, "go");
      assert.equal(await appStepsOf("unread-loaf"), 1);
      // The paid owner's is a view, as past any day's number, and no note says counting paused at 1,000.
      await visitor("unread-big");
      assert.deepEqual([await visitorsOf("unread-big"), await viewsOf("unread-big")], [1, views + 1]);
      assert.equal(await markOf("unread-big", "capped"), null);
    },
  );
  // A read that failed is kept for 30 seconds (see the next test); after that, the next new person
  // counts by Lite's number.
  await recordVisit("unread-big", page("unread-big", person()), null, NOW + 31_000);
  assert.deepEqual([await visitorsOf("unread-big"), await peopleOf("unread-lite")], [2, 1_501]);
  assert.equal(await markOf("unread-big", "capped"), null);
});

test("a plan read that failed is kept for 30 seconds, so a database hiccup isn't asked again on every visit, and the log says so at most once a minute", async () => {
  forgetServerMemory();
  await owner("hiccup-lite", "lite");
  await site("hiccup-app", "hiccup-lite");
  await visitor("hiccup-app");
  // Past the free plan's 1,000 people today: by the free numbers a new person is a view, by Lite's they count.
  await run("UPDATE owner_people SET people = 1500 WHERE user_id = 'hiccup-lite' AND day = ?", [TODAY]);
  forgetServerMemory();
  const visitAt = (later: number) => recordVisit("hiccup-app", page("hiccup-app", person()), null, NOW + later);
  const plansRead = async (fn: () => Promise<unknown>) => (await statementsDuring(fn)).filter((sql) => sql.includes("FROM subscriptions")).length;
  const logged = () => errors.filter((line) => line.includes("owner's plan not read")).length;
  const before = logged();
  const subscriptions = (sql: string) => sql.includes("FROM subscriptions");
  await failing(subscriptions, async () => {
    assert.equal(await plansRead(() => visitAt(0)), 1);
    assert.equal(await plansRead(() => visitAt(1_000)), 0, "the failed read is kept: no second read a second later");
  });
  assert.deepEqual([await visitorsOf("hiccup-app"), await peopleOf("hiccup-lite")], [1, 1_500], "both counted by the free plan's numbers");
  assert.equal(logged() - before, 1, "logged once");
  // The database is back, but for the rest of the 30 seconds the failed read still stands.
  assert.equal(await plansRead(() => visitAt(29_000)), 0);
  assert.equal(await visitorsOf("hiccup-app"), 1);
  // 30 seconds on it is read again; failing again within the minute, it isn't logged again.
  await failing(subscriptions, async () => {
    assert.equal(await plansRead(() => visitAt(31_000)), 1);
    assert.equal(logged() - before, 1, "at most once a minute");
    // A minute after the first line, the next failure is logged.
    assert.equal(await plansRead(() => visitAt(62_000)), 1);
    assert.equal(logged() - before, 2);
  });
  assert.match(errors.filter((line) => line.includes("owner's plan not read")).at(-1)!, /at most once a minute/);
  // Once it can be read, new people count by Lite's number again.
  assert.equal(await plansRead(() => visitAt(93_000)), 1);
  assert.deepEqual([await visitorsOf("hiccup-app"), await peopleOf("hiccup-lite")], [2, 1_501]);
  // A plan read fresh (the owner's own view) ends a kept failure at once. (17 minutes on, the plan
  // read at 93 seconds is no longer used.)
  const later = 17 * 60_000;
  await failing(subscriptions, async () => assert.equal(await plansRead(() => visitAt(later)), 1));
  assert.deepEqual([await visitorsOf("hiccup-app"), await peopleOf("hiccup-lite")], [2, 1_501], "a view, by the free plan's numbers");
  await peopleCap("hiccup-lite", NOW + later + 1, true);
  assert.equal(await plansRead(() => visitAt(later + 2)), 0, "the fresh read is used");
  assert.deepEqual([await visitorsOf("hiccup-app"), await peopleOf("hiccup-lite")], [3, 1_502]);
});

test("past the owners it keeps, a server's plan memory forgets the owner whose plan was used longest ago, not the one read first", async () => {
  forgetServerMemory();
  visits.visitTests.maxPlans = 3;
  try {
    for (const id of ["cache-mem1", "cache-mem2", "cache-mem3", "cache-mem4"]) await owner(id);
    for (const id of ["cache-mem1", "cache-mem2", "cache-mem3"]) await peopleCap(id, NOW);
    const reads = async (id: string, at: number) => (await statementsDuring(() => peopleCap(id, at))).filter((sql) => /FROM subscriptions/.test(sql)).length;
    // The first owner's plan is used again (a new person on one of their apps), then a fourth owner's is read.
    assert.equal(await reads("cache-mem1", NOW + 1_000), 0);
    assert.equal(await reads("cache-mem4", NOW + 2_000), 1);
    assert.equal(await reads("cache-mem1", NOW + 3_000), 0, "used a moment ago: still known");
    assert.equal(await reads("cache-mem3", NOW + 3_000), 0);
    assert.equal(await reads("cache-mem2", NOW + 3_000), 1, "used longest ago: forgotten");
  } finally {
    visits.visitTests.maxPlans = 0;
  }
});

test("a track limit that can't be read counts no app steps on the free plan, and the server log says so once", async () => {
  forgetServerMemory();
  await owner("room-free");
  await site("room-roll", "room-free", ["go", "buy"]);
  const [a, b] = [await visitor("room-roll"), await visitor("room-roll")];
  await failing(
    (sql, args) => /FROM rate_limits WHERE key = \? AND reset_at >= \?/.test(sql) && String((args as unknown[])?.[0]).startsWith("track-"),
    async () => {
      for (const [who, name] of [[a, "go"], [b, "buy"], [a, "buy"]] as const) await track("room-roll", who, name);
    },
  );
  assert.equal(await appStepsOf("room-roll"), 0, "none counted while the limit can't be read");
  // Once for this server, with this test's limits and the earlier one's (when it ran) alike.
  const said = errors.filter((line) => line.includes("track limit not read"));
  assert.equal(said.length, 1, said.join("\n"));
  assert.match(said[0], /Said once per server process/);
  // Once it can be read, the same step counts.
  await track("room-roll", a, "go");
  assert.equal(await appStepsOf("room-roll"), 1);
});
