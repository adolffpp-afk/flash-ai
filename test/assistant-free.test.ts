import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { assistantKit } from "./support/assistant-kit.ts";

/*
 * An assistant on the free models. In src/lib/engines/free.ts: the passages come with the person's
 * newest message, after their files and before their words, under their heading and within the
 * turn's room, and the person's words are never cut for them; a turn without passages is read as it
 * always was. In the chat route, with assistants switched on for the test: someone's own assistant
 * answers free when they're out of credits, someone else's only when its maker allows it (and then
 * writes at most a visitor's reply), never falling through to a paid model. Claude and the free
 * model are stand-ins (see support/research-stand-ins.ts).
 */
const kit = await assistantKit({ on: true });
after(() => kit.close());
const { stand, account, assistant, file, share, chatWith, chat, claudeSent, freeSent, ledger, said, one, run } = kit;

const { streamFreeChat, freePassageRoom } = await import("../src/lib/engines/free.ts");
const { PASSAGE_HEADING, assistantSection } = await import("../src/lib/assistant-prompt.ts");
const { FREE_PASSAGE_CHARS } = await import("../src/lib/assistants.ts");
const { VISITOR_REPLY_TOKENS } = await import("../src/lib/assistant-cost.ts");
type ChatTurn = import("../src/lib/types.ts").ChatTurn;

beforeEach(async () => {
  stand.reset();
  await run("DELETE FROM rate_limits");
});

type FreeBody = { messages: { role: string; content: string }[]; max_tokens: number };
/** What the free model was sent for one reply. */
async function sent(history: ChatTurn[], o: Parameters<typeof streamFreeChat>[6] = {}): Promise<FreeBody> {
  for await (const e of streamFreeChat(history, "", "text", async () => true, async () => {}, () => {}, o)) void e;
  return stand.state.free.sent.at(-1) as unknown as FreeBody;
}
const attached = (name: string, text: string) => ({ name, mediaType: "text/plain", data: Buffer.from(text).toString("base64") });
const PASSAGES = [
  { title: "Prices.pdf, page 2", text: "A sourdough loaf is 4 euros." },
  { title: "Prices.pdf, page 5", text: "Rye is baked on Fridays." },
];

test("passages come after the person's files and before their words, under their heading", async () => {
  const history: ChatTurn[] = [
    { role: "user", content: "Hello", passages: PASSAGES },
    { role: "assistant", content: "Hi!" },
    { role: "user", content: "How much is sourdough?", attachment: attached("order.txt", "2 loaves"), passages: PASSAGES },
  ];
  const body = await sent(history);
  const last = body.messages.at(-1)!.content;
  assert.equal(
    last,
    `File "order.txt":\n2 loaves\n\n${PASSAGE_HEADING}\n\nPrices.pdf, page 2:\nA sourdough loaf is 4 euros.\n\nPrices.pdf, page 5:\nRye is baked on Fridays.\n\nHow much is sourdough?`,
  );
  // Without a file of their own: the passages, then the words.
  const plain = await sent([{ role: "user", content: "How much is rye?", passages: PASSAGES }]);
  assert.ok(plain.messages.at(-1)!.content.startsWith(`${PASSAGE_HEADING}\n\nPrices.pdf, page 2:\n`));
  assert.ok(plain.messages.at(-1)!.content.endsWith("\n\nHow much is rye?"));
  // The passages never go in the system prompt.
  assert.ok(!body.messages[0].content.includes("sourdough loaf"));
});

test("a turn without passages is read exactly as before", async () => {
  const history: ChatTurn[] = [
    { role: "user", content: "Look", attachment: attached("a.txt", "alpha"), more: [attached("b.txt", "beta")] },
    { role: "assistant", content: "Done." },
    { role: "user", content: "", attachment: attached("c.txt", "gamma") },
    { role: "assistant", content: "" },
    { role: "user", content: "And now?" },
  ];
  const body = await sent(history);
  assert.deepEqual(
    body.messages.slice(1).map((m) => m.content),
    ['File "a.txt":\nalpha\n\nFile "b.txt":\nbeta\n\nLook', "Done.", 'File "c.txt":\ngamma\n\nPlease look at this file.', "And now?"],
  );
  assert.equal(body.max_tokens, 4000, "the free models' usual reply length");
});

test("passages fit the turn's room, and the person's words are never cut", async () => {
  const words = "Which of these do you bake on Sundays? ".repeat(60).trim();
  const big = attached("notes.txt", "n".repeat(25_000));
  const long = [{ title: "Handbook.pdf, page 1", text: "h".repeat(30_000) }];
  for (const turn of [
    { role: "user" as const, content: words, passages: long },
    { role: "user" as const, content: words, attachment: big, passages: long },
    { role: "user" as const, content: "x".repeat(23_990), passages: long },
  ]) {
    const room = freePassageRoom(turn);
    assert.ok(room >= 0 && room <= FREE_PASSAGE_CHARS);
    const content = (await sent([turn])).messages.at(-1)!.content;
    assert.ok(content.endsWith(turn.content), "the words are whole");
    assert.ok(content.length <= 24_000);
    if (room > 0) {
      const read = content.slice(content.indexOf(PASSAGE_HEADING) + PASSAGE_HEADING.length + 2, content.length - turn.content.length - 2);
      assert.equal(read.length, room, "cut to the room");
    } else assert.ok(!content.includes(PASSAGE_HEADING), "no room, no passages");
  }
  // FREE_PASSAGE_CHARS at most, however much room the turn has.
  assert.equal(freePassageRoom({ role: "user", content: "Hi" }), FREE_PASSAGE_CHARS);
  // A file and long words leave less.
  assert.ok(freePassageRoom({ role: "user", content: words, attachment: big }) < FREE_PASSAGE_CHARS);
});

test("the assistant's section goes in the free models' system prompt, and a reply can be held shorter", async () => {
  const section = assistantSection({ name: "Crumb helper", instructions: "Answer as the baker.", mine: false, named: false }, { free: true });
  const body = await sent([{ role: "user", content: "Hi" }], { system: { assistant: section }, maxTokens: 2000 });
  assert.ok(body.messages[0].content.includes(section));
  assert.equal(body.max_tokens, 2000);
  // Never more than the free models' usual length.
  assert.equal((await sent([{ role: "user", content: "Hi" }], { maxTokens: 9000 })).max_tokens, 4000);
});

const today = () => new Date().toISOString().slice(0, 10);
/** This user's free messages taken today. */
const freeUsed = async (id: string) => Number((await one<{ used: number }>("SELECT used FROM free_user_quota WHERE day = ? AND user_id = ? AND kind = 'chat'", [today(), id]))?.used ?? 0);
const INSTRUCTIONS = "Answer as Golden Crumb's baker. Quote prices from the price list.";
const PRICE_LIST = Array.from({ length: 1200 }, (_, i) => `Loaf ${i}: ${(i % 7) + 2} euros, baked at ${(i % 5) + 4} o'clock.`).join("\n");
/** An owner and a visitor out of credits, an assistant of the owner's with a long price list, and a chat each with it. */
async function outOfCredits(o: { freeOk?: boolean } = {}) {
  const owner = await account(0);
  const visitor = await account(0);
  const id = await assistant(owner, { instructions: INSTRUCTIONS, ...o });
  await file(id, "Prices.txt", PRICE_LIST);
  await share(id, `free${id.slice(0, 6)}`, visitor);
  return { owner, visitor, id, own: await chatWith(owner, id), theirs: await chatWith(visitor, id) };
}
/** Whether any reply was asked of Claude (counting tokens isn't one). */
const claudeReplied = () => claudeSent().length > 0 || stand.state.seen.some((s) => s.service === "anthropic" && !s.path.endsWith("/count_tokens"));

test("someone's own assistant answers free when they're out of credits, with its section and passages, never on a paid model", async () => {
  const b = await outOfCredits();
  const r = await chat(b.owner, b.own, "How much is loaf 12?", { assistantVersion: 3, readStart: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.events.find((e) => e.type === "route")?.free, true);
  assert.ok(said(r.events).length > 0);
  assert.ok(!claudeReplied(), "no paid model answered");
  const body = freeSent().at(-1)!;
  assert.ok(body.messages[0].content.includes(assistantSection({ name: "Crumb helper", instructions: INSTRUCTIONS, mine: true, named: true }, { free: true })), "the free section");
  const last = body.messages.at(-1)!.content;
  assert.ok(last.startsWith(`${PASSAGE_HEADING}\n\nPrices.txt`), "titled by the file's name, for its owner");
  assert.ok(last.endsWith("\n\nHow much is loaf 12?"), "the words are whole");
  assert.ok(last.length - PASSAGE_HEADING.length - "How much is loaf 12?".length <= FREE_PASSAGE_CHARS + 4, "the free models' room for passages");
  assert.equal(body.max_tokens, 4000, "the free models' usual reply length");
  assert.ok(r.events.find((e) => e.type === "read")!.items!.length >= 1, "what it read is said");
  assert.equal(await freeUsed(b.owner.id), 1);
  assert.deepEqual((await ledger(b.owner.id)).map((l) => l.amount), [0], "nothing charged");
});

test("someone else's assistant needs credits unless its maker allows free messages, and no free message is used up", async () => {
  const b = await outOfCredits();
  const r = await chat(b.visitor, b.theirs, "How much is loaf 12?", { assistantVersion: 3 });
  assert.equal(r.status, 402);
  assert.equal(r.json.code, "assistant_needs_credits");
  assert.ok(Number(r.json.needed) > 0, "what it needs");
  assert.match(String(r.json.error), /Crumb helper needs credits: its maker hasn't allowed free messages for it\./);
  assert.equal(await freeUsed(b.visitor.id), 0, "no free message used up");
  assert.deepEqual(freeSent(), [], "no free model asked");
  assert.ok(!claudeReplied(), "nor a paid one");
  assert.deepEqual((await ledger(b.visitor.id)).map((l) => l.amount), [0]);
  // Research the same: a free model would answer it as a chat.
  stand.reset();
  assert.equal((await chat(b.visitor, b.theirs, "Latest bread prices in Utrecht?", { assistantVersion: 3, engine: "search" })).json.code, "assistant_needs_credits");
  assert.equal(await freeUsed(b.visitor.id), 0);
});

test("someone else's assistant its maker lets answer free writes at most a visitor's reply, and its files' names stay hidden", async () => {
  const b = await outOfCredits({ freeOk: true });
  const r = await chat(b.visitor, b.theirs, "How much is loaf 12?", { assistantVersion: 3, readStart: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.events.find((e) => e.type === "route")?.free, true);
  assert.ok(!claudeReplied());
  const body = freeSent().at(-1)!;
  assert.equal(body.max_tokens, VISITOR_REPLY_TOKENS);
  assert.ok(body.messages[0].content.includes(INSTRUCTIONS));
  const last = body.messages.at(-1)!.content;
  assert.ok(last.startsWith(`${PASSAGE_HEADING}\n\nPassage 1, `) && !last.includes("Prices.txt"), "titled Passage 1, not by the file's name");
  assert.ok(last.length - PASSAGE_HEADING.length - "How much is loaf 12?".length <= FREE_PASSAGE_CHARS + 4);
  assert.equal(await freeUsed(b.visitor.id), 1);
  // A long message is never cut for the passages: they get what room is left.
  stand.reset();
  const words = "Which of these loaves do you bake before eight o'clock on Sundays? ".repeat(300).trim();
  const long = await chat(b.visitor, b.theirs, words, { assistantVersion: 3, readStart: true });
  assert.equal(long.status, 200);
  const content = freeSent().at(-1)!.messages.at(-1)!.content;
  assert.ok(content.endsWith(words), "the words are whole");
  assert.ok(content.length <= 24_000, "within the turn's room");
});
