import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANYONE,
  OWNER,
  OWNER_IN_APP,
  DATA_RULES,
  MAX_DECLARED,
  anyOpen,
  blockProblem,
  can,
  codeCollections,
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
  // The owner in the app itself, with the key from Open as owner, can do anything but see or change
  // what only they may see: only Flash shows that, so a script that gets into the page can't read it.
  for (const rule of DATA_RULES) {
    const got = (["read", "add", "change"] as const).map((action) => (can(rule, action, OWNER_IN_APP) ? "y" : "-")).join("");
    assert.equal(got, rule === "private" ? "-y-" : "yyy", rule);
  }
  assert.deepEqual(refusal("private", "read", OWNER_IN_APP), { status: 403, error: "You can see this in Flash, in My websites & apps › Data." });

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
  // flashDB.isOwner came with rules, so an app that checks it was made since: its changes are the owner's.
  assert.equal(guessRule(`<script>if (flashDB.isOwner) flashDB.remove("menu", id); flashDB.add("reviews", r)</script>`), "add", "owner-made, adds");
  assert.equal(guessRule(`<script>if (flashDB.isOwner) flashDB.update("menu", id, {}); flashDB.list("menu")</script>`), "read", "owner-made, reads");
});

test("the collections an app's code names are found", () => {
  assert.deepEqual(
    codeCollections(`<script>flashDB.list("menu"); flashDB.add('reviews', r); flashDB . update ( \`tasks\`, id); flashDB.mine.add("notes", n); flashDB.add("room-" + id, m); flashDB.remove(name, id)</script>`),
    ["menu", "reviews", "tasks"],
  );
});

test("the app's flash-data block is read, and anything Flash can't use in it is read-only", () => {
  assert.deepEqual(declaredRules(block(`{"menu":"read","reviews":"add"}`)), { menu: "read", reviews: "add" });
  assert.deepEqual(declaredRules(block(` { "menu" : "read" } `, `id='flash-data' type='application/json'`)), { menu: "read" }, "any attribute order");
  assert.deepEqual(declaredRules(`<script id="flash-data">{"menu":"read"}</script>`), { menu: "read" }, "without a type too");
  assert.deepEqual(declaredRules("<p>nothing</p>"), {});
  // The slips people make by hand are forgiven: comments and a comma before the end.
  assert.deepEqual(declaredRules(block(`{"menu":"read",}`)), { menu: "read" }, "a trailing comma");
  assert.deepEqual(
    declaredRules(block(`{\n  // what visitors may do\n  "menu": "read", /* the dishes */\n  "reviews": "add",\n}`)),
    { menu: "read", reviews: "add" },
    "comments",
  );
  // Only what's outside the quotes is a comment.
  const quoted = computeRules(block(`{"menu":"read","note":"see http://x.co/* here"}`));
  assert.deepEqual([quoted.app, quoted.bad], [{ menu: "read", note: "read" }, { why: "entries", names: ["note"] }]);

  // A block Flash can't read at all makes everything read-only for visitors, and says why.
  const code = `<script>flashDB.update("a", id, {})</script>`;
  for (const [json, why] of [
    [`{oops`, "json"],
    [`{"menu":"read" /* never closed`, "json"],
    [`"read"`, "shape"],
    [`{"menu":"read","pad":"${"x".repeat(4096)}"}`, "long"],
  ] as const) {
    assert.deepEqual(computeRules(block(json) + code), { v: 1, guess: "read", app: {}, block: true, bad: { why, names: [] }, code: ["a"] }, why);
  }
  assert.equal(computeRules(`<script type="application/json" id="flash-data">{"menu":"read"}`).bad?.why, "unclosed");

  // Names and rules it can't use are read-only, and named; "*" is the rule for everything else.
  const odd = computeRules(block(`{"menu":"read","two words":"add","*":"open","${"x".repeat(41)}":"add","tips":"write","n":1,"ok_1":"private"}`));
  assert.deepEqual(odd.app, { menu: "read", tips: "read", n: "read", ok_1: "private" });
  assert.equal(odd.guess, "open");
  assert.deepEqual(odd.bad, { why: "entries", names: ["two words", "x".repeat(40), "tips", "n"] });
  assert.deepEqual(computeRules(block(`{"*":"write"}`)).bad, { why: "entries", names: ["*"] });
  assert.equal(computeRules(block(`{"*":"write"}`)).guess, "read", "a bad default is read-only");

  const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`c${i}`, "add"]));
  assert.equal(Object.keys(declaredRules(block(JSON.stringify(many)))).length, MAX_DECLARED, "at most 50 entries");
  assert.equal(computeRules(block(JSON.stringify(many))).bad?.names.length, 10);
  assert.deepEqual(declaredRules(block(`{"a":"read"}`) + block(`{"a":"open","b":"open"}`)), { a: "read" }, "the first block wins");
  assert.deepEqual(declaredRules(`<script data-id="flash-data">{"a":"open"}</script>`), {}, "only the id itself counts");

  // A script that only shares the id isn't rules: code, or the app's own data (rules are words).
  for (const other of [
    `<script id="flash-data" src="/app.js"></script>`,
    `<script id="flash-data" type="module">flashDB.list("x")</script>`,
    block(`[{"q":"2+2","a":"4"}]`),
    block(`{"cards":[{"q":"2+2"}],"count":1}`),
  ]) {
    const computed = computeRules(other + code);
    assert.equal(computed.block, undefined, other);
    assert.equal(computed.guess, "open", other);
  }
  assert.deepEqual(declaredRules(block(`{"cards":[]}`) + block(`{"menu":"read"}`)), { menu: "read" }, "the rules after the app's own data");

  // A page made to be slow to read is read as quickly as any other.
  let started = Date.now();
  computeRules("<script".repeat(300_000) + "<script id=flash-data " + "a".repeat(1_000_000));
  assert.ok(Date.now() - started < 1000);
  started = Date.now();
  computeRules((block(`["${"<script id=flash-data>".repeat(170)}"]`) + "\n").repeat(500));
  assert.ok(Date.now() - started < 1000, "many blocks of the app's own data");
  // A collection called __proto__ is just a name.
  assert.equal(Object.getPrototypeOf(declaredRules(block(`{"__proto__":"open"}`))), Object.prototype);
});

test("the owner's choice beats the app's, which beats the owner's default, which beats the guess", () => {
  const computed = { v: 1 as const, guess: "open" as const, app: { menu: "read" as const } };
  assert.deepEqual(effectiveRule(computed, "add", "private", "menu"), { rule: "add", source: "you" });
  assert.deepEqual(effectiveRule(computed, null, "private", "menu"), { rule: "read", source: "app" });
  assert.deepEqual(effectiveRule(computed, null, "private", "reviews"), { rule: "private", source: "default" });
  assert.deepEqual(effectiveRule(computed, null, null, "reviews"), { rule: "open", source: "guess" });
  assert.deepEqual(effectiveRule(computed, "nonsense", "also bad", "reviews"), { rule: "open", source: "guess" }, "bad saved values are skipped");
  assert.deepEqual(effectiveRule(computed, null, null, "constructor"), { rule: "open", source: "guess" });
  // For an app with a block, everything else takes the block's rule.
  assert.deepEqual(effectiveRule({ ...computed, guess: "read", block: true }, null, null, "reviews"), { rule: "read", source: "block" });

  // What's saved comes back the same, and damaged rules come back as nothing, to be worked out again.
  assert.deepEqual(parseComputed(JSON.stringify(computed)), computed);
  const full = { v: 1 as const, guess: "open" as const, app: {}, block: true as const, bad: { why: "entries" as const, names: ["x y"] }, fromRecords: true as const, code: ["menu"] };
  assert.deepEqual(parseComputed(JSON.stringify(full)), full);
  assert.deepEqual(parseComputed(`{"v":1,"guess":"read","app":{},"bad":{"why":"nope"},"code":["ok","bad name",3],"block":1}`), { v: 1, guess: "read", app: {}, code: ["ok"] });
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
  // What Flash couldn't use, and what an update closed, come first, even for an app with nothing else to say.
  assert.equal(
    dataLine({ collections: [], other: "read", bad: { why: "json", names: [] } }),
    "Flash couldn't read this app's flash-data block because it isn't valid JSON, so visitors can only read its data until it's fixed.",
  );
  assert.equal(
    blockProblem({ why: "entries", names: ["tips", "n"] }),
    "Flash couldn't use part of this app's flash-data block (tips, n), so those collections are read-only for visitors until it's fixed.",
  );
  assert.equal(
    dataLine({ collections: [{ name: "todos", rule: "read", source: "block" }], other: "read", closed: ["todos"] }),
    "Visitors can no longer add to or change todos, because your app's flash-data block doesn't name it. Who can change this app's data: todos — only you · anything else — only you. Change it in My websites & apps › Data.",
  );
  assert.match(dataLine({ collections: [], other: "read", closed: ["a", "b"] }), /^Visitors can no longer add to or change a, b, because your app's flash-data block doesn't name them\.$/);
});

test("an app that declares its data is strict about collections it didn't name, unless it gives them a rule", () => {
  const html = block(`{"reviews":"add"}`) + `<script>flashDB.update("todos", id, {}); flashDB.add("reviews", r)</script>`;
  const computed = computeRules(html);
  assert.deepEqual(computed, { v: 1, guess: "read", app: { reviews: "add" }, block: true, code: ["todos", "reviews"] });
  assert.deepEqual(effectiveRule(computed, null, null, "todos"), { rule: "read", source: "block" });
  assert.equal(computeRules(block("{}")).guess, "read", "even an empty declaration");
  // Names made while the app runs ("room-" + id) can't be listed, so "*" gives them all a rule.
  const rooms = computeRules(block(`{"reviews":"add","*":"own"}`) + `<script>flashDB.add("room-" + id, m)</script>`);
  assert.deepEqual(effectiveRule(rooms, null, null, "room-12"), { rule: "own", source: "block" });
  assert.deepEqual(rooms.app, { reviews: "add" });
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
