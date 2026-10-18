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

const { run, one } = await import("../src/lib/server/db.ts");
const { charge, settle } = await import("../src/lib/server/credits.ts");
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
type Sent = { to: string; subject: string; text: string; html: string };
const sent: Sent[] = [];
let down = false;
let gate: Promise<void> | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  assert.match(String(input), /^https:\/\/api\.resend\.com\//, "only Resend is called");
  if (gate) await gate;
  if (down) return new Response("unavailable", { status: 503 });
  const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string; html: string };
  sent.push({ to: body.to[0], subject: body.subject, text: body.text, html: body.html });
  return Response.json({ id: "email" });
}) as typeof fetch;
const errors: unknown[] = [];
console.error = (...args: unknown[]) => errors.push(args);
console.warn = () => {};

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
  return checkLowBalance(id, credits);
}
/** Uses up today's alert emails (EMAIL_BUDGET.alerts). */
const useUpAlertEmails = () =>
  run("INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count, reset_at = excluded.reset_at", [
    `email-alert:${new Date(clock).toISOString().slice(0, 10)}`,
    EMAIL_BUDGET.alerts,
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

  // A purchase and then one big spend, with no spend between to see the balance above: this spend
  // took it from the level to below it, so it's a new drop.
  clock += WEEK;
  await give("ana", 500, "stripe:pack:2");
  assert.equal(await spent("ana", 520), "sent");
  assert.equal(to("ana@x.co").length, 3);
});

test("no email while auto top-up is on and working; one when its last try failed or this month's are used up", async () => {
  await user("auto");
  await give("auto", 90);
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
  await give("monthly", 90);
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
  const outcomes = await Promise.all([checkLowBalance("twice", 60), checkLowBalance("twice", 60)]);
  assert.deepEqual(outcomes.sort(), ["alerted", "sent"]);
  assert.equal(to("twice@x.co").length, 1);
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
  assert.deepEqual(await alertEmailsToday(), { lowSent: 1, lowBudget: 1, lowWeekly: 1, lowFailed: 0, appAiSent: 0, appAiBudget: 0, appAiFailed: 0 });
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
  await useUpAlertEmails();
  assert.equal(await appAiAlert("shopkeeper", "Bakery"), "budget");
  assert.equal(await appAiAlert("shopkeeper", "Bakery"), "daily");
  assert.equal((await alertEmailsToday()).appAiBudget, 1);
  assert.equal(to("shopkeeper@x.co").length, 3);
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
