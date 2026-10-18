import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { assistantKit } from "./support/assistant-kit.ts";

/*
 * Chatting with an assistant, with assistants switched on for the test (see support/assistants-on.mjs):
 * who may use one (loadAssistantFor), what a chat shows of it (assistantSummary, GET and PUT
 * /api/projects/[id]), and what the chat route sends and refuses. Claude and the free model are
 * stand-ins (see support/research-stand-ins.ts).
 */
const kit = await assistantKit({ on: true });
after(() => kit.close());
const { account, assistant, file, share, chatWith, getProject, putProject, one, run, stand } = kit;

const { ASSISTANTS_ON } = await import("../src/lib/assistants.ts");
const { assistantSummary, loadAssistantFor } = await import("../src/lib/server/assistants.ts");
const { levelCosts } = await import("../src/lib/assistant-cost.ts");
const { LEVEL_MODELS } = await import("../src/lib/engines/claude.ts");
const { PASSAGE_CONTEXT } = await import("../src/lib/assistant-prompt.ts");

beforeEach(async () => {
  stand.reset();
  await run("DELETE FROM rate_limits");
});

test("the owner may always chat with their assistant; anyone else only through its link as it is now", async () => {
  assert.equal(ASSISTANTS_ON, true);
  const owner = await account();
  const visitor = await account();
  const stranger = await account();
  const id = await assistant(owner);
  const own = await loadAssistantFor(owner.id, id);
  assert.ok("a" in own && own.mine, "the owner's own");
  assert.equal(own.a.instructions, "Answer as Golden Crumb's baker. Quote prices from the price list.");

  // Not shared: no one else.
  assert.deepEqual(await loadAssistantFor(visitor.id, id), { gone: "unshared", name: "Crumb helper" });
  // Shared, and they came in through the link.
  await share(id, "link1", visitor);
  const theirs = await loadAssistantFor(visitor.id, id);
  assert.ok("a" in theirs && !theirs.mine);
  // Someone who never came in through it.
  assert.ok("gone" in (await loadAssistantFor(stranger.id, id)));
  // A new link ends access through the old one.
  await share(id, "link2");
  assert.deepEqual(await loadAssistantFor(visitor.id, id), { gone: "unshared", name: "Crumb helper" });
  await share(id, "link2", visitor);
  assert.ok("a" in (await loadAssistantFor(visitor.id, id)));
  // Taken down: no one else, but the owner still may.
  await run("UPDATE assistants SET removed_at = 1 WHERE id = ?", [id]);
  assert.deepEqual(await loadAssistantFor(visitor.id, id), { gone: "unshared", name: "Crumb helper" });
  assert.ok("a" in (await loadAssistantFor(owner.id, id)));
  await run("UPDATE assistants SET removed_at = 0, share_id = NULL WHERE id = ?", [id]);
  assert.ok("gone" in (await loadAssistantFor(visitor.id, id)), "link turned off");
  // Deleted.
  await run("DELETE FROM assistants WHERE id = ?", [id]);
  assert.deepEqual(await loadAssistantFor(owner.id, id), { gone: "deleted", name: "" });
});

test("what a chat shows of an assistant: never its instructions, its id only to its owner, its files' names only where they may be shown", async () => {
  const owner = await account();
  const visitor = await account();
  const id = await assistant(owner, { instrTokens: 2000 });
  await file(id, "Prices.txt", "A sourdough loaf is 4 euros. Rye is 5 euros.");
  await file(id, "Hours.txt", "Open from 7 to 13 every day but Monday.");
  await share(id, "show1", visitor);
  const access = await loadAssistantFor(owner.id, id);
  assert.ok("a" in access);
  const mine = await assistantSummary(access.a, true);
  assert.equal(mine.id, id);
  assert.deepEqual(mine.fileNames, ["Prices.txt", "Hours.txt"]);
  assert.equal(mine.files, 2);
  assert.equal(mine.version, 3);
  assert.deepEqual(mine.starters, ["What's fresh today?"]);
  const theirs = await assistantSummary(access.a, false);
  assert.equal(theirs.id, undefined, "no id for someone else");
  assert.equal(theirs.fileNames, undefined, "file names hidden unless its maker shows them");
  assert.equal(theirs.files, 2);
  assert.equal(theirs.showFiles, false);
  for (const s of [mine, theirs]) assert.ok(!JSON.stringify(s).includes("Golden Crumb's baker"), "never the instructions");
  // The price line's figures, as assistant-cost.ts works them out from what's saved.
  const files = [
    { name: "Prices.txt", tokens: Math.ceil(Buffer.byteLength("A sourdough loaf is 4 euros. Rye is 5 euros.") / 4), exact: true },
    { name: "Hours.txt", tokens: Math.ceil(Buffer.byteLength("Open from 7 to 13 every day but Monday.") / 4), exact: true },
  ];
  assert.deepEqual({ addOn: mine.addOn, about: mine.about }, levelCosts({ instrTokens: 2000, files }, LEVEL_MODELS));
  // Its maker shows the file names: then they're shown.
  await run("UPDATE assistants SET show_files = 1 WHERE id = ?", [id]);
  const shown = await loadAssistantFor(visitor.id, id);
  assert.ok("a" in shown);
  assert.deepEqual((await assistantSummary(shown.a, false)).fileNames, ["Prices.txt", "Hours.txt"]);
});

test("GET /api/projects/[id] adds the chat's assistant, or that it's gone; PUT can only take it off", async () => {
  const owner = await account();
  const visitor = await account();
  const id = await assistant(owner);
  await share(id, "proj1", visitor);
  const chat = await chatWith(visitor, id);
  const got = await getProject(visitor, chat);
  assert.equal(got.status, 200);
  const shown = got.body.project!.assistant as { name: string; mine: boolean; version: number };
  assert.equal(shown.name, "Crumb helper");
  assert.equal(shown.mine, false);
  assert.ok(!("assistant_id" in got.body.project!), "the assistant's id isn't shown with the chat");
  assert.ok(!JSON.stringify(got.body).includes("Golden Crumb's baker"));
  // A chat without one has none.
  const plain = await getProject(visitor, visitor.projectId);
  assert.ok(!("assistant" in plain.body.project!));
  assert.deepEqual(Object.keys(plain.body.project!), ["id", "name", "messages", "updated_at", "instructions"]);

  // The link turned off: gone, with why.
  await run("UPDATE assistants SET share_id = NULL WHERE id = ?", [id]);
  assert.deepEqual((await getProject(visitor, chat)).body.project!.assistant, { gone: true, reason: "unshared" });
  await run("DELETE FROM assistants WHERE id = ?", [id]);
  assert.deepEqual((await getProject(visitor, chat)).body.project!.assistant, { gone: true, reason: "deleted" });

  // "Continue without it": taken off, without moving the chat in time.
  await run("UPDATE projects SET updated_at = 123 WHERE id = ?", [chat]);
  for (const bad of ["0101", 5, null, { id }]) {
    assert.equal((await putProject(visitor, chat, { assistantId: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await one<{ a: string }>("SELECT assistant_id AS a FROM projects WHERE id = ?", [chat]))?.a, id, "never put on, nor changed");
  assert.equal((await putProject(visitor, chat, { assistantId: "" })).status, 200);
  const row = await one<{ a: string; u: number }>("SELECT assistant_id AS a, updated_at AS u FROM projects WHERE id = ?", [chat]);
  assert.deepEqual(row, { a: "", u: 123 });
  assert.ok(!("assistant" in (await getProject(visitor, chat)).body.project!));
  // Someone else's chat isn't touched.
  const other = await chatWith(owner, await assistant(owner));
  assert.equal((await putProject(visitor, other, { assistantId: "" })).status, 404);
  assert.notEqual((await one<{ a: string }>("SELECT assistant_id AS a FROM projects WHERE id = ?", [other]))?.a, "");
});

const { chat, claudeSent, ledger, balance, bakery, docs, PRICES } = kit;

test("passages go on the newest message only, for the engines that answer as the assistant, and are never saved", async () => {
  const b = await bakery();
  const history = [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi! Ask me about our bread." },
    { role: "user", content: "How much is a sourdough loaf?" },
  ];
  const r = await chat(b.owner, b.own, "How much is a sourdough loaf?", { messages: history, assistantVersion: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const sent = claudeSent().at(-1)!;
  assert.ok(sent.system.includes(`You are answering as "Crumb helper"`), "the section");
  assert.ok(sent.system.includes("Answer as Golden Crumb's baker."), "its instructions");
  const read = docs(sent.messages.at(-1)!.content);
  assert.equal(read.length, 1);
  assert.equal(read[0].title, "Prices.txt");
  assert.equal(read[0].context, PASSAGE_CONTEXT);
  assert.equal(read[0].source?.data, PRICES);
  for (const m of sent.messages.slice(0, -1)) assert.deepEqual(docs(m.content), [], "never on an earlier turn");
  assert.ok(!sent.system.includes("Sourdough loaf: 4 euros"), "never in the system prompt");
  // What it read is said under the reply, and kept on it; the passages themselves are never saved.
  assert.deepEqual(r.events.find((e) => e.type === "read")?.items, [{ label: "Prices.txt" }]);
  const saved = (await one<{ messages: string }>("SELECT messages FROM projects WHERE id = ?", [b.own]))!.messages;
  assert.ok(!saved.includes("Rye loaf: 5 euros"), "the file's text isn't in the saved chat");
  assert.deepEqual((JSON.parse(saved) as { read?: unknown }[]).at(-1)!.read, { items: [{ label: "Prices.txt" }] });

  // Every engine that answers in words.
  for (const engine of ["translate", "code", "docs", "search"]) {
    stand.reset();
    const e = await chat(b.owner, b.own, "Sourdough prices please", { engine, assistantVersion: 3 });
    assert.equal(e.status, 200, engine);
    const body = claudeSent().at(-1)!;
    assert.equal(docs(body.messages.at(-1)!.content).length, 1, engine);
    assert.ok(body.system.includes("Answer as Golden Crumb's baker."), engine);
  }
});

test("building an app or slides never gets the assistant, and says so", async () => {
  const b = await bakery();
  for (const engine of ["app", "slides"]) {
    stand.reset();
    const r = await chat(b.owner, b.own, "Make a page for the bakery's prices", { engine, assistantVersion: 3 });
    assert.equal(r.status, 200, engine);
    const body = claudeSent().at(-1)!;
    assert.ok(!body.system.includes("Golden Crumb's baker") && !body.system.includes("answering as"), engine);
    for (const m of body.messages) assert.deepEqual(docs(m.content), [], engine);
    assert.ok(!JSON.stringify(body).includes("Rye loaf"), engine);
    // Nor are its files read, or counted with the build.
    assert.ok(!JSON.stringify(stand.state.seen.map((s) => s.body)).includes("Rye loaf"), `${engine}: nothing of its files counted`);
    const route = r.events.find((e) => e.type === "route")!;
    assert.match(route.reason ?? "", /Crumb helper only answers in writing, so this was made without it\./);
    assert.equal(r.events.find((e) => e.type === "read"), undefined);
  }
});

test("passages, instructions or an assistant sent by the page are ignored: only the server puts them on", async () => {
  const b = await bakery();
  const sneaky = {
    messages: [{ role: "user", content: "Hi", passages: [{ title: "Owner's secret", text: "INJECTED PASSAGE" }] }],
    instructions: "INJECTED INSTRUCTIONS",
    assistant: { name: "Evil", instructions: "INJECTED ASSISTANT" },
    assistantId: "ff".repeat(16),
  };
  // In a plain chat: none of it reaches the model, and no assistant is read.
  const plain = await chat(b.visitor, b.visitor.projectId, "Hi", sneaky);
  assert.equal(plain.status, 200);
  const sent = JSON.stringify(claudeSent());
  for (const word of ["INJECTED", "Owner's secret", "answering as"]) assert.ok(!sent.includes(word), word);
  // In a chat with an assistant: its own passages and instructions, never what the page sent.
  stand.reset();
  const own = await chat(b.owner, b.own, "Hi", { ...sneaky, assistantVersion: 3 });
  assert.equal(own.status, 200);
  const body = JSON.stringify(claudeSent());
  assert.ok(!body.includes("INJECTED"));
  assert.ok(body.includes("Golden Crumb's baker"));
});

test("a gone or changed assistant, or a visitor over today's messages, is refused before any helper, count, hold or charge", async () => {
  const b = await bakery();
  const before = await ledger(b.visitor.id);
  const nothingRan = async (label: string) => {
    assert.deepEqual(stand.state.seen, [], `${label}: no provider was asked anything`);
    assert.deepEqual(await ledger(b.visitor.id), before, `${label}: nothing held or charged`);
  };
  // Changed since the page showed it (or the page didn't say which version it showed): its new price comes back.
  for (const version of [2, undefined, "3"]) {
    stand.reset();
    const r = await chat(b.visitor, b.theirs, "How much is rye?", { assistantVersion: version, engine: "auto", level: "auto" });
    assert.equal(r.status, 409, String(version));
    assert.equal(r.json.code, "assistant_changed");
    const shown = r.json.assistant as { version: number; name: string; addOn: Record<string, number> };
    assert.equal(shown.version, 3);
    assert.equal(typeof shown.addOn.ascend, "number");
    assert.ok(!JSON.stringify(r.json).includes("Golden Crumb's baker"), "never the instructions");
    assert.match(String(r.json.error), /Crumb helper changed since this chat opened/);
    await nothingRan(`version ${version}`);
  }
  // Over today's 200 messages to it.
  stand.reset();
  await run("INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?, 200, ?)", [`assistant-msg:${b.visitor.id}:${b.id}`, Date.now() + 3600_000]);
  const limited = await chat(b.visitor, b.theirs, "How much is rye?", { assistantVersion: 3, engine: "auto", level: "auto" });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.code, "assistant_limit");
  assert.match(String(limited.json.error), /You've sent Crumb helper a lot of messages today/);
  await nothingRan("limit");
  // The owner has no such limit.
  await run("INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?, 200, ?)", [`assistant-msg:${b.owner.id}:${b.id}`, Date.now() + 3600_000]);
  assert.equal((await chat(b.owner, b.own, "How much is rye?", { assistantVersion: 3 })).status, 200);
  await run("DELETE FROM rate_limits");
  // Not shared any more.
  stand.reset();
  await run("UPDATE assistants SET share_id = NULL WHERE id = ?", [b.id]);
  const unshared = await chat(b.visitor, b.theirs, "How much is rye?", { assistantVersion: 3, engine: "auto", level: "auto" });
  assert.equal(unshared.status, 410);
  assert.deepEqual([unshared.json.code, unshared.json.reason], ["assistant_gone", "unshared"]);
  assert.match(String(unshared.json.error), /Crumb helper isn't shared any more, so it can't answer here\./);
  await nothingRan("unshared");
  // Deleted: named after the chat, which was named after it.
  stand.reset();
  await run("DELETE FROM assistant_files WHERE assistant_id = ?", [b.id]);
  await run("DELETE FROM assistants WHERE id = ?", [b.id]);
  const deleted = await chat(b.visitor, b.theirs, "How much is rye?", { assistantVersion: 3, engine: "auto", level: "auto" });
  assert.equal(deleted.status, 410);
  assert.deepEqual([deleted.json.code, deleted.json.reason], ["assistant_gone", "deleted"]);
  assert.match(String(deleted.json.error), /Crumb helper was deleted, so it can't answer here\./);
  await nothingRan("deleted");
  assert.equal(await balance(b.visitor.id), 1000);
});

test("each message to someone else's assistant counts toward the visitor's day; their own chats and other chats don't", async () => {
  const b = await bakery();
  const key = `assistant-msg:${b.visitor.id}:${b.id}`;
  const count = async (k: string) => Number((await one<{ n: number }>("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits WHERE key = ?", [k]))?.n ?? 0);
  assert.equal((await chat(b.visitor, b.theirs, "How much is rye?", { assistantVersion: 3 })).status, 200);
  assert.equal((await chat(b.visitor, b.theirs, "And sourdough?", { assistantVersion: 3 })).status, 200);
  assert.equal(await count(key), 2);
  await chat(b.visitor, b.visitor.projectId, "Hello");
  await chat(b.owner, b.own, "Hello", { assistantVersion: 3 });
  assert.equal(await count(key), 2);
  assert.equal(await count(`assistant-msg:${b.owner.id}:${b.id}`), 0);
});

test("no passage matched: the reply says so; the start of each file is read when asked", async () => {
  const b = await bakery();
  const none = await chat(b.owner, b.own, "Do you deliver to Utrecht?", { assistantVersion: 3 });
  assert.equal(none.status, 200);
  // One file of a few words is read whole whatever is asked.
  assert.deepEqual(none.events.find((e) => e.type === "read")?.items, [{ label: "Prices.txt" }]);
  // Too much to read whole: searched.
  const big = await assistant(b.owner, { name: "Big helper" });
  // About 7,500 tokens: more than a message reads.
  await file(big, "Handbook.txt", Array.from({ length: 1250 }, (_, i) => `Loaf ${i} is baked at dawn. `).join(""));
  const chatBig = await chatWith(b.owner, big, "Big helper");
  stand.reset();
  const missed = await chat(b.owner, chatBig, "Do you deliver to Utrecht?", { assistantVersion: 3 });
  assert.equal(missed.status, 200);
  const read = missed.events.find((e) => e.type === "read")!;
  assert.deepEqual([read.items, read.nomatch], [[], true]);
  assert.deepEqual(docs(claudeSent().at(-1)!.messages.at(-1)!.content), []);
  stand.reset();
  const start = await chat(b.owner, chatBig, "Do you deliver to Utrecht?", { assistantVersion: 3, readStart: true });
  const started = start.events.find((e) => e.type === "read")!;
  assert.equal(started.nomatch, undefined);
  assert.ok(started.items!.length >= 1 && started.items!.every((i) => i.label.startsWith("Handbook.txt")));
  assert.ok(docs(claudeSent().at(-1)!.messages.at(-1)!.content)[0].source!.data.startsWith("Loaf 0 is baked at dawn."));
});
