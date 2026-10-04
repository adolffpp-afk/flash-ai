import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
const { run, one } = await import("../src/lib/server/db.ts");
const { saveFile, listFiles, deleteFile } = await import("../src/lib/server/files.ts");
const { publicFileLink, publicFile } = await import("../src/lib/server/connector.ts");

test("My creations lists a user's own files by kind, newest first, and deletes them everywhere", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'a@x.co', 'h', 0), ('u2', 'b@x.co', 'h', 0)");
  const id = (url: string) => url.split("/").pop()!;
  const img = id(await saveFile("u1", "image/png", "a.png", Buffer.from("A")));
  const vid = id(await saveFile("u1", "video/mp4", "b.mp4", Buffer.from("BBBB")));
  await saveFile("u2", "image/png", "theirs.png", Buffer.from("C"));
  await run("UPDATE files SET created_at = 1 WHERE id = ?", [img]);
  await run("UPDATE files SET created_at = 2 WHERE id = ?", [vid]);

  assert.deepEqual((await listFiles("u1")).map((f) => f.id), [vid, img], "newest first, only theirs");
  assert.equal((await listFiles("u1"))[0].size, 4);
  assert.deepEqual((await listFiles("u1", "image")).map((f) => f.id), [img]);
  assert.deepEqual((await listFiles("u1", undefined, 2)).map((f) => f.id), [img], "the next page starts before the last one seen");

  const link = (await publicFileLink("u1", `/api/files/${img}`))!;
  assert.equal(await deleteFile("u2", img), false, "someone else can't delete it");
  assert.equal(await deleteFile("u1", img), true);
  assert.equal(await publicFile(link.split("/").pop()!), null, "its public link stops working");
  assert.equal(await one("SELECT 1 FROM public_files WHERE file_id = ?", [img]), null);
  assert.deepEqual((await listFiles("u1")).map((f) => f.id), [vid]);
});
