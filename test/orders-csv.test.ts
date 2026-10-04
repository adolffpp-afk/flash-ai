import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
const { run } = await import("../src/lib/server/db.ts");
const { listOrders, markOrder } = await import("../src/lib/server/shop.ts");
const { messageRows } = await import("../src/lib/server/inbox.ts");
const { toCsv, csvName } = await import("../src/lib/csv.ts");

test("CSV files open cleanly in spreadsheets", () => {
  assert.equal(toCsv([["a", "b"], [1, null]]), "﻿a,b\r\n1,\r\n");
  assert.equal(toCsv([['Say "hi", Ana', "two\nlines"]]), '﻿"Say ""hi"", Ana","two\nlines"\r\n');
  assert.equal(toCsv([["=HYPERLINK(1)", "+1", "-2", "@x", "Montréal"]]), "﻿'=HYPERLINK(1),'+1,'-2,'@x,Montréal\r\n", "formulas stay text");
  assert.equal(csvName("Home · Golden Crumb Bakery", "orders"), "golden-crumb-bakery-orders.csv");
  assert.equal(csvName("", "messages"), "site-messages.csv");
});

test("form messages become one column per field", () => {
  const rows = messageRows([
    { id: "1", form: "contact", data: { name: "Ana", message: "Hi" }, createdAt: Date.UTC(2026, 9, 4, 15, 30), read: true },
    { id: "2", form: "booking", data: { name: "Bo", date: "Oct 5", guests: 4 }, createdAt: Date.UTC(2026, 9, 4, 16), read: false },
  ]);
  assert.deepEqual(rows, [
    ["Date", "Form", "name", "message", "date", "guests"],
    ["2026-10-04 15:30", "contact", "Ana", "Hi", undefined, undefined],
    ["2026-10-04 16:00", "booking", "Bo", undefined, "Oct 5", "4"],
  ]);
});

test("owners mark orders as done, and back", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'o@x.co', 'h', 0)");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('crumb-1', 'u1', 'Crumb', '<p>', 0, 0), ('other', 'u1', 'O', '<p>', 0, 0)");
  await run(
    `INSERT INTO site_orders (session_id, site_slug, item, quantity, amount, currency, email, name, address, created_at)
     VALUES ('cs_1', 'crumb-1', 'Cake', 1, 2500, 'cad', 'a@x.co', 'Ana', '', 1)`,
  );
  assert.equal((await listOrders("u1", "crumb-1"))[0].done, false);
  assert.equal(await markOrder("crumb-1", "cs_1", true), true);
  assert.equal((await listOrders("u1", "crumb-1"))[0].done, true);
  assert.equal(await markOrder("other", "cs_1", true), false, "only the site's own orders");
  assert.equal(await markOrder("crumb-1", "cs_1", false), true);
  assert.equal((await listOrders("u1", "crumb-1"))[0].done, false);
});
