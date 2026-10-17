import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { register } from "node:module";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { domainToASCII, domainToUnicode } from "node:url";

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
const { cleanEmail, contactFromFields, normalPhone, pageHas, pageWords, stagesOf, cleanTags, dateText, formChanged, mailtoLink, phoneStage, failedText, DEFAULT_STAGES } = await import(
  "../src/lib/contacts.ts"
);
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
  for (const key of ["WhatsApp", "whatsApp", "whatsAppNumber", "WhatsApp number", "whatsapp", "celular", "móvil"]) {
    assert.deepEqual(contactFromFields({ name: "Ravi", [key]: "+91 98765 43210" }), { email: "", phone: "+919876543210", name: "Ravi" }, key);
  }
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

test("an email address can't bring a Bcc, a subject or another recipient into the owner's reply", async () => {
  const bcc = "jo@example.com?bcc=spy%40evil.example&subject=Re%3A%20your%20order";
  assert.equal(contactFromFields({ email: bcc }), null);
  for (const odd of ["jo@example.com#x", "jo@exa&mple.com", "jo@example.com,spy@evil.example", "jo@exam%40ple.com", "jo@example.com/x"]) {
    assert.equal(contactFromFields({ email: odd }), null, odd);
  }
  for (const real of ["ana.silva+cakes@example.co.uk", "josé@bäckerei.de", "user@例え.テスト", "a@उदाहरण.भारत", "o'brien@bücherei.de"]) {
    assert.equal(contactFromFields({ email: real })?.email, real, real);
  }
  assert.equal(contactFromFields({ email: "o'brien@xn--bcherei-n2a.de" })?.email, "o'brien@bücherei.de", "a domain as DNS writes it");
  await site("odd", "owner");
  assert.deepEqual(await send("odd", { name: "Jo", email: bcc }), { ok: true }, "the message still arrives");
  assert.deepEqual(await contactsOf("odd"), []);
  assert.equal((await siteAuth("odd", "signup", { email: bcc, password: "longenough1" }, "1.2.3.9", "/p/odd", true, null)).result, "bad-email");

  // Before the @ an address may have them, and the link still writes to that address alone.
  assert.equal(mailtoLink("ana.silva+cakes@example.co.uk"), "mailto:ana.silva+cakes@example.co.uk");
  for (const email of ["jo?bcc=spy%40evil.example&x=@example.com", "spy%40evil.example,jo@example.com", "jo#x@example.com", "josé@bäckerei.de"]) {
    const link = new URL(mailtoLink(email));
    assert.equal(link.search + link.hash, "", email);
    assert.equal(decodeURIComponent(link.pathname), email);
    assert.equal(link.pathname.split("%2C").length - 1, (email.match(/,/g) ?? []).length, "a comma stays in the address");
  }
});

test("an address is kept in one spelling: its domain as browsers and mail programs read it, with nothing invisible in it", () => {
  // The same domain, however it's written: an invisible character in it, fullwidth letters, the
  // "xn--" form DNS uses, or "ä" as "a" and a combining mark.
  for (const [typed, kept] of [
    ["cy@gmail\u{FE0F}.com", "cy@gmail.com"],
    ["cy@gma\u034Fil.com", "cy@gmail.com"],
    ["cy@gmail\u{E0100}.com", "cy@gmail.com"],
    ["cy@ｇｍａｉｌ.com", "cy@gmail.com"],
    ["CY@ＧＭＡＩＬ.COM", "cy@gmail.com"],
    ["jo@xn--bckerei-5wa.de", "jo@bäckerei.de"],
    ["jo@ba\u0308ckerei.de", "jo@bäckerei.de"],
    ["jo@BÄCKEREI.de", "jo@bäckerei.de"],
    ["jo\u0308@x.de", "jö@x.de"],
  ]) {
    assert.equal(cleanEmail(typed), kept, JSON.stringify(typed));
  }
  // Every script reads back as browsers show it.
  for (const domain of ["bäckerei.de", "例え.テスト", "उदाहरण.भारत", "почта.рф", "xn--80a1acny.xn--p1ai", "δοκιμή.gr", "straße.de", "مثال.إختبار", "ドメイン名例.jp", "한국.kr", "ab--cd.com", "a-b.c-d.com"]) {
    assert.equal(cleanEmail(`a@${domain}`), `a@${domainToUnicode(domainToASCII(domain))}`, domain);
  }
  // Before the @, an invisible character makes another address that looks the same: it isn't kept.
  for (const typed of ["c\u200By@gmail.com", "cy\u{FE0F}@gmail.com", "c\u00ADy@gmail.com", "\u202Ecy@gmail.com", "c\u0000y@gmail.com"]) {
    assert.equal(cleanEmail(typed), "", JSON.stringify(typed));
  }
  // A domain no browser could open isn't one.
  for (const typed of ["a@xn--zz.com", "a@b.12", "a@gm\u200Dail.com"]) assert.equal(cleanEmail(typed), "", typed);
});

test("members who joined with an address the old check allowed can still sign in", async () => {
  await fresh();
  await site("legacy", "owner");
  const { hashPassword } = await import("../src/lib/server/auth.ts");
  const hash = await hashPassword("longenough1");
  const odd = ["ann@mail_box.example.com", "bob@gmail.com.", "cy@[192.0.2.1]", "info@col·legi.cat", "me@i❤.ws"];
  for (const [i, email] of odd.entries()) {
    await run("INSERT INTO site_users (id, site_slug, email, name, password_hash, created_at) VALUES (?, 'legacy', ?, '', ?, 1)", [`lg${i}`, email, hash]);
    const signin = (password: string) => siteAuth("legacy", "signin", { email, password }, `1.2.4.${i}`, "/p/legacy", true, null);
    assert.equal((await signin("longenough1")).result, "ok", email);
    assert.equal((await signin("wrong-password")).result, "wrong", email);
  }
  // New sign-ups still need an address the contact list takes, and nonsense is still turned away.
  assert.equal((await siteAuth("legacy", "signup", { email: "dee@mail_box.example.com", password: "longenough1" }, "1.2.4.9", "/p/legacy", true, null)).result, "bad-email");
  assert.equal((await siteAuth("legacy", "signin", { email: "not an email", password: "longenough1" }, "1.2.4.9", "/p/legacy", true, null)).result, "bad-email");
  assert.deepEqual(await contactsOf("legacy"), []);
  await fresh();
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
  assert.equal((await one<{ email: string }>("SELECT email FROM site_orders WHERE site_slug = 'crumb'"))?.email, "ana@EXAMPLE.com", "the order keeps the address as given");

  // A buyer whose address Stripe gives in another spelling of its domain: the order keeps it as
  // their contact does, so their page shows it, the file has it and deleting them clears it.
  const jo = { ...paid, id: "cs_test_jo", customer_details: { email: "Jo@XN--BCKEREI-5WA.de", name: "Jo" } };
  globalThis.fetch = (async () => Response.json(jo)) as typeof fetch;
  assert.equal((await finishCheckout("crumb", "cs_test_jo", null, ORIGIN)).paid, true);
  const joContact = (await contactsOf("crumb")).find((c) => c.source === "order:Chocolate cake" && c.name === "Jo")!;
  assert.equal(joContact.email, "jo@bäckerei.de");
  assert.equal((await one<{ email: string }>("SELECT email FROM site_orders WHERE session_id = 'cs_test_jo'"))?.email, "jo@bäckerei.de");
  assert.equal((await contacts.contactDetail("crumb", String(joContact.id), ORIGIN))?.orderCount, 1);
  assert.equal(((await contacts.exportContact("crumb", String(joContact.id), ORIGIN))?.orders as unknown[]).length, 1);
  assert.equal(await contacts.deleteContact("crumb", String(joContact.id)), true);
  assert.equal((await one<{ email: string }>("SELECT email FROM site_orders WHERE session_id = 'cs_test_jo'"))?.email, "");
});

test("a buyer whose order Flash hadn't seen yet is on the list when the owner opens Contacts", async () => {
  await fresh();
  await site("late", "owner");
  const paid = {
    id: "cs_test_late",
    payment_status: "paid",
    amount_total: 2500,
    currency: "cad",
    created: Math.floor(Date.now() / 1000) - 3600,
    metadata: { flash_site: "late", flash_item: "Cake" },
    customer_details: { email: "bea@x.co", name: "Bea Buyer" },
    line_items: { data: [{ quantity: 1 }] },
  };
  // Stripe has the paid checkout (the buyer closed the page, or the payment went through later).
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url));
    return Response.json({ data: [paid, { ...paid, id: "cs_test_other", metadata: { flash_site: "crumb", flash_item: "Pie" } }] });
  }) as typeof fetch;
  const board = await (await call("GET", owner, "late")).json();
  assert.deepEqual(
    board.contacts.map((c: { email: string; source: string }) => [c.email, c.source]),
    [["bea@x.co", "order:Cake"]],
  );
  assert.equal(asked.length, 1);
  assert.match(asked[0], /\/checkout\/sessions\?limit=100&status=complete/);
  assert.equal((await all("SELECT 1 FROM site_orders WHERE site_slug = 'late'")).length, 1, "the order is saved too");
  // Coming back to the list within a minute, searching or opening someone doesn't ask Stripe again.
  await call("GET", owner, "late", "?mode=list");
  await call("GET", owner, "late", "?q=bea");
  await call("GET", owner, "late", `?id=${board.contacts[0].id}`);
  assert.equal(asked.length, 1);
  // A minute later it asks again, and a look-up that fails still shows the list.
  await run("UPDATE rate_limits SET reset_at = 0 WHERE key = 'contacts-orders:late'");
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  assert.equal((await (await call("GET", owner, "late")).json()).total, 1);
  assert.equal((await call("GET", stranger, "late")).status, 404);
});

test("someone known only by phone is one contact, and a number alone never joins them to someone with an email", async () => {
  await fresh();
  await site("phones", "owner");
  await send("phones", { name: "Bo", phone: "+1 555 010 0001", message: "Please deliver to 12 Elm St, gate code 4471" }, {}, "10.0.0.1");
  await send("phones", { phone: "+1-555-010-0001", message: "again" }, {}, "10.0.0.2");
  let list = await contactsOf("phones");
  assert.equal(list.length, 1, "the same phone, the same contact");
  const bo = list[0];
  assert.equal(bo.email, "");
  await run("UPDATE site_contacts SET notes = 'Pays cash' WHERE id = ?", [bo.id]);
  // Anyone can type Bo's number next to their own email: they get a contact of their own, and nothing of Bo's.
  await send("phones", { email: "mal@example.com", phone: "+15550100001", message: "hi" }, {}, "10.0.0.3");
  list = await contactsOf("phones");
  assert.equal(list.length, 2);
  const kept = list.find((c) => c.id === bo.id)!;
  assert.deepEqual([kept.email, kept.name, kept.notes], ["", "Bo", "Pays cash"], "Bo's contact is still only Bo's");
  const mal = list.find((c) => c.email === "mal@example.com")!;
  assert.equal(mal.phone, "+15550100001");
  // Bo's later messages by phone alone are Bo's, not those of whoever gave that number with an email.
  await send("phones", { phone: "+1 (555) 010-0001", message: "callback please, my code is 4471" }, {}, "10.0.0.4");
  assert.equal((await contactsOf("phones")).length, 2);
  const whose = async () =>
    Object.fromEntries(
      (await all<{ contact_id: string; data: string }>("SELECT contact_id, data FROM site_messages WHERE site_slug = 'phones'")).map((m) => [
        JSON.parse(m.data).message ?? "",
        m.contact_id,
      ]),
    );
  assert.deepEqual(await whose(), {
    "Please deliver to 12 Elm St, gate code 4471": bo.id,
    again: bo.id,
    hi: mal.id,
    "callback please, my code is 4471": bo.id,
  });
  const exported = await (await call("GET", owner, "phones", `?id=${mal.id}&format=json`)).json();
  assert.deepEqual([exported.contact.email, exported.contact.notes], ["mal@example.com", ""]);
  assert.deepEqual(
    exported.messages.map((m: { data: { message: string } }) => m.data.message),
    ["hi"],
    "their data has nothing of Bo's",
  );
  // Each one's details name the other, so the owner can tell whether they're one person.
  const detailOf = async (id: unknown) => (await call("GET", owner, "phones", `?id=${id}`)).json();
  assert.deepEqual((await detailOf(bo.id)).samePhone, [{ id: mal.id, name: "", email: "mal@example.com", phone: "+15550100001" }]);
  assert.deepEqual((await detailOf(mal.id)).samePhone.map((c: { id: string }) => c.id), [bo.id]);
  // Deleting the one with the email takes none of Bo's messages.
  assert.deepEqual(await (await call("DELETE", owner, "phones", `?id=${mal.id}`)).json(), { ok: true });
  assert.deepEqual(Object.keys(await whose()).sort(), ["Please deliver to 12 Elm St, gate code 4471", "again", "callback please, my code is 4471"]);
  assert.deepEqual((await detailOf(bo.id)).samePhone, []);
});

test("one person who gave their email on one form and only their phone on another is two contacts that name each other", async () => {
  await fresh();
  await site("twins", "owner");
  await siteAuth("twins", "signup", { email: "wes@x.co", password: "longenough1", name: "Wes" }, "10.0.1.1", "/p/twins", true, null);
  await send("twins", { name: "Wes", phone: "+1 555 010 8888", message: "Call me about my lab results" }, {}, "10.0.1.2");
  await send("twins", { email: "wes@x.co", phone: "+15550108888", message: "follow-up" }, {}, "10.0.1.3");
  const list = await contactsOf("twins");
  assert.deepEqual(
    list.map((c) => [c.email, c.phone, c.name]),
    [
      ["wes@x.co", "+15550108888", "Wes"],
      ["", "+15550108888", "Wes"],
    ],
  );
  const [withEmail, phoneOnly] = list;
  const detailOf = async (id: unknown) => (await call("GET", owner, "twins", `?id=${id}`)).json();
  assert.deepEqual((await detailOf(withEmail.id)).samePhone, [{ id: phoneOnly.id, name: "Wes", email: "", phone: "+15550108888" }]);
  assert.deepEqual((await detailOf(phoneOnly.id)).samePhone.map((c: { id: string }) => c.id), [withEmail.id]);
  // The owner deletes each one they find is the same person: the delete confirmation names the other.
  await call("DELETE", owner, "twins", `?id=${withEmail.id}`);
  assert.deepEqual((await contactsOf("twins")).map((c) => c.id), [phoneOnly.id]);
  await call("DELETE", owner, "twins", `?id=${phoneOnly.id}`);
  assert.deepEqual(await contactsOf("twins"), []);
  assert.equal(await one("SELECT 1 FROM site_messages WHERE site_slug = 'twins'"), null);
});

test("a phone number someone else typed with a member's email can be corrected or cleared by the owner", async () => {
  await fresh();
  await site("wrongphone", "owner");
  await siteAuth("wrongphone", "signup", { email: "ann@example.com", password: "longenough1", name: "Ann Lee" }, "10.0.2.1", "/p/wrongphone", true, null);
  // A stranger sends a form with Ann's email and their own number; later Ann sends her real one.
  await send("wrongphone", { email: "ann@example.com", phone: "+1 555 010 9999", message: "hi" }, {}, "10.0.2.2");
  await send("wrongphone", { email: "ann@example.com", phone: "+44 20 7946 0958", message: "it's Ann" }, {}, "10.0.2.3");
  await send("wrongphone", { phone: "+1 555 010 9999", message: "stranger again" }, {}, "10.0.2.4");
  const ann = (await contactsOf("wrongphone")).find((c) => c.email === "ann@example.com")!;
  const strangerOnly = (await contactsOf("wrongphone")).find((c) => c.email === "")!;
  assert.equal(ann.phone, "+15550109999", "the first number given fills in");
  const detailOf = async (id: unknown) => (await call("GET", owner, "wrongphone", `?id=${id}`)).json();
  assert.deepEqual((await detailOf(strangerOnly.id)).samePhone.map((c: { name: string }) => c.name), ["Ann Lee"]);

  const patch = (body: Record<string, unknown>) => call("PATCH", owner, "wrongphone", "", body);
  assert.equal((await patch({ id: ann.id, name: "Ann Lee", phone: "+44 20 7946 0958" })).status, 200);
  const fixed = await detailOf(ann.id);
  assert.deepEqual([fixed.contact.phone, fixed.contact.name], ["+442079460958", "Ann Lee"]);
  assert.deepEqual(fixed.samePhone, []);
  assert.deepEqual((await detailOf(strangerOnly.id)).samePhone, [], "the stranger's messages no longer name Ann");
  assert.equal((await (await call("GET", owner, "wrongphone", `?id=${ann.id}&format=json`)).json()).contact.phone, "+442079460958");
  const csv = await (await call("GET", owner, "wrongphone", "?format=csv")).text();
  assert.ok(csv.includes("Ann Lee,ann@example.com,'+442079460958,"), csv);
  assert.ok(!csv.includes("'+15550109999,New contact,,,Signed up"), "the stranger's number is off Ann's row");

  // Cleared, and refused when it isn't a number; someone known by their number alone keeps it.
  assert.equal((await patch({ id: ann.id, phone: "  " })).status, 200);
  assert.equal((await detailOf(ann.id)).contact.phone, "");
  const bad = await patch({ id: ann.id, phone: "call me" });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /isn't a phone number/);
  assert.equal((await patch({ id: ann.id, phone: 5550100 })).status, 400);
  assert.equal((await patch({ id: strangerOnly.id, phone: "+1 555 010 7777" })).status, 400);
  assert.equal((await patch({ id: strangerOnly.id, phone: "" })).status, 400);
  assert.equal((await detailOf(strangerOnly.id)).contact.phone, "+15550109999");
  assert.equal((await patch({ id: "missing", phone: "+1 555 010 7777" })).status, 404);
  // A later form fills it in again only while it's empty, as before.
  await send("wrongphone", { email: "ann@example.com", phone: "+44 20 7946 0958" }, {}, "10.0.2.5");
  assert.equal((await detailOf(ann.id)).contact.phone, "+442079460958");
});

test("agreeing to news counts only with the page's own wording, and a ticked box never undoes an unsubscribe", async () => {
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

  // They unsubscribe. Anyone can send the form with their address and the page's wording, so a box
  // ticked afterwards changes nothing: they stay unsubscribed, and the owner sees when.
  const t = await translatorIn("en");
  const token = contacts.unsubToken(await contacts.siteSecret("news"), "news", String(cy.id));
  assert.equal(await contacts.unsubscribe(token), true);
  const row = () => one<Record<string, string | number>>("SELECT * FROM site_contacts WHERE id = ?", [cy.id]);
  const before = await row();
  const firstOff = Number(before?.unsubscribed_at);
  assert.ok(firstOff > 0);
  const shown = async () => (await contacts.listContacts("news", t))!.contacts.find((c) => c.id === cy.id)!;
  assert.equal((await shown()).subscribed, false);
  await new Promise((r) => setTimeout(r, 5));
  await send("news", { email: "CY@example.com", message: "sign me up" }, { consent: { text: NEWS } }, "203.0.113.55");
  assert.equal((await shown()).subscribed, false, "a ticked box doesn't undo an unsubscribe");
  assert.equal((await shown()).unsubscribedAt, firstOff, "the owner sees when they unsubscribed");
  assert.deepEqual(await row(), { ...before, last_seen: (await row())?.last_seen }, "nothing about their agreement changed");
  assert.equal((await contacts.tokenContact(token))?.unsubscribed, true, "their link still says so");
  // Nor for someone who unsubscribed without ever agreeing.
  await send("news", { email: "gil@example.com" }, {}, "203.0.113.56");
  const gil = (await contactsOf("news")).find((c) => c.email === "gil@example.com")!;
  await contacts.unsubscribe(contacts.unsubToken(await contacts.siteSecret("news"), "news", String(gil.id)));
  await send("news", { email: "gil@example.com" }, { consent: { text: NEWS } }, "203.0.113.57");
  const gilNow = (await contactsOf("news")).find((c) => c.email === "gil@example.com")!;
  assert.equal(gilNow.consent_at, 0);
  assert.ok(Number(gilNow.unsubscribed_at) > 0);

  // Only the owner can record that they asked for news again, with how they asked.
  const ask = (id: unknown, askedAgain: unknown) => call("PATCH", owner, "news", "", { id, askedAgain });
  assert.equal((await ask(cy.id, "  ")).status, 400, "it needs a note");
  assert.equal((await ask(cy.id, "x".repeat(301))).status, 400, "of up to 300 characters");
  assert.equal((await ask("missing", "They asked")).status, 404);
  const dee = (await contactsOf("news")).find((c) => c.email === "dee@example.com")!;
  assert.equal((await ask(dee.id, "They asked")).status, 400, "only for someone who unsubscribed");
  assert.equal((await ask(cy.id, "  They asked at the till\n on Saturday ")).status, 200);
  const back = await shown();
  assert.equal(back.subscribed, true);
  assert.deepEqual({ ...back.consent, at: 0 }, { text: "They asked at the till on Saturday", at: 0, form: "", by: "owner" });
  assert.ok(back.consent!.at > firstOff);
  const recorded = await row();
  assert.deepEqual([recorded?.consent_ip, recorded?.consent_form, recorded?.consent_by], ["", "", "owner"], "never wording they saw, a form or an address");
  const csv = (await contacts.contactCsv("news", t, ORIGIN)).csv;
  assert.match(csv, /Recorded by you: They asked at the till on Saturday/);
  const file = (await contacts.exportContact("news", String(cy.id), ORIGIN, t))!.contact as { consent: unknown };
  assert.deepEqual({ ...(file.consent as object), at: null }, { recordedBy: "owner", note: "They asked at the till on Saturday", at: null, channel: "email" });
  const detail = await (await call("GET", owner, "news", `?id=${cy.id}`)).json();
  assert.equal(detail.contact.consent.by, "owner");
  assert.equal((await ask(cy.id, "Again")).status, 400, "they're subscribed now");
  // A box ticked now changes nothing of what the owner recorded.
  await send("news", { email: "cy@example.com" }, { consent: { text: NEWS } }, "203.0.113.58");
  assert.equal((await row())?.consent_by, "owner");
  assert.equal((await row())?.consent_text, "They asked at the till on Saturday");

  // A later unsubscribe wins again, and the owner can record it again after that.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await contacts.unsubscribe(token), true);
  assert.equal((await shown()).subscribed, false, "a later unsubscribe");
  assert.ok((await shown()).unsubscribedAt > firstOff);
  assert.equal((await contacts.tokenContact(token))?.unsubscribed, true);
  await send("news", { email: "cy@example.com" }, { consent: { text: NEWS } }, "203.0.113.59");
  assert.equal((await shown()).subscribed, false);
  assert.equal((await ask(cy.id, "They emailed me")).status, 200);
  assert.equal((await shown()).subscribed, true);
});

test("a ticked box doesn't sign up the mailbox of someone who unsubscribed under another spelling of their address", async () => {
  await fresh();
  await site("plus", "owner");
  await site("plus2", "owner");
  const agreed = async (slug: string, email: string) => Number((await contactsOf(slug)).find((c) => c.email === email)?.consent_at) > 0;
  const off = async (slug: string, email: string) => {
    const c = (await contactsOf(slug)).find((x) => x.email === email)!;
    assert.equal(await contacts.unsubscribe(contacts.unsubToken(await contacts.siteSecret(slug), slug, String(c.id))), true);
  };
  await send("plus", { email: "cy@gmail.com" }, { consent: { text: NEWS } }, "203.0.113.60");
  await send("plus", { email: "a.b@example.com" }, { consent: { text: NEWS } }, "203.0.113.61");
  // Someone already on the list at another spelling, who never agreed or unsubscribed.
  await send("plus", { email: "c.y+shop@gmail.com" }, {}, "203.0.113.62");
  await off("plus", "cy@gmail.com");
  await off("plus", "a.b@example.com");
  // The same mailboxes, written another way: Gmail ignores dots and +tags, most others +tags.
  for (const [i, email] of ["cy+news@gmail.com", "c.y@gmail.com", "C.Y+x@googlemail.com", "c.y+shop@gmail.com", "a.b+news@example.com"].entries()) {
    await send("plus", { email }, { consent: { text: NEWS } }, `198.51.100.${70 + i}`);
    assert.equal(await agreed("plus", email.toLowerCase()), false, email);
  }
  // Other mailboxes still agree: dots count outside Gmail, and another app's unsubscribe is its own.
  for (const [i, email] of ["ab@example.com", "cy@example.com", "cyd@gmail.com"].entries()) {
    await send("plus", { email }, { consent: { text: NEWS } }, `198.51.100.${80 + i}`);
    assert.equal(await agreed("plus", email), true, email);
  }
  await send("plus2", { email: "cy+news@gmail.com" }, { consent: { text: NEWS } }, "198.51.100.90");
  assert.equal(await agreed("plus2", "cy+news@gmail.com"), true, "another app");
  // The same domain written another way is the same address: an invisible character in it,
  // fullwidth letters, the xn-- form, or "ä" as "a" and a combining mark. Each joins the person
  // who unsubscribed, who stays unsubscribed, and no one who looks like them is added.
  await send("plus", { email: "jo@bäckerei.de" }, { consent: { text: NEWS } }, "203.0.113.64");
  await off("plus", "jo@bäckerei.de");
  const before = (await contactsOf("plus")).length;
  for (const [i, email] of ["cy@gmail\u{FE0F}.com", "cy@gma\u034Fil.com", "cy@ｇｍａｉｌ.com", "jo@xn--bckerei-5wa.de", "jo@ba\u0308ckerei.de"].entries()) {
    await send("plus", { email }, { consent: { text: NEWS } }, `198.51.100.${100 + i}`);
  }
  assert.equal((await contactsOf("plus")).length, before, "nobody new");
  assert.equal(await agreed("plus", "cy+news@gmail.com"), false);
  // Someone saved before addresses were kept in one spelling, who then unsubscribed: their mailbox
  // under the usual spelling doesn't agree either.
  for (const [i, email] of ["di@ｅｘａｍｐｌｅ.org", "ed@xn--bckerei-5wa.de", "fi@ba\u0308ckerei.de", "gi@exam\u{FE0F}ple.org"].entries()) {
    await run("INSERT INTO site_contacts (id, site_slug, email, source, first_seen, last_seen, unsubscribed_at) VALUES (?, 'plus', ?, 'form:contact', 1, 1, 2)", [
      `old${i}`,
      email,
    ]);
  }
  for (const [i, email] of ["di+news@example.org", "ed@bäckerei.de", "fi@bäckerei.de", "gi@example.org"].entries()) {
    await send("plus", { email }, { consent: { text: NEWS } }, `198.51.100.${110 + i}`);
    assert.equal(await agreed("plus", email), false, email);
  }
  const csv = (await contacts.contactCsv("plus", await translatorIn("en"), ORIGIN)).csv;
  const yes = csv.split("\n").filter((line) => /,Yes,/.test(line)).map((line) => line.split(",")[1]).sort();
  assert.deepEqual(yes, ["ab@example.com", "cy@example.com", "cyd@gmail.com"], "the file marks only them as agreed");
  await fresh();
});

test("someone a form signed up again after they unsubscribed, before a tick stopped doing that, reads as unsubscribed", async () => {
  await fresh();
  await site("before", "owner");
  await send("before", { email: "cy@example.com" }, { consent: { text: NEWS } }, "203.0.113.63");
  const [cy] = await contactsOf("before");
  const token = contacts.unsubToken(await contacts.siteSecret("before"), "before", String(cy.id));
  await contacts.unsubscribe(token);
  // What #114 kept when a stranger then ticked the box with Cy's address: a newer agreement from a form.
  const firstOff = Number((await contactsOf("before"))[0].unsubscribed_at);
  await run("UPDATE site_contacts SET consent_at = ?, consent_ip = 'x', consent_by = '' WHERE id = ?", [firstOff + 60_000, cy.id]);
  const t = await translatorIn("en");
  const shown = async () => (await contacts.listContacts("before", t))!.contacts[0];
  assert.equal((await shown()).subscribed, false);
  assert.equal((await shown()).unsubscribedAt, firstOff);
  assert.match((await contacts.contactCsv("before", t, ORIGIN)).csv, /cy@example\.com,[^\n]*,No,/);
  // So does the file the owner gives them, beside the form's later agreement.
  const exported = (await contacts.exportContact("before", String(cy.id), ORIGIN, t))!.contact as Record<string, unknown>;
  assert.equal(exported.subscribed, false);
  assert.equal((exported.consent as { at: string }).at, new Date(firstOff + 60_000).toISOString());
  assert.equal((await contacts.tokenContact(token))?.unsubscribed, true, "their link says so");
  assert.equal(await contacts.unsubscribe(token), true);
  assert.equal(Number((await contactsOf("before"))[0].unsubscribed_at), firstOff, "the time they unsubscribed stays");
  // The owner can still record that they asked for news again.
  assert.equal((await call("PATCH", owner, "before", "", { id: cy.id, askedAgain: "They asked at the shop" })).status, 200);
  assert.equal((await shown()).subscribed, true);
  assert.equal(((await contacts.exportContact("before", String(cy.id), ORIGIN, t))!.contact as Record<string, unknown>).subscribed, true);
  assert.equal((await contacts.tokenContact(token))?.unsubscribed, false);
  await fresh();
});

test("the Privacy Policy says how long an unsubscribe holds, and for which spellings", () => {
  const policy = readFileSync(new URL("../src/app/privacy/page.tsx", import.meta.url), "utf8");
  assert.match(policy, /for as long as they&apos;re on the app&apos;s contact list, a box ticked on a form doesn&apos;t sign them up again, not even with a \+tag \(or, for Gmail, dots\)/);
  assert.match(policy, /If the owner deletes them, Flash keeps no record that they unsubscribed\./);
});

test("only wording a visitor sees on the page counts, never words in its code, comments or attributes", async () => {
  await fresh();
  const words = "Email me news and offers from Golden Crumb";
  const unseen = [
    `<script>const label = "${words}. I can unsubscribe at any time.";</script>`,
    `<script type="text/babel">function App() { return <label><input type="checkbox" /> ${words}</label>; }</script>`,
    `<SCRIPT>var x = "</div> ${words}";</SCRIPT >`,
    `<script type="application/json" id="i18n">{"news": "${words}"}</script>`,
    `<style>.news::after { content: "${words}"; }</style>`,
    `<template id="news"><label><input type="checkbox"> ${words}</label></template>`,
    `<template><template></template><p>${words}</p></template>`,
    `<noscript>${words}</noscript>`,
    `<!-- ${words} -->`,
    `<!--> ${"x"} --><!-- <p>${words}</p> -->`,
    `<input type="checkbox" aria-label="${words}">`,
    `<button title='${words}' data-label="${words}">Send</button>`,
    `<input value="${words}" placeholder="${words}">`,
    `<a title="a > b ${words}">Home</a>`,
    `<textarea>${words}</textarea>`,
    `<iframe>${words}</iframe>`,
    `<p>A tag that never ends</p><p title="${words}`,
    // Outside an <svg>, browsers read "<title/>" as a title that runs to its end tag.
    `<p><title/>${words}</title></p>`,
    `<svg><title>${words}</title></svg>`,
    `<svg><title a=b/>${words}</title></svg>`,
  ];
  for (const code of unseen) {
    const html = `<!doctype html><html><head><title>${words}</title></head><body><h1>Golden Crumb</h1>${code}</body></html>`;
    assert.ok(!pageHas(html, words), code);
  }
  // Words on the page still count, whatever code, comments and attributes are around them.
  const seen = [
    `<label><input type="checkbox" aria-label="news">${words}</label>`,
    `<script>if (a < b && c > d) document.title = "</p>";</script><p>${words}</p>`,
    `<a title="a > b" href='/x?a=1>2'>Email me news</a> and <b class=x>offers</b> from <!-- the shop -->Golden Crumb`,
    `<template><p>Not this</p></template><label>${words}</label><style>p > a { color: red }</style>`,
    `<p>Ages <12 &amp; up. ${words}</p>`,
    // In an <svg> a tag that ends in "/>" is empty, so an icon's <title/> or <style/> hides nothing after it.
    `<svg viewBox="0 0 40 40"><title/><circle r="1"/></svg><label>${words}</label>`,
    `<svg viewBox="0 0 24 24"><style/><path d="M0 0h1v1z"/></svg><label>${words}</label>`,
    `<svg><title class="x" /></svg><p>${words}</p><svg><title>Logo</title></svg>`,
    `<svg/><p>${words}</p>`,
    `<math><mi>x</mi><style/></math><p>${words}</p>`,
  ];
  for (const html of seen) assert.ok(pageHas(html, words), html);
  assert.equal(pageWords(`<p>One</p><script>Two</script><style>Three</style><!-- Four --><template>Five</template><b title="Six">Seven</b>`), "one seven");

  // A form sent with wording that's only in the app's code keeps no agreement.
  await site("coded", "owner", `<!doctype html><html><body><div id="root"></div><script type="text/babel">const t = "${NEWS}";</script></body></html>`);
  await send("coded", { email: "hal@example.com" }, { consent: { text: NEWS } }, "203.0.113.60");
  const [hal] = await contactsOf("coded");
  assert.equal(hal.email, "hal@example.com", "the contact is still kept");
  assert.equal(hal.consent_at, 0);
  assert.equal(hal.consent_text, "");
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

test("someone seen many times before takes one place in the copied-in list, never someone else's", async () => {
  await fresh();
  await site("busy", "owner");
  // 5,000 members, the 3,000 oldest already on the list with 3,000 others who sent forms, then
  // 6,500 repeat orders from members and 50 orders from new buyers.
  await run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
     INSERT INTO site_users (id, site_slug, email, name, password_hash, created_at) SELECT 'bm' || i, 'busy', 'm' || i || '@x.co', '', 'h', 1000 + i FROM n`,
  );
  await run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 6000)
     INSERT INTO site_contacts (id, site_slug, email, source, first_seen, last_seen)
     SELECT 'bc' || i, 'busy', CASE WHEN i <= 3000 THEN 'm' || i ELSE 'f' || i END || '@x.co', 'form:contact', 50000 + i, 50000 + i FROM n`,
  );
  await run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 6500)
     INSERT INTO site_orders (session_id, site_slug, item, quantity, amount, currency, email, name, address, created_at)
     SELECT 'cs_bm' || i, 'busy', 'Bread', 1, 500, 'cad', 'M' || (1 + i % 5000) || '@x.co', CASE WHEN i = 5001 THEN 'Ann Member' ELSE '' END, '', 10000 + i FROM n`,
  );
  await run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50)
     INSERT INTO site_orders (session_id, site_slug, item, quantity, amount, currency, email, name, address, created_at)
     SELECT 'cs_bg' || i, 'busy', 'Cake', 1, 900, 'cad', 'guest' || i || '@x.co', 'Guest ' || i, '', 30000 + i FROM n`,
  );
  await contacts.fillContacts("busy");
  const count = async (where: string) => Number((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM site_contacts WHERE site_slug = 'busy' AND ${where}`))?.n);
  assert.equal(await count("1"), 8050, "6,000, the 2,000 newer members and the 50 buyers");
  assert.equal(await count("email LIKE 'm%'"), 5000, "every member");
  assert.equal(await count("email LIKE 'guest%'"), 50, "every new buyer");
  // Someone already there is brought up to date once, from all their orders.
  const m2 = await one<Record<string, unknown>>("SELECT * FROM site_contacts WHERE site_slug = 'busy' AND email = 'm2@x.co'");
  assert.deepEqual([m2?.source, m2?.first_seen, m2?.last_seen, m2?.name], ["signup", 1002, 50002, "Ann Member"]);
  const g1 = await one<Record<string, unknown>>("SELECT * FROM site_contacts WHERE site_slug = 'busy' AND email = 'guest1@x.co'");
  assert.deepEqual([g1?.source, g1?.first_seen, g1?.last_seen, g1?.name], ["order:Cake", 30001, 30001, "Guest 1"]);
  const m4999 = await one<Record<string, unknown>>("SELECT * FROM site_contacts WHERE site_slug = 'busy' AND email = 'm4999@x.co'");
  assert.deepEqual([m4999?.source, m4999?.first_seen, m4999?.last_seen], ["signup", 5999, 14998], "a newer member who bought");
  await run("DELETE FROM site_contacts WHERE site_slug = 'busy'");
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

test("the owner's reads have a limit too: the board and list, one contact, and each download", async () => {
  await fresh();
  await site("reads", "owner");
  const ana = await contacts.addContact("reads", { email: "ana@x.co" });
  assert.ok("id" in ana);
  const limitOf = (key: string) => one<{ count: number }>("SELECT count FROM rate_limits WHERE key = ?", [key]);
  const nearly = (key: string, count: number, window = 3_600_000) =>
    run("INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)", [key, count, Date.now() + window]);
  // Each kind of read counts on its own: what one does never uses another's. Downloads and exports
  // count for each app.
  const reads: [string, string, number, RegExp][] = [
    [`contacts-list:${owner.id}`, "?mode=board", 600, /Too many requests\. Try again in an hour\./],
    [`contacts-list:${owner.id}`, "?mode=list", 600, /Too many requests\. Try again in an hour\./],
    [`contacts-contact:${owner.id}`, `?id=${ana.id}`, 600, /Too many requests\. Try again in an hour\./],
    [`contacts-csv:${owner.id}:reads`, "?format=csv", 10, /Too many requests\. Try again in an hour\./],
    [`contacts-export:${owner.id}:reads`, `?id=${ana.id}&format=json`, 20, /Too many requests\. Try again in an hour\./],
    [`contacts-search:${owner.id}`, "?q=ana", 60, /Too many searches\. Please wait a minute\./],
  ];
  for (const [key, query, max, error] of reads) {
    await fresh();
    assert.equal((await call("GET", owner, "reads", query)).status, 200, query);
    assert.equal(Number((await limitOf(key))?.count), 1, `${query} counts as ${key}`);
    assert.equal((await all("SELECT key FROM rate_limits WHERE key LIKE 'contacts-%' AND key NOT LIKE 'contacts-orders:%'")).length, 1, `${query} uses no other limit`);
    await nearly(key, max - 1, key.startsWith("contacts-search:") ? 60_000 : undefined);
    assert.equal((await call("GET", owner, "reads", query)).status, 200, `${query}: the last one of ${max}`);
    const limited = await call("GET", owner, "reads", query);
    assert.equal(limited.status, 429, query);
    assert.match((await limited.json()).error, error);
  }
  // The real count: ten downloads of the whole list an hour, then a friendly no.
  await fresh();
  for (let i = 0; i < 10; i++) assert.equal((await call("GET", owner, "reads", "?format=csv")).status, 200, `download ${i + 1}`);
  assert.equal((await call("GET", owner, "reads", "?format=csv")).status, 429);
  assert.equal((await call("GET", owner, "reads", "?mode=board")).status, 200, "the board still opens");
  // Another owner's limit is their own.
  await site("reads2", "stranger");
  assert.equal((await call("GET", stranger, "reads2", "?format=csv")).status, 200);
  // An owner with many apps can download each one's list, and export someone from each, in the same hour.
  await fresh();
  for (let i = 1; i <= 11; i++) {
    await site(`reads-app${i}`, "owner");
    const someone = await contacts.addContact(`reads-app${i}`, { email: `p${i}@x.co` });
    assert.ok("id" in someone);
    assert.equal((await call("GET", owner, `reads-app${i}`, "?format=csv")).status, 200, `app ${i}'s list`);
    assert.equal((await call("GET", owner, `reads-app${i}`, `?id=${someone.id}&format=json`)).status, 200, `someone from app ${i}`);
  }
  await fresh();
});

test("a read or change another site sets off is refused before it counts against the owner's limits", async () => {
  await fresh();
  await site("elsewhere", "owner");
  const ana = await contacts.addContact("elsewhere", { email: "ana@x.co" });
  assert.ok("id" in ana);
  const from = (fetchSite: string, method: "GET" | "PATCH" = "GET", query = "?format=csv", body?: unknown) =>
    (route[method] as (r: Request, c: unknown) => Promise<Response>)(
      new Request(`${ORIGIN}/api/sites/elsewhere/contacts${query}`, {
        method,
        headers: { "content-type": "application/json", cookie: owner.cookie, "sec-fetch-site": fetchSite, "sec-fetch-dest": "document" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { params: Promise.resolve({ slug: "elsewhere" }) },
    );
  // A page on another site sends the owner's browser to the download again and again.
  for (let i = 0; i < 11; i++) {
    const refused = await from("cross-site");
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error, "Please use Flash's own page.");
  }
  assert.equal((await from("same-site", "GET", "?mode=board")).status, 403, "a page on another address of the same site");
  assert.equal((await from("cross-site", "PATCH", "", { id: ana.id, notes: "x" })).status, 403);
  assert.deepEqual(await all("SELECT key FROM rate_limits WHERE key LIKE 'contacts-%'"), [], "nothing counted");
  // The owner's own download still works, and so does the address typed in.
  assert.equal((await from("same-origin")).status, 200);
  assert.equal((await from("none")).status, 200);
  assert.equal((await call("GET", owner, "elsewhere", "?format=csv")).status, 200, "a browser that doesn't say");
  await fresh();
});

test("a new contact checks the 10,000 cap with the app's count, not by counting its whole list", async () => {
  await fresh();
  await site("count", "owner");
  const n = async () => (await one<{ n: number }>("SELECT n FROM site_contact_counts WHERE site_slug = 'count'"))?.n ?? null;
  const real = async () => Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_contacts WHERE site_slug = 'count'"))?.n);
  assert.equal(await n(), null, "no count before anyone");
  await send("count", { email: "a@x.co" }, {}, "1.1.7.1");
  assert.equal(await n(), 1, "counted once");
  // The people from before are copied in, all at once, and the next new contact counts again.
  await run("INSERT INTO site_users (id, site_slug, email, name, password_hash, created_at) VALUES ('cm1', 'count', 'old@x.co', 'Old', 'h', 1)");
  await run("INSERT INTO site_messages (id, site_slug, form, data, created_at) VALUES ('cg1', 'count', 'contact', '{\"email\":\"older@x.co\"}', 2)");
  assert.equal((await call("GET", owner, "count")).status, 200, "the first look copies them in");
  assert.equal(await real(), 3);
  await send("count", { email: "b@x.co" }, {}, "1.1.7.2");
  assert.equal(await n(), 4);

  // What the cap reads is the count: with it at 10,000, nobody new joins, though four people are there.
  await run("UPDATE site_contact_counts SET n = 10000 WHERE site_slug = 'count'");
  assert.deepEqual(await send("count", { email: "c@x.co", message: "hi" }, {}, "1.1.7.3"), { ok: true }, "the message is still saved");
  await send("count", { phone: "+15550107001" }, {}, "1.1.7.4");
  assert.equal((await call("POST", owner, "count", "", { email: "c@x.co" })).status, 409);
  assert.equal(await real(), 4, "nobody new joined");
  await send("count", { email: "A@x.co", name: "Ann" }, {}, "1.1.7.5");
  assert.equal((await one<{ name: string }>("SELECT name FROM site_contacts WHERE site_slug = 'count' AND email = 'a@x.co'"))?.name, "Ann", "people on it still update");
  await run("UPDATE site_contact_counts SET n = 9999 WHERE site_slug = 'count'");
  await send("count", { phone: "+15550107001" }, {}, "1.1.7.6");
  assert.equal(await n(), 10_000, "one more joined and was counted");
  await send("count", { email: "d@x.co" }, {}, "1.1.7.7");
  assert.equal(await real(), 5);
  await run("UPDATE site_contact_counts SET n = 5 WHERE site_slug = 'count'");

  // Every way in and out keeps it right: forms, sign-ups, and the owner adding and deleting.
  await send("count", { email: "e@x.co" }, {}, "1.1.7.8");
  assert.equal((await siteAuth("count", "signup", { email: "f@x.co", password: "longenough1" }, "1.1.7.9", "/p/count", true, null)).result, "ok");
  const added = await (await call("POST", owner, "count", "", { email: "g@x.co" })).json();
  assert.equal((await call("POST", owner, "count", "", { email: "G@x.co" })).status, 200, "someone already there");
  await send("count", { email: "g@x.co" }, {}, "1.1.7.10");
  assert.equal(await real(), 8);
  assert.equal(await n(), 8);
  assert.equal((await call("DELETE", owner, "count", `?id=${added.id}`)).status, 200);
  assert.equal(await n(), 7);
  assert.equal(await n(), await real());
  await run("PRAGMA foreign_keys = OFF");
  try {
    assert.equal(await unpublishSite("owner", "count"), true);
  } finally {
    await run("PRAGMA foreign_keys = ON");
  }
  assert.equal(await one("SELECT 1 FROM site_contact_counts WHERE site_slug = 'count'"), null, "the count goes with the app");
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
  assert.deepEqual(found.matchedByStage, { new: 55, contacted: 56, won: 0, lost: 0 }, "what the search found in each stage, for the board");
  const many = await (await call("GET", owner, "edit", "?q=person")).json();
  assert.deepEqual([many.contacts.length, many.matched], [500, 600], "the newest 500, and how many there are");
  assert.deepEqual(many.matchedByStage, { new: 300, contacted: 300, won: 0, lost: 0 });
  // Capitals in any language, as the page searches a small list.
  await contacts.addContact("edit", { name: "Иван Петров", email: "ivan@x.co" });
  await contacts.addContact("edit", { name: "Élodie Brün", email: "elodie@x.co" });
  for (const q of ["иван", "ИВАН", "élodie", "ÉLODIE", "brün", "BRÜN"]) {
    assert.equal((await (await call("GET", owner, "edit", `?q=${encodeURIComponent(q)}`)).json()).matched, 1, q);
  }
  const tagged = await (await call("GET", owner, "edit", "?q=rye")).json();
  assert.deepEqual(tagged.contacts.map((c: { id: string }) => c.id), [gus.body.id]);
  const wild = await (await call("GET", owner, "edit", "?q=%25")).json();
  assert.equal(wild.matched, 0, "% is a character, not a wildcard");
  const phone = await (await call("GET", owner, "edit", "?q=555-010-0004")).json();
  assert.equal(phone.matched, 1);
});

test("a contact's dates say the year when it isn't this one, and only real changes count as unsaved", () => {
  const today = new Date(2026, 9, 16, 12).getTime();
  const old = new Date(2025, 2, 3, 15).getTime();
  const recent = new Date(2026, 2, 3, 15).getTime();
  assert.match(dateText(old, "en-US", true, today), /^Mar 3, 2025, 3:00\sPM$/);
  assert.equal(dateText(old, "en-US", false, today), "Mar 3, 2025");
  assert.match(dateText(recent, "en-US", true, today), /^Mar 3, 3:00\sPM$/);
  assert.equal(dateText(recent, "en-US", false, today), "Mar 3");
  assert.match(dateText(old, "ar-SA-u-ca-gregory", true, today), /2025|٢٠٢٥/);
  const saved = { name: "Ann", stage: "new", tags: "VIP, Rye", notes: "Called on Monday.", phone: "+442079460958" };
  assert.equal(formChanged({ ...saved }, saved), false);
  assert.equal(
    formChanged({ name: " Ann ", stage: "new", tags: "VIP,Rye, vip", notes: "Called on Monday.\n", phone: "+44 20 7946 0958" }, saved),
    false,
    "spaces and repeats change nothing",
  );
  assert.equal(formChanged({ ...saved, phone: "+44 20 7946 0959" }, saved), true);
  assert.equal(formChanged({ ...saved, phone: "" }, saved), true);
  assert.equal(formChanged({ ...saved, phone: "call me" }, saved), true, "a number that isn't one is a change, which saving then refuses");
  assert.equal(formChanged({ ...saved, stage: "won" }, saved), true);
  assert.equal(formChanged({ ...saved, notes: "Called on Monday. Wants rye." }, saved), true);
  assert.equal(formChanged({ ...saved, tags: "VIP" }, saved), true);
});

test("a phone shows the stage a search found people in, and a failed search says why", () => {
  const ids = ["new", "contacted", "won", "lost"];
  const counts: Record<string, number> = { new: 0, contacted: 0, won: 1, lost: 2 };
  const count = (id: string) => counts[id] ?? 0;
  assert.equal(phoneStage(ids, "", true, count), "won", "the first stage with matches, not an empty page");
  assert.equal(phoneStage(ids, "lost", true, count), "lost", "the owner's pick when it has matches");
  assert.equal(phoneStage(ids, "", false, count), "new", "the first stage when not searching, even when empty");
  assert.equal(phoneStage(ids, "contacted", false, count), "contacted", "a stage tapped during this search, even with nothing found there");
  assert.equal(phoneStage(ids, "gone", true, () => 0), "new", "nothing found anywhere");
  // The server's own words, or Flash's when no answer came (the browser's "Failed to fetch").
  const answered = Object.assign(new Error("Too many searches. Please wait a minute."), { status: 429 });
  assert.equal(failedText(answered, "Couldn't load"), "Too many searches. Please wait a minute.");
  assert.equal(failedText(new TypeError("Failed to fetch"), "Couldn't load"), "Couldn't load");
  assert.equal(failedText(Object.assign(new Error(""), { status: 500 }), "Couldn't load"), "Couldn't load");
});

test("Arabic counts of contacts read right for any number", () => {
  // Arabic puts 3 to 10 of something in the plural and 11 to 99 in the singular, so a number
  // that can be anything goes after a label ("جهات الاتصال: 4"), as other Arabic counts do.
  const ar = JSON.parse(readFileSync(new URL("../src/lib/i18n/ar.json", import.meta.url), "utf8"));
  const singular = /\d\s*جهة اتصال/;
  for (const n of [2, 3, 4, 10, 11, 103, 5004]) {
    for (const [text, blanks] of [
      ["{count} contacts", { count: n }],
      ["{shown} of {count} contacts match", { shown: 1, count: n }],
      ["Your download has the newest {included} of {total} contacts (the file limit is 4 MB).", { included: 3000, total: n }],
    ] as const) {
      const shown = translate(ar, text, blanks);
      assert.notEqual(shown, text, `translated: ${text}`);
      assert.doesNotMatch(shown, singular, `${n}: ${shown}`);
      assert.ok(shown.includes(String(n)), shown);
    }
  }
  // Only ever 12 stages, which takes the singular.
  assert.equal(translate(ar, "You can have up to {count} stages.", { count: 12 }), "يمكنك إضافة 12 مرحلة كحد أقصى.");
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
  const saved = await put([{ id: "contacted", name: "Called" }, { id: "new", name: "New contact" }, { name: "Quoted" }, { id: "won", name: "Paid" }]);
  assert.equal(saved.status, 200);
  const ids = saved.body.stages.map((s: { id: string }) => s.id);
  assert.deepEqual(ids.slice(0, 2), ["contacted", "new"]);
  assert.match(ids[2], /^s[a-z0-9]{6}$/);
  const stored = JSON.parse((await one<{ s: string }>("SELECT contact_stages AS s FROM sites WHERE slug = 'stages'"))!.s);
  assert.equal(stored[1].name, "", "a standard name is kept as the standard, so it's translated");
  assert.equal(stagesOf(JSON.stringify(stored), fr)[1].name, fr("New contact"));
  assert.notEqual(fr("New contact"), "New contact");
  assert.notEqual(DEFAULT_STAGES[0].name, "New", "the first stage has its own phrase, not an unread message's");
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
  assert.equal(data.contact.subscribed, true);
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
  assert.ok(csv.includes(`Lu,lu@x.co,,New contact,,,Form: contact,`));
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
  assert.deepEqual(await contacts.tokenContact(token), { id: mo.id, slug: "unsub", title: "Golden Crumb", unsubscribed: false });
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
  // Links that don't work count against an address, 30 an hour.
  for (let i = 0; i < 30; i++) assert.equal((await unsub(changed, "List-Unsubscribe=One-Click", "198.51.100.30")).status, 404);
  assert.equal((await unsub(changed, "List-Unsubscribe=One-Click", "198.51.100.30")).status, 429);
  assert.equal((await unsub(changed, "", "198.51.100.30")).headers.get("location"), `https://www.flash-app.dev/u/${changed}`, "the page says the link doesn't work");
  // One that works always unsubscribes, from that address too.
  await run("UPDATE site_contacts SET unsubscribed_at = 0 WHERE id = ?", [mo.id]);
  const late = await unsub(token, "List-Unsubscribe=One-Click", "198.51.100.30");
  assert.equal(late.status, 200);
  assert.ok(Number((await one<{ u: number }>("SELECT unsubscribed_at AS u FROM site_contacts WHERE id = ?", [mo.id]))?.u) > 0);
  assert.equal((await unsub(token, "", "198.51.100.30")).headers.get("location"), `https://www.flash-app.dev/u/${token}`);

  // A mail provider posts everyone's one-click unsubscribes from one of its own servers.
  await fresh();
  const people: string[] = [];
  for (let i = 0; i < 40; i++) {
    const slug = i % 2 ? "unsub" : "unsub2";
    const id = await contacts.noteContact(slug, { email: `reader${i}@x.co`, phone: "", name: "" }, { source: "form:news", at: Date.now() - 60_000, consent: { text: NEWS, ipHash: "x", form: "news" } });
    people.push(id);
    const answer = await unsub(contacts.unsubToken(await contacts.siteSecret(slug), slug, id), "List-Unsubscribe=One-Click", "209.85.220.41");
    assert.equal(answer.status, 200, `reader ${i}`);
  }
  const still = await all(`SELECT id FROM site_contacts WHERE id IN (${people.map(() => "?").join(", ")}) AND consent_at > unsubscribed_at`, people);
  assert.deepEqual(still, [], "all 40 unsubscribed");
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

/*
 * A page running the app's flashDB in a bare context: listeners for the page's events (fire), what
 * it sent and what it logged. Labels are a small stand-in for the browser's nodes (labelOf).
 */
type Listener = (e: { target: unknown; isTrusted: boolean }) => void;
type FakeNode = { nodeType: number; nodeName: string; nodeValue: string | null; firstChild: FakeNode | null; nextSibling: FakeNode | null; textContent: string };
type Box = { type: string; checked: boolean; defaultChecked: boolean; labels: FakeNode[] };
function shimPage(code: string) {
  const listeners: Record<string, Listener[]> = {};
  const document = {
    readyState: "complete",
    addEventListener: (type: string, fn: Listener) => (listeners[type] ??= []).push(fn),
    createElement: () => ({ style: {} }),
    body: { appendChild() {} },
  };
  const sent: { form: string; data: object; consent?: { text: string } }[] = [];
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
}
const livePage = () => shimPage(flashDbShim("/d", "/api/sites/x/inbox").replace(/^<script>|<\/script>$/g, ""));

/**
 * A <label>'s markup as the browser's nodes: elements (named in capitals, or as written inside an
 * <svg>), and text with its character references read. textContent as the DOM has it.
 */
function labelOf(markup: string): FakeNode {
  const node = (nodeType: number, nodeValue: string | null, nodeName = "#text"): FakeNode => ({
    nodeType,
    nodeName,
    nodeValue,
    firstChild: null,
    nextSibling: null,
    textContent: nodeValue ?? "",
  });
  const root = node(1, null, "DIV");
  const open: { el: FakeNode; last: FakeNode | null }[] = [{ el: root, last: null }];
  const append = (child: FakeNode) => {
    const top = open.at(-1)!;
    if (top.last) top.last.nextSibling = child;
    else top.el.firstChild = child;
    top.last = child;
    return child;
  };
  const entities: Record<string, string> = { nbsp: "\u00a0", amp: "&", rsquo: "’", lt: "<", gt: ">" };
  for (const [token, closing, tag] of markup.matchAll(/<(\/?)([a-z0-9]+)[^>]*>|[^<]+/gi)) {
    if (!tag) append(node(3, token.replace(/&(\w+);/g, (_all, name: string) => entities[name] ?? `&${name};`)));
    else if (closing) open.pop();
    else {
      const inSvg = tag === "svg" || open.some((o) => o.el.nodeName === "svg");
      const el = append(node(1, null, inSvg ? tag : tag.toUpperCase()));
      if (!/^(br|input|img|wbr|hr|path)$/i.test(tag)) open.push({ el, last: null });
    }
  }
  const fill = (n: FakeNode): string => {
    if (n.nodeType !== 1) return n.nodeValue ?? "";
    let text = "";
    for (let c = n.firstChild; c; c = c.nextSibling) text += fill(c);
    n.textContent = text;
    return text;
  };
  fill(root);
  return root.firstChild?.nodeType === 1 && !root.firstChild.nextSibling ? root.firstChild : root;
}

test("a tick counts whatever elements the label's words are in, as a page made with React shows them", async () => {
  await fresh();
  // Each label as the page has it (JSX drops the line breaks between elements), and the words kept.
  const labels: [string, string][] = [
    [
      `<label class="flex gap-2"><input type="checkbox" id="news"><span><span class="font-medium">Join the Golden Crumb newsletter</span><span class="block text-sm">Email me news and offers. I can unsubscribe at any time.</span></span></label>`,
      "Join the Golden Crumb newsletter Email me news and offers. I can unsubscribe at any time.",
    ],
    [`<label><input type="checkbox">Email me news and offers<br>from Golden Crumb</label>`, "Email me news and offers from Golden Crumb"],
    [
      `<label><input type="checkbox"><span>Email me news and offers from Golden Crumb.</span><small class="block">I can unsubscribe at any time</small></label>`,
      "Email me news and offers from Golden Crumb. I can unsubscribe at any time",
    ],
    [`<label><input type="checkbox"><span>Email me news</span><small>(monthly)</small><b>Golden</b>&nbsp;<b>Crumb</b></label>`, "Email me news(monthly) Golden Crumb"],
    [`<label><input type="checkbox">  Email me news\n     and offers from <a href="/">Golden Crumb</a>. I can unsubscribe at any&nbsp;time.</label>`, NEWS],
    // An icon's <title> (and a style or a script) inside the label is no more part of its words than on the page.
    [
      `<label class="flex gap-2"><input type="checkbox" id="news"><svg aria-hidden="true" viewBox="0 0 20 20" class="h-5 w-5"><title>Envelope</title><path d="M2 4h16v12H2z"/></svg><span>${NEWS}</span></label>`,
      NEWS,
    ],
    [`<label><input type="checkbox"><svg viewBox="0 0 24 24" role="img"><title>Newsletter</title><path d="M0 0h24v24H0z"/></svg> ${NEWS}</label>`, NEWS],
    [`<label><input type="checkbox"><style>.tick{color:red}</style>Email me news<script>void 0</script> from Golden Crumb</label>`, "Email me news from Golden Crumb"],
  ];
  const page = livePage();
  for (const [i, [markup, words]] of labels.entries()) {
    const slug = `react${i}`;
    await site(slug, "owner", `<!doctype html><html><body><div id="root"><form><input name="email">${markup}<button>Join</button></form></div></body></html>`);
    const box: Box = { type: "checkbox", checked: true, defaultChecked: false, labels: [labelOf(markup)] };
    page.fire("click", box, true);
    page.fire("change", box, true);
    await page.db.send("signup", { email: `p${i}@example.com` }, { news: box });
    const sent = page.sent.at(-1)!;
    assert.deepEqual(sent.consent, { text: words }, markup);
    await send(slug, sent.data as Record<string, unknown>, { consent: sent.consent }, `203.0.113.${80 + i}`, sent.form);
    const [c] = await contactsOf(slug);
    assert.ok(Number(c.consent_at) > 0, `kept: ${markup}`);
    assert.equal(c.consent_text, words);
  }
  assert.ok(!page.logs.some((l) => l.startsWith("warn")), page.logs.join("\n"));
});

test("the app's page sends what the person agreed to only when they ticked the box themselves", async () => {
  const setup = shimPage;
  const box = (over: Partial<Box> = {}): Box => ({ type: "checkbox", checked: false, defaultChecked: false, labels: [labelOf("<label><input>  Email me\n   news from Golden Crumb </label>")], ...over });
  const live = livePage();
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
