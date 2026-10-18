import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "./support/automation-fixtures.ts";

/*
 * Automations racing: two Flash servers (separate processes, each with its own database client on one
 * database file) claiming, starting and charging the same runs at once. A single :memory: connection
 * would pass whatever the SQL said, so these run on a file, through SQLite's own locks. Then a server
 * killed in each window of a paid step (support/claude-stand-in.ts is Claude, for every process).
 */
const dir = mkdtempSync(join(tmpdir(), "flash-race-"));
const dbFile = join(dir, "race.db");
process.env.DATABASE_URL = `file:${dbFile}`;
for (const name of ["VERCEL_ENV", "VERCEL", "RESEND_API_KEY", "FLASH_APP_URL", "FLASH_DEMO_EMAILS", "FRED_API_KEY", "AUTOMATION_MAX_PAID"]) delete process.env[name];
// Set before the workers start, so each of them calls the stand-in.
const { claudeStandIn } = await import("./support/claude-stand-in.ts");
const claude = await claudeStandIn();
process.env.ANTHROPIC_BASE_URL = claude.url;
process.env.ANTHROPIC_API_KEY = "chat-key-for-tests";
process.env.ANTHROPIC_AUTOMATIONS_API_KEY = "automations-key-for-tests";

const { one, all, run: sql } = await import("../src/lib/server/db.ts");
await sql("PRAGMA journal_mode = WAL");
const F = await import("./support/automation-fixtures.ts");
const { RUNNER_VERSION } = await import("../src/lib/automations.ts");
const { reaperCredits } = await import("../src/lib/server/credit-holds.ts");
const { creditsFor, claudePrice } = await import("../src/lib/credits.ts");
const { LEVEL_MODELS } = await import("../src/lib/engines/claude.ts");

const workers: Worker[] = [];
after(async () => {
  await Promise.all(workers.map((w) => w.kill()));
  await claude.close();
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

test("two runs of one automation finishing at once on two servers keep one receipt chain: the later names the earlier", async () => {
  const user = await F.account("racer6", 100);
  const aid = await F.automation({ userId: user.id });
  const first = await F.runRow({ automationId: aid, userId: user.id });
  const [a] = (await A.call<{ id: string; owner: string }[]>("claim", "wa", LIMITS)).filter((c) => c.id === first);
  const second = await F.runRow({ automationId: aid, userId: user.id });
  const [b] = (await B.call<{ id: string; owner: string }[]>("claim", "wb", LIMITS)).filter((c) => c.id === second);
  assert.ok(a && b, "each server holds one of the runs");
  // A reads the chain's head and waits there; B's run ends meanwhile, moving the head on.
  await A.call("arm", "before-finish");
  const going = A.call("advance", first, a.owner, Date.now() + 760_000);
  assert.deepEqual(await A.reached("before-finish"), { runId: first, prev: "" });
  await B.call("advance", second, b.owner, Date.now() + 760_000);
  A.go();
  await going;
  const rows = await all<{ id: string; receipt: string; receipt_hash: string }>("SELECT id, receipt, receipt_hash FROM automation_runs WHERE id IN (?, ?)", [first, second]);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.ok(byId[first].receipt_hash && byId[second].receipt_hash, "both runs ended with a fingerprint");
  assert.equal(JSON.parse(byId[second].receipt).prev, "", "the run that ended first starts the chain");
  assert.equal(JSON.parse(byId[first].receipt).prev, byId[second].receipt_hash, "the later run's receipt names the earlier one");
  const head = await one<{ receipt_hash: string }>("SELECT receipt_hash FROM automations WHERE id = ?", [aid]);
  assert.equal(head!.receipt_hash, byId[first].receipt_hash, "the chain's head is the last run's fingerprint");
});


/*
 * A server killed in each window of a paid step: after its hold is recorded, after the charge (before
 * the charge's id is kept on the hold), in the middle of Claude's reply, and after the reply before
 * the settle. The next tick (on the other server, once the leases ran out) settles what it left: each
 * ends with exactly one charge, no second paid call, and every hold settled.
 */
const sonicBill = () => {
  const p = claudePrice(LEVEL_MODELS.sonic, 1200);
  return creditsFor((1200 * p.input + 300 * p.output) / 1e6);
};
type Ledger = { ref: string; amount: number; settled_at: number };
async function killedAt(point: "after-hold" | "after-charge" | "mid-stream" | "before-settle", n: number) {
  const user = await F.account(`killed${n}`, 100);
  const name = `Killed ${point}`;
  const aid = await F.automation({ userId: user.id, name });
  const rid = await F.runRow({ automationId: aid, userId: user.id });
  claude.state.replies = point === "mid-stream" ? [{ never: true }] : [];
  const k = await F.startWorker(dbFile);
  workers.push(k);
  if (point !== "mid-stream") await k.call("arm", point);
  const claimed = await k.call<{ id: string; owner: string }[]>("claim", "wk", LIMITS);
  const mine = claimed.find((c) => c.id === rid)!;
  assert.ok(mine, "the doomed server claimed the run");
  void k.call("advance", rid, mine.owner, Date.now() + 760_000).catch(() => {});
  if (point === "mid-stream") {
    const until = Date.now() + 5000;
    while (claude.state.open < 1 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    assert.equal(claude.state.open, 1, "Claude's reply had begun");
  } else await k.reached(point);
  await k.kill();
  if (point === "mid-stream") {
    const until = Date.now() + 5000;
    while (claude.state.open > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  }
  // Time passes: the hold's lease runs out as it would (its checkpoint as old as its lease), and the run's.
  const hold = (await one<Record<string, number>>("SELECT * FROM credit_holds WHERE run_id = ?", [rid]))!;
  const shift = Number(hold.lease_until) - Date.now() + 1000;
  await sql("UPDATE credit_holds SET lease_until = lease_until - ?, checked_at = checked_at - ?, created_at = created_at - ? WHERE run_id = ?", [shift, shift, shift, rid]);
  await sql("UPDATE automation_runs SET lease_until = 1 WHERE id = ?", [rid]);
  const before = (await one<Record<string, number>>("SELECT * FROM credit_holds WHERE run_id = ?", [rid]))!;
  // The next tick, on the server still standing: the reaper, then the claim and the run.
  await B.call("tick", `tb${n}`);
  const ledger = await all<Ledger>("SELECT ref, amount, settled_at FROM credit_ledger WHERE ref LIKE ? ORDER BY id", [`auto:${rid}:%`]);
  const holds = await all<{ ref: string; settled_at: number; credits: number; held: number }>("SELECT ref, settled_at, credits, held FROM credit_holds WHERE run_id = ?", [rid]);
  const run = (await one<{ status: string; outcome: string; credits: number; finished_at: number }>("SELECT status, outcome, credits, finished_at FROM automation_runs WHERE id = ?", [rid]))!;
  const calls = claude.streamed().filter((s) => String(s.body.system).includes(`"${name}"`)).length;
  const charged = ledger.filter((l) => Number(l.amount) !== 0);
  assert.equal(charged.length, 1, "exactly one charge");
  assert.ok(holds.length >= 1 && holds.every((h) => Number(h.settled_at) > 0), "every hold settled");
  assert.ok(ledger.every((l) => Number(l.settled_at) > 0));
  for (const h of holds) assert.ok(Number(h.credits) <= Number(h.held), "never above the hold");
  assert.equal(await F.balance(user.id), 100 + Number(charged[0].amount), "the balance lost only that charge");
  assert.equal(Number(run.credits), -Number(charged[0].amount), "the run's credits are that charge");
  assert.ok(Number(run.finished_at) > 0);
  return { ledger, holds, run, calls, before };
}

test("killed after its hold was recorded: nothing was charged, and the next tick runs the step once", async () => {
  const r = await killedAt("after-hold", 1);
  assert.equal(r.calls, 1, "one paid call: the next server's");
  assert.equal(r.ledger.length, 1, "the dead server never charged");
  assert.equal(r.holds.length, 2);
  assert.deepEqual(r.holds.map((h) => Number(h.credits)).sort((a, b) => a - b), [0, sonicBill()]);
  assert.deepEqual([r.run.status, r.run.outcome], ["done", "ok"]);
});

test("killed after the charge, before its id was kept: settled by ref at 0, and the next tick runs the step once", async () => {
  const r = await killedAt("after-charge", 2);
  assert.equal(Number(r.before.charge_id), 0, "the charge's id was never kept on the hold");
  assert.equal(r.calls, 1);
  assert.equal(r.ledger.length, 2, "the dead server's charge stays, lowered to 0");
  assert.equal(Number(r.ledger[0].amount), 0);
  assert.equal(Number(r.ledger[1].amount), -sonicBill());
  assert.deepEqual([r.run.status, r.run.outcome], ["done", "ok"]);
});

test("killed in the middle of Claude's reply: settled by the reaper's rule, the run ends interrupted, never called again", async () => {
  const r = await killedAt("mid-stream", 3);
  assert.equal(claude.state.open, 0, "the dead server's reply was cut off");
  assert.equal(r.calls, 1, "no second paid call");
  assert.equal(r.holds.length, 1);
  assert.equal(Number(r.ledger[0].amount), -reaperCredits(r.before as never, true));
  assert.ok(Number(r.ledger[0].amount) < 0, "what Claude may have billed is charged");
  assert.deepEqual([r.run.status, r.run.outcome], ["interrupted", "interrupted"]);
});

test("killed after Claude's reply, before the settle: charged exactly its final cost, the run ends interrupted, never called again", async () => {
  const r = await killedAt("before-settle", 4);
  assert.equal(Number(r.before.done), 1);
  assert.equal(r.calls, 1);
  assert.equal(r.holds.length, 1);
  assert.equal(Number(r.ledger[0].amount), -sonicBill(), "what chat would have charged for that reply");
  assert.deepEqual([r.run.status, r.run.outcome], ["interrupted", "interrupted"]);
});
