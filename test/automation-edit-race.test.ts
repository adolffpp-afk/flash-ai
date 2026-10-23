import { test, after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./support/route-hooks.mjs", import.meta.url);

/*
 * An edit that keeps an automation's next run (a rename, a pause) while the tick takes that slot, between
 * the edit's read and its write: the edit leaves next_at as the tick left it (0, its run made), so the
 * taken slot never comes back. A one-off renamed then still finishes after its run, and one paused can
 * be resumed, its run going on.
 */
const { claudeStandIn } = await import("./support/claude-stand-in.ts");
const claude = await claudeStandIn();
process.env.DATABASE_URL = ":memory:";
process.env.ANTHROPIC_BASE_URL = claude.url;
process.env.ANTHROPIC_API_KEY = "chat-key-for-tests";
process.env.ANTHROPIC_AUTOMATIONS_API_KEY = "automations-key-for-tests";
process.env.FLASH_ADMIN_EMAILS = "racer@example.com, pauser@example.com";
process.env.AUTOMATIONS_DEV = "1";
process.env.CRON_SECRET = "c".repeat(40);
process.env.FLASH_APP_URL = "http://flash.test";
for (const name of ["VERCEL_ENV", "VERCEL", "RESEND_API_KEY", "FLASH_DEMO_EMAILS", "FRED_API_KEY", "AUTOMATION_MAX_PAID"]) delete process.env[name];

// Token counts wait while `gate` is set (Anthropic answering in a second or two, as it does).
let gate: Promise<void> | null = null;
let counting: () => void = () => {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes("/count_tokens") && gate) {
    counting();
    await gate;
  }
  return realFetch(input, init);
}) as typeof fetch;

const { one, all, run: sql } = await import("../src/lib/server/db.ts");
const F = await import("./support/automation-fixtures.ts");
const R = await import("../src/lib/server/automation-runner.ts");
const T = await import("../src/lib/server/automation-tick.ts");
const oneRoute = await import("../src/app/api/automations/[id]/route.ts");
const { afterwards } = (await import("./support/next-server.mjs")) as unknown as { afterwards: () => Promise<unknown> };
type Spec = import("../src/lib/automations.ts").Spec;
after(() => claude.close());

const BASE = "http://flash.test";
const patch = (cookie: string, id: string, json: unknown) =>
  oneRoute.PATCH(new Request(`${BASE}/api/automations/${id}`, { method: "PATCH", headers: { cookie, "content-type": "application/json", origin: BASE }, body: JSON.stringify(json) }), { params: Promise.resolve({ id }) } as never);
const tick = () => T.runTick("tk", { dispatch: async () => {} });
const autoOf = (id: string) => one<{ status: string; next_at: number; name: string }>("SELECT status, next_at, name FROM automations WHERE id = ?", [id]);
async function lease(runId: string) {
  await sql(`UPDATE automation_runs SET lease_owner = 'w:' || id, lease_until = CAST(unixepoch('subsec') * 1000 AS INTEGER) + 120000, status = CASE status WHEN 'queued' THEN 'running' ELSE status END WHERE id = ?`, [runId]);
  return `w:${runId}`;
}

function onceAt(t: number): Spec {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "once", date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, at: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` } } };
}

test("a one-off renamed just as the tick takes its slot finishes after its run (the taken slot isn't written back)", async () => {
  await sql("INSERT INTO settings (key, value) VALUES ('auto:daily', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [new Date().toISOString().slice(0, 10)]);
  const u = await F.account("racer", 500, { email: "racer@example.com" });
  const slot = Math.floor(Date.now() / 60_000) * 60_000;
  const aid = await F.automation({ userId: u.id, spec: onceAt(slot), nextAt: slot, name: "Old name" });
  // The owner renames it in the minute it is due: the edit reads the automation, then prices it (a token count).
  let release!: () => void;
  gate = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (counting = r));
  const editing = patch(u.cookie, aid, { name: "New name" });
  await reached;
  // Meanwhile the tick takes the slot (next_at -> 0) and makes its run.
  await tick();
  assert.equal(Number((await autoOf(aid))!.next_at), 0, "the tick took the slot");
  release();
  gate = null;
  const res = await editing;
  assert.equal(res.status, 200, await res.clone().text());
  await afterwards();
  assert.deepEqual({ ...(await autoOf(aid)) }, { status: "on", next_at: 0, name: "New name" }, "renamed, its slot still taken");
  const runs = await all<{ id: string; status: string; run_key: string }>("SELECT id, status, run_key FROM automation_runs WHERE automation_id = ?", [aid]);
  assert.equal(runs.length, 1);
  // Its run goes and ends before the next tick.
  await R.advanceRun(runs[0].id, await lease(runs[0].id), Date.now() + 760_000);
  assert.deepEqual({ ...(await one<{ status: string; outcome: string }>("SELECT status, outcome FROM automation_runs WHERE id = ?", [runs[0].id])) }, { status: "done", outcome: "ok" });
  assert.equal((await autoOf(aid))!.status, "finished", "a one-off that ran is finished");
  await tick();
  assert.equal((await autoOf(aid))!.status, "finished");
  assert.equal((await all("SELECT 1 FROM automation_runs WHERE automation_id = ?", [aid])).length, 1, "it ran once");
});

test("a one-off paused just as the tick takes its slot can be resumed, and its parked run goes on", async () => {
  const u = await F.account("pauser", 500, { email: "pauser@example.com" });
  const slot = Math.floor(Date.now() / 60_000) * 60_000;
  const aid = await F.automation({ userId: u.id, spec: onceAt(slot), nextAt: slot, name: "Pause me" });
  // The pause reads the automation; between that read and its write the tick takes the slot. (A slow
  // read stands in for the time between them: the client's execute is held for the version read.)
  const client = await (await import("../src/lib/server/db.ts")).db();
  const execute = client.execute.bind(client);
  let resume!: () => void;
  let hold: Promise<void> | null = new Promise<void>((r) => (resume = r));
  let seen!: () => void;
  const atRead = new Promise<void>((r) => (seen = r));
  (client as unknown as { execute: typeof execute }).execute = (async (stmt: string | { sql: string }) => {
    const text = typeof stmt === "string" ? stmt : stmt.sql;
    if (hold && text.startsWith("SELECT spec FROM automation_versions")) {
      const h = hold;
      hold = null;
      seen();
      await h;
    }
    return execute(stmt as never);
  }) as typeof execute;
  const pausing = patch(u.cookie, aid, { status: "paused" });
  await atRead;
  await tick();
  assert.equal(Number((await autoOf(aid))!.next_at), 0, "the tick took the slot");
  resume();
  const res = await pausing;
  assert.equal(res.status, 200, await res.clone().text());
  (client as unknown as { execute: typeof execute }).execute = execute;
  assert.deepEqual({ ...(await autoOf(aid)) }, { status: "paused", next_at: 0, name: "Pause me" }, "paused, its slot still taken");
  const run = (await one<{ id: string }>("SELECT id FROM automation_runs WHERE automation_id = ?", [aid]))!;
  // Its run's worker sees the pause before its first step and parks it.
  await R.advanceRun(run.id, await lease(run.id), Date.now() + 760_000);
  assert.equal(Number((await one<{ parked: number }>("SELECT parked FROM automation_runs WHERE id = ?", [run.id]))!.parked), 1, "parked");
  // Turned on at the price the owner saw (the first answer gives it, as the card's Resume does).
  const priced = (await (await patch(u.cookie, aid, { status: "on" })).json()) as { code: string; estimate: { worst: number } };
  assert.equal(priced.code, "price_changed", "not once_passed: its time was taken by its run");
  const back = await patch(u.cookie, aid, { status: "on", seenMax: priced.estimate.worst });
  assert.equal(back.status, 200, `resumed, as a one-off paused while its run waits is: ${await back.clone().text()}`);
  assert.equal(Number((await one<{ parked: number }>("SELECT parked FROM automation_runs WHERE id = ?", [run.id]))!.parked), 0, "its run goes on");
  await R.advanceRun(run.id, await lease(run.id), Date.now() + 760_000);
  assert.deepEqual({ ...(await one<{ status: string; outcome: string }>("SELECT status, outcome FROM automation_runs WHERE id = ?", [run.id])) }, { status: "done", outcome: "ok" });
  assert.equal((await autoOf(aid))!.status, "finished");
});
