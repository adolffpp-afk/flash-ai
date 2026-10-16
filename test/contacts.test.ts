import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { register } from "node:module";
import vm from "node:vm";
import { readFileSync } from "node:fs";

/*
 * Each app's contact list: forms, sign-ups and paid orders fill one list per app, matched by email
 * without regard to case; the owner moves people through stages, and downloads, exports or deletes
 * them; people agree to news only by ticking a box themselves, and unsubscribe without signing in.
 */
register("./support/route-hooks.mjs", import.meta.url);
process.env.DATABASE_URL = ":memory:";
process.env.STRIPE_SECRET_KEY = "rk_test";
process.env.FLASH_ADMIN_EMAILS = "admin@x.co";
process.env.FLASH_APP_URL = "https://www.flash-app.dev";

const { run, one, all } = await import("../src/lib/server/db.ts");
const { contactFromFields, normalPhone, pageHas, pageWords, stagesOf, cleanTags, DEFAULT_STAGES } = await import("../src/lib/contacts.ts");
const contacts = await import("../src/lib/server/contacts.ts");
const { receiveMessage, sitesWithMessages } = await import("../src/lib/server/inbox.ts");
const { siteAuth } = await import("../src/lib/server/site-auth.ts");
const { finishCheckout } = await import("../src/lib/server/shop.ts");
const { unpublishSite } = await import("../src/lib/server/sites.ts");
const { translatorIn } = await import("../src/lib/server/i18n.ts");
const { translate } = await import("../src/lib/i18n.ts");
const { flashDbShim, MEMORY_DB } = await import("../src/lib/flashdb-shim.ts");
const route = await import("../src/app/api/sites/[slug]/contacts/route.ts");
const unsubRoute = await import("../src/app/api/u/[token]/route.ts");

const ORIGIN = "http://localhost";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const NEWS = "Email me news and offers from Golden Crumb. I can unsubscribe at any time.";
const PAGE = `<!doctype html><html><head><title>Golden Crumb</title></head><body>
  <form><input name="email"><label><input type="checkbox" id="news">  Email me news
     and offers from <a href="/">Golden Crumb</a>. I can unsubscribe at any&nbsp;time.</label></form>
  <label><input type="checkbox"> I&rsquo;d like the monthly letter</label></body></html>`;

/** A confirmed Flash user with a session cookie. */
async function user(id: string, email = `${id}@example.com`) {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES (?, ?, 'x', 0, 1)", [id, email]);
  await run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [sha(`tok_${id}`), id, Date.now() + 3600_000]);
  return { id, cookie: `flash_session=tok_${id}` };
}
type Who = Awaited<ReturnType<typeof user>>;
const site = (slug: string, owner: string, html = PAGE, title = "Golden Crumb") =>
  run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)", [slug, owner, title, html]);
const fresh = () => run("DELETE FROM rate_limits");
const contactsOf = (slug: string) => all<Record<string, string | number>>("SELECT * FROM site_contacts WHERE site_slug = ? ORDER BY first_seen", [slug]);
const send = (slug: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}, ip = "203.0.113.9", form = "contact") =>
  receiveMessage(slug, { form, data, ...extra }, ip, ORIGIN);

/** A route call as the browser makes it, signed in as `who` (or no one). */
function call(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", who: Who | null, slug: string, query = "", body?: unknown) {
  const handler = route[method] as (r: Request, c: unknown) => Promise<Response>;
  return handler(
    new Request(`${ORIGIN}/api/sites/${slug}/contacts${query}`, {
      method,
      headers: { "content-type": "application/json", ...(who && { cookie: who.cookie }) },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) },
  );
}
const unsub = (token: string, body = "", ip = "198.51.100.1") =>
  unsubRoute.POST(
    new Request(`${ORIGIN}/api/u/${token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
      body,
    }),
    { params: Promise.resolve({ token }) } as never,
  );

/** Flash in French, from its table (Node can't load the tables as the server does). */
const frTable = JSON.parse(readFileSync(new URL("../src/lib/i18n/fr.json", import.meta.url), "utf8"));
const french = Object.assign((text: string, blanks?: Record<string, string | number>) => translate(frTable, text, blanks), { language: "fr", locale: "fr-FR" });

const owner = await user("owner");
const stranger = await user("stranger");
const admin = await user("admin", "admin@x.co");

test("the sender of a form is found from its fields", () => {
  assert.deepEqual(contactFromFields({ name: "Ana", userEmail: " Ana@Example.COM ", message: "hi" }), { email: "ana@example.com", phone: "", name: "Ana" });
  assert.equal(contactFromFields({ "E-MAIL": "a@b.co" })?.email, "a@b.co", "E-mail in capitals");
  assert.equal(contactFromFields({ correo: "a@b.co" })?.email, "a@b.co");
  assert.equal(contactFromFields({ courriel: "a@b.co" })?.email, "a@b.co");
  assert.equal(contactFromFields({ reply_to: "only@value.co", note: "x" })?.email, "only@value.co", "a value that is an email address");
  assert.equal(contactFromFields({ email: "not an email", other: "z@z.co" })?.email, "z@z.co");
  assert.equal(contactFromFields({ email: `${"a".repeat(200)}@x.co` }), null, "too long to be an email");
  assert.equal(contactFromFields({ Phone: "+1 (555) 010-0000" })?.phone, "+15550100000");
  assert.equal(contactFromFields({ telefono: "00 44 20 7946 0958" })?.phone, "+442079460958");
  assert.equal(contactFromFields({ mobileNumber: "555-0100-22" })?.phone, "555010022");
  assert.equal(contactFromFields({ téléphone: "06 12 34 56 78" })?.phone, "0612345678");
  assert.equal(contactFromFields({ hotel: "+1 555 010 0000", email: "a@b.co" })?.phone, "", "hotel isn't a phone");
  assert.equal(contactFromFields({ telescope: "5550100000" }), null);
  assert.equal(contactFromFields({ phone: "call me after 5" }), null, "words aren't a number");
  assert.equal(contactFromFields({ firstName: "Ana", lastName: "Silva", email: "a@b.co" })?.name, "Ana Silva");
  assert.equal(contactFromFields({ prénom: "Léa", nom: "Roy", email: "a@b.co" })?.name, "Léa Roy");
  assert.equal(contactFromFields({ nombre: "Lucía", email: "a@b.co" })?.name, "Lucía");
  assert.equal(contactFromFields({ name: { first: "x" }, email: "a@b.co" })?.name, "", "only text counts");
  assert.equal(contactFromFields({ message: "Do you bake rye?" }), null);
  assert.equal(normalPhone("12345"), "");
  assert.equal(normalPhone("1234567890123456"), "", "more than 15 digits");
  assert.deepEqual(cleanTags([" VIP ", "vip", "", "Wholesale", 3, "x".repeat(40)]), ["VIP", "Wholesale", "x".repeat(30)]);
});

test("a form without an email or phone is still saved, with nobody added", async () => {
  await site("quiet", "owner");
  assert.deepEqual(await send("quiet", { message: "Lovely bread" }), { ok: true });
  assert.equal((await all("SELECT 1 FROM site_messages WHERE site_slug = 'quiet'")).length, 1);
  assert.deepEqual(await contactsOf("quiet"), []);
});

test("one person who sends a form, signs up and pays is one contact", async () => {
  await fresh();
  await site("crumb", "owner");
  await run("INSERT INTO seller_accounts (user_id, stripe_account, country, currency, ready, created_at) VALUES ('owner', 'acct_1', 'CA', 'cad', 1, 0)");
  const t0 = Date.now();
  await send("crumb", { name: "Ana", email: "Ana@Example.com", message: "Do you deliver?" });
  const [first] = await contactsOf("crumb");
  assert.equal(first.email, "ana@example.com");
  assert.equal(first.source, "form:contact");
  assert.equal(first.name, "Ana");
  const message = await one<{ contact_id: string }>("SELECT contact_id FROM site_messages WHERE site_slug = 'crumb'");
  assert.equal(message?.contact_id, first.id, "the message knows whose it is");

  // The owner's own stage, tags and notes stay whatever happens next.
  await run("UPDATE site_contacts SET stage = 'won', tags = '[\"VIP\"]', notes = 'Wants rye' WHERE id = ?", [first.id]);
  const joined = await siteAuth("crumb", "signup", { email: "ANA@example.COM", password: "longenough1", name: "Ana Silva" }, "1.2.3.4", "/p/crumb", true, null);
  assert.equal(joined.result, "ok");
  // Signing in again, and signing up again with the same email, add nothing.
  await siteAuth("crumb", "signin", { email: "ana@example.com", password: "longenough1" }, "1.2.3.4", "/p/crumb", true, null);
  await siteAuth("crumb", "signup", { email: "ana@example.com", password: "longenough1", name: "Someone" }, "1.2.3.4", "/p/crumb", true, null);

  // She pays; Stripe answers the checkout with an older date than the form, as an order synced late would.
  const paid = {
    id: "cs_test_ana",
    payment_status: "paid",
    amount_total: 2500,
    currency: "cad",
    created: Math.floor((t0 - 86_400_000) / 1000),
    metadata: { flash_site: "crumb", flash_item: "Chocolate cake" },
    customer_details: { email: "ana@EXAMPLE.com", name: "A. Silva", phone: "+1 555 010 0000" },
    line_items: { data: [{ quantity: 1 }] },
  };
  globalThis.fetch = (async () => Response.json(paid)) as typeof fetch;
  assert.equal((await finishCheckout("crumb", "cs_test_ana", null, ORIGIN)).paid, true);
  assert.equal((await finishCheckout("crumb", "cs_test_ana", null, ORIGIN)).paid, true, "a replayed checkout");

  const list = await contactsOf("crumb");
  assert.equal(list.length, 1, "one contact, whatever the case of the email");
  const [ana] = list;
  assert.equal(ana.source, "order:Chocolate cake", "where they came from is the earliest sighting");
  assert.equal(ana.first_seen, paid.created * 1000);
  assert.ok(Number(ana.last_seen) >= t0, "the latest sighting");
  assert.equal(ana.name, "Ana", "the first name given stays");
  assert.equal(ana.phone, "+15550100000", "a phone fills in once known");
  assert.deepEqual([ana.stage, ana.tags, ana.notes], ["won", '["VIP"]', "Wants rye"]);
  assert.equal(ana.consent_at, 0, "paying isn't agreeing to news");
  assert.equal((await all("SELECT 1 FROM site_orders WHERE site_slug = 'crumb'")).length, 1);
});

test("someone known only by phone is one contact, and becomes their email's contact", async () => {
  await fresh();
  await site("phones", "owner");
  await send("phones", { name: "Bo", phone: "+1 555 010 0001" }, {}, "10.0.0.1");
  await send("phones", { phone: "+1-555-010-0001", message: "again" }, {}, "10.0.0.2");
  let list = await contactsOf("phones");
  assert.equal(list.length, 1, "the same phone, the same contact");
  assert.equal(list[0].email, "");
  await send("phones", { email: "bo@example.com", phone: "+15550100001" }, {}, "10.0.0.3");
  list = await contactsOf("phones");
  assert.equal(list.length, 1, "no duplicate once they give an email");
  assert.equal(list[0].email, "bo@example.com");
  assert.equal(list[0].name, "Bo");
  const linked = await all<{ contact_id: string }>("SELECT contact_id FROM site_messages WHERE site_slug = 'phones'");
  assert.deepEqual([...new Set(linked.map((m) => m.contact_id))], [list[0].id], "every message is theirs");
  // A later form with just that phone number is the email contact's too.
  await send("phones", { phone: "+1 (555) 010-0001" }, {}, "10.0.0.4");
  await send("phones", { phone: "+15550100001", message: "phone only" }, {}, "10.0.0.5");
  assert.equal((await contactsOf("phones")).length, 1);
  assert.equal(await one("SELECT 1 FROM site_messages WHERE site_slug = 'phones' AND contact_id <> ?", [list[0].id]), null);
});

test("agreeing to news counts only with the page's own wording, and the latest choice wins", async () => {
  await fresh();
  await site("news", "owner");
  await site("news2", "owner");
  // The label's words, as the browser reads them, even with a link inside, an entity and other spacing.
  assert.ok(pageHas(PAGE, NEWS));
  assert.ok(pageHas(PAGE, "I’d like the monthly letter"));
  assert.ok(!pageHas(PAGE, "Email me news daily"), "words the page doesn't have");
  assert.ok(!pageHas(PAGE, "mail me news"), "whole words only");
  assert.equal(pageWords("<b>Hi</b>&#33; Ages <12 &amp; up"), "hi ages 12 up");
  await send("news", { email: "cy@example.com" }, { consent: { text: `  ${NEWS.replace(/ /g, "\n ")}  ` } }, "203.0.113.50");
  const [cy] = await contactsOf("news");
  assert.equal(cy.consent_text, NEWS);
  assert.equal(cy.consent_channel, "email");
  assert.equal(cy.consent_form, "contact");
  assert.ok(Number(cy.consent_at) > 0);
  assert.match(String(cy.consent_ip), /^[0-9a-f]{24}$/);
  assert.ok(!String(cy.consent_ip).includes("203"), "never the address");
  await send("news2", { email: "cy@example.com" }, { consent: { text: NEWS } }, "203.0.113.50");
  const [other] = await contactsOf("news2");
  assert.notEqual(other.consent_ip, cy.consent_ip, "each app hashes with its own key");

  // Wording the page doesn't have, no consent sent, or no email: nothing is kept.
  await send("news", { email: "dee@example.com" }, { consent: { text: "I agree to everything" } }, "203.0.113.51");
  await send("news", { email: "eve@example.com" }, {}, "203.0.113.52");
  await send("news", { phone: "+15550100002" }, { consent: { text: NEWS } }, "203.0.113.53");
  await send("news", { email: "fay@example.com" }, { consent: "yes" }, "203.0.113.54");
  for (const c of (await contactsOf("news")).slice(1)) assert.equal(c.consent_at, 0, String(c.email || c.phone));

  // They unsubscribe, agree again later, and unsubscribe again: the latest counts, and the time stays.
  const t = await translatorIn("en");
  const token = contacts.unsubToken(await contacts.siteSecret("news"), "news", String(cy.id));
  assert.equal(await contacts.unsubscribe(token), true);
  const firstOff = Number((await one<{ u: number }>("SELECT unsubscribed_at AS u FROM site_contacts WHERE id = ?", [cy.id]))?.u);
  assert.ok(firstOff > 0);
  const subscribed = async () => (await contacts.listContacts("news", t))!.contacts.find((c) => c.id === cy.id)!.subscribed;
  assert.equal(await subscribed(), false);
  await new Promise((r) => setTimeout(r, 5));
  await send("news", { email: "CY@example.com" }, { consent: { text: NEWS } }, "203.0.113.55");
  assert.equal(await subscribed(), true, "a newer agreement");
  assert.equal(Number((await one<{ u: number }>("SELECT unsubscribed_at AS u FROM site_contacts WHERE id = ?", [cy.id]))?.u), firstOff, "never zeroed");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await contacts.unsubscribe(token), true);
  assert.equal(await subscribed(), false, "a later unsubscribe");
  assert.ok(Number((await one<{ u: number }>("SELECT unsubscribed_at AS u FROM site_contacts WHERE id = ?", [cy.id]))?.u) > firstOff);
});

test("the list stops at 10,000 people, but the people on it still update", async () => {
  await fresh();
  await site("full", "owner");
  await run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
     INSERT INTO site_contacts (id, site_slug, email, first_seen, last_seen) SELECT 'c' || i, 'full', 'p' || i || '@x.co', 1, 1 FROM n`,
  );
  assert.deepEqual(await send("full", { email: "new@x.co", message: "hi" }), { ok: true }, "the message is still saved");
  assert.equal(await one("SELECT 1 FROM site_contacts WHERE site_slug = 'full' AND email = 'new@x.co'"), null);
  assert.equal((await all("SELECT 1 FROM site_messages WHERE site_slug = 'full'")).length, 1);
  await send("full", { email: "P7@x.co", name: "Seven" }, {}, "203.0.113.70");
  assert.equal((await one<{ name: string }>("SELECT name FROM site_contacts WHERE id = 'c7'"))?.name, "Seven");
  const joined = await siteAuth("full", "signup", { email: "member@x.co", password: "longenough1" }, "1.1.1.9", "/p/full", true, null);
  assert.equal(joined.result, "ok", "the sign-up still works");
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_contacts WHERE site_slug = 'full'"))?.n), 10_000);
  const res = await call("POST", owner, "full", "", { email: "another@x.co" });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /10,000 contacts/);
});

test("the people an app had before are copied in once, without duplicates", async () => {
  await fresh();
  await site("old", "owner");
  await run(
    `INSERT INTO site_users (id, site_slug, email, name, password_hash, created_at) VALUES
       ('m1', 'old', 'ann@x.co', 'Ann', 'h', 100), ('m2', 'old', 'bob@x.co', '', 'h', 200)`,
  );
  await run(
    `INSERT INTO site_orders (session_id, site_slug, item, quantity, amount, currency, email, name, address, created_at) VALUES
       ('cs_a', 'old', 'Pie', 1, 900, 'cad', 'Bob@X.co', 'Bob B', '', 50),
       ('cs_b', 'old', 'Cake', 1, 900, 'cad', 'cat@x.co', 'Cat', '', 300),
       ('cs_c', 'old', 'Cake', 1, 900, 'cad', 'CAT@x.co', '', '', 400),
       ('cs_d', 'old', 'Tart', 1, 900, 'cad', '', 'Nobody', '', 500)`,
  );
  await run(
    `INSERT INTO site_messages (id, site_slug, form, data, created_at) VALUES
       ('g1', 'old', 'contact', '{"email":"ANN@x.co","message":"hi"}', 10),
       ('g2', 'old', 'booking', '{"name":"Dan","phone":"+1 555 010 0003"}', 20),
       ('g3', 'old', 'contact', '{"message":"no one"}', 30),
       ('g4', 'old', 'contact', 'not json', 40)`,
  );
  assert.equal((await sitesWithMessages("owner")).find((s) => s.slug === "old")?.contacts, null, "not counted before the first look");
  const res = await call("GET", owner, "old");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 4);
  assert.equal(body.everything, true);
  const list = await contactsOf("old");
  assert.deepEqual(
    list.map((c) => [c.email || c.phone, c.source, c.first_seen, c.name]),
    [
      ["ann@x.co", "form:contact", 10, "Ann"],
      ["+15550100003", "form:booking", 20, "Dan"],
      ["bob@x.co", "order:Pie", 50, "Bob B"],
      ["cat@x.co", "order:Cake", 300, "Cat"],
    ],
  );
  assert.equal((list.find((c) => c.email === "cat@x.co") as { last_seen: number }).last_seen, 400);
  const linked = await all<{ id: string; contact_id: string }>("SELECT id, contact_id FROM site_messages WHERE site_slug = 'old' ORDER BY id");
  assert.deepEqual(
    linked.map((m) => [m.id, m.contact_id !== ""]),
    [["g1", true], ["g2", true], ["g3", false], ["g4", false]],
  );
  assert.equal((await one<{ f: number }>("SELECT contacts_filled AS f FROM sites WHERE slug = 'old'"))?.f, 1);
  assert.equal((await sitesWithMessages("owner")).find((s) => s.slug === "old")?.contacts, 4);
  // Again: nothing changes.
  const before = JSON.stringify(await contactsOf("old"));
  await run("UPDATE sites SET contacts_filled = 0 WHERE slug = 'old'");
  await contacts.fillContacts("old");
  assert.equal(JSON.stringify(await contactsOf("old")), before, "a second run changes nothing");
});

test("only the app's owner can see or change its contacts", async () => {
  await fresh();
  await site("mine", "owner");
  const ana = await contacts.addContact("mine", { email: "ana@x.co" });
  assert.ok("id" in ana);
  for (const [method, query, body] of [
    ["GET", "", undefined],
    ["GET", "?format=csv", undefined],
    ["POST", "", { email: "x@x.co" }],
    ["PATCH", "", { id: ana.id, notes: "x" }],
    ["PUT", "", { stages: [{ name: "One" }] }],
    ["DELETE", `?id=${ana.id}`, undefined],
  ] as const) {
    assert.equal((await call(method, null, "mine", query, body)).status, 401, `${method} signed out`);
    assert.equal((await call(method, stranger, "mine", query, body)).status, 404, `${method} someone else`);
    assert.equal((await call(method, admin, "mine", query, body)).status, 404, `${method} an admin who isn't the owner`);
  }
  assert.ok(await one("SELECT 1 FROM site_contacts WHERE id = ?", [ana.id]), "still there");
  assert.equal((await call("PATCH", owner, "mine", "", JSON.stringify({ id: ana.id, notes: "x".repeat(20_000) }))).status, 413);
  assert.equal((await call("POST", owner, "mine", "", "{not json")).status, 400);
  await run("INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?, 300, ?)", [`contacts-edit:${owner.id}`, Date.now() + 600_000]);
  const limited = await call("PATCH", owner, "mine", "", { id: ana.id, notes: "x" });
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /Too many changes/);
  await fresh();
  await run("INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?, 60, ?)", [`contacts-search:${owner.id}`, Date.now() + 60_000]);
  assert.equal((await call("GET", owner, "mine", "?q=ana")).status, 429);
  await fresh();
});

test("the owner adds, changes and finds people", async () => {
  await fresh();
  await site("edit", "owner");
  const add = async (body: unknown) => {
    const res = await call("POST", owner, "edit", "", body);
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await add({ name: "Nobody" })).status, 400);
  assert.match((await add({ email: "nope" })).body.error, /isn't an email address/);
  assert.match((await add({ phone: "call me" })).body.error, /isn't a phone number/);
  const gus = await add({ name: "Gus", email: "Gus@x.co", phone: "+1 555 010 0004" });
  assert.equal(gus.status, 200);
  const again = await add({ email: "gus@X.co" });
  assert.equal(again.body.id, gus.body.id, "someone already there opens as themselves");
  const byPhone = await add({ phone: "+15550100004" });
  assert.equal(byPhone.body.id, gus.body.id, "and by their phone number");
  const [row] = await contactsOf("edit");
  assert.equal(row.source, "owner");

  const patch = (body: unknown) => call("PATCH", owner, "edit", "", body);
  assert.equal((await patch({ id: gus.body.id, stage: "won", tags: ["VIP", " vip ", "Rye"], notes: "  Calls on Fridays " })).status, 200);
  assert.equal((await patch({ id: gus.body.id, stage: "nope" })).status, 400, "an unknown stage");
  assert.equal((await patch({ id: gus.body.id, notes: "x".repeat(1001) })).status, 400);
  assert.equal((await patch({ id: gus.body.id, tags: "VIP" })).status, 400);
  assert.equal((await patch({ id: "missing", notes: "x" })).status, 404);
  const detail = await (await call("GET", owner, "edit", `?id=${gus.body.id}`)).json();
  assert.equal(detail.contact.stage, "won");
  assert.deepEqual(detail.contact.tags, ["VIP", "Rye"]);
  assert.equal(detail.contact.notes, "Calls on Fridays");
  assert.match(detail.unsubscribeLink, /^https:\/\/www\.flash-app\.dev\/u\/[\w-]{16,24}\.[\w-]{22}$/);

  // More than fit at once: the server searches and counts.
  await run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
     INSERT INTO site_contacts (id, site_slug, email, name, stage, first_seen, last_seen)
     SELECT 'e' || i, 'edit', 'person' || i || '@x.co', 'Person ' || i, CASE WHEN i % 2 THEN 'contacted' ELSE '' END, i, i FROM n`,
  );
  const board = await (await call("GET", owner, "edit", "?mode=board")).json();
  assert.equal(board.everything, false);
  assert.equal(board.total, 601);
  assert.deepEqual(board.byStage, { new: 300, contacted: 300, won: 1, lost: 0 });
  assert.equal(board.contacts.filter((c: { stage: string }) => c.stage === "new").length, 100, "up to 100 per stage");
  const list = await (await call("GET", owner, "edit", "?mode=list")).json();
  assert.equal(list.contacts.length, 500);
  const found = await (await call("GET", owner, "edit", "?q=person5")).json();
  assert.equal(found.matched, 111, "person5, person50…59, person500…599");
  const tagged = await (await call("GET", owner, "edit", "?q=rye")).json();
  assert.deepEqual(tagged.contacts.map((c: { id: string }) => c.id), [gus.body.id]);
  const wild = await (await call("GET", owner, "edit", "?q=%25")).json();
  assert.equal(wild.matched, 0, "% is a character, not a wildcard");
  const phone = await (await call("GET", owner, "edit", "?q=555-010-0004")).json();
  assert.equal(phone.matched, 1);
});

test("stages can be renamed, added, reordered and removed", async () => {
  await fresh();
  await site("stages", "owner");
  const t = await translatorIn("en");
  const fr = french;
  await run(
    `INSERT INTO site_contacts (id, site_slug, email, stage, first_seen, last_seen) VALUES
       ('s1', 'stages', 'a@x.co', '', 1, 1), ('s2', 'stages', 'b@x.co', 'contacted', 1, 1), ('s3', 'stages', 'c@x.co', 'lost', 1, 1)`,
  );
  const put = async (stages: unknown) => {
    const res = await call("PUT", owner, "stages", "", { stages });
    return { status: res.status, body: await res.json() };
  };
  // Won renamed, a stage added, Contacted first, Lost removed.
  const saved = await put([{ id: "contacted", name: "Called" }, { id: "new", name: "New" }, { name: "Quoted" }, { id: "won", name: "Paid" }]);
  assert.equal(saved.status, 200);
  const ids = saved.body.stages.map((s: { id: string }) => s.id);
  assert.deepEqual(ids.slice(0, 2), ["contacted", "new"]);
  assert.match(ids[2], /^s[a-z0-9]{6}$/);
  const stored = JSON.parse((await one<{ s: string }>("SELECT contact_stages AS s FROM sites WHERE slug = 'stages'"))!.s);
  assert.equal(stored[1].name, "", "a standard name is kept as the standard, so it's translated");
  assert.equal(stagesOf(JSON.stringify(stored), fr)[1].name, fr("New"));
  assert.notEqual(fr("New"), "New");
  const stageOf = async (id: string) => (await one<{ stage: string }>("SELECT stage FROM site_contacts WHERE id = ?", [id]))?.stage;
  assert.equal(await stageOf("s1"), "new", "someone never moved stays in the stage that was first");
  assert.equal(await stageOf("s2"), "contacted");
  assert.equal(await stageOf("s3"), "", "a removed stage's people go to the first stage");
  const list = (await contacts.listContacts("stages", t))!;
  assert.deepEqual(list.byStage, { contacted: 2, new: 1, [ids[2]]: 0, won: 0 });
  assert.equal((await put([])).status, 400);
  assert.equal((await put(Array.from({ length: 13 }, (_, i) => ({ name: `S${i}` })))).status, 400);
  assert.match((await put(Array.from({ length: 13 }, (_, i) => ({ name: `S${i}` })))).body.error, /up to 12 stages/);
  assert.equal((await put([{ name: "  " }])).status, 400);
  assert.equal(DEFAULT_STAGES.length, 4);
});

test("deleting a contact takes their member account, messages and private data, and keeps orders without them", async () => {
  await fresh();
  await site("gone", "owner");
  await site("kept", "owner");
  await siteAuth("gone", "signup", { email: "hal@x.co", password: "longenough1", name: "Hal" }, "1.1.2.1", "/p/gone", true, null);
  await siteAuth("gone", "signup", { email: "ivy@x.co", password: "longenough1", name: "Ivy" }, "1.1.2.2", "/p/gone", true, null);
  const hal = (await one<{ id: string }>("SELECT id FROM site_users WHERE site_slug = 'gone' AND email = 'hal@x.co'"))!.id;
  await run("INSERT INTO site_page_tokens (token_hash, site_user_id, site_slug, expires_at) VALUES ('pt', ?, 'gone', ?)", [hal, Date.now() + 1e6]);
  await run("INSERT INTO site_records (id, site_slug, collection, data, created_at, updated_at, owner) VALUES ('r1', 'gone', 'notes', '{\"a\":1}', 1, 1, ?)", [hal]);
  await run("INSERT INTO site_uploads (id, site_slug, owner, mime, name, data, size, created_at) VALUES ('f1', 'gone', ?, 'text/plain', 'cv.txt', x'00', 1, 1)", [hal]);
  await send("gone", { email: "Hal@x.co", message: "mine" }, {}, "1.1.2.3");
  await send("gone", { email: "ivy@x.co", message: "hers" }, {}, "1.1.2.4");
  await send("kept", { email: "hal@x.co", message: "other app" }, {}, "1.1.2.5");
  await run(
    `INSERT INTO site_orders (session_id, site_slug, item, quantity, amount, currency, email, name, address, created_at) VALUES
       ('cs_h', 'gone', 'Cake', 1, 2500, 'cad', 'HAL@x.co', 'Hal', '1 Main St', 1), ('cs_i', 'gone', 'Pie', 1, 900, 'cad', 'ivy@x.co', 'Ivy', '', 1)`,
  );
  const id = (await one<{ id: string }>("SELECT id FROM site_contacts WHERE site_slug = 'gone' AND email = 'hal@x.co'"))!.id;
  const token = contacts.unsubToken(await contacts.siteSecret("gone"), "gone", id);
  assert.ok(await contacts.tokenContact(token));
  const res = await call("DELETE", owner, "gone", `?id=${id}`);
  assert.deepEqual(await res.json(), { ok: true });
  for (const [sql, what] of [
    ["SELECT 1 FROM site_users WHERE id = ?", "member"],
    ["SELECT 1 FROM site_sessions WHERE site_user_id = ?", "sign-ins"],
    ["SELECT 1 FROM site_page_tokens WHERE site_user_id = ?", "page keys"],
    ["SELECT 1 FROM site_records WHERE owner = ?", "private records"],
    ["SELECT 1 FROM site_uploads WHERE owner = ?", "files"],
  ]) assert.equal(await one(sql, [hal]), null, what);
  assert.equal(await one("SELECT 1 FROM site_contacts WHERE id = ?", [id]), null);
  assert.deepEqual((await all<{ data: string }>("SELECT data FROM site_messages WHERE site_slug = 'gone'")).map((m) => JSON.parse(m.data).message), ["hers"]);
  const order = await one<Record<string, unknown>>("SELECT * FROM site_orders WHERE session_id = 'cs_h'");
  assert.deepEqual([order?.email, order?.name, order?.address, order?.amount, order?.item], ["", "", "", 2500, "Cake"], "kept for the books");
  assert.equal((await one<{ email: string }>("SELECT email FROM site_orders WHERE session_id = 'cs_i'"))?.email, "ivy@x.co");
  assert.equal((await contactsOf("gone")).length, 1, "Ivy stays");
  assert.equal((await contactsOf("kept")).length, 1, "another app's list is its own");
  assert.equal(await contacts.tokenContact(token), null, "their link stops working");
  assert.deepEqual(await (await call("DELETE", owner, "gone", `?id=${id}`)).json(), { ok: false });
});

test("one contact's data comes as one file, under 4 MB", async () => {
  await fresh();
  await site("export", "owner");
  await siteAuth("export", "signup", { email: "jo@x.co", password: "longenough1", name: "Jo" }, "1.1.3.1", "/p/export", true, null);
  const jo = (await one<{ id: string }>("SELECT id FROM site_users WHERE site_slug = 'export'"))!.id;
  await send("export", { email: "jo@x.co", message: "Hello" }, { consent: { text: NEWS } }, "1.1.3.2");
  await run("INSERT INTO site_records (id, site_slug, collection, data, created_at, updated_at, owner) VALUES ('rj', 'export', 'notes', '{\"text\":\"mine\"}', 5, 5, ?)", [jo]);
  await run("INSERT INTO site_uploads (id, site_slug, owner, mime, name, data, size, created_at) VALUES ('fj', 'export', ?, 'image/png', 'me.png', x'00', 1, 1)", [jo]);
  await run(
    "INSERT INTO site_orders (session_id, site_slug, item, quantity, amount, currency, email, name, address, created_at) VALUES ('cs_j', 'export', 'Cake', 2, 5000, 'cad', 'Jo@x.co', 'Jo', '2 Main St', 1)",
  );
  const id = (await one<{ id: string }>("SELECT id FROM site_contacts WHERE site_slug = 'export'"))!.id;
  const res = await call("GET", owner, "export", `?id=${id}&format=json`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /golden-crumb-contact\.json/);
  const text = await res.text();
  assert.ok(!text.includes("password") && !text.includes("scrypt"), "never the password");
  const data = JSON.parse(text);
  assert.equal(data.contact.email, "jo@x.co");
  assert.equal(data.contact.consent.text, NEWS);
  assert.match(data.contact.consent.ipHash, /^[0-9a-f]{24}$/);
  assert.match(data.contact.unsubscribeLink, /^https:\/\/www\.flash-app\.dev\/u\//);
  assert.equal(data.member.email, "jo@x.co");
  assert.deepEqual(data.messages.map((m: { data: { message: string } }) => m.data.message), ["Hello"]);
  assert.equal(data.orders[0].address, "2 Main St");
  assert.deepEqual(data.privateRecords.map((r: { data: unknown }) => r.data), [{ text: "mine" }]);
  assert.equal(data.files[0].name, "me.png");
  assert.equal(data.privateRecordsCut, undefined);
  assert.equal((await call("GET", owner, "export", "?id=nope&format=json")).status, 404);

  // A member with a lot of private data: the newest that fits, and how much was left out.
  const big = JSON.stringify({ text: "x".repeat(60_000) });
  await run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 80)
     INSERT INTO site_records (id, site_slug, collection, data, created_at, updated_at, owner) SELECT 'big' || i, 'export', 'notes', ?, 100 + i, 100 + i, ? FROM n`,
    [big, jo],
  );
  const large = await (await call("GET", owner, "export", `?id=${id}&format=json`)).text();
  assert.ok(Buffer.byteLength(large) < 4_000_000, `${Buffer.byteLength(large)} bytes`);
  const cut = JSON.parse(large).privateRecordsCut;
  assert.equal(cut.total, 81);
  assert.ok(cut.included > 0 && cut.included < 81);
});

test("the whole list downloads as a CSV file in the owner's language", async () => {
  await fresh();
  await site("csv", "owner");
  await run("INSERT INTO site_domains (domain, site_slug, user_id, created_at) VALUES ('goldencrumb.com', 'csv', 'owner', 0)");
  await contacts.addContact("csv", { name: "=1+1", email: "kim@x.co" });
  await send("csv", { email: "lu@x.co", name: "Lu" }, { consent: { text: NEWS } }, "1.1.4.1");
  const res = await call("GET", owner, "csv", "?format=csv");
  assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(res.headers.get("content-disposition") ?? "", /golden-crumb-contacts\.csv/);
  assert.equal(res.headers.get("x-flash-truncated"), null);
  const csv = await res.text();
  const lines = csv.split("\r\n");
  // (Reading the reply as text drops the byte-order mark the file starts with.)
  assert.ok(lines[0].startsWith("Name,Email,Phone,Stage,Tags,Notes,Source,First seen,Last seen,Agreed to news,Agreed on,Wording they saw"), lines[0]);
  assert.ok(csv.includes("'=1+1"), "a name like a formula stays text");
  assert.ok(csv.includes(`Lu,lu@x.co,,New,,,Form: contact,`));
  assert.match(csv, /,Yes,\d{4}-\d\d-\d\d \d\d:\d\d,Email me news/);
  assert.match(csv, /https:\/\/www\.flash-app\.dev\/u\/[\w-]+\.[\w-]{22}/, "links use Flash's own address, never the app's domain");
  assert.ok(!csv.includes("goldencrumb.com"));

  const fr = french;
  const inFrench = await contacts.contactCsv("csv", fr, "https://www.flash-app.dev");
  assert.ok(inFrench.csv.startsWith(`\uFEFF${fr("Name")},${fr("Email")},${fr("Phone")}`));
  assert.notEqual(fr("First seen"), "First seen");
  assert.ok(inFrench.csv.includes(fr("Form: {form}", { form: "contact" })));
  const cut = await contacts.contactCsv("csv", fr, "https://www.flash-app.dev", Buffer.byteLength(inFrench.csv) - 1);
  assert.deepEqual([cut.included, cut.total], [1, 2], "the newest that fit");

  // Over 4 MB: the route cuts it and says so.
  await run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
     INSERT INTO site_contacts (id, site_slug, email, notes, first_seen, last_seen) SELECT 'n' || i, 'csv', 'n' || i || '@x.co', ?, i, i FROM n`,
    ["x".repeat(1000)],
  );
  const big = await call("GET", owner, "csv", "?format=csv");
  const [included, total] = (big.headers.get("x-flash-truncated") ?? "").split("/").map(Number);
  assert.equal(total, 5002);
  assert.ok(included > 3000 && included < 5002, String(included));
  assert.ok(Buffer.byteLength(await big.text()) <= 4_000_000);
});

test("an unsubscribe link works without signing in, and only a POST changes anything", async () => {
  await fresh();
  await site("unsub", "owner");
  await site("unsub2", "owner");
  await send("unsub", { email: "mo@x.co" }, { consent: { text: NEWS } }, "1.1.5.1");
  await send("unsub2", { email: "mo@x.co" }, {}, "1.1.5.2");
  const [mo] = await contactsOf("unsub");
  const [mo2] = await contactsOf("unsub2");
  assert.ok(await contacts.siteSecret("unsub2"));
  const secret = await contacts.siteSecret("unsub");
  assert.equal(await contacts.siteSecret("unsub"), secret, "made once");
  const token = contacts.unsubToken(secret, "unsub", String(mo.id));
  assert.deepEqual(await contacts.tokenContact(token), { id: mo.id, title: "Golden Crumb", unsubscribed: false });
  const changed = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  assert.equal(await contacts.tokenContact(changed), null, "a changed signature");
  assert.equal(await contacts.tokenContact(contacts.unsubToken(secret, "unsub", String(mo2.id))), null, "another app's contact");
  assert.equal(await contacts.tokenContact("nonsense"), null);
  await run("INSERT INTO site_contacts (id, site_slug, email, first_seen, last_seen) VALUES ('nosecret00000000', 'quiet', 'q@x.co', 1, 1)");
  assert.equal(await contacts.tokenContact(contacts.unsubToken("", "quiet", "nosecret00000000")), null, "an app with no secret yet");
  // Looking never writes.
  for (let i = 0; i < 3; i++) await contacts.tokenContact(token);
  assert.equal((await one<{ u: number }>("SELECT unsubscribed_at AS u FROM site_contacts WHERE id = ?", [mo.id]))?.u, 0);

  const form = await unsub(token);
  assert.equal(form.status, 303);
  assert.equal(form.headers.get("location"), `https://www.flash-app.dev/u/${token}`);
  const at = Number((await one<{ u: number }>("SELECT unsubscribed_at AS u FROM site_contacts WHERE id = ?", [mo.id]))?.u);
  assert.ok(at > 0);
  assert.equal((await contacts.tokenContact(token))?.unsubscribed, true);
  await unsub(token);
  assert.equal(Number((await one<{ u: number }>("SELECT unsubscribed_at AS u FROM site_contacts WHERE id = ?", [mo.id]))?.u), at, "the same time again");
  const oneClick = await unsub(token, "List-Unsubscribe=One-Click");
  assert.equal(oneClick.status, 200);
  assert.deepEqual(await oneClick.json(), { ok: true });
  assert.equal((await unsub(changed, "List-Unsubscribe=One-Click")).status, 404);
  assert.equal((await unsub(changed)).status, 303, "the page then says the link doesn't work");
  await fresh();
  for (let i = 0; i < 30; i++) await unsub(token, "", "198.51.100.30");
  const limited = await unsub(token, "", "198.51.100.30");
  assert.equal(limited.status, 303);
  assert.match(limited.headers.get("location") ?? "", /\?wait=1$/);
  assert.equal((await unsub(token, "List-Unsubscribe=One-Click", "198.51.100.30")).status, 429);
  await fresh();
});

test("unpublishing an app deletes its contacts", async () => {
  await site("bye", "owner");
  await send("bye", { email: "ned@x.co" }, {}, "1.1.6.1");
  assert.equal((await contactsOf("bye")).length, 1);
  await run("PRAGMA foreign_keys = OFF");
  try {
    assert.equal(await unpublishSite("owner", "bye"), true);
  } finally {
    await run("PRAGMA foreign_keys = ON");
  }
  assert.equal((await contactsOf("bye")).length, 0);
});

test("the app's page sends what the person agreed to only when they ticked the box themselves", async () => {
  type Listener = (e: { target: unknown; isTrusted: boolean }) => void;
  type Box = { type: string; checked: boolean; defaultChecked: boolean; labels: { textContent: string }[] };
  const setup = (code: string) => {
    const listeners: Record<string, Listener[]> = {};
    const document = {
      readyState: "complete",
      addEventListener: (type: string, fn: Listener) => (listeners[type] ??= []).push(fn),
      createElement: () => ({ style: {} }),
      body: { appendChild() {} },
    };
    const sent: unknown[] = [];
    const logs: string[] = [];
    const fetch = async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ ok: true }) };
    };
    const console = { info: (...a: unknown[]) => logs.push(a.map(String).join(" ")), warn: (m: string) => logs.push(`warn: ${m}`) };
    const window: { flashDB?: { send(f: string, d: object, o?: object): Promise<boolean> } } = {};
    vm.runInNewContext(code, { window, document, fetch, console, location: { href: "https://flash.test/p/x" }, history: { replaceState() {} }, URL, URLSearchParams, Promise });
    const fire = (type: string, target: unknown, isTrusted: boolean) => (listeners[type] ?? []).forEach((fn) => fn({ target, isTrusted }));
    return { db: window.flashDB!, fire, sent, logs };
  };
  const box = (over: Partial<Box> = {}): Box => ({ type: "checkbox", checked: false, defaultChecked: false, labels: [{ textContent: "  Email me\n   news from Golden Crumb " }], ...over });
  const live = setup(flashDbShim("/d", "/api/sites/x/inbox").replace(/^<script>|<\/script>$/g, ""));
  const ticked = box();
  ticked.checked = true;
  live.fire("click", ticked, true);
  live.fire("change", ticked, true);
  await live.db.send("contact", { email: "a@b.co" }, { news: ticked });
  assert.deepEqual(live.sent.at(-1), { form: "contact", data: { email: "a@b.co" }, consent: { text: "Email me news from Golden Crumb" } });

  const scripted = box({ checked: true });
  live.fire("click", scripted, false);
  live.fire("change", scripted, true);
  const untrusted = box({ checked: true });
  live.fire("change", untrusted, false);
  const preTicked = box({ checked: true, defaultChecked: true });
  live.fire("change", preTicked, true);
  const unticked = box();
  live.fire("change", unticked, true);
  const unlabelled = box({ labels: [] });
  unlabelled.checked = true;
  // The scripted click's change was in the same task; this one comes later, on its own.
  await Promise.resolve();
  live.fire("change", unlabelled, true);
  for (const news of [scripted, untrusted, preTicked, unticked, unlabelled, { type: "text", checked: true }]) {
    await live.db.send("contact", { email: "a@b.co" }, { news });
    assert.deepEqual(live.sent.at(-1), { form: "contact", data: { email: "a@b.co" } });
  }
  await live.db.send("contact", { email: "a@b.co" });
  assert.deepEqual(live.sent.at(-1), { form: "contact", data: { email: "a@b.co" } }, "no options");
  assert.ok(live.logs.some((l) => l.includes("didn't tick it themselves")));
  assert.ok(live.logs.some((l) => l.includes("starts ticked")));

  const preview = setup(`(function(){${MEMORY_DB}})()`);
  const tick = box();
  tick.checked = true;
  preview.fire("change", tick, true);
  assert.equal(await preview.db.send("contact", { email: "a@b.co" }, { news: tick }), true);
  assert.deepEqual(preview.sent, [], "the preview sends nothing");
  assert.ok(preview.logs.some((l) => l.includes("Flash records that they agreed to: Email me news from Golden Crumb")));

  // Both still run where there's no document at all.
  const bare: { flashDB?: { send: (...a: unknown[]) => Promise<boolean> } } = {};
  vm.runInNewContext(`(function(){${MEMORY_DB}})()`, { window: bare });
  assert.equal(await bare.flashDB!.send("contact", {}, { news: box({ checked: true }) }), true);
  const bareLive: { flashDB?: unknown } = {};
  vm.runInNewContext(flashDbShim("/d", "/i").replace(/^<script>|<\/script>$/g, ""), { window: bareLive, URL, URLSearchParams, location: { href: "https://x/p/x" }, fetch: () => {} });
  assert.ok(bareLive.flashDB);
});
