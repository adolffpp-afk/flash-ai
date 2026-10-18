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
  // C1 controls too (an 8-bit escape, CSI, among them), and their line break is a line break.
  const c1 = cleanAssistant({ name: "Bob\u009B2J\u0080", instructions: "One\u0085Two\u009B2J" });
  assert.equal(c1.name, "Bob2J");
  assert.equal(c1.instructions, "One\nTwo2J");
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
  // With a letter that shows as a blank (the Hangul fillers), an accent, or letters that look
  // like Latin ones (Cyrillic "а" and "ѕ", Greek "Α", a capital I for an l).
  const blank = ["Flash\u3164", "Flash\u3164support", "Flash\uFFA0team", "Flash\u115Fofficial", "Flash ∞ AI\u3164", "Flash\u2800support", "\u200EFlash\u200F"];
  const alike = ["Fl\u0430sh support", "Fla\u0455h", "FL\u0410SH", "\u0391I-Flash Inc.", "FIash support", "Flásh", "Fla\u0336sh team"];
  for (const name of [...blank, ...alike]) assert.deepEqual(validateAssistant(fields({ name })), { code: "name_kept" }, JSON.stringify(name));
  assert.equal(fields({ name: "Flash\u3164support" }).name, "Flash support", "a blank letter is a space");
  // Letters from other alphabets that look like Latin ones, whatever the alphabet: Latin small
  // capitals, Lisu, Cherokee, Armenian, an f with a hook.
  const others = ["ꜰʟᴀꜱʜ", "Flᴀsh", "ꜰʟᴀꜱʜ ꜱᴜᴘᴘᴏʀᴛ", "ꓝꓡꓮꓢꓧ", "FLꓮSH", "FLᎪᏚᎻ", "Flash Ꮪupport", "ƒlash", "Flasհ", "Flash Suppօrt", "ꓝꓡꓮꓢꓧ ∞ ꓮꓲ", "Flash Infinity ᎪI"];
  // Each of Flash's names, with the words that make it read as Flash's own help before or after it.
  const roles = ["Flash ∞ AI Support", "Flash ∞ AI official", "Flash AI team", "Flash Infinity AI Support", "Flash Infinity AI™ Official", "AI-Flash Inc. Support", "AI-Flash", "AI-Flash support", "Official Flash", "Flash Support Team", "Flash help", "Admin Flash"];
  // More such words, one or many, with an s: "Flash Customer Support", "Contact Flash Admins".
  const more = ["Flash Customer Support", "Contact Flash Support", "Flash Support Staff", "Flash Help Desk", "Flash Admins", "Flash Supports", "Flash Administrator", "Flash ∞ AI Assistant", "Flash ∞ AI Staff", "Flash Billing Support", "AI-Flash Incorporated", "Flash Inc.", "Flash Customer Service", "Flash Security Team", "Flash Bot", "Flash Moderators"];
  // A trademark sign, which NFKC would make the letters "TM" or "SM", goes the way "®" goes.
  const signs = ["Flash™", "FLASH™", "Flash ∞ AI™", "Flash™ Support", "Flash ∞ AI™ Support", "AI-Flash™", "Flash ∞ AI ™ Official", "Flash ∞ AI℠", "Flash®", "Flash ∞ AI®"];
  // Latin letters with a stroke, hook, curl or tail built in, which NFD can't take off.
  const built = ["Flⱥsh", "Flⱥsh Support", "Flᶏsh", "Fȴash", "Fɬash", "Fⱡash", "Flaȿh", "Flaꞩh", "Flaᶊh", "ᶂlash", "Fȴash ∞ AI"];
  // Flash's own, with any apostrophe, also a modifier letter that shows as one ("ʼ"), or a comma ("ꓹ").
  const owned = ["Flash's Support", "Flash’s Help Desk", "Flash ∞ AI's Support Team", "AI-Flash's Help Desk", "Flash Infinity AI's Support", "Flash's", "Official Flash's Team", "Flashʼs Support", "Flaʼsh", "Flashꓹs Support", "Flash support's"];
  for (const name of [...others, ...roles, ...more, ...signs, ...built, ...owned]) assert.deepEqual(validateAssistant(fields({ name })), { code: "name_kept" }, JSON.stringify(name));
  // Nothing that shows: blank letters, zero-width characters, a word joiner, a soft hyphen, tags.
  for (const name of ["\u3164", "\u3164 \uFFA0", "\u2800", "\u200B", "\u2060", "\u00AD", "\u{E0041}\u{E0042}", "\u200B\u0301", "\u0080\u0081", "\u009B\u0085"]) {
    assert.deepEqual(validateAssistant(fields({ name })), { code: "name_missing" }, JSON.stringify(name));
  }
  // Other words with Flash's are someone's own: "flash" is an everyday word.
  for (const name of ["Flashcards tutor", "Flash fiction coach", "My Flash helper", "Support", "Флэш помощник", "Fresh support", "Café helper", "한글 도우미", "Slash support", "Flash Infinity", "Help desk", "👨\u200D👩\u200D👧", "\u2764\uFE0F", "Flash sale helper", "Flashcards support", "The Flash fan club", "Flash photography tips", "Flashlight bot", "Flash's fan club", "Flash Store", "Hawaiʻi helper"]) {
    assert.equal(isKeptName(name), false, name);
    assert.equal(validateAssistant(fields({ name })), null, name);
  }
});
