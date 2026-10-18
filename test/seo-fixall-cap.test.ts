import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { register } from "node:module";
import { startStandIns, type ClaudeReply } from "./support/research-stand-ins.ts";

/*
 * Fix all in the search check (SEO) says "Up to N credits" before anything is sent: N is the hold the
 * chat route places for exactly the message Fix all sends, at the level picked, asked of the route itself
 * (quote, through fixAllHold), and the change it sends never holds or is charged more than N (maxCredits),
 * whatever the reply does: a long one, one a refusal fallback answered, one that's stopped. When N can't
 * be worked out, the panel says the usual price. Fix it says what it always said. Claude is a stand-in
 * (see support/research-stand-ins.ts) that counts each request by its length, so a price worked out from
 * any other words than the ones sent would differ.
 */
register("./support/route-hooks.mjs", import.meta.url);

const stand = await startStandIns();
after(() => stand.close());

process.env.DATABASE_URL = ":memory:";
process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.ANTHROPIC_BASE_URL = `${stand.origin}/anthropic`;
for (const name of ["GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "VERCEL_ENV", "FLASH_APP_URL", "CONNECTOR_KEYS", "SEARXNG_URL", "FRED_API_KEY"]) {
  delete process.env[name];
}
const logged: string[] = [];
for (const level of ["log", "error", "warn", "info"] as const) console[level] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));

const { afterwards } = await import("./support/next-server.mjs");
const { one, run: sql } = await import("../src/lib/server/db.ts");
const chatRoute = await import("../src/app/api/chat/route.ts");
const { chatRequestBody } = await import("../src/lib/chat-request.ts");
const { fixAllHold, fixPrice } = await import("../src/lib/seo-chat.ts");
const { fixForCopy } = await import("../src/lib/seo-fix.ts");
const { scanPage } = await import("../src/lib/seo-scan.ts");
const { evaluate, fixableIds } = await import("../src/lib/seo-rules.ts");
const { requestTurn } = await import("../src/lib/server/turns.ts");
const { requestStop } = await import("../src/lib/server/stops.ts");
const { english } = await import("../src/lib/i18n.ts");
const { TYPICAL_CREDITS } = await import("../src/lib/credits.ts");
type UIMessage = import("../src/lib/store.ts").UIMessage;

beforeEach(async () => {
  stand.reset();
  // Each request is counted by its length: more words, more tokens, a bigger hold.
  stand.state.claude.count = (body) => Math.ceil(JSON.stringify(body).length / 3);
  await sql("DELETE FROM rate_limits");
});

const ORIGIN = "http://localhost";
let made = 0;
async function account(credits: number) {
  const id = `fixall${made++}`;
  const token = `tok_${id}_${randomBytes(6).toString("hex")}`;
  await sql("INSERT INTO users (id, email, name, password_hash, preferences, created_at, last_free_grant, verified_at) VALUES (?, ?, '', 'x', '', 0, 0, 1)", [id, `${id}@example.com`]);
  await sql("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [createHash("sha256").update(token).digest("hex"), id, Date.now() + 3600_000]);
  const d = new Date();
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, 'test', ?, 0)", [id, credits, `free:${id}:${month}`]);
  await sql("INSERT INTO projects (id, user_id, name, messages, updated_at) VALUES (?, ?, 'Golden Crumb', '[]', 0)", [`proj_${id}`, id]);
  return { id, cookie: `flash_session=${token}`, projectId: `proj_${id}` };
}
type Who = Awaited<ReturnType<typeof account>>;
const balance = async (id: string) => Number((await one<{ b: number }>("SELECT COALESCE(SUM(amount), 0) AS b FROM credit_ledger WHERE user_id = ?", [id]))!.b);
const ledgerRows = async (id: string) => Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id = ?", [id]))!.n);

// The site as its chat built it: a weak page, with several things Fix all asks for.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head><body>
<h2>Golden Crumb</h2><img src="https://images.example/loaf.jpg"><a href="#">Menu</a>
<p>Sourdough, pastries and birthday cakes, baked every morning in Leeds.</p></body></html>`;
const CTX = { slug: "golden-crumb", appBase: "https://www.flash-app.dev", domains: [] };
const SITE = { title: "Golden Crumb", address: `${CTX.appBase}/p/${CTX.slug}` };
const FIXED = `${PAGE.replace("<title>Home</title>", "<title>Golden Crumb · Sourdough bakery in Leeds</title>")}`;

let ids = 0;
const id = () => `m${(ids++).toString(36)}${randomBytes(3).toString("hex")}`;
/** The chat that built the site: asked for it, and the reply with it. */
const builtChat = (): UIMessage[] => [
  { id: id(), role: "user", content: "Make a website for my bakery, Golden Crumb" },
  { id: id(), role: "assistant", content: "Here's your bakery site.", engine: "app", app: { title: "Golden Crumb", html: PAGE, kind: "app", slug: CTX.slug } },
];
/** Fix all's message, made as Flash.tsx's fixFor makes it for that chat's newest version. */
function fixAllMessage(): UIMessage {
  const ask = fixableIds(evaluate(scanPage(PAGE), CTX));
  const planned = fixForCopy(english, PAGE, CTX, ask, SITE);
  assert.ok(planned && planned.sent.length >= 2, "the page has several things to fix");
  return { id: id(), role: "user", content: planned.content, build: "app", picked: { label: "SEO", context: planned.context } };
}
/** The request Flash's chat page makes for message after earlier (see requestFor in Flash.tsx). */
const bodyFor = (who: Who, earlier: UIMessage[], message: UIMessage, level?: string) =>
  chatRequestBody(earlier, message, {
    choice: "auto",
    preferences: "",
    ...(level && { level }),
    models: {},
    confirmed: false,
    projectId: who.projectId,
    timeZone: "Europe/London",
    connectors: [],
    actions: [],
    replyId: id(),
    files: [],
  });

const post = (who: Who, body: object) =>
  chatRoute.POST(
    new Request(`${ORIGIN}/api/chat`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie: who.cookie }, body: JSON.stringify(body) }),
  );
/** fetch for fixAllHold, as the page's: the chat route itself, signed in as who. */
const pageFetch = (who: Who) => (async (url: string | URL | Request, init?: RequestInit) => {
  assert.equal(String(url), "/api/chat");
  return post(who, JSON.parse(String(init?.body)));
}) as typeof fetch;

type Event = { type: string; charge?: number; credits?: number; message?: string };
/**
 * Sends a chat request and reads it to its end. held: what the route held for it, read from the ledger
 * while Claude's reply waits (the reply is settled after it). onRoute runs once the reply has started.
 */
async function send(who: Who, body: object, reply: Omit<ClaudeReply, "hold"> = { blocks: [{ type: "text", text: "Done." }], stop: "end_turn" }, onRoute?: (e: Event) => Promise<void>) {
  let release = () => {};
  const hold = new Promise<void>((r) => (release = r));
  stand.state.claude.replies.push({ ...reply, hold });
  let held: number | null = null;
  let seen: Promise<void> = Promise.resolve();
  const res = await post(who, body);
  const events: Event[] = [];
  if (!res.ok || !res.body) {
    release();
    stand.state.claude.replies.length = 0;
    await afterwards();
    return { status: res.status, events, held, error: (await res.json()) as { error: string; code?: string; needed?: number } };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter((l) => l.trim())) {
      const e = JSON.parse(line) as Event;
      events.push(e);
      if (e.type === "route" && e.charge && held === null) {
        held = 0;
        seen = one<{ amount: number }>("SELECT amount FROM credit_ledger WHERE id = ?", [e.charge]).then(async (row) => {
          held = -Number(row!.amount);
          await onRoute?.(e);
          release();
        });
      }
    }
  }
  release();
  await seen;
  await afterwards();
  return { status: res.status, events, held, error: null };
}
/** What a request was finally charged: its ledger row once settled. */
const charged = async (chargeId: number) => -Number((await one<{ amount: number }>("SELECT amount FROM credit_ledger WHERE id = ?", [chargeId]))!.amount);
const chargeOf = (events: Event[]) => events.find((e) => e.type === "route")!.charge!;
const claudeCalls = () => stand.state.claude.sent.length;
const counted = () => stand.state.seen.filter((s) => s.service === "anthropic" && s.path.endsWith("/count_tokens"));

const LEVELS = ["auto", "sonic", "ascend", "vision", "ultra"];

test("Fix all's price is the hold the chat route places for the message it sends, at every level and balance", async () => {
  for (const level of LEVELS) {
    const earlier = builtChat();
    const message = fixAllMessage();
    // With plenty of credits: what the change needs at least, and the most it holds.
    const rich = await account(1_000_000);
    const quoted = await fixAllHold(bodyFor(rich, earlier, message, level), pageFetch(rich));
    assert.ok(quoted && quoted.credits >= quoted.needed && quoted.available === 1_000_000, `${level}: ${JSON.stringify(quoted)}`);
    // The price was worked out from the words Fix all sends.
    const words = JSON.stringify(counted().at(-1)!.body);
    assert.ok(words.includes("Flash's search check") && words.includes(message.content), `${level}: priced on other words`);

    // A balance above what it needs and under the most, and one under what it needs. Each is sent as Fix
    // all sends it (with its cap), and as the same message typed would go (without one), from its own
    // account, so each is priced and sent on the same balance.
    for (const credits of [1_000_000, quoted.needed + 7, quoted.needed - 1]) {
      for (const capped of [true, false]) {
        const who = await account(credits);
        const priced = await fixAllHold(bodyFor(who, earlier, message, level), pageFetch(who));
        assert.ok(priced, `${level} ${credits}: no price`);
        // Under what the level picked needs, the route answers on Auto's level when that fits (see the chat
        // route's price), and the price is that level's.
        if (credits >= quoted.needed) assert.equal(priced.needed, quoted.needed);
        // With a balance between, all of it, as a reply sent then would hold.
        if (credits === quoted.needed + 7) assert.equal(priced.credits, credits);
        const r = await send(who, bodyFor(who, earlier, { ...message, ...(capped && { cap: priced.credits }) }, level));
        if (credits < priced.needed) {
          assert.equal(r.status, 402, `${level} ${credits}: sent without the credits it needs`);
          assert.equal(await balance(who.id), credits);
          continue;
        }
        assert.equal(r.status, 200, `${level} ${credits} ${capped}: ${JSON.stringify(r.error)}`);
        assert.equal(r.held, priced.credits, `${level} ${credits} ${capped ? "capped" : "uncapped"}: held ${r.held}, said ${priced.credits}`);
        assert.ok((await charged(chargeOf(r.events))) <= priced.credits);
      }
    }
  }
});

test("a long reply, one a refusal fallback answered, never charges more than Fix all said", async () => {
  // Ascend's and Ultra's models have refusal fallbacks (see FALLBACKS in credits.ts), held for in full.
  for (const [level, asked, fallback] of [
    ["ascend", "claude-sonnet-5-5", "claude-sonnet-5"],
    ["ultra", "claude-fable-5-1", "claude-opus-5"],
  ]) {
    const who = await account(1_000_000);
    const earlier = builtChat();
    const message = fixAllMessage();
    const priced = (await fixAllHold(bodyFor(who, earlier, message, level), pageFetch(who)))!;
    // The declined attempt and the fallback both read a huge input and wrote to the limit, and the reply was cut there.
    const huge: Omit<ClaudeReply, "hold"> = {
      blocks: [{ type: "text", text: `Here it is.\n\n\`\`\`html\n${FIXED}\n` }],
      stop: "max_tokens",
      model: fallback,
      usage: {
        input_tokens: 900_000,
        output_tokens: 64_000,
        iterations: [
          { model: asked, input_tokens: 900_000, output_tokens: 64_000 },
          { model: fallback, input_tokens: 900_000, output_tokens: 64_000 },
        ],
      },
    };
    const r = await send(who, bodyFor(who, earlier, { ...message, cap: priced.credits }, level), huge);
    assert.equal(r.status, 200);
    assert.equal(r.held, priced.credits);
    const paid = await charged(chargeOf(r.events));
    // It cost Flash far more than was held, and the owner pays what was held, not a credit more.
    assert.equal(paid, priced.credits, `${level}: charged ${paid}, said ${priced.credits}`);
    assert.equal(r.events.find((e) => e.type === "cost")?.credits, paid);
    assert.equal(await balance(who.id), 1_000_000 - paid);
  }
});

test("more credits bought after the price was said don't raise the hold, and a reply stopped part way pays no more either", async () => {
  const earlier = builtChat();
  const message = fixAllMessage();
  const rich = await account(1_000_000);
  const most = (await fixAllHold(bodyFor(rich, earlier, message, "vision"), pageFetch(rich)))!;
  // Fewer credits than the most the change holds, and more than it needs: all of them are held.
  const who = await account(most.needed + 20);
  const priced = (await fixAllHold(bodyFor(who, earlier, message, "vision"), pageFetch(who)))!;
  assert.ok(priced.credits === most.needed + 20 && priced.credits < most.credits, JSON.stringify({ most, priced }));
  // A top-up between the panel and Send: the same change would now hold more, but Fix all's holds what it said.
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, 1000000, 'top-up', 0)", [who.id]);
  const uncapped = (await fixAllHold(bodyFor(who, earlier, message, "vision"), pageFetch(who)))!;
  assert.ok(uncapped.credits > priced.credits);
  const body = bodyFor(who, earlier, { ...message, cap: priced.credits }, "vision") as { replyId: string };
  const r = await send(
    who,
    body,
    { blocks: [{ type: "text", text: "Changing your page…" }], stop: "end_turn", usage: { input_tokens: 900_000, output_tokens: 64_000 } },
    // Stop is pressed while the reply is being written.
    async () => void (await requestStop(who.id, body.replyId)),
  );
  assert.equal(r.held, priced.credits);
  assert.ok((await charged(chargeOf(r.events))) <= priced.credits);
});

test("a change that now needs more than Fix all said isn't sent, and costs nothing", async () => {
  const who = await account(1_000_000);
  const earlier = builtChat();
  const message = fixAllMessage();
  const priced = (await fixAllHold(bodyFor(who, earlier, message, "vision"), pageFetch(who)))!;
  // Said less than it needs now (its chat or level changed since the panel worked it out).
  const calls = claudeCalls();
  const r = await send(who, bodyFor(who, earlier, { ...message, cap: priced.needed - 1 }, "vision"));
  assert.equal(r.status, 409);
  assert.equal(r.error?.code, "over_cap");
  assert.match(r.error!.error, new RegExp(`more than the ${(priced.needed - 1).toLocaleString("en-US")} credits`));
  assert.equal(claudeCalls(), calls, "Claude was asked for the reply");
  assert.equal(await balance(who.id), 1_000_000);
  assert.equal((await one<{ messages: string }>("SELECT messages FROM projects WHERE id = ?", [who.projectId]))!.messages, "[]");
  // A larger level than the one priced: its hold would be more, so it isn't sent either.
  const ultra = await send(who, bodyFor(who, earlier, { ...message, cap: priced.credits }, "ultra"));
  const ultraPrice = (await fixAllHold(bodyFor(who, earlier, message, "ultra"), pageFetch(who)))!;
  if (ultraPrice.needed > priced.credits) assert.equal(ultra.status, 409);
  else assert.ok(ultra.held! <= priced.credits);
  // Within it: sent, and held at most what was said.
  const ok = await send(who, bodyFor(who, earlier, { ...message, cap: priced.needed }, "vision"));
  assert.equal(ok.status, 200);
  assert.equal(ok.held, priced.needed);
});

test("working out the price runs nothing, charges nothing and saves nothing", async () => {
  const who = await account(500);
  const earlier = builtChat();
  const message = fixAllMessage();
  const rows = await ledgerRows(who.id);
  const priced = await fixAllHold(bodyFor(who, earlier, message), pageFetch(who));
  assert.ok(priced);
  assert.equal(claudeCalls(), 0, "a reply was asked for");
  assert.ok(counted().length >= 1);
  assert.equal(await ledgerRows(who.id), rows);
  assert.equal(await balance(who.id), 500);
  assert.equal((await one<{ messages: string }>("SELECT messages FROM projects WHERE id = ?", [who.projectId]))!.messages, "[]");
  // Only a change to an app or deck is priced this way: nothing else is read by a paid helper first.
  for (const body of [
    { ...bodyFor(who, earlier, { ...message, build: undefined }), quote: true },
    { ...bodyFor(who, earlier, message), engine: "text", quote: true },
    { ...bodyFor(who, earlier, message), engine: "auto", quote: true },
  ]) {
    assert.equal((await post(who, body)).status, 400);
  }
  assert.equal(claudeCalls(), 0);
  assert.equal(await ledgerRows(who.id), rows);
});

test("when the price can't be worked out, Fix all says the usual price instead of a number", async () => {
  const who = await account(50);
  const earlier = builtChat();
  const message = fixAllMessage();
  // Anthropic couldn't count the request: the route won't price it on a guess.
  stand.state.claude.countStatus = 400;
  const failed = await post(who, { ...bodyFor(who, earlier, message), quote: true });
  assert.equal(failed.status, 503);
  assert.equal(await fixAllHold(bodyFor(who, earlier, message), pageFetch(who)), null);
  stand.state.claude.countStatus = 0;
  // Offline, an answer that isn't a price, or no hold at all.
  const offline = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  assert.equal(await fixAllHold({}, offline), null);
  for (const answer of [{ error: "Flash is busy" }, { held: "345", needed: 200, available: 50 }, { held: 0, needed: 0, available: 50 }, { held: 2.5, needed: 1, available: 50 }]) {
    assert.equal(await fixAllHold({}, (async () => Response.json(answer)) as typeof fetch), null, JSON.stringify(answer));
  }
  // The panel then says what Fix it says: a typical change's price, and the balance when it's under that.
  const typical = TYPICAL_CREDITS.app!;
  assert.deepEqual(fixPrice(true, null, typical, 50), { kind: "typical", credits: typical, low: 50 });
  assert.deepEqual(fixPrice(true, null, typical, 5000), { kind: "typical", credits: typical });
  // While it's being worked out, it says so (and Send waits); once it is, the most.
  assert.deepEqual(fixPrice(true, undefined, typical, 50), { kind: "pending" });
  assert.deepEqual(fixPrice(true, { credits: 345, needed: 210, available: 5000 }, typical, 5000), { kind: "most", credits: 345 });
  assert.deepEqual(fixPrice(true, { credits: 210, needed: 210, available: 50 }, typical, 50), { kind: "most", credits: 210, short: 50 });
});

test("Fix it says what it always said: a typical change's price, whatever a hold would be", () => {
  const typical = TYPICAL_CREDITS.app!;
  for (const hold of [undefined, null, { credits: 345, needed: 210, available: 5000 }]) {
    assert.deepEqual(fixPrice(false, hold, typical, 5000), { kind: "typical", credits: typical });
    assert.deepEqual(fixPrice(false, hold, typical, 50), { kind: "typical", credits: typical, low: 50 });
  }
});

test("a Fix it message goes with no cap, and Fix all's keeps its cap on Retry and after a reload", async () => {
  const who = await account(1000);
  const earlier = builtChat();
  const message = fixAllMessage();
  assert.equal("maxCredits" in bodyFor(who, earlier, message), false);
  const body = bodyFor(who, earlier, { ...message, cap: 345 });
  assert.equal(body.maxCredits, 345);
  // The server saves it with the message, so Retry after a reload sends it again.
  assert.equal(requestTurn(body)?.user.cap, 345);
  for (const cap of [0, -5, 2.5, "345", Number.MAX_VALUE]) {
    assert.equal(requestTurn({ ...body, userMessage: { ...message, cap } })?.user.cap, undefined, String(cap));
  }
  // A cap that isn't a whole number of credits isn't one.
  const r = await send(who, { ...bodyFor(who, earlier, message, "vision"), maxCredits: 0.5 });
  assert.equal(r.status, 200);
});
