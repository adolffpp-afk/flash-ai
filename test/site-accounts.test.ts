import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";

const { run, one } = await import("../src/lib/server/db.ts");
const { siteAuth, visitorForSession, newPageToken, visitorForPageToken, listSiteUsers, countSiteUsers, removeSiteUser, SITE_COOKIE } =
  await import("../src/lib/server/site-auth.ts");
const { listRecords, addRecord, patchRecord, removeRecord } = await import("../src/lib/server/site-data.ts");
const { flashDbShim } = await import("../src/lib/flashdb-shim.ts");
const { routeHost } = await import("../src/lib/site-host.ts");

const token = (cookie?: string) => cookie?.split("=")[1].split(";")[0] ?? "";
const signUp = (slug: string, email: string, password: string, name = "", ip = "1.1.1.1") =>
  siteAuth(slug, "signup", { email, password, name }, ip, `/p/${slug}`, true, null);
const signIn = (slug: string, email: string, password: string, ip = "1.1.1.1") =>
  siteAuth(slug, "signin", { email, password }, ip, `/p/${slug}`, true, null);

test("people sign up to a published app and come back signed in", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('owner', 'o@x.io', '', 0, 1)");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('shop', 'owner', 'Shop', '<p>', 0, 0)");

  const joined = await signUp("shop", "Ann@Example.com ", "longenough1", "Ann");
  assert.equal(joined.result, "ok");
  assert.match(joined.cookie!, new RegExp(`^${SITE_COOKIE}=`));
  assert.match(joined.cookie!, /HttpOnly/);
  assert.match(joined.cookie!, /SameSite=Lax/);
  assert.match(joined.cookie!, /Path=\/p\/shop/, "the cookie belongs to this app alone");
  assert.match(joined.cookie!, /Secure/);

  const who = await visitorForSession("shop", token(joined.cookie));
  assert.equal(who?.email, "ann@example.com", "emails are kept in lower case");
  assert.equal(who?.name, "Ann");
  // The same cookie is worth nothing on another app.
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('other', 'owner', 'Other', '<p>', 0, 0)");
  assert.equal(await visitorForSession("other", token(joined.cookie)), null);

  const back = await signIn("shop", "ann@example.com", "longenough1");
  assert.equal(back.result, "ok");
  assert.equal((await visitorForSession("shop", token(back.cookie)))?.id, who?.id);
});

test("bad emails, short passwords, wrong passwords and taken emails are refused", async () => {
  assert.equal((await signUp("shop", "nope", "longenough1")).result, "bad-email");
  assert.equal((await signUp("shop", "b@x.io", "short")).result, "short-password");
  assert.equal((await signIn("shop", "ann@example.com", "wrongpassword")).result, "wrong");
  assert.equal((await signIn("shop", "nobody@x.io", "longenough1")).result, "wrong", "an unknown email reads like a wrong password");
  assert.equal((await signUp("shop", "ann@example.com", "anotherpassword")).result, "taken");
  // Signing up again with the right password just signs you in.
  assert.equal((await signUp("shop", "ann@example.com", "longenough1")).result, "ok");
  assert.equal((await signUp("gone", "ann@example.com", "longenough1")).result, "no-app");
  assert.equal(await countSiteUsers("shop"), 1);
});

test("guessing passwords is slowed down, one visitor at a time", async () => {
  const tries = [];
  for (let i = 0; i < 14; i++) tries.push((await signIn("shop", "ann@example.com", `guess${i}guess`, "9.9.9.9")).result);
  assert.ok(tries.includes("too-many"), "the tries stop after a dozen");
  // Someone else carries on as usual.
  assert.equal((await signIn("shop", "ann@example.com", "longenough1", "2.2.2.2")).result, "ok");
});

test("signing out ends that session and clears the cookie", async () => {
  const session = await signIn("shop", "ann@example.com", "longenough1", "3.3.3.3");
  const out = await siteAuth("shop", "signout", {}, "3.3.3.3", "/p/shop", true, token(session.cookie));
  assert.equal(out.result, "signed-out");
  assert.match(out.cookie!, /Max-Age=0/);
  assert.equal(await visitorForSession("shop", token(session.cookie)), null);
});

test("each person's own records are theirs alone, and the app's shared ones stay shared", async () => {
  const ann = (await signIn("shop", "ann@example.com", "longenough1", "4.4.4.4"))!;
  const annId = (await visitorForSession("shop", token(ann.cookie)))!.id;
  const bob = await signUp("shop", "bob@example.com", "longenough1", "Bob", "5.5.5.5");
  const bobId = (await visitorForSession("shop", token(bob.cookie)))!.id;

  await addRecord("shop", "orders", { item: "Bread" }, annId);
  await addRecord("shop", "orders", { item: "Cake" }, bobId);
  await addRecord("shop", "menu", { item: "Bread", price: 8 }, "");

  const annSees = (await listRecords("shop", "orders", "", annId)).body as { records: { item: string }[] };
  assert.deepEqual(annSees.records.map((r) => r.item), ["Bread"]);
  const bobSees = (await listRecords("shop", "orders", "", bobId)).body as { records: { item: string }[] };
  assert.deepEqual(bobSees.records.map((r) => r.item), ["Cake"]);
  // The app's shared records hold neither of them.
  const shared = (await listRecords("shop", "orders", "", "")).body as { records: unknown[] };
  assert.equal(shared.records.length, 0);
  assert.equal(((await listRecords("shop", "menu", "", "")).body as { records: unknown[] }).records.length, 1);

  // One person can't change or delete another's record.
  const annOrder = annSees.records[0] as { item: string; id: string };
  assert.equal((await patchRecord("shop", "orders", annOrder.id, { item: "Stolen" }, bobId)).status, 404);
  await removeRecord("shop", "orders", annOrder.id, bobId);
  assert.equal(((await listRecords("shop", "orders", "", annId)).body as { records: unknown[] }).records.length, 1, "still there");
  assert.equal((await patchRecord("shop", "orders", annOrder.id, { item: "Rye bread" }, annId)).status, 200);
});

test("the key put into a page works for that app only, and dies with the person", async () => {
  const bobId = (await listSiteUsers("shop")).find((m) => m.email === "bob@example.com")!.id;
  const key = await newPageToken(bobId, "shop");
  assert.equal((await visitorForPageToken("shop", `Bearer ${key}`))?.email, "bob@example.com");
  assert.equal(await visitorForPageToken("shop", `Bearer ${key}x`), null);
  assert.equal(await visitorForPageToken("other", `Bearer ${key}`), null, "not on another app");
  assert.equal(await visitorForPageToken("shop", null), null);
  assert.equal(await visitorForPageToken("shop", key), null, "a bare key without Bearer is no key");
  // An expired key is no key.
  await run("UPDATE site_page_tokens SET expires_at = 1");
  assert.equal(await visitorForPageToken("shop", `Bearer ${key}`), null);

  // The owner removes Bob: his sign-in, his key and his private records all go.
  assert.equal(await removeSiteUser("shop", bobId), true);
  assert.equal(await removeSiteUser("shop", bobId), false);
  assert.equal(await visitorForPageToken("shop", `Bearer ${await newPageToken(bobId, "shop").catch(() => "")}`), null);
  const left = await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_records WHERE site_slug = 'shop' AND owner = ?", [bobId]);
  assert.equal(Number(left?.n), 0);
});

test("apps are told who is signed in, and never see the session cookie", () => {
  const visitor = { user: { id: "u1", email: "ann@example.com", name: "Ann" }, token: "page-key" };
  const page = flashDbShim("/api/sites/shop/data", "/in", "/shop", false, "/api/sites/shop/auth", "/api/sites/shop/mine", visitor);
  assert.match(page, /window\.flashAuth = \{/);
  assert.match(page, /"ann@example\.com"/);
  assert.match(page, /"page-key"/);
  assert.match(page, /window\.flashDB\.mine = \{/);
  assert.ok(!page.includes("document.cookie"), "an app can't read cookies at all");
  // Signed out, there's no user and no key.
  const anon = flashDbShim("/api/sites/shop/data", "/in", "/shop", false, "/api/sites/shop/auth", "/api/sites/shop/mine");
  assert.match(anon, /const me = null/);
  assert.match(anon, /const key = ""/);
  // The preview inside Flash pretends, so sign-in screens can be tried before publishing.
  const preview = flashDbShim(null);
  assert.match(preview, /pretend sign-in/);
  assert.match(preview, /window\.flashDB\.mine = \{/);
});

test("a site on its own domain can sign people in and reach their data", () => {
  for (const path of ["/api/sites/shop/auth", "/api/sites/shop/mine", "/api/sites/shop/data"]) {
    assert.deepEqual(routeHost("mybakery.com", path, "POST"), { pass: true }, path);
  }
  // Flash's own pages still aren't reachable from a custom domain.
  assert.deepEqual(routeHost("mybakery.com", "/api/me", "GET"), { redirect: "/" });
  assert.deepEqual(routeHost("mybakery.com", "/api/me", "POST"), { notFound: true });
});
