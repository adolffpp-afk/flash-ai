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
const { chatRequestBody, editedMessage } = await import("../src/lib/chat-request.ts");
const { canSend, fixAllHold, fixAllTerms, fixMessage, fixPrice, pricedAgain } = await import("../src/lib/seo-chat.ts");
const { fixForCopy } = await import("../src/lib/seo-fix.ts");
const { scanPage } = await import("../src/lib/seo-scan.ts");
const { evaluate, fixableIds } = await import("../src/lib/seo-rules.ts");
const { requestTurn } = await import("../src/lib/server/turns.ts");
const { requestStop } = await import("../src/lib/server/stops.ts");
const { english } = await import("../src/lib/i18n.ts");
const { TYPICAL_CREDITS } = await import("../src/lib/credits.ts");
const { readFileSync } = await import("node:fs");
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
// A published site is an app or a slide deck: Fix all's change is to whichever the chat built (its build).
type Kind = "app" | "slides";
const KINDS: Kind[] = ["app", "slides"];
/** The chat that built the site (or deck): asked for it, and the reply with it. */
const builtChat = (kind: Kind = "app"): UIMessage[] => [
  { id: id(), role: "user", content: kind === "app" ? "Make a website for my bakery, Golden Crumb" : "Make a slide deck for my bakery, Golden Crumb" },
  { id: id(), role: "assistant", content: kind === "app" ? "Here's your bakery site." : "Here's your deck.", engine: kind, app: { title: "Golden Crumb", html: PAGE, kind, slug: CTX.slug } },
];
/**
 * Fix all's message and the points it lists, made as Flash.tsx's fixFor makes them for that chat's newest
 * version (html), a change to what it is (kind: fixFor's build is that version's kind).
 */
function fixAllPlan(html = PAGE, kind: Kind = "app"): { message: UIMessage; sent: string[]; left: number } {
  const ask = fixableIds(evaluate(scanPage(html), CTX));
  const planned = fixForCopy(english, html, CTX, ask, SITE);
  assert.ok(planned && planned.sent.length >= 2, "the page has several things to fix");
  const message: UIMessage = { id: id(), role: "user", content: planned.content, build: kind, picked: { label: "SEO", context: planned.context } };
  return { message, sent: planned.sent, left: planned.left };
}
const fixAllMessage = (kind: Kind = "app") => fixAllPlan(PAGE, kind).message;
/**
 * Fix all's message as Send sends it, with the price its panel said: SeoView's send adds fixAllTerms to
 * the change, and Flash's sendFix makes the message with fixMessage (see the wiring test below).
 */
const sentAs = (message: UIMessage, hold: Parameters<typeof fixAllTerms>[1], all = true) => fixMessage(message, fixAllTerms(all, hold));
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

// account: the account a tab names (X-Flash-Account), as authedFetch sends it once a browser holds several.
const post = (who: Who & { account?: string }, body: object) =>
  chatRoute.POST(
    new Request(`${ORIGIN}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: who.cookie, ...(who.account && { "x-flash-account": who.account }) },
      body: JSON.stringify(body),
    }),
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
/** What the last reply Claude was asked for may write (max_tokens): less when the hold pays for less. */
const lastMaxTokens = () => Number(stand.state.claude.sent.at(-1)?.max_tokens);
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
        // With fewer than it needs, nothing would be held: the most is what it holds with enough credits,
        // never the least it needs.
        if (priced.available < priced.needed) assert.equal(priced.credits, quoted.credits, `${level} ${credits}: said ${priced.credits}`);
        const r = await send(who, bodyFor(who, earlier, capped ? sentAs(message, priced) : message, level));
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

test("more credits bought after the price was said don't raise what it holds: it isn't sent, and a reply stopped part way pays no more", async () => {
  // On a site and on a deck alike: a cap on either kind of change is kept.
  for (const kind of KINDS) {
    const earlier = builtChat(kind);
    const message = fixAllMessage(kind);
    const rich = await account(1_000_000);
    const most = (await fixAllHold(bodyFor(rich, earlier, message, "vision"), pageFetch(rich)))!;
    assert.ok(most, `${kind}: no price`);
    // Fewer credits than the most the change holds, and more than it needs: all of them are held.
    const who = await account(most.needed + 20);
    const priced = (await fixAllHold(bodyFor(who, earlier, message, "vision"), pageFetch(who)))!;
    assert.ok(priced.credits === most.needed + 20 && priced.credits < most.credits, `${kind}: ${JSON.stringify({ most, priced })}`);
    // A top-up between the panel and Send: the same change would now hold more than the panel said, so it
    // isn't sent, rather than run on the hold it said, which would cut it short with credits to spare.
    await sql("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, 1000000, 'top-up', 0)", [who.id]);
    const uncapped = (await fixAllHold(bodyFor(who, earlier, message, "vision"), pageFetch(who)))!;
    assert.ok(uncapped.credits > priced.credits);
    const calls = claudeCalls();
    const rows = await ledgerRows(who.id);
    const topped = await send(who, bodyFor(who, earlier, sentAs(message, priced), "vision"));
    assert.equal(topped.status, 409, `${kind}: held ${topped.held}, said ${priced.credits}`);
    assert.equal(topped.error?.code, "over_cap");
    assert.equal(claudeCalls(), calls, `${kind}: Claude was asked for the reply`);
    assert.equal(await ledgerRows(who.id), rows, `${kind}: something was held or charged`);
    // Fix all again says what it holds now, and that goes.
    const again = await send(who, bodyFor(who, earlier, sentAs(message, uncapped), "vision"));
    assert.equal(again.status, 200);
    assert.equal(again.held, uncapped.credits);
    // Stop is pressed while the reply is being written: it pays no more than was said either.
    const body = bodyFor(rich, earlier, sentAs(message, most), "vision") as { replyId: string };
    const r = await send(
      rich,
      body,
      { blocks: [{ type: "text", text: "Changing your page…" }], stop: "end_turn", usage: { input_tokens: 900_000, output_tokens: 64_000 } },
      async () => void (await requestStop(rich.id, body.replyId)),
    );
    assert.equal(r.held, most.credits);
    assert.ok((await charged(chargeOf(r.events))) <= most.credits);
  }
});

test("a change that would now hold more than Fix all said isn't sent and costs nothing, rather than run cut short", async () => {
  // On a site and on a deck alike.
  for (const kind of KINDS) {
    const who = await account(1_000_000);
    const earlier = builtChat(kind);
    const message = fixAllMessage(kind);
    const priced = (await fixAllHold(bodyFor(who, earlier, message, "vision"), pageFetch(who)))!;
    assert.ok(priced, `${kind}: no price`);
    // Sent at the level it was priced at, as it was priced: it runs on the hold it said, and may write as
    // much as the same message sent without a price.
    const plain = await send(who, bodyFor(who, earlier, message, "vision"));
    const room = lastMaxTokens();
    const ok = await send(who, bodyFor(who, earlier, sentAs(message, priced), "vision"));
    assert.equal(ok.status, 200);
    assert.equal(ok.held, priced.credits);
    assert.equal(ok.held, plain.held);
    assert.equal(lastMaxTokens(), room, "the reply may write less than the same message sent without a price");
    const chatNow = async () => (await one<{ messages: string }>("SELECT messages FROM projects WHERE id = ?", [who.projectId]))!.messages;
    const before = await chatNow();
    // Said less than it would hold now (its chat or level changed since the panel worked it out): less than
    // it needs, or between that and its hold. Neither runs on a hold cut down to what was said.
    for (const cap of [priced.needed - 1, priced.needed, priced.credits - 1]) {
      const calls = claudeCalls();
      const rows = await ledgerRows(who.id);
      const r = await send(who, bodyFor(who, earlier, sentAs(message, { ...priced, credits: cap }), "vision"));
      assert.equal(r.status, 409, `${kind} cap ${cap}: ${r.status}, held ${r.held}`);
      assert.equal(r.error?.code, "over_cap");
      assert.match(r.error!.error, new RegExp(`more than the ${cap.toLocaleString("en-US")} credits`));
      assert.equal(claudeCalls(), calls, "Claude was asked for the reply");
      assert.equal(await ledgerRows(who.id), rows, "something was held or charged");
    }
    // Priced on one level and sent on a dearer one, picked in the composer before Retry: not sent either.
    const ultraPrice = (await fixAllHold(bodyFor(who, earlier, message, "ultra"), pageFetch(who)))!;
    assert.ok(ultraPrice.credits > priced.credits && ultraPrice.needed <= priced.credits, JSON.stringify({ priced, ultraPrice }));
    const calls = claudeCalls();
    const ultra = await send(who, bodyFor(who, earlier, sentAs(message, priced), "ultra"));
    assert.equal(ultra.status, 409, `${kind}: held ${ultra.held}, said ${priced.credits}`);
    assert.equal(claudeCalls(), calls);
    // None of them was saved as a turn either.
    assert.equal(await chatNow(), before);
    assert.equal(await balance(who.id), 1_000_000 - (await charged(chargeOf(plain.events))) - (await charged(chargeOf(ok.events))));
  }
});

test("with too few credits, Fix all says what the change holds with enough, and Retry after a top-up runs on that, not on the least it needs", async () => {
  const earlier = builtChat();
  const message = fixAllMessage();
  const rich = await account(1_000_000);
  const full = (await fixAllHold(bodyFor(rich, earlier, message), pageFetch(rich)))!;
  const plain = await send(rich, bodyFor(rich, earlier, message));
  const room = lastMaxTokens();
  assert.equal(plain.held, full.credits);
  // Fewer credits than the change needs at all.
  const who = await account(full.needed - 1);
  const priced = (await fixAllHold(bodyFor(who, earlier, message), pageFetch(who)))!;
  assert.deepEqual(priced, { credits: full.credits, needed: full.needed, available: full.needed - 1 });
  assert.deepEqual(fixPrice(true, priced, TYPICAL_CREDITS.app!, full.needed - 1), { kind: "most", credits: full.credits, short: full.needed - 1 });
  // Sent anyway: there aren't the credits, so nothing goes and nothing is charged. The message keeps its cap.
  const short = await send(who, bodyFor(who, earlier, sentAs(message, priced)));
  assert.equal(short.status, 402);
  assert.equal(await balance(who.id), full.needed - 1);
  // A top-up, then Retry on that message (which sends its cap again): the change holds what was said and
  // may write as much as it would have with the credits from the start.
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, 1000000, 'top-up', 0)", [who.id]);
  const retry = sentAs(message, priced);
  assert.equal(retry.cap, full.credits);
  const r = await send(who, bodyFor(who, earlier, retry));
  assert.equal(r.status, 200, JSON.stringify(r.error));
  assert.equal(r.held, full.credits);
  assert.equal(lastMaxTokens(), room, "the reply may write only what the least it needs pays for");
  assert.ok((await charged(chargeOf(r.events))) <= full.credits);
});

test("Fix all's message is sent with the price its panel said, and only Fix all's: SeoView and Flash make it with the same helpers", async () => {
  const message = fixAllMessage();
  const hold = { credits: 345, needed: 210, available: 5000 };
  assert.deepEqual(fixAllTerms(true, hold), { all: true, cap: 345 });
  // When the price couldn't be worked out, Fix all goes as it does today, with no cap.
  assert.deepEqual(fixAllTerms(true, null), { all: true });
  // Fix it and Add it never carry one.
  assert.deepEqual(fixAllTerms(false, hold), {});
  assert.equal(fixMessage(message, fixAllTerms(false, hold)), message);
  assert.equal(fixMessage(message, fixAllTerms(true, null)), message);
  assert.equal(fixMessage(message, fixAllTerms(true, hold)).cap, 345);
  assert.equal(message.cap, undefined, "the message made for the chat isn't changed");
  // A top-up between the panel and Send: the message built only through the helpers isn't sent, as the
  // change would now hold more than was said. Without the cap it would go and hold all it could.
  const earlier = builtChat();
  const rich = await account(1_000_000);
  const most = (await fixAllHold(bodyFor(rich, earlier, message), pageFetch(rich)))!;
  const who = await account(most.needed + 3);
  const priced = (await fixAllHold(bodyFor(who, earlier, message), pageFetch(who)))!;
  assert.ok(priced.credits < most.credits);
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, 1000000, 'top-up', 0)", [who.id]);
  const rows = await ledgerRows(who.id);
  const r = await send(who, bodyFor(who, earlier, sentAs(message, priced)));
  assert.equal(r.status, 409, `held ${r.held}, said ${priced.credits}`);
  assert.equal(await ledgerRows(who.id), rows, "something was held or charged");
  // The components send through them: SeoView's Send adds fixAllTerms, and Flash's sendFix sends fixMessage.
  const src = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
  assert.match(src("components/SeoView.tsx"), /await onFix\(\s*\{[^}]*shown: plan\.sent,\s*\.\.\.fixAllTerms\(all, plan\.hold\),\s*\},\s*run\.signal,\s*\)/);
  assert.match(src("components/Flash.tsx"), /else await respond\(project, chat\.messages, fixMessage\(plan\.message, fix\)\);/);
  // And the price the panel says is asked for that same request: priced quotes the message fixFor made
  // from the server's copy of the chat, after that copy, through requestFor as respond sends it, and the
  // panel's list (planFix) and the list made again on Send (fixSite) are priced as they're made.
  const flash = src("components/Flash.tsx");
  const fn = (name: string) => {
    const start = flash.indexOf(`  async function ${name}(`);
    assert.ok(start >= 0, name);
    return flash.slice(start, flash.indexOf("\n  }\n", start));
  };
  assert.match(fn("priced"), /hold: await quote\(fix, messages, plan\.message\)/);
  // As the tab's account (authedFetch names it, see account-pin.ts).
  assert.match(fn("quote"), /return fixAllHold\(requestFor\(project, messages, message, \{ replyId: newId\(\) \}\), authedFetch\);/);
  assert.equal(flash.match(/\bfixAllHold\(/g)?.length, 1, "a price is asked for another way");
  for (const name of ["planFix", "fixSite", "sendFix"]) {
    assert.match(fn(name), /const chat = await chatToFix\(fix\.projectId\);[\s\S]*const plan = await fixFor\(fix, chat\.messages\);/, name);
  }
  for (const name of ["planFix", "fixSite"]) assert.match(fn(name), /priced\(fix, chat\.messages, plan\)/, name);
  assert.equal(flash.match(/\bpriced\(/g)?.length, 3, "a price is asked for something else");
  assert.match(fn("respond"), /const body = requestFor\(project, earlier, userMsg, \{ replyId: reply\.id, files: sent, confirmed, decided, connect \}\);/);
});

test("Fix all priced while Flash was still writing a reply in its chat is priced again on Send: said again when it would hold more, never sent to be refused", async () => {
  const who = await account(1_000_000);
  const earlier = builtChat();
  // "Make the header blue", asked in that chat, and Flash is still writing the answer, which adds a gallery
  // too. The search check is opened meanwhile (another tab, a reload, a phone) and Fix all is pressed.
  const ask: UIMessage = { id: id(), role: "user", content: "Make the header blue", build: "app" };
  const writing: UIMessage[] = [...earlier, ask, { id: id(), role: "assistant", content: "", pending: true }];
  const gallery = Array.from({ length: 40 }, (_, i) => `<figure><img src="https://images.example/bake-${i}.jpg" alt="Loaf number ${i} from this morning's bake, on the counter by the window"><figcaption>Fresh from the oven: sourdough, seeded rye and cinnamon knots, baked by hand before the shop opens at seven.</figcaption></figure>`).join("\n");
  const grown = PAGE.replace("<h2>", '<header style="background:#1d4ed8;color:#fff"><h2>').replace("</h2>", "</h2></header>").replace("</body>", `<section>${gallery}</section></body>`);
  const done: UIMessage[] = [...earlier, ask, { id: id(), role: "assistant", content: "Here's the blue header, with a gallery.", engine: "app", app: { title: "Golden Crumb", html: grown, kind: "app" } }];
  const before = fixAllPlan();
  const said = (await fixAllHold(bodyFor(who, writing, before.message, "vision"), pageFetch(who)))!;
  assert.ok(said);
  // The reply is done ("Send this when it's done"), and the points Fix all lists are the same.
  const now = fixAllPlan(grown);
  assert.deepEqual(now.sent, before.sent);
  const quoteNow = () => fixAllHold(bodyFor(who, done, now.message, "vision"), pageFetch(who));
  // Sent with the price said while the reply was being written, the chat would refuse it.
  const calls = claudeCalls();
  const rows = await ledgerRows(who.id);
  const stale = await send(who, bodyFor(who, done, sentAs(now.message, said), "vision"));
  assert.equal(stale.status, 409);
  assert.equal(stale.error?.code, "over_cap");
  assert.equal(claudeCalls(), calls);
  assert.equal(await ledgerRows(who.id), rows);
  // So Send prices it again on that chat first: the panel says what it holds now, and nothing is sent.
  const again = await pricedAgain(said.credits, now, quoteNow);
  assert.ok(again && again.hold.credits > said.credits, JSON.stringify({ said, again }));
  assert.deepEqual(again.sent, before.sent);
  assert.equal(again.left, now.left);
  // Send pressed again goes at that price, and holds it.
  assert.equal(await pricedAgain(again.hold.credits, now, quoteNow), null);
  const r = await send(who, bodyFor(who, done, sentAs(now.message, again.hold), "vision"));
  assert.equal(r.status, 200, JSON.stringify(r.error));
  assert.equal(r.held, again.hold.credits);
  // Credits bought between the panel and Send (which let the change hold more) are said again too.
  const low = await account(said.needed + 20);
  const lowPrice = (await fixAllHold(bodyFor(low, done, now.message, "vision"), pageFetch(low)))!;
  assert.equal(lowPrice.credits, said.needed + 20);
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, 1000000, 'top-up', 0)", [low.id]);
  const topped = await pricedAgain(lowPrice.credits, now, () => fixAllHold(bodyFor(low, done, now.message, "vision"), pageFetch(low)));
  assert.ok(topped && topped.hold.credits > lowPrice.credits);
  // With no price said (it couldn't be worked out) nothing is asked, and when it can't be worked out now,
  // it goes as the panel said: the chat route still refuses it, with nothing charged, if it holds more.
  assert.equal(await pricedAgain(undefined, now, () => assert.fail("priced without a price said")), null);
  assert.equal(await pricedAgain(said.credits, now, async () => null), null);
  // Flash's Send (fixSite) does this once the list would still go, before the chat opens, and the panel
  // says why it's asked again when the list is the same.
  const flash = readFileSync(new URL("../src/components/Flash.tsx", import.meta.url), "utf8");
  const start = flash.indexOf("  async function fixSite(");
  const fixSite = flash.slice(start, flash.indexOf("\n  }\n", start));
  assert.match(
    fixSite,
    /if \(fix\.shown && plan\.sent\.join\(\) !== fix\.shown\.join\(\)\) return priced\(fix, chat\.messages, plan\);\s*(\/\/[^\n]*\n\s*)*const dearer = await pricedAgain\(fix\.cap, plan, \(\) => quote\(fix, chat\.messages, plan\.message\)\);\s*if \(dearer\) return dearer;[\s\S]*closeApps\(\);/,
  );
  const seo = readFileSync(new URL("../src/components/SeoView.tsx", import.meta.url), "utf8");
  assert.match(seo, /setNote\(t\(answer\.sent\.join\(\) === plan\.sent\.join\(\) \? DEARER : CHANGED\)\);/);
});

test("working out the price runs nothing, charges nothing and saves nothing", async () => {
  const who = await account(500);
  const earlier = builtChat();
  const message = fixAllMessage();
  const rows = await ledgerRows(who.id);
  // A change to a site, and to a deck (Fix all on a published deck sends build "slides").
  for (const kind of KINDS) {
    const priced = await fixAllHold(bodyFor(who, builtChat(kind), fixAllMessage(kind)), pageFetch(who));
    assert.ok(priced, `${kind}: no price`);
  }
  assert.equal(claudeCalls(), 0, "a reply was asked for");
  assert.ok(counted().length >= 2);
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

test("Edit on Fix all's message drops its cap: the owner's own words are priced as any typed change, never refused as over it", async () => {
  const who = await account(1_000_000);
  const earlier = builtChat();
  const message = fixAllMessage();
  const priced = (await fixAllHold(bodyFor(who, earlier, message, "vision"), pageFetch(who)))!;
  const sent = sentAs(message, priced);
  // The owner edits it (it's the last message, so it has Edit) and pastes a lot more: the change now holds
  // more than Fix all said, which was for its own words.
  const longer = `${message.content}\n\n${"Our opening hours, menu and story, pasted in full. ".repeat(700)}`;
  const edited = editedMessage({ ...sent, voice: true }, longer);
  assert.equal(edited.cap, undefined);
  assert.equal(edited.voice, undefined, "typed words are answered as heard");
  assert.equal(edited.content, longer);
  assert.equal(edited.picked, message.picked, "the change still goes with what it's about");
  assert.equal(sent.cap, priced.credits, "the message on the chat isn't changed");
  const r = await send(who, bodyFor(who, earlier, edited, "vision"));
  assert.equal(r.status, 200, JSON.stringify(r.error));
  assert.ok(r.held! > priced.credits, `held ${r.held}, said ${priced.credits}`);
  // Kept, the cap would refuse the owner's own words.
  const kept = await send(who, bodyFor(who, earlier, { ...edited, cap: sent.cap }, "vision"));
  assert.equal(kept.status, 409);
  assert.equal(kept.error?.code, "over_cap");
  // Flash's Edit makes the message it sends only through editedMessage.
  const flash = readFileSync(new URL("../src/components/Flash.tsx", import.meta.url), "utf8");
  const start = flash.indexOf("  async function editLast(");
  assert.ok(start >= 0);
  const editLast = flash.slice(start, flash.indexOf("\n  }\n", start));
  assert.match(editLast, /const \{ pictureAbove: had, \.\.\.old \} = messages\[lastUser\];\s*(\/\/[^\n]*\n\s*)*let edited = editedMessage\(old, text\);/);
  assert.equal(editLast.match(/\bedited = /g)?.length, 2, "the edited message is made another way");
  assert.match(editLast, /edited = withPicture\(\{ \.\.\.edited, attachmentName: undefined \}, url\);/);
  assert.match(editLast, /await respond\(active, earlier, edited, false,/);
});

test("only a change to an app or slides takes a cap: on any other request it's ignored, so no paid helper runs for a request it would refuse", async () => {
  const who = await account(1_000_000);
  // The router is a helper Claude answers at once (not streamed): it reads a request on Auto the keyword
  // rules can't place, and the reply it decides pays for it.
  const helperCalls = () => stand.state.seen.filter((s) => s.service === "anthropic" && s.path.endsWith("/messages") && s.body.stream !== true).length;
  const usageRows = async () => Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM usage WHERE user_id = ?", [who.id]))!.n);
  const ask = { messages: [{ role: "user", content: "something for my bakery's opening day" }], projectId: who.projectId, timeZone: "Europe/London", maxCredits: 1 };
  // Marked as a change (build), too: it's one only with the app or slides engine picked, so a request on
  // Auto that says it's a build is still read by the router and isn't refused after it paid for that. And
  // the app engine picked without that mark (a new app, not Fix all's change) is answered as without a cap.
  for (const [engine, build] of [
    ["auto", false],
    ["text", false],
    ["auto", true],
    ["text", true],
    ["app", false],
  ] as const) {
    const helpers = helperCalls();
    const rows = await usageRows();
    const before = await balance(who.id);
    const r = await send(who, { ...ask, engine, ...(build && { build }) });
    assert.equal(r.status, 200, `${engine}${build ? " build" : ""}: ${JSON.stringify(r.error)}`);
    if (engine === "auto") assert.equal(helperCalls(), helpers + 1, "the router didn't read it");
    // What the router cost is in what the reply was charged, and logged with it.
    assert.ok((await balance(who.id)) < before);
    assert.ok((await usageRows()) > rows);
  }
  // A change to an app or to a deck with the same cap is refused before anything runs, and costs nothing.
  for (const kind of KINDS) {
    const helpers = helperCalls();
    const rows = await ledgerRows(who.id);
    const capped = await send(who, { ...bodyFor(who, builtChat(kind), fixAllMessage(kind)), maxCredits: 1 });
    assert.equal(capped.status, 409, `${kind}: held ${capped.held}`);
    assert.equal(capped.error?.code, "over_cap");
    assert.equal(capped.error?.needed, undefined, "the refusal says what the change needs");
    assert.equal(helperCalls(), helpers);
    assert.equal(await ledgerRows(who.id), rows);
  }
});

test("each person gets 120 prices an hour: then the route counts nothing more for them, and the panel says the usual price", async () => {
  const who = await account(1_000_000);
  const earlier = builtChat();
  const message = fixAllMessage();
  for (let i = 0; i < 120; i++) assert.ok(await fixAllHold(bodyFor(who, earlier, message), pageFetch(who)), `price ${i + 1}`);
  const counts = counted().length;
  const over = await post(who, { ...bodyFor(who, earlier, message), quote: true });
  assert.equal(over.status, 429);
  assert.equal(await fixAllHold(bodyFor(who, earlier, message), pageFetch(who)), null);
  assert.equal(counted().length, counts, "Anthropic was asked to count it");
  assert.deepEqual(fixPrice(true, null, TYPICAL_CREDITS.app!, 1_000_000), { kind: "typical", credits: TYPICAL_CREDITS.app! });
  assert.equal(claudeCalls(), 0);
  // Someone else still gets theirs.
  const other = await account(1_000_000);
  assert.ok(await fixAllHold(bodyFor(other, earlier, message), pageFetch(other)));
});

test("Fix all's price is said in a live region that's there from when its panel opens, even when the list comes with the price", () => {
  const seo = readFileSync(new URL("../src/components/SeoView.tsx", import.meta.url), "utf8");
  const panel = seo.slice(seo.indexOf("const panel = (key: string) =>"), seo.indexOf("const button = "));
  // What's shown only once the points are listed: from "{points && (" to the parenthesis that closes it.
  const start = panel.indexOf("{points && (") + "{points && ".length;
  let depth = 0;
  let end = start;
  for (; end < panel.length; end++) {
    if (panel[end] === "(") depth++;
    else if (panel[end] === ")" && --depth === 0) break;
  }
  const listed = panel.slice(start, end);
  assert.ok(listed.includes("points.sent.map"), "the list wasn't found");
  // Pressed before Fix all's count loaded (or after it failed), the list and the price come together: the
  // region holding the price is there already, saying it's being worked out, so the price is a change to it.
  assert.equal((panel.match(/<div role="status">/g) ?? []).length, 1);
  assert.ok(!listed.includes('role="status"'), "the price's live region comes and goes with the list");
  assert.match(panel, /key === "all" && !asking\.plan && !project\?\.error \? \{ kind: "pending" \}/);
});

/** A function's text in a component's source: from its line to the line that closes it. */
function fnIn(source: string, head: string): string {
  const start = source.indexOf(`  ${head}`);
  assert.ok(start >= 0, head);
  return source.slice(start, source.indexOf("\n  }\n", start));
}

test("Send to Flash waits while Fix all's price is being worked out, so Fix all never goes without the price its panel says", () => {
  const hold = { credits: 345, needed: 210, available: 5000 };
  const typical = TYPICAL_CREDITS.app!;
  // Sent while it's worked out, Fix all would go with no cap, and its second look would be skipped too.
  assert.deepEqual(fixAllTerms(true, undefined), { all: true });
  assert.equal(canSend(true, undefined), false);
  // Once it's worked out it goes with it, and when it couldn't be, as today (the panel says the usual price).
  assert.equal(canSend(true, hold), true);
  assert.equal(canSend(true, null), true);
  // Fix it and Add it have no price to wait for.
  for (const h of [undefined, null, hold]) assert.equal(canSend(false, h), true);
  // It waits exactly while the panel says "Working out the most this change can cost…".
  for (const all of [true, false]) {
    for (const h of [undefined, null, hold]) assert.equal(canSend(all, h), fixPrice(all, h, typical, 5000).kind !== "pending", `${all} ${JSON.stringify(h)}`);
  }
  // SeoView's Send asks it before anything goes, and its button is disabled by it.
  const seo = readFileSync(new URL("../src/components/SeoView.tsx", import.meta.url), "utf8");
  const send = fnIn(seo, "async function send() {");
  const waits = send.indexOf("if (!canSend(all, plan.hold)) return;");
  assert.ok(waits > send.indexOf('const all = asking.key === "all";') && waits < send.indexOf("setSending(true);") && waits < send.indexOf("await onFix("), "Send doesn't wait for the price");
  assert.match(seo, /onClick=\{send\}\s*disabled=\{!points \|\| !canSend\(key === "all", points\.hold\) \|\| !project\?\.id \|\| sending\}/);
});

test("Cancel, or another Fix pressed, while Send looks at Fix all's price again sends nothing, and what it found changes no panel", () => {
  const seo = readFileSync(new URL("../src/components/SeoView.tsx", import.meta.url), "utf8");
  // Send is tied to its panel: a new signal for each Send, handed to Flash with the change.
  const send = fnIn(seo, "async function send() {");
  const asked = send.indexOf("await onFix(");
  assert.match(send, /const run = new AbortController\(\);\s*going\.current = run;\s*setSending\(true\);/);
  assert.ok(send.indexOf("going.current = run;") < asked);
  assert.match(send, /await onFix\(\s*\{[^}]*\},\s*run\.signal,\s*\);/);
  // What Flash answers is read only while that Send is still wanted: nothing is set before it's checked.
  const after = send.slice(send.indexOf("run.signal,\n", asked));
  const check = after.indexOf("if (run.signal.aborted) return;");
  assert.ok(check > 0, "the answer is read for a panel that's gone");
  assert.doesNotMatch(after.slice(0, check), /\bset[A-Z]\w*\(|refocus\.current|going\.current/);
  assert.match(after.slice(check), /^if \(run\.signal\.aborted\) return;\s*going\.current = null;\s*setSending\(false\);/);
  // Cancel, and a panel opened for another point (or Fix all again), drop it first; so does the check going.
  const drop = fnIn(seo, "function dropSend() {");
  assert.match(drop, /going\.current\?\.abort\(\);\s*going\.current = null;\s*setSending\(false\);/);
  assert.match(fnIn(seo, "function close() {"), /\{\s*dropSend\(\);\s*setAsking\(null\);/);
  const ask = fnIn(seo, "function ask(key: string, ids: CheckId[], from: HTMLElement) {");
  assert.ok(ask.indexOf("dropSend();") > 0 && ask.indexOf("dropSend();") < ask.indexOf("setAsking("), "a new panel keeps the old one's Send");
  assert.match(seo, /useEffect\(\(\) => \(\) => going\.current\?\.abort\(\), \[\]\);/);
  // And Flash sends nothing for one dropped: after its last look (the price asked for again), before My
  // websites & apps closes and the change is lined up, with nothing awaited after the check.
  const flash = readFileSync(new URL("../src/components/Flash.tsx", import.meta.url), "utf8");
  const fixSite = fnIn(flash, "async function fixSite(fix: SiteFix, signal?: AbortSignal): Promise<FixPlan | null> {");
  const dropped = fixSite.indexOf("if (signal?.aborted) return null;");
  assert.ok(dropped > fixSite.lastIndexOf("await "), "Flash can still send it after the owner cancelled");
  assert.ok(dropped < fixSite.indexOf("closeApps();") && dropped < fixSite.indexOf("showChat(") && dropped < fixSite.indexOf("setPendingFix("));
  assert.match(flash, /onFix=\{fixSite\}/);
  const myApps = readFileSync(new URL("../src/components/MyApps.tsx", import.meta.url), "utf8");
  assert.match(myApps, /onFix=\{onFix\}/);
});

test("with two accounts in one browser, each tab's Fix all is priced, capped and charged as the account it names, never the default", async () => {
  const { createSession } = await import("../src/lib/server/auth.ts");
  const ana = await account(5_000);
  const ben = await account(1_000_000);
  const tokenOf = async (who: Who) => (await createSession(who.id, false)).split(";")[0].split("=")[1];
  const [anaToken, benToken] = [await tokenOf(ana), await tokenOf(ben)];
  // Ben's account is the browser's default; each tab names its own, as authedFetch does.
  const cookie = `flash_session=${benToken}; flash_accounts=1.${anaToken}.${benToken}`;
  const anaTab = { ...ana, cookie, account: ana.id };
  const benTab = { ...ben, cookie, account: ben.id };
  const earlier = builtChat();
  const message = fixAllMessage();
  const forAna = (await fixAllHold(bodyFor(ana, earlier, message), pageFetch(anaTab)))!;
  const forBen = (await fixAllHold(bodyFor(ben, earlier, message), pageFetch(benTab)))!;
  assert.equal(forAna.available, 5_000, "Ana's tab is priced on Ana's credits");
  assert.equal(forBen.available, 1_000_000, "and Ben's tab on his");
  // A price asked for naming no account (a bare fetch) gets nobody once the browser holds two: no price,
  // never the default account's.
  assert.equal(await fixAllHold(bodyFor(ana, earlier, message), pageFetch({ ...ana, cookie })), null);
  // Ana's tab sends it with her price as its cap: held from and charged to her, never more than it said,
  // and nothing of it reaches Ben's credits.
  const r = await send(anaTab, bodyFor(ana, earlier, sentAs(message, forAna)));
  assert.equal(r.status, 200);
  assert.equal(r.held, forAna.credits);
  const paid = await charged(chargeOf(r.events));
  assert.ok(paid > 0 && paid <= forAna.credits, `charged ${paid}, said ${forAna.credits}`);
  assert.equal(await balance(ana.id), 5_000 - paid);
  assert.equal(await balance(ben.id), 1_000_000);
  assert.equal(await ledgerRows(ben.id), 1);
});
