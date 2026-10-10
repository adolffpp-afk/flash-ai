import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
process.env.RESEND_API_KEY = "test-key";
delete process.env.FLASH_DEMO_EMAILS;
const { EMAIL_BUDGET, EMAILS, sendEmail } = await import("../src/lib/server/email.ts");
const { receiveMessage, readMessages } = await import("../src/lib/server/inbox.ts");
const { inviteMember, TeamError } = await import("../src/lib/server/teams.ts");
const { addMonths, recordPayment } = await import("../src/lib/server/subscriptions.ts");
const { run, one } = await import("../src/lib/server/db.ts");
const { PLANS } = await import("../src/lib/credits.ts");

// Midday, so the day doesn't change halfway through.
const NOON = Date.UTC(2026, 9, 9, 12);
const DAY = 86_400_000;
let clock = NOON;
Date.now = () => clock;

// What Resend was asked to send: "to subject".
const sent: string[] = [];
globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string };
  sent.push(`${body.to[0]} ${body.subject}`);
  return Response.json({ id: "email" });
}) as typeof fetch;
const warnings: unknown[] = [];
console.warn = (...args: unknown[]) => warnings.push(args);

const forOthers = EMAIL_BUDGET.perDay - EMAIL_BUDGET.keptForAccounts;
const appEmail = (n: number) => EMAILS.siteMessage(`Site ${n}`, "name: Ana", "https://www.flash-app.dev/?apps=1");

test("the numbers fit Resend's free plan and keep most of it for sign-in emails", () => {
  assert.ok(EMAIL_BUDGET.perDay <= 100);
  assert.ok(EMAIL_BUDGET.keptForAccounts >= EMAIL_BUDGET.perDay / 2);
  assert.ok(EMAIL_BUDGET.perOwner > 0 && EMAIL_BUDGET.perOwner < forOthers, "one owner's forms can't take every app email");
});

test("one person's apps email them at most perOwner times a day, across all their apps", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('busy', 'busy@x.co', 'h', 0), ('calm', 'calm@x.co', 'h', 0)");
  for (const slug of ["busy-1", "busy-2", "busy-3"]) {
    await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES (?, 'busy', ?, '<p>', 0, 0)", [slug, slug]);
  }
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('calm-1', 'calm', 'Calm', '<p>', 0, 0)");

  // 8 forms on each of 3 apps: under each app's own cap, over the owner's.
  for (let i = 0; i < 8; i++) {
    for (const n of [1, 2, 3]) {
      assert.deepEqual(await receiveMessage(`busy-${n}`, { form: "contact", data: { i } }, `10.0.${n}.${i}`, "https://x"), { ok: true });
    }
  }
  assert.equal(sent.filter((s) => s.startsWith("busy@")).length, EMAIL_BUDGET.perOwner);
  for (const n of [1, 2, 3]) assert.equal((await readMessages(`busy-${n}`, false)).length, 8, "every message is still saved");

  // Someone else's app still emails them.
  await receiveMessage("calm-1", { form: "contact", data: { hi: 1 } }, "10.1.0.1", "https://x");
  assert.equal(sent.filter((s) => s.startsWith("calm@")).length, 1);
});

test("app emails and invites stop while there's still room for sign-in emails, which always go out", async () => {
  // Many different owners, so only the day's budget stops them.
  let n = 0;
  while (await sendEmail(`owner${n}@x.co`, appEmail(n), { owner: `owner${n}` })) n++;
  assert.equal(sent.length, forOthers, "everything sent so far today counts");
  assert.ok(warnings.length > 0, "the server log says the budget ran out");

  // A team invitation can't go out either, and doesn't hold a seat.
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('boss', 'boss@x.co', 'h', 0, 1)");
  const plan = PLANS.find((p) => p.id === "business")!;
  await recordPayment({
    subscriptionId: "sub_boss", userId: "boss", planId: "business", interval: "month", customer: "cus_boss",
    amountCents: plan.priceCents, periodStart: NOON - DAY, periodEnd: addMonths(NOON - DAY, 1), ref: "stripe-invoice:in_boss", test: false,
  });
  await assert.rejects(
    inviteMember({ id: "boss", email: "boss@x.co", name: "Boss" }, "new@x.co", "https://x"),
    (err: unknown) => err instanceof TeamError && err.status === 429 && /tomorrow/.test(err.message),
  );
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) AS n FROM team_invites"))?.n, 0);

  // Sign-in links, confirmations and resets still go out, even past the whole day's count.
  for (let i = 0; i < EMAIL_BUDGET.perDay; i++) {
    assert.equal(await sendEmail(`person${i}@x.co`, EMAILS.signin("https://x/signin?token=t"), "account"), true);
  }
  assert.equal(await sendEmail("late@x.co", EMAILS.verify("https://x/v"), "account"), true);
  assert.equal(await sendEmail("late@x.co", EMAILS.reset("https://x/r"), "account"), true);
  assert.equal(sent.length, forOthers + EMAIL_BUDGET.perDay + 2);
  assert.equal(await sendEmail("one-more@x.co", appEmail(0), { owner: "fresh-owner" }), false);

  // The next day starts again.
  clock = NOON + DAY;
  assert.equal(await sendEmail("next-day@x.co", appEmail(0), { owner: "fresh-owner" }), true);
});

test("sign-in emails count toward the day, so app emails leave them room", async () => {
  clock = NOON + 2 * DAY;
  const before = sent.length;
  for (let i = 0; i < EMAIL_BUDGET.perDay - 5; i++) await sendEmail(`p${i}@x.co`, EMAILS.signin("https://x/s"), "account");
  // Only 5 of the day's emails are left, fewer than kept for sign-in emails, so apps wait.
  assert.equal(await sendEmail("owner@x.co", appEmail(1), { owner: "someone" }), false);
  assert.equal(sent.length - before, EMAIL_BUDGET.perDay - 5);
});
