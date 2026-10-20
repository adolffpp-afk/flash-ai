import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * What an assistant adds to a message, shown before it's sent (src/lib/assistant-cost.ts): the formula
 * for each level at its model's dearest input rate, Auto at Vision's figure, Research on Sonic at
 * Ascend's (where it runs), files read whole at their real total, and otherwise the most a message reads.
 * Whether files are read whole is decided as the search decides it, on a libSQL file database.
 */
const dir = mkdtempSync(join(tmpdir(), "flash-assistant-cost-"));
process.env.DATABASE_URL = `file:${join(dir, "cost.db")}`;
after(() => rmSync(dir, { recursive: true, force: true }));

const cost = await import("../src/lib/assistant-cost.ts");
const { PASSAGE_FRAMING_TOKENS, about, addOn, assistantTokens, fileTokens, inputRate, levelCosts, pricedLevel, readWhole, typicalReply } = cost;
const { PASSAGE_CONTEXT, SECTION_BYTES } = await import("../src/lib/assistant-prompt.ts");
const { MAX_PASSAGES, PASSAGE_TOKENS, STORE_FACTOR } = await import("../src/lib/assistants.ts");
const { CLAUDE_PRICES, MARKUP, TYPICAL_CREDITS, claudePrice } = await import("../src/lib/credits.ts");
const { LEVEL_MODELS, claudeChoice } = await import("../src/lib/engines/claude.ts");
const { LEVELS } = await import("../src/lib/levels.ts");
const { db, run } = await import("../src/lib/server/db.ts");
const { indexFile, passagesFor } = await import("../src/lib/server/assistant-search.ts");

const bytes = (s: string) => Buffer.byteLength(s);
const OVERHEAD = bytes(PASSAGE_CONTEXT) + PASSAGE_FRAMING_TOKENS;
// 2,000 tokens of instructions, and files too big to read whole: every message reads the most passages.
const big = { instrTokens: 2000, files: [{ name: "Handbook.pdf", tokens: 40_000, exact: false }] };

test("the extra credits follow the formula on every level, at each model's dearest input rate", () => {
  const tokens = SECTION_BYTES + 2000 + PASSAGE_TOKENS + MAX_PASSAGES * OVERHEAD;
  assert.equal(assistantTokens(big), tokens);
  const rates: Record<string, number> = {};
  for (const [level, model] of Object.entries(LEVEL_MODELS)) {
    const p = CLAUDE_PRICES[model];
    rates[level] = Math.max(p.input, p.long?.input ?? 0);
    assert.equal(addOn(level as never, big, LEVEL_MODELS), Math.ceil((tokens * rates[level] * MARKUP) / 1e6 - 1e-9), level);
  }
  // Sonic's is its model's rate for long prompts, so the figure holds however long the chat gets.
  const sonic = CLAUDE_PRICES[LEVEL_MODELS.sonic];
  assert.ok(sonic.long && rates.sonic === sonic.long.input && sonic.long.input > sonic.input, "the long-prompt rate");
  assert.equal(inputRate(LEVEL_MODELS.sonic), sonic.long!.input);
  // Auto never picks Summit (see autoLevel), so its figure is Vision's.
  assert.equal(addOn("auto", big, LEVEL_MODELS), addOn("vision", big, LEVEL_MODELS));
  assert.equal(pricedLevel("auto"), "vision");
  // Never under the plain sum of the instructions and passages, which is what the plan's table shows.
  const plain: Record<string, number> = { sonic: 1, ascend: 4, vision: 8, ultra: 20 };
  for (const level of Object.keys(plain)) assert.ok(addOn(level as never, big, LEVEL_MODELS) >= plain[level], level);
  assert.ok(addOn("sonic", big, LEVEL_MODELS) < addOn("ascend", big, LEVEL_MODELS) && addOn("ascend", big, LEVEL_MODELS) < addOn("ultra", big, LEVEL_MODELS));
});

test("files read whole are priced at their real total, with their titles and what wraps them", () => {
  const files = [
    { name: "Prices.csv", tokens: 900, exact: true },
    { name: "Menu.pdf", tokens: 600, exact: true },
  ];
  assert.ok(readWhole(files));
  const titles = Math.max(bytes("Prices.csv"), bytes("File 1")) + Math.max(bytes("Menu.pdf"), bytes("File 2"));
  assert.equal(fileTokens(files), 900 + 600 + titles + 2 + 2 * OVERHEAD);
  const small = { instrTokens: 1000, files };
  assert.equal(assistantTokens(small), SECTION_BYTES + 1000 + fileTokens(files));
  assert.ok(addOn("vision", small, LEVEL_MODELS) < addOn("vision", { ...small, files: [...files, { name: "Big.pdf", tokens: 5000, exact: true }] }, LEVEL_MODELS));
  // A name shorter than "File 1" is titled "File 1" where names aren't shown, and that's what counts.
  assert.equal(fileTokens([{ name: "a", tokens: 100, exact: true }]), 100 + bytes("File 1") + 1 + OVERHEAD);
  // One file counted from its start only, or the lot over the room, and every message reads the most.
  assert.equal(fileTokens([{ ...files[0], exact: false }]), PASSAGE_TOKENS + MAX_PASSAGES * OVERHEAD);
  assert.equal(fileTokens([{ name: "a", tokens: PASSAGE_TOKENS, exact: true }]), PASSAGE_TOKENS + MAX_PASSAGES * OVERHEAD);
  // More small files than a search reads, whole only when titled "File 1" and so on: never under
  // what reading them whole takes, with what wraps each.
  const many = Array.from({ length: 12 }, (_, i) => ({ name: `Chapter ${i + 1} of the long handbook.txt`, tokens: 480, exact: true }));
  assert.ok(!readWhole(many));
  const unnamedTotal = many.reduce((sum, f, i) => sum + f.tokens + bytes(`File ${i + 1}`) + 1, 0);
  assert.ok(unnamedTotal <= PASSAGE_TOKENS, "read whole when not named");
  assert.ok(fileTokens(many) >= unnamedTotal + many.length * OVERHEAD);
  assert.ok(fileTokens(many) >= PASSAGE_TOKENS + MAX_PASSAGES * OVERHEAD);
  // No files, no passages.
  assert.equal(fileTokens([]), 0);
  assert.equal(assistantTokens({ instrTokens: 0, files: [] }), SECTION_BYTES);
});

test("Research on Sonic runs on Ascend, so its figure is Ascend's", () => {
  assert.equal(claudeChoice("search", "sonic").level, "ascend", "Research doesn't run on Sonic");
  assert.equal(pricedLevel("sonic", "search"), "ascend");
  assert.equal(addOn("sonic", big, LEVEL_MODELS, "search"), addOn("ascend", big, LEVEL_MODELS));
  assert.ok(addOn("sonic", big, LEVEL_MODELS, "search") > addOn("sonic", big, LEVEL_MODELS), "more than Sonic's own line says");
  for (const level of ["ascend", "vision", "ultra"] as const) assert.equal(addOn(level, big, LEVEL_MODELS, "search"), addOn(level, big, LEVEL_MODELS));
});

test("about: the whole message, with a typical reply on that level", () => {
  for (const { id } of LEVELS) {
    const model = LEVEL_MODELS[pricedLevel(id)];
    const reply = Math.max(1, Math.round((TYPICAL_CREDITS.text ?? 4) * (claudePrice(model).output / claudePrice(LEVEL_MODELS.ascend).output)));
    assert.equal(typicalReply(id, LEVEL_MODELS), reply, id);
    assert.equal(about(id, big, LEVEL_MODELS), Math.ceil((assistantTokens(big) * claudePrice(model).input * MARKUP) / 1e6 - 1e-9) + reply, id);
  }
  assert.equal(typicalReply("ascend", LEVEL_MODELS), TYPICAL_CREDITS.text, "Ascend's is the usual typical reply");
  const all = levelCosts(big, LEVEL_MODELS);
  assert.deepEqual(Object.keys(all.addOn), LEVELS.map((l) => l.id));
  assert.equal(all.addOn.ultra, addOn("ultra", big, LEVEL_MODELS));
  assert.equal(all.about.auto, about("vision", big, LEVEL_MODELS));
});

test("files are priced as read whole exactly when the search reads them whole, titled either way", async () => {
  await db();
  await run("PRAGMA foreign_keys = OFF");
  const id = "ab".repeat(16);
  await run("INSERT INTO assistants (id, user_id, name, created_at, updated_at) VALUES (?, 'owner', 'Bakery helper', 0, 0)", [id]);
  let n = 0;
  const add = async (name: string, text: string, tokens: number, exact = 1) => {
    const fileId = `f${++n}`;
    await run(
      "INSERT INTO assistant_files (id, assistant_id, name, kind, chars, bytes, stored, tokens, exact, hash, created_at) VALUES (?, ?, ?, 'text', ?, ?, ?, ?, ?, ?, ?)",
      [fileId, id, name, text.length, bytes(text), STORE_FACTOR * bytes(text), tokens, exact, fileId, n],
    );
    await indexFile(id, fileId, text, tokens);
    return { name, tokens, exact: exact === 1 };
  };
  // How the search reads them, titled by name and not.
  const decide = () => Promise.all([true, false].map(async (named) => (await passagesFor({ id }, "sourdough", "", { named })).mode));
  // Both names are longer than "File 1" and "File 2", so titled by name is the longer way.
  const files = [await add("Alpha notes.txt", "Sourdough is baked at dawn.", 2000)];
  assert.ok(readWhole(files));
  assert.deepEqual(await decide(), ["whole", "whole"]);
  // Up to the room with the longer titles: still whole both ways, and priced whole.
  const room = PASSAGE_TOKENS - (2000 + bytes("Alpha notes.txt") + 1) - (bytes("Beta notes.txt") + 1);
  files.push(await add("Beta notes.txt", "Rye on Fridays.", room));
  assert.ok(readWhole(files));
  assert.deepEqual(await decide(), ["whole", "whole"]);
  assert.equal(fileTokens(files), PASSAGE_TOKENS + 2 * OVERHEAD);
  // One token more: searched when titled by name, still whole when not. Not priced as read whole,
  // and never under either.
  await run("UPDATE assistant_files SET tokens = tokens + 1 WHERE id = 'f2'");
  files[1] = { ...files[1], tokens: room + 1 };
  assert.ok(!readWhole(files));
  const [named, unnamed] = await decide();
  assert.notEqual(named, "whole");
  assert.equal(unnamed, "whole");
  assert.ok(fileTokens(files) >= PASSAGE_TOKENS + 1 + 2 * OVERHEAD && fileTokens(files) >= PASSAGE_TOKENS + MAX_PASSAGES * OVERHEAD);
  // A file counted from its start only is never read whole.
  await run("UPDATE assistant_files SET tokens = 10, exact = 0 WHERE id = 'f2'");
  assert.ok(!readWhole([files[0], { ...files[1], tokens: 10, exact: false }]));
  assert.ok(!(await decide()).includes("whole"));
});
