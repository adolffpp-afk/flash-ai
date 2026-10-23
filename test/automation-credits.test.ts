import { test } from "node:test";
import assert from "node:assert/strict";

/*
 * Automations and credits: chargeOnce (one account, once per ref, never below zero, never under the
 * auto top-up level, never past a month or day limit), what a hold left behind is settled at, and the
 * free monthly credits counting an automation's open hold as not spent, however old.
 */
process.env.DATABASE_URL = ":memory:";
for (const name of ["VERCEL_ENV", "RESEND_API_KEY", "FLASH_DEMO_EMAILS", "FLASH_APP_URL"]) delete process.env[name];

const { one, run: sql } = await import("../src/lib/server/db.ts");
const C = await import("../src/lib/server/credits.ts");
const H = await import("../src/lib/server/credit-holds.ts");
const F = await import("./support/automation-fixtures.ts");
const { creditsFor, claudePrice, fallbackModel, FREE_MONTHLY_CREDITS, readCostCents } = await import("../src/lib/credits.ts");
const { PEAK_TOKENS_PER_SECOND, HELPER_MODEL, LEVEL_MODELS } = await import("../src/lib/engines/claude.ts");

const once = (account: string, aid: string, ref: string, amount: number, more: Partial<Parameters<typeof C.chargeOnce>[0]> = {}) =>
  C.chargeOnce({ account, actor: account, amount, reason: "Automation step", ref, automationId: aid, monthCap: 10_000, monthStart: 0, keepTopUpLevel: true, ...more });

async function autoTopUpAt(userId: string, below: number) {
  await sql("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES (?, 1, 'starter', ?, 'cus_1', 'pm_1', 0)", [userId, below]);
}

test("the same ref is charged once: a second try finds the first row as a replay", async () => {
  const u = await F.account("c1", 100);
  const aid = await F.automation({ userId: u.id });
  const first = await once(u.id, aid, "auto:r1:a1:1", 30);
  assert.ok("id" in first && !first.replay);
  const again = await once(u.id, aid, "auto:r1:a1:1", 30);
  assert.deepEqual(again, { id: (first as { id: number }).id, replay: true });
  assert.equal(await F.balance(u.id), 70);
  const row = await one<{ automation_id: string; actor: string | null; amount: number }>("SELECT automation_id, actor, amount FROM credit_ledger WHERE ref = 'auto:r1:a1:1'");
  assert.deepEqual({ ...row }, { automation_id: aid, actor: null, amount: -30 }, "the owner's own spending, as chat writes it");
});

test("three runs and a chat request at once never take a balance below zero", async () => {
  const u = await F.account("c2", 50);
  const aid = await F.automation({ userId: u.id });
  const results = await Promise.all([once(u.id, aid, "auto:r2:a1:1", 20), once(u.id, aid, "auto:r3:a1:1", 20), once(u.id, aid, "auto:r4:a1:1", 20), C.charge(u.id, 20, "text request")]);
  const taken = results.filter((r) => (typeof r === "number" ? r > 0 : r && "id" in r)).length;
  assert.equal(taken, 2);
  assert.equal(await F.balance(u.id), 10);
});

test("no fallthrough: an empty paying account is refused even when the team pool has credits", async () => {
  const owner = await F.account("c3owner", 500);
  const member = await F.account("c3member", 0);
  await sql(
    "INSERT INTO subscriptions (id, user_id, plan, interval, status, amount_cents, anchor, paid_until, test, created_at, updated_at) VALUES ('sub_c3', ?, 'business', 'month', 'active', 0, ?, ?, 1, 0, 0)",
    [owner.id, Date.now() - 86_400_000, Date.now() + 20 * 86_400_000],
  );
  await sql("INSERT INTO teams (id, owner_id, created_at) VALUES ('team_c3', ?, 0)", [owner.id]);
  await sql("INSERT INTO team_members (user_id, team_id, joined_at) VALUES (?, 'team_c3', 0)", [member.id]);
  const aid = await F.automation({ userId: member.id });
  assert.deepEqual(await once(member.id, aid, "auto:r5:a1:1", 5), { refused: "credits" });
  assert.equal(await F.balance(owner.id), 500, "the pool wasn't touched");
  // Chat's charge() does fall through to the pool: that is the difference.
  assert.ok(Number(await C.charge(member.id, 5, "text request")) > 0);
  assert.equal(await F.balance(owner.id), 495);
});

test("the auto top-up level is a floor: an automation never takes the balance under it, holds included", async () => {
  const u = await F.account("c4", 120);
  await autoTopUpAt(u.id, 100);
  const aid = await F.automation({ userId: u.id });
  assert.deepEqual(await once(u.id, aid, "auto:r6:a1:1", 30), { refused: "topup_floor" });
  const hold = await once(u.id, aid, "auto:r7:a1:1", 20);
  assert.ok("id" in hold);
  // The open 20-credit hold counts at full size: nothing more fits above the level.
  assert.deepEqual(await once(u.id, aid, "auto:r8:a1:1", 1), { refused: "topup_floor" });
  assert.equal(await F.balance(u.id), 100);
  // Without auto top-up (or without a card) there is no floor.
  await sql("UPDATE auto_topups SET payment_method = NULL WHERE user_id = ?", [u.id]);
  assert.ok("id" in (await once(u.id, aid, "auto:r9:a1:1", 30)));
  assert.equal(await C.topUpFloor(u.id), 0);
});

test("a charge that would cross the month limit, or the day limit, is refused before anything is taken", async () => {
  const u = await F.account("c5", 1000);
  const aid = await F.automation({ userId: u.id, capMonth: 50 });
  const monthStart = Date.now() - 1000;
  assert.ok("id" in (await once(u.id, aid, "auto:r10:a1:1", 40, { monthCap: 50, monthStart })));
  assert.deepEqual(await once(u.id, aid, "auto:r11:a1:1", 11, { monthCap: 50, monthStart }), { refused: "month" });
  assert.ok("id" in (await once(u.id, aid, "auto:r12:a1:1", 10, { monthCap: 50, monthStart })));
  // Charges from before the month started don't count.
  assert.ok("id" in (await once(u.id, aid, "auto:r13:a1:1", 10, { monthCap: 50, monthStart: Date.now() + 1000 })));
  // A settled charge counts at what it was settled to.
  await sql("UPDATE credit_ledger SET amount = -5, settled_at = 1 WHERE ref = 'auto:r10:a1:1'");
  assert.equal(await C.automationSpent(aid, monthStart), 25);
  const day = await F.automation({ userId: u.id });
  assert.ok("id" in (await once(u.id, day, "auto:r14:a1:1", 8, { dayCap: 10, dayStart: monthStart })));
  assert.deepEqual(await once(u.id, day, "auto:r15:a1:1", 3, { dayCap: 10, dayStart: monthStart }), { refused: "day" });
});

test("the free monthly credits count an automation's open hold as not spent, however old; chat's for 15 minutes", async () => {
  // Last month's free credits, then an automation hold left open for two hours (a cron outage).
  const id = "c6";
  await sql("INSERT INTO users (id, email, name, password_hash, preferences, created_at, last_free_grant, verified_at) VALUES (?, 'c6@example.com', '', 'x', '', 0, 0, 1)", [id]);
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, 'Monthly free credits', 'free:c6:2000-01', 0)", [id, FREE_MONTHLY_CREDITS]);
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, ref, automation_id, created_at) VALUES (?, -150, 'Automation step', 'auto:old:a1:1', 'a', ?)", [id, Date.now() - 2 * 3600_000]);
  await C.ensureMonthlyCredits(id);
  // Topped up to the monthly amount as if the hold weren't there: it is all given back when it settles.
  assert.equal(await F.balance(id), FREE_MONTHLY_CREDITS - 150 + 0);
  const grant = await one<{ amount: number }>("SELECT amount FROM credit_ledger WHERE ref LIKE 'free:c6:%' AND ref <> 'free:c6:2000-01'");
  assert.equal(Number(grant!.amount), 0, "nothing to top up: the open hold isn't spending");
  // A chat hold that old counts as spent, as before.
  const id2 = "c7";
  await sql("INSERT INTO users (id, email, name, password_hash, preferences, created_at, last_free_grant, verified_at) VALUES (?, 'c7@example.com', '', 'x', '', 0, 0, 1)", [id2]);
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, 'Monthly free credits', 'free:c7:2000-01', 0)", [id2, FREE_MONTHLY_CREDITS]);
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, -150, 'text request', ?)", [id2, Date.now() - 2 * 3600_000]);
  await C.ensureMonthlyCredits(id2);
  assert.equal(await F.balance(id2), FREE_MONTHLY_CREDITS);
});

const HOLD = {
  held: 40,
  started: 1,
  done: 0,
  spent_cents: 2,
  left_cents: 3,
  input_cents: 0.5,
  checked_at: 1_000_000,
  lease_until: 1_150_000,
  created_at: 990_000,
  model: HELPER_MODEL,
};

test("the reaper: 0 when nothing was charged or the call never started, the final cost when it ended", () => {
  assert.equal(H.reaperCredits(HOLD, false), 0, "no ledger row");
  assert.equal(H.reaperCredits({ ...HOLD, started: 0 }, true), 0, "the provider was never called");
  assert.equal(H.reaperCredits({ ...HOLD, done: 1, spent_cents: 2 }, true), creditsFor(2));
  assert.equal(H.reaperCredits({ ...HOLD, done: 1, spent_cents: 0 }, true), 0);
});

test("the reaper never settles above the hold, and part way it adds the most the model could still have written and read", () => {
  const gap = (150 * PEAK_TOKENS_PER_SECOND * claudePrice(HELPER_MODEL).output) / 1e6;
  assert.equal(H.reaperCredits(HOLD, true), Math.min(40, creditsFor(2 + gap + 3)));
  assert.equal(H.reaperCredits({ ...HOLD, held: 3 }, true), 3, "never above the hold");
  // Before message_start the meter says 0, but reading the input may already be billed.
  assert.ok(H.reaperCredits({ ...HOLD, spent_cents: 0, left_cents: 0, lease_until: HOLD.checked_at }, true) >= creditsFor(0.5));
  // A model with a refusal fallback: the fallback could have written too.
  const backed = Object.values(LEVEL_MODELS).find((m) => fallbackModel(m))!;
  const seconds = (HOLD.lease_until - HOLD.checked_at) / 1000;
  const writes = (m: string) => (seconds * PEAK_TOKENS_PER_SECOND * claudePrice(m).output) / 1e6;
  const both = H.reaperCredits({ ...HOLD, model: backed, held: 10_000 }, true);
  assert.equal(both, creditsFor(2 + writes(backed) + writes(fallbackModel(backed)!) + 3));
  assert.equal(H.reaperCredits({ ...HOLD, model: backed, held: 10_000, fallback: 1 }, true), both, "a hold that paid for its fallback");
  // A hold that paid for no fallback (an automation step's): none was asked for, so its model alone.
  assert.equal(H.reaperCredits({ ...HOLD, model: backed, held: 10_000, fallback: 0 }, true), creditsFor(2 + writes(backed) + 3));
});

test("the reaper never settles above what its plan let the call cost (cap_cents), when it has one: else the hold bounds it", () => {
  // A died call priced at 150 s of writing is far more than a step whose max_tokens let it cost 5¢.
  const open = H.reaperCredits({ ...HOLD, held: 10_000 }, true);
  assert.ok(open > creditsFor(5));
  assert.equal(H.reaperCredits({ ...HOLD, held: 10_000, cap_cents: 5 }, true), creditsFor(5));
  assert.equal(H.reaperCredits({ ...HOLD, held: 10, cap_cents: 5 }, true), 10, "never above the hold either");
  assert.equal(H.reaperCredits({ ...HOLD, held: 10_000, cap_cents: 0 }, true), open, "0: no bound but the hold");
  // What the call is known to have cost is under its cap: the cap changes nothing.
  assert.equal(H.reaperCredits({ ...HOLD, held: 10_000, cap_cents: 1_000 }, true), open);
});

test("what a paid step's plan still allows: a full re-read for each result to come and 1¢ per search left", () => {
  const model = LEVEL_MODELS.ascend;
  const read = readCostCents(model, 40_000);
  assert.equal(H.leftCents({ model, largestInput: 40_000, resultsLeft: 3, searchesLeft: 2, fallback: false }), 3 * read + 2);
  assert.equal(H.leftCents({ model, largestInput: 40_000, resultsLeft: 0, searchesLeft: 0, fallback: false }), 0);
  assert.ok(H.leftCents({ model, largestInput: 40_000, resultsLeft: 1, searchesLeft: 0, fallback: true }) > read);
});

test("a hold is settled once: the second settle (a reaper after a finisher) changes nothing", async () => {
  const u = await F.account("c8", 100);
  const aid = await F.automation({ userId: u.id });
  await H.recordHold({ ref: "auto:r20:a1:1", userId: u.id, runId: "r20", held: 30, model: "m", inputCents: 0, leftCents: 1 });
  const charged = await once(u.id, aid, "auto:r20:a1:1", 30);
  await H.markCharged("auto:r20:a1:1", (charged as { id: number }).id);
  assert.equal(await H.settleHold("auto:r20:a1:1", 12), true);
  assert.equal(await H.settleHold("auto:r20:a1:1", 30), false, "the loser lowers nothing");
  assert.equal(await H.settleHold("auto:r20:a1:1", 0), false);
  assert.equal(await F.balance(u.id), 88);
  const h = await one<{ credits: number; settled_at: number }>("SELECT credits, settled_at FROM credit_holds WHERE ref = 'auto:r20:a1:1'");
  assert.equal(Number(h!.credits), 12);
  assert.equal(await H.heartbeat("auto:r20:a1:1", 1, 1), 0, "a heartbeat after the settle changes nothing: the step stops");
});

test("a step's charge needs its hold open: none when the reaper settled the hold first, and a hold is recorded once", async () => {
  const u = await F.account("c9", 100);
  const aid = await F.automation({ userId: u.id });
  const hold = { userId: u.id, runId: "r21", held: 30, model: "m", inputCents: 0, leftCents: 1 };
  assert.deepEqual(await once(u.id, aid, "auto:r21:a1:1", 30, { hold: true }), { refused: "hold" }, "no hold recorded: nothing taken");
  assert.equal(await H.recordHold({ ...hold, ref: "auto:r21:a1:1" }), true);
  assert.equal(await H.recordHold({ ...hold, ref: "auto:r21:a1:1", held: 99 }), false, "a second record keeps the first");
  // The reaper settles the hold (a server that stopped before charging) before the charge lands.
  assert.equal(await H.settleHold("auto:r21:a1:1", 0), true);
  assert.deepEqual(await once(u.id, aid, "auto:r21:a1:1", 30, { hold: true }), { refused: "hold" });
  assert.equal(await F.balance(u.id), 100, "nothing taken after the hold was settled");
  await H.recordHold({ ...hold, ref: "auto:r21:a1:2" });
  const charged = await once(u.id, aid, "auto:r21:a1:2", 30, { hold: true });
  assert.ok("id" in charged && !charged.replay);
  assert.equal(Number((await one<{ held: number }>("SELECT held FROM credit_holds WHERE ref = 'auto:r21:a1:2'"))!.held), 30);
  assert.equal(await F.balance(u.id), 70);
});

test("a charge refused while another request settles in between is tried again; with no day limit it is never refused as one", async () => {
  const u = await F.account("c30", 20);
  const aid = await F.automation({ userId: u.id });
  // A chat reply holds 15 of the 20; the step asks for 10 (refused at the insert), and the reply settles at 1 right after.
  const other = (await C.charge(u.id, 15, "chat"))!;
  const asked = once(u.id, aid, "auto:c30:a1:1", 10, { dayCap: 0, dayStart: 0 });
  const settled = C.settle(other, 1);
  const r = await asked;
  await settled;
  assert.ok("id" in r && !r.replay, JSON.stringify(r));
  assert.equal(await C.balance(u.id), 9);
  // Really out of credits, it says so; and a day limit refuses only when there is one.
  assert.deepEqual(await once(u.id, aid, "auto:c30:a1:2", 50, { dayCap: 0 }), { refused: "credits" });
});

test("a hold is sized again only before anything is taken under its ref: once charged, resizeHold changes nothing", async () => {
  const u = await F.account("c31", 100);
  const aid = await F.automation({ userId: u.id });
  const ref = "auto:c31:a1:1";
  assert.equal(await H.recordHold({ ref, userId: u.id, runId: "c31", held: 40, model: LEVEL_MODELS.sonic, inputCents: 0.1, leftCents: 5 }), true);
  assert.equal(await H.resizeHold(ref, 30, 4), true, "refused at a limit, nothing taken: planned again");
  assert.ok("id" in (await once(u.id, aid, ref, 30, { hold: true })));
  assert.equal(await H.resizeHold(ref, 10, 1), false, "charged: its size stays what was charged");
  const h = (await one<{ held: number; left_cents: number }>("SELECT held, left_cents FROM credit_holds WHERE ref = ?", [ref]))!;
  assert.deepEqual([Number(h.held), Number(h.left_cents)], [30, 4]);
});
