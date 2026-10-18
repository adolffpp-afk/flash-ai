import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "./support/automation-fixtures.ts";

/*
 * Automations racing: two Flash servers (separate processes, each with its own database client on one
 * database file) claiming, starting and charging the same runs at once. A single :memory: connection
 * would pass whatever the SQL said, so these run on a file, through SQLite's own locks.
 */
const dir = mkdtempSync(join(tmpdir(), "flash-race-"));
const dbFile = join(dir, "race.db");
process.env.DATABASE_URL = `file:${dbFile}`;
for (const name of ["VERCEL_ENV", "RESEND_API_KEY", "FLASH_APP_URL"]) delete process.env[name];

const { one, run: sql } = await import("../src/lib/server/db.ts");
await sql("PRAGMA journal_mode = WAL");
const F = await import("./support/automation-fixtures.ts");
const { RUNNER_VERSION } = await import("../src/lib/automations.ts");

const workers: Worker[] = [];
after(async () => {
  await Promise.all(workers.map((w) => w.kill()));
  rmSync(dir, { recursive: true, force: true });
});
// Started one after the other: each opens the database (and its tables) before the next.
async function twoWorkers() {
  const a = await F.startWorker(dbFile);
  const b = await F.startWorker(dbFile);
  workers.push(a, b);
  return [a, b] as const;
}
const LIMITS = { perUser: 50, maxPaid: 50, maxOther: 50, paidOpen: 1 as const, perTick: 50, runnerVersion: RUNNER_VERSION };
const STEP = { stepId: "a1", kind: "ai", budgetMs: 180_000, paid: true, maxPaid: 50 };
const [A, B] = await twoWorkers();

test("of two servers claiming the same runs at once, each run goes to exactly one", async () => {
  const user = await F.account("racer1", 100);
  const aid = await F.automation({ userId: user.id });
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(await F.runRow({ automationId: aid, userId: user.id }));
  const [x, y] = await Promise.all([A.call<{ id: string; owner: string }[]>("claim", "wa", LIMITS), B.call<{ id: string; owner: string }[]>("claim", "wb", LIMITS)]);
  const claimed = [...x, ...y].map((c) => c.id).sort();
  assert.deepEqual(claimed, [...ids].sort(), "every run was claimed, none twice");
  for (const c of x) assert.equal(c.owner, `wa:${c.id}`);
  for (const c of y) assert.equal(c.owner, `wb:${c.id}`);
  const owners = await one<{ n: number }>("SELECT COUNT(DISTINCT lease_owner) AS n FROM automation_runs WHERE automation_id = ?", [aid]);
  assert.equal(Number(owners!.n), 12);
});

test("a run whose lease ran out while its worker waited before the step is started once, by the new owner", async () => {
  const user = await F.account("racer2", 100);
  const aid = await F.automation({ userId: user.id });
  const rid = await F.runRow({ automationId: aid, userId: user.id });
  const [first] = await A.call<{ id: string; owner: string }[]>("claim", "wa", LIMITS);
  assert.equal(first.id, rid);
  // A's lease runs out between its checks and its step (a slow instance), and B claims the run.
  await sql("UPDATE automation_runs SET lease_until = 1 WHERE id = ?", [rid]);
  const [second] = await B.call<{ id: string; owner: string }[]>("claim", "wb", LIMITS);
  assert.equal(second.owner, `wb:${rid}`);
  // Both try to start the step at once: only the lease's owner does.
  const [a, b] = await Promise.all([A.call("start", rid, first.owner, STEP), B.call<{ attempt: number; ref: string }>("start", rid, second.owner, STEP)]);
  assert.equal(a, "lost");
  assert.deepEqual(b, { attempt: 1, ref: `auto:${rid}:a1:1` });
  const steps = await one<{ n: number }>("SELECT COUNT(*) AS n FROM automation_run_steps WHERE run_id = ?", [rid]);
  assert.equal(Number(steps!.n), 1, "one step row: the step started once");
});

test("even with a stale lease taken back (a clock gone wrong), one step of a run runs at a time", async () => {
  const user = await F.account("racer3", 100);
  const aid = await F.automation({ userId: user.id });
  const rid = await F.runRow({ automationId: aid, userId: user.id });
  const [claimed] = await B.call<{ id: string; owner: string }[]>("claim", "wb", LIMITS);
  assert.deepEqual(await B.call("start", rid, claimed.owner, STEP), { attempt: 1, ref: `auto:${rid}:a1:1` });
  // The old owner's lease comes back as if it were live: the compare-and-set lets it through, and
  // the one-running-step index still stops it, writing nothing (its batch is undone).
  await sql("UPDATE automation_runs SET lease_owner = 'wa:' || id WHERE id = ?", [rid]);
  assert.equal(await A.call("start", rid, `wa:${rid}`, STEP), "lost");
  const row = await one<{ attempts: number; n: number }>(
    "SELECT attempts, (SELECT COUNT(*) FROM automation_run_steps WHERE run_id = r.id) AS n FROM automation_runs r WHERE id = ?",
    [rid],
  );
  assert.equal(Number(row!.attempts), 1, "the losing batch changed nothing");
  assert.equal(Number(row!.n), 1);
});

test("20 charges at once from two servers never pass a month limit of 10 credits", async () => {
  const user = await F.account("racer4", 500);
  const aid = await F.automation({ userId: user.id, capMonth: 10 });
  const charge = (i: number) => ({
    account: user.id,
    actor: user.id,
    amount: 1,
    reason: "test",
    ref: `auto:race4:${i}`,
    automationId: aid,
    monthCap: 10,
    monthStart: 0,
    keepTopUpLevel: true,
  });
  const [x, y] = await Promise.all([
    A.call<{ id?: number; refused?: string }[]>("charge", Array.from({ length: 10 }, (_, i) => charge(i))),
    B.call<{ id?: number; refused?: string }[]>("charge", Array.from({ length: 10 }, (_, i) => charge(i + 10))),
  ]);
  const taken = [...x, ...y].filter((r) => r.id);
  assert.equal(taken.length, 10);
  assert.ok([...x, ...y].filter((r) => r.refused).every((r) => r.refused === "month"));
  assert.equal(await F.balance(user.id), 490);
});

test("20 charges at once from two servers never take a balance below zero", async () => {
  const user = await F.account("racer5", 7);
  const aid = await F.automation({ userId: user.id, capMonth: 1000 });
  const charge = (i: number) => ({ account: user.id, actor: user.id, amount: 1, reason: "test", ref: `auto:race5:${i}`, automationId: aid, monthCap: 1000, monthStart: 0, keepTopUpLevel: true });
  const [x, y] = await Promise.all([
    A.call<{ id?: number }[]>("charge", Array.from({ length: 10 }, (_, i) => charge(i))),
    B.call<{ id?: number }[]>("charge", Array.from({ length: 10 }, (_, i) => charge(i + 10))),
  ]);
  assert.equal([...x, ...y].filter((r) => r.id).length, 7);
  assert.equal(await F.balance(user.id), 0);
});
