import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
const { run } = await import("../src/lib/server/db.ts");
const { searchChats } = await import("../src/lib/server/search.ts");

test("chat search finds words inside a user's own chats, with a snippet", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'a@x.co', 'h', 0), ('u2', 'b@x.co', 'h', 0)");
  const save = (id: string, user: string, name: string, messages: unknown[], at: number) =>
    run("INSERT INTO projects (id, user_id, name, messages, updated_at) VALUES (?, ?, ?, ?, ?)", [id, user, name, JSON.stringify(messages), at]);
  await save("p1", "u1", "Bakery", [
    { role: "user", content: "Write a menu for my bakery" },
    { role: "assistant", content: "## Menu\n\n**Sourdough loaf**: $8. Our *croissants* are baked fresh every morning at 6 am." },
  ], 1);
  await save("p2", "u1", "Croissant poster", [{ role: "user", content: "A poster", attachmentName: "sourdough.png" }], 2);
  await save("p3", "u2", "Someone else", [{ role: "user", content: "croissants for everyone" }], 3);

  const hits = await searchChats("u1", "CROISSANT");
  assert.deepEqual(hits.map((h) => h.id), ["p2", "p1"], "newest first, and only u1's projects");
  assert.equal(hits[0].snippet, "", "p2 matched only by name");
  assert.equal(hits[1].role, "assistant");
  assert.match(hits[1].snippet, /^Menu Sourdough loaf: \$8\. Our croissants are baked fresh/);
  assert.doesNotMatch(hits[1].snippet, /\*/);

  // A file name inside the stored message isn't text the user sees, so it isn't a hit.
  assert.deepEqual((await searchChats("u1", "sourdough")).map((h) => h.id), ["p1"]);
  // LIKE wildcards are matched literally.
  assert.deepEqual(await searchChats("u1", "%_"), []);
  assert.deepEqual(await searchChats("u1", "a"), [], "one letter is too short");
});
