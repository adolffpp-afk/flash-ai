import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
const { run, one } = await import("../src/lib/server/db.ts");
const { recordVisit, visitStats, visitSource, isPersonVisit, dayOf } = await import("../src/lib/server/visits.ts");
const { sitesWithMessages } = await import("../src/lib/server/inbox.ts");
const { FETCHERS_URL } = await import("../src/lib/server/lighthouse.ts");
const { runLock } = await import("../src/lib/server/pagespeed.ts");
const { clearLimit, overLimit } = await import("../src/lib/server/limits.ts");

// A stand-in for Google's list of its user-triggered fetchers' addresses (see lighthouse.ts).
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
  String(input) === FETCHERS_URL ? Response.json({ prefixes: [{ ipv4Prefix: "66.102.9.32/27" }, { ipv4Prefix: "66.249.81.64/27" }] }) : realFetch(input, init)) as typeof fetch;

const BROWSER = "Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0";
const visit = (headers: Record<string, string> = {}) =>
  new Request("https://www.flash-app.dev/p/crumb-1", {
    headers: { "user-agent": BROWSER, host: "www.flash-app.dev", "x-forwarded-for": "1.2.3.4", ...headers },
  });

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
});

test("visits are counted per day and source, people once a day, without the owner", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'o@x.co', 'h', 0)");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('crumb-1', 'u1', 'Crumb', '<p>', 0, 0)");
  const today = Date.UTC(2026, 9, 4, 15);
  const yesterday = today - 86_400_000;

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

  // Visits older than 30 days don't show.
  assert.equal((await visitStats("crumb-1", today + 40 * 86_400_000)).views, 0);

  // The list of sites shows the last 30 days' visits (counted from now, so these test days are older).
  const [site] = await sitesWithMessages("u1");
  assert.equal(typeof site.views, "number");

  // Unpublishing takes the stats with it.
  await run("DELETE FROM sites WHERE slug = 'crumb-1'");
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_visitors"))?.n, 0);
});

test("Google's page speed test isn't counted as visitors, whoever started it, and visitors are, even while it runs", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u2', 'p@x.co', 'h', 0)");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('crumb-2', 'u2', 'Crumb', '<p>', 0, 0)");
  // Google's test as its servers were seen sending it (other sites' logs), and Lighthouse's own agents
  // (core/config/constants.js): 9.6's phone, and 13's phone and computer, which is any Mac's Chrome.
  const psiPhone = "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse";
  const psiComputer = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Chrome-Lighthouse";
  const phone9 = "Mozilla/5.0 (Linux; Android 7.0; Moto G (4)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4695.0 Mobile Safari/537.36 Chrome-Lighthouse";
  const phone13 = "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36";
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
  const counts = async () => {
    const people = await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_visitors WHERE site_slug = 'crumb-2'");
    const views = await one<{ n: number }>("SELECT COALESCE(SUM(views), 0) AS n FROM site_visits WHERE site_slug = 'crumb-2'");
    return [Number(people?.n), Number(views?.n)];
  };
  const load = async (agent: string, ip: string) => {
    const [people, views] = await counts();
    await recordVisit("crumb-2", visit({ "user-agent": agent, "x-forwarded-for": ip }));
    const [peopleAfter, viewsAfter] = await counts();
    return [peopleAfter - people, viewsAfter - views];
  };
  for (const agent of [psiPhone, psiComputer, phone9, phone13]) assert.equal(isPersonVisit(visit({ "user-agent": agent })), false, agent);
  assert.equal(isPersonVisit(visit({ "user-agent": mac })), true, "a Mac's Chrome can be a person");
  for (const [i, running] of [false, true].entries()) {
    if (running) await overLimit(runLock("crumb-2"), 1, 180_000);
    const when = running ? "while Flash's check runs" : "any time";
    assert.deepEqual(await load(psiPhone, "66.249.81.68"), [0, 0], `${when}: Google's phone`);
    assert.deepEqual(await load(psiComputer, "66.102.9.33"), [0, 0], `${when}: Google's computer`);
    assert.deepEqual(await load(phone13, "198.51.100.1"), [0, 0], `${when}: Lighthouse's phone`);
    assert.deepEqual(await load(mac, "66.102.9.40"), [0, 0], `${when}: Lighthouse's computer from Google's fetchers' addresses`);
    // People meanwhile: Chrome on a Mac, and another browser.
    assert.deepEqual(await load(mac, `203.0.113.${i}`), [1, 1], `${when}: a visitor on a Mac`);
    assert.deepEqual(await load(BROWSER, `10.0.0.${i}`), [1, 1], `${when}: a visitor on another browser`);
    if (running) await clearLimit(runLock("crumb-2"));
  }
});
