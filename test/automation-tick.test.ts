import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import type { InStatement, InValue } from "@libsql/client";

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

const { db, one, all, run: sql } = await import("../src/lib/server/db.ts");
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
const count = async (table: string, where: string, args: string[]) => Number((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, args))!.n);
const bearer = (secret = SECRET) => ({ authorization: `Bearer ${secret}` });
const NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

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
  // Going: a worker holds it.
  const going = await F.runRow({ automationId: aid, userId: u.id, origin: "schedule", status: "running", runKey: "sched:1" });
  await sql(`UPDATE automation_runs SET lease_owner = 'w:' || id, lease_until = ${NOW} + 120000 WHERE id = ?`, [going]);
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
  const daily = DAILY.trigger.type === "schedule" ? DAILY.trigger.when : (null as never);
  // A slot still in its grace window runs at once (between 08:00 and 11:00 UTC); the next one after now is next.
  const inGrace = nextFire(daily, "UTC", Date.now() - 3 * 3_600_000);
  assert.deepEqual((await runsOf(aid)).map((r) => r.run_key).filter((k) => k.startsWith("sched:")), inGrace <= Date.now() ? [`sched:${inGrace}`] : []);
  assert.equal(Number(a!.next_at), nextFire(daily, "UTC", Date.now()), "the next slot after now");
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

for (const kind of ["daily", "weekly"] as const) {
  test(`a ${kind} wait for credits still short at one look runs the slot of the day it comes back on, in its grace window`, async () => {
    const u = await F.account(`tick8${kind}`, 0);
    // Its slot is 30 s ago (its time of day in UTC, and for weekly its weekday).
    const slot = Math.floor((Date.now() - 30_000) / 60_000) * 60_000;
    const d = new Date(slot);
    const at = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    const when = kind === "daily" ? { kind: "daily" as const, at } : { kind: "weekly" as const, days: [((d.getUTCDay() + 6) % 7) + 1], at };
    const spec: Spec = { ...F.WRITE_SPEC, trigger: { type: "schedule", when } };
    const period = (kind === "daily" ? 1 : 7) * 86_400_000;
    // As a refused run one period ago leaves it: paused for credits, looked at again at this slot.
    const aid = await F.automation({ userId: u.id, spec, status: "paused", pausedReason: "credits", resumeAt: slot, nextAt: slot });
    await sql("UPDATE automations SET need_credits = 50 WHERE id = ?", [aid]);
    await tick();
    assert.equal((await one<{ status: string }>("SELECT status FROM automations WHERE id = ?", [aid]))!.status, "paused", "still short");
    // One period on (every time it keeps moved back by one, as if the clock moved on), with credits bought.
    await sql("UPDATE automations SET next_at = next_at - ?, resume_at = resume_at - ? WHERE id = ?", [period, period, aid]);
    await sql("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, 500, 'purchase', 0)", [u.id]);
    await tick();
    assert.equal((await one<{ status: string }>("SELECT status FROM automations WHERE id = ?", [aid]))!.status, "on");
    assert.deepEqual((await runsOf(aid)).map((r) => [r.run_key, r.status]), [[`sched:${slot}`, "running"]], "the slot itself runs");
  });
}

test("an older deployment's tick (a rollback) leaves alone a schedule saved for a newer runner: never on with no next slot", async () => {
  const u = await F.account("tick8r", 100);
  const due = await F.automation({ userId: u.id, spec: DAILY, nextAt: Date.now() - 1000, runner: 99 });
  const resumes = await F.automation({ userId: u.id, spec: DAILY, status: "paused", pausedReason: "month_cap", resumeAt: Date.now() - 1000, nextAt: 1, runner: 99 });
  // A spec this runner can't read (a step kind of a later PR).
  const newer = { ...DAILY, steps: [...DAILY.steps, { id: "e1", do: "email", subject: "Today" }] };
  await sql("UPDATE automation_versions SET spec = ? WHERE automation_id IN (?, ?)", [JSON.stringify(newer), due, resumes]);
  await tick();
  const a = await one<{ status: string; next_at: number }>("SELECT status, next_at FROM automations WHERE id = ?", [due]);
  assert.deepEqual([a!.status, Number(a!.next_at) > 0], ["on", true], "its slot is kept for the newer runner");
  assert.deepEqual(await runsOf(due), []);
  const b = await one<{ status: string; next_at: number; resume_at: number }>("SELECT status, next_at, resume_at FROM automations WHERE id = ?", [resumes]);
  assert.deepEqual([b!.status, Number(b!.next_at), Number(b!.resume_at) > 0], ["paused", 1, true], "its pause is left for the newer runner to end");
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

// The review's regressions (each failed before its fix).

const DAY = 86_400_000;
/** Every statement some work sends, with the plan SQLite uses for each. */
async function plansOf(work: () => Promise<unknown>) {
  const c = await db();
  const execute = c.execute.bind(c);
  const batch = c.batch.bind(c);
  const seen: { sql: string; args: InValue[] }[] = [];
  const keep = (st: InStatement) => seen.push(typeof st === "string" ? { sql: st, args: [] } : { sql: st.sql, args: (st.args ?? []) as InValue[] });
  c.execute = (async (st: InStatement) => (keep(st), execute(st))) as typeof c.execute;
  c.batch = (async (sts: InStatement[], mode?: Parameters<typeof batch>[1]) => (sts.forEach(keep), batch(sts, mode))) as typeof c.batch;
  try {
    await work();
  } finally {
    c.execute = execute;
    c.batch = batch;
  }
  // Planned on a copy of the schema (no ANALYZE, so the plans are the same): libsql leaves an EXPLAIN of
  // a write open, and the database the tests use must stay writable.
  const { createClient } = await import("@libsql/client");
  const shadow = createClient({ url: ":memory:" });
  for (const r of (await execute("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid")).rows) await shadow.execute(String(r.sql));
  const out: { sql: string; plan: string[] }[] = [];
  for (const st of seen) {
    const plan = (await shadow.execute({ sql: `EXPLAIN QUERY PLAN ${st.sql}`, args: st.args })).rows.map((r) => String(r.detail));
    out.push({ sql: st.sql.replace(/\s+/g, " "), plan });
  }
  shadow.close();
  return out;
}
/**
 * Indexes that hold only open rows (unfinished runs, live leases, open holds, running steps), or the
 * steps whose detail is still kept (30 days at most, read by the daily job): reading all of one reads no history.
 */
const OPEN_ONLY = new Set(["automation_runs_due", "automation_runs_open", "automation_runs_lease", "credit_holds_open", "automation_run_steps_one", "automation_run_steps_detail"]);
/**
 * A plan line that reads a whole table of runs, steps, holds or charges (their aliases in these files
 * included), straight or through an index of every row (the account index: every run it ever had).
 */
const wholeTable = (line: string) => {
  const m = /^SCAN (automation_runs|automation_run_steps|credit_holds|credit_ledger|r|s|h)(?: USING (?:COVERING )?INDEX (\w+))?$/.exec(line);
  return (Boolean(m) && !(m![2] && OPEN_ONLY.has(m![2]))) || HISTORY.test(line);
};
/**
 * A search through an index that holds an account's or an automation's whole history, with no time
 * range (every run or charge it ever had): as costly as a scan once that history is long.
 */
const HISTORY = /^SEARCH \w+ USING (?:COVERING )?INDEX (?:automation_runs_user \(user_id=\?\)|automation_runs_list \(automation_id=\?\)|credit_ledger_user \(user_id=\?\))$/;
/** A statement that reads newest first in its index's order and stops at its LIMIT (an "only if changed" step's previous result). */
const inOrder = (sql: string) => /ORDER BY r\.created_at DESC, r\.id DESC, s\.attempt DESC LIMIT 1$/.test(sql.trim());
const readsHistory = (p: { sql: string; plan: string[] }) => p.plan.some((line) => (inOrder(p.sql) ? wholeTable(line) && !HISTORY.test(line) : wholeTable(line)));
/** Finished runs (and a step with detail each) for history. */
async function history(o: { automationId: (i: number) => string; userId: (i: number) => string; count: number; at: (i: number) => number; detail?: boolean; prefix: string }) {
  const out = gzipSync(JSON.stringify({ text: "x".repeat(200) }));
  const stmts: InStatement[] = [];
  for (let i = 0; i < o.count; i++) {
    const id = `${o.prefix}${i}`;
    stmts.push({
      sql: "INSERT INTO automation_runs (id, automation_id, user_id, version, run_key, origin, root_origin, status, outcome, due_at, finished_at, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 'schedule', 'schedule', 'done', 'ok', ?, ?, ?, ?)",
      args: [id, o.automationId(i), o.userId(i), `k:${id}`, o.at(i), o.at(i) + 60_000, o.at(i), o.at(i)],
    });
    if (o.detail) stmts.push({ sql: "INSERT INTO automation_run_steps (run_id, step_id, attempt, user_id, kind, status, input, output, started_at) VALUES (?, 'a1', 1, ?, 'ai', 'done', 'in', ?, ?)", args: [id, o.userId(i), out, o.at(i)] });
  }
  const c = await db();
  for (let i = 0; i < stmts.length; i += 4000) await c.batch(stmts.slice(i, i + 4000), "write");
}

test("a slot claimed but never sent is missed past its grace window, for free, and never holds up the next slot", async () => {
  const u = await F.account("tick20", 100);
  const aid = await F.automation({ userId: u.id, spec: HOURLY, nextAt: Date.now() - 1000 });
  // The slot becomes a run and is claimed, but its work call never arrives.
  assert.equal((await tick()).sent.length, 1);
  assert.deepEqual((await runsOf(aid)).map((r) => r.status), ["running"]);
  // Past its grace window, its claim's lease long gone.
  await sql(`UPDATE automation_runs SET lease_until = ${NOW} - 1, grace_until = ${NOW} - 60000 WHERE automation_id = ?`, [aid]);
  const later = await tick();
  assert.equal(later.report.missed, 1);
  assert.equal(later.sent.length, 0, "never claimed again");
  const [run] = await runsOf(aid);
  assert.deepEqual([run.status, run.outcome, Number(run.credits), run.lease_owner], ["skipped", "missed", 0, ""]);
  // The next slot is queued, not skipped as overlap.
  await sql("UPDATE automations SET next_at = ? WHERE id = ?", [Date.now() - 1000, aid]);
  await tick();
  const runs = await runsOf(aid);
  assert.deepEqual(runs.map((r) => r.outcome), ["missed", ""]);
});

test("a scheduled run waiting to try again (Claude was busy before it started) is missed past its grace window, never two at once", async () => {
  const u = await F.account("tick21", 100);
  const aid = await F.automation({ userId: u.id, spec: HOURLY, nextAt: Date.now() + 3_600_000 });
  const rid = await F.runRow({ automationId: aid, userId: u.id, origin: "schedule", runKey: "sched:800", attempts: 1, graceUntil: Date.now() - 60_000, dueAt: Date.now() - 1000 });
  await sql("INSERT INTO automation_run_steps (run_id, step_id, attempt, user_id, kind, status, started_at) VALUES (?, 'a1', 1, ?, 'ai', 'running', 0)", [rid, u.id]);
  const { report, sent } = await tick();
  assert.equal(report.missed, 1);
  assert.equal(sent.length, 0);
  assert.deepEqual((await runsOf(aid)).map((r) => [r.status, r.outcome]), [["skipped", "missed"]]);
  assert.equal((await one<{ status: string }>("SELECT status FROM automation_run_steps WHERE run_id = ?", [rid]))!.status, "interrupted", "its step row left running is closed");
});

test("an older slot claimed but never started is superseded by the next, which is queued (not overlap); one under way still blocks it", async () => {
  const u = await F.account("tick22", 100);
  const aid = await F.automation({ userId: u.id, spec: HOURLY, nextAt: Date.now() - 1000 });
  await tick();
  // Claimed, never sent, its lease run out (still in its grace window).
  await sql(`UPDATE automation_runs SET lease_until = ${NOW} - 1 WHERE automation_id = ?`, [aid]);
  await sql("UPDATE automations SET next_at = ? WHERE id = ?", [Date.now() - 500, aid]);
  await tick();
  assert.deepEqual((await runsOf(aid)).map((r) => [r.status, r.outcome]), [["skipped", "superseded"], ["running", ""]]);
  // One that charged a step is never superseded (and its slot after it is skipped as overlap).
  const aid2 = await F.automation({ userId: u.id, spec: HOURLY, nextAt: Date.now() - 1000 });
  const busy = await F.runRow({ automationId: aid2, userId: u.id, origin: "schedule", status: "running", runKey: "sched:1" });
  await sql("UPDATE automation_runs SET credits = 3 WHERE id = ?", [busy]);
  await tick();
  assert.deepEqual((await runsOf(aid2)).map((r) => [r.status, r.outcome]), [["running", ""], ["skipped", "overlap"]]);
});

test("a slot's checks and the daily job read through indexes, never an automation's whole history", async () => {
  const u = await F.account("tick23", 100);
  const aid = await F.automation({ userId: u.id, spec: HOURLY, nextAt: Date.now() - 1000 });
  await history({ prefix: "h23_", count: 3000, automationId: () => aid, userId: () => u.id, at: (i) => Date.now() - (i + 2) * 3_600_000, detail: true });
  // Another account with runs going and a long history of its own, and a run due to be claimed.
  const other = await F.account("tick23b", 100);
  const oid = await F.automation({ userId: other.id });
  await history({ prefix: "h23b_", count: 3000, automationId: () => oid, userId: () => other.id, at: (i) => Date.now() - (i + 2) * 3_600_000 });
  await F.runRow({ automationId: oid, userId: other.id, status: "running" }).then((id) => sql(`UPDATE automation_runs SET lease_owner = 'x', lease_until = ${NOW} + 60000 WHERE id = ?`, [id]));
  await F.runRow({ automationId: oid, userId: other.id });
  await sql("DELETE FROM settings WHERE key = 'auto:daily'");
  // With a dispatch, as on production, so the claim runs too.
  const plans = await plansOf(() => T.runTick("tk", { dispatch: async () => {} }));
  assert.ok(plans.length > 10);
  assert.ok(plans.some((p) => p.sql.startsWith("WITH clock AS")), "the claim was planned");
  for (const p of plans) assert.ok(!readsHistory(p), `${p.sql}\n${p.plan.join(" | ")}`);
  const slot = plans.filter((p) => /outcome = 'superseded'|INSERT INTO automation_runs/.test(p.sql));
  assert.equal(slot.length, 2);
  for (const p of slot) assert.ok(p.plan.some((l) => l.includes("automation_runs_open")), `${p.sql}\n${p.plan.join(" | ")}`);
  const health = await plansOf(async () => (await import("../src/lib/server/automation-admin.ts")).cronHealth());
  for (const p of health) assert.ok(!readsHistory(p), `${p.sql}\n${p.plan.join(" | ")}`);
  const writes = health.find((p) => p.sql.includes("COUNT(*) AS n FROM automation_runs WHERE created_at >= ?"));
  assert.equal(writes, undefined, "the month's writes are read from the daily job's count");
});

test("the burn-in card, a receipt, /admin's lines and an 'only if changed' step's previous result never read every hold or run", async () => {
  const u = await F.account("tick24", 100);
  const aid = await F.automation({ userId: u.id, spec: HOURLY });
  await history({ prefix: "h24_", count: 2000, automationId: () => aid, userId: () => u.id, at: (i) => Date.now() - (i + 2) * 3_600_000, detail: true });
  // Each run with the one settled hold its AI step leaves (holds are never deleted), and another account's too.
  const holds: InStatement[] = [];
  for (let i = 0; i < 2000; i++) {
    holds.push({ sql: "INSERT INTO credit_holds (ref, user_id, run_id, held, lease_until, settled_at, credits, created_at) VALUES (?, ?, ?, 5, 0, 1, 1, ?)", args: [`auto:h24_${i}:a1:1`, u.id, `h24_${i}`, i] });
    holds.push({ sql: "INSERT INTO credit_holds (ref, user_id, run_id, held, lease_until, settled_at, credits, created_at) VALUES (?, 'other', ?, 5, 0, 1, 1, ?)", args: [`auto:o24_${i}:a1:1`, `o24_${i}`, i] });
  }
  await (await db()).batch(holds, "write");
  const API = await import("../src/lib/server/automation-api.ts");
  const { automationStats } = await import("../src/lib/server/automation-admin.ts");
  const { previousResult } = await import("../src/lib/server/automation-steps.ts");
  const g = { user: (await S.userById(u.id))!, t: await (await import("../src/lib/server/i18n.ts")).translatorIn("en"), deadline: Date.now() + 60_000 };
  const plans = await plansOf(async () => {
    const card = await API.burnIn(g);
    assert.equal(card.runs.length, 20);
    assert.deepEqual([card.runs[0].id, card.runs[0].held, card.runs[0].holds, card.runs[0].openHolds], ["h24_0", 5, 1, 0]);
    assert.equal((await API.receipt(g, "h24_7"))!.holds.length, 1);
    await automationStats(30);
    assert.equal(await previousResult(aid, "new", "a1"), "x".repeat(200));
  });
  assert.ok(plans.length > 10);
  for (const p of plans) assert.ok(!readsHistory(p), `${p.sql}\n${p.plan.join(" | ")}`);
  // The card works out each run's holds for the 20 it shows only, and a previous result is the newest run's, read in order.
  const card = plans.find((p) => p.sql.includes("FROM (SELECT * FROM automation_runs WHERE user_id = ?"))!;
  assert.ok(card.plan.some((l) => l.includes("credit_holds_by_run")), card.plan.join(" | "));
  // The card's 20 newest runs are a range of the account's newest, an automation's unseen count reads its
  // unseen runs only, and the account's month total its automation charges of this month only.
  const latest = card.plan.indexOf("CO-ROUTINE latest");
  assert.deepEqual(card.plan.slice(latest + 1, latest + 3), ["SEARCH automation_runs USING INDEX automation_runs_user_new (user_id=?)", "SCAN latest"], "read newest first, no sort");
  const unseen = plans.find((p) => p.sql.includes("seen_at = 0 LIMIT"))!;
  assert.ok(unseen.plan.some((l) => l.includes("automation_runs_unseen")), unseen.plan.join(" | "));
  const month = plans.find((p) => p.sql.includes("FROM credit_ledger WHERE user_id = ? AND automation_id <> ''"))!;
  assert.ok(month.plan.some((l) => l.includes("credit_ledger_auto_user (user_id=? AND created_at>?)")), month.plan.join(" | "));
  const previous = plans.find((p) => p.sql.includes("SELECT s.output FROM automation_runs r"))!;
  assert.ok(previous.plan.some((l) => l.includes("automation_runs_list")) && !previous.plan.includes("USE TEMP B-TREE FOR ORDER BY"), previous.plan.join(" | "));
  await sql("DELETE FROM automation_runs");
  await sql("DELETE FROM automation_run_steps");
});

test("the burn-in card's poll never reads the week's runs or charges Flash-wide: it carries the live cron health lines, and /admin's lines the week's", async () => {
  const u = await F.account("tick24b", 100);
  const API = await import("../src/lib/server/automation-api.ts");
  const { cronHealth } = await import("../src/lib/server/automation-admin.ts");
  const g = { user: (await S.userById(u.id))!, t: await (await import("../src/lib/server/i18n.ts")).translatorIn("en"), deadline: Date.now() + 60_000 };
  let card!: Awaited<ReturnType<typeof API.burnIn>>;
  const polled = await plansOf(async () => void (card = await API.burnIn(g)));
  const week = (p: { sql: string }) => p.sql.includes("started_at - scheduled_at") || p.sql.includes("GROUP BY created_at / 60000");
  assert.deepEqual(polled.filter(week).map((p) => p.sql), [], "no lag or peak spend in the poll");
  assert.ok(!("lagP95Sec" in card.health) && !("peakCreditsPerMinute" in card.health) && "queued" in card.health && "openHolds" in card.health);
  const lines = await plansOf(async () => void (await cronHealth()));
  assert.equal(lines.filter(week).length, 2, "/admin's own lines read them");
});

test("old receipt detail is compacted past the first 5,000 runs in one daily job, and runs past 13 months all go", async () => {
  await sql("DELETE FROM automation_run_steps");
  await sql("DELETE FROM automation_runs");
  // 6,000 runs finished 40 days ago, with detail, over 200 automations (30 each: under the 50-run rule).
  await history({ prefix: "c_", count: 6000, automationId: (i) => `ca${i % 200}`, userId: (i) => `cu${i % 60}`, at: (i) => Date.now() - 40 * DAY + i, detail: true });
  // 6,000 newer runs of one automation, with detail: only its newest 50 keep theirs.
  await history({ prefix: "w_", count: 6000, automationId: () => "wide", userId: () => "wu", at: (i) => Date.now() - 10 * DAY + i, detail: true });
  // 12,000 runs past 13 months.
  await history({ prefix: "x_", count: 12_000, automationId: (i) => `xa${i % 500}`, userId: () => "xu", at: (i) => Date.now() - 400 * DAY + i });
  await sql("DELETE FROM settings WHERE key = 'auto:daily'");
  assert.equal(await T.dailyJob("2099-01-01"), true);
  const detailed = await all<{ id: string }>("SELECT DISTINCT run_id AS id FROM automation_run_steps WHERE output IS NOT NULL");
  // The wide automation's newest 50, and each other automation's latest run that delivered (an "only if changed" step reads it).
  assert.equal(detailed.length, 250);
  assert.ok(detailed.every((d) => (d.id.startsWith("w_") && Number(d.id.slice(2)) >= 5950) || (d.id.startsWith("c_") && Number(d.id.slice(2)) >= 5800)));
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM automation_runs WHERE id LIKE 'x_%'"))!.n), 0, "every run past 13 months went");
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM automation_runs"))!.n), 12_000, "the rest stay, with their receipts");
  // The month's estimated writes are what the daily job counted.
  const counted = Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM automation_runs WHERE created_at >= ?", [Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)]))!.n);
  const w = await T.monthWrites();
  assert.equal(w.writes, counted * T.WRITES_PER_RUN);
  assert.equal(w.day, utcDay(Date.now()));
  await sql("DELETE FROM automation_runs");
  await sql("DELETE FROM automation_run_steps");
});

// The third review's regressions (each failed before its fix).

test("the account limit comes before the pools: accounts with long queues never hold up another account's run", async () => {
  process.env.ANTHROPIC_AUTOMATIONS_API_KEY = "auto-key-for-tests";
  try {
    assert.equal(S.maxPaid(), 30);
    const a = await F.account("tick30a", 10_000);
    const a2 = await F.account("tick30b", 10_000);
    const b = await F.account("tick30c", 10_000);
    const aid = await F.automation({ userId: a.id });
    const aid2 = await F.automation({ userId: a2.id });
    // Two accounts with 25 runs each queued at 08:00 (25 automations at one time), and one run of another account due later.
    for (let i = 0; i < 25; i++) await F.runRow({ automationId: aid, userId: a.id, dueAt: Date.now() - 60_000 + i });
    for (let i = 0; i < 25; i++) await F.runRow({ automationId: aid2, userId: a2.id, dueAt: Date.now() - 50_000 + i });
    const bRun = await F.runRow({ automationId: await F.automation({ userId: b.id }), userId: b.id, dueAt: Date.now() - 1000 });
    const first = await tick();
    assert.ok(first.sent.some((c) => c.id === bRun), "the third account's run is claimed");
    assert.equal(first.sent.length, 7, "3 + 3 + 1");
    // With the two accounts at their 3 at once, nothing more of theirs is claimed.
    assert.equal((await tick()).sent.length, 0);
  } finally {
    delete process.env.ANTHROPIC_AUTOMATIONS_API_KEY;
  }
});

test("an account with 3 runs going gets none more claimed; a run with an open hold isn't claimed even with its lease run out", async () => {
  const u = await F.account("tick31", 100);
  const aid = await F.automation({ userId: u.id, spec: NOTIFY_FIRST });
  for (let i = 0; i < 3; i++) {
    const id = await F.runRow({ automationId: aid, userId: u.id, status: "running", nextPaid: 0 });
    await sql(`UPDATE automation_runs SET lease_owner = 'w:' || id, lease_until = ${NOW} + 120000 WHERE id = ?`, [id]);
  }
  await F.runRow({ automationId: aid, userId: u.id, nextPaid: 0 });
  assert.equal((await tick()).sent.length, 0, "the account is at its 3 at once");

  const v = await F.account("tick31b", 100);
  const held = await F.runRow({ automationId: await F.automation({ userId: v.id }), userId: v.id, status: "running" });
  // Its step's hold is still open (its lease not run out), though the run's own lease has.
  await sql("INSERT INTO credit_holds (ref, user_id, run_id, held, model, lease_until, created_at) VALUES (?, ?, ?, 10, 'm', ?, ?)", [`auto:${held}:a1:1`, v.id, held, Date.now() + 120_000, Date.now()]);
  assert.equal((await tick()).sent.length, 0, "the reaper settles it first");
  await sql("UPDATE credit_holds SET settled_at = 1 WHERE run_id = ?", [held]);
  assert.deepEqual((await tick()).sent.map((c) => c.id), [held]);
});

test("a one-off whose run was missed past its grace window is finished, not left on with no next run", async () => {
  const u = await F.account("tick32", 100);
  const once: Spec = { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "once", date: "2026-10-18", at: "08:00" } } };
  const aid = await F.automation({ userId: u.id, spec: once, nextAt: Date.now() - 1000 });
  // Its slot becomes a run, claimed, but its work call never arrives.
  assert.equal((await tick()).sent.length, 1);
  const taken = await one<{ status: string; next_at: number }>("SELECT status, next_at FROM automations WHERE id = ?", [aid]);
  assert.deepEqual([taken!.status, Number(taken!.next_at)], ["on", 0]);
  await sql(`UPDATE automation_runs SET lease_until = ${NOW} - 1, grace_until = ${NOW} - 60000 WHERE automation_id = ?`, [aid]);
  assert.equal((await tick()).report.missed, 1);
  assert.deepEqual((await runsOf(aid)).map((r) => [r.status, r.outcome]), [["skipped", "missed"]]);
  assert.equal((await one<{ status: string }>("SELECT status FROM automations WHERE id = ?", [aid]))!.status, "finished");
});

test("a one-off whose slot is skipped as it is taken (missed, a day late) is finished, not left on with no next run", async () => {
  const u = await F.account("tick32b", 100);
  const day = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const once: Spec = { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "once", date: day.slice(0, 10), at: day.slice(11, 16) } } };
  const aid = await F.automation({ userId: u.id, spec: once, nextAt: Date.parse(day.slice(0, 16) + ":00Z") });
  await tick();
  assert.deepEqual((await runsOf(aid)).map((r) => [r.status, r.outcome]), [["skipped", "missed"]]);
  assert.equal((await one<{ status: string }>("SELECT status FROM automations WHERE id = ?", [aid]))!.status, "finished");
});

test("the daily job's version prune keeps a version a run still follows, and that run can still be claimed", async () => {
  const u = await F.account("tick32c", 100);
  const aid = await F.automation({ userId: u.id });
  // Edited twice while a run of version 1 waited (released, or parked).
  const v1 = (await one<{ spec: string; runner: number }>("SELECT spec, runner FROM automation_versions WHERE automation_id = ?", [aid]))!;
  const rid = await F.runRow({ automationId: aid, userId: u.id });
  for (const v of [2, 3]) await sql("INSERT INTO automation_versions (automation_id, version, user_id, spec, runner, created_at) VALUES (?, ?, ?, ?, ?, ?)", [aid, v, u.id, v1.spec, v1.runner, Date.now()]);
  await sql("UPDATE automations SET version = 3 WHERE id = ?", [aid]);
  await sql("DELETE FROM settings");
  assert.equal(await T.dailyJob(utcDay(Date.now())), true);
  const kept = await all<{ version: number }>("SELECT version FROM automation_versions WHERE automation_id = ? ORDER BY version", [aid]);
  assert.deepEqual(kept.map((v) => Number(v.version)), [1, 3], "only the version nothing follows goes");
  assert.deepEqual((await tick()).sent.map((c) => c.id), [rid]);
});

test("past 90% of the month's writes, hourly slots are skipped for free, with one notice a month; a daily slot still runs", async () => {
  const before = process.env.AUTOMATION_MONTHLY_WRITES;
  process.env.AUTOMATION_MONTHLY_WRITES = "100";
  try {
    const u = await F.account("tick32d", 100);
    const hourly = await F.automation({ userId: u.id, spec: HOURLY, nextAt: Date.now() - 1000 });
    const daily = await F.automation({ userId: u.id, spec: DAILY, nextAt: Date.now() - 1000 });
    // 3 runs this month: about 90 writes of 100.
    for (let i = 0; i < 3; i++) await F.runRow({ automationId: hourly, userId: u.id, status: "done" });
    await sql("DELETE FROM settings");
    assert.equal(await T.dailyJob(utcDay(Date.now())), true);
    await tick();
    await sql("UPDATE automations SET next_at = ? WHERE id = ?", [Date.now() - 500, hourly]);
    await tick();
    const skipped = (await runsOf(hourly)).filter((r) => r.run_key.startsWith("sched:"));
    assert.deepEqual(skipped.map((r) => [r.status, r.outcome, Number(r.credits)]), [["skipped", "capacity", 0], ["skipped", "capacity", 0]]);
    assert.equal(await count("notifications", "user_id = ? AND ref LIKE 'capacity:%'", [u.id]), 1);
    assert.deepEqual((await runsOf(daily)).map((r) => r.outcome), [""], "only hourly slots are skipped");
  } finally {
    if (before === undefined) delete process.env.AUTOMATION_MONTHLY_WRITES;
    else process.env.AUTOMATION_MONTHLY_WRITES = before;
  }
});

test("a scheduled run past its grace window with a hold still open isn't missed (the reaper settles the hold first)", async () => {
  const u = await F.account("tick32e", 100);
  const aid = await F.automation({ userId: u.id, spec: DAILY });
  const rid = await F.runRow({ automationId: aid, userId: u.id, origin: "schedule", graceUntil: Date.now() - 60_000 });
  await sql(
    `INSERT INTO credit_holds (ref, user_id, run_id, held, model, input_cents, left_cents, lease_until, created_at) VALUES (?, ?, ?, 20, 'm', 0, 0, ${NOW} + 120000, ${NOW})`,
    [`auto:${rid}:a1:1`, u.id, rid],
  );
  assert.equal((await tick()).report.missed, 0);
  assert.deepEqual((await runsOf(aid)).map((r) => [r.status, r.outcome]), [["queued", ""]]);
});

test("a Run once now waiting in the queue isn't superseded by the next slot: only a schedule's own runs are", async () => {
  const u = await F.account("tick32f", 100);
  const aid = await F.automation({ userId: u.id, spec: DAILY, nextAt: Date.now() - 1000 });
  const mine = await F.runRow({ automationId: aid, userId: u.id });
  await tick();
  const runs = await runsOf(aid);
  assert.equal(runs.find((r) => r.id === mine)?.outcome, "", "the owner's run goes on");
  assert.equal(runs.filter((r) => r.run_key.startsWith("sched:")).length, 1);
});

test("a wait for credits isn't over while the balance is only at the auto top-up level: it stays paused until it is above", async () => {
  const u = await F.account("tick32g", 100);
  await sql("INSERT INTO auto_topups (user_id, enabled, pack, below, customer, payment_method, updated_at) VALUES (?, 1, 'starter', 80, 'cus_1', 'pm_1', 0)", [u.id]);
  const aid = await F.automation({ userId: u.id, spec: DAILY, status: "paused", pausedReason: "credits", resumeAt: Date.now() - 1000, nextAt: Date.now() + 3_600_000 });
  await sql("UPDATE automations SET need_credits = 30 WHERE id = ?", [aid]);
  await tick();
  assert.equal((await one<{ status: string }>("SELECT status FROM automations WHERE id = ?", [aid]))!.status, "paused", "100 credits less a top-up level of 80 is short of 30");
  await sql("UPDATE auto_topups SET below = 50 WHERE user_id = ?", [u.id]);
  await sql("UPDATE automations SET resume_at = 1 WHERE id = ?", [aid]);
  await tick();
  assert.equal((await one<{ status: string }>("SELECT status FROM automations WHERE id = ?", [aid]))!.status, "on");
});

test("an automation being deleted keeps its rows while a step of it runs, and they go once nothing runs", async () => {
  const u = await F.account("tick33", 100);
  const aid = await F.automation({ userId: u.id, status: "deleting" });
  const rid = await F.runRow({ automationId: aid, userId: u.id, status: "running" });
  await sql(`UPDATE automation_runs SET lease_owner = 'w:' || id, lease_until = ${NOW} + 120000 WHERE id = ?`, [rid]);
  await sql("INSERT INTO automation_run_steps (run_id, step_id, attempt, user_id, kind, status, started_at) VALUES (?, 'a1', 1, ?, 'ai', 'running', 0)", [rid, u.id]);
  assert.equal(await T.deleteAutomationNow({ id: aid, user_id: u.id }), false);
  for (const [table, where, id] of [["automations", "id", aid], ["automation_versions", "automation_id", aid], ["automation_runs", "id", rid], ["automation_run_steps", "run_id", rid]]) {
    assert.ok(await one(`SELECT 1 FROM ${table} WHERE ${where} = ?`, [id]), `${table} kept while its step runs`);
  }
  await sql("UPDATE automation_runs SET lease_owner = '', lease_until = 0, finished_at = 1 WHERE id = ?", [rid]);
  assert.equal(await T.deleteAutomationNow({ id: aid, user_id: u.id }), true);
  assert.equal(await one("SELECT 1 FROM automation_runs WHERE id = ?", [rid]), null);
});

test("a slot whose automation changed between the tick's read and its write makes no run and keeps the change", async () => {
  const L = await import("../src/lib/server/leases.ts");
  const u = await F.account("tick34", 100);
  const aid = await F.automation({ userId: u.id, spec: HOURLY, nextAt: Date.now() - 1000 });
  const later = Date.now() + 3 * 3_600_000;
  // The owner's edit lands while the tick works on the slot.
  L.probes.at = async (point, info) => {
    if (point === "before-enqueue" && info?.automationId === aid) await sql("UPDATE automations SET next_at = ? WHERE id = ?", [later, aid]);
  };
  try {
    await tick();
  } finally {
    L.probes.at = () => {};
  }
  assert.deepEqual(await runsOf(aid), [], "no run of the old slot");
  assert.equal(Number((await one<{ next_at: number }>("SELECT next_at FROM automations WHERE id = ?", [aid]))!.next_at), later, "the edit stays");
});

/** Makes the first database call (a statement or a batch) whose SQL matches fail once, as a Turso 5xx would. */
async function failOnce(match: (sql: string) => boolean, work: () => Promise<unknown>): Promise<number> {
  const c = await db();
  const execute = c.execute.bind(c);
  const batch = c.batch.bind(c);
  let failed = 0;
  const text = (st: InStatement) => (typeof st === "string" ? st : st.sql);
  c.execute = (async (st: InStatement, args?: InValue[]) => {
    if (!failed && match(text(st))) {
      failed++;
      throw new Error("SERVER_ERROR: 502");
    }
    return args === undefined ? execute(st) : execute(st as string, args);
  }) as typeof c.execute;
  c.batch = (async (sts: InStatement[], mode?: "write" | "read" | "deferred") => {
    if (!failed && sts.some((st) => match(text(st)))) {
      failed++;
      throw new Error("SERVER_ERROR: 502");
    }
    return batch(sts, mode);
  }) as typeof c.batch;
  try {
    await work();
  } finally {
    c.execute = execute;
    c.batch = batch;
  }
  return failed;
}

test("a one-off's late run is missed, the one-off finished and its owner told together: a write that fails is all done again by the next tick", async () => {
  const u = await F.account("tick35", 100);
  const slot = Math.floor((Date.now() - 25 * 3_600_000) / 60_000) * 60_000;
  const iso = new Date(slot).toISOString();
  const once: Spec = { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "once", date: iso.slice(0, 10), at: iso.slice(11, 16) } } };
  const aid = await F.automation({ userId: u.id, spec: once, nextAt: 0 });
  await F.runRow({ automationId: aid, userId: u.id, origin: "schedule", runKey: `sched:${slot}`, dueAt: slot, graceUntil: slot + 86_400_000 });
  // A tick with nothing to send (no claims), as the run would otherwise be claimed.
  assert.equal(await failOnce((s) => s.includes("SET status = 'finished'"), () => T.runTick("tk")), 1);
  await tick();
  await tick();
  assert.deepEqual((await runsOf(aid)).map((r) => [r.status, r.outcome]), [["skipped", "missed"]]);
  assert.equal((await one<{ status: string }>("SELECT status FROM automations WHERE id = ?", [aid]))!.status, "finished");
  assert.equal(await count("notifications", "user_id = ? AND ref LIKE 'missed:%'", [u.id]), 1);
});

test("a one-off's slot that comes while its Run once now is still going is queued, not skipped as overlapping: it is its only slot", async () => {
  const u = await F.account("tick36", 100);
  const slot = Math.floor((Date.now() - 1000) / 60_000) * 60_000;
  const iso = new Date(slot).toISOString();
  const once: Spec = { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "once", date: iso.slice(0, 10), at: iso.slice(11, 16) } } };
  const aid = await F.automation({ userId: u.id, spec: once, nextAt: slot });
  const own = await F.runRow({ automationId: aid, userId: u.id, origin: "owner", status: "running" });
  await sql(`UPDATE automation_runs SET lease_owner = 'n:' || id, lease_until = ${NOW} + 300000 WHERE id = ?`, [own]);
  // A repeating schedule's slot is still skipped while a run of it goes.
  const daily = await F.automation({ userId: u.id, spec: DAILY, nextAt: Date.now() - 1000 });
  const going = await F.runRow({ automationId: daily, userId: u.id, origin: "owner", status: "running" });
  await sql(`UPDATE automation_runs SET lease_owner = 'n:' || id, lease_until = ${NOW} + 300000 WHERE id = ?`, [going]);
  await T.runTick("tk");
  const scheduled = (await runsOf(aid)).filter((r) => r.run_key.startsWith("sched:"));
  assert.deepEqual(scheduled.map((r) => [r.status, r.outcome]), [["queued", ""]]);
  const a = await one<{ status: string; next_at: number }>("SELECT status, next_at FROM automations WHERE id = ?", [aid]);
  assert.deepEqual([a!.status, Number(a!.next_at)], ["on", 0]);
  assert.deepEqual((await runsOf(daily)).filter((r) => r.run_key.startsWith("sched:")).map((r) => r.outcome), ["overlap"]);
});

/** Runs `before` just ahead of the first batch with a statement whose SQL matches (a write that lands in between). */
async function beforeBatch(match: (sql: string) => boolean, before: () => Promise<unknown>, work: () => Promise<unknown>) {
  const c = await db();
  const batch = c.batch.bind(c);
  let done = false;
  c.batch = (async (sts: InStatement[], mode?: "write" | "read" | "deferred") => {
    if (!done && sts.some((st) => match(typeof st === "string" ? st : st.sql))) {
      done = true;
      await before();
    }
    return batch(sts, mode);
  }) as typeof c.batch;
  try {
    await work();
  } finally {
    c.batch = batch;
  }
  return done;
}

test("a slot past its grace window is skipped as missed as it is taken: even when the late-run pass fails, it is never sent", async () => {
  const u = await F.account("tick37", 100);
  const aid = await F.automation({ userId: u.id, spec: DAILY, nextAt: Date.now() - 3 * 86_400_000 });
  let sent: { id: string }[] = [];
  assert.equal(await failOnce((s) => s.includes("FROM automation_runs r JOIN automations a ON a.id = r.automation_id"), async () => void (sent = (await tick()).sent)), 1);
  assert.deepEqual(sent, []);
  assert.deepEqual((await runsOf(aid)).map((r) => [r.status, r.outcome]), [["skipped", "missed"]]);
});

test("a pause that changed between the tick's read and its write (the owner paused it again) keeps its runs parked", async () => {
  const u = await F.account("tick38", 100);
  const aid = await F.automation({ userId: u.id, spec: DAILY, status: "paused", pausedReason: "month_cap", resumeAt: Date.now() - 1000, nextAt: 1 });
  const parked = await F.runRow({ automationId: aid, userId: u.id, parked: 1 });
  const landed = await beforeBatch(
    (s) => s.includes("SET parked = 0"),
    () => sql("UPDATE automations SET paused_reason = 'user', resume_at = 0 WHERE id = ?", [aid]),
    tick,
  );
  assert.equal(landed, true);
  assert.equal((await one<{ status: string }>("SELECT status FROM automations WHERE id = ?", [aid]))!.status, "paused");
  assert.equal(Number((await one<{ parked: number }>("SELECT parked FROM automation_runs WHERE id = ?", [parked]))!.parked), 1);
});

test("a wait for credits counts other requests' open holds as nothing: another automation's step or a chat reply holding credits never keeps it paused a day", async () => {
  const H = await import("../src/lib/server/credit-holds.ts");
  const C = await import("../src/lib/server/credits.ts");
  // A daily automation whose slot was 30 s ago, waiting for credits (its last run needed 30).
  const slot = Math.floor((Date.now() - 30_000) / 60_000) * 60_000;
  const d = new Date(slot);
  const spec: Spec = { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "daily", at: `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}` } } };
  for (const holder of ["automation", "chat"] as const) {
    const u = await F.account(`tick39${holder}`, 100);
    const aid = await F.automation({ userId: u.id, spec, status: "paused", pausedReason: "credits", resumeAt: slot, nextAt: slot });
    await sql("UPDATE automations SET need_credits = 30 WHERE id = ?", [aid]);
    if (holder === "automation") {
      // Another automation of the account is mid-step: its hold of 90 is open (it settles far lower).
      const other = await F.automation({ userId: u.id, name: "Other" });
      const rid = await F.runRow({ automationId: other, userId: u.id, status: "running" });
      await sql(`UPDATE automation_runs SET lease_owner = 'w', lease_until = ${NOW} + 300000 WHERE id = ?`, [rid]);
      assert.ok(await H.recordHold({ ref: `auto:${rid}:a1:1`, userId: u.id, runId: rid, held: 90, model: "m", inputCents: 1, leftCents: 0 }));
      await sql("INSERT INTO credit_ledger (user_id, amount, reason, ref, automation_id, created_at) VALUES (?, -90, 'automation', ?, ?, ?)", [u.id, `auto:${rid}:a1:1`, other, Date.now()]);
    } else {
      // A chat reply holds 90 while it is written, as the chat route charges it.
      assert.ok(await C.charge(u.id, 90, "ultra request"));
    }
    assert.equal(await F.balance(u.id), 10);
    await tick();
    assert.equal((await one<{ status: string }>("SELECT status FROM automations WHERE id = ?", [aid]))!.status, "on", holder);
    assert.deepEqual((await runsOf(aid)).map((r) => r.run_key), [`sched:${slot}`], `${holder}: today's slot runs`);
  }
});

test("a one-off whose time went by while it was paused for credits or a limit is finished, with a notice, never turned on with no next run", async () => {
  // Its time was 25 hours ago (past its grace of a day); its pause ends now.
  const slot = Math.floor((Date.now() - 25 * 3_600_000) / 60_000) * 60_000;
  const iso = new Date(slot).toISOString();
  const spec: Spec = { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "once", date: iso.slice(0, 10), at: iso.slice(11, 16) } } };
  for (const [reason, credits] of [["credits", 500], ["credits", 0], ["month_cap", 500], ["day_cap", 500]] as const) {
    const u = await F.account(`tick40${reason}${credits}`, credits);
    const aid = await F.automation({ userId: u.id, spec, status: "paused", pausedReason: reason, resumeAt: Date.now() - 1000, nextAt: slot });
    await sql("UPDATE automations SET need_credits = 5 WHERE id = ?", [aid]);
    // A Run once now of it, parked with it, goes on.
    const own = await F.runRow({ automationId: aid, userId: u.id, parked: 1 });
    await tick();
    const a = (await one<{ status: string; next_at: number; paused_reason: string; resume_at: number }>("SELECT status, next_at, paused_reason, resume_at FROM automations WHERE id = ?", [aid]))!;
    assert.deepEqual([a.status, Number(a.next_at), a.paused_reason, Number(a.resume_at)], ["finished", 0, "", 0], `${reason} with ${credits}`);
    assert.equal(await count("automation_runs", "automation_id = ? AND origin = 'schedule'", [aid]), 0, "nothing scheduled");
    assert.equal(Number((await one<{ parked: number }>("SELECT parked FROM automation_runs WHERE id = ?", [own]))!.parked), 0);
    assert.deepEqual(
      (await all<{ kind: string; phrase: string }>("SELECT kind, phrase FROM notifications WHERE user_id = ?", [u.id])).map((n) => [n.kind, n.phrase]),
      [["missed", (await import("../src/lib/automations.ts")).NOTICES.missed]],
    );
    await tick();
    assert.equal(await count("notifications", "user_id = ?", [u.id]), 1, "told once");
  }
  // One whose scheduled run is still open (paused part way) is turned on as usual: that run goes on, and its end finishes it.
  const u = await F.account("tick40open", 500);
  const aid = await F.automation({ userId: u.id, spec, status: "paused", pausedReason: "month_cap", resumeAt: Date.now() - 1000, nextAt: 0 });
  const open = await F.runRow({ automationId: aid, userId: u.id, origin: "schedule", runKey: `sched:${slot}`, parked: 1, status: "running", step: "n1" });
  await tick();
  assert.equal((await one<{ status: string }>("SELECT status FROM automations WHERE id = ?", [aid]))!.status, "on");
  assert.equal(Number((await one<{ parked: number }>("SELECT parked FROM automation_runs WHERE id = ?", [open]))!.parked), 0);
});

test("a late run claimed and started by another tick between the late-run pass's read and its write is left alone: no step closed, one-off kept on, no notice", async () => {
  const u = await F.account("tick41", 100);
  const iso = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const spec: Spec = { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "once", date: iso.slice(0, 10), at: iso.slice(11, 16) } } };
  // A one-off whose slot was taken (next_at 0), its run queued and past its grace window.
  const aid = await F.automation({ userId: u.id, spec, nextAt: 0 });
  const rid = await F.runRow({ automationId: aid, userId: u.id, origin: "schedule", runKey: "sched:1", graceUntil: Date.now() - 60_000 });
  const landed = await beforeBatch(
    (s) => s.includes("SET status = 'skipped', outcome = 'missed', finished_at"),
    async () => {
      // Another tick claims it and its worker starts its first step.
      await sql(`UPDATE automation_runs SET status = 'running', lease_owner = 'w:x', lease_until = ${NOW} + 600000 WHERE id = ?`, [rid]);
      await sql("INSERT INTO automation_run_steps (run_id, step_id, attempt, user_id, kind, status, started_at) VALUES (?, 'a1', 1, ?, 'ai', 'running', 1)", [rid, u.id]);
    },
    tick,
  );
  assert.equal(landed, true);
  assert.deepEqual(
    [(await one<{ status: string }>("SELECT status FROM automation_runs WHERE id = ?", [rid]))!.status, (await one<{ status: string }>("SELECT status FROM automation_run_steps WHERE run_id = ?", [rid]))!.status],
    ["running", "running"],
  );
  assert.equal((await one<{ status: string }>("SELECT status FROM automations WHERE id = ?", [aid]))!.status, "on");
  assert.equal(await count("notifications", "user_id = ?", [u.id]), 0);
});
