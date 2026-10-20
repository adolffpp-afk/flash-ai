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

test("sign-in emails don't use up app emails' share, but a full day stops apps", async () => {
  clock = NOON + 2 * DAY;
  const before = sent.length;
  // As many sign-in emails as are kept for them: app emails still go out.
  for (let i = 0; i < EMAIL_BUDGET.keptForAccounts; i++) await sendEmail(`p${i}@x.co`, EMAILS.signin("https://x/s"), "account");
  assert.equal(await sendEmail("owner@x.co", appEmail(1), { owner: "someone" }), true);
  // The provider's whole day used: apps wait.
  for (let i = 0; i < forOthers; i++) await sendEmail(`q${i}@x.co`, EMAILS.signin("https://x/s"), "account");
  assert.equal(await sendEmail("owner2@x.co", appEmail(2), { owner: "someone-else" }), false);
  assert.equal(sent.length - before, EMAIL_BUDGET.perDay + 1);
});

test("emails to new addresses stop at their own daily share; members' sign-in emails still go", async () => {
  clock = NOON + 3 * DAY;
  let n = 0;
  while (await sendEmail(`new${n}@x.co`, EMAILS.signin("https://x/s"), "new")) n++;
  assert.equal(n, EMAIL_BUDGET.forNewAddresses);
  assert.equal(await sendEmail("member@x.co", EMAILS.signin("https://x/s"), "account"), true);
  assert.equal(await sendEmail("owner@x.co", appEmail(3), { owner: "o3" }), true, "orders and invites keep their share");
});

test("low-credit emails stop at their own daily share, count with app emails, and never take what sign-in emails keep", async () => {
  clock = NOON + 4 * DAY;
  const before = sent.length;
  const alert = (n: number) => EMAILS.lowCredits(n, "https://x/?credits=1");
  let n = 0;
  while (await sendEmail(`low${n}@x.co`, alert(n), "alert")) n++;
  assert.equal(n, EMAIL_BUDGET.alerts);
  assert.ok(EMAIL_BUDGET.alerts > 0 && EMAIL_BUDGET.alerts < forOthers, "app emails and invites keep most of their share");
  // They counted with app emails: those have what's left of the share.
  let apps = 0;
  while (await sendEmail(`app${apps}@x.co`, appEmail(apps), { owner: `alert-day-${apps}` })) apps++;
  assert.equal(apps, forOthers - EMAIL_BUDGET.alerts);
  // Every sign-in email kept for the day still goes.
  for (let i = 0; i < EMAIL_BUDGET.keptForAccounts; i++) assert.equal(await sendEmail(`s${i}@x.co`, EMAILS.signin("https://x/s"), "account"), true);
  assert.equal(sent.length - before, forOthers + EMAIL_BUDGET.keptForAccounts);

  // With app emails using up the share first, low-credit emails wait too, under their own count.
  clock = NOON + 5 * DAY;
  for (let i = 0; i < forOthers; i++) await sendEmail(`busy${i}@x.co`, appEmail(i), { owner: `busy-day-${i}` });
  assert.equal(await sendEmail("low@x.co", alert(1), "alert"), false);
  assert.equal(await sendEmail("member@x.co", EMAILS.signin("https://x/s"), "account"), true);
});

test("app-AI emails stop at a share of their own, so visitors setting them off never use up the low-credit emails'", async () => {
  clock = NOON + 6 * DAY;
  assert.ok(EMAIL_BUDGET.alerts + EMAIL_BUDGET.appAiAlerts < forOthers / 2, "app emails and invites keep most of their share");
  const ai = (n: number) => EMAILS.appAiOutOfCredits(`App ${n}`, "https://x/?credits=1");
  let n = 0;
  while (await sendEmail(`ai${n}@x.co`, ai(n), "app-ai")) n++;
  assert.equal(n, EMAIL_BUDGET.appAiAlerts);
  let low = 0;
  while (await sendEmail(`low-ai${low}@x.co`, EMAILS.lowCredits(50, "https://x/?credits=1"), "alert")) low++;
  assert.equal(low, EMAIL_BUDGET.alerts);
});

test("the day's shared emails are taken in one statement: one place left goes to one of two at once, and nothing refused is counted", async () => {
  const { countOf } = await import("../src/lib/server/limits.ts");
  clock = NOON + 7 * DAY;
  const day = new Date(clock).toISOString().slice(0, 10);
  for (let i = 0; i < forOthers - 1; i++) assert.equal(await sendEmail(`f${i}@x.co`, appEmail(i), { owner: `share-${i}` }), true);
  const low = EMAILS.lowCredits(50, "https://x/?credits=1");
  const pair = await Promise.all([sendEmail("pair-a@x.co", low, "alert"), sendEmail("pair-b@x.co", low, "alert")]);
  assert.deepEqual(pair.sort(), [false, true]);
  assert.equal(await countOf(`email-day:${day}`), forOthers, "the refused one took no place");
  assert.equal(await countOf(`email-alert:${day}`), 1, "and handed its alert place back");

  // A busy moment: forms, orders, reports, alerts and sign-in emails all at once. Every shared place is
  // used, alerts get theirs, and every sign-in email kept for the day goes.
  clock = NOON + 8 * DAY;
  const before = sent.length;
  const jobs: Promise<[string, boolean]>[] = [];
  const add = (kind: string, n: number, send: (i: number) => Promise<boolean>) => {
    for (let i = 0; i < n; i++) jobs.push(send(i).then((ok) => [kind, ok]));
  };
  add("form", 30, (i) => sendEmail(`bf${i}@x.co`, appEmail(i), { owner: `busy-owner-${i % 5}` }));
  add("other", 20, (i) => sendEmail(`bo${i}@x.co`, appEmail(i), "other"));
  add("report", 12, (i) => sendEmail(`br${i}@x.co`, appEmail(i), "report"));
  add("alert", 25, (i) => sendEmail(`ba${i}@x.co`, low, "alert"));
  add("account", EMAIL_BUDGET.keptForAccounts, (i) => sendEmail(`bs${i}@x.co`, EMAILS.signin("https://x/s"), "account"));
  const out = await Promise.all(jobs);
  const went = (kind: string) => out.filter(([k, ok]) => k === kind && ok).length;
  assert.equal(went("account"), EMAIL_BUDGET.keptForAccounts);
  assert.equal(went("form") + went("other") + went("report") + went("alert"), forOthers);
  assert.ok(went("alert") > 0 && went("alert") <= EMAIL_BUDGET.alerts);
  assert.equal(sent.length - before, EMAIL_BUDGET.perDay);
});

const { network } = await import("../src/lib/server/limits.ts");

test("IPv6 addresses count by their /64 network", () => {
  assert.equal(network("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
  assert.equal(network("2001:db8:1:2::9"), "2001:db8:1:2::/64");
  assert.equal(network("2001:0db8:0001:0002:ffff::1"), "2001:db8:1:2::/64");
  assert.equal(network("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(network("203.0.113.7"), "203.0.113.7");
  assert.equal(network("local"), "local");
});
