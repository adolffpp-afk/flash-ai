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

register("./support/route-hooks.mjs", import.meta.url);
process.env.DATABASE_URL = ":memory:";
process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const { run, one } = await import("../src/lib/server/db.ts");
const { askSiteAi, saveAiSettings, worstCaseCredits, ANSWER_TIMEOUT_MS } = await import("../src/lib/server/site-ai.ts");
const { maxDuration } = await import("../src/app/api/sites/[slug]/ai/route.ts");

const balance = async (user = "owner") =>
  Number((await one<{ c: number }>("SELECT COALESCE(SUM(amount), 0) AS c FROM credit_ledger WHERE user_id = ?", [user]))?.c);
let ip = 0;
// A new address each time, so the per-visitor limit never gets in the way.
const ask = (prompt = "When should I book?", instructions = "") => askSiteAi("shop", { prompt, instructions }, `10.0.0.${++ip}`);

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
