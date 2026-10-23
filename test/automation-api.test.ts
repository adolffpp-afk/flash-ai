import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./support/route-hooks.mjs", import.meta.url);

/*
 * The automation routes (automation-api.ts), called as Next calls them, with Claude stood in for:
 * who may call them (signed in, admins only until /admin's switch, Flash's own page, a confirmed email), each
 * route's own rate limit, ownership, at most 25 on and 3 more often than daily, the price the user
 * saw (409 price_changed) on saving, editing, running and retrying, the receipt (a GET that writes
 * nothing, read, the downloaded copy checked), estimates counted once a day and priced at their most
 * when counting fails, Run now queued over the account's limit, delete by hand (foreign keys are
 * off), the /admin card, api/me's automationsEnabled, and that draining credits through automations
 * never makes opening Flash buy credits. Then PR 1b's: /admin's switch opening automations to everyone,
 * the estimate's schedule in words, the list's last run and run count, and Download receipts.
 */
const { claudeStandIn } = await import("./support/claude-stand-in.ts");
const claude = await claudeStandIn();
process.env.DATABASE_URL = ":memory:";
process.env.ANTHROPIC_BASE_URL = claude.url;
process.env.ANTHROPIC_API_KEY = "chat-key-for-tests";
process.env.ANTHROPIC_AUTOMATIONS_API_KEY = "automations-key-for-tests";
process.env.FLASH_ADMIN_EMAILS = ["boss", "chief", "origin", "fresh", "many", "often", "pricey", "edits", "reader", "counter", "estimator", "busy", "tidy", "card", "meboss", "drain", "lvcard", "lvraise", "lvsame", "lvback", "lvroom", "lvsettled", "lvoff", "lvback2", "lvother", "lvme", "lvfull", "lvchat", "lvagain", "lvday", "rvlimit", "rvfloor", "sd6", "sd8", "sd10", "opener", "lister", "lister2", "nexter"].map((n) => `${n}@example.com`).join(", ");
process.env.AUTOMATIONS_DEV = "1";
const SECRET = "c".repeat(40);
process.env.CRON_SECRET = SECRET;
process.env.FLASH_APP_URL = "http://flash.test";
process.env.STRIPE_SECRET_KEY = "rk_test";
process.env.STRIPE_API_BASE = "http://stripe.test/v1";
for (const name of ["VERCEL_ENV", "VERCEL", "RESEND_API_KEY", "FLASH_DEMO_EMAILS", "FRED_API_KEY", "AUTOMATION_MAX_PAID", "FLASH_STRIPE_TAX"]) delete process.env[name];
// Runs earlier tests leave going count against the paid runs Flash-wide at once (10 by default): room for them all.
process.env.AUTOMATION_MAX_PAID = "30";

// Stripe, stood in for: every call is kept, and a PaymentIntent succeeds. Everything else goes through.
const stripeCalls: string[] = [];
const realFetch = globalThis.fetch;
// Token counts this many from now on take a second each (Anthropic busy).
let slowCounts = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes("/count_tokens") && slowCounts > 0) {
    slowCounts--;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!url.startsWith("http://stripe.test/")) return realFetch(input, init);
  const path = new URL(url).pathname.replace("/v1", "");
  stripeCalls.push(path);
  if (path === "/customers") return Response.json({ id: "cus_new" });
  if (path === "/checkout/sessions") return Response.json({ url: "https://checkout.stripe.test/setup" });
  // The setup checkout a card was saved with, for cardUser (see saveCard).
  if (path.startsWith("/checkout/sessions/")) {
    return Response.json({ customer: "cus_new", metadata: { user: cardUser, auto_topup: "1" }, setup_intent: { payment_method: "pm_1", status: "succeeded" } });
  }
  return path === "/payment_intents" ? Response.json({ id: `pi_${stripeCalls.length}`, status: "succeeded" }) : Response.json({});
}) as typeof fetch;
let cardUser = "";

const { one, all, run: sql } = await import("../src/lib/server/db.ts");
const R = await import("../src/lib/server/automation-runner.ts");
const { localeOf } = await import("../src/lib/i18n.ts");
const F = await import("./support/automation-fixtures.ts");
const A = await import("../src/lib/automations.ts");
const { nextFire, nextFires } = await import("../src/lib/schedule.ts");
const API = await import("../src/lib/server/automation-api.ts");
const E = await import("../src/lib/server/automation-estimate.ts");
const { worstTokens } = await import("../src/lib/credits.ts");
const { draftMostCredits } = await import("../src/lib/server/automation-draft.ts");
const C = await import("../src/lib/server/credits.ts");
const TU = await import("../src/lib/server/auto-topup.ts");
const { automationLink } = await import("../src/lib/server/notifications.ts");
const { automationStats, cronHealth } = await import("../src/lib/server/automation-admin.ts");
const { adminStats } = await import("../src/lib/server/admin-stats.ts");
const S = await import("../src/lib/server/automations.ts");
const { userById } = S;
const listRoute = await import("../src/app/api/automations/route.ts");
const estimateRoute = await import("../src/app/api/automations/estimate/route.ts");
const oneRoute = await import("../src/app/api/automations/[id]/route.ts");
const runRoute = await import("../src/app/api/automations/[id]/run/route.ts");
const runsRoute = await import("../src/app/api/automations/[id]/runs/route.ts");
const receiptRoute = await import("../src/app/api/automations/runs/[runId]/route.ts");
const chatRoute = await import("../src/app/api/automations/runs/[runId]/chat/route.ts");
const draftRoute = await import("../src/app/api/automations/draft/route.ts");
const noticesRoute = await import("../src/app/api/notifications/route.ts");
const adminRoute = await import("../src/app/api/admin/automations/route.ts");
const meRoute = await import("../src/app/api/me/route.ts");
const { afterwards } = (await import("./support/next-server.mjs")) as unknown as { afterwards: () => Promise<unknown> };
type Spec = import("../src/lib/automations.ts").Spec;
type Estimate = import("../src/lib/server/automation-estimate.ts").Estimate;

after(() => claude.close());
beforeEach(() => {
  claude.state.replies = [];
  claude.state.count = { tokens: 1200, status: 0 };
  E.forgetCounts();
});

const BASE = "http://flash.test";
/** A request as the browser sends it: writes as JSON from Flash's own page unless told otherwise. */
function req(path: string, o: { cookie?: string; method?: string; json?: unknown; origin?: string | null; type?: string } = {}) {
  const method = o.method ?? (o.json !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = {};
  if (o.cookie) headers.cookie = o.cookie;
  if (method !== "GET") {
    headers["content-type"] = o.type ?? "application/json";
    if (o.origin !== null) headers.origin = o.origin ?? BASE;
  }
  return new Request(BASE + path, { method, headers, body: method === "GET" ? undefined : JSON.stringify(o.json ?? {}) });
}
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const body = async (r: Response) => (await r.json()) as Record<string, unknown> & { estimate: Estimate; error: string; code?: string };
const changes = async () => Number((await one<{ n: number }>("SELECT total_changes() AS n"))!.n);
const count = async (table: string, where: string, args: unknown[]) => Number((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, args as never))!.n);
const counted = () => claude.state.seen.filter((s) => s.path.endsWith("/count_tokens")).length;

const DAILY: Spec = { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "daily", at: "08:00" } } };
const HOURLY: Spec = { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "hourly", every: 1, from: "08:00", to: "20:00" } } };
const ULTRA: Spec = { ...DAILY, steps: [{ id: "a1", do: "ai", mode: "write", level: "ultra", prompt: "Write one line about the weather." }, { id: "n1", do: "notify" }] };

/** An admin (their address is in FLASH_ADMIN_EMAILS) with credits. */
const admin = (name: string, credits = 500, o: { verified?: boolean } = {}) => F.account(name, credits, { email: `${name}@example.com`, ...o });
/** What a spec costs at most now, as the editor would show it. */
async function priceOf(cookie: string, spec: Spec, timeZone = "UTC") {
  const r = await estimateRoute.POST(req("/api/automations/estimate", { cookie, json: { spec, timeZone } }));
  assert.equal(r.status, 200);
  return (await body(r)).estimate;
}
/** Saves an automation at its price, as the editor does. */
async function create(cookie: string, spec: Spec, more: Record<string, unknown> = {}) {
  const worst = (await priceOf(cookie, spec)).worst;
  const r = await listRoute.POST(req("/api/automations", { cookie, json: { spec, name: "Morning note", timeZone: "UTC", seenMax: worst, ...more } }));
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  return ((await body(r)).automation as { id: string; quotedMax: number }).id;
}
/** Run once now at the price shown, and waits for the run this request moves on after answering. */
async function runOnce(cookie: string, id: string, seenMax: number) {
  const r = await runRoute.POST(req(`/api/automations/${id}/run`, { cookie, json: { requestId: `req_${Math.random().toString(36).slice(2, 12)}`, seenMax } }), ctx({ id }));
  await afterwards();
  return r;
}

test("who may call: 401 signed out, and until /admin's switch opens them 404 for everyone but an admin, on every automation route", async () => {
  const pat = await F.account("pat", 100, { admin: false });
  const boss = await admin("boss");
  assert.equal((await listRoute.GET(req("/api/automations"))).status, 401);
  assert.equal((await listRoute.POST(req("/api/automations", { json: { spec: DAILY } }))).status, 401);
  const aid = await F.automation({ userId: pat.id });
  const rid = await F.runRow({ automationId: aid, userId: pat.id });
  const asPat = [
    listRoute.GET(req("/api/automations", { cookie: pat.cookie })),
    listRoute.POST(req("/api/automations", { cookie: pat.cookie, json: { spec: DAILY, name: "x", timeZone: "UTC", seenMax: 1000 } })),
    estimateRoute.POST(req("/api/automations/estimate", { cookie: pat.cookie, json: { spec: DAILY } })),
    oneRoute.GET(req(`/api/automations/${aid}`, { cookie: pat.cookie }), ctx({ id: aid })),
    oneRoute.PATCH(req(`/api/automations/${aid}`, { cookie: pat.cookie, method: "PATCH", json: { status: "paused" } }), ctx({ id: aid })),
    oneRoute.DELETE(req(`/api/automations/${aid}`, { cookie: pat.cookie, method: "DELETE", json: {} }), ctx({ id: aid })),
    runRoute.POST(req(`/api/automations/${aid}/run`, { cookie: pat.cookie, json: { requestId: "abcdefgh12", seenMax: 1000 } }), ctx({ id: aid })),
    runsRoute.GET(req(`/api/automations/${aid}/runs`, { cookie: pat.cookie }), ctx({ id: aid })),
    receiptRoute.GET(req(`/api/automations/runs/${rid}`, { cookie: pat.cookie }), ctx({ runId: rid })),
    receiptRoute.POST(req(`/api/automations/runs/${rid}`, { cookie: pat.cookie, json: { action: "stop" } }), ctx({ runId: rid })),
    chatRoute.POST(req(`/api/automations/runs/${rid}/chat`, { cookie: pat.cookie, json: {} }), ctx({ runId: rid })),
    draftRoute.POST(req("/api/automations/draft", { cookie: pat.cookie, json: { text: "A daily note", timeZone: "UTC", acceptedCredits: 100 } })),
    noticesRoute.GET(req("/api/notifications", { cookie: pat.cookie })),
    adminRoute.GET(req("/api/admin/automations", { cookie: pat.cookie })),
    adminRoute.POST(req("/api/admin/automations", { cookie: pat.cookie, json: { action: "price" } })),
  ];
  assert.deepEqual((await Promise.all(asPat)).map((r) => r.status), Array(asPat.length).fill(404));
  assert.equal(await count("automations", "user_id = ?", [pat.id]), 1, "nothing was made, edited or deleted");
  assert.equal((await one<{ stop_requested: number }>("SELECT stop_requested FROM automation_runs WHERE id = ?", [rid]))!.stop_requested, 0);
  assert.equal(await count("projects", "user_id = ?", [pat.id]), 0, "no chat was opened");
  const list = await listRoute.GET(req("/api/automations", { cookie: boss.cookie }));
  assert.equal(list.status, 200);
  assert.deepEqual((await body(list)).automations, []);
  const card = await adminRoute.GET(req("/api/admin/automations", { cookie: boss.cookie }));
  assert.equal(card.status, 200);
  assert.deepEqual((await body(card)).setup, { server: true, key: "automations", missing: [], sharedPaid: 2, open: false });
});

test("writes come from Flash's own page as JSON, from an account with a confirmed email", async () => {
  const { cookie, id } = await admin("origin");
  const worst = (await priceOf(cookie, DAILY)).worst;
  const make = (o: { origin?: string | null; type?: string }) =>
    listRoute.POST(req("/api/automations", { cookie, json: { spec: DAILY, name: "Morning note", timeZone: "UTC", seenMax: worst }, ...o }));
  assert.equal((await make({ origin: "https://evil.example" })).status, 403);
  assert.equal((await make({ type: "text/plain" })).status, 403);
  assert.equal(await count("automations", "user_id = ?", [id]), 0, "nothing was saved");
  // An admin's address must be confirmed first: until then automations are closed to them (404 while
  // only admins may use them; the gate's own check answers 403 once they open to all).
  process.env.FLASH_DEMO_EMAILS = "true";
  try {
    const fresh = await admin("fresh", 100, { verified: false });
    const r = await listRoute.POST(req("/api/automations", { cookie: fresh.cookie, json: { spec: DAILY, name: "Morning note", timeZone: "UTC", seenMax: worst } }));
    assert.ok([403, 404].includes(r.status), String(r.status));
    assert.equal(await count("automations", "user_id = ?", [fresh.id]), 0);
  } finally {
    delete process.env.FLASH_DEMO_EMAILS;
  }
  assert.equal((await make({})).status, 201);
});

test("each route counts against its own limit, per account, and Run now per automation too (429, nothing done)", async () => {
  assert.deepEqual(API.LIMITS, {
    list: [300, 600_000],
    create: [30, 3_600_000],
    estimate: [300, 3_600_000],
    edit: [120, 600_000],
    runAutomation: [10, 3_600_000],
    runUser: [30, 3_600_000],
    read: [300, 600_000],
    act: [60, 600_000],
    stop: [300, 600_000],
    seen: [300, 600_000],
    admin: [60, 600_000],
    card: [300, 600_000],
    draft: [30, 3_600_000],
    chat: [30, 3_600_000],
  });
  const { cookie, id } = await admin("counter");
  const worst = (await priceOf(cookie, DAILY)).worst;
  const full = (key: string, n: number) => sql("INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count", [key, n, Date.now() + 600_000]);
  await full(`auto:create:${id}`, 30);
  const r = await listRoute.POST(req("/api/automations", { cookie, json: { spec: DAILY, name: "Morning note", timeZone: "UTC", seenMax: worst } }));
  assert.equal(r.status, 429);
  assert.equal(await count("automations", "user_id = ?", [id]), 0);
  assert.equal((await listRoute.GET(req("/api/automations", { cookie }))).status, 200, "listing has its own limit");
  const aid = await F.automation({ userId: id });
  await full(`auto:runAutomation:${id}:${aid}`, 10);
  const ran = await runRoute.POST(req(`/api/automations/${aid}/run`, { cookie, json: { requestId: "abcdefgh12", seenMax: 1000 } }), ctx({ id: aid }));
  assert.equal(ran.status, 429);
  assert.equal(await count("automation_runs", "automation_id = ?", [aid]), 0);
  await full(`auto:runUser:${id}`, 30);
  const other = await F.automation({ userId: id });
  assert.equal((await runRoute.POST(req(`/api/automations/${other}/run`, { cookie, json: { requestId: "abcdefgh13", seenMax: 1000 } }), ctx({ id: other }))).status, 429);
});

test("ownership: another account's automation and runs are not found, to read, edit, run, delete or act on", async () => {
  const boss = { id: "boss" };
  const chief = await admin("chief");
  const aid = await F.automation({ userId: boss.id, name: "Boss's own" });
  const rid = await F.runRow({ automationId: aid, userId: boss.id });
  const c = chief.cookie;
  const tries = [
    oneRoute.GET(req(`/api/automations/${aid}`, { cookie: c }), ctx({ id: aid })),
    oneRoute.PATCH(req(`/api/automations/${aid}`, { cookie: c, method: "PATCH", json: { status: "paused" } }), ctx({ id: aid })),
    oneRoute.DELETE(req(`/api/automations/${aid}`, { cookie: c, method: "DELETE", json: {} }), ctx({ id: aid })),
    runRoute.POST(req(`/api/automations/${aid}/run`, { cookie: c, json: { requestId: "abcdefgh14", seenMax: 1000 } }), ctx({ id: aid })),
    runsRoute.GET(req(`/api/automations/${aid}/runs`, { cookie: c }), ctx({ id: aid })),
    receiptRoute.GET(req(`/api/automations/runs/${rid}`, { cookie: c }), ctx({ runId: rid })),
    receiptRoute.POST(req(`/api/automations/runs/${rid}`, { cookie: c, json: { action: "stop" } }), ctx({ runId: rid })),
  ];
  assert.deepEqual((await Promise.all(tries)).map((r) => r.status), Array(tries.length).fill(404));
  const a = (await one<{ status: string }>("SELECT status FROM automations WHERE id = ?", [aid]))!;
  assert.equal(a.status, "on", "not paused or deleted");
  assert.equal(await count("automation_runs", "automation_id = ?", [aid]), 1, "no run was started");
  assert.equal((await one<{ stop_requested: number }>("SELECT stop_requested FROM automation_runs WHERE id = ?", [rid]))!.stop_requested, 0);
  const listed = (await body(await listRoute.GET(req("/api/automations", { cookie: c })))).automations as { id: string }[];
  assert.equal(listed.some((x) => x.id === aid), false);
  // Another account's notice can't be marked read either, by its id.
  const { notify } = await import("../src/lib/server/notifications.ts");
  assert.ok(await notify({ userId: boss.id, kind: "missed", phrase: A.NOTICES.missed, blanks: { name: "Boss's own" }, ref: "boss:own" }));
  const notice = (await one<{ id: string }>("SELECT id FROM notifications WHERE user_id = ? AND ref = 'boss:own'", [boss.id]))!.id;
  assert.equal((await noticesRoute.POST(req("/api/notifications", { cookie: c, json: { read: [notice] } }))).status, 200);
  assert.equal(Number((await one<{ read_at: number }>("SELECT read_at FROM notifications WHERE id = ?", [notice]))!.read_at), 0, "still unread");
});

test("at most 25 automations on, and at most 3 that run more often than once a day", async () => {
  const many = await admin("many");
  for (let i = 0; i < A.MAX_ON; i++) await F.automation({ userId: many.id });
  const worst = (await priceOf(many.cookie, DAILY)).worst;
  const r = await listRoute.POST(req("/api/automations", { cookie: many.cookie, json: { spec: DAILY, name: "One more", timeZone: "UTC", seenMax: worst } }));
  assert.equal(r.status, 409);
  assert.equal((await body(r)).error, `You have ${A.MAX_ON} automations on, the most for now.`);
  const draft = await listRoute.POST(req("/api/automations", { cookie: many.cookie, json: { spec: DAILY, name: "A draft", timeZone: "UTC", seenMax: worst, status: "draft" } }));
  assert.equal(draft.status, 201, "a draft isn't on");
  const often = await admin("often");
  for (let i = 0; i < A.MAX_SUB_DAILY; i++) await F.automation({ userId: often.id, spec: HOURLY });
  const hourly = await listRoute.POST(req("/api/automations", { cookie: often.cookie, json: { spec: HOURLY, name: "Hourly", timeZone: "UTC", seenMax: (await priceOf(often.cookie, HOURLY)).worst } }));
  assert.equal(hourly.status, 409);
  assert.equal((await body(hourly)).error, "At most 3 automations can run more often than once a day.");
  assert.equal(await count("automations", "user_id = ?", [often.id]), A.MAX_SUB_DAILY);
  await create(often.cookie, DAILY);
});

test("409 price_changed: saved, run and retried only at the price its owner saw, else nothing happens", async () => {
  const { cookie, id } = await admin("pricey");
  const est = await priceOf(cookie, DAILY);
  assert.ok(est.worst > 0);
  const save = (seenMax?: number) => listRoute.POST(req("/api/automations", { cookie, json: { spec: DAILY, name: "Morning note", timeZone: "UTC", seenMax } }));
  for (const seen of [undefined, est.worst - 1]) {
    const r = await save(seen);
    assert.equal(r.status, 409);
    const b = await body(r);
    assert.equal(b.code, "price_changed");
    assert.equal(b.error, "The price changed. Check the new price and try again.");
    assert.equal(b.estimate.worst, est.worst, "with the new price to show");
  }
  assert.equal(await count("automations", "user_id = ?", [id]), 0);
  const saved = await save(est.worst);
  assert.equal(saved.status, 201);
  assert.equal(((await body(saved)).automation as { quotedMax: number }).quotedMax, est.worst);
  // Run once now and Retry: the same.
  const manual = await create(cookie, F.WRITE_SPEC);
  const worst = (await priceOf(cookie, F.WRITE_SPEC)).worst;
  const low = await runOnce(cookie, manual, worst - 1);
  assert.equal(low.status, 409);
  assert.equal((await body(low)).code, "price_changed");
  assert.equal(await count("automation_runs", "automation_id = ?", [manual]), 0);
  const failed = await F.runRow({ automationId: manual, userId: id, status: "failed" });
  await sql("UPDATE automation_runs SET finished_at = ?, lease_until = 0 WHERE id = ?", [Date.now(), failed]);
  const retry = (seenMax?: number) => receiptRoute.POST(req(`/api/automations/runs/${failed}`, { cookie, json: { action: "retry", seenMax } }), ctx({ runId: failed }));
  assert.equal((await retry()).status, 409);
  assert.equal(await count("automation_runs", "automation_id = ?", [manual]), 1);
  claude.state.replies.push({ text: "Tried again." });
  const again = await retry(worst);
  await afterwards();
  assert.equal(again.status, 202);
  const retried = (await one<{ run_key: string; status: string }>("SELECT run_key, status FROM automation_runs WHERE automation_id = ? AND id <> ?", [manual, failed]))!;
  assert.deepEqual({ ...retried }, { run_key: `retry:${failed}`, status: "done" });
});

test("an edit that raises the price, or turns it on, needs seenMax; one that doesn't, doesn't", async () => {
  const { cookie } = await admin("edits");
  const aid = await create(cookie, DAILY);
  const patch = (json: Record<string, unknown>) => oneRoute.PATCH(req(`/api/automations/${aid}`, { cookie, method: "PATCH", json }), ctx({ id: aid }));
  const row = () => one<{ version: number; status: string; quoted_max: number; name: string }>("SELECT version, status, quoted_max, name FROM automations WHERE id = ?", [aid]);
  const was = (await row())!;
  assert.equal((await patch({ name: "Renamed" })).status, 200, "a new name doesn't change the price");
  assert.equal((await row())!.name, "Renamed");
  const dearer = await priceOf(cookie, ULTRA);
  assert.ok(dearer.worst > was.quoted_max, "Ultra costs more");
  const refused = await patch({ spec: ULTRA });
  assert.equal(refused.status, 409);
  assert.equal((await body(refused)).estimate.worst, dearer.worst);
  assert.equal((await row())!.version, was.version, "no new version");
  assert.equal(await count("automation_versions", "automation_id = ?", [aid]), 1);
  const ok = await patch({ spec: ULTRA, seenMax: dearer.worst });
  assert.equal(ok.status, 200);
  assert.deepEqual({ ...(await row())! }, { version: was.version + 1, status: "on", quoted_max: dearer.worst, name: "Renamed" });
  assert.equal((await patch({ status: "paused" })).status, 200);
  assert.equal((await row())!.status, "paused");
  const on = await patch({ status: "on" });
  assert.equal(on.status, 409, "turning it on shows the price first");
  assert.equal((await row())!.status, "paused");
  assert.equal((await patch({ status: "on", seenMax: dearer.worst })).status, 200);
  assert.equal((await row())!.status, "on");
});

test("the receipt: its GET writes nothing but its rate-limit row, read marks it seen, and a downloaded copy is checked", async () => {
  const { cookie, id } = await admin("reader");
  const aid = await create(cookie, F.WRITE_SPEC);
  claude.state.replies.push({ text: "Clear skies all day." });
  const started = await runOnce(cookie, aid, (await priceOf(cookie, F.WRITE_SPEC)).worst);
  assert.equal(started.status, 202);
  const runId = ((await body(started)).run as { id: string }).id;
  const runs = (await body(await runsRoute.GET(req(`/api/automations/${aid}/runs`, { cookie }), ctx({ id: aid })))).runs as { id: string; status: string; seen: boolean }[];
  assert.deepEqual(runs.map((r) => [r.id, r.status, r.seen]), [[runId, "done", false]]);
  const before = await changes();
  const got = await receiptRoute.GET(req(`/api/automations/runs/${runId}`, { cookie }), ctx({ runId }));
  assert.equal(got.status, 200);
  assert.equal((await changes()) - before, 1, "only the GET's own rate-limit row");
  const r = (await got.json()) as { run: { status: string; credits: number }; steps: { stepId: string; status: string; output: string }[]; holds: { settledAt: number }[]; fingerprint: string; receipt: unknown };
  assert.equal(r.run.status, "done");
  assert.deepEqual(r.steps.map((s) => [s.stepId, s.status]), [["a1", "done"], ["n1", "done"]]);
  assert.equal(r.steps[0].output, "Clear skies all day.");
  assert.ok(r.holds.length === 1 && r.holds[0].settledAt > 0, "its hold, settled");
  assert.match(r.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal((await one<{ seen_at: number }>("SELECT seen_at FROM automation_runs WHERE id = ?", [runId]))!.seen_at, 0, "not seen by a GET");
  const link = automationLink(aid, runId);
  assert.equal((await one<{ read_at: number }>("SELECT read_at FROM notifications WHERE user_id = ? AND link = ?", [id, link]))!.read_at, 0);
  // The download is the same receipt, as a file.
  const file = await receiptRoute.GET(req(`/api/automations/runs/${runId}?format=json`, { cookie }), ctx({ runId }));
  assert.match(file.headers.get("content-disposition") ?? "", /^attachment; filename="receipt-[A-Za-z0-9_-]+\.json"$/);
  const saved = (await file.json()) as typeof r;
  assert.equal(saved.fingerprint, r.fingerprint);
  // read marks the run seen, and its notice read.
  assert.equal((await receiptRoute.POST(req(`/api/automations/runs/${runId}`, { cookie, json: { action: "read" } }), ctx({ runId }))).status, 200);
  assert.ok(Number((await one<{ seen_at: number }>("SELECT seen_at FROM automation_runs WHERE id = ?", [runId]))!.seen_at) > 0);
  assert.ok(Number((await one<{ read_at: number }>("SELECT read_at FROM notifications WHERE user_id = ? AND link = ?", [id, link]))!.read_at) > 0);
  const check = async (receipt: unknown) =>
    ((await (await receiptRoute.POST(req(`/api/automations/runs/${runId}`, { cookie, json: { action: "check", receipt } }), ctx({ runId }))).json()) as { matches: boolean }).matches;
  assert.equal(await check(saved), true);
  const tampered = JSON.parse(JSON.stringify(saved)) as { receipt: { receipt: { credits: number } } };
  tampered.receipt.receipt.credits = 0;
  assert.equal(await check(tampered), false);
});

test("estimates: counted once a day for the same text, priced at the most the text can be when counting fails, and the route saves nothing", async () => {
  const { cookie, id } = await admin("estimator", 100);
  const u = (await userById(id))!;
  const auto = { name: "Morning note", time_zone: "UTC", where_json: "{}", language: "" };
  const now = Date.UTC(2026, 9, 18, 7, 0);
  const before = counted();
  const first = await E.estimateSpec(DAILY, u, auto, { now });
  const second = await E.estimateSpec(DAILY, u, auto, { now });
  assert.equal(counted() - before, 1, "the second asked no one");
  assert.deepEqual(second, first);
  assert.equal(first.counted, true);
  assert.equal(first.runs, 30, "a daily schedule runs 30 times in 30 days");
  assert.deepEqual(first.limits, { capRun: first.worst, capMonth: Math.max(first.worst, Math.ceil(first.typical * 30 * 1.5)) });
  E.forgetCounts();
  claude.state.count = { tokens: 1200, status: 500 };
  const failed = await E.estimateSpec(DAILY, u, auto, { now });
  assert.equal(failed.counted, false);
  const prompt = (DAILY.steps[0] as { prompt: string }).prompt;
  assert.ok(failed.steps[0].tokens > worstTokens(prompt.length) + 3000, "at least 3 tokens a character, and room for tools");
  assert.ok(failed.steps[0].tokens > first.steps[0].tokens && failed.worst >= first.worst, "priced at its most");
  // The route: an estimate saves nothing but its own rate-limit row.
  claude.state.count = { tokens: 1200, status: 0 };
  const wrote = await changes();
  assert.equal((await estimateRoute.POST(req("/api/automations/estimate", { cookie, json: { spec: DAILY } }))).status, 200);
  assert.equal((await changes()) - wrote, 1);
});

test("the most a run costs is each step's hold for one answer, never a refusal fallback's second, and a run usually costs far less", async () => {
  const { planHold, researchPlan } = await import("../src/lib/credits.ts");
  const { claudeChoice } = await import("../src/lib/engines/claude.ts");
  const { automationHold, levelScale } = await import("../src/lib/server/automation-price.ts");
  const u = (await userById((await admin("onehold", 100)).id))!;
  const auto = { name: "AI news", time_zone: "UTC", where_json: "{}", language: "" };
  const now = Date.UTC(2026, 9, 18, 7, 0);
  // "Every morning at 8, send me a short summary of today's AI news" (Research), and Write at Ultra:
  // both on models with a fallback, which chat holds for a second answer when the credits allow.
  const research: Spec = { ...DAILY, steps: [{ id: "a1", do: "ai", mode: "research", level: "ascend", prompt: "Send me a short summary of today's AI news." }, { id: "n1", do: "notify" }] };
  for (const [spec, engine, plan] of [
    [research, "search", researchPlan(false, false)],
    [ULTRA, "text", undefined],
  ] as const) {
    const est = await E.estimateSpec(spec, u, auto, { now });
    const step = spec.steps[0] as { level: "ascend" | "ultra" };
    const model = claudeChoice(engine, step.level).model;
    const tokens = est.steps[0].tokens;
    const scale = levelScale(engine, model, tokens);
    const both = planHold(engine, model, tokens, Infinity, scale, 0, plan);
    assert.equal(both.fallback, true, `${model} has a fallback`);
    assert.ok(est.worst < both.held, `${engine}: at most ${est.worst}, not the ${both.held} both answers would hold`);
    assert.equal(est.worst, automationHold(engine, model, tokens, Infinity, scale, plan).held);
    assert.equal(est.worst, planHold(engine, model, tokens, both.held - 1, scale, 0, plan).held, "the one answer's hold");
    assert.ok(est.typical > 0 && est.typical * 4 < est.worst, `${engine}: usually ${est.typical}, at most ${est.worst}`);
    // The least it holds to start is what it needs, held alike for one answer.
    assert.equal(est.least, automationHold(engine, model, tokens, 0, scale, plan).needed);
  }
});

test("an automation keeps what a run usually costs with the most it may, and shows it: saved, re-priced on an edit, kept on a rename", async () => {
  const { cookie, id } = await admin("usually");
  const row = () => one<{ quoted_max: number; quoted_typical: number }>("SELECT quoted_max, quoted_typical FROM automations WHERE user_id = ?", [id]);
  const est = await priceOf(cookie, DAILY);
  const saved = await listRoute.POST(req("/api/automations", { cookie, json: { spec: DAILY, name: "Morning note", timeZone: "UTC", seenMax: est.worst } }));
  assert.equal(saved.status, 201);
  const view = (await body(saved)).automation as { id: string; quotedMax: number; quotedTypical: number };
  assert.deepEqual([view.quotedMax, view.quotedTypical], [est.worst, est.typical]);
  assert.ok(est.typical > 0 && est.typical < est.worst);
  assert.deepEqual({ ...(await row())! }, { quoted_max: est.worst, quoted_typical: est.typical });
  const patch = (json: Record<string, unknown>) => oneRoute.PATCH(req(`/api/automations/${view.id}`, { cookie, method: "PATCH", json }), ctx({ id: view.id }));
  assert.equal((await patch({ name: "Renamed" })).status, 200);
  assert.deepEqual({ ...(await row())! }, { quoted_max: est.worst, quoted_typical: est.typical }, "a rename keeps both");
  const dearer = await priceOf(cookie, ULTRA);
  assert.equal((await patch({ spec: ULTRA, seenMax: dearer.worst })).status, 200);
  assert.deepEqual({ ...(await row())! }, { quoted_max: dearer.worst, quoted_typical: dearer.typical }, "a new spec, a new price");
  const listed = (await body(await listRoute.GET(req("/api/automations", { cookie })))).automations as { quotedTypical: number }[];
  assert.deepEqual(listed.map((a) => a.quotedTypical), [dearer.typical]);
  // One priced before this was kept says only the most.
  await sql("UPDATE automations SET quoted_typical = 0 WHERE user_id = ?", [id]);
  assert.equal(((await body(await listRoute.GET(req("/api/automations", { cookie })))).automations as { quotedTypical: number }[])[0].quotedTypical, 0);
});

test("a failed count says why, to admins only, and in the logs, never with a key", async () => {
  const auto = { name: "Morning note", time_zone: "UTC", where_json: "{}", language: "" };
  const now = Date.UTC(2026, 9, 18, 7, 0);
  const boss = (await userById((await admin("whyboss")).id))!;
  const member = (await userById((await F.account("whymember", 100, { admin: false })).id))!;
  claude.state.count = { tokens: 1200, status: 401 };
  const logged: string[] = [];
  const was = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    const seen = await E.estimateSpec(DAILY, boss, auto, { now });
    assert.equal(seen.counted, false);
    assert.deepEqual(seen.countProblem, { text: "401 api_error: scripted", kind: "key" }, "the status, the error's type, Anthropic's own words and what it means");
    E.forgetCounts();
    const hidden = await E.estimateSpec(DAILY, member, auto, { now });
    assert.equal(hidden.counted, false);
    assert.equal("countProblem" in hidden, false, "a member sees the price at its most, not why");
    assert.ok(logged.length >= 2 && logged.every((l) => l.includes("401 api_error: scripted")), logged.join("\n"));
  } finally {
    console.error = was;
  }
  // Counted again: nothing to say.
  claude.state.count = { tokens: 1200, status: 0 };
  E.forgetCounts();
  assert.equal("countProblem" in (await E.estimateSpec(DAILY, boss, auto, { now })), false);
  // A key in what was said never shows.
  assert.equal(S.anthropicProblem(new Error("bad key sk-ant-api03-abc_DEF-123 here")), "Error: bad key [key] here");
  assert.equal(S.anthropicProblem(new Error(`chat's ${process.env.ANTHROPIC_API_KEY} and ours ${process.env.ANTHROPIC_AUTOMATIONS_API_KEY}`)), "Error: chat's [key] and ours [key]");
  assert.equal(S.anthropicProblem("x".repeat(300)).length, 200, "200 characters at most");
  // Never reached: said as such, with why.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  assert.equal(S.anthropicProblem(new Anthropic.APIConnectionTimeoutError()), "timeout: Request timed out.");
  assert.equal(
    S.anthropicProblem(new Anthropic.APIConnectionError({ cause: new TypeError("Headers.append: invalid header value") })),
    "connection_error: Connection error. (Headers.append: invalid header value)",
  );
});

test("the automations key is used as pasted without spaces, line breaks or quotes around it", async () => {
  assert.equal(S.automationsKey({ ANTHROPIC_AUTOMATIONS_API_KEY: ' "sk-ant-api03-k1"\n' }), "sk-ant-api03-k1");
  assert.equal(S.automationsKey({ ANTHROPIC_AUTOMATIONS_API_KEY: "'sk-ant-api03-k1'" }), "sk-ant-api03-k1");
  assert.equal(S.automationsKey({ ANTHROPIC_AUTOMATIONS_API_KEY: " \n " }), "");
  assert.equal(S.automationsKey({}), "");
  const was = process.env.ANTHROPIC_AUTOMATIONS_API_KEY;
  process.env.ANTHROPIC_AUTOMATIONS_API_KEY = `  "${was}"\r\n`;
  try {
    assert.equal(S.keyInUse(), "automations");
    const from = claude.state.seen.length;
    const r = await estimateRoute.POST(req("/api/automations/estimate", { cookie: (await admin("pasted")).cookie, json: { spec: F.WRITE_SPEC, timeZone: "UTC" } }));
    assert.equal(r.status, 200);
    assert.equal((await body(r)).estimate.counted, true, "counted, not priced at its most");
    const sent = claude.state.seen.slice(from).filter((s) => s.path.endsWith("/count_tokens"));
    assert.ok(sent.length > 0 && sent.every((s) => s.headers["x-api-key"] === was), "the clean key, never chat's");
    // Only spaces: no key of their own, so chat's (and /admin says so).
    process.env.ANTHROPIC_AUTOMATIONS_API_KEY = " \n";
    assert.equal(S.keyInUse(), "shared");
  } finally {
    process.env.ANTHROPIC_AUTOMATIONS_API_KEY = was;
  }
});

test("a key pasted with a line break or an invisible character inside works, and a broken one never shows in what is said", async () => {
  const was = process.env.ANTHROPIC_AUTOMATIONS_API_KEY!;
  const half = Math.floor(was.length / 2);
  assert.equal(S.automationsKey({ ANTHROPIC_AUTOMATIONS_API_KEY: `${was.slice(0, half)}\n${was.slice(half)}` }), was);
  assert.equal(S.automationsKey({ ANTHROPIC_AUTOMATIONS_API_KEY: `\u201c${was.slice(0, half)}\u200b${was.slice(half)}\ufeff\u201d` }), was);
  // A key a header can't carry, as the SDK really fails with it: nothing of it is said, and it means the key.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const secret = "sk-ant-api03-AAAA\nBBBB_SECRET_TAIL";
  const broken = new Anthropic({ apiKey: secret, authToken: null, baseURL: claude.url, maxRetries: 0 });
  const err = await broken.beta.messages.countTokens({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "Hi" }] }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err, "it failed");
  const said = S.anthropicProblem(err);
  assert.ok(!said.includes("SECRET") && !said.includes("AAAA"), said);
  assert.equal(S.problemKind(err), "key");
  // The same, as any message that quotes a header value.
  const quoted = new TypeError(`Headers.append: "${secret}" is an invalid header value.`);
  assert.equal(S.anthropicProblem(quoted), "TypeError: the key holds a line break or another character a header can't carry");
  assert.equal(S.anthropicProblem(new Error(`Headers.set: "zz\nSECRET-zz" is an invalid header value.`)), "Error: Headers.set: [key] is an invalid header value.");
  // What each kind of failure means.
  assert.equal(S.problemKind(Object.assign(new Error("x"), { status: 403 })), "permission");
  assert.equal(S.problemKind(Object.assign(new Error("x"), { status: 404 })), "model");
  assert.equal(S.problemKind(Object.assign(new Error("x"), { status: 429 })), "busy");
  assert.equal(S.problemKind(new Anthropic.APIConnectionTimeoutError()), "busy");
  assert.equal(S.problemKind(Object.assign(new Error("x"), { status: 400 })), "other");
});

test("/admin checks the automations key at each level's model, kept a minute, and says what Anthropic said", async () => {
  const { LEVEL_MODELS } = await import("../src/lib/engines/claude.ts");
  const models = [...new Set(Object.values(LEVEL_MODELS))];
  const counts = () => claude.state.seen.filter((s) => s.path.endsWith("/count_tokens"));
  // Fine: each model counted once, with the automations key.
  let from = counts().length;
  assert.deepEqual(await S.checkAutomationsKey(S.automationClient()), { ok: true, problems: [] });
  const asked = counts().slice(from);
  assert.deepEqual(asked.map((s) => s.body.model).sort(), [...models].sort());
  assert.ok(asked.every((s) => s.headers["x-api-key"] === process.env.ANTHROPIC_AUTOMATIONS_API_KEY));
  // Refused: what was said for each, in level order.
  claude.state.count = { tokens: 1200, status: 401 };
  const refused = (await S.checkAutomationsKey(S.automationClient()))!;
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.problems.map((p) => p.model), models);
  assert.deepEqual(refused.problems.map((p) => p.level), ["sonic", "ascend", "vision", "ultra"].filter((l) => models.includes(LEVEL_MODELS[l as keyof typeof LEVEL_MODELS])));
  assert.ok(refused.problems.every((p) => p.problem === "401 api_error: scripted" && p.kind === "key"));
  // Busy: said apart (it passes), and kept only a few seconds.
  claude.state.count = { tokens: 1200, status: 529 };
  assert.ok((await S.checkAutomationsKey(S.automationClient()))!.problems.every((p) => p.kind === "busy" && p.problem.startsWith("529 overloaded_error")));
  claude.state.count = { tokens: 1200, status: 0 };
  // /admin's lines: kept a minute, so a reload asks no one.
  const lines = await automationStats(1);
  assert.deepEqual(lines.keyCheck, { ok: true, problems: [] });
  from = counts().length;
  claude.state.count = { tokens: 1200, status: 401 };
  assert.deepEqual((await automationStats(1)).keyCheck, { ok: true, problems: [] }, "kept");
  assert.equal(counts().length, from, "asked no one");
  claude.state.count = { tokens: 1200, status: 0 };
  // Without a key of their own there is nothing to check.
  const was = process.env.ANTHROPIC_AUTOMATIONS_API_KEY;
  delete process.env.ANTHROPIC_AUTOMATIONS_API_KEY;
  try {
    assert.equal(await S.checkAutomationsKey(), null);
    assert.equal((await automationStats(1)).keyCheck, null);
  } finally {
    process.env.ANTHROPIC_AUTOMATIONS_API_KEY = was;
  }
});

test("Run now over the account's limit of 3 at once is queued for the tick, not started", async () => {
  const { cookie, id } = await admin("busy");
  const aid = await create(cookie, F.WRITE_SPEC);
  for (let i = 0; i < 3; i++) {
    const other = await F.automation({ userId: id });
    const rid = await F.runRow({ automationId: other, userId: id, status: "running" });
    await sql("UPDATE automation_runs SET lease_owner = 'w', lease_until = ? WHERE id = ?", [Date.now() + 600_000, rid]);
  }
  const streamed = claude.streamed().length;
  const r = await runOnce(cookie, aid, (await priceOf(cookie, F.WRITE_SPEC)).worst);
  assert.equal(r.status, 202);
  const b = await body(r);
  assert.equal((b.run as { status: string }).status, "queued");
  assert.equal(b.note, "Queued: Flash is busy. It starts soon.");
  const run = (await one<{ status: string; lease_owner: string }>("SELECT status, lease_owner FROM automation_runs WHERE automation_id = ?", [aid]))!;
  assert.deepEqual({ ...run }, { status: "queued", lease_owner: "" });
  assert.equal(claude.streamed().length, streamed, "Claude wasn't called");
});

test("delete removes the automation, its versions, runs, steps and notices by hand (foreign keys are off); the money record stays", async () => {
  const { cookie, id } = await admin("tidy");
  const aid = await create(cookie, F.WRITE_SPEC);
  claude.state.replies.push({ text: "Done." });
  assert.equal((await runOnce(cookie, aid, (await priceOf(cookie, F.WRITE_SPEC)).worst)).status, 202);
  const charged = await count("credit_ledger", "automation_id = ?", [aid]);
  assert.equal(charged, 1);
  assert.ok((await count("automation_run_steps", "user_id = ?", [id])) > 0);
  assert.ok((await count("notifications", "user_id = ?", [id])) > 0);
  const r = await oneRoute.DELETE(req(`/api/automations/${aid}`, { cookie, method: "DELETE", json: {} }), ctx({ id: aid }));
  assert.equal(r.status, 200);
  assert.deepEqual(await body(r), { ok: true, deleted: true });
  for (const [table, column] of [["automations", "id"], ["automation_versions", "automation_id"], ["automation_runs", "automation_id"]]) {
    assert.equal(await count(table, `${column} = ?`, [aid]), 0, table);
  }
  assert.equal(await count("automation_run_steps", "user_id = ?", [id]), 0);
  assert.equal(await count("notifications", "user_id = ?", [id]), 0);
  assert.equal(await count("credit_ledger", "automation_id = ?", [aid]), charged, "credits spent stay spent");
  assert.equal((await oneRoute.GET(req(`/api/automations/${aid}`, { cookie }), ctx({ id: aid }))).status, 404);
});

test("the admin card prices its test automations first and makes one only at the price shown; Run once now starts it", async () => {
  const { cookie, id } = await admin("card");
  const priced = await adminRoute.POST(req("/api/admin/automations", { cookie, json: { action: "price", timeZone: "America/Toronto" } }));
  assert.equal(priced.status, 200);
  const prices = (await body(priced)).prices as Record<"once" | "daily" | "manual", Estimate>;
  assert.equal(prices.daily.runs, 30);
  assert.equal(prices.manual.runs, 0);
  const make = (kind: string, seenMax?: number, run = false) =>
    adminRoute.POST(req("/api/admin/automations", { cookie, json: { action: "make", kind, timeZone: "America/Toronto", seenMax, run } }));
  assert.equal((await make("once")).status, 409, "never without the price");
  assert.equal(await count("automations", "user_id = ?", [id]), 0);
  const once = await make("once", prices.once.worst);
  assert.equal(once.status, 201);
  const made = (await body(once)).automation as { id: string; nextAt: number };
  const ahead = made.nextAt - Date.now();
  assert.ok(ahead > 2 * 60_000 && ahead <= 4 * 60_000, `about 3 minutes ahead (${ahead} ms)`);
  claude.state.replies.push({ text: "On this day…" });
  const ran = await make("manual", prices.manual.worst, true);
  await afterwards();
  assert.equal(ran.status, 202);
  const runId = ((await body(ran)).run as { id: string }).id;
  assert.equal((await one<{ status: string }>("SELECT status FROM automation_runs WHERE id = ?", [runId]))!.status, "done");
  const card = (await body(await adminRoute.GET(req("/api/admin/automations", { cookie })))) as unknown as {
    automations: { name: string }[];
    runs: { id: string; held: number; openHolds: number; credits: number }[];
    notices: { title: string; text: string }[];
  };
  // Each named with its kind, level, mode and the start of its instruction, so test automations tell apart.
  const names = card.automations.map((a) => a.name).sort();
  assert.equal(names.length, 2);
  assert.match(names[0], /^Burn-in: one-off in 3 minutes · "Write two sentences .+…" · Sonic Write$/);
  assert.match(names[1], /^Burn-in: run by hand · "Write two sentences .+…" · Sonic Write$/);
  assert.ok(names.every((n) => n.length <= 80));
  assert.equal(API.burnInSpec("daily", "UTC", "Overlap test", "ultra", "quick").name, 'Burn-in: every day · "Overlap test" · Summit Quick research');
  assert.equal(API.burnInSpec("daily", "UTC", "x".repeat(200), "ultra", "research").name.length, 80);
  assert.equal(card.runs[0].id, runId);
  assert.ok(card.runs[0].held >= card.runs[0].credits && card.runs[0].credits > 0 && card.runs[0].openHolds === 0);
  assert.deepEqual(card.notices.map((n) => [n.title, n.text]), [[names[1], A.NOTICES.ready]]);
});

test("api/me says automationsEnabled only for admins, and only once automations are set up here, with the Review automation price", async () => {
  const pat = await F.account("pat_me", 100, { admin: false });
  const boss = await admin("meboss", 100);
  type Me = { automationsEnabled: boolean; automationDraftCredits: number };
  const me = async (cookie: string) => (await (await meRoute.GET(req("/api/me", { cookie }))).json()) as Me;
  assert.deepEqual(await me(pat.cookie).then((m) => [m.automationsEnabled, m.automationDraftCredits]), [false, 0]);
  // The price the chat's Review automation card shows: what filling the editor in costs at most.
  assert.deepEqual(await me(boss.cookie).then((m) => [m.automationsEnabled, m.automationDraftCredits]), [true, draftMostCredits()]);
  assert.ok(draftMostCredits() > 0);
  delete process.env.CRON_SECRET;
  try {
    assert.deepEqual(await me(boss.cookie).then((m) => [m.automationsEnabled, m.automationDraftCredits]), [false, 0], "not until CRON_SECRET is set");
  } finally {
    process.env.CRON_SECRET = SECRET;
  }
  await afterwards();
});

test("draining credits through automations, then opening Flash (GET /api/me), never buys credits: no PaymentIntent", async () => {
  const { cookie, id } = await admin("drain", 160);
  await sql("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES (?, 1, 'starter', 100, 'cus_1', 'pm_1', 0)", [id]);
  const dear: Spec = { ...F.WRITE_SPEC, steps: [{ id: "a1", do: "ai", mode: "write", level: "ultra", prompt: "Write a long essay." }, { id: "n1", do: "notify" }] };
  const aid = await create(cookie, dear);
  const worst = (await priceOf(cookie, dear)).worst;
  // Long answers at Ultra, so a few runs reach the top-up level.
  let refused: { status: number; code?: string } | null = null;
  for (let i = 0; i < 8; i++) {
    claude.state.replies.push({ text: "A long answer.", usage: { input_tokens: 1200, output_tokens: 3000 } });
    const r = await runOnce(cookie, aid, worst);
    if (r.status !== 202) {
      refused = { status: r.status, code: ((await r.json()) as { code?: string }).code };
      break;
    }
  }
  const spent = -Number((await one<{ s: number }>("SELECT COALESCE(SUM(amount), 0) AS s FROM credit_ledger WHERE user_id = ? AND automation_id <> ''", [id]))!.s);
  assert.ok(spent > 30, `the runs spent credits (${spent})`);
  assert.ok((await F.balance(id)) >= 100, `never under the top-up level (${await F.balance(id)})`);
  // The level stops it for free: a run whose step didn't fit above it, or Run once now refusing before one starts.
  const stopped = await count("automation_runs", "automation_id = ? AND outcome = 'topup_floor' AND credits = 0", [aid]);
  assert.ok(stopped > 0 || (refused?.status === 409 && refused.code === "no_credits"), "the level stopped a run, for free");
  stripeCalls.length = 0;
  const me = await meRoute.GET(req("/api/me", { cookie }));
  assert.equal(me.status, 200);
  await afterwards();
  assert.equal(stripeCalls.includes("/payment_intents"), false, "no PaymentIntent");
  // Spent below the level some other way (chat), the same GET buys the pack: the stand-in works.
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, -60, 'chat', ?)", [id, Date.now()]);
  await meRoute.GET(req("/api/me", { cookie }));
  await afterwards();
  assert.equal(stripeCalls.includes("/payment_intents"), true);
});

test("a chat reply while an automation's worst-case hold is open doesn't set off auto top-up: the hold counts as not spent", async () => {
  const { cookie, id } = await admin("holdtop", 150);
  await sql("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES (?, 1, 'starter', 100, 'cus_1', 'pm_1', 0)", [id]);
  const dear: Spec = { ...F.WRITE_SPEC, steps: [{ id: "a1", do: "ai", mode: "write", level: "ultra", prompt: "Write one line." }, { id: "n1", do: "notify" }] };
  const aid = await F.automation({ userId: id, spec: dear, capRun: 500, capMonth: 5000 });
  const rid = await F.runRow({ automationId: aid, userId: id });
  let release!: () => void;
  claude.state.replies.push({ text: "One line.", hold: new Promise<void>((r) => (release = r)) });
  await sql("UPDATE automation_runs SET lease_owner = 'w:' || id, lease_until = CAST(unixepoch('subsec') * 1000 AS INTEGER) + 120000, status = 'running' WHERE id = ?", [rid]);
  const running = R.advanceRun(rid, `w:${rid}`, Date.now() + 760_000);
  for (let i = 0; i < 500 && !(await one("SELECT 1 FROM credit_holds WHERE run_id = ? AND started = 1", [rid])); i++) await new Promise((r) => setTimeout(r, 10));
  // The hold takes everything above the level: the balance sits at it while the step runs.
  assert.equal(await F.balance(id), 100);
  // A chat reply settles at 2 credits meanwhile (98 now, with the hold at full size), then Flash is opened.
  await C.settle((await C.charge(id, 3, "chat"))!, 2);
  stripeCalls.length = 0;
  assert.equal((await meRoute.GET(req("/api/me", { cookie }))).status, 200);
  await afterwards();
  assert.equal(stripeCalls.includes("/payment_intents"), false, "no PaymentIntent while the hold is open");
  release();
  await running;
  // The step settled far below its hold: the balance never really went under the level.
  assert.ok((await F.balance(id)) > 100, String(await F.balance(id)));
  await meRoute.GET(req("/api/me", { cookie }));
  await afterwards();
  assert.equal(stripeCalls.includes("/payment_intents"), false, "nor after it settled");
});

/** Runs an Ultra Write step, and calls change while its hold is open (its call held until then). */
async function whileHeld(userId: string, change: () => Promise<void>, outputTokens = 3000) {
  const dear: Spec = { ...F.WRITE_SPEC, steps: [{ id: "a1", do: "ai", mode: "write", level: "ultra", prompt: "Write one line." }, { id: "n1", do: "notify" }] };
  const aid = await F.automation({ userId, spec: dear, capRun: 500, capMonth: 5000 });
  const rid = await F.runRow({ automationId: aid, userId });
  let release!: () => void;
  claude.state.replies.push({ text: "One line.", usage: { input_tokens: 1200, output_tokens: outputTokens }, hold: new Promise<void>((r) => (release = r)) });
  await sql("UPDATE automation_runs SET lease_owner = 'w:' || id, lease_until = CAST(unixepoch('subsec') * 1000 AS INTEGER) + 120000, status = 'running' WHERE id = ?", [rid]);
  const running = R.advanceRun(rid, `w:${rid}`, Date.now() + 760_000);
  for (let i = 0; i < 500 && !(await one("SELECT 1 FROM credit_holds WHERE run_id = ? AND started = 1", [rid])); i++) await new Promise((r) => setTimeout(r, 10));
  await change();
  release();
  await running;
  return -Number((await one<{ s: number }>("SELECT COALESCE(SUM(amount), 0) AS s FROM credit_ledger WHERE automation_id = ?", [aid]))!.s);
}
/** Opens Flash (GET /api/me and what it does after): whether that bought a pack. */
async function opensAndBuys(cookie: string) {
  stripeCalls.length = 0;
  assert.equal((await meRoute.GET(req("/api/me", { cookie }))).status, 200);
  await afterwards();
  return stripeCalls.includes("/payment_intents");
}

test("auto top-up turned on (a card saved) while a step's hold is open: the step may settle under the new level, and that never buys a pack", async () => {
  const { cookie, id } = await admin("lvcard", 110);
  cardUser = id;
  // Auto top-up is off when the step is charged, so its hold takes all 110.
  const charged = await whileHeld(id, async () => {
    assert.equal(await F.balance(id), 0);
    // Credits > Auto top-up at 100, then the card saved (the webhook): both while the step writes.
    assert.ok((await TU.setAutoTopUp({ id, email: `${id}@example.com` }, { enabled: true, pack: "starter", below: 100 }, BASE)).url);
    assert.equal(await TU.saveCard("cs_1"), true);
    assert.equal(await opensAndBuys(cookie), false, "nothing bought while the hold is open");
  });
  assert.ok(charged > 0 && (await F.balance(id)) < 100, `the step settled under the new level (${charged}, ${await F.balance(id)})`);
  assert.equal(await opensAndBuys(cookie), false, "nor once it settled: the automation's spending never sets off auto top-up");
  // Spent under the level by chat, the pack is bought: only that step's charge is left out.
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, -11, 'chat', ?)", [id, Date.now()]);
  assert.equal(await opensAndBuys(cookie), true);
});

test("the auto top-up level raised while a step's hold is open: the step settling under the new level never buys a pack", async () => {
  const { cookie, id } = await admin("lvraise", 320);
  await sql("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES (?, 1, 'starter', 100, 'cus_1', 'pm_1', 0)", [id]);
  const charged = await whileHeld(id, async () => {
    assert.ok((await F.balance(id)) >= 100, "the hold kept the old level");
    await TU.setAutoTopUp({ id, email: `${id}@example.com` }, { enabled: true, pack: "starter", below: 300 }, BASE);
    assert.equal(await opensAndBuys(cookie), false);
  });
  assert.ok(charged > 0 && (await F.balance(id)) < 300, `the step settled under the new level (${charged}, ${await F.balance(id)})`);
  assert.equal(await opensAndBuys(cookie), false, "no PaymentIntent");
  // A step charged after the change keeps the new level: it can't start under 300 (here: 279 left).
  claude.state.replies.push({ text: "One more." });
  const aid = await F.automation({ userId: id, spec: { ...F.WRITE_SPEC, steps: [{ id: "a1", do: "ai", mode: "write", level: "ultra", prompt: "Write one line." }, { id: "n1", do: "notify" }] }, capRun: 500, capMonth: 5000 });
  const rid = await F.runRow({ automationId: aid, userId: id });
  await sql("UPDATE automation_runs SET lease_owner = 'w:' || id, lease_until = CAST(unixepoch('subsec') * 1000 AS INTEGER) + 120000, status = 'running' WHERE id = ?", [rid]);
  await R.advanceRun(rid, `w:${rid}`, Date.now() + 760_000);
  assert.equal((await one<{ outcome: string }>("SELECT outcome FROM automation_runs WHERE id = ?", [rid]))!.outcome, "topup_floor");
  // Spent under the level by chat, the pack is bought: only the step open at the change is left out.
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, -21, 'chat', ?)", [id, Date.now()]);
  assert.equal(await opensAndBuys(cookie), true);
});

/** Chat spends the balance down to `to`, then Flash is opened: whether that bought a pack. */
async function chatTo(cookie: string, id: string, to: number) {
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, ?, 'chat', ?)", [id, to - (await F.balance(id)), Date.now()]);
  return opensAndBuys(cookie);
}
const marked = (id: string) => count("credit_ledger", "user_id = ? AND topup_kept_from IS NOT NULL", [id]);

test("saves that keep auto top-up's level (the pack changed, the same choice again, a card replaced, the level lowered) while steps run mark nothing: it still buys at its level", async () => {
  const { cookie, id } = await admin("lvsame", 1000);
  cardUser = id;
  const choose = (pack: string, below: number) => TU.setAutoTopUp({ id, email: `${id}@example.com` }, { enabled: true, pack, below }, BASE).then(() => undefined);
  await sql("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES (?, 1, 'starter', 100, 'cus_1', 'pm_1', 0)", [id]);
  let charged = await whileHeld(id, () => choose("creator", 100));
  charged += await whileHeld(id, () => choose("creator", 100));
  charged += await whileHeld(id, () => TU.saveCard("cs_1").then(() => undefined));
  // Set to 300 with nothing held, then lowered to 100 while a step (kept above 300) holds credits.
  await choose("creator", 300);
  charged += await whileHeld(id, () => choose("creator", 100));
  assert.ok(charged > 100, `four steps charged ${charged}`);
  assert.equal(await marked(id), 0);
  // Spent to 99 by chat: the pack is bought, at the level and not at the level plus those charges.
  assert.equal(await chatTo(cookie, id, 99), true);
});

test("a save that keeps auto top-up's level marks nothing even when chat spent the balance under it while a step held credits: the pack is bought", async () => {
  const { cookie, id } = await admin("lvchat", 1000);
  await sql("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES (?, 1, 'starter', 100, 'cus_1', 'pm_1', 0)", [id]);
  // The step takes its whole hold; meanwhile chat spends the balance to 87 and the pack is changed.
  await whileHeld(id, async () => {
    await sql("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, ?, 'chat', ?)", [id, 87 - (await F.balance(id)), Date.now()]);
    await TU.setAutoTopUp({ id, email: `${id}@example.com` }, { enabled: true, pack: "creator", below: 100 }, BASE);
  }, 60_000);
  assert.equal(await F.balance(id), 87);
  assert.equal(await marked(id), 0);
  assert.equal(await opensAndBuys(cookie), true, "chat took it under the level the step was kept above");
});

test("auto top-up's marks last only while the balance is under its level: once it is back there, every charge counts again", async () => {
  const { cookie, id } = await admin("lvback", 320);
  await sql("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES (?, 1, 'starter', 100, 'cus_1', 'pm_1', 0)", [id]);
  // The level raised to 300 while a step holds credits under it: its charge is marked.
  const charged = await whileHeld(id, () => TU.setAutoTopUp({ id, email: `${id}@example.com` }, { enabled: true, pack: "starter", below: 300 }, BASE).then(() => undefined));
  assert.equal(await marked(id), 1);
  assert.ok((await F.balance(id)) < 300);
  assert.equal(await opensAndBuys(cookie), false);
  // Credits bought by hand take the balance back over the level: the next check clears the mark.
  assert.equal(await C.addPurchase(id, "starter", "stripe:cs_lvback"), true);
  assert.equal(await opensAndBuys(cookie), false);
  assert.equal(await marked(id), 0);
  // Chat spends it to 299: the pack is bought at the level, not at the level plus that step's charge.
  assert.ok(charged > 1);
  assert.equal(await chatTo(cookie, id, 299), true);
});

test("the level raised while a step holds credits marks nothing when the balance, that hold at full size, is still at the new level", async () => {
  const { cookie, id } = await admin("lvroom", 900);
  await sql("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES (?, 1, 'starter', 100, 'cus_1', 'pm_1', 0)", [id]);
  await whileHeld(id, async () => {
    assert.ok((await F.balance(id)) >= 300, String(await F.balance(id)));
    await TU.setAutoTopUp({ id, email: `${id}@example.com` }, { enabled: true, pack: "starter", below: 300 }, BASE);
  });
  assert.equal(await marked(id), 0);
  assert.equal(await chatTo(cookie, id, 299), true);
});

test("auto top-up's mark touches only this account's holds open at the change, and only when it is turned on with a card", async () => {
  // A charge settled before auto top-up was turned on (here at a balance under its level) still counts.
  const settled = await admin("lvsettled", 120);
  await sql("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES (?, 0, 'starter', 100, 'cus_1', 'pm_1', 0)", [settled.id]);
  const spent = await whileHeld(settled.id, async () => undefined);
  assert.ok(spent > 20 && (await F.balance(settled.id)) < 100, `${spent} spent, ${await F.balance(settled.id)} left`);
  await TU.setAutoTopUp({ id: settled.id, email: `${settled.id}@example.com` }, { enabled: true, pack: "starter", below: 100 }, BASE);
  assert.equal(await marked(settled.id), 0);
  assert.equal(await opensAndBuys(settled.cookie), true, "a settled charge isn't marked");
  // A hold open while auto top-up is saved off (here at a higher level) isn't marked, so it counts once
  // auto top-up is on again.
  const off = await admin("lvoff", 320);
  await sql("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES (?, 1, 'starter', 100, 'cus_1', 'pm_1', 0)", [off.id]);
  await whileHeld(off.id, () => TU.setAutoTopUp({ id: off.id, email: `${off.id}@example.com` }, { enabled: false, pack: "starter", below: 300 }, BASE).then(() => undefined));
  assert.equal(await marked(off.id), 0);
  await TU.setAutoTopUp({ id: off.id, email: `${off.id}@example.com` }, { enabled: true, pack: "starter", below: 300 }, BASE);
  assert.ok((await F.balance(off.id)) < 300);
  assert.equal(await opensAndBuys(off.cookie), true, "a hold open at turning off isn't marked");
  // Turned back on (its card already saved) while a step holds credits: that step never buys a pack.
  const back = await admin("lvback2", 320);
  await sql("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES (?, 0, 'starter', 300, 'cus_1', 'pm_1', 0)", [back.id]);
  await whileHeld(back.id, () => TU.setAutoTopUp({ id: back.id, email: `${back.id}@example.com` }, { enabled: true, pack: "starter", below: 300 }, BASE).then(() => undefined));
  assert.ok((await F.balance(back.id)) < 300);
  assert.equal(await marked(back.id), 1);
  assert.equal(await opensAndBuys(back.cookie), false, "the step open when it was turned on never sets it off");
  // Another account turning its own auto top-up on leaves this account's open hold unmarked.
  const other = await admin("lvother", 320);
  await sql("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES (?, 1, 'starter', 100, 'cus_1', 'pm_1', 0)", [other.id]);
  const me = await admin("lvme", 50);
  await sql("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES (?, 0, 'starter', 100, 'cus_2', 'pm_2', 0)", [me.id]);
  await whileHeld(other.id, () => TU.setAutoTopUp({ id: me.id, email: `${me.id}@example.com` }, { enabled: true, pack: "starter", below: 100 }, BASE).then(() => undefined));
  assert.equal(await marked(other.id), 0);
  assert.equal(await chatTo(other.cookie, other.id, 99), true, "another account's change marks nothing here");
});

test("a charge auto top-up leaves out counts again once the balance is under what it was when it was marked: a step that took its whole hold never stops auto top-up for good", async () => {
  const { cookie, id } = await admin("lvfull", 250);
  await sql("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES (?, 0, 'starter', 100, 'cus_1', 'pm_1', 0)", [id]);
  // Turned on at 100 (its card already saved) while a step holds all but 86, and the step takes its whole hold.
  let at = 0;
  const charged = await whileHeld(id, async () => {
    at = await F.balance(id);
    await TU.setAutoTopUp({ id, email: `${id}@example.com` }, { enabled: true, pack: "starter", below: 100 }, BASE);
  }, 60_000);
  assert.ok(at < 100 && charged > 100, `${at} left, ${charged} charged`);
  assert.equal(await F.balance(id), at);
  assert.equal(await marked(id), 1);
  // The step's spending never sets it off, even when it took all it held...
  assert.equal(await opensAndBuys(cookie), false, "nothing bought for the step");
  // ...but one credit spent by chat below that is the account's own: the pack is bought.
  assert.equal(await chatTo(cookie, id, at - 1), true, "bought once chat spent below the balance at the change");
});

test("a charge auto top-up leaves out counts again a day after it settled: a balance too small to spend from never stops auto top-up for good", async () => {
  const { cookie, id } = await admin("lvday", 110);
  cardUser = id;
  await sql("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES (?, 0, 'starter', 100, 'cus_1', 'pm_1', 0)", [id]);
  // Off while the step is charged, so its hold takes all 110; turned on at 100 meanwhile; the step takes all it held.
  await whileHeld(id, async () => {
    assert.equal(await F.balance(id), 0);
    await TU.setAutoTopUp({ id, email: `${id}@example.com` }, { enabled: true, pack: "starter", below: 100 }, BASE);
  }, 60_000);
  assert.ok((await F.balance(id)) < 100, String(await F.balance(id)));
  assert.equal(await marked(id), 1);
  assert.equal(await opensAndBuys(cookie), false, "nothing bought for the step");
  // A day after it settled, with nothing spent (nothing can be, from so little), its charge counts.
  await sql("UPDATE credit_ledger SET settled_at = settled_at - ? WHERE user_id = ? AND topup_kept_from IS NOT NULL", [C.KEPT_OUT_MS, id]);
  assert.equal(await opensAndBuys(cookie), true, "bought a day later");
  assert.equal(await marked(id), 0);
});

test("turning auto top-up on again, or raising its level, goes by the balance as it is then: the marks from before are cleared", async () => {
  const { cookie, id } = await admin("lvagain", 320);
  const choose = (enabled: boolean, below: number) => TU.setAutoTopUp({ id, email: `${id}@example.com` }, { enabled, pack: "starter", below }, BASE).then(() => undefined);
  await sql("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES (?, 1, 'starter', 100, 'cus_1', 'pm_1', 0)", [id]);
  // Raised to 300 while a step holds credits: its charge is left out, and the step settles under 300.
  await whileHeld(id, () => choose(true, 300));
  assert.equal(await marked(id), 1);
  assert.ok((await F.balance(id)) < 300);
  assert.equal(await opensAndBuys(cookie), false);
  // Turned off (nothing changes), then on again with nothing running: the balance under 300 buys the pack.
  await choose(false, 300);
  assert.equal(await marked(id), 1);
  await choose(true, 300);
  assert.equal(await marked(id), 0);
  assert.equal(await opensAndBuys(cookie), true, "turned on under its level");
});

test("/admin's automation lines: setup by name only, cron health worked out from the data, and what runs charged against their cost", async () => {
  const lines = await automationStats(30);
  assert.deepEqual([lines.server, lines.key, lines.missing, lines.sharedPaid], [true, "automations", [], 2]);
  assert.equal(lines.active, Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM automations WHERE status = 'on'"))!.n));
  assert.ok(lines.credits > 0 && lines.costCents > 0 && lines.requests > 0, "the runs above, charged and costed");
  assert.ok(lines.outcomes.some((o) => o.status === "done" && o.week > 0 && o.day > 0));
  // Function time counts each step's own time, not a run's wait between tries: three tries of 2 s over 8 minutes are 6 s.
  const u = await admin("fntime");
  const aid = await F.automation({ userId: u.id });
  const rid = await F.runRow({ automationId: aid, userId: u.id, status: "failed" });
  const t0 = Date.now() - 600_000;
  await sql("UPDATE automation_runs SET started_at = ?, finished_at = ? WHERE id = ?", [t0, t0 + 480_000, rid]);
  for (const [attempt, at] of [[1, 0], [2, 180_000], [3, 478_000]]) {
    await sql("INSERT INTO automation_run_steps (run_id, step_id, attempt, user_id, kind, status, started_at, finished_at) VALUES (?, 'a1', ?, ?, 'ai', 'retried', ?, ?)", [rid, attempt, u.id, t0 + at, t0 + at + 2000]);
  }
  const more = (await automationStats(30)).functionSeconds - lines.functionSeconds;
  assert.ok(more >= 5 && more <= 7, `${more} s`);
  // A call that cost Flash money and charged nothing is a loss.
  await sql("INSERT INTO usage (user_id, engine, model, provider, credits, cost_cents, ok, part, automation_id, created_at) VALUES ('boss', 'write', 'm', 'anthropic', 0, 2.5, 1, 0, 'lost', ?)", [Date.now()]);
  const after1 = await automationStats(30);
  assert.equal(after1.losses, lines.losses + 1);
  assert.equal(after1.lostCents, lines.lostCents + 2.5);
  // A 429: counted for the last hour, and AI runs pause for a minute.
  const health = await cronHealth();
  await S.backOff();
  const hit = await cronHealth();
  assert.equal(hit.rateLimitedLastHour, health.rateLimitedLastHour + 1);
  assert.equal(hit.paidOpen, false);
  await sql("DELETE FROM settings WHERE key = 'auto:backoff_until'");
  // Missing setup by name, never a value; chat's key until the automations key is set.
  const key = process.env.ANTHROPIC_AUTOMATIONS_API_KEY;
  delete process.env.CRON_SECRET;
  delete process.env.FLASH_APP_URL;
  delete process.env.ANTHROPIC_AUTOMATIONS_API_KEY;
  try {
    const off = (await adminStats(30)).automations;
    assert.deepEqual([off.key, off.missing, off.health.maxPaid], ["shared", ["CRON_SECRET", "FLASH_APP_URL"], 2]);
    assert.equal(JSON.stringify(off).includes(SECRET), false);
    assert.equal(off.cronSecretShort, false, "not set at all");
    // One set but too short is said apart from one not set (still not used, and never shown).
    process.env.CRON_SECRET = "short-secret";
    const short = (await adminStats(30)).automations;
    assert.deepEqual([short.missing, short.cronSecretShort], [["CRON_SECRET", "FLASH_APP_URL"], true]);
    assert.equal(JSON.stringify(short).includes("short-secret"), false);
  } finally {
    process.env.CRON_SECRET = SECRET;
    process.env.FLASH_APP_URL = "http://flash.test";
    process.env.ANTHROPIC_AUTOMATIONS_API_KEY = key;
  }
});

// The review's regressions (each failed before its fix).

const NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const patch = (cookie: string, id: string, json: Record<string, unknown>) => oneRoute.PATCH(req(`/api/automations/${id}`, { cookie, method: "PATCH", json }), ctx({ id }));
type Card = { automations: { id: string; spentThisMonth: number; heldNow: number; timePassed: boolean }[]; runs: { id: string; held: number; holds: number; deleted: boolean; waiting: boolean }[]; spentThisMonth: number; heldNow: number; noticeLocale: string };
const cardOf = async (cookie: string) => (await body(await adminRoute.GET(req("/api/admin/automations", { cookie })))) as unknown as Card;

test("a downloaded receipt whose words were changed doesn't match, though its fingerprint is Flash's", async () => {
  const { cookie } = await admin("rv1");
  const aid = await create(cookie, F.WRITE_SPEC);
  claude.state.replies.push({ text: "Clear skies all day." });
  const started = await runOnce(cookie, aid, (await priceOf(cookie, F.WRITE_SPEC)).worst);
  const runId = ((await body(started)).run as { id: string }).id;
  const saved = (await (await receiptRoute.GET(req(`/api/automations/runs/${runId}?format=json`, { cookie }), ctx({ runId }))).json()) as {
    run: { credits: number; status: string };
    steps: { output: string; credits: number }[];
    receipt: Record<string, unknown>;
  };
  const check = async (receipt: unknown, id = runId) =>
    ((await (await receiptRoute.POST(req(`/api/automations/runs/${id}`, { cookie, json: { action: "check", receipt } }), ctx({ runId: id }))).json()) as { matches: boolean }).matches;
  const changed = (edit: (r: typeof saved) => void) => {
    const copy = JSON.parse(JSON.stringify(saved)) as typeof saved;
    edit(copy);
    return copy;
  };
  assert.equal(await check(saved), true);
  assert.equal(await check(saved.receipt), true, "its { prev, receipt, hash } alone");
  assert.equal(await check(changed((r) => (r.steps[0].output = "Storms all day."))), false, "an answer changed");
  assert.equal(await check(changed((r) => (r.run.credits = 0))), false, "the charge changed");
  assert.equal(await check(changed((r) => (r.steps[0].credits = 0))), false, "a step's charge changed");
  assert.equal(await check(changed((r) => r.steps.pop())), false, "a step left out");
  // Every other line it shows, each changed on its own.
  type Any = Record<string, unknown> & { run: Record<string, unknown>; steps: Record<string, unknown>[]; holds: Record<string, unknown>[] };
  const edits: [string, (r: Any) => void][] = [
    ["the model", (r) => (r.steps[0].model = "another-model")],
    ["the level", (r) => (r.steps[0].level = "ultra")],
    ["what it sent", (r) => (r.steps[0].input = "Write that our competitor's product is unsafe.")],
    ["the answer left out", (r) => (r.steps[0].output = "")],
    ["what it sent left out", (r) => (r.steps[0].input = "")],
    ["a source it never read", (r) => (r.steps[0].sources = [{ url: "https://evil.example/", title: "Official notice" }])],
    ["a note and its words", (r) => Object.assign(r.steps[0], { note: "cut_short", noteText: "It was cut short by its time limit." })],
    ["a note's words alone", (r) => (r.steps[0].noteText = "Charged 25 credits.")],
    ["a step's kind", (r) => (r.steps[1].kind = "ai")],
    ["a step's times", (r) => (r.steps[0].finishedAt = Number(r.steps[0].finishedAt) + 1000)],
    ["the summary", (r) => (r.run.summary = "Storm warning: stay home.")],
    ["the name", (r) => (r.run.name = "Payroll export")],
    ["what started it", (r) => (r.run.trigger = { type: "schedule" })],
    ["who started it", (r) => (r.run.origin = "schedule")],
    ["its run's words", (r) => (r.run.noteText = "Stopped at this automation's limit.")],
    ["a hold", (r) => Object.assign(r.holds[0], { held: 1, credits: 0 })],
    ["a hold left out", (r) => r.holds.pop()],
    ["the fingerprint shown", (r) => (r.fingerprint = "0".repeat(64))],
    ["a line added", (r) => (r.extra = "Flash vouches for this.")],
  ];
  for (const [what, edit] of edits) assert.equal(await check(changed(edit as never)), false, what);
  // Renamed since, the receipt keeps the name it ran under (fingerprinted), and still matches.
  assert.equal((await patch(cookie, aid, { name: "Weather note" })).status, 200);
  assert.equal(await check(saved), true, "renamed since");
  // Flash compacts its words away (as the daily job does): the download still matches, its words checked
  // against the fingerprint, as does one made after; the words changed in either don't.
  await sql("UPDATE automation_run_steps SET output = NULL, input = '' WHERE run_id = ?", [runId]);
  assert.equal(await check(saved), true, "compacted since");
  const later = (await (await receiptRoute.GET(req(`/api/automations/runs/${runId}?format=json`, { cookie }), ctx({ runId }))).json()) as typeof saved;
  assert.equal(later.steps[0].output, "");
  assert.equal(await check(later), true, "downloaded once compacted");
  assert.equal(await check(changed((r) => (r.steps[0].output = "Storms all day."))), false, "an answer changed, compacted since");
  assert.equal(await check(changed((r) => ((r as unknown as Any).steps[0].input = "Another instruction."))), false, "what it sent changed, compacted since");
  assert.equal(await check(changed((r) => ((r as unknown as Any).steps[0].sources = [{ url: "https://evil.example/", title: "Notice" }]))), false, "a source added, compacted since");
  // Another run's receipt is not this run's.
  claude.state.replies.push({ text: "Rain later." });
  const other = ((await body(await runOnce(cookie, aid, (await priceOf(cookie, F.WRITE_SPEC)).worst))).run as { id: string }).id;
  assert.equal(await check(saved, other), false);
});

test("a run Flash refunded says so in its receipt: what came back is fingerprinted, and a download that changes it doesn't match", async () => {
  const { cookie, id } = await admin("rv1r");
  const before = await F.balance(id);
  const aid = await create(cookie, F.WRITE_SPEC);
  // Claude's reply breaks off part way: the step used credits, and the run fails because of Flash.
  claude.state.replies.push({ text: "Half an answer that goes on", cut: true });
  const runId = ((await body(await runOnce(cookie, aid, (await priceOf(cookie, F.WRITE_SPEC)).worst))).run as { id: string }).id;
  const saved = (await (await receiptRoute.GET(req(`/api/automations/runs/${runId}?format=json`, { cookie }), ctx({ runId }))).json()) as {
    run: { credits: number; refunded: number; status: string };
    steps: { credits: number }[];
    receipt: { receipt: { credits: number; refunded?: number } };
  };
  assert.equal(saved.run.status, "failed");
  assert.ok(saved.steps[0].credits >= 1, "its step shows what it used");
  assert.deepEqual([saved.run.credits, saved.run.refunded], [0, saved.steps[0].credits], "and the run gave it all back");
  assert.deepEqual([saved.receipt.receipt.credits, saved.receipt.receipt.refunded], [0, saved.steps[0].credits], "as its fingerprinted receipt says");
  assert.equal(await F.balance(id), before, "nothing stays charged");
  const check = async (receipt: unknown) =>
    ((await (await receiptRoute.POST(req(`/api/automations/runs/${runId}`, { cookie, json: { action: "check", receipt } }), ctx({ runId }))).json()) as { matches: boolean }).matches;
  const changed = (edit: (r: typeof saved) => void) => {
    const copy = JSON.parse(JSON.stringify(saved)) as typeof saved;
    edit(copy);
    return copy;
  };
  assert.equal(await check(saved), true);
  assert.equal(await check(changed((r) => (r.run.refunded = 0))), false, "the refund left out");
  assert.equal(await check(changed((r) => Object.assign(r.run, { credits: r.run.refunded, refunded: 0 }))), false, "said to be charged");
  // A run that wasn't refunded matches with 0, and not with a refund added.
  claude.state.replies.push({ text: "Clear skies all day." });
  const done = ((await body(await runOnce(cookie, aid, (await priceOf(cookie, F.WRITE_SPEC)).worst))).run as { id: string }).id;
  const plain = (await (await receiptRoute.GET(req(`/api/automations/runs/${done}?format=json`, { cookie }), ctx({ runId: done }))).json()) as typeof saved;
  assert.deepEqual([plain.run.status, plain.run.refunded, "refunded" in plain.receipt.receipt], ["done", 0, false]);
  const checkDone = async (receipt: unknown) =>
    ((await (await receiptRoute.POST(req(`/api/automations/runs/${done}`, { cookie, json: { action: "check", receipt } }), ctx({ runId: done }))).json()) as { matches: boolean }).matches;
  assert.equal(await checkDone(plain), true);
  assert.equal(await checkDone({ ...plain, run: { ...plain.run, refunded: plain.run.credits, credits: 0 } }), false, "said to be refunded");
});

test("a Research step's sources are fingerprinted: its download matches, and one with a source changed doesn't, before and after compaction", async () => {
  const { cookie } = await admin("rv9src");
  const research: Spec = { v: 1, trigger: { type: "manual" }, steps: [{ id: "a1", do: "ai", mode: "research", level: "sonic", prompt: "Check today's news about my bank." }, { id: "n1", do: "notify" }] };
  const aid = await create(cookie, research);
  claude.state.replies.push({
    blocks: [
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_fetch", input: { url: "https://news.example/bank" } },
      {
        type: "web_fetch_tool_result",
        tool_use_id: "srvtoolu_1",
        content: { type: "web_fetch_result", url: "https://news.example/bank", retrieved_at: "2026-10-18T00:00:00Z", content: { type: "document", source: { type: "text", media_type: "text/plain", data: "Rates held." }, title: "Bank news" } },
      } as never,
      { type: "text", text: "Rates held today." },
    ],
  });
  const runId = ((await body(await runOnce(cookie, aid, (await priceOf(cookie, research)).worst))).run as { id: string }).id;
  const saved = (await (await receiptRoute.GET(req(`/api/automations/runs/${runId}?format=json`, { cookie }), ctx({ runId }))).json()) as { steps: { sources: { url: string; title: string }[] }[] };
  assert.deepEqual(saved.steps[0].sources, [{ url: "https://news.example/bank", title: "Bank news" }]);
  const check = async (receipt: unknown) =>
    ((await (await receiptRoute.POST(req(`/api/automations/runs/${runId}`, { cookie, json: { action: "check", receipt } }), ctx({ runId }))).json()) as { matches: boolean }).matches;
  const retitled = JSON.parse(JSON.stringify(saved)) as typeof saved;
  retitled.steps[0].sources[0].title = "Flash: sign in again";
  assert.equal(await check(saved), true);
  assert.equal(await check(retitled), false, "a source's title changed");
  await sql("UPDATE automation_run_steps SET output = NULL, input = '' WHERE run_id = ?", [runId]);
  assert.equal(await check(saved), true, "compacted since: its sources are the fingerprint's");
  assert.equal(await check(retitled), false, "nor once compacted");
});

test("a receipt saved while its run was going has no fingerprint to check: the check says so, apart from a changed one", async () => {
  const { cookie, id } = await admin("rv9early");
  const aid = await F.automation({ userId: id, spec: F.WRITE_SPEC });
  const rid = await F.runRow({ automationId: aid, userId: id });
  const early = (await (await receiptRoute.GET(req(`/api/automations/runs/${rid}?format=json`, { cookie }), ctx({ runId: rid }))).json()) as { fingerprint: string; receipt: unknown };
  assert.deepEqual([early.fingerprint, early.receipt], ["", null]);
  claude.state.replies.push({ text: "Clear skies all day." });
  await sql(`UPDATE automation_runs SET status = 'running', lease_owner = 'w:' || id, lease_until = ${NOW} + 120000 WHERE id = ?`, [rid]);
  await R.advanceRun(rid, `w:${rid}`, Date.now() + 760_000);
  const answer = async (receipt: unknown) => (await (await receiptRoute.POST(req(`/api/automations/runs/${rid}`, { cookie, json: { action: "check", receipt } }), ctx({ runId: rid }))).json()) as { matches: boolean; reason?: string };
  assert.deepEqual(await answer(early), { matches: false, reason: "unfinished" });
  const now = await (await receiptRoute.GET(req(`/api/automations/runs/${rid}?format=json`, { cookie }), ctx({ runId: rid }))).json();
  assert.deepEqual(await answer(now), { matches: true });
  assert.deepEqual(await answer({ ...now, receipt: null, fingerprint: "" }), { matches: false, reason: "unfinished" });
});

test("a run stopped at a limit keeps the figure its note names: changing the limits or the auto top-up level after leaves its receipt, and its download, as they were", async () => {
  const ultra: Spec = { ...F.WRITE_SPEC, steps: [{ id: "a1", do: "ai", mode: "write", level: "ultra", prompt: "Write one line." }, { id: "n1", do: "notify" }] };
  const ends = async (cookie: string, aid: string, userId: string) => {
    const rid = await F.runRow({ automationId: aid, userId });
    await sql(`UPDATE automation_runs SET status = 'running', lease_owner = 'w:' || id, lease_until = ${NOW} + 120000 WHERE id = ?`, [rid]);
    await R.advanceRun(rid, `w:${rid}`, Date.now() + 760_000);
    const file = (await (await receiptRoute.GET(req(`/api/automations/runs/${rid}?format=json`, { cookie }), ctx({ runId: rid }))).json()) as { run: { outcome: string; noteText: string } };
    const now = async () => {
      const shown = (await (await receiptRoute.GET(req(`/api/automations/runs/${rid}?format=json`, { cookie }), ctx({ runId: rid }))).json()) as typeof file;
      const { matches } = (await (await receiptRoute.POST(req(`/api/automations/runs/${rid}`, { cookie, json: { action: "check", receipt: file } }), ctx({ runId: rid }))).json()) as { matches: boolean };
      return { noteText: shown.run.noteText, matches };
    };
    return { file, now };
  };
  const { cookie, id } = await admin("rvlimit");
  // Its month limit (20) is less than its step needs: skipped at the month limit, then the limit raised.
  const month = await F.automation({ userId: id, spec: ultra, capRun: 300, capMonth: 20 });
  const m = await ends(cookie, month, id);
  assert.equal(m.file.run.outcome, "month_cap");
  assert.match(m.file.run.noteText, /\(20 credits\)/);
  assert.deepEqual(await m.now(), { noteText: m.file.run.noteText, matches: true });
  assert.equal((await patch(cookie, month, { capRun: 300, capMonth: 2000 })).status, 200);
  assert.deepEqual(await m.now(), { noteText: m.file.run.noteText, matches: true }, "the month limit raised since");
  // Two Sonic steps under a run limit of 1 more than one needs at least (as a price_up pause records it):
  // after a long first answer the second doesn't fit, so the run stops at its limit; then it is raised.
  const probe = await F.automation({ userId: id, spec: { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "daily", at: "08:00" } } }, capRun: 1, nextAt: Date.now() + 3_600_000 });
  await ends(cookie, probe, id);
  const cap = Number((await one<{ need_credits: number }>("SELECT need_credits FROM automations WHERE id = ?", [probe]))!.need_credits) + 1;
  const two: Spec = { ...F.WRITE_SPEC, steps: [{ id: "a1", do: "ai", mode: "write", level: "sonic", prompt: "Write one line." }, { id: "a2", do: "ai", mode: "write", level: "sonic", prompt: "And one more." }, { id: "n1", do: "notify" }] };
  const each = await F.automation({ userId: id, spec: two, capRun: cap, capMonth: 2000 });
  claude.state.replies.push({ text: "Sunny.", usage: { input_tokens: 1200, output_tokens: 8000 } });
  const r = await ends(cookie, each, id);
  assert.equal(r.file.run.outcome, "run_cap");
  assert.ok(r.file.run.noteText.includes(`limit of ${cap} credits`), r.file.run.noteText);
  assert.equal((await patch(cookie, each, { capRun: 300, capMonth: 2000, seenMax: 1e9 })).status, 200);
  assert.deepEqual(await r.now(), { noteText: r.file.run.noteText, matches: true }, "the run limit raised since");
  // 110 credits with auto top-up at 100: skipped at the level, then the level raised, then auto top-up off.
  const floor = await admin("rvfloor", 110);
  await sql("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES (?, 1, 'starter', 100, 'cus_1', 'pm_1', 0)", [floor.id]);
  const f = await ends(floor.cookie, await F.automation({ userId: floor.id, spec: ultra, capRun: 300, capMonth: 2000 }), floor.id);
  assert.equal(f.file.run.outcome, "topup_floor");
  assert.match(f.file.run.noteText, /\(100 credits\)/);
  const choose = (enabled: boolean, below: number) => TU.setAutoTopUp({ id: floor.id, email: `${floor.id}@example.com` }, { enabled, pack: "starter", below }, BASE);
  await choose(true, 300);
  assert.deepEqual(await f.now(), { noteText: f.file.run.noteText, matches: true }, "the level raised since");
  await choose(false, 300);
  assert.deepEqual(await f.now(), { noteText: f.file.run.noteText, matches: true }, "auto top-up off since");
});

test("resuming an automation paused mid-run lets that run go on; its next slot isn't skipped as overlap", async () => {
  const { cookie, id } = await admin("rv2");
  const aid = await create(cookie, DAILY);
  const worst = (await priceOf(cookie, DAILY)).worst;
  // Its run had done its AI step when the owner paused it: the runner parked it after that step.
  const rid = await F.runRow({ automationId: aid, userId: id, origin: "schedule", status: "running", step: "n1", runKey: "sched:1" });
  await sql(`UPDATE automation_runs SET credits = 3, vars_json = '{"a1":"Sunny today."}' WHERE id = ?`, [rid]);
  assert.equal((await patch(cookie, aid, { status: "paused" })).status, 200);
  await sql("UPDATE automation_runs SET parked = 1 WHERE id = ?", [rid]);
  assert.equal((await patch(cookie, aid, { status: "on", seenMax: worst })).status, 200);
  assert.equal((await one<{ parked: number }>("SELECT parked FROM automation_runs WHERE id = ?", [rid]))!.parked, 0, "it goes on");
  await sql(`UPDATE automation_runs SET lease_owner = 'w:' || id, lease_until = ${NOW} + 120000 WHERE id = ?`, [rid]);
  await R.advanceRun(rid, `w:${rid}`, Date.now() + 760_000);
  assert.equal((await one<{ status: string }>("SELECT status FROM automation_runs WHERE id = ?", [rid]))!.status, "done", "and delivers");
  const T = await import("../src/lib/server/automation-tick.ts");
  await sql("UPDATE automations SET next_at = ? WHERE id = ?", [Date.now() - 1000, aid]);
  await T.runTick("tk", { dispatch: async () => {} });
  const slot = await one<{ status: string; outcome: string }>("SELECT status, outcome FROM automation_runs WHERE automation_id = ? AND id <> ? ORDER BY created_at DESC LIMIT 1", [aid, rid]);
  assert.notEqual(slot!.outcome, "overlap");
});

test("Run once now times its run from the request: time spent pricing it comes out of the steps' time, never on top", async () => {
  const u = await admin("rv2deadline");
  // Its own words, so the estimate's count isn't one kept from another test.
  const spec: Spec = { ...F.WRITE_SPEC, steps: [{ id: "a1", do: "ai", mode: "write", level: "sonic", prompt: "Write one line about the deadline." }, { id: "n1", do: "notify" }] };
  const aid = await F.automation({ userId: u.id, spec, capRun: 100_000, capMonth: 100_000 });
  // A step whose budget needs all but half a second of the time a request's run may use; pricing takes a second.
  const budget = A.STEP_BUDGET_MS.write;
  A.STEP_BUDGET_MS.write = API.OWNER_RUN_MS - 500;
  slowCounts = 1;
  try {
    const r = await runRoute.POST(req(`/api/automations/${aid}/run`, { cookie: u.cookie, json: { requestId: "req_deadline", seenMax: 100_000 } }), ctx({ id: aid }));
    assert.equal(r.status, 202);
    await afterwards();
  } finally {
    A.STEP_BUDGET_MS.write = budget;
    slowCounts = 0;
  }
  // Too little time is left in this request for the step: it is handed on to a work call, not started.
  assert.equal(await count("automation_run_steps s JOIN automation_runs r ON r.id = s.run_id", "r.automation_id = ?", [aid]), 0);
  assert.equal((await one<{ lease_owner: string }>("SELECT lease_owner FROM automation_runs WHERE automation_id = ?", [aid]))!.lease_owner, "", "handed on");
});

test("a one-off whose time has come can still be paused or renamed; turning it on checks its time", async () => {
  const { cookie } = await admin("rv3");
  const soon = new Date(Date.now() + 10 * 60_000).toISOString();
  const once: Spec = { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "once", date: soon.slice(0, 10), at: soon.slice(11, 16) } } };
  const aid = await create(cookie, once);
  // Its time comes (the version keeps the time it was saved with).
  const gone = new Date(Date.now() - 60_000).toISOString();
  await sql("UPDATE automation_versions SET spec = ? WHERE automation_id = ?", [JSON.stringify({ ...once, trigger: { type: "schedule", when: { kind: "once", date: gone.slice(0, 10), at: gone.slice(11, 16) } } }), aid]);
  assert.equal((await patch(cookie, aid, { name: "Renamed" })).status, 200);
  assert.equal((await patch(cookie, aid, { status: "paused" })).status, 200);
  // Too late to turn on as it is: the answer says its time has passed (not "check its steps"), and the card shows it.
  const late = await patch(cookie, aid, { status: "on", seenMax: 100_000 });
  assert.equal(late.status, 409);
  const said = await body(late);
  assert.deepEqual([said.code, said.error], ["once_passed", A.ONCE_PASSED]);
  assert.equal((await cardOf(cookie)).automations.find((a) => a.id === aid)?.timePassed, true);
  assert.equal((await one<{ status: string }>("SELECT status FROM automations WHERE id = ?", [aid]))!.status, "paused", "nothing changed");
});

test("a paused one-off whose time is under 2 minutes away but still to come isn't said to have passed: turned on as it is, it runs then", async () => {
  const { cookie } = await admin("rv3near");
  const soon = new Date(Date.now() + 10 * 60_000).toISOString();
  const once: Spec = { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "once", date: soon.slice(0, 10), at: soon.slice(11, 16) } } };
  const worst = (await priceOf(cookie, once)).worst;
  const aid = await create(cookie, once);
  assert.equal((await patch(cookie, aid, { status: "paused" })).status, 200);
  // Its saved time is now 30 to 90 seconds away.
  const near = new Date(Date.now() + 90_000).toISOString();
  const when = { kind: "once" as const, date: near.slice(0, 10), at: near.slice(11, 16) };
  await sql("UPDATE automation_versions SET spec = ? WHERE automation_id = ?", [JSON.stringify({ ...once, trigger: { type: "schedule", when } }), aid]);
  assert.equal((await cardOf(cookie)).automations.find((a) => a.id === aid)?.timePassed, false, "Turn on is offered");
  const on = await patch(cookie, aid, { status: "on", seenMax: worst });
  assert.equal(on.status, 200, JSON.stringify(await on.clone().json()));
  assert.equal(Number((await one<{ next_at: number }>("SELECT next_at FROM automations WHERE id = ?", [aid]))!.next_at), Date.parse(`${when.date}T${when.at}:00Z`));
  // A new time still needs to be 2 minutes ahead.
  assert.equal((await patch(cookie, aid, { spec: { ...once, trigger: { type: "schedule", when } }, seenMax: worst })).status, 400);
});

test("a paused one-off turned on in another time zone needs its time there 2 minutes ahead, as a new time does", async () => {
  const { cookie } = await admin("rv3zone");
  // Its time is 40 to 100 s from now in UTC+1, an hour later in UTC (its zone now).
  const there = Math.floor((Date.now() + 100_000) / 60_000) * 60_000;
  const wall = new Date(there + 3_600_000).toISOString();
  const once: Spec = { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "once", date: wall.slice(0, 10), at: wall.slice(11, 16) } } };
  const worst = (await priceOf(cookie, once)).worst;
  const aid = await create(cookie, once);
  assert.equal((await patch(cookie, aid, { status: "paused" })).status, 200);
  const moved = await patch(cookie, aid, { status: "on", timeZone: "Etc/GMT-1", seenMax: worst });
  assert.equal(moved.status, 409);
  assert.equal((await body(moved)).code, "once_passed");
  const kept = (await one<{ status: string; time_zone: string }>("SELECT status, time_zone FROM automations WHERE id = ?", [aid]))!;
  assert.deepEqual([kept.status, kept.time_zone], ["paused", "UTC"], "nothing changed");
});

for (const edit of ["daily", "later", "manual"] as const) {
  test(`a one-off edited while its run is going (${{ daily: "into a daily", later: "to a later time", manual: "to run by hand" }[edit]}) keeps what the edit gave it when that run ends`, async () => {
    const T = await import("../src/lib/server/automation-tick.ts");
    const L = await import("../src/lib/server/leases.ts");
    const { cookie } = await admin(`rv3edit${edit}`);
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    const later = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const once: Spec = { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "once", date: soon.slice(0, 10), at: soon.slice(11, 16) } } };
    const next: Spec =
      edit === "daily"
        ? { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "daily", at: "08:00" } } }
        : edit === "later"
          ? { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "once", date: later.slice(0, 10), at: later.slice(11, 16) } } }
          : F.WRITE_SPEC;
    const aid = await create(cookie, once);
    // Its time comes: the tick takes its slot (next_at 0) and claims its run.
    await sql("UPDATE automations SET next_at = ? WHERE id = ?", [Date.now() - 1000, aid]);
    const sent: { id: string; owner: string }[] = [];
    const rid = async () => (await one<{ id: string }>("SELECT id FROM automation_runs WHERE automation_id = ?", [aid]))?.id;
    await T.runTick(`tk-edit-${edit}`, { dispatch: async (c) => void (c.id === (await rid()) && sent.push(c)) });
    assert.equal(sent.length, 1);
    // The owner edits it while the run's AI step is charged and about to call Claude.
    claude.state.replies.push({ text: "Remember the dentist." });
    let go!: () => void;
    const held = new Promise<void>((r) => (go = r));
    let reached!: () => void;
    const atCharge = new Promise<void>((r) => (reached = r));
    L.probes.at = async (point) => {
      if (point === "after-charge") {
        reached();
        await held;
      }
    };
    try {
      const going = R.advanceRun(sent[0].id, sent[0].owner, Date.now() + 760_000);
      await atCharge;
      const edited = await patch(cookie, aid, { spec: next, seenMax: (await priceOf(cookie, next)).worst });
      assert.equal(edited.status, 200, JSON.stringify(await edited.clone().json()));
      go();
      await going;
    } finally {
      L.probes.at = () => {};
    }
    assert.equal((await one<{ status: string }>("SELECT status FROM automation_runs WHERE id = ?", [sent[0].id]))!.status, "done", "the run follows its own version");
    const a = (await one<{ status: string; next_at: number; version: number }>("SELECT status, next_at, version FROM automations WHERE id = ?", [aid]))!;
    const want = edit === "daily" ? nextFire({ kind: "daily", at: "08:00" }, "UTC", Date.now()) : edit === "later" ? Date.parse(`${later.slice(0, 16)}:00Z`) : 0;
    assert.deepEqual([a.status, Number(a.next_at), Number(a.version)], ["on", want, 2]);
    if (edit === "manual") return;
    // That slot is still to come: a tick then makes its run.
    await sql("UPDATE automations SET next_at = ? WHERE id = ?", [Date.now() - 1000, aid]);
    await T.runTick(`tk-edit-${edit}-2`, { dispatch: async () => {} });
    assert.equal(await count("automation_runs", "automation_id = ?", [aid]), 2);
  });
}

for (const kind of ["once", "daily"] as const) {
  test(`a ${kind} renamed after its slot came, before the tick took it, still runs that slot`, async () => {
    const u = await admin(`rv3${kind}`);
    // The slot came 20 s ago; ticks are a minute apart.
    const slot = Math.floor((Date.now() - 20_000) / 60_000) * 60_000;
    const iso = new Date(slot).toISOString();
    const when = kind === "once" ? { kind: "once" as const, date: iso.slice(0, 10), at: iso.slice(11, 16) } : { kind: "daily" as const, at: iso.slice(11, 16) };
    const aid = await F.automation({ userId: u.id, spec: { ...F.WRITE_SPEC, trigger: { type: "schedule", when } }, nextAt: slot });
    assert.equal((await patch(u.cookie, aid, { name: "Renamed" })).status, 200);
    assert.equal(Number((await one<{ next_at: number }>("SELECT next_at FROM automations WHERE id = ?", [aid]))!.next_at), slot, "its slot is kept");
    const T = await import("../src/lib/server/automation-tick.ts");
    await T.runTick(`tk-rename-${kind}`, { dispatch: async () => {} });
    assert.equal(await count("automation_runs", "automation_id = ? AND run_key = ?", [aid, `sched:${slot}`]), 1);
  });
}

test("a one-off paused while its run is going can be resumed: that run goes on and delivers, and the one-off is finished", async () => {
  const { cookie } = await admin("rv3b");
  const soon = new Date(Date.now() + 10 * 60_000).toISOString();
  const once: Spec = { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "once", date: soon.slice(0, 10), at: soon.slice(11, 16) } } };
  const worst = (await priceOf(cookie, once)).worst;
  const aid = await create(cookie, once);
  // Its time comes: the tick makes its run and claims it.
  const gone = new Date(Date.now() - 60_000).toISOString();
  await sql("UPDATE automation_versions SET spec = ? WHERE automation_id = ?", [JSON.stringify({ ...once, trigger: { type: "schedule", when: { kind: "once", date: gone.slice(0, 10), at: gone.slice(11, 16) } } }), aid]);
  await sql("UPDATE automations SET next_at = ? WHERE id = ?", [Date.now() - 1000, aid]);
  const T = await import("../src/lib/server/automation-tick.ts");
  const sent: { id: string; owner: string }[] = [];
  await T.runTick("tk-once", { dispatch: async (c) => void sent.push(c) });
  assert.equal(sent.length, 1);
  // The owner pauses it while its AI step is going: after that step the run is parked.
  let release!: () => void;
  claude.state.replies.push({ text: "First line.", hold: new Promise((r) => (release = () => r(undefined))) });
  const going = R.advanceRun(sent[0].id, sent[0].owner, Date.now() + 760_000);
  for (const until = Date.now() + 5000; claude.state.open < 1 && Date.now() < until; ) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await patch(cookie, aid, { status: "paused" })).status, 200);
  release();
  await going;
  const parked = await one<{ parked: number; finished_at: number }>("SELECT parked, finished_at FROM automation_runs WHERE id = ?", [sent[0].id]);
  assert.deepEqual([Number(parked!.parked), Number(parked!.finished_at)], [1, 0]);
  assert.equal((await cardOf(cookie)).automations.find((a) => a.id === aid)?.timePassed, false, "Resume is offered");
  // Resume: its run goes on (its time, taken already, isn't checked again), and nothing is scheduled again.
  const resumed = await patch(cookie, aid, { status: "on", seenMax: worst });
  assert.equal(resumed.status, 200, JSON.stringify(await resumed.clone().json()));
  const a = await one<{ status: string; next_at: number }>("SELECT status, next_at FROM automations WHERE id = ?", [aid]);
  assert.deepEqual([a!.status, Number(a!.next_at)], ["on", 0]);
  for (let i = 0; i < 2; i++) await T.runTick(`tk-once-${i}`, { dispatch: async (c) => void sent.push(c) });
  assert.equal(sent.length, 2, "the parked run is claimed again");
  await R.advanceRun(sent[1].id, sent[1].owner, Date.now() + 760_000);
  const done = await one<{ status: string }>("SELECT status FROM automation_runs WHERE id = ?", [sent[0].id]);
  assert.equal(done!.status, "done");
  assert.equal((await one<{ status: string }>("SELECT status FROM automations WHERE id = ?", [aid]))!.status, "finished");
  assert.equal(await count("automation_runs", "automation_id = ?", [aid]), 1, "no second run of the one-off");
});

test("another account's tries at Run now never use up the owner's limit for it", async () => {
  const owner = await admin("rv4");
  const other = await admin("rv5");
  const aid = await create(owner.cookie, F.WRITE_SPEC);
  for (let i = 0; i < 10; i++) {
    const r = await runRoute.POST(req(`/api/automations/${aid}/run`, { cookie: other.cookie, json: { requestId: `abcdefgh${100 + i}`, seenMax: 1000 } }), ctx({ id: aid }));
    assert.equal(r.status, 404);
  }
  claude.state.replies.push({ text: "Mine." });
  assert.equal((await runOnce(owner.cookie, aid, (await priceOf(owner.cookie, F.WRITE_SPEC)).worst)).status, 202);
});

test("charged this month counts only settled charges; an open hold shows apart, as held now", async () => {
  const { cookie, id } = await admin("rv6");
  const aid = await create(cookie, F.WRITE_SPEC);
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, ref, automation_id, created_at, settled_at) VALUES (?, -5, 'automation', 'auto:x1:a1:1', ?, ?, ?)", [id, aid, Date.now(), Date.now()]);
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, ref, automation_id, created_at) VALUES (?, -30, 'automation', 'auto:x2:a1:1', ?, ?)", [id, aid, Date.now()]);
  const one_ = (await body(await oneRoute.GET(req(`/api/automations/${aid}`, { cookie }), ctx({ id: aid })))).automation as { spentThisMonth: number; heldNow: number };
  assert.deepEqual([one_.spentThisMonth, one_.heldNow], [5, 30]);
  const card = await cardOf(cookie);
  assert.deepEqual([card.spentThisMonth, card.heldNow], [5, 30]);
});

test("the card: a run's largest hold (not their sum), runs of an automation being deleted still shown and readable, and the notices' locale", async () => {
  const { cookie, id } = await admin("rv7");
  await sql("UPDATE users SET language = 'ar' WHERE id = ?", [id]);
  const aid = await F.automation({ userId: id });
  const rid = await F.runRow({ automationId: aid, userId: id, status: "done" });
  await sql("UPDATE automation_runs SET finished_at = ? WHERE id = ?", [Date.now(), rid]);
  for (const [n, held] of [[1, 20], [2, 30]]) {
    await sql("INSERT INTO credit_holds (ref, user_id, run_id, held, lease_until, settled_at, credits, created_at) VALUES (?, ?, ?, ?, 0, ?, 1, ?)", [`auto:${rid}:a1:${n}`, id, rid, held, Date.now(), Date.now() + n]);
  }
  let card = await cardOf(cookie);
  const run = card.runs.find((r) => r.id === rid)!;
  assert.deepEqual([run.held, run.holds, run.deleted], [30, 2, false]);
  assert.equal(card.noticeLocale, localeOf("ar"), "the notices' times are written as their text is");
  // Deleted while it ran: its run stays on the card, marked, and its receipt can be read (not acted on).
  await sql("UPDATE automations SET status = 'deleting' WHERE id = ?", [aid]);
  card = await cardOf(cookie);
  assert.equal(card.runs.find((r) => r.id === rid)?.deleted, true);
  assert.equal((await receiptRoute.GET(req(`/api/automations/runs/${rid}`, { cookie }), ctx({ runId: rid }))).status, 200);
  assert.equal((await receiptRoute.POST(req(`/api/automations/runs/${rid}`, { cookie, json: { action: "retry", seenMax: 1000 } }), ctx({ runId: rid }))).status, 404);
  // Its saved receipt can still be compared, and the run marked seen.
  const check = await receiptRoute.POST(req(`/api/automations/runs/${rid}`, { cookie, json: { action: "check", receipt: { prev: "", receipt: { run: rid }, hash: "x" } } }), ctx({ runId: rid }));
  assert.deepEqual([check.status, (await body(check)).matches], [200, false]);
  assert.equal((await receiptRoute.POST(req(`/api/automations/runs/${rid}`, { cookie, json: { action: "read" } }), ctx({ runId: rid }))).status, 200);
  assert.ok(Number((await one<{ seen_at: number }>("SELECT seen_at FROM automation_runs WHERE id = ?", [rid]))!.seen_at) > 0);
});

test("a skipped run's receipt says why, in the reader's words", async () => {
  const { cookie, id } = await admin("rv8");
  const aid = await F.automation({ userId: id, spec: DAILY });
  const rid = await F.runRow({ automationId: aid, userId: id, origin: "schedule", status: "skipped" });
  await sql("UPDATE automation_runs SET outcome = 'missed', finished_at = ? WHERE id = ?", [Date.now(), rid]);
  const r = (await (await receiptRoute.GET(req(`/api/automations/runs/${rid}`, { cookie }), ctx({ runId: rid }))).json()) as { run: { noteText: string }; steps: unknown[] };
  assert.equal(r.steps.length, 0);
  assert.equal(r.run.noteText, A.NOTICES.missed);
});

// The third review's regressions (each failed before its fix).

test("the /admin card's 5 s poll has its own limit: 10 minutes of polling never refuses the card or its buttons", async () => {
  const { cookie, id } = await admin("lim1");
  const aid = await F.automation({ userId: id, status: "paused" });
  await F.runRow({ automationId: aid, userId: id, parked: 1 });
  // 10 minutes at 5 s is 120 loads.
  for (let i = 0; i < 121; i++) assert.equal((await adminRoute.GET(req("/api/admin/automations", { cookie }))).status, 200, `load ${i + 1}`);
  const price = await adminRoute.POST(req("/api/admin/automations", { cookie, json: { action: "price", timeZone: "UTC" } }));
  assert.equal(price.status, 200, "pricing a test automation still works");
});

test("Stop has its own limit: opening receipts and marking notices read never use it up", async () => {
  const { cookie, id } = await admin("lim2");
  const aid = await F.automation({ userId: id });
  for (let i = 0; i < 60; i++) {
    const rid = await F.runRow({ automationId: aid, userId: id });
    await sql("UPDATE automation_runs SET status = 'done', outcome = 'ok', finished_at = ? WHERE id = ?", [Date.now(), rid]);
    assert.equal((await receiptRoute.POST(req(`/api/automations/runs/${rid}`, { cookie, json: { action: "read" } }), ctx({ runId: rid }))).status, 200);
    assert.equal((await noticesRoute.POST(req("/api/notifications", { cookie, json: { read: [] } }))).status, 200);
  }
  // Retries and checks keep theirs (60 / 10 min), apart from Stop's.
  await sql("INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 60, ?)", [`auto:act:${id}`, Date.now() + 600_000]);
  const live = await F.runRow({ automationId: aid, userId: id, status: "running" });
  await sql("UPDATE automation_runs SET lease_owner = 'w:x', lease_until = ? WHERE id = ?", [Date.now() + 600_000, live]);
  const stop = await receiptRoute.POST(req(`/api/automations/runs/${live}`, { cookie, json: { action: "stop" } }), ctx({ runId: live }));
  assert.equal(stop.status, 200);
  assert.equal(Number((await one<{ s: number }>("SELECT stop_requested AS s FROM automation_runs WHERE id = ?", [live]))!.s), 1, "asked to stop");
  assert.equal((await receiptRoute.POST(req(`/api/automations/runs/${live}`, { cookie, json: { action: "retry", seenMax: 1000 } }), ctx({ runId: live }))).status, 429);
});

test("the card says which runs wait: parked ones for Resume, and ones that try again later with their time", async () => {
  const { cookie, id } = await admin("lim3");
  const aid = await F.automation({ userId: id });
  const parked = await F.runRow({ automationId: aid, userId: id, parked: 1 });
  const later = await F.runRow({ automationId: aid, userId: id, status: "running", dueAt: Date.now() + 60_000 });
  const card = (await body(await adminRoute.GET(req("/api/admin/automations", { cookie })))) as unknown as { runs: { id: string; parked: boolean; dueAt: number }[] };
  const of = (rid: string) => card.runs.find((r) => r.id === rid)!;
  assert.deepEqual([of(parked).parked, of(later).parked], [true, false]);
  assert.ok(of(later).dueAt > Date.now(), "its next try");
  const r = (await (await receiptRoute.GET(req(`/api/automations/runs/${parked}`, { cookie }), ctx({ runId: parked }))).json()) as { run: { parked: boolean } };
  assert.equal(r.run.parked, true);
});

test("Run once now at an automation's month limit says so in words, and starts nothing; a run skipped there says why", async () => {
  const { cookie, id } = await admin("lim4");
  const aid = await create(cookie, F.WRITE_SPEC);
  const est = await priceOf(cookie, F.WRITE_SPEC);
  const a = (await one<{ cap_month: number }>("SELECT cap_month FROM automations WHERE id = ?", [aid]))!;
  assert.ok(est.least > 0 && est.least <= est.worst);
  // This month's charges leave one credit less than its AI step needs to start.
  const used = Number(a.cap_month) - est.least + 1;
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, ref, automation_id, created_at, settled_at) VALUES (?, ?, 'automation', 'auto:m1:a1:1', ?, ?, ?)", [id, -used, aid, Date.now(), Date.now()]);
  const r = await runOnce(cookie, aid, est.worst);
  assert.equal(r.status, 409);
  const said = await body(r);
  assert.equal(said.code, "month_cap");
  const { english } = await import("../src/lib/i18n.ts");
  const { nextMonthStart } = await import("../src/lib/schedule.ts");
  const date = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(nextMonthStart(Date.now()));
  assert.equal(said.error, english(A.MONTH_LEFT, { credits: Number(a.cap_month).toLocaleString("en-US"), date }));
  assert.equal(await count("automation_runs", "automation_id = ?", [aid]), 0, "nothing started");
  // A run skipped at the limit (one started before the limit was used) says why.
  const rid = await F.runRow({ automationId: aid, userId: id, status: "skipped" });
  await sql("UPDATE automation_runs SET outcome = 'month_cap', finished_at = ? WHERE id = ?", [Date.now(), rid]);
  const got = (await (await receiptRoute.GET(req(`/api/automations/runs/${rid}`, { cookie }), ctx({ runId: rid }))).json()) as { run: { noteText: string } };
  assert.ok(got.run.noteText.startsWith("Not enough of this month's limit"), got.run.noteText);
});

test("Run once now and Retry without the credits its AI step needs say so in words and start nothing; a run skipped for credits says why", async () => {
  const { cookie, id } = await admin("lim4b", 0);
  const aid = await create(cookie, F.WRITE_SPEC);
  const est = await priceOf(cookie, F.WRITE_SPEC);
  const { english } = await import("../src/lib/i18n.ts");
  // One credit less than its AI step needs to start.
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, ?, 'purchase', 0)", [id, est.least - 1]);
  let r = await runOnce(cookie, aid, est.worst);
  assert.equal(r.status, 409);
  let said = await body(r);
  assert.deepEqual([said.code, said.error], ["no_credits", english(A.NO_CREDITS, { credits: est.least })]);
  assert.equal(await count("automation_runs", "automation_id = ?", [aid]), 0, "nothing started");
  // Enough credits, but not above the auto top-up level: it says that instead.
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, 100, 'purchase', 0)", [id]);
  await sql("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES (?, 1, 'starter', 100, 'cus_1', 'pm_1', 0)", [id]);
  r = await runOnce(cookie, aid, est.worst);
  said = await body(r);
  assert.deepEqual([r.status, said.code, said.error], [409, "no_credits", english(A.NOTICES.topupFloor, { credits: 100 })]);
  // Retry of a run that was skipped for credits: the same, and its receipt says why.
  const rid = await F.runRow({ automationId: aid, userId: id, status: "skipped" });
  await sql("UPDATE automation_runs SET outcome = 'no_credits', finished_at = ? WHERE id = ?", [Date.now(), rid]);
  const again = await receiptRoute.POST(req(`/api/automations/runs/${rid}`, { cookie, json: { action: "retry", seenMax: est.worst } }), ctx({ runId: rid }));
  assert.equal(again.status, 409);
  assert.equal((await body(again)).code, "no_credits");
  assert.equal(await count("automation_runs", "automation_id = ?", [aid]), 1, "nothing started");
  const got = (await (await receiptRoute.GET(req(`/api/automations/runs/${rid}`, { cookie }), ctx({ runId: rid }))).json()) as { run: { noteText: string } };
  assert.equal(got.run.noteText, A.NOTICES.noCredits);
  await sql("DELETE FROM auto_topups WHERE user_id = ?", [id]);
});

test("Run once now while another run's hold takes the account's credits starts: that hold counts as nothing, and the run waits for it", async () => {
  const { cookie, id } = await admin("lim4h", 0);
  const aid = await create(cookie, F.WRITE_SPEC);
  const est = await priceOf(cookie, F.WRITE_SPEC);
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, ?, 'purchase', 0)", [id, est.least + 40]);
  // Another automation's step holds 50 of them right now.
  const other = await F.automation({ userId: id });
  const busy = await F.runRow({ automationId: other, userId: id, status: "running" });
  await sql(`UPDATE automation_runs SET lease_owner = 'x', lease_until = ${NOW} + 600000 WHERE id = ?`, [busy]);
  const ref = `auto:${busy}:a1:1`;
  await sql(`INSERT INTO credit_holds (ref, user_id, run_id, held, model, input_cents, left_cents, lease_until, created_at) VALUES (?, ?, ?, 50, 'm', 0, 0, ${NOW} + 600000, ${NOW})`, [ref, id, busy]);
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, ref, automation_id, created_at) VALUES (?, -50, 'automation', ?, ?, ?)", [id, ref, other, Date.now()]);
  assert.ok((await F.balance(id)) < est.least);
  const r = await runOnce(cookie, aid, est.worst);
  assert.equal(r.status, 202, JSON.stringify(await r.clone().json()));
  const run = (await one<{ status: string; outcome: string; credits: number }>("SELECT status, outcome, credits FROM automation_runs WHERE automation_id = ?", [aid]))!;
  assert.deepEqual([run.status, run.outcome, Number(run.credits)], ["queued", "", 0], "it waits for the other hold, for free");
});

test("Run once now while its own other run's hold takes the month's limit starts: that hold counts as nothing there too", async () => {
  const { cookie, id } = await admin("lim4m");
  const aid = await create(cookie, F.WRITE_SPEC);
  const est = await priceOf(cookie, F.WRITE_SPEC);
  const a = (await one<{ cap_month: number }>("SELECT cap_month FROM automations WHERE id = ?", [aid]))!;
  // Its scheduled run's step holds all but one credit less than its AI step needs of the month.
  const busy = await F.runRow({ automationId: aid, userId: id, status: "running" });
  await sql(`UPDATE automation_runs SET lease_owner = 'x', lease_until = ${NOW} + 600000 WHERE id = ?`, [busy]);
  const ref = `auto:${busy}:a1:1`;
  const held = Number(a.cap_month) - est.least + 1;
  await sql(`INSERT INTO credit_holds (ref, user_id, run_id, held, model, input_cents, left_cents, lease_until, created_at) VALUES (?, ?, ?, ?, 'm', 0, 0, ${NOW} + 600000, ${NOW})`, [ref, id, busy, held]);
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, ref, automation_id, created_at) VALUES (?, ?, 'automation', ?, ?, ?)", [id, -held, ref, aid, Date.now()]);
  assert.ok((await F.balance(id)) >= est.least, "the account has the credits");
  const r = await runOnce(cookie, aid, est.worst);
  assert.equal(r.status, 202, JSON.stringify(await r.clone().json()));
  const run = (await one<{ status: string; outcome: string }>("SELECT status, outcome FROM automation_runs WHERE automation_id = ? AND id <> ?", [aid, busy]))!;
  assert.deepEqual([run.status, run.outcome], ["queued", ""], "it waits for the other hold, for free");
});

test("the burn-in form's pricing has the estimate's limit: writing an instruction never uses up making a test, nor the other way round", async () => {
  const { cookie, id } = await admin("lim4c");
  // Making tests has used up its 60 in 10 minutes.
  await sql("INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 60, ?)", [`auto:admin:${id}`, Date.now() + 600_000]);
  const price = await adminRoute.POST(req("/api/admin/automations", { cookie, json: { action: "price", timeZone: "UTC" } }));
  assert.equal(price.status, 200, "pricing still answers");
  const make = await adminRoute.POST(req("/api/admin/automations", { cookie, json: { action: "make", kind: "daily", timeZone: "UTC", seenMax: 100_000 } }));
  assert.equal(make.status, 429);
  assert.equal(Number((await one<{ count: number }>("SELECT count FROM rate_limits WHERE key = ?", [`auto:estimate:${id}`]))!.count), 1);
});

test("a notice names its automation once: in its title, not again in its line", async () => {
  const { cookie } = await admin("lim5");
  const aid = await create(cookie, F.WRITE_SPEC, { name: "A rather long automation name for the notice" });
  claude.state.replies.push({ text: "**Sunny** all day." });
  assert.equal((await runOnce(cookie, aid, (await priceOf(cookie, F.WRITE_SPEC)).worst)).status, 202);
  const card = (await body(await adminRoute.GET(req("/api/admin/automations", { cookie })))) as unknown as { notices: { title: string; text: string; body?: string }[] };
  const notice = card.notices.find((n) => n.title === "A rather long automation name for the notice")!;
  assert.ok(notice, "the run's notice");
  assert.equal(notice.text, A.NOTICES.ready);
  assert.equal(notice.text.includes("A rather long"), false);
  // The answer as one plain line: no Markdown marks in the bell.
  assert.equal(notice.body, "Sunny all day.");
});

// The fourth review's regressions (each failed before its fix).

test("a spec whose next jumps over its AI step is refused on create and on edit, saving nothing", async () => {
  const { cookie } = await admin("r5skip", 0);
  const skips = {
    v: 1,
    trigger: { type: "schedule", when: { kind: "hourly", every: 1, from: "00:00", to: "23:00" } },
    steps: [
      { id: "n1", do: "notify", text: "Drink a glass of water.", next: "n2" },
      { id: "a1", do: "ai", mode: "research", level: "ultra", prompt: "Never reached." },
      { id: "n2", do: "notify", text: "Stretch for a minute." },
    ],
  };
  const est = await estimateRoute.POST(req("/api/automations/estimate", { cookie, json: { spec: skips, timeZone: "UTC" } }));
  assert.equal(est.status, 400);
  const made = await listRoute.POST(req("/api/automations", { cookie, json: { spec: skips, name: "Water", timeZone: "UTC", seenMax: 100_000 } }));
  assert.equal(made.status, 400);
  assert.equal((await body(made)).error, A.SPEC_INVALID);
  const aid = await create(cookie, F.WRITE_SPEC);
  const edit = await oneRoute.PATCH(req(`/api/automations/${aid}`, { cookie, method: "PATCH", json: { spec: skips, seenMax: 100_000 } }), ctx({ id: aid }));
  assert.equal(edit.status, 400);
  assert.equal(Number((await one<{ version: number }>("SELECT version FROM automations WHERE id = ?", [aid]))!.version), 1, "no new version");
});

test("an estimate whose token count never answers is priced at its most within its count's own short time, never the SDK's 10 minutes", { timeout: 20_000 }, async () => {
  const { STEP_TIMING } = await import("../src/lib/server/automation-steps.ts");
  const was = STEP_TIMING.countMs;
  STEP_TIMING.countMs = 300;
  claude.state.count.silent = true;
  try {
    const { cookie } = await admin("r5count");
    const start = Date.now();
    const r = await Promise.race([estimateRoute.POST(req("/api/automations/estimate", { cookie, json: { spec: F.WRITE_SPEC, timeZone: "UTC" } })), new Promise<null>((ok) => setTimeout(() => ok(null), 10_000))]);
    assert.ok(r, "the estimate answered");
    assert.equal(r.status, 200);
    assert.equal((await body(r)).estimate.counted, false, "priced at the most the text can be");
    assert.ok(Date.now() - start < 5000);
  } finally {
    STEP_TIMING.countMs = was;
  }
});

test("/admin's function time counts a step left behind by a server that stopped at most the longest a step may take", async () => {
  const u = await admin("r5time");
  const aid = await F.automation({ userId: u.id });
  const rid = await F.runRow({ automationId: aid, userId: u.id });
  const now = Date.now();
  // A step started 3 hours before it was closed (its server stopped; a later claim closed it).
  await sql("INSERT INTO automation_run_steps (run_id, step_id, attempt, user_id, kind, status, started_at, finished_at) VALUES (?, 'a1', 1, ?, 'ai', 'interrupted', ?, ?)", [rid, u.id, now - 3 * 3_600_000, now]);
  await sql("UPDATE automation_runs SET status = 'interrupted', outcome = 'interrupted', finished_at = ? WHERE id = ?", [now, rid]);
  const before = (await automationStats(1)).functionSeconds;
  await sql("DELETE FROM automation_run_steps WHERE run_id = ?", [rid]);
  const without = (await automationStats(1)).functionSeconds;
  assert.equal(before - without, Math.max(...Object.values(A.STEP_BUDGET_MS)) / 1000);
});

test("cron health: lag reads the week's newest scheduled runs, Queued counts only runs due now, and Peak spend only what was charged", async () => {
  const u = await admin("r5health");
  const aid = await F.automation({ userId: u.id });
  const now = Date.now();
  const d = await (await import("../src/lib/server/db.ts")).db();
  // 5,000 runs six days ago that started 1 s after their slot, then 1,000 in the last hour that started 10 minutes late.
  const rows = (count: number, at: number, lag: number, tag: string) =>
    Array.from({ length: count }, (_, i) => ({
      sql: `INSERT INTO automation_runs (id, automation_id, user_id, version, run_key, origin, root_origin, status, outcome, due_at, grace_until, scheduled_at, started_at, finished_at, created_at, updated_at)
            VALUES (?, ?, ?, 1, ?, 'schedule', 'schedule', 'done', 'ok', ?, ?, ?, ?, ?, ?, ?)`,
      args: [`${tag}${i}`, aid, u.id, `slot:${tag}${i}`, at + i, at + i + 900_000, at + i, at + i + lag, at + i + lag + 1000, at + i, at + i],
    }));
  await d.batch(rows(5000, now - 6 * 86_400_000, 1000, "r5old"), "write");
  await d.batch(rows(1000, now - 3_600_000, 600_000, "r5new"), "write");
  const h = await cronHealth();
  assert.deepEqual([h.lagP95Sec, h.lagRuns], [600, 5000], "a tick late now shows");
  await sql("DELETE FROM automation_runs WHERE automation_id = ?", [aid]);
  // A run waiting for its next try (Claude was busy) isn't waiting for room; one due now is.
  await F.runRow({ automationId: aid, userId: u.id, dueAt: Date.now() + 300_000 });
  assert.equal((await cronHealth()).queued, h.queued);
  await F.runRow({ automationId: aid, userId: u.id });
  assert.equal((await cronHealth()).queued, h.queued + 1);
  await sql("DELETE FROM automation_runs WHERE automation_id = ?", [aid]);
  // A hold still open is a step's worst case, not spent: the peak is what was charged. (In a minute of
  // its own, three days ago, so other tests' charges don't add to it.)
  const minute = Math.floor((Date.now() - 3 * 86_400_000) / 60_000) * 60_000 + 30_000;
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, ref, automation_id, created_at, settled_at) VALUES (?, -100000, 'automation', 'auto:r5peak:a1:1', ?, ?, 0)", [u.id, aid, minute]);
  assert.ok((await cronHealth()).peakCreditsPerMinute < 100_000);
  await sql("UPDATE credit_ledger SET amount = -99999, settled_at = ? WHERE ref = 'auto:r5peak:a1:1'", [Date.now()]);
  assert.equal((await cronHealth()).peakCreditsPerMinute, 99_999);
  await sql("DELETE FROM credit_ledger WHERE ref = 'auto:r5peak:a1:1'");
});

test("Retry and the card's Run once now count against Run now's limits, and the card's make against Save's: 429, nothing made or started", async () => {
  const { cookie, id } = await admin("r5limits", 100_000);
  const aid = await create(cookie, F.WRITE_SPEC);
  const est = await priceOf(cookie, F.WRITE_SPEC);
  claude.state.replies = [{ cut: true }];
  const first = await runOnce(cookie, aid, est.worst);
  const rid = ((await body(first)).run as { id: string }).id;
  assert.equal((await one<{ status: string }>("SELECT status FROM automation_runs WHERE id = ?", [rid]))!.status, "failed");
  const full = (key: string, n: number) => sql("INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count", [key, n, Date.now() + 3_600_000]);
  const free = (key: string) => sql("DELETE FROM rate_limits WHERE key = ?", [key]);
  const retry = () => receiptRoute.POST(req(`/api/automations/runs/${rid}`, { cookie, json: { action: "retry", seenMax: est.worst } }), ctx({ runId: rid }));
  const calls = claude.streamed().length;
  for (const [key, n] of [[`auto:runUser:${id}`, 30], [`auto:runAutomation:${id}:${aid}`, 10]] as const) {
    await full(key, n);
    assert.equal((await retry()).status, 429, key);
    await free(key);
  }
  assert.equal(await count("automation_runs", "automation_id = ?", [aid]), 1, "no run started");
  const priced = (await body(await adminRoute.POST(req("/api/admin/automations", { cookie, json: { action: "price", timeZone: "UTC" } })))).prices as Record<"manual", Estimate>;
  const make = () => adminRoute.POST(req("/api/admin/automations", { cookie, json: { action: "make", kind: "manual", run: true, timeZone: "UTC", seenMax: priced.manual.worst } }));
  for (const [key, n] of [[`auto:runUser:${id}`, 30], [`auto:create:${id}`, 30]] as const) {
    await full(key, n);
    assert.equal((await make()).status, 429, key);
    await free(key);
  }
  await afterwards();
  assert.equal(await count("automations", "user_id = ?", [id]), 1, "nothing made");
  assert.equal(claude.streamed().length, calls, "nothing called");
});

test("the card's Run once now refused for credits leaves no automation behind: pressing it again never fills the account", async () => {
  const { cookie, id } = await admin("r5refused", 0);
  const priced = (await body(await adminRoute.POST(req("/api/admin/automations", { cookie, json: { action: "price", timeZone: "UTC" } })))).prices as Record<"manual", Estimate>;
  for (let i = 0; i < 3; i++) {
    const r = await adminRoute.POST(req("/api/admin/automations", { cookie, json: { action: "make", kind: "manual", run: true, timeZone: "UTC", seenMax: priced.manual.worst } }));
    assert.equal(r.status, 409);
    assert.equal((await body(r)).code, "no_credits");
  }
  assert.equal(await count("automations", "user_id = ?", [id]), 0);
  assert.equal(await count("automation_versions", "automation_id NOT IN (SELECT id FROM automations)", []), 0);
  assert.equal(await count("automation_runs", "user_id = ?", [id]), 0);
});

test("a refusal for credits writes its number in the reader's digits, as the month's refusal does", async () => {
  const { cookie, id } = await admin("r5digits", 0);
  await sql("UPDATE users SET language = 'ar' WHERE id = ?", [id]);
  const aid = await create(cookie, F.WRITE_SPEC);
  const est = await priceOf(cookie, F.WRITE_SPEC);
  const r = await runOnce(cookie, aid, est.worst);
  assert.equal(r.status, 409);
  const said = (await body(r)).error;
  assert.ok(said.includes(est.least.toLocaleString(localeOf("ar"))) && !/[0-9]/.test(said), said);
});

test("a failed run's receipt, and a cut-short one's, say why", async () => {
  const { cookie, id } = await admin("r5notes");
  await sql("UPDATE users SET language = 'ar' WHERE id = ?", [id]);
  const aid = await F.automation({ userId: id });
  const { translatorIn } = await import("../src/lib/server/i18n.ts");
  const ar = await translatorIn("ar");
  // A run that failed part way was refunded what it used (see REFUNDED), so it says nothing was charged too.
  for (const [outcome, status, credits, refunded, said] of [
    ["failed", "failed", 0, 0, ar(A.NOTICES.failed)],
    ["failed", "failed", 0, 3, ar(A.NOTICES.failed)],
    ["interrupted", "interrupted", 0, 4, ar(A.NOTICES.interrupted)],
    ["cut_short", "done", 2, 0, ar(A.NOTICES.cutShort)],
  ] as const) {
    const rid = await F.runRow({ automationId: aid, userId: id, status });
    await sql("UPDATE automation_runs SET outcome = ?, credits = ?, refunded = ?, finished_at = ? WHERE id = ?", [outcome, credits, refunded, Date.now(), rid]);
    const r = (await (await receiptRoute.GET(req(`/api/automations/runs/${rid}`, { cookie }), ctx({ runId: rid }))).json()) as { run: { noteText: string; credits: number; refunded: number } };
    assert.equal(r.run.noteText, said);
    assert.deepEqual([r.run.credits, r.run.refunded], [credits, refunded]);
    assert.ok(!/[A-Za-z]{4}/.test(said.replace("Flash", "")), `in the reader's words: ${said}`);
  }
});

test("the admin card's one-off in 3 minutes, made in the repeated hour of a fall-back night, is made for 3 minutes ahead", async () => {
  const realNow = Date.now;
  for (const [zone, moment] of [["America/Toronto", "2026-11-01T06:10:00Z"], ["Europe/London", "2026-10-25T01:20:00Z"], ["Australia/Lord_Howe", "2027-04-03T15:10:00Z"]] as const) {
    Date.now = () => Date.parse(moment) + (realNow() % 1000);
    try {
      // Signed in that night (a session doesn't last until 2027).
      const { cookie } = await admin(`fallback${zone.length}`);
      const prices = (await body(await adminRoute.POST(req("/api/admin/automations", { cookie, json: { action: "price", timeZone: zone } })))).prices as Record<"once", Estimate>;
      const made = await adminRoute.POST(req("/api/admin/automations", { cookie, json: { action: "make", kind: "once", timeZone: zone, seenMax: prices.once.worst } }));
      assert.equal(made.status, 201, zone);
      const ahead = ((await body(made)).automation as { nextAt: number }).nextAt - Date.now();
      assert.ok(ahead > 2 * 60_000 && ahead <= 4 * 60_000, `${zone}: about 3 minutes ahead (${ahead} ms)`);
    } finally {
      Date.now = realNow;
    }
  }
});

test("a receipt shows a step's waits for other runs' holds in a row once, with why, never as tries; its fingerprint counts them, and the card says the run waits", async () => {
  const { cookie, id } = await admin("rv7wait");
  const aid = await create(cookie, F.WRITE_SPEC);
  // It waited twice, tried once (busy), and waited again.
  const rid = await F.runRow({ automationId: aid, userId: id, attempts: 4 });
  const row = (attempt: number, note: string) =>
    sql("INSERT INTO automation_run_steps (run_id, step_id, attempt, user_id, kind, status, note, started_at, finished_at) VALUES (?, 'a1', ?, ?, 'ai', 'retried', ?, ?, ?)", [rid, attempt, id, note, attempt, attempt]);
  for (const [attempt, note] of [[1, "waiting"], [2, "waiting"], [3, "busy"], [4, "waiting"]] as const) await row(attempt, note);
  await sql("UPDATE automation_runs SET due_at = ? WHERE id = ?", [Date.now() + 60_000, rid]);
  type Got = {
    run: { status: string; waiting: boolean };
    steps: { stepId: string; status: string; attempt: number; waits: number; noteText: string }[];
    receipt: { receipt: { steps: { id: string; attempt: number; status: string }[]; waited?: number } } | null;
  };
  const get = async () => (await (await receiptRoute.GET(req(`/api/automations/runs/${rid}`, { cookie }), ctx({ runId: rid }))).json()) as Got;
  const shown = (r: Got) => r.steps.map((s) => [s.stepId, s.status, s.attempt, s.waits]);
  let r = await get();
  assert.equal(r.run.waiting, true, "it waits for another run's hold");
  assert.equal((await cardOf(cookie)).runs.find((x) => x.id === rid)!.waiting, true, "the card says so too");
  // Its last wait goes on now, and says why; the earlier ones were waited.
  assert.deepEqual(shown(r), [["a1", "waited", 0, 2], ["a1", "retried", 1, 0], ["a1", "waiting", 0, 1]]);
  assert.deepEqual(r.steps.map((s) => s.noteText), ["", "", A.NOTICES.waitingHold], "with why");
  // Parked with its paused automation, it waits for Resume, not for a hold: its wait is over, and says nothing of a minute.
  await sql("UPDATE automation_runs SET parked = 1 WHERE id = ?", [rid]);
  assert.deepEqual((await get()).steps.map((s) => [s.status, s.noteText]), [["waited", ""], ["retried", ""], ["waited", ""]]);
  await sql("UPDATE automation_runs SET parked = 0 WHERE id = ?", [rid]);
  // It runs: its waits stay out of its tries and its fingerprinted steps, which count them.
  claude.state.replies.push({ text: "Clear skies all day." });
  await sql(`UPDATE automation_runs SET due_at = 0, status = 'running', lease_owner = 'w:' || id, lease_until = ${NOW} + 120000 WHERE id = ?`, [rid]);
  await R.advanceRun(rid, `w:${rid}`, Date.now() + 760_000);
  r = await get();
  assert.deepEqual([r.run.status, r.run.waiting], ["done", false]);
  assert.equal((await cardOf(cookie)).runs.find((x) => x.id === rid)!.waiting, false);
  assert.deepEqual(shown(r), [["a1", "waited", 0, 2], ["a1", "retried", 1, 0], ["a1", "waited", 0, 1], ["a1", "done", 2, 0], ["n1", "done", 1, 0]]);
  assert.deepEqual(r.receipt!.receipt.steps.map((s) => [s.id, s.attempt, s.status]), [["a1", 1, "retried"], ["a1", 2, "done"], ["n1", 1, "done"]]);
  assert.equal(r.receipt!.receipt.waited, 3);
  // Its download is checked against that fingerprint.
  const saved = await (await receiptRoute.GET(req(`/api/automations/runs/${rid}?format=json`, { cookie }), ctx({ runId: rid }))).json();
  const check = async (receipt: unknown) => ((await (await receiptRoute.POST(req(`/api/automations/runs/${rid}`, { cookie, json: { action: "check", receipt } }), ctx({ runId: rid }))).json()) as { matches: boolean }).matches;
  assert.equal(await check(saved), true);
  const changed = JSON.parse(JSON.stringify(saved)) as Got;
  changed.steps[3].status = "failed";
  assert.equal(await check(changed), false, "a try changed");
  // Its wait lines are checked too: their count against the fingerprint's, and each against Flash's record.
  type Line = Record<string, unknown>;
  const edit = (f: (steps: Line[]) => void) => {
    const copy = JSON.parse(JSON.stringify(saved)) as { steps: Line[] };
    f(copy.steps);
    return copy;
  };
  assert.equal(await check(edit((x) => Object.assign(x[0], { waits: 14 }))), false, "more waits");
  assert.equal(await check(edit((x) => Object.assign(x[0], { held: 31 }))), false, "a hold while it waited");
  assert.equal(await check(edit((x) => Object.assign(x[0], { credits: 25 }))), false, "a charge while it waited");
  assert.equal(await check(edit((x) => Object.assign(x[0], { status: "done" }))), false, "a wait that ran");
  assert.equal(await check(edit((x) => Object.assign(x[0], { noteText: "Charged 25 credits while waiting." }))), false, "a note");
  assert.equal(await check(edit((x) => void x.push({ ...x[2] }))), false, "a wait line added");
  assert.equal(await check(edit((x) => void x.splice(2, 1))), false, "a wait line left out");
  // Moved between lines, the count still adds up, but the lines aren't Flash's.
  assert.equal(await check(edit((x) => Object.assign(x[0], { waits: 1 }) && Object.assign(x[2], { waits: 2 }))), false, "waits moved");
  // A row that isn't an object makes a file that doesn't match, never an error.
  assert.equal(await check(edit((x) => void x.splice(1, 0, null as unknown as Line))), false, "a row that isn't one");
  // Flash's record of its waits changed after the run ended, and the file edited to say the same: the fingerprint's count still decides.
  await sql("DELETE FROM automation_run_steps WHERE run_id = ? AND attempt = 2 AND note = 'waiting'", [rid]);
  assert.equal(await check(edit((x) => Object.assign(x[0], { waits: 1 }))), false, "fewer waits than the fingerprint counts");
  assert.equal(await check(edit((x) => void (Object.assign(x[0], { waits: 1 }) && x.push({ ...x[2] })))), false, "a line added to make up the count");
});

test("a blank burn-in instruction is refused (400), never priced or made with another text in its place", async () => {
  const { cookie, id } = await admin("rv7blank");
  const counts = counted();
  for (const prompt of ["", "   \n\t "]) {
    const price = await adminRoute.POST(req("/api/admin/automations", { cookie, json: { action: "price", prompt, timeZone: "UTC" } }));
    assert.equal(price.status, 400, JSON.stringify(prompt));
    assert.equal((await body(price)).error, "Write an instruction first.");
    const make = await adminRoute.POST(req("/api/admin/automations", { cookie, json: { action: "make", kind: "manual", run: true, prompt, timeZone: "UTC", seenMax: 100_000 } }));
    assert.equal(make.status, 400, JSON.stringify(prompt));
  }
  assert.equal(counted(), counts, "nothing counted");
  assert.equal(await count("automations", "user_id = ?", [id]), 0, "nothing made");
  // Left out, it is the card's own example.
  assert.equal((await adminRoute.POST(req("/api/admin/automations", { cookie, json: { action: "price", timeZone: "UTC" } }))).status, 200);
});

// The seventh review's regressions (each failed before its fix).

const onceAt = (t: number): Spec => {
  const iso = new Date(t).toISOString();
  return { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "once", date: iso.slice(0, 10), at: iso.slice(11, 16) } } };
};
const rowOf = (id: string) => one<{ status: string; next_at: number; resume_at: number; paused_reason: string }>("SELECT status, next_at, resume_at, paused_reason FROM automations WHERE id = ?", [id]);

test("a paused one-off moved to a new time waits for that time: its next slot and the pause's next look move with it", async () => {
  const T = await import("../src/lib/server/automation-tick.ts");
  const u = await admin("rv70", 500);
  const T1 = Math.floor((Date.now() + 10 * 60_000) / 60_000) * 60_000;
  // Paused for credits (a daily paused so, edited into this one-off): looked at again at its time.
  const aid = await F.automation({ userId: u.id, spec: onceAt(T1), status: "paused", pausedReason: "credits", resumeAt: T1, nextAt: T1, capRun: 100_000, capMonth: 100_000 });
  const T2 = Math.floor((Date.now() + 2 * 86_400_000) / 60_000) * 60_000;
  const moved = onceAt(T2);
  assert.equal((await patch(u.cookie, aid, { spec: moved, seenMax: (await priceOf(u.cookie, moved)).worst })).status, 200);
  assert.deepEqual(await rowOf(aid), { status: "paused", next_at: T2, resume_at: T2, paused_reason: "credits" }, "both at the new time");
  // T1 comes and goes: nothing runs.
  await T.runTick("tk-rv70", { dispatch: async () => {} });
  assert.equal(await count("automation_runs", "automation_id = ?", [aid]), 0);
  // T2 comes (moved into the past by as much, both together): its slot runs.
  const shift = T2 - Date.now() + 1000;
  await sql("UPDATE automations SET next_at = next_at - ?, resume_at = resume_at - ? WHERE id = ?", [shift, shift, aid]);
  await T.runTick("tk-rv70b", { dispatch: async () => {} });
  const keys = await all<{ run_key: string }>("SELECT run_key FROM automation_runs WHERE automation_id = ?", [aid]);
  assert.deepEqual(keys.map((k) => k.run_key), [`sched:${T2 - shift}`], "its new time's slot");
  // A daily paused at its month limit, edited into a one-off: its pause is looked at by that one-off's time, not next month.
  const daily = await F.automation({ userId: u.id, spec: { ...moved, trigger: { type: "schedule", when: { kind: "daily", at: "08:00" } } }, status: "paused", pausedReason: "month_cap", resumeAt: Date.now() + 20 * 86_400_000, nextAt: Date.now() + 3_600_000, capRun: 100_000, capMonth: 100_000 });
  assert.equal((await patch(u.cookie, daily, { spec: moved, seenMax: (await priceOf(u.cookie, moved)).worst })).status, 200);
  assert.deepEqual(await rowOf(daily), { status: "paused", next_at: T2, resume_at: T2, paused_reason: "month_cap" });
  // A rename keeps both as they were.
  assert.equal((await patch(u.cookie, daily, { name: "Renamed" })).status, 200);
  assert.deepEqual([Number((await rowOf(daily))!.next_at), Number((await rowOf(daily))!.resume_at)], [T2, T2]);
  // A daily paused for credits, moved to another time of day: it tries again at its new next slot, not at its old one.
  const at = (hhmm: string): Spec => ({ ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "daily", at: hhmm } } });
  const old = Date.now() + 20 * 3_600_000;
  const short = await F.automation({ userId: u.id, spec: at(new Date(old).toISOString().slice(11, 16)), status: "paused", pausedReason: "credits", resumeAt: old + 3_600_000, nextAt: old, capRun: 100_000, capMonth: 100_000 });
  // Renamed, it keeps both.
  assert.equal((await patch(u.cookie, short, { name: "Renamed too" })).status, 200);
  assert.deepEqual([Number((await rowOf(short))!.next_at), Number((await rowOf(short))!.resume_at)], [old, old + 3_600_000]);
  const evening = at(new Date(Date.now() + 2 * 3_600_000).toISOString().slice(11, 16));
  assert.equal((await patch(u.cookie, short, { spec: evening, seenMax: (await priceOf(u.cookie, evening)).worst })).status, 200);
  const row = (await rowOf(short))!;
  assert.ok(Number(row.next_at) > Date.now() && Number(row.next_at) < Date.now() + 3 * 3_600_000, "its new slot, today");
  assert.equal(Number(row.resume_at), Number(row.next_at), "its pause is looked at again then");
});

test("a one-off paused while its run is going and moved to a new time keeps that time when resumed, and isn't finished by the old run's end", async () => {
  const { cookie } = await admin("rv71");
  const soon = new Date(Date.now() + 10 * 60_000).toISOString();
  const once: Spec = { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "once", date: soon.slice(0, 10), at: soon.slice(11, 16) } } };
  const aid = await create(cookie, once);
  const gone = new Date(Date.now() - 60_000).toISOString();
  await sql("UPDATE automation_versions SET spec = ? WHERE automation_id = ?", [JSON.stringify({ ...once, trigger: { type: "schedule", when: { kind: "once", date: gone.slice(0, 10), at: gone.slice(11, 16) } } }), aid]);
  await sql("UPDATE automations SET next_at = ? WHERE id = ?", [Date.now() - 1000, aid]);
  const T = await import("../src/lib/server/automation-tick.ts");
  const sent: { id: string; owner: string }[] = [];
  await T.runTick("tk-rv71", { dispatch: async (c) => void sent.push(c) });
  assert.equal(sent.length, 1);
  let release!: () => void;
  claude.state.replies.push({ text: "First line.", hold: new Promise((r) => (release = () => r(undefined))) });
  const going = R.advanceRun(sent[0].id, sent[0].owner, Date.now() + 760_000);
  for (const until = Date.now() + 5000; claude.state.open < 1 && Date.now() < until; ) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await patch(cookie, aid, { status: "paused" })).status, 200);
  release();
  await going;
  // While it is paused, its owner moves it to tomorrow.
  const T2 = Math.floor((Date.now() + 27 * 3_600_000) / 60_000) * 60_000;
  const moved = onceAt(T2);
  const worst = (await priceOf(cookie, moved)).worst;
  assert.equal((await patch(cookie, aid, { spec: moved, seenMax: worst })).status, 200);
  const resumed = await patch(cookie, aid, { status: "on", seenMax: worst });
  assert.equal(resumed.status, 200);
  assert.deepEqual([(await rowOf(aid))!.status, Number((await rowOf(aid))!.next_at)], ["on", T2], "the new time is kept");
  // The old run goes on and ends: the one-off stays on for its new time.
  await T.runTick("tk-rv71b", { dispatch: async (c) => void sent.push(c) });
  assert.equal(sent.length, 2);
  await R.advanceRun(sent[1].id, sent[1].owner, Date.now() + 760_000);
  assert.equal((await one<{ status: string }>("SELECT status FROM automation_runs WHERE id = ?", [sent[0].id]))!.status, "done");
  assert.deepEqual([(await rowOf(aid))!.status, Number((await rowOf(aid))!.next_at)], ["on", T2]);
});

test("a step whose own record of its model wasn't kept shows its hold's model in the receipt, once its call was sent; never one that wasn't sent", async () => {
  const H = await import("../src/lib/server/credit-holds.ts");
  const u = await admin("rv72", 100);
  const aid = await F.automation({ userId: u.id });
  const rid = await F.runRow({ automationId: aid, userId: u.id });
  await sql(`UPDATE automation_runs SET status = 'interrupted', outcome = 'interrupted', finished_at = ${NOW} WHERE id = ?`, [rid]);
  for (const [attempt, started] of [[1, 1], [2, 0]] as const) {
    const ref = `auto:${rid}:a1:${attempt}`;
    // Its input and model write failed before the call (they are kept apart from the step's start).
    await sql("INSERT INTO automation_run_steps (run_id, step_id, attempt, user_id, kind, status, note, hold_ref, model, started_at, finished_at) VALUES (?, 'a1', ?, ?, 'ai', 'interrupted', '', ?, '', ?, ?)", [rid, attempt, u.id, ref, attempt, attempt]);
    assert.ok(await H.recordHold({ ref, userId: u.id, runId: rid, held: 20, model: "the-held-model", inputCents: 0.1, leftCents: 0 }));
    await sql("UPDATE credit_holds SET started = ? WHERE ref = ?", [started, ref]);
  }
  const r = (await (await receiptRoute.GET(req(`/api/automations/runs/${rid}`, { cookie: u.cookie }), ctx({ runId: rid }))).json()) as { steps: { attempt: number; model: string }[] };
  assert.deepEqual(r.steps.map((s) => s.model), ["the-held-model", ""]);
});

/*
 * Ultra busy before it starts, so the step steps down to Vision (see steppedDown): the hold is rewritten
 * before Vision is called. `onStepDown` runs just before that write lands (the database's own batch).
 */
async function steppedDown(userId: string, spec: Spec, replies: object[], onStepDown: () => Promise<void>) {
  const aid = await F.automation({ userId, spec, capRun: 5000, capMonth: 50000 });
  const rid = await F.runRow({ automationId: aid, userId });
  claude.state.replies.push(...(replies as never[]));
  const client = await (await import("../src/lib/server/db.ts")).db();
  const batch = client.batch.bind(client);
  (client as unknown as { batch: typeof batch }).batch = (async (stmts: { sql: string }[], mode?: never) => {
    if (typeof stmts[0] === "object" && stmts[0].sql.startsWith("UPDATE credit_holds SET model = ?")) await onStepDown();
    return batch(stmts as never, mode);
  }) as typeof batch;
  const before = claude.streamed().length;
  await sql(`UPDATE automation_runs SET status = 'running', lease_owner = 'w:' || id, lease_until = ${NOW} + 120000 WHERE id = ?`, [rid]);
  return {
    rid,
    sent: () => claude.streamed().slice(before).map((x) => x.body.model),
    run: async (during?: () => Promise<void>) => {
      try {
        const going = R.advanceRun(rid, `w:${rid}`, Date.now() + 760_000);
        await during?.();
        await going;
      } finally {
        (client as unknown as { batch: typeof batch }).batch = batch;
      }
      return (await one<{ status: string; outcome: string }>("SELECT status, outcome FROM automation_runs WHERE id = ?", [rid]))!;
    },
  };
}
const ULTRA_WRITE: Spec = { v: 1, trigger: { type: "manual" }, steps: [{ id: "a1", do: "ai", mode: "write", level: "ultra", prompt: "Write one line about the weather." }, { id: "n1", do: "notify" }] };

test("stepped down, with its hold settled meanwhile by the reaper (its lease ran out while Ultra was busy): the step stops, and Vision is never called", async () => {
  const { LEVEL_MODELS } = await import("../src/lib/engines/claude.ts");
  const { id } = await admin("sd6", 1000);
  let reaped = 0;
  const s = await steppedDown(id, ULTRA_WRITE, [{ status: 529 }, { text: "Vision wrote this." }], async () => {
    if (reaped) return;
    await sql("UPDATE credit_holds SET lease_until = 1 WHERE run_id = (SELECT run_id FROM credit_holds WHERE settled_at = 0 AND model = ? AND user_id = ?)", [LEVEL_MODELS.ultra, id]);
    reaped = await R.reapLapsed();
  });
  const run = await s.run();
  assert.equal(reaped, 1, "the reaper settled the hold");
  assert.deepEqual(s.sent(), [LEVEL_MODELS.ultra], "Vision is never called for a settled hold");
  assert.notEqual(run.outcome, "ok");
  const step = (await one<{ status: string; note: string }>("SELECT status, note FROM automation_run_steps WHERE run_id = ? AND step_id = 'a1'", [s.rid]))!;
  assert.notEqual(step.status, "done", JSON.stringify(step));
});

test("a Research step stepped down from Ultra keeps its hold as the reaper's bound, with what is left at Vision's prices", async () => {
  const { LEVEL_MODELS } = await import("../src/lib/engines/claude.ts");
  const { id } = await admin("sd8", 2000);
  const research: Spec = { v: 1, trigger: { type: "manual" }, steps: [{ id: "a1", do: "ai", mode: "research", level: "ultra", prompt: "Check today's news about my bank." }, { id: "n1", do: "notify" }] };
  const seen: { ultra?: { left_cents: number; model: string } | null; vision?: { model: string; cap_cents: number; left_cents: number } | null } = {};
  let release!: () => void;
  const s = await steppedDown(id, research, [{ status: 529 }, { text: "Rates held today.", hold: new Promise<void>((r) => (release = r)) }], async () => {
    seen.ultra = await one<{ left_cents: number; model: string }>("SELECT left_cents, model FROM credit_holds WHERE settled_at = 0 AND user_id = ?", [id]);
  });
  await s.run(async () => {
    const until = Date.now() + 5000;
    while (claude.state.open < 1 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    seen.vision = await one<{ model: string; cap_cents: number; left_cents: number }>("SELECT model, cap_cents, left_cents FROM credit_holds WHERE settled_at = 0 AND user_id = ?", [id]);
    release();
  });
  const { ultra, vision } = seen;
  assert.equal(ultra?.model, LEVEL_MODELS.ultra);
  assert.equal(vision?.model, LEVEL_MODELS.vision);
  assert.equal(Number(vision!.cap_cents), 0, "no bound but the hold for a step with tools: its rounds and searches aren't in max_tokens");
  assert.ok(Number(vision!.left_cents) > 0 && Number(vision!.left_cents) < Number(ultra!.left_cents), `left at Vision's prices (${vision!.left_cents} vs Ultra's ${ultra!.left_cents})`);
});

test("one failed write of the step-down is tried again: Vision answers and the run is done", async () => {
  const { LEVEL_MODELS } = await import("../src/lib/engines/claude.ts");
  const { id } = await admin("sd10", 1000);
  let failed = 0;
  const s = await steppedDown(id, ULTRA_WRITE, [{ status: 529 }, { text: "Vision wrote this." }], async () => {
    if (failed++ === 0) throw new Error("SQLITE_BUSY: database is locked");
  });
  assert.deepEqual({ ...(await s.run()) }, { status: "done", outcome: "ok" });
  assert.equal(failed, 2, "written on the second try");
  assert.deepEqual(s.sent(), [LEVEL_MODELS.ultra, LEVEL_MODELS.vision]);
});

// PR 1b: automations for everyone.

test("/admin's switch opens automations to everyone and closes them again; opening needs their own key", async () => {
  const pat = await F.account("pat_open", 100, { admin: false });
  const { cookie } = await admin("opener");
  const listed = async () => (await listRoute.GET(req("/api/automations", { cookie: pat.cookie }))).status;
  const enabled = async () => ((await (await meRoute.GET(req("/api/me", { cookie: pat.cookie }))).json()) as { automationsEnabled: boolean }).automationsEnabled;
  const turn = (open: unknown, c = cookie) => adminRoute.POST(req("/api/admin/automations", { cookie: c, json: { action: "open", open } }));
  try {
    assert.deepEqual([await listed(), await enabled()], [404, false]);
    assert.equal((await turn(true, pat.cookie)).status, 404, "closed, the switch isn't there for anyone else");
    assert.equal((await turn("yes")).status, 400);
    // Never on chat's key: without their own, it stays closed.
    const key = process.env.ANTHROPIC_AUTOMATIONS_API_KEY;
    delete process.env.ANTHROPIC_AUTOMATIONS_API_KEY;
    try {
      assert.equal((await turn(true)).status, 409);
    } finally {
      process.env.ANTHROPIC_AUTOMATIONS_API_KEY = key;
    }
    assert.deepEqual([await listed(), await enabled(), (await adminStats(30)).automations.open], [404, false, false]);
    const opened = await turn(true);
    assert.equal(opened.status, 200);
    assert.deepEqual(await opened.json(), { open: true });
    assert.deepEqual([await listed(), await enabled(), (await adminStats(30)).automations.open], [200, true, true]);
    assert.equal((await turn(false, pat.cookie)).status, 403, "open to everyone, only an admin may close them");
    // Another server reads the switch from the database.
    S.forgetOpen();
    assert.equal(await listed(), 200);
    assert.equal((await turn(false)).status, 200);
    assert.deepEqual([await listed(), await enabled()], [404, false]);
    S.forgetOpen();
    assert.equal(await listed(), 404, "closed for every server");
  } finally {
    await S.setOpenToEveryone(false);
    await afterwards();
  }
});

test("the estimate says when it runs in the reader's words, with its next 3 times; one its owner runs has neither", async () => {
  const { cookie } = await admin("nexter");
  const when = { kind: "weekly" as const, days: [1, 3], at: "08:00" };
  const r = await estimateRoute.POST(req("/api/automations/estimate", { cookie, json: { spec: { ...F.WRITE_SPEC, trigger: { type: "schedule", when } }, timeZone: "America/Toronto" } }));
  assert.equal(r.status, 200);
  const got = (await r.json()) as { schedule: { sentence: string; zone: string }; next: string };
  assert.deepEqual(got.schedule, { sentence: `Every Monday and Wednesday at ${A.clockText("08:00", "en")}`, zone: "Eastern Time" });
  const times = nextFires(when, "America/Toronto", Date.now(), 3);
  assert.equal(got.next, `Next: ${times.map((x) => A.runTimeText(x, "America/Toronto", "en")).join(" · ")}`);
  const manual = (await (await estimateRoute.POST(req("/api/automations/estimate", { cookie, json: { spec: F.WRITE_SPEC, timeZone: "UTC" } }))).json()) as typeof got;
  assert.deepEqual([manual.schedule, manual.next], [null, ""]);
});

test("the list shows each automation's last run and charge, its runs say how many there are, and Download receipts saves them all, each checked", async () => {
  const { cookie } = await admin("lister");
  const aid = await create(cookie, F.WRITE_SPEC);
  const price = (await priceOf(cookie, F.WRITE_SPEC)).worst;
  claude.state.replies.push({ text: "First." }, { text: "Second." });
  for (let i = 0; i < 2; i++) assert.equal((await runOnce(cookie, aid, price)).status, 202);
  const rows = await all<{ id: string; credits: number; finished_at: number; receipt_hash: string }>("SELECT id, credits, finished_at, receipt_hash FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC", [aid]);
  assert.equal(rows.length, 2);
  const view = ((await body(await listRoute.GET(req("/api/automations", { cookie })))).automations as { id: string; lastCredits: number; lastEndedAt: number }[]).find((a) => a.id === aid)!;
  assert.deepEqual([view.lastCredits, view.lastEndedAt], [Number(rows[0].credits), Number(rows[0].finished_at)]);
  assert.ok(view.lastCredits > 0);
  const page = await body(await runsRoute.GET(req(`/api/automations/${aid}/runs`, { cookie }), ctx({ id: aid })));
  assert.deepEqual([page.total, page.cursor, (page.runs as unknown[]).length], [2, null, 2]);
  // Download receipts: newest first, each as Compare takes it.
  const file = await runsRoute.GET(req(`/api/automations/${aid}/runs?format=receipts`, { cookie }), ctx({ id: aid }));
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-disposition"), `attachment; filename="receipts-${aid}.json"`);
  const saved = (await file.json()) as { automation: { id: string; name: string }; receipts: { prev: string; hash: string; receipt: { run: string; credits: number } }[] };
  assert.deepEqual(saved.automation, { id: aid, name: "Morning note" });
  assert.deepEqual(saved.receipts.map((x) => [x.receipt.run, x.hash]), rows.map((x) => [x.id, x.receipt_hash]));
  const check = async (runId: string, receipt: unknown) =>
    ((await (await receiptRoute.POST(req(`/api/automations/runs/${runId}`, { cookie, json: { action: "check", receipt } }), ctx({ runId }))).json()) as { matches: boolean }).matches;
  assert.equal(await check(rows[0].id, saved.receipts[0]), true);
  assert.equal(await check(rows[1].id, saved.receipts[1]), true);
  const changed = structuredClone(saved.receipts[0]);
  changed.receipt.credits += 1;
  assert.equal(await check(rows[0].id, changed), false);
  // Someone else's automation's receipts are not found.
  const other = await admin("lister2");
  assert.equal((await runsRoute.GET(req(`/api/automations/${aid}/runs?format=receipts`, { cookie: other.cookie }), ctx({ id: aid }))).status, 404);
});
