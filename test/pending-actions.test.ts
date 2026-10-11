import { test, before } from "node:test";
import assert from "node:assert/strict";

/*
 * Connector calls waiting for the user (pending-actions.ts): an approval is taken once, only by its
 * own user, only for the input the card showed and only before it expires; it writes nothing to the
 * credit ledger; and only Flash's own page can send one.
 */
process.env.DATABASE_URL = ":memory:";

const { ACTION_TTL_MS, approvalAllowed, approvedResults, cancelAction, claimAction, finishAction, inputHash, proposeAction, actionStatus } = await import(
  "../src/lib/server/pending-actions.ts"
);
const { all, run } = await import("../src/lib/server/db.ts");

const user = "user-1";
const card = (input: Record<string, unknown> = { to: "sam@example.com", note: "Hi" }, at?: number) =>
  proposeAction({ userId: user, connectionId: "conn-1", connection: "Resend", host: "mcp.resend.com", tool: "send_email", title: "Send email", toolHash: "h", kind: "write", custom: false, input, at });

before(async () => {
  await run("INSERT INTO users (id, email, name, password_hash, preferences, created_at, last_free_grant) VALUES (?, ?, '', 'x', '', 0, 0)", [user, "a@example.com"]);
  await run("INSERT INTO connections (id, user_id, provider, kind, label, url, created_at) VALUES ('conn-1', ?, 'resend', 'preset', 'Resend', '', 0)", [user]);
});

test("the input hash doesn't depend on key order, and does on every value", () => {
  assert.equal(inputHash({ a: 1, b: { c: 2, d: 3 } }), inputHash({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(inputHash({ a: 1 }), inputHash({ a: 2 }));
  assert.notEqual(inputHash({ to: "sam@example.com" }), inputHash({ to: "sam@example.com", cc: "x@example.com" }));
});

test("an approval is taken once, by its own user, for the input on the card, before it expires", async () => {
  const c = await card();
  assert.equal(c.status, "pending");
  assert.equal(c.inputHash, inputHash({ note: "Hi", to: "sam@example.com" }));
  assert.equal(await claimAction("someone-else", c.id, c.inputHash), null, "another user");
  assert.equal(await claimAction(user, c.id, inputHash({ to: "attacker@example.com", note: "Hi" })), null, "another input");
  assert.equal(await claimAction(user, c.id, c.inputHash, c.expiresAt), null, "too late");
  // Two clicks at once: only one wins.
  const [a, b] = await Promise.all([claimAction(user, c.id, c.inputHash), claimAction(user, c.id, c.inputHash)]);
  assert.equal([a, b].filter(Boolean).length, 1);
  assert.equal(await claimAction(user, c.id, c.inputHash), null, "once only");
  assert.deepEqual(await actionStatus(user, c.id), { status: "pending" }, "running shows as waiting");
  await finishAction(c.id, true, "Sent.");
  assert.deepEqual(await actionStatus(user, c.id), { status: "done", result: "Sent." });
  assert.equal(await actionStatus("someone-else", c.id), null, "nobody else sees it");
  assert.deepEqual(await all("SELECT * FROM credit_ledger"), [], "approving writes nothing to the ledger");
});

test("a cancelled or expired card can't be approved", async () => {
  const c = await card();
  assert.equal(await cancelAction("someone-else", c.id), false);
  assert.equal(await cancelAction(user, c.id), true);
  assert.equal(await cancelAction(user, c.id), false, "once");
  assert.equal(await claimAction(user, c.id, c.inputHash), null);
  assert.deepEqual(await actionStatus(user, c.id), { status: "cancelled" });
  const old = await card({ to: "x@example.com", note: "Old" }, Date.now() - ACTION_TTL_MS - 1000);
  assert.deepEqual(await actionStatus(user, old.id), { status: "expired" });
  assert.equal(await claimAction(user, old.id, old.inputHash), null);
});

test("an approved result continues one answer, once, for its own user, and only while it is recent", async () => {
  const c = await card({ to: "a@example.com", note: "1" });
  await claimAction(user, c.id, c.inputHash);
  await finishAction(c.id, true, "Sent.");
  const pending = await card({ to: "b@example.com", note: "2" });
  assert.deepEqual((await approvedResults(user, [c.id, pending.id])).map((r) => r.id), [c.id], "only done ones");
  assert.equal((await approvedResults("someone-else", [c.id])).length, 0);
  assert.equal((await approvedResults(user, [c.id], { at: Date.now() + ACTION_TTL_MS + 1000 })).length, 0, "not after 30 minutes");
  assert.equal((await approvedResults(user, [c.id], { take: true })).length, 1);
  assert.equal((await approvedResults(user, [c.id], { take: true })).length, 0, "used once");
});

test("finished and long-expired rows are cleared when a new one is written", async () => {
  const day = 24 * 60 * 60_000;
  const old = await card({ to: "old@example.com", note: "old" }, Date.now() - 2 * day);
  await cancelAction(user, old.id, Date.now() - 2 * day);
  const stale = await card({ to: "stale@example.com", note: "stale" }, Date.now() - 2 * day);
  const fresh = await card({ to: "new@example.com", note: "new" });
  const ids = (await all<{ id: string }>("SELECT id FROM pending_actions")).map((r) => r.id);
  assert.ok(!ids.includes(old.id) && !ids.includes(stale.id));
  assert.ok(ids.includes(fresh.id));
});

test("only Flash's own page can approve: JSON, with exactly Flash's origin", () => {
  const own = "https://flash.example";
  const mine = [own, "https://www.flash.example"];
  const req = (headers: Record<string, string>) => new Request(`${own}/api/connect/actions/x`, { method: "POST", headers });
  const json = { "content-type": "application/json" };
  assert.equal(approvalAllowed(req({ ...json, origin: own }), mine), true);
  assert.equal(approvalAllowed(req({ ...json, origin: "https://www.flash.example" }), mine), true, "the address the request came to");
  assert.equal(approvalAllowed(req({ ...json, origin: own, "sec-fetch-site": "same-origin" }), mine), true);
  assert.equal(approvalAllowed(req({ ...json }), mine), false, "no Origin");
  assert.equal(approvalAllowed(req({ ...json, origin: "null" }), mine), false, "a sandboxed page (a published app)");
  assert.equal(approvalAllowed(req({ ...json, origin: "https://evil.example" }), mine), false);
  assert.equal(approvalAllowed(req({ ...json, origin: "https://flash.example.evil.example" }), mine), false);
  assert.equal(approvalAllowed(req({ ...json, origin: "http://flash.example" }), mine), false, "another scheme");
  assert.equal(approvalAllowed(req({ "content-type": "text/plain", origin: own }), mine), false, "a form post");
  assert.equal(approvalAllowed(req({ ...json, origin: own, "sec-fetch-site": "cross-site" }), mine), false);
});
