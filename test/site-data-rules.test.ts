import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

process.env.DATABASE_URL = ":memory:";

const { run, one, all } = await import("../src/lib/server/db.ts");
const { sha256 } = await import("../src/lib/server/ids.ts");
const { createSession } = await import("../src/lib/server/auth.ts");
const { siteAuth, visitorForSession, newPageToken, SITE_COOKIE } = await import("../src/lib/server/site-auth.ts");
const {
  listRecords,
  addRecord,
  patchRecord,
  removeRecord,
  collectionRule,
  chooseRule,
  sharedCollections,
  newestShared,
  sharedCsv,
  refreshRules,
  keepRules,
} = await import("../src/lib/server/site-data.ts");
const { newOwnerCode, ownerKeyForCode, isOwnerKey, callerFor } = await import("../src/lib/server/site-owner.ts");
const { publishSite, restoreVersion, listVersions, versionHtml, unpublishSite, slugTaken, SITE_TABLES } = await import("../src/lib/server/sites.ts");
const { readUpload } = await import("../src/lib/server/site-files.ts");
const { serveSite } = await import("../src/lib/server/serve-site.ts");
const { flashDbShim, injectHead, MEMORY_DB } = await import("../src/lib/flashdb-shim.ts");
const { ANYONE, OWNER, OWNER_IN_APP, computeRules, dataLine } = await import("../src/lib/data-rules.ts");
const { routeHost } = await import("../src/lib/site-host.ts");
type Caller = import("../src/lib/data-rules.ts").Caller;

const owner = { id: "owner", email: "o@x.io", name: "", verified_at: 1 } as never;
await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('owner', 'o@x.io', '', 0, 1), ('other', 'x@x.io', '', 0, 1)");

const flashData = (rules: object) => `<script type="application/json" id="flash-data">${JSON.stringify(rules)}</script>`;
/** Publishes an app as the owner and returns its slug. The tests publish more than an hour's worth. */
async function publish(html: string, title = "App", slug?: string): Promise<string> {
  await run("DELETE FROM rate_limits");
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
/** Opens an app as its owner, as Open as owner in Flash does: a one-time code, traded for a key. */
async function ownerKey(slug: string, session: string): Promise<string> {
  const code = (await newOwnerCode(slug, "owner", session))!;
  return (await ownerKeyForCode(slug, code))!.key;
}

test("the wipe from the audit is refused", async () => {
  const html = `<script>flashDB.list("reviews").then(show); form.onsubmit = () => flashDB.add("reviews", { text: input.value });</script>`;
  const slug = await publish(html, "Reviews");
  const saved = await one<{ data_rules: string }>("SELECT data_rules FROM sites WHERE slug = ?", [slug]);
  assert.deepEqual(JSON.parse(saved!.data_rules), { v: 1, guess: "add", app: {}, code: ["reviews"] }, "the rules are saved with the page");

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
  // The app's own authorId is just the app's data: Flash keeps who added it in a column of its own.
  assert.equal(record(added).authorId, "bob");
  const id = record(added).id as string;
  const stored = await one<{ data: string; author: string }>("SELECT data, author FROM site_records WHERE id = ?", [id]);
  assert.deepEqual(JSON.parse(stored!.data), { text: "Ann's post", authorId: "bob" });
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

test("an app made before rules keeps its own authorId, in shared and in each person's own records", async () => {
  // Like the boards Flash built before: Edit and Delete show where p.authorId is the person's id.
  await legacySite("board-old", `<script>flashDB.add("posts", { text, authorId: flashAuth.user.id }); flashDB.remove("posts", id); flashDB.mine.add("drafts", d)</script>`);
  await run("INSERT INTO site_records (id, site_slug, collection, data, created_at, updated_at) VALUES ('old1', 'board-old', 'posts', ?, 1, 1)", [
    JSON.stringify({ text: "from before", authorId: "u_ann" }),
  ]);
  const ann = await member("board-old", "ann@example.com", "9.9.9.1");
  assert.equal((await collectionRule("board-old", "posts"))?.rule, "open");
  assert.deepEqual(records(await listRecords("board-old", "posts", "", "", ANYONE)).map((r) => r.authorId), ["u_ann"], "what was there comes back");
  const added = await addRecord("board-old", "posts", { text: "new", authorId: "u_ann" }, "", ANYONE);
  assert.equal(record(added).authorId, "u_ann");
  const id = record(added).id as string;
  assert.equal(record(await patchRecord("board-old", "posts", id, { text: "edited" }, "", ANYONE)).authorId, "u_ann");
  assert.deepEqual(records(await listRecords("board-old", "posts", "", "", ann)).map((r) => [r.text, r.authorId]), [
    ["from before", "u_ann"],
    ["edited", "u_ann"],
  ]);
  assert.deepEqual((await newestShared("board-old", "posts")).map((r) => r.data.authorId), ["u_ann", "u_ann"], "and in the owner's Data view");
  const mine = await addRecord("board-old", "drafts", { text: "draft", authorId: ann.id }, ann.id);
  assert.equal(record(mine).authorId, ann.id);
  assert.equal(records(await listRecords("board-old", "drafts", "", ann.id))[0].authorId, ann.id);
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

test("Open as owner's code works once for one app, and its key ends with the Flash sign-in or after an hour", async () => {
  const slug = await publish(flashData({ menu: "read", signups: "private" }), "Keys");
  const otherSlug = await publish("<p>other</p>", "Other");
  const session = cookieToken(await createSession("owner", true));
  assert.equal(await newOwnerCode(slug, "other", session), null, "only the app's owner gets one");
  assert.equal(await newOwnerCode(slug, "owner", ""), null);
  const tried = (await newOwnerCode(slug, "owner", session))!;
  assert.equal(await ownerKeyForCode(otherSlug, tried), null, "not for another app");
  assert.equal(await ownerKeyForCode(slug, tried), null, "and trying it there used it up");

  const code = (await newOwnerCode(slug, "owner", session))!;
  const made = (await ownerKeyForCode(slug, code))!;
  assert.match(made.key, /^o_/);
  assert.equal(made.language, "");
  assert.equal(await ownerKeyForCode(slug, code), null, "a code works once");
  const both = await Promise.all([0, 1].map(async () => ownerKeyForCode(slug, (await newOwnerCode(slug, "owner", session))!)));
  assert.ok(both.every(Boolean), "each code makes its own key");
  const raced = (await newOwnerCode(slug, "owner", session))!;
  assert.deepEqual((await Promise.all([ownerKeyForCode(slug, raced), ownerKeyForCode(slug, raced)])).filter(Boolean).length, 1, "two pages racing for one code");

  const key = made.key;
  assert.equal(await isOwnerKey(slug, key), true);
  const caller = await callerFor(slug, `Bearer ${key}`);
  assert.deepEqual(caller, OWNER_IN_APP);
  assert.equal((await addRecord(slug, "menu", { dish: "Pie" }, "", caller)).status, 201);
  // In the app, the owner's key can add to a private collection like anyone, but never read it:
  // only Flash's Data view can, so a script that gets into the page can't leak the sign-ups.
  assert.equal((await addRecord(slug, "signups", { email: "a@b.co" }, "", caller)).status, 201);
  assert.deepEqual(await listRecords(slug, "signups", "", "", caller), {
    status: 403,
    body: { error: "You can see this in Flash, in My websites & apps › Data." },
  });
  const signup = records(await listRecords(slug, "signups", "", "", OWNER))[0].id as string;
  assert.equal((await removeRecord(slug, "signups", signup, "", caller)).status, 403);
  assert.equal((await patchRecord(slug, "signups", signup, { email: "x" }, "", caller)).status, 403);
  assert.equal(records(await listRecords(slug, "signups", "", "", OWNER)).length, 1);

  assert.equal(await isOwnerKey(otherSlug, key), false, "not for another app");
  assert.deepEqual(await callerFor(otherSlug, `Bearer ${key}`), ANYONE);
  assert.deepEqual(await callerFor(slug, key), ANYONE, "a bare key without Bearer is no key");
  assert.deepEqual(await callerFor(slug, null), ANYONE);
  const kept = await one<{ n: number }>(
    "SELECT (SELECT COUNT(*) FROM site_owner_keys WHERE token_hash = ?) + (SELECT COUNT(*) FROM site_owner_codes WHERE code_hash = ?) AS n",
    [key, code],
  );
  assert.equal(Number(kept?.n), 0, "only hashes are kept");

  // A code lasts two minutes.
  const late = (await newOwnerCode(slug, "owner", session))!;
  await run("UPDATE site_owner_codes SET expires_at = 1 WHERE code_hash = ?", [sha256(late)]);
  assert.equal(await ownerKeyForCode(slug, late), null);
  // Signing out of Flash ends the keys, and the codes not used yet.
  const pending = (await newOwnerCode(slug, "owner", session))!;
  await run("DELETE FROM sessions WHERE token_hash = ?", [sha256(session)]);
  assert.equal(await isOwnerKey(slug, key), false);
  assert.equal(await ownerKeyForCode(slug, pending), null);
  // So does an hour.
  const session2 = cookieToken(await createSession("owner", true));
  const key2 = await ownerKey(slug, session2);
  assert.equal(await isOwnerKey(slug, key2), true);
  const expires = await one<{ at: number }>("SELECT expires_at AS at FROM site_owner_keys WHERE token_hash = ?", [sha256(key2)]);
  assert.ok(Number(expires!.at) - Date.now() <= 3_600_000);
  await run("UPDATE site_owner_keys SET expires_at = 0 WHERE token_hash = ?", [sha256(key2)]);
  assert.equal(await isOwnerKey(slug, key2), false);
  // At most 20 live keys per app and owner.
  for (let i = 0; i < 25; i++) await ownerKey(slug, session2);
  const live = await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_owner_keys WHERE site_slug = ?", [slug]);
  assert.equal(Number(live?.n), 20);
  // If the app changes hands or goes, its codes and keys stop working.
  const key3 = await ownerKey(slug, session2);
  const code3 = (await newOwnerCode(slug, "owner", session2))!;
  await run("UPDATE sites SET user_id = 'other' WHERE slug = ?", [slug]);
  assert.equal(await isOwnerKey(slug, key3), false);
  assert.equal(await ownerKeyForCode(slug, code3), null);
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
  assert.ok(await restoreVersion("owner", slug, v2Id));
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

test("an app opens as its owner only from Open as owner in Flash, and only once", async () => {
  const slug = await publish(flashData({ menu: "read" }) + "<p>Menu</p>", "Page");
  const page = (query = "", headers: Record<string, string> = {}) =>
    serveSite(slug, `https://flash-app.dev/p/${slug}`, new Request(`https://flash-app.dev/p/${slug}${query}`, { headers: { host: "flash-app.dev", ...headers } })).then(
      (r) => r.text(),
    );
  const keyIn = (html: string) => html.match(/const ownerKey = "([^"]*)"/)?.[1];
  const session = cookieToken(await createSession("owner", true));
  const theirs = cookieToken(await createSession("other", true));

  assert.equal(keyIn(await page()), "", "nobody signed in");
  assert.equal(keyIn(await (await serveSite(slug)).text()), "", "no request at all");
  // The owner opening their app, even signed in to Flash, sees it as visitors do: a script or a
  // link that gets into the app can't act as them.
  assert.equal(keyIn(await page("", { cookie: `flash_session=${session}` })), "", "the owner's Flash sign-in alone");
  assert.equal(keyIn(await page("", { cookie: `flash_session=${theirs}` })), "");

  const code = (await newOwnerCode(slug, "owner", session))!;
  const ownerPage = await page(`?flash_owner=${code}`, { "sec-fetch-site": "same-origin" });
  const key = keyIn(ownerPage)!;
  assert.match(key, /^o_/);
  assert.equal(await isOwnerKey(slug, key), true);
  assert.match(ownerPage, /Owner view: you can change this app's data here until you reload or close this page/);
  // The same address again (a reload, a copied link) shows the app as visitors do, and says why.
  const again = await page(`?flash_owner=${code}`);
  assert.equal(keyIn(again), "");
  assert.match(again, /This owner link has been used already or is too old/);
  assert.equal(keyIn(await page(`?flash_owner=nonsense`)), "");

  // On Flash's own address the code only works when Flash's own page opened it, not from a link elsewhere.
  const code2 = (await newOwnerCode(slug, "owner", session))!;
  assert.equal(keyIn(await page(`?flash_owner=${code2}`, { "sec-fetch-site": "cross-site" })), "");
  assert.match(keyIn(await page(`?flash_owner=${code2}`, { "sec-fetch-site": "none" }))!, /^o_/);
  // The app's own domain is always another site to Flash, so there a code made for it works, once.
  await run("INSERT INTO site_domains (domain, site_slug, user_id, created_at) VALUES ('mybakery.com', ?, 'owner', 0)", [slug]);
  const at = (host: string, path: string, query: string, from = "cross-site") =>
    serveSite(slug, `https://${host}/`, new Request(`https://${host}${path}${query}`, { headers: { host, "sec-fetch-site": from } })).then((r) => r.text());
  const onDomain = (query: string) => at("mybakery.com", "/", query);
  const code3 = (await newOwnerCode(slug, "owner", session, "mybakery.com"))!;
  assert.match(keyIn(await onDomain(`?flash_owner=${code3}`))!, /^o_/);
  assert.equal(keyIn(await onDomain(`?flash_owner=${code3}`)), "");
  // A code works only at the address it was made for, and trying it anywhere else uses it up: one
  // sent to the domain can't be used on Flash's own address (as /d/ or /p/ there) or another domain,
  // and one made for Flash can't be used on the domain.
  for (const [where, tried] of [
    ["Flash's /d/ address", (query: string) => at("flash-app.dev", "/d/mybakery.com", query, "none")],
    ["Flash's /p/ address", (query: string) => page(query, { "sec-fetch-site": "none" })],
    ["another domain", (query: string) => at("mybakery.co", "/", query)],
  ] as const) {
    const forDomain = (await newOwnerCode(slug, "owner", session, "mybakery.com"))!;
    assert.equal(keyIn(await tried(`?flash_owner=${forDomain}`)), "", where);
    assert.equal(keyIn(await onDomain(`?flash_owner=${forDomain}`)), "", `${where}: used up`);
  }
  const forFlash = (await newOwnerCode(slug, "owner", session))!;
  assert.equal(keyIn(await onDomain(`?flash_owner=${forFlash}`)), "");
  assert.equal(keyIn(await page(`?flash_owner=${forFlash}`, { "sec-fetch-site": "none" })), "", "used up");
  // An app's own sign-in cookie is something else entirely.
  assert.equal(keyIn(await page("", { cookie: `${SITE_COOKIE}=${session}` })), "");
  // The owner's Data view, and Open as owner, aren't reachable from an app's own domain.
  assert.deepEqual(routeHost("mybakery.com", `/api/sites/${slug}/records`, "GET"), { redirect: "/" });
  assert.deepEqual(routeHost("mybakery.com", `/api/sites/${slug}/records`, "PATCH"), { notFound: true });
  assert.deepEqual(routeHost("mybakery.com", `/api/sites/${slug}/owner`, "POST"), { notFound: true });
});

test("the published flashDB sends the right key, only to Flash, and says who is looking", async () => {
  type Init = { method: string; headers: Record<string, string>; body?: unknown };
  type Sent = { url: string; init: Init };
  type Db = { isOwner: boolean; list(c: string): Promise<unknown[]>; remove(c: string, id: string): Promise<void>; send(f: string, d: object): Promise<boolean> };
  const run = (owner: { key: string; note: string; ended: string } | null, visitor: { user: { id: string; email: string; name: string }; token: string } | null, status = 200, refusal = {}) => {
    const sent: Sent[] = [];
    const fetch = async (url: string, init: Init) => {
      sent.push({ url, init });
      return {
        ok: status < 400,
        status,
        json: async () => (status < 400 ? { records: [{ id: "a" }], more: false } : { error: "Only this app's owner can change this.", ...refusal }),
      };
    };
    const notes: string[] = [];
    const element = () => ({ style: {}, textContent: "", setAttribute() {}, remove() {} });
    const script = { removed: false, remove() { script.removed = true; } };
    const document = { readyState: "complete", createElement: element, body: { appendChild: (n: { textContent: string }) => notes.push(n.textContent) }, currentScript: script };
    const location = { href: "https://flash.test/p/x?flash_owner=abc&keep=1" };
    const history = { replaceState: (_s: unknown, _t: string, url: string) => (location.href = url) };
    const window: { flashDB?: Db } = {};
    const code = flashDbShim("/api/sites/x/data", "/in", "/shop", false, "/auth", "/mine", visitor, "/ai", "/files", owner).replace(/^<script>|<\/script>$/g, "");
    vm.runInNewContext(code, { window, fetch, document, location, history, setTimeout: () => 0, URL, URLSearchParams });
    return { db: window.flashDB!, sent, script, notes, location };
  };
  const visitor = { user: { id: "u1", email: "ann@example.com", name: "Ann" }, token: "page-key" };
  const ownerView = { key: "o_owner", note: "Owner view", ended: "Your owner view has ended. Choose Open as owner again." };

  const asOwner = run(ownerView, visitor);
  assert.equal(asOwner.db.isOwner, true);
  assert.deepEqual(asOwner.notes, ["Owner view"]);
  await asOwner.db.list("menu");
  assert.equal(asOwner.sent[0].init.headers.Authorization, "Bearer o_owner", "the owner's key wins on shared data");
  assert.equal(asOwner.script.removed, true, "the script holding the key leaves the page");
  assert.equal(asOwner.location.href, "https://flash.test/p/x?keep=1", "the one-time code leaves the address");
  // Every address was made whole when the page started, so a <base> tag added later can't send the
  // key elsewhere, and the request's options have no prototype a script could watch them through.
  assert.equal(asOwner.sent[0].url, "https://flash.test/api/sites/x/data?collection=menu");
  assert.equal(Object.getPrototypeOf(asOwner.sent[0].init), null);
  assert.equal(Object.getPrototypeOf(asOwner.sent[0].init.headers), null);
  await asOwner.db.send("contact", { a: 1 });
  assert.equal(asOwner.sent[1].url, "https://flash.test/in");
  assert.equal(asOwner.sent[1].init.headers.Authorization, undefined, "forms carry no key");

  const asVisitor = run(null, visitor);
  assert.equal(asVisitor.db.isOwner, false);
  await asVisitor.db.list("menu");
  assert.equal(asVisitor.sent[0].init.headers.Authorization, "Bearer page-key");
  assert.equal(asVisitor.script.removed, false, "other pages are left as they were");
  assert.deepEqual(asVisitor.notes, []);

  const anon = run(null, null);
  assert.equal(anon.db.isOwner, false);
  await anon.db.list("menu");
  assert.equal(anon.sent[0].init.headers.Authorization, undefined, "no key, no header (and no preflight)");
  assert.equal(anon.sent[0].init.headers["Content-Type"], undefined);

  // A code that didn't work: the page says so, and is the visitors' page.
  const used = run({ key: "", note: "This owner link has been used already", ended: "" }, null);
  assert.equal(used.db.isOwner, false);
  assert.deepEqual(used.notes, ["This owner link has been used already"]);
  assert.equal(used.script.removed, false);

  // When the owner's key has ended, the owner is told how to start again; other refusals say what they say.
  await assert.rejects(run(ownerView, null, 403, { ownerEnded: true }).db.remove("menu", "a"), /Choose Open as owner again/);
  await assert.rejects(run(ownerView, null, 403).db.remove("menu", "a"), /Only this app's owner can change this/);
  await assert.rejects(run(null, null, 403, { ownerEnded: true }).db.remove("menu", "a"), /Only this app's owner can change this/);

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
  vm.runInNewContext(page.replace(/^<script>|<\/script>$/g, ""), { window, URLSearchParams, URL, location: { href: "https://x/p/x" }, fetch: () => {} });
  assert.equal(window.flashAuth!.user.name, name, "the name still reads the same");
});

test("unpublishing takes everything the app kept, from every table that keeps something for an app", async () => {
  // Turso runs with foreign keys off, so nothing may rely on ON DELETE CASCADE.
  await run("PRAGMA foreign_keys = OFF");
  try {
    // As there, deleting only the site would leave its data behind.
    await legacySite("leaky", "<p>");
    await run("INSERT INTO site_records (id, site_slug, collection, data, created_at, updated_at) VALUES ('leak', 'leaky', 'menu', '{}', 0, 0)");
    await run("DELETE FROM sites WHERE slug = 'leaky'");
    assert.ok(await one("SELECT 1 FROM site_records WHERE id = 'leak'"));
    assert.equal((await listRecords("leaky", "menu", "", "", OWNER)).status, 404, "and nobody can reach it");

    // Every table with a site_slug column, read from the database itself, so one added later without
    // being listed in SITE_TABLES fails here.
    const tables: string[] = [];
    for (const { name } of await all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")) {
      const columns = await all<{ name: string }>(`PRAGMA table_info(${name})`);
      if (columns.some((c) => c.name === "site_slug")) tables.push(name);
    }
    assert.deepEqual([...SITE_TABLES].sort(), tables, "unpublishing knows every table that keeps something for an app");
    /** A row for the app in a table, with something in each column that must have a value. */
    const seed = async (table: string, slug: string, n = 0) => {
      const columns = await all<{ name: string; type: string; notnull: number; dflt_value: unknown }>(`PRAGMA table_info(${table})`);
      const filled = columns.filter((c) => c.name === "site_slug" || (Number(c.notnull) && c.dflt_value === null));
      const value = (c: { name: string; type: string }) =>
        c.name === "site_slug" ? slug : /INT/i.test(c.type) ? n + 1 : /BLOB/i.test(c.type) ? Buffer.from("x") : `${table}-${slug}-${c.name}-${n}`;
      await run(`INSERT INTO ${table} (${filled.map((c) => c.name).join(", ")}) VALUES (${filled.map(() => "?").join(", ")})`, filled.map(value));
    };

    const slug = "gone-app";
    await legacySite(slug, flashData({ menu: "read" }));
    for (const table of tables) await seed(table, slug);
    const counts = async () => {
      const found: Record<string, number> = {};
      for (const table of tables) found[table] = Number((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE site_slug = ?`, [slug]))?.n);
      return found;
    };
    const before = await counts();
    for (const table of tables) assert.ok(before[table] > 0, table);

    assert.equal(await unpublishSite("other", slug), false, "only the owner can");
    assert.deepEqual(await counts(), before, "and someone else's try takes nothing at all");
    assert.equal(await slugTaken(slug), true);
    assert.equal(await unpublishSite("owner", slug), true);
    for (const [table, n] of Object.entries(await counts())) assert.equal(n, 0, table);
    assert.equal(await slugTaken(slug), false, "the name is free again, with nothing left to inherit");

    // What an app unpublished before this fix left behind keeps its name from being reused: its
    // records, members, files, orders, domains, visits and the AI it used.
    for (const table of ["site_records", "site_users", "site_uploads", "site_orders", "site_domains", "site_visits", "site_visitors", "site_ai_usage"]) {
      const old = `old-${table.replace(/_/g, "-")}`;
      assert.equal(await slugTaken(old), false, old);
      await seed(table, old);
      assert.equal(await slugTaken(old), true, old);
    }
    // A file left behind is no longer served.
    await run("INSERT INTO site_uploads (id, site_slug, owner, mime, name, data, size, created_at) VALUES ('f1', 'old-app', '', 'text/plain', 'a.txt', x'00', 1, 0)");
    assert.equal(await readUpload("old-app", "f1"), null);
    assert.equal(await slugTaken("never-used"), false);
  } finally {
    await run("PRAGMA foreign_keys = ON");
  }
});

test("rules worked out from an old page never replace the rules a publish just saved", async () => {
  const v1 = `<script>flashDB.update("todos", id, {})</script>`;
  const v2 = flashData({ todos: "read" });
  await legacySite("race", v1);
  // The refresh reads the old page, then the new page is published with its rules, then the refresh would save.
  const refreshing = refreshRules("race");
  const publishing = run("UPDATE sites SET html = ?, updated_at = 5, data_rules = ? WHERE slug = 'race'", [v2, JSON.stringify(computeRules(v2))]);
  await Promise.all([refreshing, publishing]);
  const saved = await one<{ data_rules: string }>("SELECT data_rules FROM sites WHERE slug = 'race'");
  assert.deepEqual(JSON.parse(saved!.data_rules), computeRules(v2));
  // The same, without relying on the order: rules from a page that was replaced since aren't kept.
  assert.equal(await keepRules("race", computeRules(v1), 0), false);
  assert.equal(await keepRules("race", computeRules(v2), 5), true);
});

test("an app whose block Flash can't read is read-only, and the owner is told why", async () => {
  const html = `<script type="application/json" id="flash-data">{"menu": "read" "reviews": "add"}</script><script>if (flashDB.isOwner) flashDB.remove("menu", id); flashDB.add("reviews", r)</script>`;
  await run("DELETE FROM rate_limits");
  const result = await publishSite(owner, { html, title: "Broken" });
  assert.ok("data" in result && result.data);
  assert.deepEqual(result.data.bad, { why: "json", names: [] });
  const slug = result.slug;
  assert.equal((await addRecord(slug, "reviews", { text: "hi" }, "", ANYONE)).status, 403, "fails closed");
  assert.equal((await addRecord(slug, "reviews", { text: "hi" }, "", OWNER)).status, 201);
  const data = (await sharedCollections(slug))!;
  assert.deepEqual([data.block, data.bad, data.guess], [true, { why: "json", names: [] }, "read"]);
  // The collections its code names show in the Data view before they hold anything.
  assert.deepEqual(
    data.collections.map((c) => [c.name, c.rule, c.source]),
    [
      ["reviews", "read", "block"],
      ["menu", "read", "block"],
    ],
  );
});

test("an update whose new block leaves out what visitors could change says so", async () => {
  const v1 = `<script>flashDB.add("tasks", t); flashDB.update("tasks", id, { done: true }); flashDB.add("room-" + room, m)</script>`;
  const slug = await publish(v1, "Tasks");
  await addRecord(slug, "room-7", { text: "hi" }, "", ANYONE);
  const v2 = flashData({ reviews: "add" }) + v1 + `<script>flashDB.add("reviews", r)</script>`;
  await run("DELETE FROM rate_limits");
  const second = await publishSite(owner, { html: v2, title: "Tasks", slug });
  assert.ok("data" in second && second.data);
  assert.deepEqual(second.data.closed, ["tasks", "room-7"]);
  assert.equal((await addRecord(slug, "room-7", { text: "x" }, "", ANYONE)).status, 403);
  // Giving "*" a rule keeps them open, and closes nothing.
  const v3 = flashData({ reviews: "add", "*": "open" }) + v1;
  const third = await publishSite(owner, { html: v3, title: "Tasks", slug });
  assert.ok("data" in third && third.data);
  assert.equal(third.data.closed, undefined);
  assert.equal((await addRecord(slug, "room-8", { text: "x" }, "", ANYONE)).status, 201);
  assert.deepEqual(await collectionRule(slug, "tasks"), { rule: "open", source: "block" });
});

test("an update that no longer names a private collection tells the owner visitors can see it now", async () => {
  const v1 = flashData({ signups: "private", menu: "read" }) + `<script>flashDB.add("signups", s); flashDB.list("menu")</script>`;
  const slug = await publish(v1, "Club");
  await addRecord(slug, "signups", { email: "a@b.c" }, "", ANYONE);
  await run("DELETE FROM rate_limits");
  // The new block leaves sign-ups out: visitors can read them, and publishing says so (and not that they were closed).
  const second = await publishSite(owner, { html: flashData({ menu: "read" }) + `<script>flashDB.list("menu")</script>`, title: "Club", slug });
  assert.ok("data" in second && second.data);
  assert.deepEqual(second.data.exposed, ["signups"]);
  assert.equal(second.data.closed, undefined);
  assert.match(dataLine(second.data), /^Visitors can now see signups, which only you could see before\./);
  // A page with no block at all says so too.
  await publishSite(owner, { html: v1, title: "Club", slug });
  const third = await publishSite(owner, { html: `<script>flashDB.list("signups")</script>`, title: "Club", slug });
  assert.ok("data" in third && third.data);
  assert.deepEqual(third.data.exposed, ["signups"]);
  // The owner's own choice in Flash is theirs: nothing to warn about.
  await publishSite(owner, { html: v1, title: "Club", slug });
  assert.equal(await chooseRule(slug, "signups", "read"), true);
  const fourth = await publishSite(owner, { html: flashData({ menu: "read" }), title: "Club", slug });
  assert.ok("data" in fourth && fourth.data);
  assert.equal(fourth.data.exposed, undefined);
});

test("an update that lets visitors see a private collection says so, whatever in the page did it", async () => {
  const code = `<script>flashDB.add("signups", s); flashDB.list("menu")</script>`;
  const v1 = flashData({ signups: "private", menu: "read" }) + code;
  const slug = await publish(v1, "Sign-ups");
  await addRecord(slug, "signups", { email: "a@b.c", phone: "555" }, "", ANYONE);
  const update = async (html: string) => {
    await run("DELETE FROM rate_limits");
    const result = await publishSite(owner, { html, title: "Sign-ups", slug });
    assert.ok("data" in result && result.data);
    return result.data;
  };
  // The block names it with another rule.
  for (const rule of ["add", "read", "open"]) {
    const data = await update(flashData({ signups: rule, menu: "read" }) + code);
    assert.deepEqual(data.exposed, ["signups"], rule);
    assert.equal((await listRecords(slug, "signups", "", "", ANYONE)).status, 200);
    await update(v1);
  }
  // The read-only line doesn't read as private.
  const read = await update(flashData({ signups: "read" }) + code);
  assert.match(dataLine(read), /^Visitors can now see signups, which only you could see before\. .*signups — visitors can see it, only you change it/);
  await update(v1);
  // The owner's default for anything else is "add", and the block no longer names it.
  assert.equal(await chooseRule(slug, "*", "add"), true);
  assert.deepEqual((await update(flashData({ menu: "read" }) + code)).exposed, ["signups"]);
  await update(v1);
  // The owner's default is "Only you can see it", and the block now names it as read-only.
  assert.equal(await chooseRule(slug, "*", "private"), true);
  await update(flashData({ menu: "read" }) + code);
  assert.deepEqual((await update(flashData({ menu: "read", signups: "read" }) + code)).exposed, ["signups"]);
  assert.equal(await chooseRule(slug, "*", null), true);
  // The block's own "*" kept it private, and the block now names it.
  await update(flashData({ "*": "private", menu: "read" }) + code);
  assert.equal((await listRecords(slug, "signups", "", "", ANYONE)).status, 403);
  assert.deepEqual((await update(flashData({ "*": "private", menu: "read", signups: "add" }) + code)).exposed, ["signups"]);
  // Only the owner's own choice for the collection in Flash goes unsaid.
  await update(v1);
  assert.equal(await chooseRule(slug, "signups", "add"), true);
  assert.equal((await update(flashData({ menu: "read" }) + code)).exposed, undefined);
  // Each owner has room for 20 apps, and the tests publish more.
  assert.equal(await unpublishSite("owner", slug), true);
});

test("an update whose block Flash can't use never shows visitors what only the owner could see", async () => {
  const code = `<script>if (flashDB.isOwner) flashDB.remove("menu", id); flashDB.add("signups", s); flashDB.list("menu")</script>`;
  const v1 = flashData({ signups: "private", menu: "read" }) + code;
  const slug = await publish(v1, "Club");
  await addRecord(slug, "signups", { email: "a@b.c", phone: "555" }, "", ANYONE);
  const block = (text: string, type = "application/json") => `<script type="${type}" id="flash-data">${text}</script>`;
  for (const [text, type] of [
    [`{"signups":"Private","menu":"read"}`, "application/json"],
    [`{"signups":"private","menu":"read"}`, "text/json"],
    [`{signups: "private", menu: "read"}`, "application/json"],
    [`{'signups':'private'}`, "application/json"],
    [`{"signups":{"rule":"private"},"menu":"read"}`, "application/json"],
    [`{"collections":{"signups":"private","menu":"read"}}`, "application/json"],
    [`{"rules":[{"collection":"signups","rule":"private"}]}`, "application/json"],
    [`{"menu":"read","pad":"${"x".repeat(4096)}"}`, "application/json"],
  ]) {
    await run("DELETE FROM rate_limits");
    const result = await publishSite(owner, { html: block(text, type) + code, title: "Club", slug });
    assert.ok("data" in result && result.data);
    assert.equal((await listRecords(slug, "signups", "", "", ANYONE)).status, 403, text);
    assert.equal((await collectionRule(slug, "signups"))?.rule, "private", text);
    assert.equal(result.data.exposed, undefined, text);
    // And the owner is told when Flash couldn't use the block, in words that say visitors can see its data.
    if (result.data.bad) assert.match(dataLine(result.data), /visitors can see/, text);
    // It stays so through another update Flash can't use either.
    await publishSite(owner, { html: block(text, type) + code + "<p>again</p>", title: "Club", slug });
    assert.equal((await listRecords(slug, "signups", "", "", ANYONE)).status, 403, `${text} again`);
    await publishSite(owner, { html: v1, title: "Club", slug });
  }
  // On a first publish nothing could be kept private yet, and visitors can't add sign-ups to see.
  const fresh = await publish(block(`{signups: "private"}`) + code, "New club");
  assert.deepEqual(await addRecord(fresh, "signups", { email: "x@y.z" }, "", ANYONE), { status: 403, body: { error: "Only this app's owner can change this." } });
  assert.equal(records(await listRecords(fresh, "signups", "", "", OWNER)).length, 0);
  // A text/json block works from the start.
  const typed = await publish(block(`{"signups":"private"}`, "text/json") + code, "Typed club");
  assert.equal((await addRecord(typed, "signups", { email: "x@y.z" }, "", ANYONE)).status, 201);
  assert.equal((await listRecords(typed, "signups", "", "", ANYONE)).status, 403);
  // Restoring an earlier version Flash can't use keeps it private too.
  let broken = "";
  await publishSite(owner, { html: block(`{oops`) + code, title: "Club", slug });
  await publishSite(owner, { html: v1, title: "Club", slug });
  for (const v of await listVersions(slug)) if ((await versionHtml(slug, v.id)) === block(`{oops`) + code) broken = v.id;
  assert.ok(broken);
  assert.ok(await restoreVersion("owner", slug, broken));
  assert.equal((await listRecords(slug, "signups", "", "", ANYONE)).status, 403);
  for (const app of [slug, fresh, typed]) assert.equal(await unpublishSite("owner", app), true);
});

test("bringing back an earlier version says when visitors can now see a collection that was private", async () => {
  const code = `<script>if (flashDB.isOwner) flashDB.remove("menu", id); flashDB.add("signups", s)</script>`;
  const v1 = code + "<p>v1</p>";
  const slug = await publish(v1, "Club");
  await publish(flashData({ signups: "private", menu: "read" }) + code, "Club", slug);
  await addRecord(slug, "signups", { email: "a@b.c", phone: "555" }, "", ANYONE);
  assert.equal((await listRecords(slug, "signups", "", "", ANYONE)).status, 403);
  let first = "";
  for (const v of await listVersions(slug)) if ((await versionHtml(slug, v.id)) === v1) first = v.id;
  const restored = await restoreVersion("owner", slug, first);
  assert.ok(restored?.data);
  assert.deepEqual(restored.data.exposed, ["signups"]);
  assert.match(dataLine(restored.data), /^Visitors can now see signups, which only you could see before\./);
  // Bringing back the version that kept it private says nothing of the kind.
  const again = await restoreVersion("owner", slug, (await listVersions(slug))[0].id);
  assert.ok(again?.data);
  assert.equal(again.data.exposed, undefined);
  assert.equal((await listRecords(slug, "signups", "", "", ANYONE)).status, 403);
  assert.equal(await restoreVersion("owner", slug, "gone"), null);
  assert.equal(await unpublishSite("owner", slug), true);
});

test("while the block can't be used, the owner's default 'Only you can see it' hides nothing visitors could see", async () => {
  const code = `<script>if (flashDB.isOwner) flashDB.remove("menu", id); flashDB.list("menu"); flashDB.add("reviews", r); flashDB.add("orders", o)</script>`;
  const v1 = flashData({ menu: "read", reviews: "add", orders: "private" }) + code;
  const slug = await publish(v1, "Cafe");
  await addRecord(slug, "menu", { dish: "Soup" }, "", OWNER);
  await addRecord(slug, "reviews", { text: "Lovely" }, "", ANYONE);
  await addRecord(slug, "orders", { email: "a@b.c" }, "", ANYONE);
  assert.equal(await chooseRule(slug, "*", "private"), true);
  const update = async (html: string) => {
    await run("DELETE FROM rate_limits");
    const result = await publishSite(owner, { html, title: "Cafe", slug });
    assert.ok("data" in result && result.data);
    return result.data;
  };
  const status = async (collection: string) => (await listRecords(slug, collection, "", "", ANYONE)).status;
  for (const block of [
    `<script type="application/json" id="flash-data">{'menu':'read','reviews':'add','orders':'private'}</script>`,
    flashData({ menu: "read", reviews: "Add!", orders: "private" }),
  ]) {
    const data = await update(block + code);
    assert.deepEqual([await status("menu"), await status("reviews"), await status("orders")], [200, 200, 403], block);
    assert.equal((await addRecord(slug, "reviews", { text: "x" }, "", ANYONE)).status, 403, "read-only until it's fixed");
    assert.equal(data.exposed, undefined, block);
    // What the owner is told matches what visitors get.
    const line = dataLine(data);
    assert.match(line, /visitors can still see/, block);
    assert.match(line, /menu — visitors can see it, only you change it · reviews — visitors can see it, only you change it · orders — only you can see it/, block);
    // Fixing the block brings back what it was, and nothing reads as newly shown.
    const fixed = await update(v1);
    assert.equal(fixed.exposed, undefined, block);
    assert.deepEqual([await status("menu"), await status("reviews"), await status("orders")], [200, 200, 403]);
  }
  // A collection only the owner's default kept from visitors stays private through a broken block,
  // even when the owner drops the default afterwards.
  await update(flashData({ menu: "read", orders: "privat" }) + code);
  assert.equal(await status("orders"), 403);
  await update(`<script type="application/json" id="flash-data">{oops</script>` + code);
  assert.equal(await status("orders"), 403);
  assert.equal(await chooseRule(slug, "*", null), true);
  assert.equal(await status("orders"), 403);
  assert.equal(await unpublishSite("owner", slug), true);
});

test("publishing a 2 MB page stays quick", async () => {
  const html = `<script type="module" id="flash-data">`.repeat(Math.floor((2 * 1024 * 1024 - 100) / 38));
  const started = Date.now();
  const slug = await publish(html, "Big");
  await publish(html + "<p>v2</p>", "Big", slug);
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
  assert.equal(await unpublishSite("owner", slug), true);
});

test("an app made before rules whose code Flash can't see keeps working while it has records", async () => {
  // Its code comes from a script elsewhere, so its page never says flashDB.
  const html = `<script src="https://cdn.jsdelivr.net/gh/me/guestbook@1/app.js"></script>`;
  await legacySite("cdn-book", html);
  await run("INSERT INTO site_records (id, site_slug, collection, data, created_at, updated_at) VALUES ('g1', 'cdn-book', 'entries', '{}', 1, 1)");
  assert.equal((await addRecord("cdn-book", "entries", { text: "hi" }, "", ANYONE)).status, 201);
  assert.equal((await collectionRule("cdn-book", "entries"))?.rule, "open");
  // Updating it with the same kind of page keeps it so; one with flashDB code of its own is read again.
  await publish(html + "<p>v2</p>", "Book", "cdn-book");
  assert.equal((await collectionRule("cdn-book", "entries"))?.rule, "open");
  await publish(`<script>flashDB.add("entries", e)</script>`, "Book", "cdn-book");
  assert.equal((await collectionRule("cdn-book", "entries"))?.rule, "add");
  // An old page that never used its data, and has none, stays read-only.
  await legacySite("cdn-plain", html);
  assert.equal((await addRecord("cdn-plain", "entries", { text: "hi" }, "", ANYONE)).status, 403);
  // Restored to an earlier version before its data was ever used, it's still kept open.
  await legacySite("cdn-later", html);
  await run("INSERT INTO site_records (id, site_slug, collection, data, created_at, updated_at) VALUES ('g2', 'cdn-later', 'entries', '{}', 1, 1)");
  await run("INSERT INTO site_versions (id, site_slug, title, html, created_at) VALUES ('cv1', 'cdn-later', 'Book', ?, 1)", [html + "<p>v0</p>"]);
  assert.ok(await restoreVersion("owner", "cdn-later", "cv1"));
  assert.equal(JSON.parse((await one<{ data_rules: string }>("SELECT data_rules FROM sites WHERE slug = 'cdn-later'"))!.data_rules).guess, "open");
});

test("the CSV keeps numbers as numbers", async () => {
  const slug = await publish(flashData({ places: "read" }), "Map");
  await addRecord(slug, "places", { lng: -73.98, score: -3, note: "-5", label: "=SUM(A1)" }, "", OWNER);
  const { csv } = await sharedCsv(slug, "places");
  const [header, row] = csv.slice(1).split("\r\n");
  assert.equal(header, "Added,lng,score,note,label,id");
  assert.deepEqual(row.split(",").slice(1, 5), ["-73.98", "-3", "'-5", "'=SUM(A1)"], "text that looks like a formula still can't run");
});

test("the shim goes into the head, or right after the doctype when there's no head", () => {
  const shim = "<script>x</script>";
  assert.equal(injectHead("<!doctype html><html><head><title>A</title>", shim), `<!doctype html><html><head>${shim}<title>A</title>`);
  // A page with no <head> but a <header> stays in standards mode.
  assert.equal(injectHead("<!doctype html><html lang=en><body><header>Hi</header>", shim), `<!doctype html>${shim}<html lang=en><body><header>Hi</header>`);
  assert.equal(injectHead("\uFEFF <!-- made by Flash --> <!DOCTYPE html><body>", shim), `\uFEFF <!-- made by Flash --> <!DOCTYPE html>${shim}<body>`);
  assert.equal(injectHead("<p>Hi</p>", shim), `${shim}<p>Hi</p>`, "no doctype at all");
  assert.equal(injectHead("<!-- never closed <!doctype html>", shim), `${shim}<!-- never closed <!doctype html>`);
  // A page made to be slow to read is read as quickly as any other.
  const started = Date.now();
  injectHead("<!-- a -->".repeat(200_000) + "<p>", shim);
  injectHead("<!--".repeat(500_000), shim);
  assert.ok(Date.now() - started < 1000);
});
