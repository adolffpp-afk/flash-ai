import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { register } from "node:module";

/*
 * "Made with Flash ∞ AI" on a published app's link preview: on for every app, and only an owner on a
 * paid plan can turn it off. The plan is checked each time the preview is made, so it comes back
 * when the plan ends.
 */
register("./support/route-hooks.mjs", import.meta.url);
process.env.DATABASE_URL = ":memory:";
process.env.FLASH_ADMIN_EMAILS = "";

const { all, one, run } = await import("../src/lib/server/db.ts");
const { recordPayment, addMonths, endSubscription } = await import("../src/lib/server/subscriptions.ts");
const { plainTitle, shareCard, showsMadeWith } = await import("../src/lib/server/made-with.ts");
const { serveSite } = await import("../src/lib/server/serve-site.ts");
const { sitePreview } = await import("../src/lib/site-preview.ts");
const route = await import("../src/app/api/sites/[slug]/made-with/route.ts");

const ORIGIN = "http://localhost";
// No <title> and no picture, so the preview uses Flash's own title and picture.
const UNTITLED = "<!doctype html><html><head></head><body><h1>Golden Crumb</h1><p>Fresh sourdough every morning, baked before sunrise for the whole street.</p></body></html>";

/** A confirmed user with a session, and an app of theirs with no title of its own. */
async function owner(id: string) {
  const token = `tok_${id}`;
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES (?, ?, 'x', 0, 1)", [id, `${id}@example.com`]);
  await run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [createHash("sha256").update(token).digest("hex"), id, Date.now() + 3600_000]);
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES (?, ?, 'Golden Crumb', ?, 0, 0)", [`crumb-${id}`, id, UNTITLED]);
  return { id, slug: `crumb-${id}`, cookie: `flash_session=${token}` };
}
type Owner = Awaited<ReturnType<typeof owner>>;

/** A paid-up Pro plan for the user. */
async function subscribe(userId: string) {
  const start = Date.now() - 86_400_000;
  await recordPayment({
    subscriptionId: `sub_${userId}`, userId, planId: "pro", interval: "month", customer: null,
    amountCents: 2500, periodStart: start, periodEnd: addMonths(start, 1), ref: `test:${userId}`, test: true,
  });
}

const call = (method: "GET" | "PATCH", who: Owner, slug = who.slug, body?: unknown) =>
  route[method](
    new Request(`${ORIGIN}/api/sites/${slug}/made-with`, {
      method,
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: who.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) } as never,
  );
const saved = async (slug: string) => Number((await one<{ made_with: number }>("SELECT made_with FROM sites WHERE slug = ?", [slug]))?.made_with);
const page = async (slug: string) => (await serveSite(slug, `https://www.flash-app.dev/p/${slug}`)).text();

test("every app has the setting, on until its owner turns it off", async () => {
  const column = (await all<{ name: string; type: string; notnull: number; dflt_value: string | null }>("PRAGMA table_info(sites)")).find((c) => c.name === "made_with");
  assert.ok(column, "the migration adds sites.made_with");
  assert.equal(column.type, "INTEGER");
  assert.equal(column.notnull, 1);
  assert.equal(column.dflt_value, "1");
  const free = await owner("fresh");
  assert.equal(await saved(free.slug), 1);
  assert.deepEqual(await (await call("GET", free)).json(), { on: true, allowed: false, shown: true });
});

test("the switch saves only for an owner on a paid plan, and never charges anything", async () => {
  const free = await owner("free");
  const paid = await owner("paid");
  await subscribe(paid.id);
  const credits = async (id: string) => Number((await one<{ b: number }>("SELECT COALESCE(SUM(amount), 0) AS b FROM credit_ledger WHERE user_id = ?", [id]))?.b);
  const before = await credits(paid.id);

  const refused = await call("PATCH", free, free.slug, { on: false });
  assert.equal(refused.status, 402);
  assert.deepEqual(await refused.json(), { error: "Paid plans can turn this off." });
  assert.equal(await saved(free.slug), 1, "nothing changed");

  const done = await call("PATCH", paid, paid.slug, { on: false });
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { on: false, allowed: true, shown: false });
  assert.equal(await saved(paid.slug), 0);
  assert.deepEqual(await (await call("GET", paid)).json(), { on: false, allowed: true, shown: false });
  assert.deepEqual(await (await call("PATCH", paid, paid.slug, { on: true })).json(), { on: true, allowed: true, shown: true });
  assert.equal(await credits(paid.id), before, "no credits spent");

  // Only the app's owner, with a clear answer, signed in.
  assert.equal((await call("PATCH", paid, free.slug, { on: false })).status, 404, "someone else's app");
  assert.equal(await saved(free.slug), 1);
  assert.equal((await call("GET", paid, free.slug)).status, 404);
  assert.equal((await call("PATCH", paid, paid.slug, { on: "no" })).status, 400);
  assert.equal((await call("PATCH", { ...paid, cookie: "" }, paid.slug, { on: false })).status, 401);
});

test("the shared picture and title drop it only when it's off and the owner is on a paid plan", async () => {
  const paid = await owner("baker");
  const free = await owner("cook");
  await subscribe(paid.id);
  // A free owner whose setting is off (it can't be turned off on the free plan, but a plan that ended leaves it so).
  await run("UPDATE sites SET made_with = 0 WHERE slug = ?", [free.slug]);

  const madeWith = async (slug: string) => (await shareCard(slug))?.madeWith;
  assert.equal(await madeWith(paid.slug), true, "paid, on");
  assert.equal(await madeWith(free.slug), true, "free, off");
  await run("UPDATE sites SET made_with = 1 WHERE slug = ?", [free.slug]);
  assert.equal(await madeWith(free.slug), true, "free, on");
  await call("PATCH", paid, paid.slug, { on: false });
  assert.deepEqual(await shareCard(paid.slug), {
    title: "Golden Crumb",
    description: "Fresh sourdough every morning, baked before sunrise for the whole street.",
    madeWith: false,
    address: "",
  });
  assert.equal(await shareCard("no-such-app"), null);

  // Its own domain takes the line's place, the shorter one when it has both.
  await run("INSERT INTO site_domains (domain, site_slug, user_id, created_at) VALUES ('www.goldencrumb.ca', ?, ?, 1), ('goldencrumb.ca', ?, ?, 2)", [paid.slug, paid.id, paid.slug, paid.id]);
  assert.equal((await shareCard(paid.slug))?.address, "goldencrumb.ca");

  // The page's own share tags: the app's name instead of "Made with Flash", and the plain picture's address.
  const plain = await page(paid.slug);
  assert.match(plain, /property="og:title" content="Golden Crumb"/);
  assert.match(plain, /property="og:site_name" content="Golden Crumb"/);
  assert.match(plain, new RegExp(`property="og:image" content="https://www\\.flash-app\\.dev/p/${paid.slug}/card\\?plain=1"`));
  assert.doesNotMatch(plain, /Made with/);
  const branded = await page(free.slug);
  assert.match(branded, /property="og:title" content="Made with Flash"/);
  assert.match(branded, new RegExp(`property="og:image" content="https://www\\.flash-app\\.dev/p/${free.slug}/card"`));
});

test("when the owner's plan ends, the line comes back, and goes again with a new plan", async () => {
  const shop = await owner("shop");
  await subscribe(shop.id);
  await call("PATCH", shop, shop.slug, { on: false });
  assert.equal((await shareCard(shop.slug))?.madeWith, false);

  await endSubscription(`sub_${shop.id}`);
  assert.equal((await shareCard(shop.slug))?.madeWith, true, "drawn again with the line");
  assert.match(await page(shop.slug), /property="og:title" content="Made with Flash"/);
  assert.equal(await saved(shop.slug), 0, "the owner's choice is kept");
  assert.deepEqual(await (await call("GET", shop)).json(), { on: false, allowed: false, shown: true });
  assert.equal((await call("PATCH", shop, shop.slug, { on: true })).status, 402, "and can't be changed without a plan");

  await run("DELETE FROM subscriptions WHERE user_id = ?", [shop.id]);
  await subscribe(shop.id);
  assert.equal(await showsMadeWith({ user_id: shop.id, made_with: 0 }), false);
  assert.equal((await shareCard(shop.slug))?.madeWith, false);
});

test("a page with no title is titled after what made it, or the app's own name once that's off", () => {
  assert.equal(sitePreview(UNTITLED).title, "Made with Flash");
  assert.equal(sitePreview(UNTITLED, "Golden Crumb").title, "Golden Crumb");
  assert.equal(sitePreview(`<title>Crumb &amp; Co</title>${UNTITLED}`, "Golden Crumb").title, "Crumb & Co", "the page's own title wins");
  assert.equal(plainTitle({ slug: "crumb-x1", title: "Golden Crumb " }), "Golden Crumb");
  assert.equal(plainTitle({ slug: "crumb-x1", title: " " }), "crumb-x1", "an app with no name goes by its address");
});

test("an app with a share picture of its own keeps it first, and Flash's picture isn't used", async () => {
  const own = await owner("pictured");
  const share = "https://goldencrumb.ca/share.jpg?v=1&amp;s=2";
  await run("UPDATE sites SET html = ? WHERE slug = ?", [UNTITLED.replace("<head>", `<head><meta property="og:image" content="${share}">`), own.slug]);
  const images = [...(await page(own.slug)).matchAll(/property="og:image" content="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(images, [share, share], "its own picture comes first, not /p/<slug>/card");
  assert.equal(sitePreview(`<meta content="${share}" property='og:image'>`).image, "https://goldencrumb.ca/share.jpg?v=1&s=2", "either order of the tag's parts");
  assert.equal(sitePreview(`<meta property="og:image" content="/share.jpg"><img src="https://cdn.example/cake.jpg">`).image, "https://cdn.example/cake.jpg", "not a picture with no full address");
});
