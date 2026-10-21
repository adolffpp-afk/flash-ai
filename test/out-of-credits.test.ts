/*
 * The out-of-credits email (low-balance.ts): once the balance is at or below 0, where nothing paid can
 * be held, the account holder is emailed once, in place of the low-credit email, with what still works
 * and what waits until they top up. Again only after credits came back. The same opt-out, share of the
 * day's emails, team pool and Credits link as the low-credit email, none while auto top-up can buy,
 * and never from a visitor's question to an app's AI.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for the AI provider an app's AI asks.
const claude = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
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
    );
  });
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
// A free chat model is set up (and no free pictures), so a confirmed account keeps its free daily chats.
process.env.GROQ_API_KEY = "gsk-fake";
delete process.env.CLOUDFLARE_API_TOKEN;
// fal.ai is set up, so pictures, videos, music and voice all run (see engineStatus in status.ts).
process.env.FAL_KEY = "fal-fake";
delete process.env.OPENAI_API_KEY;
delete process.env.ELEVENLABS_API_KEY;
delete process.env.FLASH_FREE_DAILY_CHATS;
delete process.env.FLASH_DEMO_EMAILS;
delete process.env.FLASH_STRIPE_TAX;

const { run, one } = await import("../src/lib/server/db.ts");
const { addPurchase, charge, ensureMonthlyCredits, refund, settle } = await import("../src/lib/server/credits.ts");
const { EMAIL_BUDGET, EMAILS, LOW_CREDITS_LINE, creditLists } = await import("../src/lib/server/email.ts");
const { alertEmailsToday, checkLowBalance, saveAlertSettings } = await import("../src/lib/server/low-balance.ts");
const { askSiteAi, saveAiSettings } = await import("../src/lib/server/site-ai.ts");
const { afterwards } = await import("./support/next-server.mjs");

const NOON = Date.UTC(2026, 9, 9, 12);
const DAY = 86_400_000;
let clock = NOON;
Date.now = () => clock;

// Resend's and Stripe's answers. declines: Stripe declines the card.
type Sent = { to: string; subject: string; text: string; html: string };
const sent: Sent[] = [];
const stripeCalls: string[] = [];
// Each payment's own id, as Stripe gives (an auto top-up's credits are kept by it, once).
let intents = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "127.0.0.1") return realFetch(input, init);
  if (url.host === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string; html: string };
    sent.push({ to: body.to[0], subject: body.subject, text: body.text, html: body.html });
    return Response.json({ id: "email" });
  }
  assert.equal(url.host, "api.stripe.com", "only Resend and Stripe are called");
  stripeCalls.push(url.pathname);
  if (url.pathname === "/v1/payment_intents") return Response.json({ id: `pi_${++intents}`, status: "succeeded" });
  return Response.json({});
}) as typeof fetch;
console.error = () => {};
console.warn = () => {};

const OUT = "Your Flash credits have run out: top up to keep your apps updating";
const LOW = "Your Flash credits are running low";
const to = (id: string) => sent.filter((e) => e.to === `${id}@x.co`);
const user = (id: string, { name = "", nickname = "", verified = true } = {}) =>
  run("INSERT INTO users (id, email, password_hash, name, nickname, verified_at, created_at) VALUES (?, ?, 'h', ?, ?, ?, 0)", [id, `${id}@x.co`, name, nickname, verified ? 1 : 0]);
const give = (id: string, credits: number, ref: string | null = null) =>
  run("INSERT INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, 'test', ?, ?)", [id, credits, ref, clock]);
const balance = async (id: string) => Number((await one<{ b: number }>("SELECT COALESCE(SUM(amount), 0) AS b FROM credit_ledger WHERE user_id = ?", [id]))?.b);
/** A paid spend of the account holder's own: held, settled, then what happens after the response. */
async function spend(id: string, credits: number) {
  const held = await charge(id, credits, "test");
  assert.ok(held, "the balance covers it");
  await settle(held, credits);
  await afterwards();
}
/** A paid request of the account holder's own that the balance doesn't cover. */
async function refused(id: string, credits = 120) {
  assert.equal(await charge(id, credits, "a build"), null);
  await afterwards();
}
const outState = (id: string) => one<{ out_at: number; out_retry_at: number }>("SELECT out_at, out_retry_at FROM credit_alerts WHERE user_id = ?", [id]);
const useUpAlertEmails = () =>
  run("INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count, reset_at = excluded.reset_at", [
    `email-alert:${new Date(clock).toISOString().slice(0, 10)}`,
    EMAIL_BUDGET.alerts,
    clock + DAY,
  ]);

// What a confirmed account with free chats set up reads, as text: every line, in order.
const STILL_WORKING = [
  "Still working:",
  "- Your published apps and websites stay online for visitors, with their pages, forms, sign-ins and shop orders.",
  "- Free chats on free models, up to 25 a day.",
].join("\n");
const WAITING = [
  "Waiting until you top up:",
  "- New builds, and changes Flash makes to your apps.",
  "- Chats on paid levels.",
  "- Pictures, videos, music and voiceovers.",
  "- The AI inside your apps answering visitors.",
].join("\n");
const OFF = "You get this because low-credit emails are on. To stop them, open Credits in Flash and untick “Email me when my credits run low”.";

test("a spend that leaves nothing emails once that the credits ran out, in place of the low-credit email: greeting, both lists, Credits, how to stop them", async () => {
  await user("ana", { name: "Ana Lima", nickname: "Ana" });
  await give("ana", 150);
  await spend("ana", 150);
  assert.equal(await balance("ana"), 0);
  const [email, ...more] = to("ana");
  assert.equal(more.length, 0, "one email, not the low-credit one as well");
  assert.equal(email.subject, OUT);
  assert.equal(
    email.text,
    [OUT, "Hi Ana,", "Your Flash account has run out of credits.", STILL_WORKING, WAITING, "Top up in Flash: https://flash.test/?credits=1&as=ana", OFF].join("\n\n"),
  );
  // The HTML says the same, line for line, with the button to Credits in this account.
  for (const line of email.text.split("\n").filter((l) => l && !l.startsWith("Top up in Flash:"))) {
    const words = line.replace(/^- /, "").replace(/&/g, "&amp;").replace(/'/g, "&#39;");
    assert.ok(email.html.includes(words), `the HTML has "${words}"`);
  }
  assert.match(email.html, /<a href="https:\/\/flash\.test\/\?credits=1&as=ana"[^>]*>Top up in Flash<\/a>/);
  assert.equal((email.html.match(/<li /g) ?? []).length, 6, "two lists: two lines and four");
  for (const part of [email.subject, email.text, email.html]) assert.ok(!/[—–]/.test(part), "no dashes for pauses");

  // More spends at nothing, and requests refused, send no more.
  await refused("ana");
  await refused("ana", 5);
  assert.equal(await checkLowBalance("ana"), "alerted");
  assert.equal(to("ana").length, 1);
  assert.deepEqual(
    { sent: (await alertEmailsToday()).outSent, low: (await alertEmailsToday()).lowSent },
    { sent: 1, low: 0 },
    "/admin counts it as an out-of-credits email",
  );
});

test("credits coming back re-arm it, whatever brings them (a purchase, a refund, the monthly credits), and the next time it runs out is emailed", async () => {
  // ana has 0 and was emailed. A pack bought: the next time it runs out is emailed again.
  assert.ok(await addPurchase("ana", "starter", "stripe:pack:ana1"));
  assert.equal((await outState("ana"))?.out_at, 0, "re-armed as the credits came in");
  const pack = await balance("ana");
  await spend("ana", pack - 3);
  assert.deepEqual(to("ana").map((e) => e.subject), [OUT, LOW], "3 left is low, not out: small requests still fit");
  await spend("ana", 3);
  assert.deepEqual(to("ana").map((e) => e.subject), [OUT, LOW, OUT]);

  // A refund of a failed request's credits, then spent again.
  clock += 60_000;
  await refund("ana", 20, "Refund: the picture failed");
  assert.equal((await outState("ana"))?.out_at, 0);
  await spend("ana", 20);
  assert.deepEqual(to("ana").map((e) => e.subject), [OUT, LOW, OUT, OUT]);

  // The free plan's monthly credits, at the start of the next month.
  clock = Date.UTC(2026, 10, 1, 12);
  await ensureMonthlyCredits("ana");
  assert.equal(await balance("ana"), 200);
  assert.equal((await outState("ana"))?.out_at, 0);
  await spend("ana", 200);
  assert.deepEqual(to("ana").map((e) => e.subject), [OUT, LOW, OUT, OUT, OUT], "straight from 200 to nothing: the out-of-credits email alone");
});

test("with no name, no greeting; above 0, however little, it isn't out", async () => {
  clock = NOON + 40 * DAY;
  await user("noname");
  await give("noname", 120);
  await spend("noname", 119);
  assert.deepEqual(to("noname").map((e) => e.subject), [LOW], "1 credit left still pays for something");
  assert.ok(!to("noname")[0].text.includes("Hi "));
  await refused("noname");
  assert.equal(to("noname").length, 1, "a request refused with credits left isn't out either");
  await spend("noname", 1);
  const email = to("noname")[1];
  assert.equal(email.subject, OUT);
  assert.ok(email.text.startsWith(`${OUT}\n\nYour Flash account has run out of credits.\n\n`), "no greeting without a name");
  assert.ok(!email.html.includes("Hi "));
});

test("a request refused at 0 sends it when no spend did: a refund that took the credits back, or an email the day's share held back", async () => {
  // A pack refunded: its credits are taken back, and no spend sees the balance at 0.
  await user("back");
  await give("back", 500, "stripe:pack:back1");
  await give("back", -500, "stripe-refund:ch_back:1");
  assert.equal(to("back").length, 0);
  await refused("back");
  assert.deepEqual(to("back").map((e) => e.subject), [OUT]);

  // The day's share used up: it waits for a later day, and the first refusal then sends it.
  await user("busy");
  await give("busy", 100);
  await useUpAlertEmails();
  await spend("busy", 100);
  assert.equal(to("busy").length, 0, "the day's share is used up");
  assert.equal((await alertEmailsToday()).outBudget, 1);
  assert.ok(Number((await outState("busy"))?.out_retry_at) > clock, "owed from the next day");
  await refused("busy");
  assert.equal(to("busy").length, 0, "not the same day");
  clock += DAY;
  await refused("busy");
  assert.deepEqual(to("busy").map((e) => e.subject), [OUT]);
  await refused("busy");
  assert.equal(to("busy").length, 1, "and once");
});

test("none while auto top-up can buy, nor with the emails turned off", async () => {
  await user("auto");
  await give("auto", 100);
  await run("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES ('auto', 1, 'starter', 100, 'cus', 'pm', 0)");
  stripeCalls.length = 0;
  await spend("auto", 100);
  assert.deepEqual(stripeCalls, ["/v1/payment_intents"], "auto top-up bought");
  assert.ok((await balance("auto")) > 0);
  assert.equal(to("auto").length, 0);
  // At 0 again within its gap between top-ups: it will buy on the next request, so still no email.
  await spend("auto", await balance("auto"));
  assert.equal(await checkLowBalance("auto"), "auto");
  assert.equal(to("auto").length, 0);

  await user("quiet");
  await saveAlertSettings("quiet", { enabled: false, below: 100 });
  await give("quiet", 50);
  await spend("quiet", 50);
  await refused("quiet");
  assert.equal(to("quiet").length, 0, "the same opt-out as the low-credit email");
});

test("a visitor's question refused for lack of credits never sends it; the owner's own refused request does", async () => {
  await user("shop", { name: "Sam" });
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('bakery', 'shop', 'Bakery', '<p>', 0, 0)");
  await saveAiSettings("bakery", true, 1000);
  // At 0 with no spend to see it (a refund took the credits back).
  await give("shop", 300, "stripe:pack:shop1");
  await give("shop", -300, "stripe-refund:ch_shop:1");
  // Visitors asking the app's AI: refused, and the owner hears of it by the app-AI email only.
  assert.equal((await askSiteAi("bakery", { prompt: "When should I book?" }, "203.0.113.9")).status, 402);
  await afterwards();
  assert.equal(await charge("shop", 5, 'AI in "Bakery"', { visitor: true, keepTopUpLevel: true }), null);
  await afterwards();
  assert.deepEqual(to("shop").map((e) => e.subject), ["The AI in Bakery is out of credits"]);
  assert.equal(await checkLowBalance("shop", { topUp: false, out: false }), "waiting", "a check that may not send it leaves it owed");
  assert.equal(to("shop").length, 1);
  // The owner's own request, refused.
  await refused("shop");
  assert.deepEqual(to("shop").map((e) => e.subject), ["The AI in Bakery is out of credits", OUT]);
  assert.ok(to("shop")[1].text.startsWith(`${OUT}\n\nHi Sam,\n\n`));
});

test("a team member's spend that empties the pool emails the pool's owner, with the button to Credits in the owner's account", async () => {
  await user("boss", { name: "Bo" });
  await user("member", { name: "Mia" });
  await run(
    `INSERT INTO subscriptions (id, user_id, plan, interval, status, amount_cents, anchor, paid_until, test, created_at, updated_at)
     VALUES ('sub_boss', 'boss', 'business', 'month', 'active', 10000, ?, ?, 1, ?, ?)`,
    [clock, clock + 30 * DAY, clock, clock],
  );
  await run("INSERT INTO teams (id, owner_id, created_at) VALUES ('team_boss', 'boss', 0)");
  await run("INSERT INTO team_members (team_id, user_id, joined_at) VALUES ('team_boss', 'member', 0)");
  await give("boss", 30);
  await spend("member", 30);
  assert.equal(await balance("boss"), 0, "the pool paid");
  assert.deepEqual(to("boss").map((e) => e.subject), [OUT]);
  assert.ok(to("boss")[0].text.startsWith(`${OUT}\n\nHi Bo,\n\n`));
  assert.ok(to("boss")[0].text.includes("Top up in Flash: https://flash.test/?credits=1&as=boss"));
  assert.equal(to("member").length, 0, "the member's own credits didn't run out");
});

test("the low-credit email: greeting, the approved line, the balance, then what works and what waits if they run out", async () => {
  await user("low", { nickname: "Lu" });
  await give("low", 150);
  await spend("low", 70);
  const [email] = to("low");
  assert.equal(email.subject, LOW);
  assert.equal(
    email.text,
    [LOW, "Hi Lu,", LOW_CREDITS_LINE, "You have 80 credits left.", "If they run out:", STILL_WORKING, WAITING, "Top up in Flash: https://flash.test/?credits=1&as=low", OFF].join("\n\n"),
  );
  for (const line of email.text.split("\n").filter((l) => l && !l.startsWith("Top up in Flash:"))) {
    const words = line.replace(/^- /, "").replace(/&/g, "&amp;").replace(/'/g, "&#39;");
    assert.ok(email.html.includes(words), `the HTML has "${words}"`);
  }
  for (const part of [email.subject, email.text, email.html]) assert.ok(!/[—–]/.test(part));
});

test("the lists follow what free models give: none for an email not confirmed yet, and free pictures when they are set up", async () => {
  // Unconfirmed: no free models for them, so no free chats are promised (in the low-credit email: an
  // email not confirmed yet is never told its credits ran out, see below).
  await user("new", { verified: false });
  await give("new", 150, "stripe:pack:new1");
  await spend("new", 70);
  const [email] = to("new");
  assert.equal(email.subject, LOW);
  assert.ok(!email.text.includes("Free chats"), "verification is on (emails are), and this email isn't confirmed");
  assert.ok(email.text.includes("Still working:\n- Your published apps and websites stay online for visitors, with their pages, forms, sign-ins and shop orders.\n\nWaiting"));

  // With free pictures set up, pictures on the free models keep working, and only paid ones wait.
  assert.deepEqual(creditLists({ chats: 25, images: 3 }), {
    working: [
      "Your published apps and websites stay online for visitors, with their pages, forms, sign-ins and shop orders.",
      "Free chats and pictures on free models, up to 25 chats and 3 pictures a day.",
    ],
    waiting: ["New builds, and changes Flash makes to your apps.", "Chats on paid levels.", "Pictures on paid models, videos, music and voiceovers.", "The AI inside your apps answering visitors."],
  });
  assert.deepEqual(creditLists(null).working, ["Your published apps and websites stay online for visitors, with their pages, forms, sign-ins and shop orders."]);
  // A name is kept to one line and escaped.
  const odd = EMAILS.outOfCredits("https://flash.test/?credits=1&as=x", { name: "Jo <b>\r\nBcc: x@y.z" });
  assert.ok(odd.text.includes("Hi Jo <b> Bcc: x@y.z,\n\n"));
  assert.ok(odd.html.includes("Hi Jo &lt;b&gt; Bcc: x@y.z,"));
});

// How many full low-credit checks (checkLowBalance's one read) the requests since the last reset cost.
const { db } = await import("../src/lib/server/db.ts");
const client = await db();
let fullChecks = 0;
const execute = client.execute.bind(client) as (...args: unknown[]) => unknown;
(client as { execute: unknown }).execute = (q: string | { sql: string }, ...rest: unknown[]) => {
  if ((typeof q === "string" ? q : q.sql).includes("AS auto_below")) fullChecks++;
  return execute(q, ...rest);
};
const alertPlaces = async () =>
  Number((await one<{ count: number }>("SELECT count FROM rate_limits WHERE key = ?", [`email-alert:${new Date(clock).toISOString().slice(0, 10)}`]))?.count ?? 0);

test("only credits that were there run out: an account that never had any, or whose email isn't confirmed, isn't told so, and takes none of the day's alert emails", async () => {
  clock = NOON + 100 * DAY;
  // Signed up with an address nobody confirmed (it may be someone else's): no free credits, so 0 from
  // the start. Its paid requests are refused, and nothing is emailed.
  await user("stranger", { verified: false });
  await refused("stranger", 8);
  await refused("stranger");
  // Confirmed, but no credits ever came in (no free credits on this server, say).
  await user("never");
  await refused("never");
  assert.deepEqual([to("stranger").length, to("never").length], [0, 0]);
  assert.equal(await alertPlaces(), 0, "none of the day's alert emails taken");
  // Not confirmed, with credits bought: at 0 it gets the low-credit email, as before, not this one.
  await user("unconfirmed", { verified: false });
  await give("unconfirmed", 40, "stripe:pack:unconfirmed1");
  await spend("unconfirmed", 40);
  await refused("unconfirmed");
  assert.deepEqual(to("unconfirmed").map((e) => e.subject), [LOW]);
});

test("a refusal at 0 looks no further when no email can be owed: emails turned off, or the out-of-credits email sent with a low one still owed", async () => {
  clock = NOON + 110 * DAY;
  await user("optout");
  await saveAlertSettings("optout", { enabled: false, below: 100 });
  await give("optout", 50);
  await spend("optout", 50);
  fullChecks = 0;
  for (let i = 0; i < 20; i++) await refused("optout");
  assert.equal(fullChecks, 0, "turned off: one read a refusal, as before");
  assert.equal(to("optout").length, 0);

  await user("noemail");
  await give("noemail", 50);
  const key = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    await spend("noemail", 50);
    fullChecks = 0;
    for (let i = 0; i < 5; i++) await refused("noemail");
    assert.equal(fullChecks, 0, "no emails on this server");
  } finally {
    process.env.RESEND_API_KEY = key;
  }

  // A low-credit email the day's share held back, then a spend the next day that leaves nothing: the
  // out-of-credits email goes in its place, and refusals after it don't look for the low one.
  await user("owed");
  await give("owed", 150);
  await useUpAlertEmails();
  await spend("owed", 70);
  assert.equal(to("owed").length, 0, "held back");
  clock += DAY;
  await spend("owed", 80);
  assert.deepEqual(to("owed").map((e) => e.subject), [OUT]);
  fullChecks = 0;
  for (let i = 0; i < 10; i++) await refused("owed");
  assert.equal(fullChecks, 0);
  assert.equal(to("owed").length, 1);
  // Credits back, still under the level: the next drop is emailed as before.
  await give("owed", 60, "stripe:pack:owed1");
  await spend("owed", 10);
  assert.deepEqual(to("owed").map((e) => e.subject), [OUT, LOW]);
});

test("a team member's own credits at 0 haven't run out while the team's pool has some: it pays for them first", async () => {
  clock = NOON + 120 * DAY;
  await user("boss2", { name: "Bea" });
  await user("mia", { name: "Mia" });
  await run(
    `INSERT INTO subscriptions (id, user_id, plan, interval, status, amount_cents, anchor, paid_until, test, created_at, updated_at)
     VALUES ('sub_boss2', 'boss2', 'business', 'month', 'active', 10000, ?, ?, 1, ?, ?)`,
    [clock, clock + 30 * DAY, clock, clock],
  );
  await run("INSERT INTO teams (id, owner_id, created_at) VALUES ('team_boss2', 'boss2', 0)");
  await run("INSERT INTO team_members (team_id, user_id, joined_at) VALUES ('team_boss2', 'mia', 0)");
  // Her own credits never came in, the pool has 100, and a build of 300 is refused.
  await give("boss2", 100);
  await refused("mia", 300);
  assert.equal(to("mia").length, 0);
  // Her own 50 spent on a request the pool's 10 didn't cover: her own are at 0, the pool still pays.
  await give("boss2", -90, "stripe-refund:ch_boss2:1");
  await give("mia", 50);
  await spend("mia", 50);
  assert.equal(await balance("mia"), 0);
  await refused("mia", 300);
  assert.ok(!to("mia").some((e) => e.subject === OUT), "the pool's 10 still pay for her small requests");
  assert.equal(to("boss2").length, 0);
  // The pool spent too: nothing she can spend from has credits, so both have run out.
  await spend("mia", 10);
  assert.deepEqual(to("boss2").map((e) => e.subject), [OUT]);
  await refused("mia", 300);
  assert.ok(to("mia").at(-1)?.text.startsWith(`${OUT}\n\nHi Mia,\n\n`));
  assert.ok(to("mia").at(-1)?.text.includes("Top up in Flash: https://flash.test/?credits=1&as=mia"));
});

/** A Business team whose pool (the owner's balance) its member spends from first. */
async function team(owner: string, member: string) {
  await user(owner);
  await user(member);
  await run(
    `INSERT INTO subscriptions (id, user_id, plan, interval, status, amount_cents, anchor, paid_until, test, created_at, updated_at)
     VALUES (?, ?, 'business', 'month', 'active', 10000, ?, ?, 1, ?, ?)`,
    [`sub_${owner}`, owner, clock, clock + 30 * DAY, clock, clock],
  );
  await run("INSERT INTO teams (id, owner_id, created_at) VALUES (?, ?, 0)", [`team_${owner}`, owner]);
  await run("INSERT INTO team_members (team_id, user_id, joined_at) VALUES (?, ?, 0)", [`team_${owner}`, member]);
}
const autoTopUp = (id: string, lastAt: number) =>
  run("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, last_at, updated_at) VALUES (?, 1, 'starter', 100, 'cus', 'pm', ?, 0)", [id, lastAt]);
const subjects = (id: string) => to(id).map((e) => e.subject);

test("a team member isn't told her credits ran out while the pool's auto top-up will buy a pack, as an account of its own isn't", async () => {
  clock = NOON + 130 * DAY;
  // The pool's auto top-up bought a minute ago: it buys again on a request from its gap's end on.
  await team("boss3", "max");
  await give("boss3", 50);
  await give("max", 30);
  await autoTopUp("boss3", clock - 60_000);
  stripeCalls.length = 0;
  await spend("max", 50);
  await spend("max", 30);
  await refused("max");
  assert.deepEqual(stripeCalls, [], "within the gap: nothing bought yet");
  assert.deepEqual(subjects("boss3"), [], "the pool's owner isn't told: auto top-up will buy");
  // Nor is she: her own 30, under her level, get the low-credit email, as when the pool has credits.
  assert.deepEqual(subjects("max"), [LOW]);
  clock += 11 * 60_000;
  await refused("max");
  assert.deepEqual(stripeCalls, ["/v1/payment_intents"], "her next request: the pool's auto top-up buys");
  assert.ok((await balance("boss3")) > 0);
  assert.deepEqual(subjects("max"), [LOW]);

  // Able to buy now: the pool's pack was refunded (no spend saw it at 0), and her own spend takes hers to 0.
  await team("boss4", "zoe");
  await give("boss4", 500, "stripe:pack:boss4");
  await give("boss4", -500, "stripe-refund:ch_boss4:1");
  await give("zoe", 40);
  await autoTopUp("boss4", 0);
  stripeCalls.length = 0;
  await spend("zoe", 40);
  assert.deepEqual(subjects("zoe"), [LOW], "not out: the pool's auto top-up can buy");
  await refused("zoe");
  assert.deepEqual(stripeCalls, ["/v1/payment_intents"], "and does, on her next request");
  assert.deepEqual(subjects("zoe"), [LOW]);
  // Once the pool's auto top-up can't buy (turned off), both at 0 have run out, and she is told.
  await run("UPDATE auto_topups SET enabled = 0 WHERE user_id = 'boss4'");
  await spend("zoe", await balance("boss4"));
  await refused("zoe");
  assert.deepEqual(subjects("boss4"), [OUT]);
  assert.deepEqual(subjects("zoe"), [LOW, OUT]);
});

test("a team member is told again the next time she runs out, once the pool's credits came back", async () => {
  clock = NOON + 140 * DAY;
  await team("boss5", "ivy");
  await give("ivy", 50);
  await give("boss5", 10);
  await spend("ivy", 10);
  await spend("ivy", 50);
  await refused("ivy");
  assert.deepEqual([subjects("boss5"), subjects("ivy")], [[OUT], [OUT]], "both ran out, and each is told once");
  // The owner buys a pack: the pool has credits again, she spends them all, and both have run out again.
  assert.ok(await addPurchase("boss5", "starter", "stripe:pack:boss5"));
  await spend("ivy", await balance("boss5"));
  assert.equal(await balance("ivy"), 0);
  await refused("ivy");
  await refused("ivy", 5);
  assert.deepEqual([subjects("boss5"), subjects("ivy")], [[OUT, OUT], [OUT, OUT]], "the second time too");
  // The owner moves to a plan without seats: the pool no longer pays for her, so its credits coming back
  // aren't hers. Her own are still at 0, and she was told: nothing more until credits of hers come in.
  await run("UPDATE subscriptions SET plan = 'pro' WHERE user_id = 'boss5'");
  assert.ok(await addPurchase("boss5", "starter", "stripe:pack:boss5:2"));
  await refused("ivy");
  assert.deepEqual(subjects("ivy"), [OUT, OUT]);
  assert.ok(Number((await outState("ivy"))?.out_at) > 0, "still told");
  // Nor while she has a team plan of her own (her own balance is her pool), with the owner's back on one.
  await run("UPDATE subscriptions SET plan = 'business' WHERE user_id = 'boss5'");
  await run(
    `INSERT INTO subscriptions (id, user_id, plan, interval, status, amount_cents, anchor, paid_until, test, created_at, updated_at)
     VALUES ('sub_ivy', 'ivy', 'agency', 'month', 'active', 30000, ?, ?, 1, ?, ?)`,
    [clock, clock + 30 * DAY, clock, clock],
  );
  assert.ok(await addPurchase("boss5", "starter", "stripe:pack:boss5:3"));
  assert.ok(Number((await outState("ivy"))?.out_at) > 0, "the owner's credits aren't hers");
});

test("a team member told her credits ran out isn't told again when the pool's auto top-up is turned on and off with no credits coming in", async () => {
  clock = NOON + 150 * DAY;
  await team("boss6", "kim");
  await give("boss6", 10);
  await give("kim", 20);
  await spend("kim", 10);
  // A long request of hers, held from her own credits, runs past the time a hold counts as coming back.
  const held = await charge("kim", 20, "test");
  assert.ok(held);
  clock += 16 * 60_000;
  await refused("kim");
  assert.deepEqual([subjects("boss6"), subjects("kim")], [[OUT], [OUT]], "both ran out, and each is told once");
  // The owner turns the pool's auto top-up on: within its gap it can buy but hasn't, so her request
  // settling finds her not out, though nothing came in.
  await autoTopUp("boss6", clock - 60_000);
  stripeCalls.length = 0;
  await settle(held!, 20);
  await afterwards();
  assert.deepEqual(stripeCalls, [], "within the gap: nothing bought");
  // Not out while the pool can buy: under her level, the low-credit email, as for any member then.
  assert.deepEqual(subjects("kim"), [OUT, LOW]);
  // Turned off again before it bought: both at 0, as when she was told.
  await run("UPDATE auto_topups SET enabled = 0 WHERE user_id = 'boss6'");
  await refused("kim");
  await refused("kim", 5);
  assert.deepEqual([subjects("boss6"), subjects("kim")], [[OUT], [OUT, LOW]], "no credits came in: not told again");
  assert.ok(Number((await outState("kim"))?.out_at) > 0, "still told");
  // Credits come into the pool, she spends them, and both are told the next time.
  assert.ok(await addPurchase("boss6", "starter", "stripe:pack:boss6"));
  await spend("kim", await balance("boss6"));
  await refused("kim");
  assert.deepEqual([subjects("boss6"), subjects("kim")], [[OUT, OUT], [OUT, LOW, OUT]]);
});

test("credits into the pool re-arm a member who was told when its owner wasn't (emails off), and the trigger reads the pool's balance once", async () => {
  clock = NOON + 160 * DAY;
  await team("boss7", "lea");
  await run("INSERT INTO credit_alerts (user_id, enabled) VALUES ('boss7', 0)");
  await give("boss7", 10);
  await give("lea", 20);
  await spend("lea", 10);
  await spend("lea", 20);
  await refused("lea");
  assert.deepEqual([subjects("boss7"), subjects("lea")], [[], [OUT]]);
  assert.equal(Number((await outState("boss7"))?.out_at), 0, "the owner, with emails off, has nothing to re-arm");
  assert.ok(await addPurchase("boss7", "starter", "stripe:pack:boss7"));
  assert.equal(Number((await outState("lea"))?.out_at), 0, "re-armed by the pool's credits");
  // The whole ledger is summed in one place, the trigger's WHEN, so never twice for one row.
  const made = await one<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'credit_alerts_out_rearm'");
  assert.equal(made?.sql.match(/SUM\(/g)?.length, 1);
});

test("emails turned off with a low-credit email still owed: refusals at 0 look no further for it", async () => {
  clock = NOON + 150 * DAY;
  await user("owedoff");
  await give("owedoff", 150);
  // Held back for the day's share: owed from the next day on.
  await useUpAlertEmails();
  await spend("owedoff", 70);
  assert.ok(Number((await one<{ retry_at: number }>("SELECT retry_at FROM credit_alerts WHERE user_id = 'owedoff'"))?.retry_at) > clock);
  await saveAlertSettings("owedoff", { enabled: false, below: 100 });
  await spend("owedoff", 80);
  clock += 2 * DAY;
  fullChecks = 0;
  for (let i = 0; i < 20; i++) await refused("owedoff");
  assert.equal(fullChecks, 0, "one read a refusal, as with nothing owed");
  assert.equal(to("owedoff").length, 0);
});

test("the lists name only what the server has set up: what isn't says it's coming soon, credits or not", async () => {
  clock = NOON + 160 * DAY;
  // Pictures from OpenAI only: no video, music or voice (each needs fal.ai or ElevenLabs).
  delete process.env.FAL_KEY;
  process.env.OPENAI_API_KEY = "sk-fake";
  try {
    await user("solo-pics", { name: "Pia" });
    await give("solo-pics", 150);
    await spend("solo-pics", 70);
    await spend("solo-pics", 80);
    const [low, out] = to("solo-pics");
    assert.deepEqual([low.subject, out.subject], [LOW, OUT]);
    for (const email of [low, out]) {
      assert.ok(email.text.includes(`Waiting until you top up:\n- New builds, and changes Flash makes to your apps.\n- Chats on paid levels.\n- Pictures.\n- The AI inside your apps answering visitors.\n\n`));
      assert.ok(!/videos|music|voiceovers/.test(email.text + email.html));
      assert.ok(email.html.includes(">Pictures.</li>"));
    }
  } finally {
    delete process.env.OPENAI_API_KEY;
    process.env.FAL_KEY = "fal-fake";
  }
  // Free pictures set up (Cloudflare) on a server with no picture model: they never run, so they aren't
  // promised; with one, they are, and only paid ones wait.
  const freeLanes = { chats: 25, images: 3 };
  const noPictures = { app: true, text: true, image: false, video: false, music: true, voice: true };
  assert.deepEqual(creditLists(freeLanes, noPictures), {
    working: ["Your published apps and websites stay online for visitors, with their pages, forms, sign-ins and shop orders.", "Free chats on free models, up to 25 a day."],
    waiting: ["New builds, and changes Flash makes to your apps.", "Chats on paid levels.", "Music and voiceovers.", "The AI inside your apps answering visitors."],
  });
  assert.deepEqual(creditLists(freeLanes, { ...noPictures, image: true, video: true }).waiting[2], "Pictures on paid models, videos, music and voiceovers.");
  assert.deepEqual(creditLists(freeLanes, { ...noPictures, image: true }).waiting[2], "Pictures on paid models, music and voiceovers.");
  // With no paid tool for pictures, video, music or voice, that line is left out; without the chat model, free chats and what needs it too.
  const none = { app: false, text: false, image: false, video: false, music: false, voice: false };
  assert.deepEqual(creditLists(freeLanes, none), { working: ["Your published apps and websites stay online for visitors, with their pages, forms, sign-ins and shop orders."], waiting: [] });
  const bare = EMAILS.outOfCredits("https://flash.test/?credits=1&as=x", { free: freeLanes, live: none });
  assert.ok(!bare.text.includes("Waiting until you top up:") && !bare.html.includes("Waiting until you top up:"), "no empty list");
});
