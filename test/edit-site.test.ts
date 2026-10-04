import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
const { run } = await import("../src/lib/server/db.ts");
const { projectForSite } = await import("../src/lib/server/sites.ts");

test("Edit finds the owner's chat that published a site", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'a@x.co', 'h', 0), ('u2', 'b@x.co', 'h', 0)");
  const msgs = (slug: string) => JSON.stringify([{ id: "m1", role: "assistant", content: "", app: { title: "Crumb", html: "<p>", kind: "app", slug } }]);
  await run("INSERT INTO projects (id, user_id, name, messages, updated_at) VALUES ('old', 'u1', 'Old', ?, 1), ('new', 'u1', 'New', ?, 2), ('other', 'u2', 'Theirs', ?, 3)", [
    msgs("crumb-1"),
    msgs("crumb-1"),
    msgs("crumb-1"),
  ]);
  assert.equal(await projectForSite("u1", "crumb-1"), "new", "the newest of the owner's chats");
  assert.equal(await projectForSite("u2", "crumb-1"), "other", "only the asker's own chats");
  assert.equal(await projectForSite("u1", "crumb-12"), null, "a longer slug doesn't match");
  assert.equal(await projectForSite("u1", "crumb"), null);
  assert.equal(await projectForSite("u1", '%"'), null);
});
