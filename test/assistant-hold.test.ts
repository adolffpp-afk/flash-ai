import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { assistantKit } from "./support/assistant-kit.ts";

/*
 * What a message to an assistant holds: its section, its maker's instructions and the passages from
 * its files are counted with the rest of what's sent, so the credits held pay for the most the reply
 * can cost, as in any chat (src/app/api/chat/route.ts). Claude is a stand-in that counts a request by
 * its length (see support/research-stand-ins.ts), so a part left out of the count is seen.
 */
const kit = await assistantKit({ on: true });
after(() => kit.close());
const { account, assistant, file, share, chatWith, chat, claudeSent, ledger, docs, run, stand } = kit;
const { MARKUP, claudePrice, fallbackModel } = await import("../src/lib/credits.ts");
const { VISITOR_REPLY_TOKENS } = await import("../src/lib/assistant-cost.ts");

beforeEach(async () => {
  stand.reset();
  await run("DELETE FROM rate_limits");
});

type Body = Record<string, unknown> & { model: string; max_tokens: number; fallbacks?: string; system: string; messages: { role: string; content: unknown }[] };
// About four characters a token, for what's read: the system prompt, the messages and any tools.
const byLength = (b: Record<string, unknown>) => Math.ceil(JSON.stringify([b.system, b.messages, b.tools ?? null]).length / 4);

/** A chat request, with what it held while its reply was being written (before it's settled to what it cost). */
async function held(who: Awaited<ReturnType<typeof account>>, projectId: string, content: string, body: Record<string, unknown> = {}) {
  let release = () => {};
  stand.state.claude.replies.push({ blocks: [{ type: "text", text: "A loaf is 4 euros." }], stop: "end_turn", hold: new Promise<void>((r) => (release = r)) });
  const pending = chat(who, projectId, content, body);
  for (let i = 0; !claudeSent().length && i < 400; i++) await new Promise((r) => setTimeout(r, 5));
  const rows = await ledger(who.id);
  release();
  const r = await pending;
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const charge = rows.at(-1)!;
  assert.match(charge.reason, / request$/);
  return { r, held: -charge.amount };
}

/** What Claude was asked to count for the model that answered, and what it was sent (the same, read by its length, when no tools are sent). */
function countedAndSent() {
  const sent = claudeSent().at(-1)! as unknown as Body;
  // The request's own count, with its system prompt (the passages are counted alone too, without one).
  const counts = stand.state.seen.filter((s) => s.path.endsWith("/count_tokens") && s.body.model === sent.model && "system" in s.body).map((s) => s.body);
  assert.equal(counts.length, 1, "counted once");
  return { sent, counted: counts[0] };
}

// The margin credits.ts holds on top of what a reply can cost (SAFETY there, which isn't exported).
const SAFETY = 1.25;

/** The most a reply sent so can cost, in cents: everything it reads, and as much as it may write, by its refusal fallback too. */
function worstCents(sent: Body, tokens: number) {
  const p = claudePrice(sent.model, tokens);
  let cents = (tokens * p.input + sent.max_tokens * p.output) / 1e6;
  const backup = sent.fallbacks ? fallbackModel(sent.model) : undefined;
  if (backup) {
    // It reads the input and the declined words again.
    const b = claudePrice(backup, tokens);
    cents += (tokens * b.input + sent.max_tokens * (b.input + b.output)) / 1e6;
  }
  return cents;
}

const INSTRUCTIONS = "Answer as Golden Crumb's baker, warmly and briefly, and quote prices from the price list. ".repeat(80).trim();
// Too long to read whole: read from its start (readStart), a message reads the most it may.
const PRICE_LIST = Array.from({ length: 1200 }, (_, i) => `Loaf ${i}: ${(i % 7) + 2} euros, baked at ${(i % 5) + 4} o'clock.`).join("\n");

test("the credits held count the assistant's instructions and passages, exactly as they're sent, and pay for the most the reply can cost", async () => {
  const owner = await account(5000);
  const visitor = await account(5000);
  const id = await assistant(owner, { instructions: INSTRUCTIONS, instrTokens: Math.ceil(Buffer.byteLength(INSTRUCTIONS) / 4) });
  await file(id, "Prices.txt", PRICE_LIST);
  await share(id, "hold1", visitor);
  const own = await chatWith(owner, id);
  const theirs = await chatWith(visitor, id);

  // A chat without an assistant: what the same message holds.
  stand.state.claude.count = byLength;
  const plain = await held(owner, owner.projectId, "How much is loaf 12?");
  const plainSent = countedAndSent();
  assert.deepEqual([plainSent.counted.system, plainSent.counted.messages], [plainSent.sent.system, plainSent.sent.messages]);

  for (const [who, chatId, label] of [
    [owner, own, "the owner's"],
    [visitor, theirs, "someone else's"],
  ] as const) {
    stand.reset();
    stand.state.claude.count = byLength;
    const r = await held(who, chatId, "How much is loaf 12?", { assistantVersion: 3, readStart: true });
    const { sent, counted } = countedAndSent();
    assert.ok(sent.system.includes(INSTRUCTIONS), `${label}: the instructions are sent`);
    assert.ok(docs(sent.messages.at(-1)!.content).length >= 1, `${label}: passages are sent`);
    // Counted exactly as sent: the section and instructions, and the passages on the newest message.
    assert.equal(counted.system, sent.system, label);
    assert.deepEqual(counted.messages, sent.messages, label);
    // The most the reply can cost, reading all that's sent, is held, with the margin every hold has.
    const tokens = byLength(sent);
    assert.ok(byLength(counted) > byLength(plainSent.counted) + 6000, `${label}: the instructions and passages count`);
    assert.ok(worstCents(sent, tokens) * MARKUP * SAFETY <= r.held, `${label}: ${worstCents(sent, tokens) * MARKUP} worst, ${r.held} held`);
    assert.ok(r.held > plain.held, `${label}: more than the plain chat holds`);
    if (who === visitor) assert.ok(sent.max_tokens <= VISITOR_REPLY_TOKENS, "someone else's writes at most its cap");
  }

  // With just the credits it needs, the reply may write only what they pay for, with the margin, every
  // part of what it reads counted first.
  const tight = await account(0);
  const id2 = await assistant(tight, { instructions: INSTRUCTIONS, instrTokens: Math.ceil(Buffer.byteLength(INSTRUCTIONS) / 4) });
  await file(id2, "Prices.txt", PRICE_LIST);
  const tightChat = await chatWith(tight, id2);
  // Today's free messages used up, so a request it can't pay for says what it needs.
  await run("INSERT INTO free_user_quota (day, user_id, kind, used) VALUES (?, ?, 'chat', 100000)", [new Date().toISOString().slice(0, 10), tight.id]);
  stand.reset();
  stand.state.claude.count = byLength;
  const short = await chat(tight, tightChat, "How much is loaf 12?", { assistantVersion: 3, readStart: true });
  assert.equal(short.status, 402);
  const needed = Number(short.json.needed);
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, ?, 'test', 0)", [tight.id, needed + 1]);
  stand.reset();
  stand.state.claude.count = byLength;
  const r = await held(tight, tightChat, "How much is loaf 12?", { assistantVersion: 3, readStart: true });
  const { sent, counted } = countedAndSent();
  assert.deepEqual([counted.system, counted.messages], [sent.system, sent.messages]);
  assert.ok(r.held <= needed + 1);
  const worst = worstCents(sent, byLength(sent)) * MARKUP;
  assert.ok(worst * SAFETY <= r.held, `${worst} worst, ${r.held} held`);
});

test("a count Anthropic can't make holds and sends nothing, as in any chat", async () => {
  const owner = await account();
  const id = await assistant(owner, { instructions: INSTRUCTIONS });
  await file(id, "Prices.txt", PRICE_LIST);
  const own = await chatWith(owner, id);
  stand.state.claude.countStatus = 500;
  const before = await ledger(owner.id);
  const r = await chat(owner, own, "How much is loaf 12?", { assistantVersion: 3, readStart: true });
  assert.equal(claudeSent().length, 0, "no reply priced on a guess");
  assert.notEqual(r.status, 200);
  assert.deepEqual(await ledger(owner.id), before);
});
