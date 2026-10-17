import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./support/route-hooks.mjs", import.meta.url);
process.env.DATABASE_URL = ":memory:";
delete process.env.FLASH_APP_URL;
console.error = () => {};
const { run, one, all, db } = await import("../src/lib/server/db.ts");
const { sha256 } = await import("../src/lib/server/ids.ts");
const { createSession } = await import("../src/lib/server/auth.ts");
const { newOwnerCode } = await import("../src/lib/server/site-owner.ts");
const { serveSite } = await import("../src/lib/server/serve-site.ts");
const visits = await import("../src/lib/server/visits.ts");
const { recordVisit, recordOwnerVisit, visitStats, visitSource, isPersonVisit, dayOf, visitorCode, peoplePerDay, pruneDaily, forgetServerMemory, visitTests } = visits;
const { sitesWithMessages } = await import("../src/lib/server/inbox.ts");
const pageRoute = await import("../src/app/p/[slug]/route.ts");
const domainRoute = await import("../src/app/d/[host]/route.ts");
const { afterwards } = await import("./support/next-server.mjs");

const DAY = 86_400_000;
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0";
const visit = (headers: Record<string, string> = {}, path = "/p/crumb-1") =>
  new Request(`https://www.flash-app.dev${path}`, {
    headers: { "user-agent": BROWSER, host: "www.flash-app.dev", "accept-language": "en", "x-forwarded-for": "1.2.3.4", ...headers },
  });
const count = async (sql: string, args: (string | number)[] = []) => Number((await one<{ n: number }>(sql, args))?.n ?? 0);
const viewsOf = (slug: string) => count("SELECT COALESCE(SUM(views), 0) AS n FROM site_visits WHERE site_slug = ?", [slug]);
/** Starts again as a new server on a day nothing has pruned yet. */
async function freshServer() {
  forgetServerMemory();
  await run("DELETE FROM settings WHERE key IN ('visits_pruned', 'funnel_since')");
}
/** Counts the statements this process sends to the database while fn runs. */
async function statementsDuring(fn: () => Promise<unknown>): Promise<string[]> {
  const client = await db();
  const sent: string[] = [];
  const execute = client.execute.bind(client);
  const batch = client.batch.bind(client);
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

await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('u1', 'o@x.co', 'h', 0, 1)");

test("where a visit came from", () => {
  assert.equal(visitSource(null, "www.flash-app.dev"), "");
  assert.equal(visitSource("https://www.flash-app.dev/", "www.flash-app.dev"), "", "Flash itself and reloads are direct");
  assert.equal(visitSource("https://crumbbakery.com/#/menu", "crumbbakery.com"), "");
  assert.equal(visitSource("https://www.google.ca/", "crumbbakery.com"), "google.com");
  assert.equal(visitSource("https://l.instagram.com/?u=x", "crumbbakery.com"), "instagram.com");
  assert.equal(visitSource("https://m.facebook.com/", "crumbbakery.com"), "facebook.com");
  assert.equal(visitSource("https://t.co/abc", "crumbbakery.com"), "x.com");
  assert.equal(visitSource("https://www.yelp.ca/biz/crumb", "crumbbakery.com"), "yelp.ca");
  assert.equal(visitSource("android-app://com.google.android.gm", "crumbbakery.com"), "");
  assert.equal(visitSource("not a url", "crumbbakery.com"), "");
});

test("robots and prefetches aren't visitors", () => {
  assert.equal(isPersonVisit(visit()), true);
  assert.equal(isPersonVisit(visit({ "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" })), false);
  assert.equal(isPersonVisit(visit({ "user-agent": "facebookexternalhit/1.1" })), false);
  assert.equal(isPersonVisit(visit({ "user-agent": "" })), false);
  assert.equal(isPersonVisit(visit({ "sec-purpose": "prefetch" })), false);
  // Link previews in chat apps, AI assistants fetching a page for someone, and scripts.
  assert.equal(isPersonVisit(visit({ "user-agent": "WhatsApp/2.24.6.77 A" })), false);
  assert.equal(isPersonVisit(visit({ "user-agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0)" })), false);
  assert.equal(isPersonVisit(visit({ "user-agent": "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)" })), false);
  assert.equal(isPersonVisit(visit({ "user-agent": "axios/1.7.2" })), false);
  assert.equal(isPersonVisit(visit({ "accept-language": "" })), false, "browsers always say which languages their person reads");
});

test("visits are counted per day and source, people once a day, without the owner", async () => {
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('crumb-1', 'u1', 'Crumb', '<p>', 0, 0)");
  const today = Date.UTC(2026, 9, 4, 15);
  const yesterday = today - DAY;

  await recordVisit("crumb-1", visit(), null, yesterday);
  await recordVisit("crumb-1", visit(), null, today);
  await recordVisit("crumb-1", visit(), null, today); // same person reloading
  await recordVisit("crumb-1", visit({ "x-forwarded-for": "5.6.7.8", referer: "https://www.google.com/" }), null, today);
  await recordVisit("crumb-1", visit({ "user-agent": "Googlebot" }), null, today);
  await recordVisit("crumb-1", visit({ "x-forwarded-for": "9.9.9.9" }), "u1", today); // the owner
  await recordVisit("gone-site", visit(), null, today); // unpublished: writes nothing, doesn't throw

  const stats = await visitStats("crumb-1", today);
  assert.equal(stats.days.length, 30);
  assert.equal(stats.days[29].day, dayOf(today));
  assert.deepEqual(stats.days[29], { day: "2026-10-04", views: 3, visitors: 2 });
  assert.deepEqual(stats.days[28], { day: "2026-10-03", views: 1, visitors: 1 });
  assert.equal(stats.days[0].views, 0);
  assert.equal(stats.views, 4);
  assert.equal(stats.visitors, 3);
  assert.deepEqual(stats.sources, [
    { source: "", views: 3 },
    { source: "google.com", views: 1 },
  ]);
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_visits WHERE site_slug = 'gone-site'"))?.n, 0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM site_people WHERE site_slug = 'gone-site'"), 0);

  // Visits older than 30 days don't show.
  assert.equal((await visitStats("crumb-1", today + 40 * DAY)).views, 0);

  // The list of sites shows the last 30 days' visits (counted from now, so these test days are older).
  const [site] = await sitesWithMessages("u1");
  assert.equal(typeof site.views, "number");

  // Unpublishing takes the stats with it.
  await run("DELETE FROM sites WHERE slug = 'crumb-1'");
  assert.equal(await count("SELECT COUNT(*) AS n FROM site_people"), 0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM site_events"), 0);
});

test("coming back from paying or signing in isn't another view", async () => {
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('back-1', 'u1', 'Back', '<p>', 0, 0)");
  const at = Date.UTC(2026, 9, 5, 12);
  await recordVisit("back-1", visit({}, "/p/back-1"), null, at);
  assert.equal(await viewsOf("back-1"), 1);
  await recordVisit("back-1", visit({}, "/p/back-1?flash_paid=1"), null, at);
  await recordVisit("back-1", visit({}, "/p/back-1?flash_auth=ok"), null, at);
  await recordVisit("back-1", visit({ referer: "https://checkout.stripe.com/" }, "/p/back-1"), null, at);
  assert.equal(await viewsOf("back-1"), 1);
  await recordVisit("back-1", visit({ referer: "https://www.google.com/" }, "/p/back-1"), null, at);
  assert.equal(await viewsOf("back-1"), 2);
});

test("visitor codes are made with a key that changes every day, and only that day's key is made", async () => {
  await freshServer();
  await run("DELETE FROM visit_keys");
  const day = "2026-10-06";
  const a = await visitorCode("x-1", visit(), day);
  assert.match(a, /^[0-9a-f]{24}$/);
  assert.equal(await visitorCode("x-1", visit(), day), a, "the same browser on the same day");
  forgetServerMemory();
  assert.equal(await visitorCode("x-1", visit(), day), a, "every server uses the day's one key");
  assert.notEqual(await visitorCode("x-1", visit(), "2026-10-07"), a, "another day, another code");
  assert.notEqual(await visitorCode("x-2", visit(), day), a, "another app, another code");
  assert.notEqual(await visitorCode("x-1", visit({ "x-forwarded-for": "1.2.3.5" }), day), a);
  assert.notEqual(a, sha256(`${day}|x-1|1.2.3.4|${BROWSER}`).slice(0, 24), "not a hash anyone could make from an address");
  assert.deepEqual((await all<{ day: string }>("SELECT day FROM visit_keys ORDER BY day")).map((r) => r.day), ["2026-10-06", "2026-10-07"]);

  // A visit makes today's key only.
  await run("DELETE FROM visit_keys");
  forgetServerMemory();
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('keys-1', 'u1', 'Keys', '<p>', 0, 0)");
  await recordVisit("keys-1", visit({}, "/p/keys-1"), null, Date.UTC(2026, 9, 8, 0, 0, 30));
  assert.deepEqual((await all<{ day: string }>("SELECT day FROM visit_keys")).map((r) => r.day), ["2026-10-08"]);
});

test("the owner signed in to Flash is noted with the person's read, never counted, and not in the stats", async () => {
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('own-1', 'u1', 'Own', '<p>', 0, 0)");
  const at = Date.UTC(2026, 9, 9, 12);
  await recordVisit("own-1", visit({ "x-forwarded-for": "2.2.2.2" }, "/p/own-1"), null, at); // warms the day's key
  const ownerLoad = visit({ "x-forwarded-for": "3.3.3.3" }, "/p/own-1");
  const sent = await statementsDuring(() => recordVisit("own-1", ownerLoad, "u1", at));
  assert.equal(sent.length, 2, `the person's read and the owner's row, no query of its own: ${sent.join(" | ")}`);
  const code = await visitorCode("own-1", ownerLoad, dayOf(at));
  assert.equal((await one<{ kind: string }>("SELECT kind FROM site_people WHERE site_slug = 'own-1' AND visitor = ?", [code]))?.kind, "owner");
  // Later that day, signed out, the same browser is still the owner.
  await recordVisit("own-1", ownerLoad, null, at + 60_000);
  assert.equal(await viewsOf("own-1"), 1);
  assert.equal((await visitStats("own-1", at)).visitors, 1);
});

test("Open as owner: a working code notes the owner, on /p/ and on the app's domain; any other code writes nothing", async () => {
  const realNow = Date.now;
  const clock = Date.UTC(2026, 9, 10, 12);
  Date.now = () => clock;
  try {
    await freshServer();
    await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('code-1', 'u1', 'Code', '<p>Hi</p>', 0, 0)");
    await run("INSERT INTO site_domains (domain, site_slug, user_id, created_at) VALUES ('codebakery.com', 'code-1', 'u1', 0)");
    const session = (await createSession("u1", true)).split(";")[0].split("=")[1];
    const ctx = (params: object) => ({ params: Promise.resolve(params) }) as never;
    const onFlash = (query: string, ip: string) => pageRoute.GET(visit({ "x-forwarded-for": ip }, `/p/code-1${query}`), ctx({ slug: "code-1" }));
    const onDomain = (query: string, ip: string) =>
      domainRoute.GET(visit({ "x-forwarded-for": ip, host: "codebakery.com" }, `/d/codebakery.com${query}`), ctx({ host: "codebakery.com" }));
    const ownerRows = () => count("SELECT COUNT(*) AS n FROM site_people WHERE site_slug = 'code-1' AND kind = 'owner'");

    // A code made in Flash, used once: the page is in owner view, and the owner's row is written.
    const code = (await newOwnerCode("code-1", "u1", session))!;
    const page = await serveSite("code-1", "https://www.flash-app.dev/p/code-1", visit({ "x-forwarded-for": "4.4.4.4" }, `/p/code-1?flash_owner=${code}`));
    assert.equal(page.ownerView, true);
    await recordOwnerVisit("code-1", visit({ "x-forwarded-for": "4.4.4.4" }, "/p/code-1"));
    assert.equal(await ownerRows(), 1);

    const fresh = (await newOwnerCode("code-1", "u1", session))!;
    const viaRoute = await onFlash(`?flash_owner=${fresh}`, "5.5.5.5");
    await afterwards();
    assert.equal((viaRoute as { ownerView?: true }).ownerView, true);
    assert.equal(await ownerRows(), 2);
    assert.equal(await viewsOf("code-1"), 0, "a load with the code isn't a visit");
    // The same browser later that day, without the code: still the owner, so no view and no person.
    await onFlash("", "5.5.5.5");
    await afterwards();
    assert.equal(await viewsOf("code-1"), 0);

    // A made-up code, or one used already: nothing written, and no view either.
    for (const query of ["?flash_owner=junk", `?flash_owner=${fresh}`]) {
      const p = await onFlash(query, "6.6.6.6");
      const d = await onDomain(query, "6.6.6.7");
      await afterwards();
      assert.equal((p as { ownerView?: true }).ownerView, undefined, query);
      assert.equal((d as { ownerView?: true }).ownerView, undefined, query);
    }
    assert.equal(await ownerRows(), 2);
    assert.equal(await viewsOf("code-1"), 0);
    assert.equal(await count("SELECT COUNT(*) AS n FROM site_people WHERE site_slug = 'code-1' AND kind = 'visit'"), 0);

    // On the app's own domain, a code made for it works there.
    const forDomain = (await newOwnerCode("code-1", "u1", session, "codebakery.com"))!;
    const d = await onDomain(`?flash_owner=${forDomain}`, "7.7.7.7");
    await afterwards();
    assert.equal((d as { ownerView?: true }).ownerView, true);
    assert.equal(await ownerRows(), 3);
    // An ordinary visit on the domain counts.
    await onDomain("", "8.8.8.8");
    await afterwards();
    assert.equal(await viewsOf("code-1"), 1);
    assert.equal((await visitStats("code-1")).visitors, 1);
  } finally {
    Date.now = realNow;
  }
});

test("the daily prune runs on one server once a day, keeps codes 2 days and totals 100 days, and gives the day back when it fails", async () => {
  await freshServer();
  const at = Date.UTC(2027, 2, 1, 12);
  const day = (n: number) => dayOf(at - n * DAY);
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('prune-1', 'u1', 'Prune', '<p>', 0, 0)");
  for (const n of [3, 2, 1, 0]) {
    await run("INSERT OR IGNORE INTO visit_keys (day, secret) VALUES (?, 'aa')", [day(n)]);
    await run("INSERT INTO site_people (site_slug, day, visitor, kind) VALUES ('prune-1', ?, 'v', 'visit')", [day(n)]);
    await run("INSERT INTO owner_people (user_id, day, people) VALUES ('u1', ?, 1)", [day(n)]);
    await run("INSERT INTO site_step_names (site_slug, day, name) VALUES ('prune-1', ?, 'booking')", [day(n)]);
  }
  for (const n of [100, 99]) {
    await run("INSERT INTO site_visits (site_slug, day, source, views) VALUES ('prune-1', ?, '', 1)", [day(n)]);
    await run("INSERT INTO site_events (site_slug, day, step, n) VALUES ('prune-1', ?, 'visit', 1)", [day(n)]);
    await run("INSERT INTO site_revenue (site_slug, day, source, medium, campaign, currency, orders, amount) VALUES ('prune-1', ?, '', '', '', 'usd', 1, 500)", [day(n)]);
  }
  // A checkout's source waits 3 days for its order.
  await run("INSERT INTO site_checkouts (session_id, site_slug, source, medium, campaign, created_at) VALUES ('cs_old', 'prune-1', 'x', '', '', ?), ('cs_new', 'prune-1', 'x', '', '', ?)", [
    at - 3 * DAY - 1,
    at - 3 * DAY + 60_000,
  ]);
  assert.equal(await pruneDaily(at), true);
  forgetServerMemory(); // another server
  assert.equal(await pruneDaily(at), false, "only one server claims the day");
  assert.equal(await pruneDaily(at), false, "and a server tries once a day");
  const where = (table: string) => (table === "visit_keys" ? "1" : table === "owner_people" ? "user_id = 'u1'" : "site_slug = 'prune-1'");
  const days = async (table: string) => (await all<{ day: string }>(`SELECT DISTINCT day FROM ${table} WHERE ${where(table)} ORDER BY day`)).map((r) => r.day);
  assert.deepEqual(await days("visit_keys"), [day(1), day(0)]);
  assert.deepEqual(await days("site_people"), [day(1), day(0)]);
  assert.deepEqual(await days("owner_people"), [day(1), day(0)]);
  assert.deepEqual(await days("site_visits"), [day(99)], "day −99 stays, day −100 goes");
  assert.deepEqual(await days("site_events"), [day(99)]);
  assert.deepEqual(await days("site_revenue"), [day(99)]);
  assert.deepEqual(await days("site_step_names"), [day(1), day(0)]);
  assert.deepEqual((await all<{ session_id: string }>("SELECT session_id FROM site_checkouts")).map((r) => r.session_id), ["cs_new"]);
  const since = (await one<{ value: string }>("SELECT value FROM settings WHERE key = 'funnel_since'"))?.value;
  assert.equal(since, day(0));

  // A day whose prune fails is given back, so another server can do it.
  const next = at + DAY;
  visitTests.failPrune = true;
  forgetServerMemory();
  assert.equal(await pruneDaily(next), false);
  visitTests.failPrune = false;
  assert.equal((await one<{ value: string }>("SELECT value FROM settings WHERE key = 'visits_pruned'"))?.value, day(0));
  assert.equal(await pruneDaily(next), false, "the server that failed doesn't try again that day");
  forgetServerMemory();
  assert.equal(await pruneDaily(next), true);
  assert.deepEqual(await days("site_people"), [day(0)]);
  assert.equal((await one<{ value: string }>("SELECT value FROM settings WHERE key = 'funnel_since'"))?.value, since, "counting began once, and that never moves");
});

test("on the day this counter takes over, nobody is counted twice, and the people counted before stay as daily totals", async () => {
  await freshServer();
  await run("DELETE FROM visit_keys");
  const deploy = Date.UTC(2027, 4, 1, 12);
  const day = (n: number) => dayOf(deploy - n * DAY);
  const created = deploy - 10 * DAY;
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('old-1', 'u1', 'Old', '<p>', ?, 0)", [created]);
  const browser = (ip: string) => visit({ "x-forwarded-for": ip }, "/p/old-1");
  const old = (n: number, ip: string) => sha256(`${day(n)}|old-1|${ip}|${BROWSER}`).slice(0, 24);
  // What the counter before this one kept: codes without a key, one row per person and day.
  await run("INSERT INTO site_visitors (site_slug, day, visitor) VALUES ('old-1', ?, ?), ('old-1', ?, ?), ('old-1', ?, ?), ('old-1', ?, ?)", [
    day(2), old(2, "7.7.7.7"), day(1), old(1, "7.7.7.7"), day(1), old(1, "7.7.7.8"), day(0), old(0, "8.8.8.8"),
  ]);
  const people = async () => Object.fromEntries(await peoplePerDay("old-1", day(2)));
  assert.deepEqual(await people(), { [day(2)]: 1, [day(1)]: 2, [day(0)]: 1 }, "no day reads zero before the roll-up");

  // Someone the old counter counted this morning comes back: their row, but no second count.
  await recordVisit("old-1", browser("8.8.8.8"), null, deploy);
  assert.equal(await count("SELECT COUNT(*) AS n FROM site_people WHERE site_slug = 'old-1' AND kind = 'visit'"), 1);
  assert.equal(await count("SELECT COALESCE(SUM(n), 0) AS n FROM site_events WHERE site_slug = 'old-1' AND step = 'visit'"), 0);
  // That visit's prune rolled up the days before today, and kept today's old rows.
  assert.deepEqual((await all<{ day: string }>("SELECT day FROM site_visitors WHERE site_slug = 'old-1'")).map((r) => r.day), [day(0)]);
  assert.deepEqual(
    (await all<{ day: string; n: number }>("SELECT day, n FROM site_events WHERE site_slug = 'old-1' AND step = 'visit-old' ORDER BY day")).map((r) => [r.day, Number(r.n)]),
    [
      [day(2), 1],
      [day(1), 2],
    ],
  );
  assert.deepEqual(await people(), { [day(2)]: 1, [day(1)]: 2, [day(0)]: 1 });
  await recordVisit("old-1", browser("8.8.8.8"), null, deploy + 1000);
  await recordVisit("old-1", browser("9.9.9.9"), null, deploy + 2000); // someone new
  assert.deepEqual(await people(), { [day(2)]: 1, [day(1)]: 2, [day(0)]: 2 });
  const tile = await visitStats("old-1", deploy);
  assert.equal(tile.days.length, 11, "from the day the app was made");
  assert.deepEqual(tile.days.slice(-3).map((d) => d.visitors), [1, 2, 2]);
  assert.equal(tile.days[0].day, dayOf(created));

  // The next day's prune rolls up the deploy day's old rows: still 2 people that day.
  forgetServerMemory();
  assert.equal(await pruneDaily(deploy + DAY), true);
  assert.equal(await count("SELECT COUNT(*) AS n FROM site_visitors WHERE site_slug = 'old-1'"), 0);
  assert.deepEqual(await people(), { [day(2)]: 1, [day(1)]: 2, [day(0)]: 2 });
  // A row a slow server added late is rolled up the day after, once.
  await run("INSERT INTO site_visitors (site_slug, day, visitor) VALUES ('old-1', ?, 'late')", [day(0)]);
  forgetServerMemory();
  assert.equal(await pruneDaily(deploy + 2 * DAY), true);
  await run("UPDATE settings SET value = ? WHERE key = 'visits_pruned'", [day(-1)]);
  forgetServerMemory();
  assert.equal(await pruneDaily(deploy + 2 * DAY), true, "running it again");
  assert.deepEqual(await people(), { [day(2)]: 1, [day(1)]: 2, [day(0)]: 3 });
  assert.equal((await one<{ value: string }>("SELECT value FROM settings WHERE key = 'funnel_since'"))?.value, day(0));
});

test("the 30-day chart starts on the day the app was made", async () => {
  const at = Date.UTC(2027, 5, 10, 12);
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('new-1', 'u1', 'New', '<p>', ?, 0)", [at - 4 * DAY - 3600_000]);
  await recordVisit("new-1", visit({}, "/p/new-1"), null, at);
  const stats = await visitStats("new-1", at);
  assert.equal(stats.days.length, 5);
  assert.equal(stats.days[0].day, dayOf(at - 4 * DAY));
  assert.deepEqual(stats.days[4], { day: dayOf(at), views: 1, visitors: 1 });
});

const { FREE_PEOPLE_PER_DAY, PLAN_PEOPLE, MAX_TOUCHES, peopleCap, networkMemory } = visits;
/** A new browser each time: another person on the same network. */
let browsers = 0;
const someone = (slug: string, headers: Record<string, string> = {}, query = "") =>
  visit({ "user-agent": `${BROWSER} person/${++browsers}`, "x-forwarded-for": `10.0.${Math.floor(browsers / 250)}.${browsers % 250}`, ...headers }, `/p/${slug}${query}`);
const eventsOf = (slug: string, step = "visit") => count("SELECT COALESCE(SUM(n), 0) AS n FROM site_events WHERE site_slug = ? AND step = ?", [slug, step]);
const peopleRows = (slug: string) => count("SELECT COUNT(*) AS n FROM site_people WHERE site_slug = ? AND kind = 'visit'", [slug]);
const ownerCount = async (owner: string, day: string) => count("SELECT COALESCE(SUM(people), 0) AS n FROM owner_people WHERE user_id = ? AND day = ?", [owner, day]);
const viewsBySource = async (slug: string) =>
  Object.fromEntries((await all<{ source: string; views: number }>("SELECT source, SUM(views) AS views FROM site_visits WHERE site_slug = ? GROUP BY source", [slug])).map((r) => [r.source, Number(r.views)]));
const mark = async (slug: string, step: string) => (await one<{ n: number }>("SELECT n FROM site_events WHERE site_slug = ? AND step = ?", [slug, step]))?.n ?? null;
async function app(slug: string, owner: string) {
  await run("INSERT OR IGNORE INTO users (id, email, password_hash, created_at, verified_at) VALUES (?, ?, 'h', 0, 1)", [owner, `${owner}@x.co`]);
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES (?, ?, 'App', '<p>', 0, 0)", [slug, owner]);
}
async function plan(owner: string, id: string) {
  await run(
    `INSERT INTO subscriptions (id, user_id, plan, interval, status, amount_cents, anchor, paid_until, test, created_at, updated_at)
     VALUES (?, ?, ?, 'month', 'active', 100, 0, ?, 1, 0, 0)`,
    [`sub-${owner}`, owner, id, Date.UTC(2100, 0, 1)],
  );
}

test("each person counts under where they first came from that day, and an app counts 30 sources a day", async () => {
  forgetServerMemory();
  await app("touch-1", "u1");
  const at = Date.UTC(2027, 6, 1, 9);
  const ana = visit({ "x-forwarded-for": "11.0.0.1", referer: "https://www.google.com/" }, "/p/touch-1");
  await recordVisit("touch-1", ana, null, at);
  // A reload with no referrer, and one from Instagram later, are still the Google visit.
  await recordVisit("touch-1", visit({ "x-forwarded-for": "11.0.0.1" }, "/p/touch-1"), null, at + 1000);
  await recordVisit("touch-1", visit({ "x-forwarded-for": "11.0.0.1", referer: "https://l.instagram.com/" }, "/p/touch-1?utm_source=ig"), null, at + 2000);
  assert.deepEqual(await viewsBySource("touch-1"), { "google.com": 3 });
  assert.equal((await one<{ source: string }>("SELECT source FROM site_people WHERE site_slug = 'touch-1'"))?.source, "google.com");
  await recordVisit("touch-1", someone("touch-1", {}, "?utm_source=newsletter&utm_medium=email&utm_campaign=Spring"), null, at);
  assert.deepEqual(
    (await all<{ source: string; medium: string; campaign: string; n: number }>(
      "SELECT source, medium, campaign, n FROM site_events WHERE site_slug = 'touch-1' AND step = 'visit' ORDER BY source",
    )).map((r) => [r.source, r.medium, r.campaign, Number(r.n)]),
    [
      ["google.com", "", "", 1],
      ["newsletter", "email", "spring", 1],
    ],
  );

  // Up to 30 sources a day; a 31st new one is "(other)", while one already there still counts as itself.
  for (let i = 3; i <= MAX_TOUCHES; i++) await recordVisit("touch-1", someone("touch-1", {}, `?utm_source=src-${i}`), null, at);
  assert.equal(await count("SELECT COUNT(*) AS n FROM site_events WHERE site_slug = 'touch-1' AND step = 'visit'"), MAX_TOUCHES);
  await recordVisit("touch-1", someone("touch-1", {}, "?utm_source=one-too-many"), null, at);
  await recordVisit("touch-1", someone("touch-1", {}, "?utm_source=src-7"), null, at);
  await recordVisit("touch-1", someone("touch-1", { referer: "https://www.google.com/" }), null, at);
  const sources = await viewsBySource("touch-1");
  assert.equal(sources["(other)"], 1);
  assert.equal(sources["one-too-many"], undefined);
  assert.equal(sources["src-7"], 2);
  assert.equal(sources["google.com"], 4);
  assert.equal(await eventsOf("touch-1"), MAX_TOUCHES + 3);
});

test("people are counted per owner per day across all their apps, up to their plan's number; past it the apps just count views", async () => {
  forgetServerMemory();
  visitTests.freePeople = 3;
  try {
    await app("cap-a", "capper");
    await app("cap-b", "capper");
    await app("else-1", "someone-else");
    const at = Date.UTC(2027, 6, 2, 9);
    const day = dayOf(at);
    const early = someone("cap-a", { referer: "https://www.google.com/" });
    const sent = await statementsDuring(async () => {
      await recordVisit("cap-a", early, null, at);
      await recordVisit("cap-a", someone("cap-a", {}, "?utm_source=newsletter"), null, at);
      await recordVisit("cap-b", someone("cap-b"), null, at);
    });
    assert.deepEqual(sent.filter((sql) => /subscriptions|FROM users/.test(sql)), [], "below the free number, no plan is read");
    assert.equal(await ownerCount("capper", day), 3, "two apps, one count");
    assert.equal(await mark("cap-a", "capped"), null);

    // The 4th new person, on either app: a view, but no person, no day total and nothing on the count.
    await recordVisit("cap-b", someone("cap-b"), null, at + 1000);
    await recordVisit("cap-a", someone("cap-a", {}, "?utm_source=fresh"), null, at + 2000);
    await recordVisit("cap-a", someone("cap-a", {}, "?utm_source=newsletter"), null, at + 3000);
    await recordVisit("cap-a", someone("cap-a"), null, at + 4000);
    assert.equal(await ownerCount("capper", day), 3);
    assert.equal(await peopleRows("cap-a"), 2);
    assert.equal(await peopleRows("cap-b"), 1);
    assert.equal(await eventsOf("cap-a"), 2);
    // Their views never open a new source: one already there that day keeps its own, Direct stays Direct.
    assert.deepEqual(await viewsBySource("cap-a"), { "google.com": 1, newsletter: 2, "(other)": 1, "": 1 });
    assert.equal(await mark("cap-a", "capped"), 3);
    assert.equal(await mark("cap-b", "capped"), 3);
    // Someone counted before the pause still counts, under where they came from.
    await recordVisit("cap-a", early, null, at + 5000);
    assert.equal((await viewsBySource("cap-a"))["google.com"], 2);
    // Another owner's apps are unaffected.
    for (let i = 0; i < 3; i++) await recordVisit("else-1", someone("else-1"), null, at);
    assert.equal(await peopleRows("else-1"), 3);
    assert.equal(await mark("else-1", "capped"), null);
    // The stats show only who was counted.
    assert.equal((await visitStats("cap-a", at)).visitors, 2);
  } finally {
    visitTests.freePeople = 0;
  }
});

test("a paid plan counts more people a day, a team member counts against their own plan, and an admin gets Agency's number", async () => {
  forgetServerMemory();
  visitTests.freePeople = 2;
  const real = { ...PLAN_PEOPLE };
  Object.assign(PLAN_PEOPLE, { pro: 4, business: 5, agency: 6 });
  process.env.FLASH_ADMIN_EMAILS = "boss@x.co";
  try {
    await app("pro-1", "pro-owner");
    await plan("pro-owner", "pro");
    await app("team-1", "team-owner");
    await plan("team-owner", "business");
    await app("member-1", "member");
    await run("INSERT INTO teams (id, owner_id, created_at) VALUES ('t1', 'team-owner', 0)");
    await run("INSERT INTO team_members (user_id, team_id, joined_at) VALUES ('member', 't1', 0)");
    await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('boss', 'boss@x.co', 'h', 0, 1)");
    await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('boss-1', 'boss', 'App', '<p>', 0, 0)");
    const at = Date.UTC(2027, 6, 3, 9);
    const day = dayOf(at);
    for (const slug of ["pro-1", "team-1", "member-1", "boss-1"]) for (let i = 0; i < 8; i++) await recordVisit(slug, someone(slug), null, at);
    assert.equal(await ownerCount("pro-owner", day), 4, "Pro's number, past the free one");
    assert.equal(await ownerCount("team-owner", day), 5, "the team's owner: Business");
    assert.equal(await ownerCount("member", day), 2, "a team member: their own free number, not the team's");
    assert.equal(await ownerCount("boss", day), 6, "an admin: Agency's number");
    assert.deepEqual(await peopleCap("member", at), { cap: 2, paid: false });
    assert.deepEqual(await peopleCap("pro-owner", at), { cap: 4, paid: true });
  } finally {
    visitTests.freePeople = 0;
    Object.assign(PLAN_PEOPLE, real);
    delete process.env.FLASH_ADMIN_EMAILS;
  }
});

test("a paused day is remembered 15 minutes, so a plan bought that day counts soon, and counting starts again at midnight", async () => {
  forgetServerMemory();
  visitTests.freePeople = 2;
  const real = { ...PLAN_PEOPLE };
  PLAN_PEOPLE.pro = 4;
  try {
    await app("late-1", "late-owner");
    const at = Date.UTC(2027, 6, 4, 23, 30);
    for (let i = 0; i < 2; i++) await recordVisit("late-1", someone("late-1"), null, at);
    await recordVisit("late-1", someone("late-1"), null, at + 1000); // past the number: the plan is read, and the day paused
    await plan("late-owner", "pro");
    const reads = await statementsDuring(async () => {
      await recordVisit("late-1", someone("late-1"), null, at + 5 * 60_000);
      await recordVisit("late-1", someone("late-1"), null, at + 14 * 60_000);
    });
    assert.deepEqual(reads.filter((sql) => /subscriptions|FROM users/.test(sql)), [], "no plan read while paused");
    assert.equal(await ownerCount("late-owner", dayOf(at)), 2);
    // 15 minutes on, the plan is read again: Pro's number, so counting goes on.
    await recordVisit("late-1", someone("late-1"), null, at + 16 * 60_000);
    assert.equal(await ownerCount("late-owner", dayOf(at)), 3);

    // Paused at 23:58 on a free plan; a new person at 00:00:30 is counted at once.
    await run("DELETE FROM subscriptions WHERE user_id = 'late-owner'");
    forgetServerMemory();
    const night = Date.UTC(2027, 6, 5, 23, 58);
    for (let i = 0; i < 3; i++) await recordVisit("late-1", someone("late-1"), null, night);
    assert.equal(await ownerCount("late-owner", dayOf(night)), 2);
    await recordVisit("late-1", someone("late-1"), null, Date.UTC(2027, 6, 6, 0, 0, 30));
    assert.equal(await ownerCount("late-owner", "2027-07-06"), 1);
  } finally {
    visitTests.freePeople = 0;
    Object.assign(PLAN_PEOPLE, real);
  }
});

test("two servers counting the same new person at once count them once", async () => {
  forgetServerMemory();
  await app("race-1", "racer");
  const at = Date.UTC(2027, 6, 7, 9);
  await recordVisit("race-1", someone("race-1"), null, at); // the day's key and settings are known
  const same = () => visit({ "x-forwarded-for": "12.0.0.1" }, "/p/race-1");
  const sent = await statementsDuring(() => Promise.all([recordVisit("race-1", same(), null, at), recordVisit("race-1", same(), null, at)]));
  const reads = sent.map((sql, i) => [sql, i] as const).filter(([sql]) => /LEFT JOIN owner_people/.test(sql));
  const firstWrite = sent.findIndex((sql) => /INSERT INTO owner_people/.test(sql));
  assert.equal(reads.length, 2);
  assert.ok(reads[1][1] < firstWrite, "both read before either wrote");
  assert.equal(await ownerCount("racer", dayOf(at)), 2);
  assert.equal(await eventsOf("race-1"), 2);
  assert.equal(await peopleRows("race-1"), 2);
  assert.equal(await viewsOf("race-1"), 3);
});

test("one internet connection adds at most its number of new people a day per owner on a server, and the server keeps no address", async () => {
  forgetServerMemory();
  visitTests.networkPeople = 3;
  try {
    await app("net-1", "networked");
    const at = Date.UTC(2027, 6, 8, 9);
    const school = (n: number, at2 = at) => recordVisit("net-1", visit({ "x-forwarded-for": "13.0.0.1", "user-agent": `${BROWSER} pupil/${n}` }, "/p/net-1"), null, at2);
    for (let n = 1; n <= 4; n++) await school(n);
    assert.equal(await peopleRows("net-1"), 3);
    assert.equal(await eventsOf("net-1"), 3);
    assert.equal(await viewsOf("net-1"), 4, "the 4th is a view");
    assert.equal(await mark("net-1", "capped-net"), 3);
    await recordVisit("net-1", visit({ "x-forwarded-for": "13.0.0.2" }, "/p/net-1"), null, at);
    assert.equal(await peopleRows("net-1"), 4, "another connection still counts");
    // An IPv6 address counts by its /64 network.
    for (let n = 1; n <= 4; n++) await recordVisit("net-1", visit({ "x-forwarded-for": `2001:db8:1:2::${n}`, "user-agent": `${BROWSER} phone/${n}` }, "/p/net-1"), null, at);
    assert.equal(await peopleRows("net-1"), 7);
    assert.ok(networkMemory().every((k) => /^[0-9a-f]{24}$/.test(k) && !k.includes("13.0.0")));
    assert.equal(FREE_PEOPLE_PER_DAY, 10_000);
    // The next day the first connection counts again.
    await school(5, at + DAY);
    assert.equal(await count("SELECT COUNT(*) AS n FROM site_people WHERE site_slug = 'net-1' AND day = ?", [dayOf(at + DAY)]), 1);
  } finally {
    visitTests.networkPeople = 0;
  }
});
