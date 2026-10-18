import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startStandIns } from "./support/research-stand-ins.ts";

/*
 * An assistant on the free models (src/lib/engines/free.ts): the passages come with the person's
 * newest message, after their files and before their words, under their heading and within the
 * turn's room, and the person's words are never cut for them; a turn without passages is read as it
 * always was. The free model is a stand-in (see support/research-stand-ins.ts).
 */
const stand = await startStandIns();
after(() => stand.close());
process.env.DATABASE_URL = ":memory:";
process.env.GROQ_API_KEY = "groq-test";
process.env.GROQ_BASE_URL = `${stand.origin}/groq`;
for (const name of ["GEMINI_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_BASE_URL", "ANTHROPIC_API_KEY"]) delete process.env[name];

const { streamFreeChat, freePassageRoom } = await import("../src/lib/engines/free.ts");
const { PASSAGE_HEADING, assistantSection } = await import("../src/lib/assistant-prompt.ts");
const { FREE_PASSAGE_CHARS } = await import("../src/lib/assistants.ts");
type ChatTurn = import("../src/lib/types.ts").ChatTurn;

beforeEach(() => stand.reset());

type FreeBody = { messages: { role: string; content: string }[]; max_tokens: number };
/** What the free model was sent for one reply. */
async function sent(history: ChatTurn[], o: Parameters<typeof streamFreeChat>[6] = {}): Promise<FreeBody> {
  for await (const e of streamFreeChat(history, "", "text", async () => true, async () => {}, () => {}, o)) void e;
  return stand.state.free.sent.at(-1) as unknown as FreeBody;
}
const file = (name: string, text: string) => ({ name, mediaType: "text/plain", data: Buffer.from(text).toString("base64") });
const PASSAGES = [
  { title: "Prices.pdf, page 2", text: "A sourdough loaf is 4 euros." },
  { title: "Prices.pdf, page 5", text: "Rye is baked on Fridays." },
];

test("passages come after the person's files and before their words, under their heading", async () => {
  const history: ChatTurn[] = [
    { role: "user", content: "Hello", passages: PASSAGES },
    { role: "assistant", content: "Hi!" },
    { role: "user", content: "How much is sourdough?", attachment: file("order.txt", "2 loaves"), passages: PASSAGES },
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
    { role: "user", content: "Look", attachment: file("a.txt", "alpha"), more: [file("b.txt", "beta")] },
    { role: "assistant", content: "Done." },
    { role: "user", content: "", attachment: file("c.txt", "gamma") },
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
  const big = file("notes.txt", "n".repeat(25_000));
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
