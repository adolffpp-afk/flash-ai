import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

register("./support/route-hooks.mjs", import.meta.url);

/*
 * The per-minute tick (automation-tick.ts) and the cron routes: an empty tick only reads, a slot
 * becomes one run whatever happens, missed, late, overlapping and superseded slots are free, the
 * claim's limits, the 429 back-off, parked runs, pauses that end by themselves, the daily job, runner
 * versions, and who may call the cron routes at all.
 */
process.env.DATABASE_URL = ":memory:";
process.env.ANTHROPIC_API_KEY = "chat-key-for-tests";
for (const name of ["VERCEL_ENV", "VERCEL", "RESEND_API_KEY", "FLASH_DEMO_EMAILS", "FLASH_APP_URL", "ANTHROPIC_AUTOMATIONS_API_KEY", "AUTOMATION_MAX_PAID", "CRON_SECRET", "AUTOMATIONS_DEV"]) {
  delete process.env[name];
}
const SECRET = "s".repeat(40);

const { one, all, run: sql } = await import("../src/lib/server/db.ts");
const F = await import("./support/automation-fixtures.ts");
const T = await import("../src/lib/server/automation-tick.ts");
const S = await import("../src/lib/server/automations.ts");
const { nextFire, utcDay } = await import("../src/lib/schedule.ts");
const { routeHost } = await import("../src/lib/site-host.ts");
const { FREE_MONTHLY_CREDITS } = await import("../src/lib/credits.ts");
const tickRoute = await import("../src/app/api/cron/tick/route.ts");
const workRoute = await import("../src/app/api/cron/work/route.ts");
const { afterwards } = (await import("./support/next-server.mjs")) as unknown as { afterwards: () => Promise<unknown> };
type Spec = import("../src/lib/automations.ts").Spec;

const DAILY: Spec = { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "daily", at: "08:00" } } };
const HOURLY: Spec = { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "hourly", every: 1, from: "00:00", to: "23:00" } } };
const NOTIFY_FIRST: Spec = { ...F.WRITE_SPEC, steps: [{ id: "n1", do: "notify", text: "Hello" }, F.WRITE_SPEC.steps[0]] };

beforeEach(async () => {
  for (const table of ["automations", "automation_versions", "automation_runs", "automation_run_steps", "credit_holds", "notifications", "settings"]) await sql(`DELETE FROM ${table}`);
  // Today's daily job is done, unless a test says otherwise.
  await sql("INSERT INTO settings (key, value) VALUES ('auto:daily', ?)", [utcDay(Date.now())]);
});

/** A tick that sends nothing anywhere: the runs it claims are kept. */
async function tick() {
  const sent: { id: string; owner: string }[] = [];
  const report = await T.runTick("tk", { dispatch: async (c) => void sent.push(c) });
  return { report, sent };
}
const runsOf = (aid: string) => all<{ id: string; status: string; outcome: string; run_key: string; credits: number; lease_owner: string }>(
  "SELECT id, status, outcome, run_key, credits, lease_owner FROM automation_runs WHERE automation_id = ? ORDER BY created_at",
  [aid],
);
const changes = async () => Number((await one<{ n: number }>("SELECT total_changes() AS n"))!.n);
const bearer = (secret = SECRET) => ({ authorization: `Bearer ${secret}` });

test("an empty tick only reads: anythingDue's checks use their indexes, and the route answers 204 with no writes", async () => {
  process.env.AUTOMATIONS_DEV = "1";
  process.env.CRON_SECRET = SECRET;
  for (const check of T.DUE_CHECKS) {
    const plan = (await all<{ detail: string }>(`EXPLAIN QUERY PLAN ${check}`)).map((r) => r.detail).join(" | ");
    assert.match(plan, /USING (COVERING )?INDEX/, plan);
    assert.doesNotMatch(plan, /SCAN (automations|automation_runs|credit_holds)\b(?! USING)/, plan);
  }
  const before = await changes();
  const res = await tickRoute.GET(new Request("http://localhost/api/cron/tick", { headers: bearer() }));
  assert.equal(res.status, 204);
  await afterwards();
  assert.equal(await changes(), before, "nothing was written");
});

test("a slot becomes one run, however many ticks see it at once", async () => {
  const u = await F.account("tick1", 100);
  const slot = Date.now() - 1000;
  const aid = await F.automation({ userId: u.id, spec: DAILY, nextAt: slot });
  await Promise.all([tick(), tick(), tick()]);
  await tick();
  const runs = await runsOf(aid);
  assert.deepEqual(runs.map((r) => [r.run_key, r.status]), [[`sched:${slot}`, "running"]]);
  const a = await one<{ next_at: number }>("SELECT next_at FROM automations WHERE id = ?", [aid]);
  assert.equal(Number(a!.next_at), nextFire(DAILY.trigger.type === "schedule" ? DAILY.trigger.when : (null as never), "UTC", Date.now()));
});

test("ticks missed for days make one missed run, free, and no backlog", async () => {
  const u = await F.account("tick2", 100);
  const aid = await F.automation({ userId: u.id, spec: DAILY, nextAt: Date.now() - 3 * 86_400_000 });
  const { sent } = await tick();
  const runs = await runsOf(aid);
  assert.deepEqual(runs.map((r) => [r.status, r.outcome, Number(r.credits)]), [["skipped", "missed", 0]]);
  assert.equal(sent.length, 0);
  assert.ok(Number((await one<{ next_at: number }>("SELECT next_at FROM automations WHERE id = ?", [aid]))!.next_at) > Date.now());
  const notices = await all<{ phrase: string }>("SELECT phrase FROM notifications WHERE user_id = ?", [u.id]);
  assert.deepEqual(notices.map((n) => n.phrase), ["Missed: Flash couldn't start it in time. Nothing was charged."]);
});

test("a run still queued past its grace window when it would be claimed is missed, free", async () => {
  const u = await F.account("tick3", 100);
  const aid = await F.automation({ userId: u.id, spec: DAILY, nextAt: Date.now() + 3_600_000 });
  await F.runRow({ automationId: aid, userId: u.id, origin: "schedule", graceUntil: Date.now() - 1000 });
  const { sent, report } = await tick();
  assert.equal(report.missed, 1);
  assert.equal(sent.length, 0);
  assert.deepEqual((await runsOf(aid)).map((r) => [r.status, r.outcome]), [["skipped", "missed"]]);
});

test("a slot while the last run is still going is skipped; an older slot that never started is superseded", async () => {
  const u = await F.account("tick4", 100);
  const aid = await F.automation({ userId: u.id, spec: HOURLY, nextAt: Date.now() - 1000 });
  await F.runRow({ automationId: aid, userId: u.id, origin: "schedule", status: "running", runKey: "sched:1" });
  await tick();
  let runs = await runsOf(aid);
  assert.deepEqual(runs.map((r) => [r.status, r.outcome]), [["running", ""], ["skipped", "overlap"]]);
  const aid2 = await F.automation({ userId: u.id, spec: HOURLY, nextAt: Date.now() - 1000 });
  await F.runRow({ automationId: aid2, userId: u.id, origin: "schedule", status: "queued", runKey: "sched:2", dueAt: Date.now() + 60_000 });
  await tick();
  runs = await runsOf(aid2);
  assert.deepEqual(runs.map((r) => [r.run_key.startsWith("sched:2"), r.status, r.outcome]), [[true, "skipped", "superseded"], [false, "running", ""]]);
});

test("claims: at most 3 runs at once per account, the paid pool's limit, and a full paid pool doesn't hold up a notice run", async () => {
  // On chat's own key, at most 2 runs whose next step is AI at once.
  assert.equal(S.keyInUse(), "shared");
  assert.equal(S.maxPaid(), 2);
  const busy = await F.account("tick5", 100);
  const aid = await F.automation({ userId: busy.id, spec: NOTIFY_FIRST });
  for (let i = 0; i < 5; i++) await F.runRow({ automationId: aid, userId: busy.id, nextPaid: 0 });
  const paid: string[] = [];
  for (const name of ["tick5a", "tick5b", "tick5c"]) {
    const u = await F.account(name, 100);
    paid.push(await F.runRow({ automationId: await F.automation({ userId: u.id }), userId: u.id, nextPaid: 1 }));
  }
  const { sent } = await tick();
  const claimed = new Set(sent.map((c) => c.id));
  assert.equal([...claimed].filter((id) => paid.includes(id)).length, 2, "the paid pool");
  assert.equal(sent.length - 2, 3, "three of the account's five");
});

test("a 429 stops paid claims for a minute; other runs are still claimed", async () => {
  const u = await F.account("tick6", 100);
  const paid = await F.runRow({ automationId: await F.automation({ userId: u.id }), userId: u.id, nextPaid: 1 });
  const other = await F.runRow({ automationId: await F.automation({ userId: u.id, spec: NOTIFY_FIRST }), userId: u.id, nextPaid: 0 });
  await S.backOff();
  assert.equal(await S.paidOpen(), 0);
  let { sent } = await tick();
  assert.deepEqual(sent.map((c) => c.id), [other]);
  // A minute later.
  await sql("UPDATE settings SET value = '1' WHERE key = 'auto:backoff_until'");
  ({ sent } = await tick());
  assert.deepEqual(sent.map((c) => c.id), [paid]);
});

test("a paused automation's runs are parked: not claimed, and not due", async () => {
  const u = await F.account("tick7", 100);
  const aid = await F.automation({ userId: u.id, status: "paused", pausedReason: "user" });
  await F.runRow({ automationId: aid, userId: u.id, parked: 1 });
  assert.equal(await T.anythingDue(), false);
  const { sent } = await tick();
  assert.equal(sent.length, 0);
});

test("pauses that end by themselves: a month limit at the reset, and a wait for credits once the month's credits are given", async () => {
  const u = await F.account("tick8", 0);
  const aid = await F.automation({ userId: u.id, spec: DAILY, status: "paused", pausedReason: "month_cap", resumeAt: Date.now() - 1000, nextAt: 1 });
  const parked = await F.runRow({ automationId: aid, userId: u.id, parked: 1, dueAt: Date.now() + 3_600_000 });
  assert.equal(await T.anythingDue(), true);
  await tick();
  const a = await one<{ status: string; next_at: number }>("SELECT status, next_at FROM automations WHERE id = ?", [aid]);
  assert.equal(a!.status, "on");
  assert.ok(Number(a!.next_at) > Date.now(), "the next slot after now");
  assert.equal(Number((await one<{ parked: number }>("SELECT parked FROM automation_runs WHERE id = ?", [parked]))!.parked), 0);

  // A free account waiting for 10 credits, whose month's free credits aren't given yet (as on the 1st).
  const free = await F.account("tick8b", 0);
  await sql("UPDATE credit_ledger SET ref = 'free:tick8b:2000-01' WHERE user_id = ?", [free.id]);
  const waiting = await F.automation({ userId: free.id, spec: DAILY, status: "paused", pausedReason: "credits", resumeAt: Date.now() - 1000, nextAt: Date.now() - 500 });
  await sql("UPDATE automations SET need_credits = ? WHERE id = ?", [FREE_MONTHLY_CREDITS + 1, waiting]);
  await tick();
  let w = await one<{ status: string; resume_at: number }>("SELECT status, resume_at FROM automations WHERE id = ?", [waiting]);
  assert.equal(w!.status, "paused", "not enough yet");
  assert.ok(Number(w!.resume_at) >= Date.now() + 86_400_000 - 5000, "looked at again, at most once a day");
  await sql("UPDATE automations SET need_credits = ?, resume_at = 1 WHERE id = ?", [FREE_MONTHLY_CREDITS, waiting]);
  await tick();
  w = await one<{ status: string; resume_at: number }>("SELECT status, resume_at FROM automations WHERE id = ?", [waiting]);
  assert.equal(w!.status, "on");
});

test("the daily job runs once a day, and deletes what was being deleted by hand (foreign keys are off), keeping the money record", async () => {
  await sql("DELETE FROM settings");
  await sql("DELETE FROM rate_limits");
  const u = await F.account("tick9", 100);
  const aid = await F.automation({ userId: u.id, status: "deleting" });
  const rid = await F.runRow({ automationId: aid, userId: u.id, status: "done" });
  await sql("INSERT INTO automation_run_steps (run_id, step_id, attempt, user_id, kind, status, started_at) VALUES (?, 'a1', 1, ?, 'ai', 'done', 0)", [rid, u.id]);
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, ref, automation_id, created_at) VALUES (?, -3, 'automation', ?, ?, 0)", [u.id, `auto:${rid}:a1:1`, aid]);
  await sql("INSERT INTO notifications (id, user_id, kind, phrase, link, created_at) VALUES ('n9', ?, 'run_done', 'x', ?, 0)", [u.id, `automations=${aid}&run=${rid}`]);
  await sql("INSERT INTO rate_limits (key, count, reset_at) VALUES ('old', 1, 1), ('new', 1, ?)", [Date.now() + 60_000]);
  assert.equal(await T.anythingDue(), true, "the daily job is due");
  assert.equal(await T.dailyJob("2026-10-18"), true);
  assert.equal(await T.dailyJob("2026-10-18"), false, "once a day");
  for (const [table, where] of [["automations", "id"], ["automation_versions", "automation_id"], ["automation_runs", "automation_id"]]) {
    assert.equal(await one(`SELECT 1 FROM ${table} WHERE ${where} = ?`, [aid]), null, table);
  }
  assert.equal(await one("SELECT 1 FROM automation_run_steps WHERE run_id = ?", [rid]), null);
  assert.equal(await one("SELECT 1 FROM notifications WHERE id = 'n9'"), null);
  assert.ok(await one("SELECT 1 FROM credit_ledger WHERE automation_id = ?", [aid]), "the ledger stays");
  assert.deepEqual((await all<{ key: string }>("SELECT key FROM rate_limits ORDER BY key")).map((r) => r.key), ["new"]);
  assert.equal(await T.dailyJob("2026-10-19"), true, "the next day");
});

test("a run whose version needs a newer runner waits, without counting as a failure", async () => {
  const u = await F.account("tick10", 100);
  const aid = await F.automation({ userId: u.id, runner: 99 });
  const rid = await F.runRow({ automationId: aid, userId: u.id });
  const { sent } = await tick();
  assert.equal(sent.length, 0);
  const run = await one<{ status: string }>("SELECT status FROM automation_runs WHERE id = ?", [rid]);
  assert.equal(run!.status, "queued");
  assert.equal(Number((await one<{ fail_streak: number }>("SELECT fail_streak FROM automations WHERE id = ?", [aid]))!.fail_streak), 0);
});

test("the cron routes: 404 off production, 503 without CRON_SECRET, 401 with a wrong bearer", async () => {
  const call = async () => [
    (await tickRoute.GET(new Request("http://localhost/api/cron/tick", { headers: bearer() }))).status,
    (await workRoute.POST(new Request("http://localhost/api/cron/work", { method: "POST", headers: { ...bearer(), "content-type": "application/json" }, body: "{}" }))).status,
  ];
  process.env.CRON_SECRET = SECRET;
  delete process.env.AUTOMATIONS_DEV;
  process.env.VERCEL = "1";
  process.env.VERCEL_ENV = "preview";
  assert.deepEqual(await call(), [404, 404], "a preview deployment never runs automations");
  // AUTOMATIONS_DEV only counts on a laptop, never on Vercel.
  process.env.AUTOMATIONS_DEV = "1";
  assert.deepEqual(await call(), [404, 404]);
  process.env.VERCEL_ENV = "production";
  process.env.CRON_SECRET = "too-short";
  assert.deepEqual(await call(), [503, 503]);
  delete process.env.CRON_SECRET;
  assert.deepEqual(await call(), [503, 503]);
  process.env.CRON_SECRET = SECRET;
  const wrong = await tickRoute.GET(new Request("http://localhost/api/cron/tick", { headers: bearer("x".repeat(40)) }));
  assert.equal(wrong.status, 401);
  assert.equal((await tickRoute.GET(new Request("http://localhost/api/cron/tick"))).status, 401);
  // The right one: the work call checks what it's given, and answers at once.
  assert.equal((await call())[1], 400);
  const ok = await workRoute.POST(
    new Request("http://localhost/api/cron/work", { method: "POST", headers: { ...bearer(), "content-type": "application/json" }, body: JSON.stringify({ runId: "nope", owner: "w:nope" }) }),
  );
  assert.equal(ok.status, 202);
  await afterwards();
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
});

test("Flash's own hosts pass the cron paths straight through (Vercel Cron follows no redirect)", () => {
  for (const host of ["flash-ai-git-main-flash.vercel.app", "flash-app.dev", "www.flash-app.dev"]) {
    for (const path of ["/api/cron/tick", "/api/cron/work"]) {
      assert.deepEqual(routeHost(host, path, path.endsWith("tick") ? "GET" : "POST"), { pass: true }, `${host}${path}`);
    }
  }
});

test("each claimed run gets its own work call to Flash itself, with the cron secret and no redirect followed", async () => {
  const seen: { path: string; auth: string; outbound: boolean; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", auth: String(req.headers.authorization), outbound: "x-flash-outbound" in req.headers, body });
      // A redirect is never followed (the secret goes nowhere else): it would show here as /steal.
      res.writeHead(req.url === "/api/cron/work" && seen.length === 1 ? 202 : 307, { location: "/steal" });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.FLASH_APP_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.CRON_SECRET = SECRET;
  await T.dispatchWork({ id: "run_a", owner: "tk:run_a" });
  await T.dispatchWork({ id: "run_b", owner: "tk:run_b" });
  server.close();
  delete process.env.FLASH_APP_URL;
  assert.equal(seen.length, 2);
  for (const s of seen) {
    assert.equal(s.path, "/api/cron/work");
    assert.equal(s.auth, `Bearer ${SECRET}`);
    assert.equal(s.outbound, false);
  }
  assert.deepEqual(JSON.parse(seen[0].body), { runId: "run_a", owner: "tk:run_a" });
});
