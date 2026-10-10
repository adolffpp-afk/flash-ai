import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PROJECT_BYTES, PROJECT_FULL, PROJECT_TOO_LARGE, REPLY_ROOM_BYTES, projectTooLarge, roomForTurn } from "../src/lib/project-size.ts";
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

test("a chat too big to keep another turn gets no more messages, so none is run or charged", () => {
  const message = { id: "m1", role: "user", content: "Make it darker" };
  assert.equal(roomForTurn(1_000_000, message), true);
  // Saved by the server with no size check before, a chat could grow past what opens again.
  assert.equal(roomForTurn(MAX_PROJECT_BYTES - REPLY_ROOM_BYTES, message), false);
  // A long message counts in bytes, and a change to an app saves the whole app again.
  assert.equal(roomForTurn(3_000_000, { ...message, content: "α".repeat(400_000) }), false);
  assert.equal(roomForTurn(3_000_000, message, "<p>".repeat(300_000)), false);
  // After a turn that fit, the chat still saves and opens: the reply had room.
  const before = MAX_PROJECT_BYTES - REPLY_ROOM_BYTES - 1000;
  assert.equal(roomForTurn(before, message), true);
  assert.ok(before + 200 + REPLY_ROOM_BYTES <= MAX_PROJECT_BYTES);
  assert.match(PROJECT_FULL, /too big for more messages/);
});
