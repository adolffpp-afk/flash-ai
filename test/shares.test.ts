import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
const { run } = await import("../src/lib/server/db.ts");
const { saveFile } = await import("../src/lib/server/files.ts");
const { createShare, getShare, sharedFile, deleteShares, shareable } = await import("../src/lib/server/shares.ts");

test("a shared copy drops errors, unfinished replies and app code, and points files at the share", () => {
  const out = shareable(
    [
      { id: "1", role: "user", content: "Make a logo" },
      { id: "2", role: "assistant", content: "", images: [{ url: "/api/files/abc", prompt: "logo" }], cost: 9 },
      { id: "3", role: "assistant", content: "", error: "Busy", pending: false },
      { id: "4", role: "assistant", content: "Here", app: { html: "<script>secret()</script>", title: "T", slug: "my-app" } as never },
      { id: "5", role: "assistant", content: "…", pending: true },
    ],
    "S1",
  );
  assert.deepEqual(out.map((m) => m.id), ["1", "2", "4"]);
  assert.equal(out[1].images![0].url, "/s/S1/files/abc");
  assert.equal("cost" in out[1] && out[1].cost !== undefined, false);
  assert.equal(JSON.stringify(out).includes("secret()"), false);
  assert.match(out[2].content, /\/p\/my-app/);
});

test("only the owner can share a project, and only files the chat shows are served", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'a@x.co', 'h', 0), ('u2', 'b@x.co', 'h', 0)");
  const shown = (await saveFile("u1", "image/png", "a.png", Buffer.from("A"))).split("/").pop()!;
  const hidden = (await saveFile("u1", "image/png", "b.png", Buffer.from("B"))).split("/").pop()!;
  const messages = [
    { id: "1", role: "user", content: "hi" },
    { id: "2", role: "assistant", content: "", images: [{ url: `/api/files/${shown}`, prompt: "p" }] },
  ];
  await run("INSERT INTO projects (id, user_id, name, messages, updated_at) VALUES ('p1', 'u1', 'Logos', ?, 0)", [JSON.stringify(messages)]);

  assert.equal(await createShare("u2", "p1"), null, "someone else's project");
  const id = (await createShare("u1", "p1"))!;
  const share = await getShare(id);
  assert.equal(share?.title, "Logos");
  assert.ok(await sharedFile(id, shown));
  assert.equal(await sharedFile(id, hidden), null, "a file the chat doesn't show");
  assert.equal(await deleteShares("u1", "p1"), 1);
  assert.equal(await getShare(id), null);
});
