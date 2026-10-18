import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./support/route-hooks.mjs", import.meta.url);

/*
 * The automation runner, with Claude stood in for (support/claude-stand-in.ts): Write and Research
 * runs end to end on the automations key, retries before Claude started (free, with a new ref), a
 * failure part way (charged as chat charges it, never retried), the step's deadline, heartbeats that
 * fail or find their hold settled, Stop, a short budget, versions, pausing and deleting mid-run, an
 * earlier attempt left behind, a price rise, "only if changed", and the receipt chain.
 */
const { claudeStandIn } = await import("./support/claude-stand-in.ts");
const claude = await claudeStandIn();
process.env.DATABASE_URL = ":memory:";
process.env.ANTHROPIC_BASE_URL = claude.url;
process.env.ANTHROPIC_API_KEY = "chat-key-for-tests";
process.env.ANTHROPIC_AUTOMATIONS_API_KEY = "automations-key-for-tests";
for (const name of ["VERCEL_ENV", "VERCEL", "RESEND_API_KEY", "FLASH_DEMO_EMAILS", "FLASH_APP_URL", "FRED_API_KEY", "AUTOMATION_MAX_PAID"]) delete process.env[name];

const { one, all, run: sql } = await import("../src/lib/server/db.ts");
const F = await import("./support/automation-fixtures.ts");
const A = await import("../src/lib/automations.ts");
const R = await import("../src/lib/server/automation-runner.ts");
const S = await import("../src/lib/server/automation-steps.ts");
const T = await import("../src/lib/server/automation-tick.ts");
const H = await import("../src/lib/server/credit-holds.ts");
const { creditsFor, claudePrice } = await import("../src/lib/credits.ts");
const { LEVEL_MODELS } = await import("../src/lib/engines/claude.ts");
type Spec = import("../src/lib/automations.ts").Spec;

after(() => claude.close());
const TIMING = { ...S.STEP_TIMING };
const BUDGETS = { ...A.STEP_BUDGET_MS };
beforeEach(() => {
  Object.assign(S.STEP_TIMING, TIMING);
  Object.assign(A.STEP_BUDGET_MS, BUDGETS);
  claude.state.replies = [];
  claude.state.count = { tokens: 1200, status: 0 };
});

/** Leases a run to this test as a claim would, and returns its owner token. */
async function lease(runId: string) {
  await sql(
    `UPDATE automation_runs SET lease_owner = 'w:' || id, lease_until = CAST(unixepoch('subsec') * 1000 AS INTEGER) + 120000,
            status = CASE status WHEN 'queued' THEN 'running' ELSE status END WHERE id = ?`,
    [runId],
  );
  return `w:${runId}`;
}
/** Runs an automation's run in this process until it ends, waits or is handed on. */
async function advance(runId: string, deadline = Date.now() + 760_000) {
  await R.advanceRun(runId, await lease(runId), deadline);
}
const runOf = (id: string) => one<Record<string, unknown>>("SELECT * FROM automation_runs WHERE id = ?", [id]);
const stepsOf = (id: string) => all<Record<string, unknown>>("SELECT * FROM automation_run_steps WHERE run_id = ? ORDER BY started_at, attempt", [id]);
const ledgerOf = (runId: string) => all<{ ref: string; amount: number; settled_at: number }>("SELECT ref, amount, settled_at FROM credit_ledger WHERE ref LIKE ? ORDER BY id", [`auto:${runId}:%`]);
const holdsOf = (runId: string) => all<{ ref: string; settled_at: number; credits: number; held: number }>("SELECT ref, settled_at, credits, held FROM credit_holds WHERE run_id = ?", [runId]);
const noticesOf = (userId: string) => all<{ kind: string; phrase: string; blanks: string; ref: string }>("SELECT kind, phrase, blanks, ref FROM notifications WHERE user_id = ? ORDER BY created_at", [userId]);
const waitFor = async (check: () => boolean | Promise<boolean>, ms = 3000) => {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
// What the stand-in bills by default: 1,200 tokens read, 300 written, on a level's model.
const billed = (model: string, input = 1200, output = 300) => (input * claudePrice(model, input).input + output * claudePrice(model, input).output) / 1e6;

const RESEARCH_SPEC: Spec = {
  v: 1,
  trigger: { type: "manual" },
  steps: [
    { id: "r1", do: "ai", mode: "research", level: "sonic", prompt: "What happened in markets today?" },
    { id: "n1", do: "notify" },
  ],
};

test("a Write run: priced and run on the automations key, charged what chat charges, its answer saved and noticed", async () => {
  const u = await F.account("run1", 100);
  const aid = await F.automation({ userId: u.id });
  const rid = await F.runRow({ automationId: aid, userId: u.id });
  claude.state.seen.length = 0;
  claude.state.replies.push({ text: "Sunny and mild today." });
  await advance(rid);
  const run = await runOf(rid);
  assert.equal(run!.status, "done");
  assert.equal(run!.outcome, "ok");
  // Every call to Anthropic (counting and the reply) went with the automations key, never chat's.
  assert.ok(claude.state.seen.length >= 2);
  for (const s of claude.state.seen) assert.equal(s.headers["x-api-key"], "automations-key-for-tests");
  const sent = claude.streamed()[0].body;
  assert.equal(sent.model, LEVEL_MODELS.sonic);
  assert.match(String(sent.system), /This is an automation the user set up to run by itself: "Morning note"\. It runs when the user starts it; this run was started by the user at /);
  // Charged once, exactly as chat would charge this reply, and the hold settled.
  const charge = creditsFor(billed(LEVEL_MODELS.sonic));
  assert.deepEqual((await ledgerOf(rid)).map((l) => Number(l.amount)), [-charge]);
  assert.equal(Number(run!.credits), charge);
  assert.ok((await holdsOf(rid)).every((h) => Number(h.settled_at) > 0));
  const steps = await stepsOf(rid);
  assert.deepEqual(steps.map((s) => [s.step_id, s.status]), [["a1", "done"], ["n1", "done"]]);
  assert.equal(S.outputText(steps[0].output as Uint8Array), "Sunny and mild today.");
  const notices = await noticesOf(u.id);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].phrase, A.NOTICES.ready);
  assert.equal(JSON.parse(notices[0].blanks).text, "Sunny and mild today.");
  // The usage row says which automation it was for.
  const usage = await one<{ automation_id: string; credits: number }>("SELECT automation_id, credits FROM usage WHERE user_id = ? AND part = 0", [u.id]);
  assert.deepEqual({ ...usage }, { automation_id: aid, credits: charge });
});

test("Research on Sonic is priced and run at Ascend, its sources are saved, and the notice carries the answer", async () => {
  const u = await F.account("run2", 200);
  const aid = await F.automation({ userId: u.id, spec: RESEARCH_SPEC });
  const rid = await F.runRow({ automationId: aid, userId: u.id });
  claude.state.seen.length = 0;
  claude.state.replies.push({
    blocks: [
      { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "markets today" } },
      { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", url: "https://news.example.com/markets", title: "Markets close higher", encrypted_content: "x" }] },
      { type: "text", text: "Stocks rose." },
    ],
  });
  await advance(rid);
  assert.equal((await runOf(rid))!.status, "done");
  const counted = claude.state.seen.find((s) => s.path.endsWith("/count_tokens"))!;
  assert.equal(counted.body.model, LEVEL_MODELS.ascend);
  assert.equal(claude.streamed()[0].body.model, LEVEL_MODELS.ascend);
  const steps = await stepsOf(rid);
  assert.equal(steps[0].level, "sonic");
  assert.equal(steps[0].model, LEVEL_MODELS.ascend);
  const { gunzipSync } = await import("node:zlib");
  const saved = JSON.parse(gunzipSync(Buffer.from(steps[0].output as Uint8Array)).toString()) as { text: string; sources: { url: string }[] };
  assert.equal(saved.text, "Stocks rose.");
  assert.deepEqual(saved.sources.map((s) => s.url), ["https://news.example.com/markets"]);
});

test("Claude busy (529) before it started: nothing is charged, and the next attempt later has a new ref", async () => {
  const u = await F.account("run3", 100);
  const aid = await F.automation({ userId: u.id });
  const rid = await F.runRow({ automationId: aid, userId: u.id });
  const dueBefore = Date.now();
  claude.state.replies.push({ status: 529 });
  await advance(rid);
  let run = await runOf(rid);
  assert.equal(run!.lease_owner, "", "released");
  assert.equal(run!.status, "queued");
  assert.ok(Number(run!.due_at) >= dueBefore + 45_000, "a minute later, give or take a fifth");
  assert.deepEqual((await ledgerOf(rid)).map((l) => [l.ref, Number(l.amount)]), [[`auto:${rid}:a1:1`, 0]]);
  assert.equal((await stepsOf(rid))[0].status, "retried");
  // Its time comes: a new attempt, a new hold and ref, charged once.
  await sql("UPDATE automation_runs SET due_at = 0 WHERE id = ?", [rid]);
  claude.state.replies.push({ text: "Now it worked." });
  await advance(rid);
  run = await runOf(rid);
  assert.equal(run!.status, "done");
  const ledger = await ledgerOf(rid);
  assert.deepEqual(ledger.map((l) => l.ref), [`auto:${rid}:a1:1`, `auto:${rid}:a1:2`]);
  assert.equal(Number(ledger[0].amount), 0);
  assert.equal(-Number(ledger[1].amount), creditsFor(billed(LEVEL_MODELS.sonic)));
});

test("a 429 also stops paid claims Flash-wide for a minute", async () => {
  const u = await F.account("run3b", 100);
  const aid = await F.automation({ userId: u.id });
  const rid = await F.runRow({ automationId: aid, userId: u.id });
  claude.state.replies.push({ status: 429 });
  await advance(rid);
  const { paidOpen } = await import("../src/lib/server/automations.ts");
  assert.equal(await paidOpen(), 0);
  await sql("DELETE FROM settings WHERE key = 'auto:backoff_until'");
});

test("a failure part way is charged for the work that ran, as chat charges it, and isn't tried again", async () => {
  const u = await F.account("run4", 100);
  const aid = await F.automation({ userId: u.id });
  const rid = await F.runRow({ automationId: aid, userId: u.id });
  const before = claude.streamed().length;
  claude.state.replies.push({ text: "Half an answer that goes on", cut: true });
  await advance(rid);
  const run = await runOf(rid);
  assert.equal(run!.status, "failed");
  assert.equal(claude.streamed().length, before + 1, "Claude was called once");
  const [charge] = await ledgerOf(rid);
  assert.ok(-Number(charge.amount) >= 1 && Number(charge.settled_at) > 0);
  const [hold] = await holdsOf(rid);
  assert.ok(-Number(charge.amount) <= Number(hold.held));
  assert.equal((await stepsOf(rid))[0].status, "failed");
  // Busy (529) on Research's second call, after the first was billed: charged too, never tried again.
  const u2 = await F.account("run4b", 2000);
  const aid2 = await F.automation({ userId: u2.id, spec: RESEARCH_SPEC, capRun: 1000, capMonth: 2000 });
  const rid2 = await F.runRow({ automationId: aid2, userId: u2.id });
  const before2 = claude.streamed().length;
  claude.state.replies.push(
    {
      blocks: [
        { type: "server_tool_use", id: "srv_9", name: "web_search", input: { query: "markets" } },
        { type: "web_search_tool_result", tool_use_id: "srv_9", content: [{ type: "web_search_result", url: "https://news.example.com/a", title: "A", encrypted_content: "x" }] },
        { type: "text", text: "So far: " },
      ],
      stop: "pause_turn",
    },
    { status: 529 },
  );
  await advance(rid2);
  assert.equal(claude.streamed().length, before2 + 2, "the second call was busy");
  assert.deepEqual([(await runOf(rid2))!.status, (await runOf(rid2))!.outcome], ["failed", "failed"]);
  const ledger2 = await ledgerOf(rid2);
  assert.equal(ledger2.length, 1, "one attempt, not tried again");
  assert.ok(-Number(ledger2[0].amount) >= 1, "the work that ran is paid for");
});

test("the deadline stops a reply that never ends at the step's budget: charged once for what it used, and not tried again", { timeout: 30_000 }, async () => {
  A.STEP_BUDGET_MS.write = 400;
  const u = await F.account("run5", 100);
  const aid = await F.automation({ userId: u.id });
  const rid = await F.runRow({ automationId: aid, userId: u.id });
  const before = claude.streamed().length;
  claude.state.replies.push({ text: "This goes on and on", never: true });
  const start = Date.now();
  await advance(rid);
  assert.ok(Date.now() - start < 3000, "stopped at its budget");
  await waitFor(() => claude.state.open === 0);
  const run = await runOf(rid);
  // What it wrote is delivered, cut short.
  assert.equal(run!.status, "done");
  const steps = await stepsOf(rid);
  assert.equal(steps[0].status, "done");
  assert.equal(steps[0].note, "cut_short");
  assert.equal(claude.streamed().length, before + 1);
  const ledger = await ledgerOf(rid);
  assert.equal(ledger.length, 1);
  assert.ok(-Number(ledger[0].amount) >= 1);
});

test("a heartbeat that fails stops the step once its last good one is too old; one that finds its hold settled stops it at once", { timeout: 30_000 }, async () => {
  Object.assign(S.STEP_TIMING, { heartbeatMs: 40, staleMs: 300, checkMs: 20 });
  const u = await F.account("run6", 100);
  const aid = await F.automation({ userId: u.id });
  const rid = await F.runRow({ automationId: aid, userId: u.id });
  // Every heartbeat (a write that renews the lease of a started hold) fails, as a Turso timeout would.
  await sql(`CREATE TRIGGER hb_fail BEFORE UPDATE OF spent_cents ON credit_holds WHEN OLD.started = 1 AND NEW.done = 0 BEGIN SELECT RAISE(ABORT, 'heartbeat refused'); END`);
  claude.state.replies.push({ text: "Thinking for a long time", never: true });
  const start = Date.now();
  await advance(rid);
  await sql("DROP TRIGGER hb_fail");
  const took = Date.now() - start;
  assert.ok(took >= 280 && took < 2000, `stopped after its last good heartbeat went stale (${took} ms)`);
  await waitFor(() => claude.state.open === 0);
  // It settled itself and wrote nothing more: the run isn't moved on, and the next claim ends it interrupted.
  const [hold] = await holdsOf(rid);
  assert.ok(Number(hold.settled_at) > 0);
  assert.equal((await stepsOf(rid))[0].status, "interrupted");
  assert.equal((await runOf(rid))!.status, "running");
  const streams = claude.streamed().length;
  await advance(rid);
  assert.equal((await runOf(rid))!.status, "interrupted");
  assert.equal(claude.streamed().length, streams, "never called again by itself");

  // The reaper settles a hold under a running step: its next heartbeat changes nothing, and it stops.
  const rid2 = await F.runRow({ automationId: aid, userId: u.id });
  claude.state.replies.push({ text: "Still going", never: true });
  const going = advance(rid2);
  await waitFor(() => claude.state.open === 1);
  const h = (await one<import("../src/lib/server/credit-holds.ts").Hold>("SELECT * FROM credit_holds WHERE run_id = ?", [rid2]))!;
  assert.equal(await R.reapHold(h), true);
  const reapedAt = Date.now();
  await going;
  assert.ok(Date.now() - reapedAt < 500, "stopped at its next heartbeat");
  await waitFor(() => claude.state.open === 0);
  // Settled once, by the reaper; the finisher lost and logged its cost at 0 credits.
  const ledger = await ledgerOf(rid2);
  assert.equal(ledger.length, 1);
  const reaped = (await holdsOf(rid2))[0];
  assert.equal(-Number(ledger[0].amount), Number(reaped.credits));
  const loss = await one<{ credits: number; cost_cents: number }>("SELECT credits, cost_cents FROM usage WHERE automation_id = ? AND part = 0 ORDER BY rowid DESC LIMIT 1", [aid]);
  assert.equal(Number(loss!.credits), 0);
  assert.ok(Number(loss!.cost_cents) > 0);
  assert.equal((await runOf(rid2))!.status, "interrupted");
});

test("Stop takes effect within 5 seconds and pays for what was used", { timeout: 30_000 }, async () => {
  const u = await F.account("run7", 100);
  const aid = await F.automation({ userId: u.id });
  const rid = await F.runRow({ automationId: aid, userId: u.id });
  claude.state.replies.push({ text: "Writing slowly", never: true });
  const going = advance(rid);
  await waitFor(() => claude.state.open === 1);
  await sql("UPDATE automation_runs SET stop_requested = 1 WHERE id = ?", [rid]);
  const asked = Date.now();
  await going;
  assert.ok(Date.now() - asked <= 5_500, `stopped in ${Date.now() - asked} ms`);
  await waitFor(() => claude.state.open === 0);
  const run = await runOf(rid);
  assert.equal(run!.status, "stopped");
  assert.equal(run!.outcome, "stopped_by_user");
  const [charge] = await ledgerOf(rid);
  assert.ok(-Number(charge.amount) >= 1 && Number(charge.settled_at) > 0);
});

test("a call with too little time left for the step hands the run on, keeping its place", async () => {
  const u = await F.account("run8", 100);
  const aid = await F.automation({ userId: u.id });
  const rid = await F.runRow({ automationId: aid, userId: u.id });
  const due = Number((await runOf(rid))!.due_at);
  await advance(rid, Date.now() + 100_000);
  const run = await runOf(rid);
  assert.equal(run!.lease_owner, "");
  assert.equal(Number(run!.due_at), due);
  assert.equal((await stepsOf(rid)).length, 0);
});

test("an edit during a run doesn't change it: the run follows its own version", async () => {
  const u = await F.account("run9", 100);
  const aid = await F.automation({ userId: u.id });
  const rid = await F.runRow({ automationId: aid, userId: u.id });
  const edited: Spec = { ...F.WRITE_SPEC, steps: [{ id: "a1", do: "ai", mode: "write", level: "sonic", prompt: "Write about tea instead." }, { id: "n1", do: "notify" }] };
  await sql("INSERT INTO automation_versions (automation_id, version, user_id, spec, runner, created_at) VALUES (?, 2, ?, ?, 1, 0)", [aid, u.id, JSON.stringify(edited)]);
  await sql("UPDATE automations SET version = 2 WHERE id = ?", [aid]);
  await advance(rid);
  const sent = JSON.stringify(claude.streamed().at(-1)!.body.messages);
  assert.match(sent, /weather/);
  assert.doesNotMatch(sent, /tea/);
});

test("pausing mid-run lets the step finish, then parks the run", async () => {
  const u = await F.account("run10", 100);
  const aid = await F.automation({ userId: u.id });
  const rid = await F.runRow({ automationId: aid, userId: u.id });
  let release: () => void = () => {};
  claude.state.replies.push({ text: "Done after the pause.", hold: new Promise<void>((r) => (release = r)) });
  const going = advance(rid);
  await waitFor(() => claude.state.open === 1);
  await sql("UPDATE automations SET status = 'paused', paused_reason = 'user' WHERE id = ?", [aid]);
  release();
  await going;
  await waitFor(() => claude.state.open === 0);
  const run = await runOf(rid);
  assert.equal(Number(run!.parked), 1);
  assert.equal(run!.lease_owner, "");
  assert.equal(run!.step, "n1");
  assert.deepEqual((await stepsOf(rid)).map((s) => [s.step_id, s.status]), [["a1", "done"]]);
  assert.equal(await one("SELECT 1 FROM automation_runs WHERE id = ? AND parked = 0", [rid]), null);
});

test("deleting an automation stops its run: a step in flight settles first, and a run not started costs nothing", async () => {
  const u = await F.account("run11", 100);
  const aid = await F.automation({ userId: u.id });
  const rid = await F.runRow({ automationId: aid, userId: u.id });
  claude.state.replies.push({ text: "Going", never: true });
  const going = advance(rid);
  await waitFor(() => claude.state.open === 1);
  // What Delete does: the automation is being deleted, and its live runs are asked to stop.
  await sql("UPDATE automations SET status = 'deleting', next_at = 0 WHERE id = ?", [aid]);
  await sql("UPDATE automation_runs SET stop_requested = 1 WHERE automation_id = ? AND finished_at = 0", [aid]);
  await going;
  await waitFor(() => claude.state.open === 0);
  const run = await runOf(rid);
  assert.equal(run!.status, "stopped");
  assert.equal(run!.outcome, "deleted");
  assert.ok((await holdsOf(rid)).every((h) => Number(h.settled_at) > 0));
  const rid3 = await F.runRow({ automationId: aid, userId: u.id });
  await advance(rid3);
  assert.equal((await runOf(rid3))!.outcome, "deleted");
  assert.deepEqual(await ledgerOf(rid3), []);
});

test("an earlier attempt that had called Claude ends the run interrupted, settled by the reaper's rule, never re-run", async () => {
  const u = await F.account("run12", 100);
  const aid = await F.automation({ userId: u.id });
  const rid = await F.runRow({ automationId: aid, userId: u.id, attempts: 1 });
  const ref = `auto:${rid}:a1:1`;
  // A server stopped mid-step: its step row still running, its hold charged, started and open.
  await sql("INSERT INTO automation_run_steps (run_id, step_id, attempt, user_id, kind, status, hold_ref, started_at) VALUES (?, 'a1', 1, ?, 'ai', 'running', ?, 0)", [rid, u.id, ref]);
  await H.recordHold({ ref, userId: u.id, runId: rid, held: 20, model: LEVEL_MODELS.sonic, inputCents: 0.1, leftCents: 0 });
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, ref, automation_id, created_at) VALUES (?, -20, 'automation', ?, ?, ?)", [u.id, ref, aid, Date.now()]);
  await H.markStarted(ref);
  const streams = claude.streamed().length;
  await advance(rid);
  const run = await runOf(rid);
  assert.equal(run!.status, "interrupted");
  assert.equal(claude.streamed().length, streams, "Claude wasn't called again");
  const [hold] = await holdsOf(rid);
  assert.ok(Number(hold.settled_at) > 0 && Number(hold.credits) <= 20);
  assert.equal((await stepsOf(rid))[0].status, "interrupted");
  const notice = (await noticesOf(u.id)).find((n) => n.kind === "interrupted");
  assert.equal(notice?.phrase, A.NOTICES.interrupted);
});

test("a price rise over the run limit pauses a scheduled automation with price_up, charging nothing", async () => {
  const u = await F.account("run13", 100);
  const spec: Spec = { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "daily", at: "08:00" } } };
  const aid = await F.automation({ userId: u.id, spec, capRun: 1, nextAt: Date.now() + 3_600_000 });
  const rid = await F.runRow({ automationId: aid, userId: u.id, origin: "schedule" });
  const streams = claude.streamed().length;
  await advance(rid);
  const run = await runOf(rid);
  assert.deepEqual([run!.status, run!.outcome], ["skipped", "price_up"]);
  const a = await one<{ status: string; paused_reason: string; resume_at: number; need_credits: number }>("SELECT status, paused_reason, resume_at, need_credits FROM automations WHERE id = ?", [aid]);
  assert.deepEqual([a!.status, a!.paused_reason, Number(a!.resume_at)], ["paused", "price_up", 0]);
  assert.ok(Number(a!.need_credits) > 1);
  assert.deepEqual(await ledgerOf(rid), []);
  assert.equal(claude.streamed().length, streams);
  const notice = (await noticesOf(u.id)).find((n) => n.phrase === A.NOTICES.priceUp);
  assert.equal(JSON.parse(notice!.blanks).cap, 1);
});

test("the run limit is never passed: each step's hold shrinks to what the limit leaves, and a step that can't fit stops the run", async () => {
  const u = await F.account("run13b", 500);
  // What one Sonic Write step needs at least, as a price_up pause records it.
  const probe: Spec = { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "daily", at: "08:00" } } };
  const pid = await F.automation({ userId: u.id, spec: probe, capRun: 1, nextAt: Date.now() + 3_600_000 });
  await advance(await F.runRow({ automationId: pid, userId: u.id, origin: "schedule" }));
  const need = Number((await one<{ need_credits: number }>("SELECT need_credits FROM automations WHERE id = ?", [pid]))!.need_credits);
  assert.ok(need > 1);
  // Two Write steps under a limit of 1 more than the least one needs: the first is held at the limit
  // (less than it would hold), and after a long answer is charged the second no longer fits.
  const spec: Spec = {
    v: 1,
    trigger: { type: "manual" },
    steps: [
      { id: "a1", do: "ai", mode: "write", level: "sonic", prompt: "Write one line about the weather." },
      { id: "a2", do: "ai", mode: "write", level: "sonic", prompt: "And one about the sea." },
      { id: "n1", do: "notify" },
    ],
  };
  const cap = need + 1;
  const aid = await F.automation({ userId: u.id, spec, capRun: cap });
  const rid = await F.runRow({ automationId: aid, userId: u.id });
  claude.state.replies.push({ text: "Sunny.", usage: { input_tokens: 1200, output_tokens: 8000 } });
  const streams = claude.streamed().length;
  await advance(rid);
  const holds = await holdsOf(rid);
  assert.equal(holds.length, 1, "the second step never held anything");
  assert.equal(Number(holds[0].held), cap, "held what the limit leaves, not its usual amount");
  const run = await runOf(rid);
  assert.deepEqual([run!.status, run!.outcome], ["stopped", "run_cap"]);
  assert.ok(Number(run!.credits) > cap - need && Number(run!.credits) <= cap, "charged, within the limit");
  assert.equal(claude.streamed().length, streams + 1);
  const steps = await stepsOf(rid);
  assert.deepEqual(steps.map((s) => [s.step_id, s.status, s.note]), [["a1", "done", ""], ["a2", "skipped", "run_cap"]]);
  // The same step alone, with room, holds more than the limit allowed.
  const free = await F.automation({ userId: u.id });
  const fid = await F.runRow({ automationId: free, userId: u.id });
  await advance(fid);
  assert.ok(Number((await holdsOf(fid))[0].held) > cap);
});

test("out of credits: nothing is charged, it waits for credits with one notice a month, offering Quick research, and comes back on by itself", async () => {
  const u = await F.account("run14", 0);
  const spec: Spec = { ...RESEARCH_SPEC, trigger: { type: "schedule", when: { kind: "daily", at: "08:00" } } };
  const next = Date.now() + 3_600_000;
  const aid = await F.automation({ userId: u.id, spec, nextAt: next });
  const rid = await F.runRow({ automationId: aid, userId: u.id, origin: "schedule" });
  await advance(rid);
  assert.deepEqual([(await runOf(rid))!.status, (await runOf(rid))!.outcome], ["skipped", "no_credits"]);
  const a = await one<{ status: string; paused_reason: string; resume_at: number; need_credits: number }>("SELECT status, paused_reason, resume_at, need_credits FROM automations WHERE id = ?", [aid]);
  assert.deepEqual([a!.status, a!.paused_reason, Number(a!.resume_at)], ["paused", "credits", next], "looked at again at the next slot");
  const notices = (await noticesOf(u.id)).filter((n) => n.kind === "credits");
  assert.equal(notices.length, 1);
  const blanks = JSON.parse(notices[0].blanks);
  assert.equal(blanks.credits, Number(a!.need_credits));
  assert.equal(blanks.offer, "quick");
  assert.ok(blanks.offerCredits > 0 && blanks.offerCredits < Number(a!.need_credits) * 10);
  assert.deepEqual(await ledgerOf(rid), []);
  // A second refusal this month adds no second notice.
  await sql("UPDATE automations SET status = 'on' WHERE id = ?", [aid]);
  const rid2 = await F.runRow({ automationId: aid, userId: u.id, origin: "schedule" });
  await advance(rid2);
  assert.equal((await noticesOf(u.id)).filter((n) => n.kind === "credits").length, 1);
  // Credits arrive; at its next look the tick turns it back on.
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, 500, 'purchase', 0)", [u.id]);
  await sql("UPDATE automations SET resume_at = 1 WHERE id = ?", [aid]);
  await T.runTick("test", { dispatch: async () => {} });
  const back = await one<{ status: string; paused_reason: string }>("SELECT status, paused_reason FROM automations WHERE id = ?", [aid]);
  assert.deepEqual({ ...back }, { status: "on", paused_reason: "" });
});

test("a free user's credits for this month are given before their run is priced", async () => {
  const u = await F.account("run15", 0);
  // Last month's free credits only (3 left), as on 31 October before a 3 November run.
  await sql("UPDATE credit_ledger SET ref = 'free:run15:2000-01', amount = 3 WHERE user_id = ?", [u.id]);
  const aid = await F.automation({ userId: u.id });
  const rid = await F.runRow({ automationId: aid, userId: u.id });
  await advance(rid);
  assert.equal((await runOf(rid))!.status, "done");
  const rows = await all<{ ref: string | null; amount: number }>("SELECT ref, amount FROM credit_ledger WHERE user_id = ? ORDER BY id", [u.id]);
  const grant = rows.findIndex((r) => String(r.ref).startsWith("free:run15:") && r.ref !== "free:run15:2000-01");
  const charge = rows.findIndex((r) => String(r.ref).startsWith(`auto:${rid}:`));
  assert.ok(grant >= 0 && grant < charge, "the month's credits came first");
});

test("only if changed: NO_CHANGE ends the run with nothing new and no notice; any other answer is delivered", async () => {
  const u = await F.account("run16", 200);
  const spec: Spec = {
    v: 1,
    trigger: { type: "manual" },
    steps: [
      { id: "a1", do: "ai", mode: "write", level: "sonic", prompt: "Check the price of tea.", onlyIfChanged: true },
      { id: "n1", do: "notify" },
    ],
  };
  const aid = await F.automation({ userId: u.id, spec });
  const first = await F.runRow({ automationId: aid, userId: u.id });
  claude.state.replies.push({ text: "Tea costs 10." });
  await advance(first);
  assert.match(JSON.stringify(claude.streamed().at(-1)!.body.messages), /no previous result yet/);
  assert.equal((await noticesOf(u.id)).length, 1);
  const second = await F.runRow({ automationId: aid, userId: u.id });
  claude.state.replies.push({ text: "NO_CHANGE\nThe price is still 10." });
  await advance(second);
  // The previous result went as data.
  const sent = JSON.stringify(claude.streamed().at(-1)!.body.messages);
  assert.match(sent, /<previous_result>\\nTea costs 10.\\n<\/previous_result>/);
  const run = await runOf(second);
  assert.deepEqual([run!.status, run!.outcome, run!.summary], ["done", "nothing_new", "The price is still 10."]);
  assert.equal((await noticesOf(u.id)).length, 1, "no notice for nothing new");
  assert.equal((await stepsOf(second)).find((s) => s.step_id === "n1"), undefined, "the notice step was skipped");
  // A missing marker means "tell the user".
  const third = await F.runRow({ automationId: aid, userId: u.id });
  claude.state.replies.push({ text: "Tea now costs 12." });
  await advance(third);
  assert.match(JSON.stringify(claude.streamed().at(-1)!.body.messages), /Tea costs 10/, "compared with the last answer delivered");
  assert.equal((await noticesOf(u.id)).length, 2);
});

test("the receipt chain: each run's fingerprint follows the one before, a saved receipt checks, and still does after compaction", async () => {
  const u = await F.account("run17", 200);
  const aid = await F.automation({ userId: u.id });
  const runs = [await F.runRow({ automationId: aid, userId: u.id }), await F.runRow({ automationId: aid, userId: u.id })];
  for (const rid of runs) await advance(rid);
  const [one1, two] = await Promise.all(runs.map((rid) => runOf(rid)));
  const saved1 = R.savedReceipt(one1 as { receipt: string; receipt_hash: string })!;
  const saved2 = R.savedReceipt(two as { receipt: string; receipt_hash: string })!;
  assert.equal(saved1.prev, "");
  assert.equal(saved2.prev, saved1.hash, "chained");
  // The fingerprint is sha256 of the one before and this run's compact receipt, worked out here by hand.
  const { createHash } = await import("node:crypto");
  const { canonicalJson } = await import("../src/lib/server/mcp-client.ts");
  assert.equal(createHash("sha256").update(saved2.prev + canonicalJson(saved2.receipt)).digest("hex"), saved2.hash);
  assert.equal(createHash("sha256").update(canonicalJson(saved1.receipt)).digest("hex"), saved1.hash);
  assert.equal((await one<{ receipt_hash: string }>("SELECT receipt_hash FROM automations WHERE id = ?", [aid]))!.receipt_hash, saved2.hash);
  // The downloaded receipt, as its owner saved it (JSON), checks against the chain.
  const downloaded = JSON.parse(JSON.stringify(saved1));
  assert.equal(await R.verifyReceipt(aid, downloaded), true);
  // A changed receipt doesn't.
  assert.equal(await R.verifyReceipt(aid, { ...downloaded, receipt: { ...downloaded.receipt, credits: downloaded.receipt.credits + 1 } }), false);
  // Compacted (old detail cleared): the saved receipt still checks.
  await sql("UPDATE automation_runs SET finished_at = ? WHERE automation_id = ?", [Date.now() - 40 * 86_400_000, aid]);
  await sql("DELETE FROM settings WHERE key = 'auto:daily'");
  assert.equal(await T.dailyJob(), true);
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) AS n FROM automation_run_steps WHERE run_id IN (?, ?) AND output IS NOT NULL", runs))!.n, 0);
  assert.equal(await R.verifyReceipt(aid, downloaded), true);
});

test("a replay of a ref whose hold had started never calls Claude", async () => {
  const u = await F.account("run18", 100);
  const aid = await F.automation({ userId: u.id });
  const rid = await F.runRow({ automationId: aid, userId: u.id });
  const ref = `auto:${rid}:a1:1`;
  // This attempt's ref is in the ledger already, with its hold started (its step row lost).
  await H.recordHold({ ref, userId: u.id, runId: rid, held: 20, model: LEVEL_MODELS.sonic, inputCents: 0.1, leftCents: 0 });
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, ref, automation_id, created_at) VALUES (?, -20, 'automation', ?, ?, ?)", [u.id, ref, aid, Date.now()]);
  await H.markStarted(ref);
  const streams = claude.streamed().length;
  await advance(rid);
  assert.equal(claude.streamed().length, streams);
  assert.equal((await ledgerOf(rid)).length, 1, "charged once");
});

test("a personal spec with no AI step is refused", () => {
  assert.deepEqual(A.parseSpec({ v: 1, trigger: { type: "manual" }, steps: [{ id: "n1", do: "notify", text: "Drink water" }] }), { error: A.SPEC_NEEDS_AI });
});

test("the runner never buys credits: no automation file calls auto top-up", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL("../src/lib/server/", import.meta.url);
  const files = readdirSync(dir).filter((f) => /^automation/.test(f) || f === "credit-holds.ts" || f === "leases.ts" || f === "notifications.ts");
  assert.ok(files.length >= 7);
  for (const f of files) assert.doesNotMatch(readFileSync(new URL(f, dir), "utf8"), /maybeAutoTopUp|auto-topup/, f);
});
