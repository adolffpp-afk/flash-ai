import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { register } from "node:module";

/*
 * The search check (SEO) kept with each app's page: worked out when it's published, updated or put
 * back, read again for apps published before it existed, shown in the list of apps and to the
 * publishing connector, and never charged for.
 */
register("./support/route-hooks.mjs", import.meta.url);
process.env.DATABASE_URL = ":memory:";
process.env.FLASH_ADMIN_EMAILS = "";
process.env.FLASH_APP_URL = "https://www.flash-app.dev";

const { all, one, run } = await import("../src/lib/server/db.ts");
const { publishSite, restoreVersion, listVersions } = await import("../src/lib/server/sites.ts");
const { refreshSeo, seoFactsFor } = await import("../src/lib/server/seo.ts");
const { chooseRule } = await import("../src/lib/server/site-data.ts");
const { callTool } = await import("../src/lib/server/mcp-tools.ts");
const { scanPage, SEO_VERSION } = await import("../src/lib/seo-scan.ts");
const { evaluate, issueCount } = await import("../src/lib/seo-rules.ts");
const { afterwards } = (await import("./support/next-server.mjs")) as unknown as { afterwards: () => Promise<unknown> };
const seoRoute = await import("../src/app/api/sites/[slug]/seo/route.ts");
const sitesRoute = await import("../src/app/api/sites/route.ts");
const versionsRoute = await import("../src/app/api/sites/[slug]/versions/route.ts");
const appRoute = await import("../src/app/p/[slug]/route.ts");
const domainRoute = await import("../src/app/d/[host]/route.ts");

const ORIGIN = "http://localhost";

// A page with what Google and visitors need, and one with almost nothing.
const GOOD = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Golden Crumb · Sourdough bakery in Lisbon</title>
<meta name="description" content="Golden Crumb bakes sourdough, pastries and birthday cakes every morning in Lisbon. Order online and pick up warm.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Bakery","name":"Golden Crumb"}</script>
</head><body><h1>Sourdough baked before sunrise</h1>
<p>Our bakers start at four so the loaves are still warm when the doors open at seven, every day of the week.</p>
<img src="https://images.example/loaf.jpg" alt="A crusty sourdough loaf on a board" width="800" height="600">
<h2>Visit us</h2><p>Rua das Flores 12, Lisbon. Open every day from seven until the bread runs out.</p></body></html>`;
const BAD = "<h1>Hi</h1><img src=x.png><a href='#/menu'></a>";
const CTX = (slug: string, domains: string[] = []) => ({ slug, appBase: "https://www.flash-app.dev", domains });
const scoreOf = (html: string, slug: string) => evaluate(scanPage(html), CTX(slug)).score;
type Check = import("../src/lib/seo-rules.ts").Check;

/** A confirmed user with a session. */
async function owner(id: string) {
  const token = `tok_${id}`;
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES (?, ?, 'x', 0, 1)", [id, `${id}@example.com`]);
  await run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [createHash("sha256").update(token).digest("hex"), id, Date.now() + 3600_000]);
  const user = (await one("SELECT id, email, name, nickname, work, language, preferences, created_at, last_free_grant, verified_at FROM users WHERE id = ?", [id])) as never;
  return { id, user, cookie: `flash_session=${token}` };
}
type Owner = Awaited<ReturnType<typeof owner>>;

/** An app as one published before the search check existed: no facts saved with it. */
async function legacy(who: Owner, slug: string, html: string, updatedAt = 1) {
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES (?, ?, 'Golden Crumb', ?, 0, ?)", [slug, who.id, html, updatedAt]);
}

const request = (path: string, who: Owner | null, init: { method?: string; body?: unknown } = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", origin: ORIGIN, ...(who && { cookie: who.cookie }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
const params = (slug: string) => ({ params: Promise.resolve({ slug }) }) as never;
const getSeo = (who: Owner | null, slug: string) => seoRoute.GET(request(`/api/sites/${slug}/seo`, who), params(slug));
const listed = async (who: Owner) =>
  ((await (await sitesRoute.GET(request("/api/sites", who))).json()) as { sites: { slug: string; seo: { score: number; issues: number } | null }[] }).sites;
const savedSeo = async (slug: string) => (await one<{ seo: string }>("SELECT seo FROM sites WHERE slug = ?", [slug]))!.seo;
const credits = async () => Number((await one<{ b: number }>("SELECT COALESCE(SUM(amount), 0) AS b FROM credit_ledger"))?.b);

test("every app has room for its search check and its page speed result, empty until worked out", async () => {
  const columns = await all<{ name: string; type: string; notnull: number; dflt_value: string | null }>("PRAGMA table_info(sites)");
  for (const name of ["seo", "pagespeed"]) {
    const column = columns.find((c) => c.name === name);
    assert.ok(column, `the migration adds sites.${name}`);
    assert.equal(column.type, "TEXT");
    assert.equal(column.notnull, 1);
    assert.equal(column.dflt_value, "''");
  }
});

test("publishing saves the check with the page and says its score, and an update says the score before", async () => {
  const who = await owner("pub");
  const first = await publishSite(who.user, { html: BAD, title: "Golden Crumb" });
  assert.ok("slug" in first && first.seo);
  const slug = first.slug;
  assert.equal(JSON.parse(await savedSeo(slug)).v, SEO_VERSION, "saved in the same row");
  assert.deepEqual(JSON.parse(await savedSeo(slug)), JSON.parse(JSON.stringify(scanPage(BAD))));
  const bad = evaluate(scanPage(BAD), CTX(slug));
  assert.deepEqual(first.seo, { score: bad.score, issues: issueCount(bad) }, "a new app has no score before");
  assert.ok(first.seo.issues > 0);

  const updated = await publishSite(who.user, { html: GOOD, title: "Golden Crumb", slug });
  assert.ok("slug" in updated && updated.seo);
  assert.equal(updated.slug, slug);
  assert.equal(updated.seo.score, scoreOf(GOOD, slug));
  assert.equal(updated.seo.before, bad.score);
  assert.ok(updated.seo.score! > bad.score!, `${updated.seo.score} > ${bad.score}`);
  assert.deepEqual(JSON.parse(await savedSeo(slug)), JSON.parse(JSON.stringify(scanPage(GOOD))));

  // An app published before the check existed is read from its old page for the score before.
  await legacy(who, "old-pub", BAD);
  const fromOld = await publishSite(who.user, { html: GOOD, title: "Golden Crumb", slug: "old-pub" });
  assert.ok("slug" in fromOld && fromOld.seo);
  assert.equal(fromOld.seo.before, scoreOf(BAD, "old-pub"));
});

test("putting an earlier version back checks it again, and says the lower score", async () => {
  const who = await owner("restore");
  const first = await publishSite(who.user, { html: BAD, title: "Golden Crumb" });
  assert.ok("slug" in first);
  const slug = first.slug;
  await publishSite(who.user, { html: GOOD, title: "Golden Crumb", slug });
  const [older] = await listVersions(slug);
  const restored = await restoreVersion(who.id, slug, older.id);
  assert.ok(restored?.seo);
  assert.equal(restored.seo.score, scoreOf(BAD, slug));
  assert.equal(restored.seo.before, scoreOf(GOOD, slug));
  assert.ok(restored.seo.score! < restored.seo.before!);
  assert.deepEqual(JSON.parse(await savedSeo(slug)), JSON.parse(JSON.stringify(scanPage(BAD))), "the facts saved are the restored page's");

  // The Versions view's Restore says it too.
  const [good] = await listVersions(slug);
  const res = await versionsRoute.POST(request(`/api/sites/${slug}/versions`, who, { method: "POST", body: { id: good.id } }), params(slug));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; seo: { score: number; issues: number; before: number } };
  assert.equal(body.ok, true);
  assert.equal(body.seo.score, scoreOf(GOOD, slug));
  assert.equal(body.seo.before, scoreOf(BAD, slug));
});

test("the check is for the app's owner only, and an app published before it is checked on first look", async () => {
  const who = await owner("look");
  const other = await owner("other");
  await legacy(who, "old-look", GOOD, 7);

  assert.equal((await getSeo(null, "old-look")).status, 401);
  const notTheirs = await getSeo(other, "old-look");
  assert.equal(notTheirs.status, 404);
  assert.deepEqual(await notTheirs.json(), { error: "Not found" });
  assert.equal(await savedSeo("old-look"), "", "nothing was read for someone else");
  assert.equal((await getSeo(who, "never-made")).status, 404);

  const res = await getSeo(who, "old-look");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { checkedAt: number; title: string; ctx: unknown; report: { score: number; checks: { id: string }[] }; domainTest: string | null };
  assert.equal(body.checkedAt, 7, "the version of the page it's about");
  assert.equal(body.title, "Golden Crumb");
  assert.deepEqual(body.ctx, CTX("old-look"), "the client checks the chat's newest copy with the same context");
  assert.equal(body.report.score, scoreOf(GOOD, "old-look"));
  assert.ok(body.report.checks.length > 10);
  assert.equal(body.domainTest, null);
  assert.equal(JSON.parse(await savedSeo("old-look")).v, SEO_VERSION, "worked out once and saved");

  // Facts from an older version of the check are read again too.
  await run("UPDATE sites SET seo = ? WHERE slug = 'old-look'", [JSON.stringify({ v: SEO_VERSION - 1 })]);
  assert.equal(((await (await getSeo(who, "old-look")).json()) as { report: { score: number } }).report.score, scoreOf(GOOD, "old-look"));
  assert.equal(JSON.parse(await savedSeo("old-look")).v, SEO_VERSION);

  // A connected domain is in the context, and is the one a Google check would test.
  await run("INSERT INTO site_domains (domain, site_slug, user_id, created_at) VALUES ('crumb.pt', 'old-look', ?, 0)", [who.id]);
  const withDomain = (await (await getSeo(who, "old-look")).json()) as { ctx: { domains: string[] }; domainTest: string };
  assert.deepEqual(withDomain.ctx.domains, ["crumb.pt"]);
  assert.equal(withDomain.domainTest, "crumb.pt");
});

test("facts read from an old page never replace the facts a publish just saved", async () => {
  const who = await owner("race");
  await legacy(who, "race-app", BAD, 1);
  // The refresh reads the old page, then the new page is published with its facts, then the refresh would save.
  const refreshing = refreshSeo("race-app");
  const publishing = run("UPDATE sites SET html = ?, updated_at = 5, seo = ? WHERE slug = 'race-app'", [GOOD, seoFactsFor(GOOD)]);
  await Promise.all([refreshing, publishing]);
  assert.deepEqual(JSON.parse(await savedSeo("race-app")), JSON.parse(JSON.stringify(scanPage(GOOD))));
  // The same, without relying on the order: facts for a version that was replaced aren't kept.
  await run("UPDATE sites SET seo = '' WHERE slug = 'race-app'");
  await run("UPDATE sites SET seo = ? WHERE slug = ? AND updated_at = ?", [seoFactsFor(BAD), "race-app", 1]);
  assert.equal(await savedSeo("race-app"), "", "the guard refuses an old version's facts");
  assert.equal((await refreshSeo("race-app"))?.updatedAt, 5);
  assert.deepEqual(JSON.parse(await savedSeo("race-app")), JSON.parse(JSON.stringify(scanPage(GOOD))));
  assert.equal(await refreshSeo("no-such-app"), null);
});

test("the list of apps shows each score, working out old apps' after it answers", async () => {
  const who = await owner("list");
  await legacy(who, "old-list", GOOD, 3);
  const published = await publishSite(who.user, { html: BAD, title: "Golden Crumb" });
  assert.ok("slug" in published);

  const first = await listed(who);
  assert.equal(first.find((s) => s.slug === "old-list")?.seo, null, "not worked out while the list waits");
  const bad = evaluate(scanPage(BAD), CTX(published.slug));
  assert.deepEqual(first.find((s) => s.slug === published.slug)?.seo, { score: bad.score, issues: issueCount(bad) });

  await afterwards();
  assert.equal(JSON.parse(await savedSeo("old-list")).v, SEO_VERSION, "worked out after the answer");
  const next = await listed(who);
  const good = evaluate(scanPage(GOOD), CTX("old-list"));
  assert.deepEqual(next.find((s) => s.slug === "old-list")?.seo, { score: good.score, issues: issueCount(good) });

  // A page the check couldn't read has no score, and isn't read again on every look.
  await run("UPDATE sites SET seo = ? WHERE slug = 'old-list'", [JSON.stringify({ v: SEO_VERSION, error: true })]);
  assert.equal((await listed(who)).find((s) => s.slug === "old-list")?.seo, null);
  await afterwards();
  assert.deepEqual(JSON.parse(await savedSeo("old-list")), { v: SEO_VERSION, error: true });
  const failed = (await (await getSeo(who, "old-list")).json()) as { report: { score: number | null } };
  assert.equal(failed.report.score, null, "no made-up number");
});

test("blanks only in the sample entries a list shows while it's empty count until the list has entries without them", async () => {
  const who = await owner("luigi");
  // As builder.ts asks: sample content while a list is empty, and [Price] for what the owner hasn't said.
  const MENU = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Luigi's Pizzeria · Wood-fired pizza in Leeds</title>
<meta name="description" content="Luigi's Pizzeria bakes wood-fired Neapolitan pizza in Leeds every evening. See the menu and book a table online.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"></head>
<body><h1>Wood-fired pizza in Leeds</h1><p>Neapolitan dough, slow-proved for two days, baked in ninety seconds in our oak-fired oven.</p>
<h2>Menu</h2><ul id="menu"><li>Loading the menu…</li></ul>
<script>
const SAMPLE_MENU = [{ name: "Margherita", price: "[Price]" }, { name: "Diavola", price: "[Price]" }];
async function load() {
  let items = await flashDB.list("menu");
  if (!items.length && flashDB.isOwner) { for (const s of SAMPLE_MENU) await flashDB.add("menu", s); items = await flashDB.list("menu"); }
  const shown = items.length ? items : SAMPLE_MENU;
  menu.replaceChildren(...shown.map((d) => { const li = document.createElement("li"); li.textContent = d.name + " · " + d.price; return li; }));
}
load();
</script>
<script type="application/json" id="flash-data">{"menu": "read"}</script></body></html>`;
  const published = await publishSite(who.user, { html: MENU, title: "Luigi's" });
  assert.ok("slug" in published && published.seo);
  const slug = published.slug;
  const look = async () => {
    const body = (await (await getSeo(who, slug)).json()) as { report: { score: number; checks: Check[] } };
    const found = body.report.checks.find((c) => c.id === "placeholders")!;
    return { score: body.report.score, said: `${found.status} ${found.problem} ${found.values.list} ${found.action}` };
  };
  const add = (id: string, data: object, owner = "") =>
    run("INSERT INTO site_records (id, site_slug, collection, data, created_at, updated_at, owner) VALUES (?, ?, 'menu', ?, 0, 0, ?)", [id, slug, JSON.stringify(data), owner]);
  // An empty menu: visitors see the sample, [Price] and all.
  const empty = await look();
  assert.equal(empty.said, "fail found [Price] tell");
  assert.equal(published.seo.score, empty.score);
  // Someone's own entries (flashDB.mine) aren't what visitors see.
  await add("mine1", { name: "Margherita", price: "£9.50" }, "visitor-1");
  assert.equal((await look()).said, "fail found [Price] tell");
  // The owner opened the app, which saved the sample as the menu: visitors see [Price] in it.
  await add("m1", { name: "Margherita", price: "[Price]" });
  await add("m2", { name: "Diavola", price: "£11.00" });
  assert.equal((await look()).said, "fail found [Price] tell");
  // The real menu: the sample never shows, so it's only worth knowing, and doesn't count.
  await run("UPDATE site_records SET data = ? WHERE id = 'm1'", [JSON.stringify({ name: "Margherita", price: "£9.50" })]);
  const filled = await look();
  assert.equal(filled.said, "tip samples [Price] null");
  assert.ok(filled.score > empty.score, `${filled.score} > ${empty.score}`);
  assert.equal((await listed(who)).find((s) => s.slug === slug)?.seo?.score, filled.score, "the list of apps says the same");
  // When visitors can't read the menu, they get the sample.
  await chooseRule(slug, "menu", "private");
  assert.equal((await look()).said, "fail found [Price] tell");
  await chooseRule(slug, "menu", null);
  assert.equal((await look()).said, "tip samples [Price] null");
  // A blank in another object the script always shows still counts, while the sample's doesn't.
  const contact = MENU.replace("const SAMPLE_MENU", 'const CONTACT = { phone: "[Phone number]" };\nfooter.textContent = CONTACT.phone;\nconst SAMPLE_MENU');
  assert.ok("slug" in (await publishSite(who.user, { html: contact, title: "Luigi's", slug })));
  assert.equal((await look()).said, "fail found [Phone number] tell");
  // So does one in a field named like the menu's, as in a pizza of the week shown above it: the real
  // menu has prices, but the special still shows [Price].
  const special = MENU.replace("const SAMPLE_MENU", 'const SPECIAL = { name: "Truffle bianca", price: "[Price]" };\nspecial.textContent = SPECIAL.name + " · " + SPECIAL.price;\nconst SAMPLE_MENU');
  assert.ok("slug" in (await publishSite(who.user, { html: special, title: "Luigi's", slug })));
  assert.equal((await look()).said, "fail found [Price] tell");
  // A blank the page's own words show still counts, whatever the menu holds.
  const shown = MENU.replace("<h2>Menu</h2>", "<p>Call us on [Phone number].</p><h2>Menu</h2>");
  assert.ok("slug" in (await publishSite(who.user, { html: MENU, title: "Luigi's", slug })));
  const updated = await publishSite(who.user, { html: shown, title: "Luigi's", slug });
  assert.ok("slug" in updated && updated.seo);
  assert.equal((await look()).said, "fail found [Phone number] tell");
  assert.equal(updated.seo.before, filled.score, "the score before counts the menu too");
});

test("blanks in an object a page always shows count, whatever its lists hold", async () => {
  const who = await owner("crumb");
  // A bakery chain's shops come from a list, and its footer always shows the head office: there are no sample entries.
  const CHAIN = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Golden Crumb · Sourdough bakeries in Lisbon</title>
<meta name="description" content="Golden Crumb bakes sourdough, pastries and birthday cakes every morning in three Lisbon shops. Find the one nearest you.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"></head>
<body><h1>Sourdough baked before sunrise</h1><p>Our bakers start at four so the loaves are still warm when the doors open at seven, every day of the week.</p>
<h2>Our shops</h2><ul id="shops"></ul>
<footer><p>Head office: <span id="addr"></span> · <span id="tel"></span></p></footer>
<script>
const HEAD_OFFICE = { address: "[Address]", phone: "[Phone number]" };
document.getElementById("addr").textContent = HEAD_OFFICE.address;
document.getElementById("tel").textContent = HEAD_OFFICE.phone;
flashDB.list("shops").then((list) => { shops.replaceChildren(...list.map((s) => { const li = document.createElement("li"); li.textContent = s.name + ", " + s.address + ", " + s.phone; return li; })); });
</script>
<script type="application/json" id="flash-data">{"shops": "read"}</script></body></html>`;
  const published = await publishSite(who.user, { html: CHAIN, title: "Golden Crumb" });
  assert.ok("slug" in published && published.seo);
  const slug = published.slug;
  const look = async () => {
    const body = (await (await getSeo(who, slug)).json()) as { report: { score: number; checks: Check[] } };
    const found = body.report.checks.find((c) => c.id === "placeholders")!;
    return { score: body.report.score, said: `${found.status} ${found.problem} ${found.values.list} ${found.action}` };
  };
  const empty = await look();
  assert.equal(empty.said, "fail found [Address], [Phone number] tell");
  for (const [id, name, address, phone] of [
    ["s1", "Baixa", "Rua das Flores 12", "+351 21 000 0001"],
    ["s2", "Alfama", "Largo do Chafariz 3", "+351 21 000 0002"],
  ]) {
    await run("INSERT INTO site_records (id, site_slug, collection, data, created_at, updated_at, owner) VALUES (?, ?, 'shops', ?, 0, 0, '')", [id, slug, JSON.stringify({ name, address, phone })]);
  }
  // The shops have addresses and phones, but the footer still shows the blanks.
  assert.deepEqual(await look(), empty);
  assert.equal((await listed(who)).find((s) => s.slug === slug)?.seo?.score, empty.score, "the list of apps says the same");
});

test("the search check never charges: looking, publishing, updating and restoring", async () => {
  const who = await owner("free");
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, 500, 'grant', 0)", [who.id]);
  const before = await credits();
  assert.ok(before >= 500);
  await legacy(who, "free-app", GOOD);
  await getSeo(who, "free-app");
  await listed(who);
  await afterwards();
  const done = await publishSite(who.user, { html: BAD, title: "Golden Crumb", slug: "free-app" });
  assert.ok("slug" in done);
  const [version] = await listVersions("free-app");
  await restoreVersion(who.id, "free-app", version.id);
  await getSeo(who, "free-app");
  assert.equal(await credits(), before);
});

test("publishing through the connector says the app's search check", async () => {
  const who = await owner("mcp");
  const ctx = { user: who.user, origin: "https://www.flash-app.dev", app: "Claude", progress: () => {} };
  const result = (await callTool("flash_publish_app", { html: GOOD, title: "Golden Crumb" }, ctx))!;
  const text = (result.content[0] as { text: string }).text;
  const slug = text.match(/slug: ([\w-]+)/)![1];
  const report = evaluate(scanPage(GOOD), CTX(slug));
  assert.match(text, new RegExp(` Search check: ${report.score}/100, ${issueCount(report)} things to fix in Flash › My websites & apps › SEO\\.$`));
  assert.match(text, /Free, no credits used\./);
});

test("each app's page names its main address for Google: Flash's main domain, or the domain it's opened on (the bare one for its www.)", async () => {
  const who = await owner("canon");
  await legacy(who, "canon-app", GOOD);
  await run("INSERT INTO site_domains (domain, site_slug, user_id, created_at) VALUES ('crumb.lisbon', 'canon-app', ?, 0), ('www.crumb.lisbon', 'canon-app', ?, 1)", [who.id, who.id]);
  const canonicals = (html: string) => [...html.matchAll(/<link rel="canonical" href="([^"]*)">/g)].map((m) => m[1]);

  // A copy on another of Flash's addresses points at the main one; its share card keeps the address it was opened at.
  const copy = await (await appRoute.GET(new Request("https://flash-ai-pi.vercel.app/p/canon-app"), params("canon-app"))).text();
  assert.deepEqual(canonicals(copy), ["https://www.flash-app.dev/p/canon-app"]);
  assert.match(copy, /property="og:url" content="https:\/\/flash-ai-pi\.vercel\.app\/p\/canon-app"/);
  // A domain names itself, and www. names the bare domain when that's the app's too, so the two
  // copies don't compete; each share card keeps the address it was opened at. A www. alone names itself.
  const onDomain = async (domain: string) =>
    (await domainRoute.GET(new Request(`http://localhost/d/${domain}`), { params: Promise.resolve({ host: domain }) } as never)).text();
  for (const domain of ["crumb.lisbon", "www.crumb.lisbon"]) {
    const html = await onDomain(domain);
    assert.deepEqual(canonicals(html), ["https://crumb.lisbon/"], domain);
    assert.ok(html.includes(`property="og:url" content="https://${domain}/"`), domain);
  }
  await run("INSERT INTO site_domains (domain, site_slug, user_id, created_at) VALUES ('www.crumb.porto', 'canon-app', ?, 2), ('crumb.porto.example', 'canon-app', ?, 3)", [who.id, who.id]);
  assert.deepEqual(canonicals(await onDomain("www.crumb.porto")), ["https://www.crumb.porto/"]);
  assert.deepEqual(canonicals(await onDomain("crumb.porto.example")), ["https://crumb.porto.example/"]);
  await afterwards();

  // A page that names its own keeps it, with no second one (a new version the check hasn't read yet:
  // every visit above kept what it read in the old one).
  await run("UPDATE sites SET html = ?, updated_at = 2, seo = '' WHERE slug = 'canon-app'", [GOOD.replace("</head>", '<link rel="canonical" href="https://crumb.lisbon/"></head>')]);
  const own = await (await appRoute.GET(new Request("https://www.flash-app.dev/p/canon-app"), params("canon-app"))).text();
  assert.deepEqual(canonicals(own), ["https://crumb.lisbon/"]);
  await afterwards();
});
