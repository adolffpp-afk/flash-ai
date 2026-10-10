import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

process.env.DATABASE_URL = ":memory:";

const { run, one } = await import("../src/lib/server/db.ts");
const { sha256 } = await import("../src/lib/server/ids.ts");
const { createSession } = await import("../src/lib/server/auth.ts");
const { siteAuth, visitorForSession, newPageToken, SITE_COOKIE } = await import("../src/lib/server/site-auth.ts");
const { listRecords, addRecord, patchRecord, removeRecord, collectionRule, chooseRule, sharedCollections, newestShared, sharedCsv } =
  await import("../src/lib/server/site-data.ts");
const { newOwnerKey, isOwnerKey, callerFor } = await import("../src/lib/server/site-owner.ts");
const { publishSite, restoreVersion, listVersions, versionHtml, unpublishSite, slugTaken } = await import("../src/lib/server/sites.ts");
const { saveUpload, readUpload, setUploadsOn } = await import("../src/lib/server/site-files.ts");
const { serveSite } = await import("../src/lib/server/serve-site.ts");
const { flashDbShim, MEMORY_DB } = await import("../src/lib/flashdb-shim.ts");
const { ANYONE, OWNER, computeRules } = await import("../src/lib/data-rules.ts");
const { routeHost } = await import("../src/lib/site-host.ts");
type Caller = import("../src/lib/data-rules.ts").Caller;

const owner = { id: "owner", email: "o@x.io", name: "", verified_at: 1 } as never;
await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('owner', 'o@x.io', '', 0, 1), ('other', 'x@x.io', '', 0, 1)");

const flashData = (rules: object) => `<script type="application/json" id="flash-data">${JSON.stringify(rules)}</script>`;
/** Publishes an app as the owner and returns its slug. */
async function publish(html: string, title = "App", slug?: string): Promise<string> {
  const result = await publishSite(owner, { html, title, slug });
  assert.ok("slug" in result, JSON.stringify(result));
  return result.slug;
}
/** A site from before data rules existed: no rules saved with it. */
async function legacySite(slug: string, html: string) {
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES (?, 'owner', 'Old', ?, 0, 0)", [slug, html]);
}
const cookieToken = (cookie?: string) => cookie?.split("=")[1].split(";")[0] ?? "";
/** Signs someone up to an app and returns who they are to the data API, as their page key says. */
async function member(slug: string, email: string, ip: string): Promise<Caller & { kind: "visitor" }> {
  const joined = await siteAuth(slug, "signup", { email, password: "longenough1" }, ip, `/p/${slug}`, true, null);
  const session = cookieToken(joined.cookie);
  const who = (await visitorForSession(slug, session))!;
  const caller = await callerFor(slug, `Bearer ${await newPageToken(who.id, slug, session)}`);
  assert.deepEqual(caller, { kind: "visitor", id: who.id });
  return caller as Caller & { kind: "visitor" };
}
const records = (answer: { body: unknown }) => (answer.body as { records: Record<string, unknown>[] }).records;
const record = (answer: { body: unknown }) => (answer.body as { record: Record<string, unknown> }).record;

test("the wipe from the audit is refused", async () => {
  const html = `<script>flashDB.list("reviews").then(show); form.onsubmit = () => flashDB.add("reviews", { text: input.value });</script>`;
  const slug = await publish(html, "Reviews");
  const saved = await one<{ data_rules: string }>("SELECT data_rules FROM sites WHERE slug = ?", [slug]);
  assert.deepEqual(JSON.parse(saved!.data_rules), { v: 1, guess: "add", app: {} }, "the rules are saved with the page");

  const added = await addRecord(slug, "reviews", { text: "Lovely" }, "", ANYONE);
  assert.equal(added.status, 201, "anyone can still add");
  const id = record(added).id as string;
  assert.equal((await patchRecord(slug, "reviews", id, { text: "spam" }, "", ANYONE)).status, 403);
  assert.equal((await removeRecord(slug, "reviews", id, "", ANYONE)).status, 403);
  assert.deepEqual(records(await listRecords(slug, "reviews", "", "", ANYONE)).map((r) => r.text), ["Lovely"], "still there, unchanged");
  assert.equal((await removeRecord(slug, "reviews", id, "", OWNER)).status, 200, "the owner can");
  assert.equal(records(await listRecords(slug, "reviews", "", "", ANYONE)).length, 0);

  // An app published before rules existed gets its rules the first time its data is used.
  await legacySite("old-reviews", html);
  assert.equal((await addRecord("old-reviews", "reviews", { text: "Hi" }, "", ANYONE)).status, 201);
  const later = await one<{ data_rules: string }>("SELECT data_rules FROM sites WHERE slug = 'old-reviews'");
  assert.equal(JSON.parse(later!.data_rules).guess, "add");
  const old = records(await listRecords("old-reviews", "reviews", "", "", ANYONE))[0];
  assert.equal((await removeRecord("old-reviews", "reviews", old.id as string, "", ANYONE)).status, 403);
  // Damaged rules are worked out again.
  await run("UPDATE sites SET data_rules = '{broken' WHERE slug = 'old-reviews'");
  assert.deepEqual(await collectionRule("old-reviews", "reviews"), { rule: "add", source: "guess" });
  assert.equal(await collectionRule("no-such-app", "reviews"), null);
  assert.equal((await listRecords("no-such-app", "reviews", "", "", ANYONE)).status, 404);
});

test("an app made before rules that changes records keeps working", async () => {
  await legacySite("todo-old", `<script>flashDB.add("todos", t); flashDB.update("todos", id, { done: true }); flashDB.remove("todos", id)</script>`);
  const added = await addRecord("todo-old", "todos", { text: "milk" }, "", ANYONE);
  assert.equal(added.status, 201);
  const id = record(added).id as string;
  assert.equal((await patchRecord("todo-old", "todos", id, { done: true }, "", ANYONE)).status, 200);
  assert.equal((await removeRecord("todo-old", "todos", id, "", ANYONE)).status, 200);
  assert.equal(records(await listRecords("todo-old", "todos", "", "", ANYONE)).length, 0);
  assert.equal((await removeRecord("todo-old", "todos", "gone", "", ANYONE)).status, 200, "a record already gone is fine");
  assert.equal((await patchRecord("todo-old", "todos", "gone", {}, "", ANYONE)).status, 404);
});

test("signed-in people manage their own records", async () => {
  const slug = await publish(flashData({ posts: "own" }) + `<script>flashDB.list("posts")</script>`, "Board");
  const ann = await member(slug, "ann@example.com", "1.1.1.1");
  const bob = await member(slug, "bob@example.com", "2.2.2.2");

  const anon = await addRecord(slug, "posts", { text: "hi" }, "", ANYONE);
  assert.deepEqual(anon, { status: 401, body: { error: "Sign in to add here." } });
  const added = await addRecord(slug, "posts", { text: "Ann's post", byYou: false, authorId: "bob" }, "", ann);
  assert.equal(added.status, 201);
  assert.equal(record(added).byYou, true);
  assert.equal(record(added).authorId, undefined, "a forged author is dropped");
  const id = record(added).id as string;
  const stored = await one<{ data: string; author: string }>("SELECT data, author FROM site_records WHERE id = ?", [id]);
  assert.deepEqual(JSON.parse(stored!.data), { text: "Ann's post" });
  assert.equal(stored!.author, ann.id);

  assert.equal(records(await listRecords(slug, "posts", "", "", ann))[0].byYou, true, "Ann sees it's hers");
  assert.equal(records(await listRecords(slug, "posts", "", "", bob))[0].byYou, undefined, "Bob doesn't");
  assert.equal(records(await listRecords(slug, "posts", "", "", ANYONE))[0].byYou, undefined);
  // Bob can't claim it by writing byYou into it.
  await addRecord(slug, "posts", { text: "Bob's", byYou: true }, "", bob);
  const seenByAnn = records(await listRecords(slug, "posts", "", "", ann));
  assert.deepEqual(seenByAnn.map((r) => [r.text, r.byYou]), [["Ann's post", true], ["Bob's", undefined]]);

  assert.equal((await patchRecord(slug, "posts", id, { text: "Bob was here" }, "", bob)).status, 403);
  assert.equal((await removeRecord(slug, "posts", id, "", bob)).status, 403);
  assert.equal((await patchRecord(slug, "posts", id, { text: "x" }, "", ANYONE)).status, 403);
  const changed = await patchRecord(slug, "posts", id, { text: "Ann's edit", byYou: false }, "", ann);
  assert.equal(changed.status, 200);
  assert.equal(record(changed).byYou, true);
  assert.equal((await patchRecord(slug, "posts", id, { text: "Tidied by the owner" }, "", OWNER)).status, 200);
  assert.equal((await patchRecord(slug, "posts", "missing", { text: "x" }, "", ann)).status, 404);
  assert.equal((await removeRecord(slug, "posts", id, "", ann)).status, 200);

  // The owner sees who added what.
  const list = await newestShared(slug, "posts");
  assert.deepEqual(list.map((r) => [r.data, r.addedBy]), [[{ text: "Bob's" }, "bob@example.com"]]);
});

test("private collections take sign-ups but only the owner reads them", async () => {
  const slug = await publish(flashData({ signups: "private" }) + `<script>flashDB.add("signups", f)</script>`, "Waitlist");
  const ann = await member(slug, "ann@example.com", "3.3.3.3");
  assert.equal((await addRecord(slug, "signups", { email: "a@b.co" }, "", ANYONE)).status, 201);
  assert.equal((await addRecord(slug, "signups", { email: "ann@example.com" }, "", ann)).status, 201);
  assert.deepEqual(await listRecords(slug, "signups", "", "", ANYONE), { status: 403, body: { error: "Only this app's owner can see this." } });
  assert.equal((await listRecords(slug, "signups", "", "", ann)).status, 403, "not even what you sent");
  assert.equal(records(await listRecords(slug, "signups", "", "", OWNER)).length, 2);
  const id = records(await listRecords(slug, "signups", "", "", OWNER))[0].id as string;
  assert.equal((await patchRecord(slug, "signups", id, { email: "x" }, "", ann)).status, 403);
  assert.equal((await removeRecord(slug, "signups", id, "", ANYONE)).status, 403);

  const data = (await sharedCollections(slug))!;
  assert.deepEqual(
    data.collections.map((c) => [c.name, c.count, c.rule, c.source, c.personal]),
    [["signups", 2, "private", "app", ["email"]]],
  );
});

test("read-only collections: visitors read, only the owner adds", async () => {
  const slug = await publish(flashData({ menu: "read" }) + `<script>flashDB.list("menu")</script>`, "Menu");
  const ann = await member(slug, "ann@example.com", "4.4.4.4");
  assert.deepEqual(await addRecord(slug, "menu", { dish: "Soup" }, "", ANYONE), { status: 403, body: { error: "Only this app's owner can change this." } });
  assert.equal((await addRecord(slug, "menu", { dish: "Soup" }, "", ann)).status, 403);
  const added = await addRecord(slug, "menu", { dish: "Soup", price: 8 }, "", OWNER);
  assert.equal(added.status, 201);
  assert.equal(record(added).byYou, undefined, "only signed-in visitors are told what they added");
  const id = record(added).id as string;
  assert.deepEqual(records(await listRecords(slug, "menu", "", "", ANYONE)).map((r) => r.dish), ["Soup"]);
  assert.equal((await patchRecord(slug, "menu", id, { price: 0 }, "", ANYONE)).status, 403);
  assert.equal((await patchRecord(slug, "menu", id, { price: 0 }, "", ann)).status, 403);
  assert.equal((await removeRecord(slug, "menu", id, "", ann)).status, 403);
  assert.equal((await patchRecord(slug, "menu", id, { price: 9 }, "", OWNER)).status, 200);
  // Collections the app didn't name are read-only too.
  assert.equal((await addRecord(slug, "anything", { x: 1 }, "", ANYONE)).status, 403);

  // The owner can open one up, or set a default for anything else.
  assert.equal(await chooseRule(slug, "*", "add"), true);
  assert.equal((await addRecord(slug, "anything", { x: 1 }, "", ANYONE)).status, 201);
  assert.deepEqual(await collectionRule(slug, "anything"), { rule: "add", source: "default" });
  assert.deepEqual(await collectionRule(slug, "menu"), { rule: "read", source: "app" }, "the app's own rule still wins over the default");
  assert.equal(await chooseRule(slug, "*", null), true);
  assert.equal(await chooseRule(slug, "bad name", "add"), false);

  // The CSV is cut, newest first, when it would be too big.
  for (let i = 0; i < 5; i++) {
    const r = record(await addRecord(slug, "menu", { dish: `Dish ${i}`, note: "x".repeat(200) }, "", OWNER));
    await run("UPDATE site_records SET created_at = ? WHERE id = ?", [Date.now() + 1000 + i, r.id as string]);
  }
  const all = await sharedCsv(slug, "menu");
  assert.equal(all.included, 6);
  // After the byte-order mark Excel needs, a header row from the newest record's fields.
  assert.equal(all.csv.charCodeAt(0), 0xfeff);
  assert.equal(all.csv.slice(1).split("\r\n")[0], "Added,dish,note,price,id");
  const cut = await sharedCsv(slug, "menu", undefined, 700);
  assert.deepEqual([cut.included, cut.total], [2, 6]);
  assert.ok(Buffer.byteLength(cut.csv) <= 700);
  assert.match(cut.csv, /Dish 4/);
  assert.doesNotMatch(cut.csv, /Dish 0/);
});

test("owner keys work for one app, and end with the Flash sign-in or after two hours", async () => {
  const slug = await publish(flashData({ menu: "read" }), "Keys");
  const otherSlug = await publish("<p>other</p>", "Other");
  const session = cookieToken(await createSession("owner", true));
  const key = (await newOwnerKey(slug, "owner", session))!;
  assert.match(key, /^o_/);
  assert.equal(await isOwnerKey(slug, key), true);
  assert.deepEqual(await callerFor(slug, `Bearer ${key}`), OWNER);
  assert.equal((await addRecord(slug, "menu", { dish: "Pie" }, "", await callerFor(slug, `Bearer ${key}`))).status, 201);
  assert.equal(await isOwnerKey(otherSlug, key), false, "not for another app");
  assert.deepEqual(await callerFor(otherSlug, `Bearer ${key}`), ANYONE);
  assert.deepEqual(await callerFor(slug, key), ANYONE, "a bare key without Bearer is no key");
  assert.deepEqual(await callerFor(slug, null), ANYONE);
  assert.equal(await newOwnerKey(slug, "other", session), null, "only the app's owner gets one");
  assert.equal(await newOwnerKey(slug, "owner", ""), null);
  const stored = await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_owner_keys WHERE token_hash = ?", [key]);
  assert.equal(Number(stored?.n), 0, "only the key's hash is kept");

  // Signing out of Flash ends it.
  await run("DELETE FROM sessions WHERE token_hash = ?", [sha256(session)]);
  assert.equal(await isOwnerKey(slug, key), false);
  // So do two hours.
  const session2 = cookieToken(await createSession("owner", true));
  const key2 = (await newOwnerKey(slug, "owner", session2))!;
  assert.equal(await isOwnerKey(slug, key2), true);
  await run("UPDATE site_owner_keys SET expires_at = 0 WHERE token_hash = ?", [sha256(key2)]);
  assert.equal(await isOwnerKey(slug, key2), false);
  // At most 20 live keys per app and owner.
  for (let i = 0; i < 25; i++) await newOwnerKey(slug, "owner", session2);
  const live = await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_owner_keys WHERE site_slug = ?", [slug]);
  assert.equal(Number(live?.n), 20);
  // If the app changes hands or goes, its keys stop working.
  const key3 = (await newOwnerKey(slug, "owner", session2))!;
  await run("UPDATE sites SET user_id = 'other' WHERE slug = ?", [slug]);
  assert.equal(await isOwnerKey(slug, key3), false);
  await run("UPDATE sites SET user_id = 'owner' WHERE slug = ?", [slug]);
  assert.equal(await isOwnerKey(slug, key3), true);
  assert.equal(await unpublishSite("owner", slug), true);
  assert.equal(await isOwnerKey(slug, key3), false);
});

test("a page token that happens to start with o_ still signs the visitor in", async () => {
  const slug = await publish(flashData({ posts: "own" }), "Lucky");
  const ann = await member(slug, "ann@example.com", "5.5.5.5");
  const token = "o_" + "a".repeat(30);
  await run("INSERT INTO site_page_tokens (token_hash, site_user_id, site_slug, expires_at, session_hash) VALUES (?, ?, ?, ?, '')", [
    sha256(token),
    ann.id,
    slug,
    Date.now() + 60_000,
  ]);
  assert.deepEqual(await callerFor(slug, `Bearer ${token}`), { kind: "visitor", id: ann.id });
  assert.deepEqual(await callerFor(slug, `Bearer o_nothing`), ANYONE);
});

test("the owner's choice survives republishing, and restoring a version recomputes the app's rules", async () => {
  const v1 = flashData({ menu: "read" }) + "<p>v1</p>";
  const v2 = flashData({ menu: "read", reviews: "add" }) + "<p>v2</p>";
  const v3 = `<script>flashDB.update("menu", id, {})</script><p>v3</p>`;
  const slug = await publish(v1, "Cafe");
  assert.equal(await chooseRule(slug, "menu", "open"), true);
  const second = await publishSite(owner, { html: v2, title: "Cafe", slug });
  assert.ok("data" in second && second.data);
  assert.deepEqual(second.data, {
    collections: [
      { name: "menu", rule: "open", source: "you" },
      { name: "reviews", rule: "add", source: "app" },
    ],
    other: "read",
  });
  await publish(v3, "Cafe", slug);
  assert.deepEqual(await collectionRule(slug, "reviews"), { rule: "open", source: "guess" });
  assert.deepEqual(await collectionRule(slug, "menu"), { rule: "open", source: "you" });

  let v2Id = "";
  for (const v of await listVersions(slug)) if ((await versionHtml(slug, v.id)) === v2) v2Id = v.id;
  assert.ok(v2Id);
  assert.equal(await restoreVersion("owner", slug, v2Id), true);
  const saved = await one<{ data_rules: string }>("SELECT data_rules FROM sites WHERE slug = ?", [slug]);
  assert.deepEqual(JSON.parse(saved!.data_rules), computeRules(v2));
  assert.deepEqual(await collectionRule(slug, "reviews"), { rule: "add", source: "app" });
  assert.deepEqual(await collectionRule(slug, "menu"), { rule: "open", source: "you" }, "the owner's choice stays");
  assert.equal(await chooseRule(slug, "menu", null), true);
  assert.deepEqual(await collectionRule(slug, "menu"), { rule: "read", source: "app" }, "back to the app's choice");
});

test("each person's private records are unaffected by data rules", async () => {
  const slug = await publish(flashData({ notes: "read" }), "Notes");
  const ann = await member(slug, "ann@example.com", "6.6.6.6");
  const bob = await member(slug, "bob@example.com", "7.7.7.7");
  const added = await addRecord(slug, "notes", { text: "mine" }, ann.id);
  assert.equal(added.status, 201);
  const id = record(added).id as string;
  assert.equal(records(await listRecords(slug, "notes", "", ann.id)).length, 1);
  assert.equal((await patchRecord(slug, "notes", id, { text: "Bob's" }, bob.id)).status, 404);
  assert.equal((await patchRecord(slug, "notes", id, { text: "still mine" }, ann.id)).status, 200);
  assert.equal(records(await listRecords(slug, "notes", "", "", ANYONE)).length, 0, "the shared notes are empty");
  assert.equal((await removeRecord(slug, "notes", id, ann.id)).status, 200);
  assert.equal(records(await listRecords(slug, "notes", "", ann.id)).length, 0);
});

test("the published page carries an owner key only for the signed-in owner", async () => {
  const slug = await publish(flashData({ menu: "read" }) + "<p>Menu</p>", "Page");
  const page = (cookie?: string) =>
    serveSite(slug, `https://x/p/${slug}`, new Request(`https://x/p/${slug}`, cookie ? { headers: { cookie } } : {})).then((r) => r.text());
  const keyIn = (html: string) => html.match(/const ownerKey = "([^"]*)"/)?.[1];

  assert.equal(keyIn(await page()), "", "nobody signed in");
  assert.equal(keyIn(await (await serveSite(slug)).text()), "", "no request at all");
  const mine = cookieToken(await createSession("owner", true));
  const theirs = cookieToken(await createSession("other", true));
  const ownerPage = await page(`flash_session=${mine}`);
  const key = keyIn(ownerPage)!;
  assert.match(key, /^o_/);
  assert.equal(await isOwnerKey(slug, key), true);
  assert.match(ownerPage, /Owner view: you can change this app's data here/);
  assert.equal(keyIn(await page(`flash_session=${theirs}`)), "", "another Flash user gets none");
  assert.equal(keyIn(await page(`flash_session=nonsense`)), "");
  // An app's own sign-in cookie is something else entirely.
  assert.equal(keyIn(await page(`${SITE_COOKIE}=${mine}`)), "");
  // The owner's Data view isn't reachable from an app's own domain.
  assert.deepEqual(routeHost("mybakery.com", `/api/sites/${slug}/records`, "GET"), { redirect: "/" });
  assert.deepEqual(routeHost("mybakery.com", `/api/sites/${slug}/records`, "PATCH"), { notFound: true });
});

test("the published flashDB sends the right key and says who is looking", async () => {
  type Sent = { url: string; headers: Record<string, string> };
  const run = (ownerKey: string | null, visitor: { user: { id: string; email: string; name: string }; token: string } | null, status = 200) => {
    const sent: Sent[] = [];
    const fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
      sent.push({ url, headers: init?.headers ?? {} });
      return { ok: status < 400, status, json: async () => (status < 400 ? { records: [{ id: "a" }], more: false } : { error: "Only this app's owner can change this." }) };
    };
    const element = () => ({ style: {}, setAttribute() {}, remove() {} });
    const script = { removed: false, remove() { script.removed = true; } };
    const document = { readyState: "complete", createElement: element, body: { appendChild() {} }, currentScript: script };
    const window: { flashDB?: { isOwner: boolean; list(c: string): Promise<unknown[]>; remove(c: string, id: string): Promise<void> } } = {};
    const owner = ownerKey ? { key: ownerKey, note: "Owner view", ended: "Your owner view has ended. Reload the page." } : null;
    const code = flashDbShim("/api/sites/x/data", "/in", "/shop", false, "/auth", "/mine", visitor, "/ai", "/files", owner).replace(/^<script>|<\/script>$/g, "");
    vm.runInNewContext(code, { window, fetch, document, setTimeout: () => 0, URLSearchParams });
    return { db: window.flashDB!, sent, script };
  };
  const visitor = { user: { id: "u1", email: "ann@example.com", name: "Ann" }, token: "page-key" };

  const asOwner = run("o_owner", visitor);
  assert.equal(asOwner.db.isOwner, true);
  await asOwner.db.list("menu");
  assert.equal(asOwner.sent[0].headers.Authorization, "Bearer o_owner", "the owner's key wins on shared data");
  assert.equal(asOwner.script.removed, true, "the script holding the key leaves the page");

  const asVisitor = run(null, visitor);
  assert.equal(asVisitor.db.isOwner, false);
  await asVisitor.db.list("menu");
  assert.equal(asVisitor.sent[0].headers.Authorization, "Bearer page-key");
  assert.equal(asVisitor.script.removed, false, "other pages are left as they were");

  const anon = run(null, null);
  assert.equal(anon.db.isOwner, false);
  await anon.db.list("menu");
  assert.equal(anon.sent[0].headers.Authorization, undefined, "no key, no header (and no preflight)");
  assert.equal(anon.sent[0].headers["Content-Type"], undefined);

  // When the owner's key has ended, the owner is told to reload.
  await assert.rejects(run("o_old", null, 403).db.remove("menu", "a"), /Reload the page/);
  await assert.rejects(run(null, null, 403).db.remove("menu", "a"), /Only this app's owner can change this/);

  // Flash's preview, and a downloaded app, treat the person trying it as its owner.
  const memory: { flashDB?: { isOwner: boolean; add(c: string, d: object): Promise<{ byYou?: boolean }> } } = {};
  vm.runInNewContext(`(function(){${MEMORY_DB}})()`, { window: memory });
  assert.equal(memory.flashDB!.isOwner, true);
  assert.equal((await memory.flashDB!.add("menu", { dish: "Soup" })).byYou, true);
});

test("a name with </script> in it can't end the page's script", () => {
  const name = `</script><script>alert(1)</script><!--`;
  const page = flashDbShim("/api/sites/x/data", "/in", "/shop", false, "/auth", "/mine", { user: { id: "u1", email: "a@b.co", name }, token: "k" });
  assert.equal(page.indexOf("</script>"), page.length - "</script>".length, "only the shim's own closing tag");
  assert.ok(!page.includes("<!--"));
  const window: { flashAuth?: { user: { name: string } } } = {};
  vm.runInNewContext(page.replace(/^<script>|<\/script>$/g, ""), { window, URLSearchParams, fetch: () => {} });
  assert.equal(window.flashAuth!.user.name, name, "the name still reads the same");
});

test("unpublishing takes everything the app kept, even where the database doesn't cascade", async () => {
  // Turso runs with foreign keys off, so nothing may rely on ON DELETE CASCADE.
  await run("PRAGMA foreign_keys = OFF");
  try {
    // As there, deleting only the site would leave its data behind.
    await legacySite("leaky", "<p>");
    await run("INSERT INTO site_records (id, site_slug, collection, data, created_at, updated_at) VALUES ('leak', 'leaky', 'menu', '{}', 0, 0)");
    await run("DELETE FROM sites WHERE slug = 'leaky'");
    assert.ok(await one("SELECT 1 FROM site_records WHERE id = 'leak'"));
    assert.equal((await listRecords("leaky", "menu", "", "", OWNER)).status, 404, "and nobody can reach it");

    const slug = "gone-app";
    await legacySite(slug, flashData({ menu: "read" }));
    const ann = await member(slug, "ann@example.com", "8.8.8.8");
    await addRecord(slug, "menu", { dish: "Soup" }, "", OWNER);
    await addRecord(slug, "notes", { text: "mine" }, ann.id);
    await chooseRule(slug, "menu", "add");
    await newOwnerKey(slug, "owner", cookieToken(await createSession("owner", true)));
    await setUploadsOn(slug, true);
    const upload = await saveUpload(slug, { name: "a.txt", type: "text/plain", bytes: Buffer.from("hello") }, "");
    const fileId = (upload.body as { url: string }).url.split("/").pop()!;
    assert.ok(await readUpload(slug, fileId));
    await run("INSERT INTO site_messages (id, site_slug, form, data, created_at) VALUES ('m1', ?, 'contact', '{}', 0)", [slug]);
    await run("INSERT INTO site_ai (site_slug, enabled, daily_credits, updated_at) VALUES (?, 1, 100, 0)", [slug]);
    await run("INSERT INTO site_products (id, site_slug, name, price, currency, created_at) VALUES ('p1', ?, 'Soup', 800, 'cad', 0)", [slug]);
    await run("INSERT INTO site_versions (id, site_slug, title, html, created_at) VALUES ('v1', ?, 'Gone', '<p>', 0)", [slug]);
    await run("INSERT INTO site_visits (site_slug, day, source, views) VALUES (?, '2026-10-01', '', 3)", [slug]);

    assert.equal(await unpublishSite("other", slug), false, "only the owner can");
    assert.equal(await slugTaken(slug), true);
    assert.equal(await unpublishSite("owner", slug), true);
    const tables = [
      "site_records",
      "site_users",
      "site_sessions",
      "site_page_tokens",
      "site_ai",
      "site_uploads",
      "site_messages",
      "site_versions",
      "site_visits",
      "site_products",
      "site_owner_keys",
      "site_collection_rules",
    ];
    for (const table of tables) {
      const left = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE site_slug = ?`, [slug]);
      assert.equal(Number(left?.n), 0, table);
    }
    assert.equal(await slugTaken(slug), false, "the name is free again, with nothing left to inherit");

    // A file left behind by an app unpublished before this fix is no longer served, and its name isn't reused.
    await run("INSERT INTO site_uploads (id, site_slug, owner, mime, name, data, size, created_at) VALUES ('f1', 'old-app', '', 'text/plain', 'a.txt', x'00', 1, 0)");
    assert.equal(await readUpload("old-app", "f1"), null);
    assert.equal(await slugTaken("old-app"), true);
    await run("INSERT INTO site_records (id, site_slug, collection, data, created_at, updated_at) VALUES ('r1', 'old-app-2', 'menu', '{}', 0, 0)");
    assert.equal(await slugTaken("old-app-2"), true);
    assert.equal(await slugTaken("never-used"), false);
  } finally {
    await run("PRAGMA foreign_keys = ON");
  }
});
