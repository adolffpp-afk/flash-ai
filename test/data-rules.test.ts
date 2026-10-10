import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANYONE,
  OWNER,
  DATA_RULES,
  MAX_DECLARED,
  anyOpen,
  can,
  computeRules,
  dataLine,
  declaredRules,
  effectiveRule,
  guessRule,
  looksPersonal,
  parseComputed,
  refusal,
  type Caller,
  type DataAction,
} from "../src/lib/data-rules.ts";

const block = (json: string, attrs = 'type="application/json" id="flash-data"') => `<script ${attrs}>${json}</script>`;

test("who may do what under each data rule", () => {
  const ann: Caller = { kind: "visitor", id: "ann" };
  const bob: Caller = { kind: "visitor", id: "bob" };
  // Each string is [anyone, the signed-in author, another signed-in person, the owner] for a record Ann added.
  const expected: Record<string, Record<DataAction, string>> = {
    open: { read: "yyyy", add: "yyyy", change: "yyyy" },
    add: { read: "yyyy", add: "yyyy", change: "-y-y" },
    own: { read: "yyyy", add: "-yyy", change: "-y-y" },
    read: { read: "yyyy", add: "---y", change: "---y" },
    private: { read: "---y", add: "yyyy", change: "---y" },
  };
  for (const rule of DATA_RULES) {
    for (const action of ["read", "add", "change"] as const) {
      const got = [ANYONE, ann, bob, OWNER].map((caller) => (can(rule, action, caller, "ann") ? "y" : "-")).join("");
      assert.equal(got, expected[rule][action], `${rule} ${action}`);
    }
  }
  // A record nobody signed in added belongs to nobody, not to a visitor without an id.
  assert.equal(can("add", "change", { kind: "visitor", id: "" }, ""), false);
  assert.equal(can("own", "change", ann, ""), false);

  assert.deepEqual(refusal("own", "add", ANYONE), { status: 401, error: "Sign in to add here." });
  assert.deepEqual(refusal("private", "read", ann), { status: 403, error: "Only this app's owner can see this." });
  assert.deepEqual(refusal("add", "change", bob), { status: 403, error: "You can only change or delete what you added." });
  assert.deepEqual(refusal("own", "change", ANYONE), { status: 403, error: "You can only change or delete what you added." });
  assert.deepEqual(refusal("read", "add", ann), { status: 403, error: "Only this app's owner can change this." });
});

test("Flash guesses a rule for apps made before rules existed", () => {
  assert.equal(guessRule(`<script>flashDB.list("menu").then(show)</script>`), "read", "list only");
  assert.equal(guessRule(`<script>await flashDB.list("reviews"); await flashDB.add("reviews", r)</script>`), "add", "add only");
  assert.equal(guessRule(`<script>flashDB.add("todos", t); flashDB.update("todos", id, { done: true })</script>`), "open", "update");
  assert.equal(guessRule(`<script>window.flashDB.remove("todos", id)</script>`), "open", "remove");
  assert.equal(guessRule(`<script>flashDB . update ("x", id, {})</script>`), "open", "spaces");
  // Each person's own records don't count.
  assert.equal(
    guessRule(`<script>flashDB.list("menu"); flashDB.mine.add("notes", n); flashDB.mine.remove("notes", id); flashDB?.mine?.update("n", id, {})</script>`),
    "read",
    "mine ignored",
  );
  // What can't be followed keeps working: anyone may change anything.
  assert.equal(guessRule(`<script>const db = flashDB; db.add("x", {})</script>`), "open", "alias");
  assert.equal(guessRule(`<script>const db = window.flashDB;</script>`), "open", "alias from window");
  assert.equal(guessRule(`<script>flashDB["update"]("x", id, {})</script>`), "open", "bracket access");
  assert.equal(guessRule(`<script>if (typeof flashDB !== "undefined") flashDB.list("x")</script>`), "open", "typeof");
  assert.equal(guessRule(`<script>flashDB?.remove("x", id)</script>`), "open", "optional chaining");
  assert.equal(guessRule(`<script>flashDB?.add("x", {})</script>`), "add", "optional chaining add");
  assert.equal(guessRule(`<h1>A menu</h1><p>No database here.</p>`), "read", "no flashDB");
  assert.equal(guessRule(`<script>myflashDBthing.update()</script>`), "read", "only the real name counts");
});

test("the app's flash-data block is read, and anything odd in it is ignored", () => {
  assert.deepEqual(declaredRules(block(`{"menu":"read","reviews":"add"}`)), { menu: "read", reviews: "add" });
  assert.deepEqual(declaredRules(block(` { "menu" : "read" } `, `id='flash-data' type='application/json'`)), { menu: "read" }, "any attribute order");
  assert.deepEqual(declaredRules("<p>nothing</p>"), {});
  assert.deepEqual(declaredRules(block(`{"menu":"read",}`)), {}, "bad JSON");
  assert.deepEqual(declaredRules(block(`["menu"]`)), {}, "not an object");
  assert.deepEqual(declaredRules(block(`{"menu":"read","pad":"${"x".repeat(4096)}"}`)), {}, "more than 4,096 characters");
  assert.deepEqual(
    declaredRules(block(`{"menu":"read","two words":"add","*":"open","${"x".repeat(41)}":"add","tips":"write","n":1,"ok_1":"private"}`)),
    { menu: "read", ok_1: "private" },
    "bad names or values",
  );
  const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`c${i}`, "add"]));
  assert.equal(Object.keys(declaredRules(block(JSON.stringify(many)))).length, MAX_DECLARED, "at most 50 entries");
  assert.deepEqual(declaredRules(block(`{"a":"read"}`) + block(`{"a":"open","b":"open"}`)), { a: "read" }, "the first block wins");
  assert.deepEqual(declaredRules(`<script data-id="flash-data">{"a":"open"}</script>`), {}, "only the id itself counts");
  // A page made to be slow to read is read as quickly as any other.
  const started = Date.now();
  computeRules("<script".repeat(300_000) + "<script id=flash-data " + "a".repeat(1_000_000));
  assert.ok(Date.now() - started < 1000);
  // A collection called __proto__ is just a name.
  assert.equal(Object.getPrototypeOf(declaredRules(block(`{"__proto__":"open"}`))), Object.prototype);

  // A bad block is ignored: the rules come from the code, as for an app without one.
  assert.equal(computeRules(block(`{oops`) + `<script>flashDB.update("a", id, {})</script>`).guess, "open");
});

test("the owner's choice beats the app's, which beats the owner's default, which beats the guess", () => {
  const computed = { v: 1 as const, guess: "open" as const, app: { menu: "read" as const } };
  assert.deepEqual(effectiveRule(computed, "add", "private", "menu"), { rule: "add", source: "you" });
  assert.deepEqual(effectiveRule(computed, null, "private", "menu"), { rule: "read", source: "app" });
  assert.deepEqual(effectiveRule(computed, null, "private", "reviews"), { rule: "private", source: "default" });
  assert.deepEqual(effectiveRule(computed, null, null, "reviews"), { rule: "open", source: "guess" });
  assert.deepEqual(effectiveRule(computed, "nonsense", "also bad", "reviews"), { rule: "open", source: "guess" }, "bad saved values are skipped");
  assert.deepEqual(effectiveRule(computed, null, null, "constructor"), { rule: "open", source: "guess" });

  // What's saved comes back the same, and damaged rules come back as nothing, to be worked out again.
  assert.deepEqual(parseComputed(JSON.stringify(computed)), computed);
  for (const bad of ["", "{", "null", `{"v":2,"guess":"read","app":{}}`, `{"v":1,"guess":"write","app":{}}`, `{"v":1,"guess":"read","app":[]}`]) {
    assert.equal(parseComputed(bad), null, bad);
  }
  assert.deepEqual(parseComputed(`{"v":1,"guess":"read","app":{"menu":"read","bad name":"add","x":"nope"}}`)!.app, { menu: "read" });

  // Whether anyone could change something, for the warning in My websites & apps.
  assert.equal(anyOpen(computed, {}), true, "the guess for anything else is open");
  assert.equal(anyOpen(computed, { "*": "read" }), false, "the owner's default covers it");
  assert.equal(anyOpen(computed, { "*": "read", menu: "open" }), true);
  assert.equal(anyOpen({ v: 1, guess: "read", app: { list: "open" } }, {}), true, "the app opened one itself");
  assert.equal(anyOpen({ v: 1, guess: "read", app: { list: "open" } }, { list: "add" }), false);

  assert.equal(
    dataLine({ collections: [{ name: "menu", rule: "read", source: "app" }, { name: "reviews", rule: "add", source: "app" }], other: "read" }),
    "Who can change this app's data: menu — only you · reviews — visitors can add · anything else — only you. Change it in My websites & apps › Data.",
  );
  assert.equal(dataLine({ collections: [], other: "read" }), "", "nothing to say for a plain website");
  assert.match(dataLine({ collections: [], other: "open" }), /anything else — anyone can change anything/);
});

test("an app that declares its data is strict about collections it didn't name", () => {
  const html = block(`{"reviews":"add"}`) + `<script>flashDB.update("todos", id, {}); flashDB.add("reviews", r)</script>`;
  const computed = computeRules(html);
  assert.deepEqual(computed, { v: 1, guess: "read", app: { reviews: "add" } });
  assert.equal(effectiveRule(computed, null, null, "todos").rule, "read");
  assert.equal(computeRules(block("{}")).guess, "read", "even an empty declaration");
  // Without a block, the same code would let anyone change anything.
  assert.equal(computeRules(`<script>flashDB.update("todos", id, {})</script>`).guess, "open");
});

test("personal details are spotted by field name", () => {
  assert.deepEqual(
    looksPersonal(["email", "userEmail", "phone_number", "Address", "dob", "e-mail", "telephone", "zipCode", "cardNumber", "IBAN", "birthday", "tel"]),
    ["email", "userEmail", "phone_number", "Address", "dob", "e-mail", "telephone", "zipCode", "cardNumber", "IBAN", "birthday", "tel"],
  );
  assert.deepEqual(looksPersonal(["title", "price", "notes", "hotel", "discard", "zipper", "name", "score"]), []);
});
