import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
process.env.VERCEL_API_TOKEN = "t";
process.env.VERCEL_PROJECT_ID = "flash-ai";
process.env.FLASH_ADMIN_EMAILS = "owner@x.co";
const { run } = await import("../src/lib/server/db.ts");
const { cleanDomain, isSubdomain, addDomain, siteForDomain, removeDomain, domainsForSite } = await import("../src/lib/server/domains.ts");
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

  const free = await addDomain(user("u2", "free@x.co"), "bakery-1", "crumbbakery.com");
  assert.equal("status" in free && free.status, 402, "free accounts can't connect domains");

  const apex = await addDomain(user("u1", "owner@x.co"), "bakery-1", "CrumbBakery.com");
  assert.ok(!("error" in apex));
  assert.deepEqual(apex.records, [{ type: "A", name: "@", value: "216.198.79.1" }]);
  assert.equal(apex.connected, false);
  assert.ok(calls.includes("POST /v10/projects/flash-ai/domains"));
  const sub = await addDomain(user("u1", "owner@x.co"), "bakery-1", "www.crumbbakery.com");
  assert.ok(!("error" in sub));
  assert.deepEqual(sub.records, [{ type: "CNAME", name: "www", value: "abc.vercel-dns-017.com" }]);
  assert.equal(await siteForDomain("crumbbakery.com"), "bakery-1");

  await removeDomain("www.crumbbakery.com");
  assert.ok(calls.includes("DELETE /v9/projects/flash-ai/domains/www.crumbbakery.com"));
  assert.deepEqual(await domainsForSite("bakery-1"), ["crumbbakery.com"]);
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
