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
// The runs the first tests leave going count against the paid runs Flash-wide at once (10 by default):
// room for them, as LIMITS gives, so a later test's tick still claims its run.
process.env.AUTOMATION_MAX_PAID = "50";
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
const { REFUNDED } = await import("../src/lib/server/automation-runner.ts");
const { creditsFor, claudePrice, readCostCents } = await import("../src/lib/credits.ts");
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
 * ends with exactly one charge, no second paid call, and every hold settled. A run that ends interrupted
 * (its call had been sent) failed because of Flash, so that charge is then given back (see REFUNDED).
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
  const run = (await one<{ status: "done" | "interrupted"; outcome: string; credits: number; refunded: number; finished_at: number }>(
    "SELECT status, outcome, credits, refunded, finished_at FROM automation_runs WHERE id = ?",
    [rid],
  ))!;
  const calls = claude.streamed().filter((s) => String(s.body.system).includes(`"${name}"`)).length;
  // What its step was charged: the credits its holds settled at.
  const charges = holds.filter((h) => Number(h.credits) > 0);
  assert.equal(charges.length, 1, "exactly one charge");
  const used = Number(charges[0].credits);
  assert.ok(holds.length >= 1 && holds.every((h) => Number(h.settled_at) > 0), "every hold settled");
  assert.ok(ledger.every((l) => Number(l.settled_at) > 0));
  for (const h of holds) assert.ok(Number(h.credits) <= Number(h.held), "never above the hold");
  const kept = ledger.filter((l) => Number(l.amount) !== 0);
  if (REFUNDED.has(run.status)) {
    assert.deepEqual(kept, [], "all of it given back");
    assert.equal(await F.balance(user.id), 100, "the balance lost nothing");
    assert.deepEqual([Number(run.credits), Number(run.refunded)], [0, used], "the run gave back that charge");
  } else {
    assert.deepEqual(kept.map((l) => -Number(l.amount)), [used]);
    assert.equal(await F.balance(user.id), 100 - used, "the balance lost only that charge");
    assert.deepEqual([Number(run.credits), Number(run.refunded)], [used, 0], "the run's credits are that charge");
  }
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

test("killed in the middle of Claude's reply: settled by the reaper's rule, then given back as the run ends interrupted, never called again", async () => {
  const r = await killedAt("mid-stream", 3);
  assert.equal(claude.state.open, 0, "the dead server's reply was cut off");
  assert.equal(r.calls, 1, "no second paid call");
  assert.equal(r.holds.length, 1);
  assert.equal(Number(r.holds[0].credits), reaperCredits(r.before as never, true));
  assert.ok(Number(r.holds[0].credits) > 0, "what Claude may have billed is charged");
  assert.deepEqual([r.run.status, r.run.outcome, Number(r.run.refunded)], ["interrupted", "interrupted", Number(r.holds[0].credits)]);
});

test("killed after Claude's reply, before the settle: charged exactly its final cost, then given back as the run ends interrupted, never called again", async () => {
  const r = await killedAt("before-settle", 4);
  assert.equal(Number(r.before.done), 1);
  assert.equal(r.calls, 1);
  assert.equal(r.holds.length, 1);
  assert.equal(Number(r.holds[0].credits), sonicBill(), "what chat would have charged for that reply");
  assert.deepEqual([r.run.status, r.run.outcome, Number(r.run.refunded)], ["interrupted", "interrupted", sonicBill()]);
});

for (const credits of [100, 1000]) {
  test(`stepped down (Ultra busy, then Vision), killed mid-call with ${credits} credits: the reaper charges by the Vision call that was sent, and names it`, async () => {
    const user = await F.account(`stepdown${credits}`, credits);
    const name = `Stepped down ${credits}`;
    const spec = { v: 1, trigger: { type: "manual" }, steps: [{ id: "a1", do: "ai", mode: "write", level: "ultra", prompt: "Write one line about the weather." }, { id: "n1", do: "notify" }] };
    const aid = await F.automation({ userId: user.id, spec: spec as never, capRun: 2000, capMonth: 20000, name });
    const rid = await F.runRow({ automationId: aid, userId: user.id });
    // Ultra answers 529 before it starts, so the step steps down to Vision, whose reply never ends.
    claude.state.replies = [{ status: 529 }, { never: true }];
    const k = await F.startWorker(dbFile);
    workers.push(k);
    const mine = (await k.call<{ id: string; owner: string }[]>("claim", `wsd${credits}`, LIMITS)).find((c) => c.id === rid)!;
    void k.call("advance", rid, mine.owner, Date.now() + 760_000).catch(() => {});
    const until = Date.now() + 5000;
    while (claude.state.open < 1 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    assert.equal(claude.state.open, 1, "Vision's reply had begun");
    const sent = claude.streamed().filter((x) => String(x.body.system).includes(`"${name}"`));
    assert.deepEqual(sent.map((x) => x.body.model), [LEVEL_MODELS.ultra, LEVEL_MODELS.vision]);
    const maxTokens = Number(sent[1].body.max_tokens);
    assert.equal(JSON.stringify(sent[1].body).includes("fallback"), false, "the Vision call asks for no fallback");
    await k.kill();
    while (claude.state.open > 0 && Date.now() < until + 5000) await new Promise((r) => setTimeout(r, 10));
    const hold = (await one<Record<string, number | string>>("SELECT * FROM credit_holds WHERE run_id = ?", [rid]))!;
    // Before the Vision call was sent, its hold named it, at its prices, with the most it may cost.
    // (Its input as counted: Claude's 1200 tokens and the room the step's tools take.)
    const tokens = Math.round((Number(hold.input_cents) * 1e6) / claudePrice(LEVEL_MODELS.vision).input);
    assert.ok(tokens >= 1200 && Math.abs(Number(hold.input_cents) - readCostCents(LEVEL_MODELS.vision, tokens)) < 1e-9, `read at Vision's price (${hold.input_cents})`);
    const visionMost = readCostCents(LEVEL_MODELS.vision, tokens) + (maxTokens * claudePrice(LEVEL_MODELS.vision, tokens).output) / 1e6;
    assert.equal(hold.model, LEVEL_MODELS.vision);
    assert.ok(Math.abs(Number(hold.cap_cents) - visionMost) < 1e-9, `${hold.cap_cents} vs ${visionMost}`);
    const shift = Number(hold.lease_until) - Date.now() + 1000;
    await sql("UPDATE credit_holds SET lease_until = lease_until - ?, checked_at = checked_at - ?, created_at = created_at - ? WHERE run_id = ?", [shift, shift, shift, rid]);
    await sql("UPDATE automation_runs SET lease_until = 1 WHERE id = ?", [rid]);
    await B.call("tick", `tsd${credits}`);
    const charged = Number((await one<{ credits: number }>("SELECT credits FROM credit_holds WHERE run_id = ?", [rid]))!.credits);
    assert.ok(charged > 0 && charged <= creditsFor(visionMost), `charged ${charged}, at most ${creditsFor(visionMost)} for the Vision call`);
    assert.ok(charged < Number(hold.held), "less than the hold sized for Ultra");
    const usage = await all<{ model: string }>("SELECT model FROM usage WHERE automation_id = ?", [aid]);
    assert.deepEqual(usage.map((u) => u.model), [LEVEL_MODELS.vision], "/admin names the model that was called");
    const step = (await one<{ model: string; status: string }>("SELECT model, status FROM automation_run_steps WHERE run_id = ? AND step_id = 'a1'", [rid]))!;
    assert.deepEqual([step.model, step.status], [LEVEL_MODELS.vision, "interrupted"], "so does its receipt");
    // Then given back: the run ended interrupted, a failure of Flash's (see REFUNDED).
    const run = (await one<{ status: string; credits: number; refunded: number }>("SELECT status, credits, refunded FROM automation_runs WHERE id = ?", [rid]))!;
    assert.deepEqual([run.status, Number(run.credits), Number(run.refunded)], ["interrupted", 0, charged]);
    assert.equal(await F.balance(user.id), credits);
  });
}
