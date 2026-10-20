import { test } from "node:test";
import assert from "node:assert/strict";

const { IDEA_CHARS, HELPER_TOKENS, cleanIdea, cleanPrompt, helperSystem } = await import("../src/lib/prompt-helper.ts");
const { callMaxCents, creditsFor } = await import("../src/lib/credits.ts");
const { LEVEL_MODELS } = await import("../src/lib/engines/claude.ts");

test("an idea is its words, cut to the most the helper reads, and needs a few letters", () => {
  assert.equal(cleanIdea("  a logo for my bakery  "), "a logo for my bakery");
  assert.equal(cleanIdea("hi"), null);
  assert.equal(cleanIdea(42), null);
  assert.equal(cleanIdea("x".repeat(IDEA_CHARS + 50))?.length, IDEA_CHARS);
});

test("the helper writes the prompt for the tool picked, in the user's language, never the answer", () => {
  assert.match(helperSystem("image"), /image generator/);
  assert.match(helperSystem("app"), /app and website builder/);
  assert.match(helperSystem("auto"), /AI assistant/);
  for (const tool of ["auto", "text", "image"] as const) {
    assert.match(helperSystem(tool), /same language/);
    assert.match(helperSystem(tool), /Don't answer it/);
  }
});

test("a prompt loses the label and quotes a model may wrap it in", () => {
  assert.equal(cleanPrompt('"Write a story"'), "Write a story");
  assert.equal(cleanPrompt("“Write a story”"), "Write a story");
  assert.equal(cleanPrompt("Prompt: Write a story"), "Write a story");
  assert.equal(cleanPrompt("**Improved prompt:** Write a story"), "Write a story");
  assert.equal(cleanPrompt("Write a \"short\" story"), 'Write a "short" story');
});

test("the most a rewrite can cost is a small message on every level, and the hold covers it", () => {
  const system = helperSystem("search");
  for (const model of Object.values(LEVEL_MODELS)) {
    const most = callMaxCents(model, system.length + IDEA_CHARS, HELPER_TOKENS);
    // Held at creditsFor(most): never less than the call can cost Flash.
    assert.ok(creditsFor(most) >= most, model);
    assert.ok(creditsFor(most) <= 50, `${model}: ${creditsFor(most)} credits at most`);
  }
});
