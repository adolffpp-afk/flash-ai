import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

/*
 * Published apps can't be used against their visitors or against Flash: another page can't sign a
 * visitor in to an app as someone else, a custom domain shows only its own app's files, an app
 * can't pose as Flash's Connect page, removed members' files go, and no page is slow to serve.
 */
register("./support/route-hooks.mjs", import.meta.url);
process.env.DATABASE_URL = ":memory:";

const { run } = await import("../src/lib/server/db.ts");
const { serveSite } = await import("../src/lib/server/serve-site.ts");
const { FORM_COOKIE, siteAuth, removeSiteUser } = await import("../src/lib/server/site-auth.ts");
const { saveUpload, readUpload } = await import("../src/lib/server/site-files.ts");
const { validRedirectUri } = await import("../src/lib/server/connector.ts");
const { makeSlug } = await import("../src/lib/server/sites.ts");
const { hasOwnPreview, sitePreview } = await import("../src/lib/site-preview.ts");
const { injectHead } = await import("../src/lib/flashdb-shim.ts");
const authRoute = await import("../src/app/api/sites/[slug]/auth/route.ts");
const { routeHost } = await import("../src/lib/site-host.ts");
const { siteForDomain } = await import("../src/lib/server/domains.ts");

await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('owner', 'o@x.io', '', 0, 1)");
await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('journal', 'owner', 'Journal', '<head></head><p>hi', 0, 0)");
await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('evil', 'owner', 'Evil', '<p>', 0, 0)");

const signInForm = (fields: Record<string, string>, cookie = "") =>
  new Request("https://flash-app.dev/api/sites/journal/auth", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "null", cookie },
    body: new URLSearchParams(fields).toString(),
  });

test("an app's sign-in form works only with the key its own page gave this browser", async () => {
  assert.equal((await siteAuth("journal", "signup", { email: "attacker@evil.io", password: "longenough1" }, "1.1.1.1", "/p/journal", true, null)).result, "ok");
  const page = await serveSite("journal", undefined, new Request("https://flash-app.dev/p/journal"));
  const set = page.headers.get("set-cookie") ?? "";
  assert.match(set, new RegExp(`^${FORM_COOKIE}=[\\w-]+; Path=/api/sites/journal/auth; HttpOnly;.*SameSite=None; Secure`));
  const key = set.split(";")[0].split("=")[1];
  assert.ok((await page.text()).includes(JSON.stringify(key)), "the page's forms carry the key");

  const creds = { action: "signin", email: "attacker@evil.io", password: "longenough1" };
  // Another site posting the attacker's details: no key, or a key of its own, signs nobody in.
  for (const r of [await authRoute.POST(signInForm(creds), { params: Promise.resolve({ slug: "journal" }) } as never),
    await authRoute.POST(signInForm({ ...creds, form_key: "x".repeat(32) }, `${FORM_COOKIE}=${key}`), { params: Promise.resolve({ slug: "journal" }) } as never)]) {
    assert.equal(r.status, 303);
    assert.match(r.headers.get("location")!, /flash_auth=unknown/);
    assert.equal(r.headers.get("set-cookie"), null);
  }
  // The app's own page, with its key and the matching cookie: signed in.
  const own = await authRoute.POST(signInForm({ ...creds, form_key: key }, `${FORM_COOKIE}=${key}`), { params: Promise.resolve({ slug: "journal" }) } as never);
  assert.match(own.headers.get("location")!, /flash_auth=ok/);
  assert.match(own.headers.get("set-cookie")!, /^flash_app_session=/);
  // A browser that has its key isn't given a new one.
  const again = await serveSite("journal", undefined, new Request("https://flash-app.dev/p/journal", { headers: { cookie: `${FORM_COOKIE}=${key}` } }));
  assert.equal(again.headers.get("set-cookie"), null);
});

test("a custom domain reaches only its own app's API, files included", async () => {
  await run("INSERT INTO site_domains (domain, site_slug, user_id, created_at) VALUES ('shop.example.com', 'journal', 'owner', 0)");
  // What src/proxy.ts does: a site API call on a custom domain goes through only for the site connected to it.
  const passes = async (path: string) => {
    const route = routeHost("shop.example.com", path, "GET");
    return "siteApi" in route && (await siteForDomain("shop.example.com")) === route.siteApi;
  };
  assert.equal(await passes("/api/sites/journal/files/abc123"), true);
  assert.equal(await passes("/api/sites/evil/files/abc123"), false, "another app's files aren't shown under this domain");
  assert.equal(await passes("/api/sites/evil/data"), false);
  // On Flash's own host every app's API works as before.
  assert.deepEqual(routeHost("flash-app.dev", "/api/sites/evil/data", "GET"), { pass: true });
});

test("no app can be the return address of Connect to Flash, or take a look-alike address", () => {
  assert.equal(validRedirectUri("https://www.flash-app.dev/p/claude-ab12"), false);
  assert.equal(validRedirectUri("https://flash-app.dev./p/x"), false);
  assert.equal(validRedirectUri("https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(validRedirectUri("https://my-app.vercel.app/callback"), true);
  for (const title of ["Flash sign in", "Login", "Connect your account", "OAuth", "Reset password"]) assert.match(makeSlug(title), /^app-/, title);
  assert.match(makeSlug("Ann's bakery"), /^ann-s-bakery-/);
});

test("removing someone from an app stops serving the files they sent", async () => {
  await run("INSERT INTO site_users (id, site_slug, email, name, password_hash, created_at) VALUES ('m1', 'journal', 'm@x.io', '', '', 0)");
  await run("UPDATE sites SET uploads_on = 1 WHERE slug = 'journal'");
  const saved = await saveUpload("journal", { name: "cv.pdf", type: "application/pdf", bytes: Buffer.from("%PDF-1.4") }, "m1");
  const id = String((saved.body as { url?: string }).url).split("/").pop()!;
  assert.ok(await readUpload("journal", id));
  assert.equal(await removeSiteUser("journal", "m1"), true);
  assert.equal(await readUpload("journal", id), null);
});

test("a page of half-written tags is still quick to serve", () => {
  for (const unit of ["<meta ", "<img ", "<p>", "<title>", "<head ", "<meta name=description content=\""]) {
    const html = "<!doctype html>" + unit.repeat(Math.floor(2_000_000 / unit.length));
    const started = performance.now();
    hasOwnPreview(html);
    sitePreview(html);
    injectHead(html, "<script></script>");
    assert.ok(performance.now() - started < 1000, unit);
  }
  // Ordinary pages read as before.
  const page = '<html><head><title>Home · Bakery</title><meta name="description" content="Fresh bread &amp; cakes"></head><body><p>Hi</p><img src="https://x.io/cake.jpg"></body>';
  assert.deepEqual(sitePreview(page), { title: "Bakery", description: "Fresh bread & cakes", image: "https://x.io/cake.jpg" });
  assert.equal(injectHead("<html><head lang=en><title>x</title></head>", "S"), "<html><head lang=en>S<title>x</title></head>");
  assert.equal(injectHead("<!doctype html><header>x</header>", "S"), "<!doctype html>S<header>x</header>");
});
