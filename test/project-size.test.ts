import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PROJECT_BYTES, PROJECT_TOO_LARGE, projectTooLarge } from "../src/lib/project-size.ts";
import { MAX_INSTRUCTIONS } from "../src/lib/project-instructions.ts";

test("projects stop saving under Vercel's 4.5 MB limit, with a reason people can act on", () => {
  const VERCEL_LIMIT = 4.5 * 1000 * 1000;
  // The saved chat plus the rest of the request (the name and a few brackets) still fits, and so
  // does opening it again, with the project's instructions (3 bytes a letter at most).
  assert.ok(MAX_PROJECT_BYTES + 1000 < VERCEL_LIMIT);
  assert.ok(MAX_PROJECT_BYTES + 3 * MAX_INSTRUCTIONS + 1000 < VERCEL_LIMIT);
  const fits = JSON.stringify([{ role: "user", content: "a".repeat(MAX_PROJECT_BYTES - 100) }]);
  assert.equal(projectTooLarge(fits), false);
  assert.equal(projectTooLarge(JSON.stringify([{ role: "user", content: "a".repeat(MAX_PROJECT_BYTES) }])), true);
  // Counted in bytes as sent, so text in other alphabets can't slip past.
  const greek = JSON.stringify([{ role: "user", content: "α".repeat(MAX_PROJECT_BYTES / 2 + 10) }]);
  assert.ok(greek.length < MAX_PROJECT_BYTES);
  assert.equal(projectTooLarge(greek), true);
  assert.match(PROJECT_TOO_LARGE, /too big to save/);
  assert.match(PROJECT_TOO_LARGE, /download the chat/);
});
