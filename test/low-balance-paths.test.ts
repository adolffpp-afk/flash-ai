/*
 * Low-credit emails on every path a spend can take: the app's AI, connectors, voice and the companion
 * as well as chat, a team's shared pool, auto top-up that fails or can't buy, a request refused for
 * lack of credits while an email is still owed or auto top-up can try again, several alerts at once,
 * credits that come back (a purchase, the monthly credits) with no spend between to see them, and a
 * visitor's question to an app's AI, which never buys its owner a pack.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in Claude for an app's AI: every answer costs a few credits.
const claude = createServer((req, res) => {
  req.resume();
  req.on("end", () =>
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        id: "m",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [{ type: "text", text: "Tuesday." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 4000, output_tokens: 3000 },
      }),
    ),
  );
});
await new Promise<void>((r) => claude.listen(0, "127.0.0.1", r));
after(() => claude.close());

register("./support/route-hooks.mjs", import.meta.url);
register(
  `data:text/javascript,${encodeURIComponent("export const load = (url, context, next) => next(url, url.endsWith('.json') ? { ...context, importAttributes: { type: 'json' } } : context);")}`,
);
process.env.DATABASE_URL = ":memory:";
process.env.RESEND_API_KEY = "test-key";
process.env.STRIPE_SECRET_KEY = "rk_test";
process.env.FLASH_APP_URL = "https://flash.test/";
process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(claude.address() as AddressInfo).port}`;
delete process.env.FLASH_DEMO_EMAILS;
delete process.env.FLASH_STRIPE_TAX;

const { run, one } = await import("../src/lib/server/db.ts");
const { addPurchase, charge, ensureMonthlyCredits, refund, settle } = await import("../src/lib/server/credits.ts");
const { EMAIL_BUDGET, sendEmail } = await import("../src/lib/server/email.ts");
const { maybeAutoTopUp } = await import("../src/lib/server/auto-topup.ts");
const { checkLowBalance } = await import("../src/lib/server/low-balance.ts");
const { askSiteAi, saveAiSettings } = await import("../src/lib/server/site-ai.ts");
const { afterwards } = await import("./support/next-server.mjs");

const NOON = Date.UTC(2026, 9, 9, 12);
const DAY = 86_400_000;
const MINUTE = 60_000;
let clock = NOON;
Date.now = () => clock;

// Resend's and Stripe's answers. decline: Stripe declines the card.
const sent: { to: string; subject: string }[] = [];
const stripeCalls: string[] = [];
let decline = false;
let intents = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "127.0.0.1") return realFetch(input, init);
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

test("a top-up's credits spent within its gap: the first request refused after the gap tries again, and the email goes if it can't buy", async () => {
  for (const id of ["gap", "gap2"]) {
    await user(id);
    await give(id, 130);
    await autoTopUpOn(id);
  }
  const bought = () => stripeCalls.filter((p) => p === "/v1/payment_intents").length;
  stripeCalls.length = 0;
  await spend("gap", 40);
  await afterwards();
  assert.equal(await balance("gap"), 90 + 500, "below the level: auto top-up buys");
  // A big build within the gap between top-ups: nothing more is bought, and no email (it can still buy).
  clock += 3 * MINUTE;
  await spend("gap", 580);
  await afterwards();
  assert.equal(bought(), 1);
  // Every paid request is refused from now on. The first one after the gap buys again.
  clock += 11 * MINUTE;
  assert.equal(await charge("gap", 50, "a build"), null);
  await afterwards();
  assert.equal(bought(), 2);
  assert.equal(await balance("gap"), 10 + 500);
  assert.ok(await charge("gap", 50, "a build"), "and the next request goes");
  assert.equal(to("gap").length, 0);

  // The same with the card declined after the gap: auto top-up turns off and the email goes.
  clock += 11 * MINUTE;
  await spend("gap2", 40);
  await afterwards();
  clock += 3 * MINUTE;
  await spend("gap2", 580);
  await afterwards();
  clock += 11 * MINUTE;
  decline = true;
  assert.equal(await charge("gap2", 50, "a build"), null);
  await afterwards();
  decline = false;
  assert.equal(Number((await one<{ enabled: number }>("SELECT enabled FROM auto_topups WHERE user_id = 'gap2'"))?.enabled), 0);
  assert.deepEqual(to("gap2").map((e) => e.subject), [LOW]);
});

test("a visitor's question to an app's AI never buys its owner a pack, answered or refused; the owner's own next request does", async () => {
  clock += DAY;
  await user("shop");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('bakery', 'shop', 'Bakery', '<p>', 0, 0)");
  await give("shop", 102);
  await autoTopUpOn("shop");
  await saveAiSettings("bakery", true, 1000);
  stripeCalls.length = 0;
  assert.equal((await askSiteAi("bakery", { prompt: "When should I book?" }, "203.0.113.9")).status, 200);
  await afterwards();
  // The app's AI only spends what is above the auto top-up level while auto top-up can buy (see
  // site-ai-money.test.ts), so the answer leaves the balance at or over it.
  assert.ok((await balance("shop")) >= 100, "the answer stopped at the auto top-up level");
  // A visitor's spend that does go below the level (a hold taken before auto top-up was turned on,
  // say), settled: it doesn't set off a top-up either.
  const held = await charge("shop", 5, 'AI in "Bakery"', { visitor: true });
  assert.ok(held);
  await settle(held, 5, { visitor: true });
  await afterwards();
  assert.ok((await balance("shop")) < 100, "the spend took the balance below the auto top-up level");
  // One refused by charge() (another visitor's question took the credits first, say).
  assert.equal(await charge("shop", 500, 'AI in "Bakery"', { visitor: true }), null);
  await afterwards();
  assert.deepEqual(stripeCalls, [], "nothing bought for visitors");
  assert.equal(to("shop").length, 0, "and no email: auto top-up still buys, on the owner's own next request");
  // The owner's own request, refused: auto top-up buys.
  assert.equal(await charge("shop", 500, "a build"), null);
  await afterwards();
  assert.deepEqual(stripeCalls, ["/v1/payment_intents"]);
  assert.ok((await balance("shop")) > 500);
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
  const outcomes = await Promise.all([checkLowBalance("free"), checkLowBalance("free"), checkLowBalance("free")]);
  assert.deepEqual(outcomes.sort(), ["alerted", "alerted", "sent"]);
  assert.equal(to("free").length, 2);

  // A purchase, then two spends settling together.
  clock += 8 * DAY;
  await addPurchase("free", "starter", "stripe:pack:free");
  for (let i = 0; i < 2; i++)
    await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at, settled_at) VALUES ('free', -260, 'job', ?, ?)", [clock, clock]);
  assert.deepEqual((await Promise.all([checkLowBalance("free"), checkLowBalance("free")])).sort(), ["alerted", "sent"]);
  assert.equal(to("free").length, 3);

  // Credits back that leave the balance below the level aren't a new drop.
  clock += 8 * DAY;
  await refund("free", 5, "a failed request");
  assert.equal(await checkLowBalance("free"), "alerted");
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
