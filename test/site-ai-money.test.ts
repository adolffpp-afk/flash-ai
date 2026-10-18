import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { register } from "node:module";

/*
 * window.flashAI's money: one attempt per hold. A stand-in Claude counts every request it is sent
 * and can answer, fail with an error, or drop the connection.
 */
let mode: "answer" | "error" | "drop" = "answer";
let hits = 0;
let timeoutHeader = "";
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    hits++;
    timeoutHeader = String(req.headers["x-stainless-timeout"] ?? "");
    if (mode === "drop") return req.socket.destroy();
    if (mode === "error") return res.writeHead(500, { "Content-Type": "application/json" }).end('{"type":"error","error":{"type":"api_error","message":"nope"}}');
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        id: "m",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [{ type: "text", text: "Tuesday works best." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 400, output_tokens: 60 },
      }),
    );
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

// A stand-in Stripe: records what auto top-up would buy.
let stripeCalls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith("https://stripe.test/")) return realFetch(input, init);
  stripeCalls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
  return Response.json({ id: `pi_${stripeCalls.length}`, status: "succeeded" });
}) as typeof fetch;

register("./support/route-hooks.mjs", import.meta.url);
process.env.DATABASE_URL = ":memory:";
process.env.STRIPE_SECRET_KEY = "rk_test";
process.env.STRIPE_API_BASE = "https://stripe.test/v1";
process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const { run, one } = await import("../src/lib/server/db.ts");
const { askSiteAi, saveAiSettings, worstCaseCredits, ANSWER_TIMEOUT_MS } = await import("../src/lib/server/site-ai.ts");
const { maxDuration } = await import("../src/app/api/sites/[slug]/ai/route.ts");
const { maybeAutoTopUp } = await import("../src/lib/server/auto-topup.ts");
const { CREDIT_PACKS } = await import("../src/lib/credits.ts");
const { charge, spendable } = await import("../src/lib/server/credits.ts");

const balance = async (user = "owner") =>
  Number((await one<{ c: number }>("SELECT COALESCE(SUM(amount), 0) AS c FROM credit_ledger WHERE user_id = ?", [user]))?.c);
let ip = 0;
// A new address each time, so the per-visitor limit never gets in the way.
const ask = (prompt = "When should I book?", instructions = "", slug = "shop") => askSiteAi(slug, { prompt, instructions }, `10.0.${Math.floor(++ip / 250)}.${ip % 250}`);
// Asks until the app's AI stops answering, and returns how many answers it gave and its last refusal.
async function askUntilRefused(slug = "shop") {
  for (let answers = 0; answers < 500; answers++) {
    const answer = await ask(undefined, undefined, slug);
    if (answer.status !== 200) return { answers, refusal: answer };
  }
  throw new Error("never stopped");
}
const autoTopUpOn = (user: string, below: number) =>
  run(
    `INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES (?, 1, ?, ?, 'cus_1', 'pm_1', 0)
     ON CONFLICT (user_id) DO UPDATE SET enabled = 1, below = excluded.below, payment_method = excluded.payment_method`,
    [user, CREDIT_PACKS[0].id, below],
  );
const setBalance = async (user: string, credits: number) => {
  await run("DELETE FROM credit_ledger WHERE user_id = ?", [user]);
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, ?, 'test', 0)", [user, credits]);
};

test("set up an app with its AI on", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('owner', 'o@x.io', '', 0, 1)");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('shop', 'owner', 'Bakery', '<p>', 0, 0)");
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES ('owner', 500, 'test', 0)");
  await saveAiSettings("shop", true, 500);
  hits = 0;
  assert.equal((await ask()).status, 200);
  assert.equal(hits, 1);
});

test("a failed answer is asked for once: the hold pays for one call, never the two retries the client would add", async () => {
  for (const how of ["error", "drop"] as const) {
    const before = await balance();
    mode = how;
    hits = 0;
    const answer = await ask();
    mode = "answer";
    assert.equal(answer.status, 502, how);
    assert.equal(hits, 1, `${how}: Claude was asked once`);
    assert.equal(await balance(), before, `${how}: the owner pays nothing for a failed answer`);
  }
});

test("a dropped call may still have run: it is logged at the most it can cost, and the owner isn't charged", async () => {
  mode = "drop";
  await ask("Open on Sunday?");
  mode = "answer";
  const lost = await one<{ credits: number; cost_cents: number; ok: number }>("SELECT credits, cost_cents, ok FROM usage ORDER BY rowid DESC LIMIT 1");
  assert.equal(Number(lost?.credits), 0);
  assert.equal(Number(lost?.ok), 0);
  assert.ok(Number(lost?.cost_cents) > 0, "what Flash may have paid shows on the dashboard");
  // An error status means the call never ran: nothing is logged for it.
  const rows = Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM usage"))?.n);
  mode = "error";
  await ask();
  mode = "answer";
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM usage"))?.n), rows);
});

test("an answer gives up in time for the request to settle its hold", async () => {
  await ask();
  assert.equal(Number(timeoutHeader), ANSWER_TIMEOUT_MS / 1000, "the client's own 10 minutes aren't used");
  // The route stops at maxDuration; giving up 15 seconds before leaves time to put the hold back.
  assert.ok(ANSWER_TIMEOUT_MS <= maxDuration * 1000 - 15_000, `${ANSWER_TIMEOUT_MS} ms within ${maxDuration} s`);
  assert.ok(worstCaseCredits() > 0);
});

test("every paid Claude call that isn't streamed is sent once: a retry could cost more than its hold", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const files = (await readdir(new URL("../src/", import.meta.url), { recursive: true })).filter((f) => /\.tsx?$/.test(f));
  const calls: string[] = [];
  for (const file of files) {
    const text = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
    for (let at = text.indexOf("messages.create("); at !== -1; at = text.indexOf("messages.create(", at + 1)) {
      // The call's arguments, to its closing parenthesis.
      let depth = 0;
      let end = at + "messages.create".length;
      do {
        if (text[end] === "(") depth++;
        if (text[end] === ")") depth--;
        end++;
      } while (depth > 0 && end < text.length);
      const args = text.slice(at, end);
      calls.push(file);
      assert.match(args, /maxRetries: 0/, `${file}: ${args.slice(0, 80)}…`);
    }
  }
  // site-ai, post-pack, and claude.ts's prompt and scene writers, router and picture check.
  assert.ok(calls.length >= 6, calls.join(", "));
});

test("with auto top-up on, the app's AI stops at its level, so a visitor never makes Flash buy the owner a pack", async () => {
  await saveAiSettings("shop", true, 5000);
  await setBalance("owner", 115);
  await autoTopUpOn("owner", 100);
  const { answers, refusal } = await askUntilRefused();
  assert.ok(answers > 0, "it answers while the balance is over the level");
  assert.equal(refusal.status, 402);
  assert.match((refusal.body as { error: string }).error, /out of credits/, "the usual out-of-credits answer");
  assert.ok((await balance()) >= 100, `${await balance()} credits left, never under the level`);
  // What /api/me and every chat reply run afterwards: nothing to buy.
  stripeCalls = [];
  assert.equal(await maybeAutoTopUp("owner"), false);
  assert.deepEqual(stripeCalls, [], "no payment was made");

  // With auto top-up off, it spends what there is, as before.
  await run("UPDATE auto_topups SET enabled = 0 WHERE user_id = 'owner'");
  assert.equal((await ask()).status, 200);
  assert.equal((await askUntilRefused()).refusal.status, 402);
  assert.ok((await balance()) < 100);
  // Nor does a level without a saved card hold anything back.
  await setBalance("owner", 115);
  await run("UPDATE auto_topups SET payment_method = NULL, enabled = 1 WHERE user_id = 'owner'");
  await askUntilRefused();
  assert.ok((await balance()) < 100, "a level without a card buys nothing, so it isn't kept");
});

test("keeping the level is checked in the same statement as the charge, and other spending is as before", async () => {
  await setBalance("owner", 106);
  await autoTopUpOn("owner", 100);
  assert.deepEqual(await spendable("owner", { keepTopUpLevel: true }), { largest: 6, total: 6, pool: null });
  assert.deepEqual(await spendable("owner"), { largest: 106, total: 106, pool: null }, "what the owner sees and spends themselves");
  const held = await Promise.all([1, 2, 3].map(() => charge("owner", 3, "visitor question", { keepTopUpLevel: true })));
  assert.equal(held.filter((id) => id !== null).length, 2, "two of three questions fit above the level");
  assert.equal(await balance(), 100);
  assert.notEqual(await charge("owner", 3, "the owner's own chat"), null, "the owner's own spending isn't held back");
  assert.equal(await balance(), 97);
});

test("a team member's app keeps the team owner's level on the shared pool, then spends the member's own credits", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('boss', 'b@x.io', '', 0, 1), ('member', 'm@x.io', '', 0, 1)");
  await run(
    `INSERT INTO subscriptions (id, user_id, plan, interval, status, amount_cents, anchor, paid_until, test, created_at, updated_at)
     VALUES ('sub-boss', 'boss', 'business', 'month', 'active', 100, 0, ?, 1, 0, 0)`,
    [Date.UTC(2100, 0, 1)],
  );
  await run("INSERT INTO teams (id, owner_id, created_at) VALUES ('t1', 'boss', 0)");
  await run("INSERT INTO team_members (user_id, team_id, joined_at) VALUES ('member', 't1', 0)");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('team-app', 'member', 'Team app', '<p>', 0, 0)");
  await saveAiSettings("team-app", true, 5000);
  await setBalance("boss", 115);
  await autoTopUpOn("boss", 100);
  await setBalance("member", 20);
  await autoTopUpOn("member", 100);
  await run("UPDATE auto_topups SET enabled = 0 WHERE user_id = 'member'");
  const { refusal } = await askUntilRefused("team-app");
  assert.equal(refusal.status, 402);
  assert.ok((await balance("boss")) >= 100, `the pool keeps the owner's level (${await balance("boss")})`);
  assert.ok((await balance("boss")) < 110, "and spends down to it");
  assert.ok((await balance("member")) < 20, "the member's own credits paid for the rest");
  stripeCalls = [];
  assert.equal(await maybeAutoTopUp("boss"), false);
  assert.deepEqual(stripeCalls, []);
});
