/*
 * Low-credit emails on every path a spend can take: the app's AI, connectors, voice and the companion
 * as well as chat, a team's shared pool, auto top-up that fails or can't buy, a request refused for
 * lack of credits while an email is still owed, several alerts at once, and credits that come back
 * (a purchase, the monthly credits) with no spend between to see them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";

register("./support/route-hooks.mjs", import.meta.url);
register(
  `data:text/javascript,${encodeURIComponent("export const load = (url, context, next) => next(url, url.endsWith('.json') ? { ...context, importAttributes: { type: 'json' } } : context);")}`,
);
process.env.DATABASE_URL = ":memory:";
process.env.RESEND_API_KEY = "test-key";
process.env.STRIPE_SECRET_KEY = "rk_test";
process.env.FLASH_APP_URL = "https://flash.test/";
delete process.env.FLASH_DEMO_EMAILS;
delete process.env.FLASH_STRIPE_TAX;

const { run, one } = await import("../src/lib/server/db.ts");
const { addPurchase, charge, ensureMonthlyCredits, refund, settle } = await import("../src/lib/server/credits.ts");
const { EMAIL_BUDGET, sendEmail } = await import("../src/lib/server/email.ts");
const { maybeAutoTopUp } = await import("../src/lib/server/auto-topup.ts");
const { checkLowBalance } = await import("../src/lib/server/low-balance.ts");
const { afterwards } = await import("./support/next-server.mjs");

const NOON = Date.UTC(2026, 9, 9, 12);
const DAY = 86_400_000;
let clock = NOON;
Date.now = () => clock;

// Resend's and Stripe's answers. decline: Stripe declines the card.
const sent: { to: string; subject: string }[] = [];
const stripeCalls: string[] = [];
let decline = false;
let intents = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.host === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string };
    sent.push({ to: body.to[0], subject: body.subject });
    return Response.json({ id: "email" });
  }
  assert.equal(url.host, "api.stripe.com", "only Resend and Stripe are called");
  stripeCalls.push(url.pathname);
  if (url.pathname === "/v1/payment_intents") {
    if (decline) return Response.json({ error: { message: "Your card was declined." } }, { status: 402 });
    return Response.json({ id: `pi_${++intents}`, status: "succeeded" });
  }
  return Response.json({});
}) as typeof fetch;
console.error = () => {};
console.warn = () => {};

const LOW = "Your Flash credits are running low";
const to = (id: string) => sent.filter((e) => e.to === `${id}@x.co`);
const user = (id: string) => run("INSERT INTO users (id, email, password_hash, verified_at, created_at) VALUES (?, ?, 'h', 1, 0)", [id, `${id}@x.co`]);
const give = (id: string, credits: number, ref: string | null = null) =>
  run("INSERT INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, 'test', ?, ?)", [id, credits, ref, clock]);
const balance = async (id: string) => Number((await one<{ b: number }>("SELECT COALESCE(SUM(amount), 0) AS b FROM credit_ledger WHERE user_id = ?", [id]))?.b);
const autoTopUpOn = (id: string, below = 100) =>
  run("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES (?, 1, 'starter', ?, 'cus', 'pm', 0)", [id, below]);
/** A paid spend as the app's AI, connectors, voice and the companion make one: held, then settled. */
async function spend(id: string, credits: number) {
  const held = await charge(id, credits, "test");
  assert.ok(held, "the balance covers it");
  await settle(held, credits);
}
const alertKey = () => `email-alert:${new Date(clock).toISOString().slice(0, 10)}`;
const useUpAlertEmails = () =>
  run("INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count, reset_at = excluded.reset_at", [
    alertKey(),
    EMAIL_BUDGET.alerts,
    clock + DAY,
  ]);

test("auto top-up buys on a spend outside chat (the app's AI, connectors, voice, the companion), and no email goes", async () => {
  await user("baker");
  await give("baker", 130);
  await autoTopUpOn("baker");
  stripeCalls.length = 0;
  for (let i = 0; i < 6; i++) await spend("baker", 10);
  await afterwards();
  assert.deepEqual(stripeCalls, ["/v1/payment_intents"], "one top-up, at the level");
  assert.equal(await balance("baker"), 130 - 60 + 500);
  assert.equal(to("baker").length, 0);
});

test("a team member's spend tops up the pool owner's balance, whose ledger it came from", async () => {
  await user("boss");
  await user("member");
  await run(
    `INSERT INTO subscriptions (id, user_id, plan, interval, status, amount_cents, anchor, paid_until, test, created_at, updated_at)
     VALUES ('sub_boss', 'boss', 'business', 'month', 'active', 10000, ?, ?, 1, 0, 0)`,
    [clock, clock + 30 * DAY],
  );
  await run("INSERT INTO teams (id, owner_id, created_at) VALUES ('team_boss', 'boss', 0)");
  await run("INSERT INTO team_members (team_id, user_id, joined_at) VALUES ('team_boss', 'member', 0)");
  await give("boss", 120);
  await autoTopUpOn("boss");
  stripeCalls.length = 0;
  await spend("member", 30);
  await afterwards();
  assert.equal(await balance("member"), 0, "the pool paid");
  assert.deepEqual(stripeCalls, ["/v1/payment_intents"]);
  assert.equal(await balance("boss"), 90 + 500);
  assert.equal(to("boss").length + to("member").length, 0);
});

test("a disputed account with auto top-up on is emailed: auto top-up never buys for it", async () => {
  await user("disp");
  await give("disp", 149);
  await give("disp", 0, "stripe-dispute:dp_1:ch_1");
  await autoTopUpOn("disp");
  stripeCalls.length = 0;
  await spend("disp", 100);
  await afterwards();
  assert.equal(stripeCalls.length, 0);
  assert.equal(await maybeAutoTopUp("disp"), false);
  assert.deepEqual(to("disp").map((e) => e.subject), [LOW]);
});

test("a declined card: the spend that started the top-up sends one email, whichever try met the decline", async () => {
  // The chat route: the spend settles, then the route's own top-up runs as the check does.
  await user("dec");
  await give("dec", 130);
  await autoTopUpOn("dec");
  decline = true;
  const held = await charge("dec", 125, "test");
  await settle(held!, 125);
  assert.equal(await maybeAutoTopUp("dec"), false);
  await afterwards();
  assert.deepEqual(
    { ...(await one<{ enabled: number; failed: string }>("SELECT enabled, failed FROM auto_topups WHERE user_id = 'dec'")) },
    { enabled: 0, failed: "Your card was declined." },
  );
  assert.deepEqual(to("dec").map((e) => e.subject), [LOW]);

  // Opening Flash (/api/me) meets the decline first, with no spend at all: the email goes too.
  await user("dec2");
  await give("dec2", 50);
  await autoTopUpOn("dec2");
  assert.equal(await maybeAutoTopUp("dec2"), false);
  await afterwards();
  assert.deepEqual(to("dec2").map((e) => e.subject), [LOW]);
  decline = false;
});

test("an email held back by the day's share goes the next day on a request refused for lack of credits", async () => {
  await user("held");
  await give("held", 130);
  await useUpAlertEmails();
  await spend("held", 125);
  await afterwards();
  assert.equal(to("held").length, 0, "the day's share is used up");
  assert.ok(Number((await one<{ r: number }>("SELECT retry_at AS r FROM credit_alerts WHERE user_id = 'held'"))?.r) > clock);
  clock += DAY + 3600_000;
  assert.equal(await charge("held", 120, "a build"), null);
  await afterwards();
  assert.deepEqual(to("held").map((e) => e.subject), [LOW]);
  // Nothing more is owed: another refusal sends nothing.
  assert.equal(await charge("held", 120, "a build"), null);
  await afterwards();
  assert.equal(to("held").length, 1);
});

test("the alerts' daily share holds under a burst: 11 at once send 10, and 2 at once with one place left send 1", async () => {
  clock += DAY;
  const before = sent.length;
  const mail = { subject: "s", html: "h", text: "t" };
  const outcomes = await Promise.all(Array.from({ length: 11 }, (_, i) => sendEmail(`burst${i}@x.co`, mail, "alert")));
  assert.equal(outcomes.filter(Boolean).length, EMAIL_BUDGET.alerts);
  assert.equal(sent.length - before, EMAIL_BUDGET.alerts);

  clock += DAY;
  for (let i = 0; i < EMAIL_BUDGET.alerts - 1; i++) assert.equal(await sendEmail(`one${i}@x.co`, mail, "alert"), true);
  const pair = await Promise.all([sendEmail("pair1@x.co", mail, "alert"), sendEmail("pair2@x.co", mail, "alert")]);
  assert.deepEqual(pair.sort(), [false, true]);
});

test("credits that come back with no spend to see them re-arm the alert: the next drop is emailed, even when its spends settle together", async () => {
  clock += DAY;
  // Emailed once, then this month's free credits bring the balance back to 200.
  await user("free");
  await give("free", 150);
  await spend("free", 60);
  await afterwards();
  assert.equal(to("free").length, 1);
  clock += 8 * DAY;
  await ensureMonthlyCredits("free");
  assert.equal(await balance("free"), 200);
  // One request settles three paid jobs before any of their checks runs (an MCP batch, say).
  for (let i = 0; i < 3; i++)
    await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at, settled_at) VALUES ('free', -55, 'job', ?, ?)", [clock, clock]);
  const outcomes = await Promise.all([checkLowBalance("free", 55), checkLowBalance("free", 55), checkLowBalance("free", 55)]);
  assert.deepEqual(outcomes.sort(), ["alerted", "alerted", "sent"]);
  assert.equal(to("free").length, 2);

  // A purchase, then two spends settling together.
  clock += 8 * DAY;
  await addPurchase("free", "starter", "stripe:pack:free");
  for (let i = 0; i < 2; i++)
    await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at, settled_at) VALUES ('free', -260, 'job', ?, ?)", [clock, clock]);
  assert.deepEqual((await Promise.all([checkLowBalance("free", 260), checkLowBalance("free", 260)])).sort(), ["alerted", "sent"]);
  assert.equal(to("free").length, 3);

  // Credits back that leave the balance below the level aren't a new drop.
  clock += 8 * DAY;
  await refund("free", 5, "a failed request");
  assert.equal(await checkLowBalance("free", 1), "alerted");
  assert.equal(to("free").length, 3);
});

test("the Android app shows the setting the emails say to untick (it isn't a purchase)", () => {
  const dialog = readFileSync(new URL("../src/components/CreditsDialog.tsx", import.meta.url), "utf8");
  const start = dialog.indexOf("{!inApp && (");
  assert.ok(start > 0);
  // The block hidden in the app: from its start to the "{me.freeLane" that follows it.
  const end = dialog.indexOf("{me.freeLane.chats > 0", start);
  assert.match(dialog.slice(start, end), /\{me\.paymentsEnabled && <LowCreditEmails onChanged=\{onChanged\} \/>\}/, "on the website, under auto top-up");
  // In the app, after the block it hides.
  // Not behind me.paymentsEnabled, which the page sets false in the app (Flash.tsx): the setting asks the server.
  const inApp = /\{inApp && \(\s*<div className="mt-10">\s*<LowCreditEmails onChanged=\{onChanged\} \/>/.exec(dialog);
  assert.ok(inApp && inApp.index > end - 400 && inApp.index < end, "in the Android app, outside the hidden block");
  const flash = readFileSync(new URL("../src/components/Flash.tsx", import.meta.url), "utf8");
  assert.match(flash, /inAndroidApp\(\) \? \{ \.\.\.fetched, paymentsEnabled: false/, "why it can't go by me.paymentsEnabled");
});
