import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
process.env.FLASH_DEMO_EMAILS = "true";
delete process.env.RESEND_API_KEY;
const { inviteMember, acceptInvite, removeFromTeam, teamPool, teamSummary, TeamError } = await import(
  "../src/lib/server/teams.ts"
);
const { balance, charge, settle, spendable, ensureMonthlyCredits, recentActivity } = await import(
  "../src/lib/server/credits.ts"
);
const { addMonths, recordPayment, endSubscription } = await import("../src/lib/server/subscriptions.ts");
const { emailKey } = await import("../src/lib/server/account.ts");
const { run } = await import("../src/lib/server/db.ts");
const { PLANS } = await import("../src/lib/credits.ts");

const business = PLANS.find((p) => p.id === "business")!;
const DAY = 86400000;
const users: Record<string, { id: string; email: string; name: string; verified_at: number }> = {};

async function user(id: string, verified = true) {
  const u = { id, email: `${id}@t.io`, name: id, verified_at: verified ? 1 : 0 };
  await run("INSERT INTO users (id, email, email_key, name, password_hash, created_at, verified_at) VALUES (?, ?, ?, ?, 'x', 0, ?)", [
    id, u.email, emailKey(u.email), id, u.verified_at,
  ]);
  users[id] = u;
  return u;
}

async function subscribe(userId: string, planId: string, id: string) {
  const start = Date.now() - DAY;
  const plan = PLANS.find((p) => p.id === planId)!;
  await recordPayment({
    subscriptionId: id, userId, planId, interval: "month", customer: `cus_${id}`, amountCents: plan.priceCents,
    periodStart: start, periodEnd: addMonths(start, 1), ref: `stripe-invoice:in_${id}`, test: false,
  });
}

const tokenOf = (link: string | undefined) => new URL(link!).searchParams.get("invite")!;

async function join(ownerId: string, memberId: string) {
  await acceptInvite(users[memberId], tokenOf(await inviteMember(users[ownerId], users[memberId].email, "http://x")));
}

test("only an active Business plan can invite, and only the invited, confirmed address can join", async () => {
  await user("pro");
  await subscribe("pro", "pro", "sub_pro");
  await assert.rejects(inviteMember(users.pro, "a@t.io", "http://x"), TeamError);

  await user("owner");
  await subscribe("owner", "business", "sub_biz");
  assert.equal(await balance("owner"), business.credits);
  await user("m1");
  await user("stranger");
  await user("unverified", false);
  const link = await inviteMember(users.owner, "M1@t.io", "http://x");
  assert.ok(link?.startsWith("http://x/?invite="));
  await assert.rejects(acceptInvite(users.stranger, tokenOf(link)), /different email/);
  await assert.rejects(acceptInvite(users.m1, "made-up"), /expired/);
  await acceptInvite(users.m1, tokenOf(link));
  await assert.rejects(acceptInvite(users.m1, tokenOf(link)), /expired/, "links work once");

  const unverifiedLink = await inviteMember(users.owner, users.unverified.email, "http://x");
  await assert.rejects(acceptInvite(users.unverified, tokenOf(unverifiedLink)), /Confirm your email/);
  await assert.rejects(inviteMember(users.owner, "owner@t.io", "http://x"), /already on your team/);
});

test("members spend the owner's shared pool first, then their own credits", async () => {
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES ('m1', 50, 'own', 0)");
  assert.equal((await teamPool("m1"))?.user_id, "owner");
  assert.equal(await teamPool("owner"), null, "the owner's own balance is the pool");
  assert.deepEqual(await spendable("m1"), { largest: business.credits, total: business.credits + 50, pool: business.credits });

  const id = (await charge("m1", 400, "app request"))!;
  assert.ok(id);
  assert.equal(await balance("owner"), business.credits - 400);
  assert.equal(await balance("m1"), 50);
  await settle(id, 150);
  assert.equal(await balance("owner"), business.credits - 150);

  // The owner sees who spent it; the member sees it as team credits.
  assert.match((await recentActivity("owner"))[0].reason, /app request by m1/);
  assert.match((await recentActivity("m1"))[0].reason, /team credits/);
  const summary = await teamSummary("owner");
  assert.equal(summary?.role, "owner");
  assert.equal(summary?.role === "owner" && summary.members[0].used, 150);
  const member = await teamSummary("m1");
  assert.deepEqual(member, { role: "member", active: true, owner: "owner" });
});

test("parallel charges never take the pool below zero", async () => {
  const pool = await balance("owner");
  const each = 1000;
  const results = await Promise.all(Array.from({ length: 20 }, () => charge("m1", each, "parallel")));
  const taken = results.filter((r) => r !== null).length;
  assert.equal(taken, Math.floor(pool / each), "only what the pool covers (the member's 50 can't pay 1,000)");
  assert.ok((await balance("owner")) >= 0);
  assert.equal(await balance("m1"), 50);
  assert.equal(await balance("owner"), pool - taken * each);
  // Once the pool can't cover a request, it falls back to the member's own credits.
  assert.ok(await charge("m1", (await balance("owner")) - 10, "drain"));
  assert.ok(await charge("m1", 40, "text request"));
  assert.equal(await balance("owner"), 10);
  assert.equal(await balance("m1"), 10);
  assert.equal(await charge("m1", (await balance("owner")) + 1000, "too big"), null);
});

test("seats are capped, the owner included", async () => {
  // Owner, m1, m2, m3 and the unverified invite fill the 5 seats.
  await user("m2");
  await user("m3");
  await user("m4");
  await join("owner", "m2");
  await join("owner", "m3");
  await assert.rejects(inviteMember(users.owner, users.m4.email, "http://x"), /seats/);
  // Cancelling the pending invite frees its seat.
  const summary = await teamSummary("owner");
  const invite = summary?.role === "owner" ? summary.invites[0] : undefined;
  assert.equal(invite?.email, users.unverified.email);
  await removeFromTeam("owner", { inviteId: invite!.id });
  await join("owner", "m4");
});

test("only the owner removes members; removed members and ended plans stop sharing", async () => {
  await assert.rejects(removeFromTeam("m1", { userId: "m2" }), TeamError);
  assert.ok(await teamPool("m2"));
  await removeFromTeam("owner", { userId: "m2" });
  assert.equal(await teamPool("m2"), null);
  // A member can leave.
  await removeFromTeam("m3", { userId: "m3" });
  assert.equal(await teamPool("m3"), null);

  // A cancelled or refunded Business plan ends the shared pool.
  await endSubscription("sub_biz");
  assert.equal(await teamPool("m1"), null);
  const before = await balance("owner");
  assert.ok(await charge("m1", 5, "text request"));
  assert.equal(await balance("m1"), 5);
  assert.equal(await balance("owner"), before, "the owner's leftover credits stay the owner's");
  assert.deepEqual(await teamSummary("m1"), { role: "member", active: false, owner: "owner" });
});

test("a member's visit gives the team pool this month's paid-for credits", async () => {
  await user("owner2");
  await user("mm");
  await subscribe("owner2", "business", "sub_biz2");
  await join("owner2", "mm");
  // A renewal recorded without its grant (as if the owner hadn't visited since): the member's visit grants it, once.
  await run("DELETE FROM credit_ledger WHERE ref = 'plan:sub_biz2:0'");
  assert.equal(await balance("owner2"), 0);
  await ensureMonthlyCredits("mm");
  await ensureMonthlyCredits("mm");
  assert.equal(await balance("owner2"), business.credits);
});
