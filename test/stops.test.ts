import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
const { requestStop, watchStop } = await import("../src/lib/server/stops.ts");
const { one } = await import("../src/lib/server/db.ts");

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return check();
};

test("Stop reaches a request running on the same instance at once", async () => {
  let stops = 0;
  const end = watchStop("u1", "r1", () => stops++, 60_000);
  await requestStop("u1", "r1");
  assert.equal(stops, 1);
  await requestStop("u1", "r1");
  assert.equal(stops, 1, "heard once");
  assert.ok(await one("SELECT 1 FROM chat_stops WHERE user_id = 'u1' AND reply_id = 'r1'"), "recorded for other instances");
  end();
  const cleared = async () => !(await one("SELECT 1 FROM chat_stops WHERE user_id = 'u1' AND reply_id = 'r1'"));
  const deadline = Date.now() + 2000;
  while (!(await cleared()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(await cleared(), "cleared once its request is over");
});

test("old Stops are cleared by time, with an index so that stays quick", async () => {
  const { run, now } = await import("../src/lib/server/db.ts");
  await run("INSERT INTO chat_stops (user_id, reply_id, created_at) VALUES ('old', 'r', ?)", [now() - 2 * 3600_000]);
  await requestStop("u9", "r9");
  assert.equal(await one("SELECT 1 FROM chat_stops WHERE user_id = 'old'"), null);
  const plan = await one<{ detail: string }>("EXPLAIN QUERY PLAN DELETE FROM chat_stops WHERE created_at < 1");
  assert.match(plan!.detail, /chat_stops_time/);
});

test("Stop recorded by another instance is heard from the database", async () => {
  let stops = 0;
  const end = watchStop("u2", "r2", () => stops++, 20);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(stops, 0);
  // As if POST /api/chat/stop ran on another server: only the database row is there.
  const { run, now } = await import("../src/lib/server/db.ts");
  await run("INSERT INTO chat_stops (user_id, reply_id, created_at) VALUES ('u2', 'r2', ?)", [now()]);
  assert.ok(await until(() => stops === 1));
  end();
});

test("Stop pressed before the request started is heard when it starts", async () => {
  await requestStop("u3", "r3");
  let stops = 0;
  const end = watchStop("u3", "r3", () => stops++, 60_000);
  assert.ok(await until(() => stops === 1));
  end();
});

test("Stop is for one user's one reply, and a finished request no longer listens", async () => {
  let stops = 0;
  const end = watchStop("u4", "r4", () => stops++, 20);
  await requestStop("someone-else", "r4");
  await requestStop("u4", "another-reply");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(stops, 0);
  end();
  await requestStop("u4", "r4");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(stops, 0);
});
