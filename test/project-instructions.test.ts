import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_INSTRUCTIONS, cleanInstructions, withInstructions } from "../src/lib/project-instructions.ts";

process.env.DATABASE_URL = ":memory:";
const { run, one } = await import("../src/lib/server/db.ts");

test("a project's instructions follow the user's memory", () => {
  assert.equal(withInstructions("I run a bakery.", ""), "I run a bakery.");
  assert.equal(withInstructions("I run a bakery.", "   "), "I run a bakery.");
  assert.equal(
    withInstructions("I run a bakery.", " Answer in French. "),
    "I run a bakery.\n\nInstructions for this project (follow them in every answer here unless the user says otherwise):\nAnswer in French.",
  );
  assert.match(withInstructions("", "Be brief."), /^Instructions for this project .*\nBe brief\.$/);
  assert.equal(cleanInstructions("x".repeat(MAX_INSTRUCTIONS + 50)).length, MAX_INSTRUCTIONS);
});

test("projects keep their instructions", async () => {
  await run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'a@b.c', 'A', 'x', 0)");
  await run("INSERT INTO projects (id, user_id, name, updated_at) VALUES ('p1', 'u1', 'Bakery', 0)");
  assert.equal((await one<{ instructions: string }>("SELECT instructions FROM projects WHERE id = 'p1'"))?.instructions, "");
  await run("UPDATE projects SET instructions = ? WHERE id = 'p1'", ["Answer in French."]);
  assert.equal((await one<{ instructions: string }>("SELECT instructions FROM projects WHERE id = 'p1'"))?.instructions, "Answer in French.");
});
