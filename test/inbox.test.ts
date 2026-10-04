import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
const { run, one } = await import("../src/lib/server/db.ts");
const { receiveMessage, readMessages, ownsSite, sitesWithMessages, deleteMessage } = await import("../src/lib/server/inbox.ts");
const { buildSystem } = await import("../src/lib/engines/builder.ts");
const { flashDbShim } = await import("../src/lib/flashdb-shim.ts");

const status = (r: { ok: true } | { status: number }) => ("status" in r ? r.status : 200);

test("site forms reach only the owner, marked read once seen", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'owner@x.co', 'h', 0), ('u2', 'other@x.co', 'h', 0)");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('bakery-1', 'u1', 'Crumb Bakery', '<p>', 0, 0)");
  const sent = await receiveMessage("bakery-1", { form: "contact", data: { name: "Ana", email: "ana@example.com", message: "Do you bake gluten-free?" } }, "1.1.1.1", "https://www.flash-app.dev");
  assert.deepEqual(sent, { ok: true });

  assert.equal(status(await receiveMessage("bakery-1", { form: "bad name!", data: {} }, "1.1.1.1", "")), 400);
  assert.equal(status(await receiveMessage("bakery-1", { form: "contact", data: ["x"] }, "1.1.1.1", "")), 400);
  assert.equal(status(await receiveMessage("bakery-1", { form: "contact", data: { m: "x".repeat(20_000) } }, "1.1.1.1", "")), 413);
  assert.equal(status(await receiveMessage("nope", { form: "contact", data: { a: 1 } }, "2.2.2.2", "")), 404);

  assert.equal(await ownsSite("u1", "bakery-1"), true);
  assert.equal(await ownsSite("u2", "bakery-1"), false);
  assert.deepEqual(
    (await sitesWithMessages("u1")).map((s) => [s.slug, s.messages, s.unread]),
    [["bakery-1", 1, 1]],
  );
  const [first] = await readMessages("bakery-1");
  assert.equal(first.form, "contact");
  assert.equal(first.data.email, "ana@example.com");
  assert.equal(first.read, false, "shows as new the first time");
  assert.equal((await readMessages("bakery-1"))[0].read, true);
  assert.equal((await sitesWithMessages("u1"))[0].unread, 0);
  // The public flashDB data API never sees form messages.
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_records"))?.n, 0);

  await deleteMessage("bakery-1", first.id);
  assert.deepEqual(await readMessages("bakery-1"), []);
});

test("one visitor can send at most 10 forms an hour", async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await receiveMessage("bakery-1", { form: "contact", data: { i } }, "9.9.9.9", "");
  assert.equal(status(last!), 429);
  assert.equal((await readMessages("bakery-1")).length, 10);
});

test("unpublishing a site removes its messages", async () => {
  await run("DELETE FROM sites WHERE slug = 'bakery-1'");
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_messages"))?.n, 0);
});

test("the app builder makes multi-page sites and sends forms privately", () => {
  const system = buildSystem("app", "");
  assert.match(system, /<section data-page="name">/);
  assert.match(system, /href="#\/name"/);
  assert.match(system, /flashDB\.send\("contact"/);
  assert.doesNotMatch(buildSystem("slides", ""), /data-page/);
  assert.match(flashDbShim("/api/sites/x/data", "/api/sites/x/inbox"), /"\/api\/sites\/x\/inbox"/);
  assert.match(flashDbShim(null), /async send\(form, data\)/, "the preview has send too, without sending");
});
