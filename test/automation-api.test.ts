import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./support/route-hooks.mjs", import.meta.url);

/*
 * The automation routes (automation-api.ts), called as Next calls them, with Claude stood in for:
 * who may call them (signed in, admins only in PR 1a, Flash's own page, a confirmed email), each
 * route's own rate limit, ownership, at most 25 on and 3 more often than daily, the price the user
 * saw (409 price_changed) on saving, editing, running and retrying, the receipt (a GET that writes
 * nothing, read, the downloaded copy checked), estimates counted once a day and priced at their most
 * when counting fails, Run now queued over the account's limit, delete by hand (foreign keys are
 * off), the /admin card, api/me's automationsEnabled, and that draining credits through automations
 * never makes opening Flash buy credits.
 */
const { claudeStandIn } = await import("./support/claude-stand-in.ts");
const claude = await claudeStandIn();
process.env.DATABASE_URL = ":memory:";
process.env.ANTHROPIC_BASE_URL = claude.url;
process.env.ANTHROPIC_API_KEY = "chat-key-for-tests";
process.env.ANTHROPIC_AUTOMATIONS_API_KEY = "automations-key-for-tests";
process.env.FLASH_ADMIN_EMAILS = ["boss", "chief", "origin", "fresh", "many", "often", "pricey", "edits", "reader", "counter", "estimator", "busy", "tidy", "card", "meboss", "drain"].map((n) => `${n}@example.com`).join(", ");
process.env.AUTOMATIONS_DEV = "1";
const SECRET = "c".repeat(40);
process.env.CRON_SECRET = SECRET;
process.env.FLASH_APP_URL = "http://flash.test";
process.env.STRIPE_SECRET_KEY = "rk_test";
process.env.STRIPE_API_BASE = "http://stripe.test/v1";
for (const name of ["VERCEL_ENV", "VERCEL", "RESEND_API_KEY", "FLASH_DEMO_EMAILS", "FRED_API_KEY", "AUTOMATION_MAX_PAID", "FLASH_STRIPE_TAX"]) delete process.env[name];

// Stripe, stood in for: every call is kept, and a PaymentIntent succeeds. Everything else goes through.
const stripeCalls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith("http://stripe.test/")) return realFetch(input, init);
  const path = new URL(url).pathname.replace("/v1", "");
  stripeCalls.push(path);
  return path === "/payment_intents" ? Response.json({ id: `pi_${stripeCalls.length}`, status: "succeeded" }) : Response.json({});
}) as typeof fetch;

const { one, run: sql } = await import("../src/lib/server/db.ts");
const F = await import("./support/automation-fixtures.ts");
const A = await import("../src/lib/automations.ts");
const API = await import("../src/lib/server/automation-api.ts");
const E = await import("../src/lib/server/automation-estimate.ts");
const { worstTokens } = await import("../src/lib/credits.ts");
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

test("who may call: 401 signed out, and in PR 1a 404 for everyone but an admin, on every automation route", async () => {
  const pat = await F.account("pat", 100);
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
    noticesRoute.GET(req("/api/notifications", { cookie: pat.cookie })),
    adminRoute.GET(req("/api/admin/automations", { cookie: pat.cookie })),
    adminRoute.POST(req("/api/admin/automations", { cookie: pat.cookie, json: { action: "price" } })),
  ];
  assert.deepEqual((await Promise.all(asPat)).map((r) => r.status), Array(asPat.length).fill(404));
  assert.equal(await count("automations", "user_id = ?", [pat.id]), 1, "nothing was made, edited or deleted");
  assert.equal((await one<{ stop_requested: number }>("SELECT stop_requested FROM automation_runs WHERE id = ?", [rid]))!.stop_requested, 0);
  const list = await listRoute.GET(req("/api/automations", { cookie: boss.cookie }));
  assert.equal(list.status, 200);
  assert.deepEqual((await body(list)).automations, []);
  const card = await adminRoute.GET(req("/api/admin/automations", { cookie: boss.cookie }));
  assert.equal(card.status, 200);
  assert.deepEqual((await body(card)).setup, { server: true, key: "automations", missing: [], sharedPaid: 2 });
});

test("writes come from Flash's own page as JSON, from an account with a confirmed email", async () => {
  const { cookie, id } = await admin("origin");
  const worst = (await priceOf(cookie, DAILY)).worst;
  const make = (o: { origin?: string | null; type?: string }) =>
    listRoute.POST(req("/api/automations", { cookie, json: { spec: DAILY, name: "Morning note", timeZone: "UTC", seenMax: worst }, ...o }));
  assert.equal((await make({ origin: "https://evil.example" })).status, 403);
  assert.equal((await make({ type: "text/plain" })).status, 403);
  assert.equal(await count("automations", "user_id = ?", [id]), 0, "nothing was saved");
  // An admin's address must be confirmed first: until then automations are closed to them (404 in
  // PR 1a, where only admins may use them; the gate's own check answers 403 once they open to all).
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
    admin: [60, 600_000],
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
  await full(`auto:runAutomation:${aid}`, 10);
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
  assert.deepEqual(card.automations.map((a) => a.name).sort(), ["Burn-in: one-off in 3 minutes", "Burn-in: run by hand"]);
  assert.equal(card.runs[0].id, runId);
  assert.ok(card.runs[0].held >= card.runs[0].credits && card.runs[0].credits > 0 && card.runs[0].openHolds === 0);
  assert.deepEqual(card.notices.map((n) => [n.title, n.text]), [["Burn-in: run by hand", "Burn-in: run by hand is ready"]]);
});

test("api/me says automationsEnabled only for admins, and only once automations are set up here", async () => {
  const pat = await F.account("pat_me", 100);
  const boss = await admin("meboss", 100);
  const enabled = async (cookie: string) => ((await (await meRoute.GET(req("/api/me", { cookie }))).json()) as { automationsEnabled: boolean }).automationsEnabled;
  assert.equal(await enabled(pat.cookie), false);
  assert.equal(await enabled(boss.cookie), true);
  delete process.env.CRON_SECRET;
  try {
    assert.equal(await enabled(boss.cookie), false, "not until CRON_SECRET is set");
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
  for (let i = 0; i < 8; i++) {
    claude.state.replies.push({ text: "A long answer.", usage: { input_tokens: 1200, output_tokens: 3000 } });
    const r = await runOnce(cookie, aid, worst);
    if (r.status !== 202) break;
  }
  const spent = -Number((await one<{ s: number }>("SELECT COALESCE(SUM(amount), 0) AS s FROM credit_ledger WHERE user_id = ? AND automation_id <> ''", [id]))!.s);
  assert.ok(spent > 30, `the runs spent credits (${spent})`);
  assert.ok((await F.balance(id)) >= 100, `never under the top-up level (${await F.balance(id)})`);
  assert.ok(await count("automation_runs", "automation_id = ? AND outcome = 'topup_floor' AND credits = 0", [aid]), "the level stopped a run, for free");
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

test("/admin's automation lines: setup by name only, cron health worked out from the data, and what runs charged against their cost", async () => {
  const lines = await automationStats(30);
  assert.deepEqual([lines.server, lines.key, lines.missing, lines.sharedPaid], [true, "automations", [], 2]);
  assert.equal(lines.active, Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM automations WHERE status = 'on'"))!.n));
  assert.ok(lines.credits > 0 && lines.costCents > 0 && lines.requests > 0, "the runs above, charged and costed");
  assert.ok(lines.outcomesWeek.some((o) => o.status === "done" && o.runs > 0));
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
  } finally {
    process.env.CRON_SECRET = SECRET;
    process.env.FLASH_APP_URL = "http://flash.test";
    process.env.ANTHROPIC_AUTOMATIONS_API_KEY = key;
  }
});
