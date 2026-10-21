import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A file, so a second server (a fresh copy of db.ts) can open the same database.
const dir = mkdtempSync(join(tmpdir(), "flash-db-mark-"));
process.env.DATABASE_URL = `file:${join(dir, "flash.db")}`;

const first = await import("../src/lib/server/db.ts");
type Db = typeof import("../src/lib/server/db.ts");
const second = (await import(`../src/lib/server/db.ts?${"second"}`)) as Db;
const third = (await import(`../src/lib/server/db.ts?${"third"}`)) as Db;

const hasIndex = async (name: string) =>
  Boolean(await first.one("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?", [name]));

test("a server starting on a database already set up skips the setup, and a changed setup runs again", async () => {
  await first.db();
  const mark = await first.one<{ mark: string }>("SELECT mark FROM schema_mark WHERE id = 1");
  assert.ok(mark?.mark, "the setup leaves its mark");

  // An index the setup makes, gone: a server that skips the setup leaves it gone.
  await first.run("DROP INDEX users_referred_by");
  await second.db();
  assert.equal(await hasIndex("users_referred_by"), false);

  // A database whose mark is from another setup gets the whole setup again, and this one's mark.
  await first.run("UPDATE schema_mark SET mark = 'older'");
  await third.db();
  assert.equal(await hasIndex("users_referred_by"), true);
  assert.equal((await first.one<{ mark: string }>("SELECT mark FROM schema_mark WHERE id = 1"))?.mark, mark.mark);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
