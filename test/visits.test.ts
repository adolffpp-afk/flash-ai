import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
const { run, one } = await import("../src/lib/server/db.ts");
const { recordVisit, visitStats, visitSource, isPersonVisit, dayOf } = await import("../src/lib/server/visits.ts");
const { sitesWithMessages } = await import("../src/lib/server/inbox.ts");

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
