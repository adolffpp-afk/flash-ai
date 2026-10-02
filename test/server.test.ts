import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import vm from "node:vm";
import { verifyWebhook } from "../src/lib/server/stripe.ts";
import { flashDbShim, injectHead } from "../src/lib/flashdb-shim.ts";

const secret = "whsec_test";
const sign = (payload: string, t: number, key = secret) =>
  `t=${t},v1=${createHmac("sha256", key).update(`${t}.${payload}`).digest("hex")}`;
const nowSec = () => Math.floor(Date.now() / 1000);

test("webhook: accepts a valid signature", () => {
  assert.equal(verifyWebhook("{}", sign("{}", nowSec()), secret), true);
});

test("webhook: rejects a wrong secret, tampered body, old timestamp or missing header", () => {
  assert.equal(verifyWebhook("{}", sign("{}", nowSec(), "other"), secret), false);
  assert.equal(verifyWebhook('{"x":1}', sign("{}", nowSec()), secret), false);
  assert.equal(verifyWebhook("{}", sign("{}", nowSec() - 1000), secret), false);
  assert.equal(verifyWebhook("{}", null, secret), false);
});

test("injectHead puts the script right after <head>", () => {
  assert.equal(injectHead("<html><head><title>a</title></head></html>", "<s/>"), "<html><head><s/><title>a</title></head></html>");
  assert.equal(injectHead("<p>hi</p>", "<s/>"), "<s/><p>hi</p>");
});

test("in-memory flashDB: add, list, update, remove", async () => {
  const code = flashDbShim(null).replace(/^<script>|<\/script>$/g, "");
  type Row = { id: string; text: string; done?: boolean };
  type DB = {
    add(c: string, d: object): Promise<Row>;
    list(c: string): Promise<Row[]>;
    update(c: string, id: string, d: object): Promise<Row>;
    remove(c: string, id: string): Promise<void>;
  };
  const window: { flashDB?: DB } = {};
  vm.runInNewContext(code, { window });
  const db = window.flashDB!;
  const a = await db.add("todos", { text: "milk", id: "spoofed" });
  assert.notEqual(a.id, "spoofed");
  await db.add("todos", { text: "eggs" });
  await db.update("todos", a.id, { done: true });
  const list = await db.list("todos");
  assert.equal(list.length, 2);
  assert.equal(list[0].done, true);
  list[0].text = "changed outside";
  assert.equal((await db.list("todos"))[0].text, "milk");
  await db.remove("todos", a.id);
  assert.equal(JSON.stringify((await db.list("todos")).map((r) => r.text)), '["eggs"]');
});
