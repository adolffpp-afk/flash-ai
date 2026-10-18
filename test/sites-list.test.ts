import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./support/route-hooks.mjs", import.meta.url);
process.env.DATABASE_URL = ":memory:";
const { run, all, one, db } = await import("../src/lib/server/db.ts");
const { sitesWithMessages, siteCounts } = await import("../src/lib/server/inbox.ts");
const { createSession } = await import("../src/lib/server/auth.ts");
const sitesRoute = await import("../src/app/api/sites/route.ts");
const { afterwards } = (await import("./support/next-server.mjs")) as unknown as { afterwards: () => Promise<unknown> };
const { seoFactsFor } = await import("../src/lib/server/seo.ts");

await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('u1', 'a@x.co', 'h', 0, 1), ('u2', 'b@x.co', 'h', 0, 1)");
// 25 apps, app-1 the oldest, each with a message (read on even ones), a member and a visit.
const today = new Date().toISOString().slice(0, 10);
for (let i = 1; i <= 25; i++) {
  const slug = `app-${i}`;
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES (?, 'u1', ?, '<p>', 0, ?)", [slug, `App ${i}`, i * 1000]);
  await run("INSERT INTO site_messages (id, site_slug, form, data, created_at, read_at) VALUES (?, ?, 'f', '{}', 0, ?)", [`m${i}`, slug, i % 2 ? 0 : 5]);
  await run("INSERT INTO site_users (id, site_slug, email, name, password_hash, created_at) VALUES (?, ?, ?, '', 'h', 0)", [`s${i}`, slug, `p${i}@x.co`]);
  await run("INSERT INTO site_visits (site_slug, day, source, views) VALUES (?, ?, '', 3)", [slug, today]);
}
await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('theirs-1', 'u2', 'Theirs', '<p>', 0, 99999)");

test("the app list counts messages, visits, members and contacts for its 20 newest apps, and unread for every app", async () => {
  const list = await sitesWithMessages("u1");
  assert.equal(list.length, 25);
  assert.deepEqual(
    list.slice(0, 20).map((s) => s.slug),
    Array.from({ length: 20 }, (_, i) => `app-${25 - i}`),
    "newest first",
  );
  for (const s of list.slice(0, 20)) {
    assert.equal(s.messages, 1, s.slug);
    assert.equal(s.views, 3, s.slug);
    assert.equal(s.members, 1, s.slug);
  }
  for (const s of list.slice(20)) assert.deepEqual([s.messages, s.views, s.members, s.contacts], [null, null, null, null], s.slug);
  assert.deepEqual(
    list.map((s) => s.unread),
    list.map((s) => (Number(s.slug.slice(4)) % 2 ? 1 : 0)),
    "unread for all 25",
  );
});

test("?counts= gives up to 20 of the user's own apps' counts, never another owner's", async () => {
  // seo: the search check's score, null until worked out (see the test below).
  assert.deepEqual(await siteCounts("u1", ["app-1", "app-2", "theirs-1"]), {
    "app-1": { messages: 1, views: 3, members: 1, contacts: null, seo: null },
    "app-2": { messages: 1, views: 3, members: 1, contacts: null, seo: null },
  });
  const many = Array.from({ length: 25 }, (_, i) => `app-${i + 1}`);
  assert.equal(Object.keys(await siteCounts("u1", many)).length, 20);
  assert.deepEqual(await siteCounts("u1", []), {});

  const cookie = (await createSession("u1", true)).split(";")[0];
  const get = (query: string) => sitesRoute.GET(new Request(`https://www.flash-app.dev/api/sites${query}`, { headers: { cookie } }));
  const counted = (await (await get("?counts=app-3,theirs-1")).json()) as { counts: Record<string, unknown>; sites?: unknown };
  assert.deepEqual(Object.keys(counted.counts), ["app-3"]);
  assert.equal(counted.sites, undefined, "only the counts");
  const whole = (await (await get("")).json()) as { sites: unknown[]; maxSites: number };
  assert.equal(whole.sites.length, 25);
  assert.equal(whole.maxSites, 20, "a free account publishes up to 20");
});

test("the list reads only the owner's apps, by index, and unread through the index of unread messages", async () => {
  const client = await db();
  const sql: string[] = [];
  const execute = client.execute.bind(client);
  client.execute = ((s: { sql: string; args: unknown[] }, ...rest: unknown[]) => {
    if (typeof s === "object" && s.sql.includes("WITH recent")) sql.push(s.sql);
    return (execute as (...a: unknown[]) => unknown)(s, ...rest);
  }) as typeof client.execute;
  try {
    await sitesWithMessages("u1");
  } finally {
    client.execute = execute;
  }
  const since = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const plan = (await all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql[0]}`, ["u1", since, "u1"])).map((r) => r.detail);
  assert.ok(!plan.some((d) => /^SCAN (s|sites)\b/.test(d)), plan.join("\n"));
  assert.ok(plan.some((d) => /USING (COVERING )?INDEX sites_user/.test(d)), plan.join("\n"));
  assert.ok(plan.some((d) => /USING (COVERING )?INDEX site_messages_unread/.test(d)), plan.join("\n"));
  // Publishing's count, and the other lists of one owner's apps, use it too.
  const count = (await all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM sites WHERE user_id = ?", ["u1"])).map((r) => r.detail);
  assert.ok(count.some((d) => /INDEX sites_user/.test(d)), count.join("\n"));
});

test("search check scores come with the counts: for the 20 newest apps in the list, and with ?counts= for the rest, each worked out after its answer", async () => {
  // Four apps checked already, the two newest and the two oldest; the rest were published before the check existed.
  await afterwards();
  await run("UPDATE sites SET seo = ''");
  for (const slug of ["app-25", "app-24", "app-2", "app-1"]) await run("UPDATE sites SET seo = ? WHERE slug = ?", [seoFactsFor("<p>"), slug]);
  const cookie = (await createSession("u1", true)).split(";")[0];
  const get = async (query: string) =>
    (await (await sitesRoute.GET(new Request(`https://www.flash-app.dev/api/sites${query}`, { headers: { cookie } }))).json()) as {
      sites: { slug: string; seo?: { score: number; issues: number } | null }[];
      counts: Record<string, { seo?: { score: number; issues: number } | null }>;
    };
  const scored = (seo: unknown) => typeof (seo as { score?: unknown } | null)?.score === "number";

  const { sites } = await get("");
  assert.ok(scored(sites[0].seo) && scored(sites[1].seo), "the newest, checked, have their score");
  assert.equal(sites[2].seo, null, "a counted app not checked yet has none, yet");
  for (const s of sites.slice(20)) assert.ok(!("seo" in s), `${s.slug}: not counted, so no score (it may read the app's data)`);
  await afterwards();
  assert.ok((await get("")).sites.slice(0, 20).every((s) => scored(s.seo)), "the 20 counted were checked after the list answered");
  assert.equal((await one<{ seo: string }>("SELECT seo FROM sites WHERE slug = 'app-4'"))?.seo, "", "the rest weren't read for it");

  const past = await get("?counts=app-1,app-4,app-5");
  assert.ok(scored(past.counts["app-1"].seo));
  assert.deepEqual([past.counts["app-4"].seo, past.counts["app-5"].seo], [null, null]);
  await afterwards();
  const again = await get("?counts=app-4,app-5");
  assert.ok(scored(again.counts["app-4"].seo) && scored(again.counts["app-5"].seo), "worked out after the counts answered");
  assert.equal((await one<{ seo: string }>("SELECT seo FROM sites WHERE slug = 'app-3'"))?.seo, "", "only the ones asked for");
});
