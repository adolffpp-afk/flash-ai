import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
process.env.VERCEL_API_TOKEN = "t";
process.env.VERCEL_PROJECT_ID = "flash-ai";
process.env.FLASH_ADMIN_EMAILS = "owner@x.co";
const { run } = await import("../src/lib/server/db.ts");
const { cleanDomain, isSubdomain, addDomain, siteForDomain, removeDomain, domainsForSite, ownershipValue, ownershipRecord, provesOwnership, pointsAtFlash } =
  await import("../src/lib/server/domains.ts");
const { routeHost } = await import("../src/lib/site-host.ts");

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
  assert.deepEqual(routeHost("crumbbakery.com", "/api/sites/bakery-1/inbox", "POST"), { pass: true });
  assert.deepEqual(routeHost("crumbbakery.com", "/api/sites/bakery-1/data", "GET"), { pass: true });
  assert.deepEqual(routeHost("crumbbakery.com", "/admin", "GET"), { redirect: "/" });
  assert.deepEqual(routeHost("crumbbakery.com", "/api/auth/signin", "POST"), { notFound: true });
  assert.deepEqual(routeHost("flash.example.org", "/admin", "GET", "flash.example.org"), { pass: true }, "FLASH_APP_URL's host is Flash's own");
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
