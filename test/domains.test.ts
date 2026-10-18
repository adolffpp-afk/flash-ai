import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./support/route-hooks.mjs", import.meta.url);
process.env.DATABASE_URL = ":memory:";
process.env.VERCEL_API_TOKEN = "t";
process.env.VERCEL_PROJECT_ID = "flash-ai";
process.env.FLASH_ADMIN_EMAILS = "owner@x.co";
const { run } = await import("../src/lib/server/db.ts");
const { cleanDomain, isSubdomain, addDomain, siteForDomain, removeDomain, domainsForSite, ownershipValue, ownershipRecord, provesOwnership, pointsAtFlash } =
  await import("../src/lib/server/domains.ts");
const { routeHost } = await import("../src/lib/site-host.ts");
const domainFile = await import("../src/app/d/[host]/[file]/route.ts");
const domainPage = await import("../src/app/d/[host]/route.ts");
const domainsRoute = await import("../src/app/api/sites/[slug]/domains/route.ts");
const seoRoute = await import("../src/app/api/sites/[slug]/seo/route.ts");
const { messageOf } = await import("../src/lib/seo-words.ts");
const { createHash } = await import("node:crypto");

test("domains people type are cleaned, and Flash's own can't be claimed", () => {
  assert.equal(cleanDomain(" https://WWW.CrumbBakery.com/menu "), "www.crumbbakery.com");
  assert.equal(cleanDomain("crumb-bakery.co.uk."), "crumb-bakery.co.uk");
  assert.equal(cleanDomain("not a domain"), null);
  assert.equal(cleanDomain("evil.flash-app.dev"), null);
  assert.equal(cleanDomain("x.vercel.app"), null);
  assert.equal(isSubdomain("crumbbakery.com"), false);
  assert.equal(isSubdomain("shop.crumbbakery.com"), true);
  assert.equal(isSubdomain("crumb.co.uk"), false);
  assert.equal(isSubdomain("shop.crumb.co.uk"), true);
});

test("connecting a domain adds it on Vercel and shows the DNS record to add", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('u1', 'owner@x.co', 'h', 0, 1), ('u2', 'free@x.co', 'h', 0, 1)");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('bakery-1', 'u1', 'Crumb', '<p>', 0, 0)");
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method} ${url.replace("https://api.vercel.com", "")}`);
    if (url.includes("/config")) return Response.json({ misconfigured: true, recommendedIPv4: [{ rank: 1, value: ["216.198.79.1"] }], recommendedCNAME: [{ rank: 1, value: "abc.vercel-dns-017.com." }] });
    if (init?.method === "POST") return Response.json({ name: "x", verified: true });
    return Response.json({ verified: true });
  }) as typeof fetch;
  const user = (id: string, email: string) => ({ id, email, name: "", verified_at: 1 }) as never;

  // The owner has added the _flash TXT record that proves both names are theirs.
  const proved = async (name: string) => (name.endsWith("crumbbakery.com") ? [[ownershipValue("u1")]] : []);

  const free = await addDomain(user("u2", "free@x.co"), "bakery-1", "crumbbakery.com", proved);
  assert.equal("status" in free && free.status, 402, "free accounts can't connect domains");

  const apex = await addDomain(user("u1", "owner@x.co"), "bakery-1", "CrumbBakery.com", proved);
  assert.ok(!("error" in apex));
  assert.deepEqual(apex.records, [{ type: "A", name: "@", value: "216.198.79.1" }]);
  assert.equal(apex.connected, false);
  assert.ok(calls.includes("POST /v10/projects/flash-ai/domains"));
  const sub = await addDomain(user("u1", "owner@x.co"), "bakery-1", "www.crumbbakery.com", proved);
  assert.ok(!("error" in sub));
  assert.deepEqual(sub.records, [{ type: "CNAME", name: "www", value: "abc.vercel-dns-017.com" }]);
  assert.equal(await siteForDomain("crumbbakery.com"), "bakery-1");

  await removeDomain("www.crumbbakery.com");
  assert.ok(calls.includes("DELETE /v9/projects/flash-ai/domains/www.crumbbakery.com"));
  assert.deepEqual(await domainsForSite("bakery-1"), ["crumbbakery.com"]);
});

test("a domain needs a TXT record from its owner before Flash adds it", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('u3', 'squatter@x.co', 'h', 0, 1)");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('squat-1', 'u3', 'Squat', '<p>', 0, 0)");
  // Both can connect domains (as admins here; normally a paid plan).
  process.env.FLASH_ADMIN_EMAILS = "owner@x.co,squatter@x.co";
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method} ${String(input).replace("https://api.vercel.com", "")}`);
    if (String(input).includes("/config")) return Response.json({ misconfigured: false });
    return Response.json({ verified: true });
  }) as typeof fetch;
  const owner = { id: "u1", email: "owner@x.co", name: "", verified_at: 1 } as never;
  const squatter = { id: "u3", email: "squatter@x.co", name: "", verified_at: 1 } as never;
  const dns: Record<string, string[][]> = {};
  const lookup = async (name: string) => {
    if (!dns[name]) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return dns[name];
  };

  // Each user has their own value, and the record is named as DNS settings expect.
  assert.notEqual(ownershipValue("u1"), ownershipValue("u3"));
  assert.match(ownershipValue("u1"), /^flash-verify=[0-9a-f]{32}$/);
  assert.deepEqual(ownershipRecord("crumbpies.com", "u1"), { type: "TXT", name: "_flash", value: ownershipValue("u1") });
  assert.equal(ownershipRecord("shop.crumbpies.co.uk", "u1").name, "_flash.shop");

  // Without the record, nothing is added anywhere, and the owner is shown what to add.
  const waiting = await addDomain(owner, "bakery-1", "crumbpies.com", lookup);
  assert.deepEqual(waiting, { domain: "crumbpies.com", connected: false, records: [ownershipRecord("crumbpies.com", "u1")], needsProof: true });
  assert.equal(await siteForDomain("crumbpies.com"), null);
  assert.ok(!calls.some((c) => c.startsWith("POST /v10/")), "not added on Vercel either");

  // Someone else can't take it, even with their own value somewhere else.
  dns["_flash.crumbpies.com"] = [[ownershipValue("u1")]];
  dns["_flash.squatter.com"] = [[ownershipValue("u3")]];
  const taken = await addDomain(squatter, "squat-1", "crumbpies.com", lookup);
  assert.ok(!("error" in taken) && taken.needsProof, "the owner's record doesn't prove it for anyone else");
  assert.equal(await siteForDomain("crumbpies.com"), null);

  // With the record in place (quotes and split pieces are fine), the owner connects it.
  dns["_flash.crumbpies.com"] = [["v=spf1 -all"], [`"${ownershipValue("u1").slice(0, 20)}`, `${ownershipValue("u1").slice(20)}"`]];
  assert.equal(await provesOwnership("crumbpies.com", "u1", lookup), true);
  const connected = await addDomain(owner, "bakery-1", "crumbpies.com", lookup);
  assert.ok(!("error" in connected) && !connected.needsProof && connected.connected);
  assert.equal(await siteForDomain("crumbpies.com"), "bakery-1");

  // Another user can't move it to their site without their own record on the domain.
  const takeover = await addDomain(squatter, "squat-1", "crumbpies.com", lookup);
  assert.ok(!("error" in takeover) && takeover.needsProof);
  assert.equal(await siteForDomain("crumbpies.com"), "bakery-1", "the owner keeps their domain");

  // Domains the user already has keep working and need no new record, even if DNS can't be reached.
  const failing = async () => {
    throw new Error("timeout");
  };
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('bakery-2', 'u1', 'Crumb 2', '<p>', 0, 0)");
  const moved = await addDomain(owner, "bakery-2", "crumbpies.com", failing);
  assert.ok(!("error" in moved) && !moved.needsProof);
  assert.equal(await siteForDomain("crumbpies.com"), "bakery-2");

  // A domain someone added before proof was needed moves to whoever proves they run its DNS.
  await run("INSERT INTO site_domains (domain, site_slug, user_id, created_at) VALUES ('oldsquat.com', 'squat-1', 'u3', 0)");
  assert.ok((await addDomain(owner, "bakery-1", "oldsquat.com", lookup) as { needsProof?: boolean }).needsProof);
  assert.equal(await siteForDomain("oldsquat.com"), "squat-1");
  dns["_flash.oldsquat.com"] = [[ownershipValue("u1")]];
  assert.ok(!(await addDomain(owner, "bakery-1", "oldsquat.com", lookup) as { needsProof?: boolean }).needsProof);
  assert.equal(await siteForDomain("oldsquat.com"), "bakery-1");
});

test("custom domains show their site and keep Flash's pages off them", () => {
  assert.deepEqual(routeHost("www.flash-app.dev", "/", "GET"), { pass: true });
  assert.deepEqual(routeHost("localhost:3100", "/api/me", "GET"), { pass: true });
  assert.deepEqual(routeHost("flash-ai-pi.vercel.app", "/admin", "GET"), { pass: true });
  assert.deepEqual(routeHost("CrumbBakery.com", "/", "GET"), { rewrite: "/d/crumbbakery.com" });
  assert.deepEqual(routeHost("crumbbakery.com", "/api/sites/bakery-1/inbox", "POST"), { siteApi: "bakery-1" });
  assert.deepEqual(routeHost("crumbbakery.com", "/api/sites/bakery-1/data", "GET"), { siteApi: "bakery-1" });
  assert.deepEqual(routeHost("crumbbakery.com", "/admin", "GET"), { redirect: "/" });
  assert.deepEqual(routeHost("crumbbakery.com", "/api/auth/signin", "POST"), { notFound: true });
  assert.deepEqual(routeHost("flash.example.org", "/admin", "GET", "flash.example.org"), { pass: true }, "FLASH_APP_URL's host is Flash's own");
  // Its own robots.txt and sitemap.xml, so Google can find it; only to read.
  assert.deepEqual(routeHost("CrumbBakery.com", "/robots.txt", "GET"), { rewrite: "/d/crumbbakery.com/robots.txt" });
  assert.deepEqual(routeHost("crumbbakery.com", "/sitemap.xml", "GET"), { rewrite: "/d/crumbbakery.com/sitemap.xml" });
  assert.deepEqual(routeHost("crumbbakery.com", "/robots.txt", "POST"), { notFound: true });
  assert.deepEqual(routeHost("crumbbakery.com", "/about", "GET"), { redirect: "/" });
  assert.deepEqual(routeHost("www.flash-app.dev", "/robots.txt", "GET"), { pass: true }, "Flash's own robots.txt is its own");
});

test("a site on its own domain has a robots.txt that lets Google in and a sitemap of its one page", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('u9', 'r@x.co', 'h', 0, 1)");
  const day = Date.UTC(2026, 9, 12, 15, 30);
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('robots-1', 'u9', 'Crumb', '<!doctype html><title>Crumb</title><p>Bread', 0, ?)", [day]);
  await run("INSERT INTO site_domains (domain, site_slug, user_id, created_at) VALUES ('robotsbakery.com', 'robots-1', 'u9', 0)");
  const get = (host: string, file: string) => domainFile.GET(new Request(`http://localhost/d/${host}/${file}`), { params: Promise.resolve({ host, file }) } as never);

  const robots = await get("robotsbakery.com", "robots.txt");
  assert.equal(robots.status, 200);
  assert.equal(robots.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(robots.headers.get("cache-control"), "public, max-age=3600");
  assert.equal(await robots.text(), "User-agent: *\nAllow: /\nSitemap: https://robotsbakery.com/sitemap.xml\n", "nothing kept from Google, the app's data included");

  const sitemap = await get("RobotsBakery.com", "sitemap.xml");
  assert.equal(sitemap.status, 200);
  assert.equal(sitemap.headers.get("content-type"), "application/xml; charset=utf-8");
  const xml = await sitemap.text();
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
  assert.match(xml, /<url><loc>https:\/\/robotsbakery.com\/<\/loc><lastmod>2026-10-12<\/lastmod><\/url>/);

  for (const [host, file] of [["nobody.com", "robots.txt"], ["nobody.com", "sitemap.xml"], ["robotsbakery.com", "x.txt"], ["robotsbakery.com", "humans.txt"], ["%E0%A4%A", "robots.txt"]]) {
    assert.equal((await get(host, file)).status, 404, `${host}/${file}`);
  }

  // A page that asks to be kept off Google, or a site someone reported, lists nothing.
  const empty = /<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9"><\/urlset>/;
  await run("UPDATE sites SET html = ?, seo = '' WHERE slug = 'robots-1'", ['<!doctype html><meta name="robots" content="noindex"><title>Crumb</title>']);
  assert.match(await (await get("robotsbakery.com", "sitemap.xml")).text(), empty);
  await run("UPDATE sites SET html = '<p>Bread', seo = '' WHERE slug = 'robots-1'");
  assert.match(await (await get("robotsbakery.com", "sitemap.xml")).text(), /<loc>/);
  await run(
    "INSERT INTO reports (id, item_kind, item_id, owner_id, reason, reporter, created_at, updated_at) VALUES ('rep-1', 'site', 'robots-1', 'u9', 'spam', 'someone', 0, 0)",
  );
  assert.match(await (await get("robotsbakery.com", "sitemap.xml")).text(), empty);
  await run("UPDATE reports SET status = 'reviewed' WHERE id = 'rep-1'");
  assert.match(await (await get("robotsbakery.com", "sitemap.xml")).text(), /<loc>/, "listed again once it's reviewed");

  // With www. connected too, both name the bare domain's sitemap, and only that one lists the page,
  // under the bare address (as the page names it), so the two copies don't compete: once Flash saw the
  // bare domain lead to it. Until then www. is the address that shows the app, and lists itself.
  await run("INSERT INTO site_domains (domain, site_slug, user_id, created_at, connected_at) VALUES ('www.robotsbakery.com', 'robots-1', 'u9', 1, 5)");
  assert.equal(await (await get("www.robotsbakery.com", "robots.txt")).text(), "User-agent: *\nAllow: /\nSitemap: https://www.robotsbakery.com/sitemap.xml\n");
  assert.match(await (await get("www.robotsbakery.com", "sitemap.xml")).text(), /<loc>https:\/\/www.robotsbakery.com\/<\/loc>/);
  await run("UPDATE site_domains SET connected_at = 5 WHERE domain = 'robotsbakery.com'");
  for (const host of ["robotsbakery.com", "www.robotsbakery.com"]) {
    assert.equal(await (await get(host, "robots.txt")).text(), "User-agent: *\nAllow: /\nSitemap: https://robotsbakery.com/sitemap.xml\n", host);
  }
  assert.match(await (await get("robotsbakery.com", "sitemap.xml")).text(), /<loc>https:\/\/robotsbakery.com\/<\/loc>/);
  assert.match(await (await get("www.robotsbakery.com", "sitemap.xml")).text(), empty);
  // A www. alone is the main address.
  await run("DELETE FROM site_domains WHERE domain = 'robotsbakery.com'");
  assert.equal(await (await get("www.robotsbakery.com", "robots.txt")).text(), "User-agent: *\nAllow: /\nSitemap: https://www.robotsbakery.com/sitemap.xml\n");
  assert.match(await (await get("www.robotsbakery.com", "sitemap.xml")).text(), /<loc>https:\/\/www.robotsbakery.com\/<\/loc>/);
});

test("only a domain that leads to Flash now counts as pointing at it", async () => {
  // What Vercel says about each domain: whether it has it verified, and whether its DNS leads there.
  const vercel: Record<string, { verified: boolean; misconfigured: boolean } | "down"> = {
    "crumbbakery.com": { verified: true, misconfigured: false },
    "lapsed.com": { verified: true, misconfigured: true },
    "pending.com": { verified: false, misconfigured: false },
    "flaky.com": "down",
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const domain = Object.keys(vercel).find((d) => url.includes(`/${d}`));
    const state = domain ? vercel[domain] : undefined;
    if (state === "down") throw new Error("timeout");
    if (!state) return Response.json({ error: { code: "not_found" } }, { status: 404 });
    if (url.includes("/config")) return Response.json({ misconfigured: state.misconfigured });
    return Response.json({ verified: state.verified });
  }) as typeof fetch;
  assert.equal(await pointsAtFlash("crumbbakery.com"), true);
  assert.equal(await pointsAtFlash("lapsed.com"), false, "its DNS leads somewhere else");
  assert.equal(await pointsAtFlash("pending.com"), false, "not verified on Vercel yet");
  assert.equal(await pointsAtFlash("flaky.com"), false, "no answer is no");
  assert.equal(await pointsAtFlash("gone.com"), false, "Vercel doesn't have it");
  const token = process.env.VERCEL_API_TOKEN;
  delete process.env.VERCEL_API_TOKEN;
  assert.equal(await pointsAtFlash("crumbbakery.com"), false, "without Vercel nothing can be checked");
  process.env.VERCEL_API_TOKEN = token;
});

test("www. names its bare domain as the main address only once the bare domain leads to Flash too", async () => {
  process.env.FLASH_APP_URL = "https://www.flash-app.dev";
  process.env.FLASH_ADMIN_EMAILS = "owner@x.co,crumb@x.co";
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('u7', 'crumb@x.co', 'h', 0, 1)");
  await run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 'u7', ?)", [createHash("sha256").update("tok-u7").digest("hex"), Date.now() + 3600_000]);
  const page = '<!doctype html><html lang="en"><head><title>Golden Crumb · Sourdough bakery</title></head><body><h1>Bread</h1></body></html>';
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('crumb-7', 'u7', 'Crumb', ?, 0, 1)", [page]);
  // Vercel: www.'s CNAME is set, so www. shows the app; the bare domain's A record still leads to its old host.
  let apexMoved = false;
  let vercelDown = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (vercelDown) return Response.json({ error: { code: "internal" } }, { status: 500 });
    if (url.includes("/config")) return Response.json({ misconfigured: !url.includes("www.crumb.pt") && !apexMoved });
    if (init?.method === "POST") return Response.json({ name: "x", verified: true });
    return Response.json({ verified: true });
  }) as typeof fetch;
  const owner = { id: "u7", email: "crumb@x.co", name: "", verified_at: 1 } as never;
  const proved = async () => [[ownershipValue("u7")]];
  // The owner connects crumb.pt ("Waiting for the DNS record"), follows the tip and connects www. too.
  const bare = await addDomain(owner, "crumb-7", "crumb.pt", proved);
  const www = await addDomain(owner, "crumb-7", "www.crumb.pt", proved);
  assert.deepEqual(["connected" in bare && bare.connected, "connected" in www && www.connected], [false, true]);

  const cookie = { cookie: "flash_session=tok-u7" };
  const canonical = async (host: string) =>
    /<link rel="canonical" href="([^"]+)"/.exec(await (await domainPage.GET(new Request(`http://localhost/d/${host}`), { params: Promise.resolve({ host }) } as never)).text())?.[1];
  const file = async (host: string, name: string) => (await domainFile.GET(new Request(`http://localhost/d/${host}/${name}`), { params: Promise.resolve({ host, file: name }) } as never)).text();
  const seo = async () => {
    const body = await (await seoRoute.GET(new Request("http://localhost/api/sites/crumb-7/seo", { headers: cookie }), { params: Promise.resolve({ slug: "crumb-7" }) } as never)).json();
    const of = (id: string) => body.report.checks.find((c: { id: string }) => c.id === id);
    return { sitemap: of("sitemap").values.url, canonical: [messageOf(of("canonical")), of("canonical").values.domain], domainTest: body.domainTest };
  };
  // www. is the only address that shows the app, so it names itself and lists itself; so does the SEO view.
  assert.equal(await canonical("www.crumb.pt"), "https://www.crumb.pt/");
  assert.equal(await file("www.crumb.pt", "robots.txt"), "User-agent: *\nAllow: /\nSitemap: https://www.crumb.pt/sitemap.xml\n");
  assert.match(await file("www.crumb.pt", "sitemap.xml"), /<loc>https:\/\/www\.crumb\.pt\/<\/loc>/);
  const before = await seo();
  assert.equal(before.sitemap, "https://www.crumb.pt/sitemap.xml");
  assert.equal(before.domainTest, "www.crumb.pt", "Check with Google tests the domain that works");
  assert.deepEqual(before.canonical, [messageOf({ id: "canonical", problem: "domains" }), "https://www.crumb.pt/"], "the page is on Flash's address and on www.");

  // The bare domain's A record is fixed, and the owner presses Check again: from then on both name it.
  apexMoved = true;
  const checked = await (await domainsRoute.GET(new Request("http://localhost/api/sites/crumb-7/domains", { headers: cookie }), { params: Promise.resolve({ slug: "crumb-7" }) } as never)).json();
  assert.deepEqual(checked.domains.map((d: { connected: boolean }) => d.connected), [true, true]);
  for (const host of ["crumb.pt", "www.crumb.pt"]) {
    assert.equal(await canonical(host), "https://crumb.pt/", host);
    assert.equal(await file(host, "robots.txt"), "User-agent: *\nAllow: /\nSitemap: https://crumb.pt/sitemap.xml\n", host);
  }
  assert.doesNotMatch(await file("www.crumb.pt", "sitemap.xml"), /<loc>/);
  const after = await seo();
  assert.deepEqual([after.sitemap, after.domainTest, after.canonical[1]], ["https://crumb.pt/sitemap.xml", "crumb.pt", "https://crumb.pt/"]);

  // A Vercel outage while the owner looks changes nothing Flash knows: both still name the bare domain.
  vercelDown = true;
  await domainsRoute.GET(new Request("http://localhost/api/sites/crumb-7/domains", { headers: cookie }), { params: Promise.resolve({ slug: "crumb-7" }) } as never);
  vercelDown = false;
  for (const host of ["crumb.pt", "www.crumb.pt"]) {
    assert.equal(await canonical(host), "https://crumb.pt/", `${host} after an outage`);
    assert.equal(await file(host, "robots.txt"), "User-agent: *\nAllow: /\nSitemap: https://crumb.pt/sitemap.xml\n", `${host} after an outage`);
  }
  assert.doesNotMatch(await file("www.crumb.pt", "sitemap.xml"), /<loc>/);

  // It moves back to its old host: seen when Flash next looks (here, Check again), www. names itself again.
  apexMoved = false;
  await domainsRoute.GET(new Request("http://localhost/api/sites/crumb-7/domains", { headers: cookie }), { params: Promise.resolve({ slug: "crumb-7" }) } as never);
  assert.equal(await canonical("www.crumb.pt"), "https://www.crumb.pt/");
});
