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
