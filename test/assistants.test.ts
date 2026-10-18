import { test } from "node:test";
import assert from "node:assert/strict";

/*
 * An assistant's fields: cleaned the same way in the browser and on the server, and refused, never
 * cut, when they're over a limit. Nothing about assistants is on yet.
 */
const a = await import("../src/lib/assistants.ts");
const { cleanAssistant, validateAssistant, isKeptName } = a;

const fields = (o: Record<string, unknown>) => cleanAssistant({ name: "Bakery helper", ...o });

test("assistants stay off, with the limits and rooms agreed for them", () => {
  assert.equal(a.ASSISTANTS_ON, false, "nothing can reach people or charge them before the price line ships");
  assert.equal(a.MAX_ASSISTANT_INSTRUCTIONS, 8000);
  assert.equal(a.MAX_STARTERS, 6);
  assert.equal(a.MAX_ASSISTANT_FILES, 20);
  assert.equal(a.MAX_FILE_CHARS, 1_000_000);
  assert.equal(a.MAX_ASSISTANT_CHARS, 2_000_000);
  assert.equal(a.PASSAGE_TOKENS, 6000, "the same passage budget on every level");
  assert.equal(a.FREE_PASSAGE_CHARS, 6000);
  assert.equal(a.FREE_INSTRUCTION_CHARS, 8000);
  assert.equal(a.STORE_FACTOR, 3, "assistant text counts three times against storage");
});

test("what's sent is cleaned to text, on one line where it's a name, without cutting anything", () => {
  const long = "x".repeat(9000);
  const c = cleanAssistant({
    name: "  Bakery\n\thelper\u202E  ",
    description: "Answers\r\nabout bread",
    instructions: `\u0000  Be kind.\r\nUse French.  ${long}`,
    starters: ["  What's fresh? ", "", "What's fresh?", 42, "Opening\nhours"],
    level: "summit",
    color: "javascript:alert(1)",
  });
  assert.equal(c.name, "Bakery helper");
  assert.equal(c.description, "Answers about bread");
  assert.equal(c.instructions, `Be kind.\nUse French.  ${long}`, "line breaks kept, nothing cut");
  assert.deepEqual(c.starters, ["What's fresh?", "Opening hours"], "blank, repeated and non-text starters dropped");
  assert.equal(c.level, "auto", "a level Flash doesn't have is Auto");
  assert.equal(c.color, "");
  assert.deepEqual(cleanAssistant({ starters: "One\nTwo\n\n", level: "ultra", color: "teal" }), {
    name: "",
    description: "",
    instructions: "",
    starters: ["One", "Two"],
    level: "ultra",
    color: "teal",
  });
  assert.deepEqual(cleanAssistant(null).starters, []);
  assert.equal(cleanAssistant({ name: { toString: () => "Flash" } }).name, "", "only text counts");
});

test("over a limit is refused with its reason and numbers, never cut", () => {
  assert.equal(validateAssistant(fields({})), null);
  assert.deepEqual(validateAssistant(fields({ name: "   " })), { code: "name_missing" });
  assert.equal(validateAssistant(fields({ name: "n".repeat(60) })), null);
  assert.deepEqual(validateAssistant(fields({ name: "n".repeat(61) })), { code: "name_long", max: 60 });
  assert.deepEqual(validateAssistant(fields({ description: "d".repeat(301) })), { code: "description_long", max: 300 });
  assert.equal(validateAssistant(fields({ instructions: "i".repeat(8000) })), null, "a GPT's full 8,000 characters fit");
  assert.deepEqual(validateAssistant(fields({ instructions: "i".repeat(8001) })), { code: "instructions_long", max: 8000, count: 8001 });
  assert.equal(fields({ instructions: "i".repeat(8001) }).instructions.length, 8001, "and nothing was cut");
  const six = ["1", "2", "3", "4", "5", "6"];
  assert.equal(validateAssistant(fields({ starters: six })), null);
  assert.deepEqual(validateAssistant(fields({ starters: [...six, "7"] })), { code: "starters", max: 6, chars: 200 });
  assert.equal(validateAssistant(fields({ starters: ["s".repeat(200)] })), null);
  assert.deepEqual(validateAssistant(fields({ starters: ["s".repeat(201)] })), { code: "starters", max: 6, chars: 200 });
});

test("names Flash keeps for itself are refused, in any case and with any spacing", () => {
  for (const name of ["Flash", "flash support", "FLASH  SUPPORT", "Flash-Team", "Flash_official", "Flash ∞ AI", "flash ai", "Flash Infinity AI", "Flash Infinity AI™", "AI-Flash Inc.", "F l a s h", "Flash\u200Bsupport"]) {
    assert.ok(isKeptName(name), name);
    assert.deepEqual(validateAssistant(fields({ name })), { code: "name_kept" }, name);
  }
  for (const name of ["Flashcards tutor", "Flash fiction coach", "My Flash helper", "Support"]) {
    assert.equal(isKeptName(name), false, name);
    assert.equal(validateAssistant(fields({ name })), null, name);
  }
});
