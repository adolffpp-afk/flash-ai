import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createHash } from "node:crypto";

// Spends settle inside requests: next/server's after() is the stand-in, which keeps the work for afterwards().
register("./support/route-hooks.mjs", import.meta.url);
// The server's translation tables are JSON files it imports as Next does (see i18n-tables.ts).
register(
  `data:text/javascript,${encodeURIComponent("export const load = (url, context, next) => next(url, url.endsWith('.json') ? { ...context, importAttributes: { type: 'json' } } : context);")}`,
);
process.env.DATABASE_URL = ":memory:";
process.env.RESEND_API_KEY = "test-key";
process.env.STRIPE_SECRET_KEY = "rk_test";
process.env.FLASH_APP_URL = "https://flash.test/";
delete process.env.FLASH_DEMO_EMAILS;

const { run, one, db } = await import("../src/lib/server/db.ts");
const { charge, settle, recentActivity } = await import("../src/lib/server/credits.ts");
const { EMAIL_BUDGET, EMAILS, LOW_CREDITS_LINE } = await import("../src/lib/server/email.ts");
const { MAX_PER_MONTH } = await import("../src/lib/server/auto-topup.ts");
const { sitesWithMessages } = await import("../src/lib/server/inbox.ts");
const lowBalance = await import("../src/lib/server/low-balance.ts");
const { ALERT_LEVELS, DEFAULT_LEVEL, alertEmailsToday, lowCreditsLevel, alertForPush, alertSettings, appAiAlert, checkLowBalance, creditsLink, deleteUserAlerts, noteAppAiOutOfCredits, saveAlertSettings, watchBalance } =
  lowBalance;
const { afterwards } = await import("./support/next-server.mjs");
const settingsRoute = await import("../src/app/api/billing/low-credit-emails/route.ts");
const { bellState, runningLow, NEARLY_OUT } = await import("../src/lib/bell.ts");

// Midday, so the day doesn't change halfway through a test.
const NOON = Date.UTC(2026, 9, 9, 12);
const DAY = 86_400_000;
const WEEK = 7 * DAY;
let clock = NOON;
Date.now = () => clock;

// What Resend was asked to send. down: it answers with an error. gate: it waits for this first.
// sending: called once as the next send reaches Resend.
type Sent = { to: string; subject: string; text: string; html: string };
const sent: Sent[] = [];
let down = false;
let gate: Promise<void> | null = null;
let sending: (() => void) | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  assert.match(String(input), /^https:\/\/api\.resend\.com\//, "only Resend is called");
  sending?.();
  sending = null;
  if (gate) await gate;
  if (down) return new Response("unavailable", { status: 503 });
  const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string; html: string };
  sent.push({ to: body.to[0], subject: body.subject, text: body.text, html: body.html });
  return Response.json({ id: "email" });
}) as typeof fetch;
const errors: unknown[] = [];
console.error = (...args: unknown[]) => errors.push(args);
console.warn = () => {};

// Makes the database fail once on the next statement that starts with failOn (a Turso hiccup).
const database = await db();
const execute = database.execute.bind(database);
let failOn: string | null = null;
(database as unknown as { execute: unknown }).execute = (stmt: string | { sql: string }) => {
  if (failOn && typeof stmt === "object" && stmt.sql.trimStart().startsWith(failOn)) {
    failOn = null;
    return Promise.reject(new Error("SQLITE_BUSY: database is locked"));
  }
  return execute(stmt as never);
};

const to = (email: string) => sent.filter((e) => e.to === email);
const user = (id: string) => run("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'h', 0)", [id, `${id}@x.co`]);
const give = (id: string, credits: number, ref: string | null = null) =>
  run("INSERT INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, 'test', ?, ?)", [id, credits, ref, clock]);
/** A spend as Flash makes one: held, then settled at what it used, then what happens after the response. */
async function spend(id: string, credits: number) {
  const held = await charge(id, credits, "test");
  assert.ok(held, "the balance covers it");
  await settle(held, credits);
  await afterwards();
}
/** A spend already settled, then the check settling it starts: its outcome. */
async function spent(id: string, credits: number) {
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at, settled_at) VALUES (?, ?, 'test', ?, ?)", [id, -credits, clock, clock]);
  return checkLowBalance(id);
}
/** Uses up today's low-credit emails (EMAIL_BUDGET.alerts), or app-AI emails (EMAIL_BUDGET.appAiAlerts). */
const useUpAlertEmails = (kind: "alert" | "app-ai" = "alert") =>
  run("INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count, reset_at = excluded.reset_at", [
    `email-${kind}:${new Date(clock).toISOString().slice(0, 10)}`,
    kind === "alert" ? EMAIL_BUDGET.alerts : EMAIL_BUDGET.appAiAlerts,
    clock + DAY,
  ]);
const state = (id: string) =>
  one<{ alerted_at: number; sent_at: number; retry_at: number; app_ai_at: number }>("SELECT alerted_at, sent_at, retry_at, app_ai_at FROM credit_alerts WHERE user_id = ?", [id]);

test("the default level is on the list, and a level that isn't is refused", async () => {
  await user("set");
  assert.ok(ALERT_LEVELS.some((l) => l === DEFAULT_LEVEL));
  assert.deepEqual(await alertSettings("set"), { enabled: true, below: DEFAULT_LEVEL, levels: ALERT_LEVELS }, "on until they turn it off");
  assert.equal(await saveAlertSettings("set", { enabled: true, below: 7 }), null);
  assert.deepEqual(await saveAlertSettings("set", { enabled: false, below: 300 }), { enabled: false, below: 300, levels: ALERT_LEVELS });
  assert.deepEqual(await alertSettings("set"), { enabled: false, below: 300, levels: ALERT_LEVELS });
});

test("a spend that takes the balance below the level emails once: the approved words, the balance, Credits and how to stop them", async () => {
  await user("ana");
  await give("ana", 150);
  await spend("ana", 40);
  assert.equal(to("ana@x.co").length, 0, "110 is still above 100");
  await spend("ana", 30);
  const [email, ...more] = to("ana@x.co");
  assert.equal(more.length, 0);
  assert.equal(email.subject, "Your Flash credits are running low");
  assert.equal(
    LOW_CREDITS_LINE,
    "Your Flash credits are running low. Your apps and websites keep running, but they only get new updates while you have credits. Top up to keep them updating.",
  );
  for (const part of [email.text, email.html]) {
    assert.ok(part.includes(LOW_CREDITS_LINE));
    assert.ok(part.includes("You have 80 credits left."));
    assert.ok(part.includes("https://flash.test/?credits=1&as=ana"), "the button opens Credits in this account");
    assert.ok(part.includes("Email me when my credits run low"), "and says how to stop them");
  }
  assert.equal(creditsLink("a b"), "https://flash.test/?credits=1&as=a%20b");

  // Spending on below the level: no more emails for this drop.
  await spend("ana", 10);
  await spend("ana", 10);
  assert.equal(to("ana@x.co").length, 1);
  assert.equal(await spent("ana", 1), "alerted");
});

test("the next drop is emailed only after the balance was back at or above the level, at most once a week", async () => {
  // ana has 59, emailed at NOON. Topped up to 259: the next spend sees it above and re-arms.
  await give("ana", 200, "stripe:pack:1");
  clock += 60_000;
  assert.equal(await spent("ana", 9), "above");
  assert.equal((await state("ana"))?.alerted_at, 0);
  // Below again within the week: this drop waits until a week after the last email.
  assert.equal(await spent("ana", 200), "weekly");
  assert.equal(to("ana@x.co").length, 1);
  assert.equal((await state("ana"))?.retry_at, NOON + WEEK);
  assert.equal(await spent("ana", 1), "waiting");
  clock = NOON + WEEK;
  assert.equal(await spent("ana", 1), "sent", "a week after the last, the next spend sends it");
  assert.ok(to("ana@x.co")[1].text.includes("You have 48 credits left."));
  assert.equal(await spent("ana", 1), "alerted");

  // A purchase and then one big spend, with no spend between to see the balance above: the purchase
  // re-armed it as it came in (credit_alerts_rearm), so it's a new drop.
  clock += WEEK;
  await give("ana", 500, "stripe:pack:2");
  assert.equal(await spent("ana", 520), "sent");
  assert.equal(to("ana@x.co").length, 3);
});

test("no email while auto top-up is on and can buy; one when its last try failed or this month's are used up", async () => {
  // Emails at 300, auto top-up at 100: it buys at its own level (see test/low-balance-paths.test.ts
  // for a top-up the check tries), so 249 left sends no email.
  await user("auto");
  await saveAlertSettings("auto", { enabled: true, below: 300 });
  await give("auto", 250);
  await run("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES ('auto', 1, 'starter', 100, 'cus', 'pm', 0)");
  assert.equal(await spent("auto", 1), "auto");
  // A declined card turns it off with the reason (see auto-topup.ts).
  await run("UPDATE auto_topups SET enabled = 0, failed = 'Your card was declined.'");
  assert.equal(await spent("auto", 1), "sent");

  await user("manual");
  await give("manual", 90);
  await run("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES ('manual', 0, 'starter', 100, 'cus', 'pm', 0)");
  assert.equal(await spent("manual", 1), "sent", "turned off, with a card saved");
  await user("nocard");
  await give("nocard", 90);
  await run("INSERT INTO auto_topups (user_id, enabled, pack, below, updated_at) VALUES ('nocard', 1, 'starter', 100, 0)");
  assert.equal(await spent("nocard", 1), "sent", "no card to buy with");

  await user("monthly");
  await saveAlertSettings("monthly", { enabled: true, below: 300 });
  await give("monthly", 250);
  await run("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES ('monthly', 1, 'starter', 100, 'cus', 'pm', 0)");
  for (let i = 0; i < MAX_PER_MONTH - 1; i++) await give("monthly", 0, `stripe:auto:pi_${i}`);
  assert.equal(await spent("monthly", 1), "auto");
  await give("monthly", 0, "stripe:auto:pi_last");
  assert.equal(await spent("monthly", 1), "sent", "auto top-up won't buy again this month");
});

test("off when turned off, at the level picked, and only with payments and emails on", async () => {
  // set turned it off at 300.
  await give("set", 250);
  assert.equal(await spent("set", 10), "off");
  await saveAlertSettings("set", { enabled: true, below: 300 });
  assert.equal(await spent("set", 10), "sent", "230 is below 300");

  await user("nopay");
  await give("nopay", 50);
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal(await spent("nopay", 1), "off", "no payments: nothing to top up with");
  process.env.STRIPE_SECRET_KEY = "rk_test";
  delete process.env.RESEND_API_KEY;
  assert.equal(await spent("nopay", 1), "off", "no email provider");
  process.env.RESEND_API_KEY = "test-key";
  assert.equal(await state("nopay"), null, "nothing was kept for it");
});

test("a held charge doesn't count as spent until it settles, and a spend of nothing isn't looked at", async () => {
  await user("hold");
  await give("hold", 150);
  const running = await charge("hold", 100, "a long build");
  assert.ok(running);
  assert.equal(await spent("hold", 10), "above", "the running build holds 100, but most of it comes back");
  // Fifteen minutes on, a hold that never settled counts.
  clock += 15 * 60_000 + 1;
  assert.equal(await spent("hold", 1), "sent");
  clock = NOON + 2 * WEEK + DAY;

  const before = (globalThis as { __flashAfter?: unknown[] }).__flashAfter?.length ?? 0;
  watchBalance("hold", 0);
  await settle(running, 0);
  assert.equal((globalThis as { __flashAfter?: unknown[] }).__flashAfter?.length ?? 0, before, "nothing after the response");
});

test("two spends settling at once send one email", async () => {
  await user("twice");
  await give("twice", 150);
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at, settled_at) VALUES ('twice', -60, 'a', ?, ?), ('twice', -60, 'b', ?, ?)", [clock, clock, clock, clock]);
  const outcomes = await Promise.all([checkLowBalance("twice"), checkLowBalance("twice")]);
  assert.deepEqual(outcomes.sort(), ["alerted", "sent"]);
  assert.equal(to("twice@x.co").length, 1);
});

test("spends near the level settling together, each enough alone to cross it, email the drop once: during the send, after it, and a week on", async () => {
  // 107, then two settled spends of 4: 99, and each spend alone took it from the level to below it.
  await user("near");
  await give("near", 107);
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at, settled_at) VALUES ('near', -4, 'a', ?, ?), ('near', -4, 'b', ?, ?)", [clock, clock, clock, clock]);
  let release = () => {};
  gate = new Promise((r) => (release = r));
  const reached = new Promise<void>((r) => (sending = r));
  const first = checkLowBalance("near");
  await reached;
  // The second check, while the first one's email is on its way: done, or sending a second one.
  const secondSends = new Promise<void>((r) => (sending = r));
  const second = checkLowBalance("near");
  await Promise.race([second, secondSends]);
  sending = null;
  release();
  gate = null;
  assert.deepEqual([await first, await second], ["sent", "alerted"]);
  assert.equal(await checkLowBalance("near"), "alerted", "and once it went");
  assert.deepEqual({ ...(await state("near")) }, { alerted_at: clock, sent_at: clock, retry_at: 0, app_ai_at: 0 }, "nothing held for a week on");
  assert.equal((await alertEmailsToday()).lowWeekly, 0);
  // More than a week on, the balance never back at the level: a request refused for lack of credits
  // and another spend send nothing more for this drop.
  clock += WEEK + DAY;
  assert.equal(await charge("near", 500, "a build"), null);
  await afterwards();
  await spend("near", 1);
  assert.equal(to("near@x.co").length, 1);
});

test("settling hands the check to after the response: the spend never waits for the email, and never fails with it", async () => {
  await user("slow");
  await give("slow", 120);
  let release = () => {};
  gate = new Promise((r) => (release = r));
  const held = await charge("slow", 50, "test");
  await settle(held!, 50);
  assert.equal(to("slow@x.co").length, 0, "settled while the email is still on its way");
  release();
  gate = null;
  await afterwards();
  assert.equal(to("slow@x.co").length, 1, "and the email goes after");

  // The provider fails: the spend settles, the failure is logged, and the email waits for a later day.
  await user("down");
  await give("down", 120);
  down = true;
  errors.length = 0;
  const failing = await charge("down", 50, "test");
  await settle(failing!, 50);
  await afterwards();
  down = false;
  assert.ok(errors.some((e) => String((e as unknown[])[0]).includes("low-credit email failed")));
  assert.equal(to("down@x.co").length, 0);
  assert.equal((await state("down"))?.retry_at, Math.floor(clock / DAY + 1) * DAY);
  assert.equal(await spent("down", 1), "waiting", "not again today");
  clock = Math.floor(clock / DAY + 1) * DAY + 3600_000;
  assert.equal(await spent("down", 1), "sent", "the first spend the next day sends it, still low");
});

test("when the day's alert emails are used up, the alert waits for a later day, unless the balance is back up", async () => {
  await useUpAlertEmails();
  await user("late");
  await give("late", 50);
  await user("later");
  await give("later", 50);
  assert.equal(await spent("late", 1), "budget");
  assert.equal(await spent("later", 1), "budget");
  assert.equal(to("late@x.co").length + to("later@x.co").length, 0);
  assert.equal(await spent("late", 1), "waiting");
  clock = Math.floor(clock / DAY + 1) * DAY + 3600_000;
  assert.equal(await spent("late", 1), "sent");
  // later bought credits before spending again: nothing is owed.
  await give("later", 500, "stripe:pack:later");
  assert.equal(await spent("later", 1), "above");
  assert.equal(to("later@x.co").length, 0);
  assert.deepEqual({ ...(await state("later")) }, { alerted_at: 0, sent_at: 0, retry_at: 0, app_ai_at: 0 });
});

test("today's alert emails are counted for /admin", async () => {
  clock = Math.floor(clock / DAY + 1) * DAY + 3600_000;
  await user("count");
  await give("count", 50);
  assert.equal(await spent("count", 1), "sent");
  await give("count", 500, "stripe:pack:count");
  assert.equal(await spent("count", 1), "above");
  assert.equal(await spent("count", 500), "weekly");
  await useUpAlertEmails();
  await user("count2");
  await give("count2", 50);
  assert.equal(await spent("count2", 1), "budget");
  assert.deepEqual(await alertEmailsToday(), { lowSent: 1, lowBudget: 1, lowWeekly: 1, lowFailed: 0, outSent: 0, outBudget: 0, outFailed: 0, appAiSent: 0, appAiBudget: 0, appAiFailed: 0 });
  await run("DELETE FROM rate_limits WHERE key LIKE 'email-alert:%'");
});

test("an app's AI out of credits: the app is marked for the bell and its owner emailed, at most once a day", async () => {
  clock = Math.floor(clock / DAY + 1) * DAY + 3600_000;
  await user("shopkeeper");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('bakery', 'shopkeeper', 'Bakery <Best>', '<p>', 0, 0)");
  await run("INSERT INTO site_ai (site_slug, enabled, updated_at) VALUES ('bakery', 1, 0)");
  noteAppAiOutOfCredits("bakery", "shopkeeper", "Bakery <Best>");
  await afterwards();
  const [email, ...more] = to("shopkeeper@x.co");
  assert.equal(more.length, 0);
  assert.equal(email.subject, "The AI in Bakery <Best> is out of credits");
  assert.ok(email.text.includes("Visitors are asking the AI in your app Bakery <Best>, but their questions aren't being answered"));
  assert.ok(email.text.includes("The rest of the app keeps working."));
  assert.ok(email.text.includes("https://flash.test/?credits=1&as=shopkeeper"));
  assert.ok(email.html.includes("Bakery &lt;Best&gt;") && !email.html.includes("<Best>"), "the title is escaped");
  const [site] = await sitesWithMessages("shopkeeper");
  assert.equal(site.aiOutOfCredits, clock, "the bell shows it");

  // More visitors turned away: no new email the same day, and the mark is refreshed only every few minutes.
  clock += 60_000;
  noteAppAiOutOfCredits("bakery", "shopkeeper", "Bakery <Best>");
  await afterwards();
  assert.equal((await sitesWithMessages("shopkeeper"))[0].aiOutOfCredits, clock - 60_000);
  clock += 20 * 60_000;
  noteAppAiOutOfCredits("bakery", "shopkeeper", "Bakery <Best>");
  await afterwards();
  assert.equal((await sitesWithMessages("shopkeeper"))[0].aiOutOfCredits, clock);
  assert.equal(to("shopkeeper@x.co").length, 1, "one a day");
  assert.equal(await appAiAlert("shopkeeper", "Bakery"), "daily");
  clock += DAY;
  assert.equal(await appAiAlert("shopkeeper", "Bakery"), "sent");
  assert.equal(to("shopkeeper@x.co").length, 2);

  // Two at once send one; turned off sends none.
  clock += DAY;
  assert.deepEqual((await Promise.all([appAiAlert("shopkeeper", "Bakery"), appAiAlert("shopkeeper", "Bakery")])).sort(), ["daily", "sent"]);
  clock += DAY;
  await saveAlertSettings("shopkeeper", { enabled: false, below: 100 });
  assert.equal(await appAiAlert("shopkeeper", "Bakery"), "off");
  // Held back by the day's budget: it waits a day like a sent one, and is counted.
  await saveAlertSettings("shopkeeper", { enabled: true, below: 100 });
  await useUpAlertEmails("app-ai");
  assert.equal(await appAiAlert("shopkeeper", "Bakery"), "budget");
  assert.equal(await appAiAlert("shopkeeper", "Bakery"), "daily");
  assert.equal((await alertEmailsToday()).appAiBudget, 1);
  assert.equal(to("shopkeeper@x.co").length, 3);
});

test("an app's AI stopped at its owner's auto top-up level: the bell and the email say it stopped there, not that their credits ran out", async () => {
  clock = Math.floor(clock / DAY + 1) * DAY + 3600_000;
  await user("leveler");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('buns', 'leveler', 'Buns <Hot>', '<p>', 0, 0)");
  await run("INSERT INTO site_ai (site_slug, enabled, updated_at) VALUES ('buns', 1, 0)");
  noteAppAiOutOfCredits("buns", "leveler", "Buns <Hot>", true);
  await afterwards();
  const [email, ...more] = to("leveler@x.co");
  assert.equal(more.length, 0);
  assert.equal(email.subject, "The AI in Buns <Hot> stopped at your auto top-up level");
  assert.ok(email.text.includes("Visitors are asking the AI in your app Buns <Hot>, but their questions aren't being answered"));
  assert.ok(email.text.includes("with auto top-up on, it stops when your balance gets down to your top-up level, so your visitors never set off a top-up"));
  assert.ok(!/run out|out of credits/.test(email.text + email.subject), "their credits haven't run out");
  assert.ok(email.html.includes("Buns &lt;Hot&gt;") && !email.html.includes("<Hot>"), "the title is escaped");
  const [site] = await sitesWithMessages("leveler");
  assert.deepEqual([site.aiOutOfCredits, site.aiAtLevel], [clock, true], "the bell shows it, as stopped at the level");
  // Then its credits run out (auto top-up turned off, say): the mark says so at once, within the few
  // minutes a mark otherwise waits. The day's one email has gone, whichever it was.
  clock += 60_000;
  noteAppAiOutOfCredits("buns", "leveler", "Buns <Hot>");
  await afterwards();
  const [later] = await sitesWithMessages("leveler");
  assert.deepEqual([later.aiOutOfCredits, later.aiAtLevel], [clock, false]);
  assert.equal(to("leveler@x.co").length, 1, "one a day");
  clock += DAY;
  assert.equal(await appAiAlert("leveler", "Buns", true), "sent");
  assert.equal(to("leveler@x.co")[1].subject, "The AI in Buns stopped at your auto top-up level");
  // The bell's words.
  const { readFile } = await import("node:fs/promises");
  const bell = await readFile(new URL("../src/components/Bell.tsx", import.meta.url), "utf8");
  assert.match(bell, /s\.aiAtLevel\s*\?\s*t\("The AI in \{name\} stopped at your auto top-up level"/);
});

test("visitors setting off app-AI emails never use up the low-credit emails' share", async () => {
  // Owners out of credits whose apps' AI visitors ask, more of them than the app-AI emails' share.
  clock = Math.floor(clock / DAY + 1) * DAY + 3600_000;
  const outcomes = [];
  for (let i = 0; i <= EMAIL_BUDGET.appAiAlerts; i++) {
    await user(`broke${i}`);
    outcomes.push(await appAiAlert(`broke${i}`, `App ${i}`));
  }
  assert.deepEqual(outcomes, [...Array(EMAIL_BUDGET.appAiAlerts).fill("sent"), "budget"]);
  // Someone's own spend takes their balance below their level: the email still goes.
  await user("own");
  await give("own", 150);
  await spend("own", 60);
  assert.deepEqual(to("own@x.co").map((e) => e.subject), ["Your Flash credits are running low"]);
});

test("one owner's busy apps take at most one place a day in the app-AI emails' share, so other owners still get theirs", async () => {
  const { countOf } = await import("../src/lib/server/limits.ts");
  // From a day's first moment: the owner's one email a day (app_ai_at) lands once on each UTC day.
  clock = Math.floor(clock / DAY + 1) * DAY + 1;
  await user("bakehouse");
  // Visitors of two of their apps turned away, three at a time, every three minutes for two days.
  const places: Record<string, number> = {};
  const end = clock + 2 * DAY;
  for (; clock < end; clock += 3 * 60_000) {
    await Promise.all([appAiAlert("bakehouse", "Bakery"), appAiAlert("bakehouse", "Buns"), appAiAlert("bakehouse", "Bakery")]);
    const day = new Date(clock).toISOString().slice(0, 10);
    places[day] = await countOf(`email-app-ai:${day}`);
  }
  assert.deepEqual(Object.values(places), [1, 1], "one place a day");
  assert.equal(to("bakehouse@x.co").length, 2);
  // The rest of the last day's share is there for other owners.
  clock -= 3 * 60_000;
  const others = [];
  for (let i = 1; i < EMAIL_BUDGET.appAiAlerts; i++) {
    await user(`neighbour${i}`);
    others.push(await appAiAlert(`neighbour${i}`, "Cafe"));
  }
  assert.deepEqual(others, Array(EMAIL_BUDGET.appAiAlerts - 1).fill("sent"));
});

test("the emails keep a title to one line, never show a negative balance, and the words for phones are the bell's", async () => {
  const email = EMAILS.appAiOutOfCredits("Shop\r\nBcc: x@y.z", "https://flash.test/?credits=1");
  assert.equal(email.subject, "The AI in Shop Bcc: x@y.z is out of credits");
  assert.equal(EMAILS.appAiOutOfCredits("  ", "l").subject, "The AI in your app is out of credits");
  assert.ok(EMAILS.lowCredits(-5, "l").text.includes("You have 0 credits left."));
  assert.ok(EMAILS.lowCredits(1234, "l").text.includes("You have 1,234 credits left."));

  const push = await alertForPush("ana", { kind: "low-credits" });
  assert.equal(push.title, "Your Flash credits are running low.");
  assert.equal(`${push.title} ${push.body}`, LOW_CREDITS_LINE);
  assert.equal(push.url, "https://flash.test/?credits=1&as=ana");
  await run("UPDATE users SET language = 'de' WHERE id = 'ana'");
  const de = await alertForPush("ana", { kind: "app-ai", site: "Bäckerei" });
  assert.ok(de.title.includes("Bäckerei") && !de.title.includes("out of credits"), "in their language");
  const stopped = await alertForPush("ana", { kind: "app-ai", site: "Bäckerei", atLevel: true });
  assert.ok(stopped.title.includes("Bäckerei") && stopped.title !== de.title, "stopped at the level, in their language");
  assert.ok(EMAILS.appAiAtLevel("Shop\r\nBcc: x@y.z", "l").subject === "The AI in Shop Bcc: x@y.z stopped at your auto top-up level");
  await run("UPDATE users SET language = '' WHERE id = 'ana'");
});

test("deleting an account's alerts removes its row (foreign keys are off on Turso)", async () => {
  assert.ok(await state("ana"));
  await deleteUserAlerts("ana");
  assert.equal(await state("ana"), null);
  assert.ok(await state("set"), "only theirs");
});

test("Credits' setting: only for the signed-in person, only levels from the list, and the bell and Home say \"low\" at the same level", async () => {
  await user("me");
  const token = "tok_me";
  await run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 'me', ?)", [createHash("sha256").update(token).digest("hex"), clock + DAY]);
  const call = (method: "GET" | "POST", body?: object, cookie = `flash_session=${token}`) =>
    settingsRoute[method](
      new Request("http://localhost/api/billing/low-credit-emails", {
        method,
        headers: { "content-type": "application/json", origin: "http://localhost", cookie },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  assert.equal((await call("GET", undefined, "")).status, 401);
  assert.deepEqual(await (await call("GET")).json(), { enabled: true, below: DEFAULT_LEVEL, levels: ALERT_LEVELS, emails: true });
  assert.equal(await lowCreditsLevel("me"), DEFAULT_LEVEL);

  const bad = await call("POST", { enabled: true, below: 5 });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "Pick a level from the list." });
  assert.deepEqual(await (await call("POST", { enabled: true, below: 1000 })).json(), { enabled: true, below: 1000, levels: ALERT_LEVELS, emails: true });
  assert.equal(await lowCreditsLevel("me"), 1000);
  assert.deepEqual(await (await call("POST", { enabled: false, below: 1000 })).json(), { enabled: false, below: 1000, levels: ALERT_LEVELS, emails: true });
  assert.equal(await lowCreditsLevel("me"), NEARLY_OUT, "emails off: only nearly nothing left is low");
  await saveAlertSettings("me", { enabled: true, below: 300 });
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal(await lowCreditsLevel("me"), NEARLY_OUT, "payments off");
  process.env.STRIPE_SECRET_KEY = "rk_test";
  delete process.env.RESEND_API_KEY;
  assert.equal((await (await call("GET")).json()).emails, false, "no email provider: Credits hides the setting");
  process.env.RESEND_API_KEY = "test-key";
  // The Android app's page is told payments are off, so the server says whether these emails go.
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal((await (await call("GET")).json()).emails, false, "payments off: no emails, and no setting");
  process.env.STRIPE_SECRET_KEY = "rk_test";
  assert.equal((await (await call("GET")).json()).emails, true);
});

test("the bell: low below the person's level, with its dot until opened once; an app's AI out of credits until credits come", () => {
  const T = NOON;
  const me = (credits: number, lowCredits = 100, activity: { amount: number; reason: string; created_at: number }[] = []) => ({ credits, lowCredits, activity });
  assert.equal(runningLow(me(99)), true);
  assert.equal(runningLow(me(100)), false);
  assert.equal(runningLow({ credits: 9, activity: [] }), true, "before the server says a level: nearly nothing left");
  assert.equal(runningLow({ credits: 10, activity: [] }), false);

  const low = bellState(me(80), [], T, T - 1, false);
  assert.deepEqual([low.low, low.fresh, low.empty], [true, true, false]);
  assert.equal(bellState(me(80), [], T, T - 1, true).fresh, false, "opened since it went low: no dot");
  assert.equal(bellState(me(5), [], T, T - 1, true).fresh, true, "nearly nothing left: the dot stays");
  assert.deepEqual([bellState(me(150), [], T, T - 1, false).low, bellState(me(150), [], T, T - 1, false).empty], [false, true]);

  const site = (aiOutOfCredits: number) => ({ slug: "bakery", title: "Bakery", unread: 0, aiOutOfCredits });
  const out = bellState(me(500), [site(T - 3600_000)], T, T - 7200_000, true);
  assert.deepEqual(out.aiOut.map((s) => s.slug), ["bakery"]);
  assert.deepEqual([out.fresh, out.empty], [true, false]);
  assert.equal(bellState(me(500), [site(T - 3600_000)], T, T, true).fresh, false, "seen already");
  assert.equal(bellState(me(500), [site(0)], T, 0, true).aiOut.length, 0, "it answers again");
  assert.equal(bellState(me(500), [site(T - 8 * DAY)], T, 0, true).aiOut.length, 0, "more than a week ago");
  const toppedUp = me(500, 100, [{ amount: 500, reason: "Top up", created_at: T - 60_000 }]);
  assert.equal(bellState(toppedUp, [site(T - 3600_000)], T, 0, true).aiOut.length, 0, "credits came since");
  assert.equal(bellState(me(500), [site(T - 3600_000)], 0, 0, true).aiOut.length, 0, "not before the browser knows the time");
});

test("the bell's list stays on the screen: across a phone, and from the bell toward the page in either direction", async () => {
  const { readFile } = await import("node:fs/promises");
  const bell = await readFile(new URL("../src/components/Bell.tsx", import.meta.url), "utf8");
  const menu = bell.match(/role="menu"[\s\S]*?className="([^"]+)"/)?.[1].split(" ") ?? [];
  // A phone: the bell sits too far in for a 20rem list pinned to it, so it spans the screen under the top bar.
  for (const name of ["fixed", "inset-x-4", "top-16"]) assert.ok(menu.includes(name), name);
  // Wider: from the bell's end side, which is its left in Arabic, Hebrew, Persian and Urdu, where the
  // bell sits near the left edge and a list pinned to its right side ran off the screen.
  for (const name of ["sm:absolute", "sm:inset-x-auto", "sm:end-0", "sm:top-full", "sm:w-80"]) assert.ok(menu.includes(name), name);
  assert.deepEqual(menu.filter((name) => /^(sm:)?(w-|right-|left-)/.test(name)), ["sm:w-80"]);
  assert.match(bell, /const row = "flex w-full items-start gap-3 rounded-xl px-3 py-2\.5 text-start /);
  assert.doesNotMatch(bell, /\btext-(left|right)\b/);
});

const nextDayAt = (hour: number) => Math.floor(clock / DAY + 1) * DAY + hour * 3600_000;

test("a check the database fails, or an email held back whose note fails, still sends the drop's email later", async () => {
  clock = nextDayAt(1);
  // The check's one read fails: nothing is claimed, and the next spend sends it.
  await user("hiccup");
  await give("hiccup", 150);
  errors.length = 0;
  failOn = "SELECT u.email";
  await spend("hiccup", 60);
  assert.equal(failOn, null, "the read failed");
  assert.equal(errors.length, 1, "and was logged");
  assert.equal(await state("hiccup"), null, "nothing claimed");
  await spend("hiccup", 1);
  assert.equal(to("hiccup@x.co").length, 1);

  // The day's share used up, and noting that fails once: noted as a failed send, sent the next day.
  await useUpAlertEmails();
  await user("noted");
  await give("noted", 150);
  failOn = "UPDATE credit_alerts SET alerted_at = 0, sent_at";
  await spend("noted", 60);
  assert.equal(failOn, null);
  assert.deepEqual({ ...(await state("noted")) }, { alerted_at: 0, sent_at: 0, retry_at: nextDayAt(0), app_ai_at: 0 }, "owed from the next day");
  clock = nextDayAt(1);
  await spend("noted", 1);
  assert.equal(to("noted@x.co").length, 1, "the first spend the next day sends it");
});

test("an email cut off mid-send (the server stopped) counts as sent when claimed: the drop isn't lost, and the next goes a week after it", async () => {
  clock = nextDayAt(1);
  const claimed = clock;
  await user("cut");
  await give("cut", 150);
  // Resend never answers: the server was stopped while the email was on its way.
  gate = new Promise(() => {});
  const reached = new Promise<void>((r) => (sending = r));
  void spent("cut", 60);
  await reached;
  gate = null;
  clock += 60_000;
  assert.equal(await spent("cut", 1), "alerted", "being sent");
  // Past the time a send can take: it may have gone, so it counts as the week's email.
  clock = claimed + 16 * 60_000;
  assert.equal(await spent("cut", 1), "weekly");
  assert.deepEqual({ ...(await state("cut")) }, { alerted_at: 0, sent_at: claimed, retry_at: claimed + WEEK, app_ai_at: 0 });
  assert.equal(to("cut@x.co").length, 0);
  clock = claimed + WEEK;
  assert.equal(await spent("cut", 1), "sent", "still low a week on: emailed");
  assert.equal(to("cut@x.co").length, 1);
});

test("credits coming in while the email is being sent, then a new drop: one email now, the next a week after it", async () => {
  clock = nextDayAt(1);
  const first = clock;
  await user("pair");
  await give("pair", 150);
  let release = () => {};
  gate = new Promise((r) => (release = r));
  const reached = new Promise<void>((r) => (sending = r));
  const sending1 = spent("pair", 60);
  await reached;
  // A pack bought meanwhile (190: credit_alerts_rearm re-arms it), and a spend takes it below again.
  await give("pair", 100, "stripe:pack:pair-1");
  assert.equal((await state("pair"))?.alerted_at, 0, "re-armed");
  clock += 30_000;
  const secondSends = new Promise<string>((r) => (sending = () => r("sending")));
  assert.equal(await Promise.race([spent("pair", 120), secondSends]), "weekly", "the first counts as this week's");
  sending = null;
  release();
  gate = null;
  assert.equal(await sending1, "sent");
  assert.equal(to("pair@x.co").length, 1);
  assert.deepEqual({ ...(await state("pair")) }, { alerted_at: 0, sent_at: first, retry_at: first + WEEK, app_ai_at: 0 });
  clock = first + WEEK;
  assert.equal(await spent("pair", 1), "sent");
  assert.equal(to("pair@x.co").length, 2);
});

test("a level set at or under the balance re-arms the alert: the next drop below it is emailed, and one already under it isn't again", async () => {
  clock = nextDayAt(1);
  await user("lower");
  await give("lower", 150);
  await spend("lower", 60);
  assert.equal(to("lower@x.co").length, 1, "90 is below 100");
  clock += 8 * DAY;
  // Lowered to 50, under the 90 left: one image of 60 takes it to 30.
  await saveAlertSettings("lower", { enabled: true, below: 50 });
  assert.equal((await state("lower"))?.alerted_at, 0, "re-armed");
  await spend("lower", 60);
  assert.equal(to("lower@x.co").length, 2, "the drop below 50 is emailed");
  // Changed to 100 with 30 left: that drop was emailed already, so nothing goes again.
  clock += 8 * DAY;
  await saveAlertSettings("lower", { enabled: true, below: 100 });
  assert.ok((await state("lower"))?.alerted_at, "still emailed");
  assert.equal(await spent("lower", 1), "alerted");
  assert.equal(to("lower@x.co").length, 2);
});

test("a spend that settles after its account was deleted writes no alert row back, and emails no one", async () => {
  clock = nextDayAt(1);
  await user("gone");
  await give("gone", 200);
  const running = await charge("gone", 150, "chat request");
  assert.ok(running);
  // Deleted by hand while the request runs (Turso has foreign keys off).
  await run("PRAGMA foreign_keys = OFF");
  try {
    await deleteUserAlerts("gone");
    await run("DELETE FROM users WHERE id = 'gone'");
    await settle(running, 150);
    await afterwards();
    assert.equal(await state("gone"), null, "nothing written back");
    assert.equal(await checkLowBalance("gone"), "off");
    assert.equal(await state("gone"), null);
    assert.equal(to("gone@x.co").length, 0);
  } finally {
    await run("DELETE FROM credit_ledger WHERE user_id = 'gone'");
    await run("PRAGMA foreign_keys = ON");
  }
});

test("the bell's \"AI out of credits\" stays gone once credits came in, however many spends follow", async () => {
  clock = nextDayAt(1);
  await user("baker");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('rolls', 'baker', 'Rolls', '<p>', 0, 0)");
  await run("INSERT INTO site_ai (site_slug, enabled, updated_at) VALUES ('rolls', 1, 0)");
  noteAppAiOutOfCredits("rolls", "baker", "Rolls");
  await afterwards();
  const sites = async () => (await sitesWithMessages("baker")).map((s) => ({ slug: s.slug, title: s.title, unread: s.unread, aiOutOfCredits: s.aiOutOfCredits }));
  assert.equal((await sites())[0].aiOutOfCredits, clock, "turning visitors away");
  clock += 3600_000;
  await give("baker", 2000, "stripe:pack:baker");
  assert.equal((await sites())[0].aiOutOfCredits, 0, "credits came since");
  // More spends than the activity list /api/me sends (20), with no visitor asking the AI meanwhile.
  for (let i = 0; i < 25; i++) {
    clock += 60_000;
    const held = await charge("baker", 10, "text request");
    await settle(held!, 5);
  }
  await afterwards();
  const activity = await recentActivity("baker");
  assert.ok(!activity.some((a) => a.amount > 0), "the purchase is out of the list");
  assert.equal(bellState({ credits: 1875, lowCredits: 100, activity }, await sites(), clock, 0, true).aiOut.length, 0);
});
