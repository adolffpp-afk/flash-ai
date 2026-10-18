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

// A stand-in Claude for an app's AI.
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
  if (url.pathname === "/v1/payment_intents") return Response.json({ id: `pi_${stripeCalls.length}`, status: "succeeded" });
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
  "- New builds and changes to your apps.",
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
  // Unconfirmed: no free models for them, so no free chats are promised.
  await user("new", { verified: false });
  await give("new", 40);
  await spend("new", 40);
  const [email] = to("new");
  assert.equal(email.subject, OUT);
  assert.ok(!email.text.includes("Free chats"), "verification is on (emails are), and this email isn't confirmed");
  assert.ok(email.text.includes("Still working:\n- Your published apps and websites stay online for visitors, with their pages, forms, sign-ins and shop orders.\n\nWaiting"));

  // With free pictures set up, pictures on the free models keep working, and only paid ones wait.
  assert.deepEqual(creditLists({ chats: 25, images: 3 }), {
    working: [
      "Your published apps and websites stay online for visitors, with their pages, forms, sign-ins and shop orders.",
      "Free chats and pictures on free models, up to 25 chats and 3 pictures a day.",
    ],
    waiting: ["New builds and changes to your apps.", "Chats on paid levels.", "Pictures on paid models, videos, music and voiceovers.", "The AI inside your apps answering visitors."],
  });
  assert.deepEqual(creditLists(null).working, ["Your published apps and websites stay online for visitors, with their pages, forms, sign-ins and shop orders."]);
  // A name is kept to one line and escaped.
  const odd = EMAILS.outOfCredits("https://flash.test/?credits=1&as=x", { name: "Jo <b>\r\nBcc: x@y.z" });
  assert.ok(odd.text.includes("Hi Jo <b> Bcc: x@y.z,\n\n"));
  assert.ok(odd.html.includes("Hi Jo &lt;b&gt; Bcc: x@y.z,"));
});
