import { test } from "node:test";
import assert from "node:assert/strict";
import type { UIMessage } from "../src/lib/store.ts";

process.env.DATABASE_URL = ":memory:";
const { PENDING_LIMIT_MS, changeMessages, cleanUserMessage, keepRunning, placeReply, placeTurn, requestTurn, saveCopy, saveReply, saveTurn, unfinished } = await import(
  "../src/lib/server/turns.ts"
);
const { one, run } = await import("../src/lib/server/db.ts");

const user = (id: string, content = id): UIMessage => ({ id, role: "user", content });
const answer = (id: string, content = id): UIMessage => ({ id, role: "assistant", content });
const pending = (id: string): UIMessage => ({ id, role: "assistant", content: "", pending: true, pendingSince: Date.now() });
const ids = (messages: UIMessage[]) => messages.map((m) => m.id);

test("a new turn goes after the last message", () => {
  const chat = [user("u1"), answer("a1")];
  assert.deepEqual(ids(placeTurn(chat, { user: user("u2"), afterId: "a1", reply: pending("r2") })), ["u1", "a1", "u2", "r2"]);
  assert.deepEqual(ids(placeTurn([], { user: user("u1"), afterId: null, reply: pending("r1") })), ["u1", "r1"]);
});

test("Retry and Edit answer the last message again, in place of the old reply", () => {
  const chat = [user("u1"), answer("a1"), user("u2"), answer("a2")];
  // Retry: the same message, a new reply, after the message before it.
  assert.deepEqual(ids(placeTurn(chat, { user: user("u2"), afterId: "a1", reply: pending("r3") })), ["u1", "a1", "u2", "r3"]);
  // Edit keeps the message's id with new words.
  const edited = placeTurn(chat, { user: user("u2", "new words"), afterId: "a1", reply: pending("r3") });
  assert.equal(edited[2].content, "new words");
  assert.equal(edited.length, 4);
  // Retrying the first message of a chat.
  assert.deepEqual(ids(placeTurn([user("u1"), answer("a1")], { user: user("u1"), afterId: null, reply: pending("r2") })), ["u1", "r2"]);
});

test("a turn after a message that isn't saved yet goes last, and saving it twice keeps one copy", () => {
  const chat = [user("u1"), answer("a1")];
  const turn = { user: user("u2"), afterId: "local-invoice", reply: pending("r2") };
  const once = placeTurn(chat, turn);
  assert.deepEqual(ids(once), ["u1", "a1", "u2", "r2"]);
  assert.deepEqual(ids(placeTurn(once, turn)), ["u1", "a1", "u2", "r2"]);
});

test("the finished reply replaces its pending one, or comes back after an older copy was saved over it", () => {
  const turn = { user: user("u2"), afterId: "a1", reply: pending("r2") };
  const done = answer("r2", "the answer");
  const running = [user("u1"), answer("a1"), user("u2"), pending("r2")];
  assert.deepEqual(placeReply(running, turn, done), [user("u1"), answer("a1"), user("u2"), done]);
  // Another tab saved the chat as it was before this turn: the turn comes back after its message.
  assert.deepEqual(ids(placeReply([user("u1"), answer("a1"), user("x"), answer("y")], turn, done)!), ["u1", "a1", "u2", "r2", "x", "y"]);
  // The chat's first turn, saved over by an empty copy.
  assert.deepEqual(ids(placeReply([], { user: user("u1"), afterId: null, reply: pending("r1") }, answer("r1"))!), ["u1", "r1"]);
  // Retry while it ran: the message is there with another reply, so this one isn't put back.
  assert.equal(placeReply([user("u1"), answer("a1"), user("u2"), pending("r3")], turn, done), null);
});

test("only a user message's own fields are kept, each of a sensible size", () => {
  const m = cleanUserMessage({
    id: "m1",
    role: "assistant",
    content: "Make it darker",
    attachmentName: "The picture above",
    pictureAbove: "/api/files/abc",
    template: { engine: "docs", name: "Invoice", model: "x" },
    build: "app",
    picked: { label: "button", context: "Change only this part" },
    queued: true,
    voice: "yes",
    cost: 999,
    app: { html: "<script>" },
  });
  assert.deepEqual(m, {
    id: "m1",
    role: "user",
    content: "Make it darker",
    attachmentName: "The picture above",
    template: { engine: "docs", name: "Invoice", model: "x" },
    queued: true,
    build: "app",
    picked: { label: "button", context: "Change only this part" },
    pictureAbove: "/api/files/abc",
  });
  assert.equal(cleanUserMessage({ id: "m1", content: "x".repeat(100_001) }), null);
  assert.equal(cleanUserMessage({ id: "../x", content: "hi" }), null);
  assert.equal(cleanUserMessage("hi"), null);
  assert.equal(cleanUserMessage({ id: "m1", content: "hi", template: { engine: "nope", name: "T" } })?.template, undefined);
  assert.equal(cleanUserMessage({ id: "m1", content: "hi", pictureAbove: "x".repeat(3000) })?.pictureAbove, true);
});

test("a request's turn is saved only with a reply id, a user message and the message it follows", () => {
  const userMessage = { id: "m2", role: "user", content: "Hi" };
  assert.deepEqual(requestTurn({ replyId: "r2", userMessage, afterId: "a1" }), {
    user: { id: "m2", role: "user", content: "Hi" },
    afterId: "a1",
    reply: { id: "r2", role: "assistant", content: "", pending: true },
  });
  assert.equal(requestTurn({ replyId: "r1", userMessage, afterId: null })?.afterId, null, "a chat's first turn");
  // A page loaded before the server saved turns sends none of them.
  assert.equal(requestTurn({}), null);
  assert.equal(requestTurn({ replyId: "r2", userMessage }), null, "where it goes is unknown");
  assert.equal(requestTurn({ replyId: "r2", userMessage, afterId: "../a1" }), null);
  assert.equal(requestTurn({ replyId: "r 2", userMessage, afterId: "a1" }), null);
  assert.equal(requestTurn({ replyId: "m2", userMessage, afterId: "a1" }), null, "the reply can't be the message itself");
  assert.equal(requestTurn({ replyId: "r2", userMessage: { id: "m2" }, afterId: "a1" }), null);
});

test("a reply pending long after its request's time ran out shows as not finished", () => {
  const now = Date.now();
  const fresh = { ...pending("r1"), pendingSince: now - 60_000 };
  const dead = { ...pending("r2"), pendingSince: now - PENDING_LIMIT_MS - 1 };
  const [kept, ended] = unfinished([fresh, dead], "Didn't finish.", now);
  assert.equal(kept.pending, true);
  assert.equal(ended.pending, undefined);
  assert.equal(ended.error, "Didn't finish.");
});

async function project(id: string, messages: UIMessage[] = [], name = "New project") {
  await run("INSERT OR IGNORE INTO users (id, email, password_hash, created_at) VALUES ('u', 'u@t.io', 'x', 0)");
  await run("INSERT INTO projects (id, user_id, name, messages, updated_at) VALUES (?, 'u', ?, ?, 0)", [id, name, JSON.stringify(messages)]);
}
const saved = async (id: string) => {
  const row = await one<{ name: string; messages: string; version: number }>("SELECT name, messages, version FROM projects WHERE id = ?", [id]);
  return { name: row!.name, messages: JSON.parse(row!.messages) as UIMessage[], version: Number(row!.version) };
};
// The browser's autosave (PUT /api/projects/[id]), which writes its whole copy and raises the version.
const browserSave = (id: string, messages: UIMessage[]) =>
  run("UPDATE projects SET messages = ?, version = version + 1 WHERE id = ?", [JSON.stringify(messages), id]);

test("the server saves the turn as it starts and the reply as it ends, and names a new chat", async () => {
  await project("p1");
  const turn = { user: user("u1", "Write a poem about the sea, with a long title that goes on"), afterId: null, reply: pending("r1") };
  assert.equal(await saveTurn("u", "p1", turn), true);
  let row = await saved("p1");
  assert.equal(row.name, "Write a poem about the sea, with a long");
  assert.deepEqual(ids(row.messages), ["u1", "r1"]);
  assert.equal(row.messages[1].pending, true);
  assert.equal(row.version, 1);

  const done = { ...answer("r1", "The sea…"), cost: 3 };
  assert.equal(await saveReply("u", "p1", turn, done), true);
  row = await saved("p1");
  assert.deepEqual(row.messages[1], done);
  assert.equal(row.version, 2);
  // Only the first message names a chat.
  await saveTurn("u", "p1", { user: user("u2", "Shorter"), afterId: "r1", reply: pending("r2") });
  assert.equal((await saved("p1")).name, "Write a poem about the sea, with a long");
});

test("a reply finished after the browser saved over the chat is put back, never lost", async () => {
  await project("p2", [user("u1"), answer("a1")], "Poems");
  const turn = { user: user("u2"), afterId: "a1", reply: pending("r2") };
  await saveTurn("u", "p2", turn);
  // A save the browser sent just before the request lands after the server's.
  await browserSave("p2", [user("u1"), answer("a1")]);
  await saveReply("u", "p2", turn, answer("r2", "kept"));
  const row = await saved("p2");
  assert.deepEqual(ids(row.messages), ["u1", "a1", "u2", "r2"]);
  assert.equal(row.messages[3].content, "kept");
});

test("a reply finished after Retry is left out, and the retried one is untouched", async () => {
  await project("p3", [user("u1"), answer("a1")], "Retry");
  const first = { user: user("u2"), afterId: "a1", reply: pending("r2") };
  await saveTurn("u", "p3", first);
  const retried = { user: user("u2"), afterId: "a1", reply: pending("r3") };
  await saveTurn("u", "p3", retried);
  assert.equal(await saveReply("u", "p3", first, answer("r2", "old")), false);
  await saveReply("u", "p3", retried, answer("r3", "new"));
  assert.deepEqual((await saved("p3")).messages.map((m) => m.content), ["u1", "a1", "u2", "new"]);
});

test("a write never lands on top of one saved since it read the chat: it reads again", async () => {
  await project("p4", [user("u1"), answer("a1")], "Race");
  let tries = 0;
  const ok = await changeMessages("u", "p4", (messages) => {
    tries++;
    // The browser saves (with a change of its own) between the server's read and its write.
    if (tries === 1) void browserSave("p4", [user("u1"), { ...answer("a1"), app: { title: "T", html: "<p/>", kind: "app", slug: "my-app" } }]);
    return { messages: [...messages, user("u2")] };
  });
  // The UPDATE above runs before this write: the first try finds a newer version and reads again.
  assert.equal(ok, true);
  assert.equal(tries, 2);
  const row = await saved("p4");
  assert.equal(row.messages[1].app?.slug, "my-app", "the browser's change is kept");
  assert.deepEqual(ids(row.messages), ["u1", "a1", "u2"]);
  assert.equal(row.version, 2);
});

test("saving a turn never undoes a rename saved since it read the chat", async () => {
  await project("p6", [user("u1"), answer("a1")], "Old name");
  let renamed = false;
  const ok = await changeMessages("u", "p6", (messages) => {
    // Renaming doesn't raise the version, so this write goes ahead; it mustn't put the old name back.
    if (!renamed) void run("UPDATE projects SET name = 'New name' WHERE id = 'p6'");
    renamed = true;
    return { messages: [...messages, user("u2")] };
  });
  assert.equal(ok, true);
  const row = await saved("p6");
  assert.equal(row.name, "New name");
  assert.deepEqual(ids(row.messages), ["u1", "a1", "u2"]);
});

test("a deleted chat or another user's isn't written", async () => {
  await project("p5", [], "Mine");
  assert.equal(await saveTurn("someone-else", "p5", { user: user("u1"), afterId: null, reply: pending("r1") }), false);
  assert.equal(await saveReply("u", "gone", { user: user("u1"), afterId: null, reply: pending("r1") }, answer("r1")), false);
  assert.deepEqual((await saved("p5")).messages, []);
});

// The browser's save as PUT /api/projects/[id] makes it: its copy, merged with what the server is working on.
const pageSave = (id: string, messages: UIMessage[]) => saveCopy("u", id, messages);

test("a save from the page never replaces a reply the server is still working on (Share, a tab that gave up)", async () => {
  await project("k1", [user("u1"), answer("a1")], "Share");
  const turn = { user: user("u2"), afterId: "a1", reply: pending("r2") };
  await saveTurn("u", "k1", turn);
  // Share saves the page's copy with pending taken off: a partial answer, or an error from a tab that gave up.
  await pageSave("k1", [user("u1"), answer("a1"), user("u2"), { ...answer("r2", "partial"), error: "Flash couldn't finish this answer." }]);
  let row = await saved("k1");
  assert.equal(row.messages[3].pending, true, "still the server's to finish");
  await saveReply("u", "k1", turn, answer("r2", "FULL ANSWER"));
  // The page still shows it pending until its next check: its save keeps the finished answer.
  await pageSave("k1", [user("u1"), { ...answer("a1"), app: { title: "T", html: "<p/>", kind: "app", slug: "mine" } }, user("u2"), { ...pending("r2"), content: "part" }]);
  row = await saved("k1");
  assert.equal(row.messages[3].content, "FULL ANSWER");
  assert.equal(row.messages[1].app?.slug, "mine", "the page's own change is saved");
  // Once the page has it, its copy is saved as it is.
  await pageSave("k1", [user("u1"), answer("a1"), user("u2"), answer("r2", "edited")]);
  assert.equal((await saved("k1")).messages[3].content, "edited");
});

test("a tab with an older copy can't take out a turn the server is working on", async () => {
  await project("k2", [user("u1"), answer("a1")], "Two tabs");
  const turn = { user: user("u2"), afterId: "a1", reply: pending("r2") };
  await saveTurn("u", "k2", turn);
  // The laptop's copy is from before the phone asked, with a change of its own.
  await pageSave("k2", [user("u1"), { ...answer("a1"), content: "a1 edited" }]);
  let row = await saved("k2");
  assert.deepEqual(ids(row.messages), ["u1", "a1", "u2", "r2"]);
  assert.equal(row.messages[1].content, "a1 edited");
  assert.equal(row.messages[3].pending, true);
  await saveReply("u", "k2", turn, answer("r2", "kept"));
  row = await saved("k2");
  assert.deepEqual(ids(row.messages), ["u1", "a1", "u2", "r2"]);
  assert.equal(row.messages[3].content, "kept");
});

test("a save sent just before Retry lands after it without dropping the retried reply", async () => {
  await project("k3", [user("u1"), answer("a1"), user("u2"), answer("a2")], "Retry race");
  const retried = { user: user("u2"), afterId: "a1", reply: pending("r3") };
  await saveTurn("u", "k3", retried);
  // The autosave of the finished a2, slow on a cold start, arrives now.
  await pageSave("k3", [user("u1"), answer("a1"), user("u2"), answer("a2")]);
  assert.deepEqual(ids((await saved("k3")).messages), ["u1", "a1", "u2", "r3"]);
  assert.equal(await saveReply("u", "k3", retried, answer("r3", "again")), true);
  assert.deepEqual((await saved("k3")).messages.map((m) => m.content), ["u1", "a1", "u2", "again"]);
});

test("a pending reply the server hasn't saved stays pending, so its answer can still go in its place", () => {
  const at = Date.now();
  const merged = keepRunning([user("u1")], [user("u1"), { id: "r1", role: "assistant", content: "", pending: true }], at);
  assert.equal(merged[1].pending, true);
  assert.equal(merged[1].pendingSince, at);
  // One the server gave up on long ago is saved as the page has it.
  const dead = { ...pending("r2"), pendingSince: at - PENDING_LIMIT_MS - 1 };
  assert.equal(keepRunning([user("u2"), dead], [user("u2"), answer("r2", "error copy")], at)[1].content, "error copy");
  assert.deepEqual(ids(keepRunning([user("u2"), dead], [], at)), [], "and isn't put back");
});

test("a copy can't keep a reply pending past its request's time, whatever time it gives", () => {
  const at = Date.now();
  const forever = { id: "r1", role: "assistant" as const, content: "", pending: true, pendingSince: at + 365 * 24 * 3600_000 };
  const merged = keepRunning([user("u1")], [user("u1"), forever], at);
  assert.equal(merged[1].pendingSince, at, "the server's clock");
  assert.deepEqual(ids(keepRunning(merged, [], at + PENDING_LIMIT_MS + 1)), [], "and it isn't put back once that time is up");
});

test("saves from the page can't grow a chat past the size limit with replies it says are pending", async () => {
  await project("big1", [], "Big");
  const big = "x".repeat(400_000);
  const batch = (tag: string) => Array.from({ length: 10 }, (_, i) => ({ ...pending(`${tag}${i}`), content: big }));
  const results: string[] = [];
  for (const tag of ["a", "b", "c", "d"]) results.push(await pageSave("big1", batch(tag)));
  assert.deepEqual(results, ["saved", "too large", "too large", "too large"]);
  const row = await one<{ messages: string }>("SELECT messages FROM projects WHERE id = 'big1'");
  assert.ok(new TextEncoder().encode(row!.messages).length <= 4_400_000);
  assert.equal(await pageSave("big1", []), "saved", "a copy that fits is still saved");
});

test("a chat made from a template is named after it, not its request", async () => {
  await project("k4");
  const turn = requestTurn({ replyId: "r1", userMessage: { id: "m1", content: "Write a professional cover letter for the job" }, afterId: null, name: "  Cover letter for Acme  " })!;
  assert.equal(turn.name, "Cover letter for Acme");
  await saveTurn("u", "k4", turn);
  assert.equal((await saved("k4")).name, "Cover letter for Acme");
});
