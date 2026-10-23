import { test } from "node:test";
import assert from "node:assert/strict";

/*
 * Teams in published apps: an app open only to the people its owner invited, members and managers,
 * and the "team" and "personal" rules, all checked by Flash's server whatever the app's code does.
 */
process.env.DATABASE_URL = ":memory:";

const { run, one } = await import("../src/lib/server/db.ts");
const { siteAuth, visitorForSession, newPageToken } = await import("../src/lib/server/site-auth.ts");
const { listRecords, addRecord, patchRecord, removeRecord, chooseRule } = await import("../src/lib/server/site-data.ts");
const { callerFor } = await import("../src/lib/server/site-owner.ts");
const { publishSite, unpublishSite } = await import("../src/lib/server/sites.ts");
const { appAccess, chooseAccess, invite, uninvite, listInvites, asMember } = await import("../src/lib/server/site-team.ts");
const { serveSite } = await import("../src/lib/server/serve-site.ts");
const { ANYONE, OWNER } = await import("../src/lib/data-rules.ts");

const owner = { id: "owner", email: "o@x.io", name: "", verified_at: 1 } as never;
await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('owner', 'o@x.io', '', 0, 1)");

const flashData = (rules: object) => `<script type="application/json" id="flash-data">${JSON.stringify(rules)}</script>`;
async function publish(html: string, title = "CRM"): Promise<string> {
  await run("DELETE FROM rate_limits");
  const result = await publishSite(owner, { html, title });
  assert.ok("slug" in result, JSON.stringify(result));
  return result.slug;
}
const cookieToken = (cookie?: string) => cookie?.split("=")[1].split(";")[0] ?? "";
let ips = 0;
/** Signs someone up (or in), and returns their session and who they are to the data API. */
async function join(slug: string, email: string, action = "signup") {
  await run("DELETE FROM rate_limits");
  const done = await siteAuth(slug, action, { email, password: "longenough1" }, `10.0.0.${++ips}`, `/p/${slug}`, true, null);
  if (done.result !== "ok") return { result: done.result };
  const session = cookieToken(done.cookie);
  const who = (await visitorForSession(slug, session))!;
  const header = `Bearer ${await newPageToken(who.id, slug, session)}`;
  return { result: "ok", session, header, caller: await callerFor(slug, header), id: who.id };
}
const records = (answer: { body: unknown }) => (answer.body as { records: Record<string, unknown>[] }).records;
const record = (answer: { body: unknown }) => (answer.body as { record: Record<string, unknown> }).record;

const CRM = `<!doctype html><html><body><h1>CRM</h1><script>flashDB.list("deals")</script>${flashData({ accounts: "team", deals: "personal" })}</body></html>`;

test("an app with team rules is open only to invited people, unless its owner says otherwise", async () => {
  const slug = await publish(CRM);
  assert.deepEqual(await appAccess(slug), { chosen: "", access: "invited" });
  const bakery = await publish("<p>Bakery</p>", "Bakery");
  assert.deepEqual(await appAccess(bakery), { chosen: "", access: "anyone" }, "other apps stay open");
  await chooseRule(bakery, "orders", "team");
  assert.deepEqual(await appAccess(bakery), { chosen: "", access: "invited" }, "a team rule the owner chose closes it too");

  assert.equal((await join(slug, "stranger@x.io")).result, "invite-only", "nobody signs themselves up");
  assert.deepEqual(await invite(slug, ["Ann@X.io", "bob@x.io"], "member"), { saved: 2 });
  assert.deepEqual(await invite(slug, ["not an email"], "member"), { error: "bad-email" });
  const ann = await join(slug, "ann@x.io");
  assert.equal(ann.result, "ok", "an invited person signs up");
  assert.deepEqual(ann.caller, { kind: "visitor", id: ann.id });

  // Without signing in, nothing at all: not the team's records, not even adding.
  for (const collection of ["accounts", "deals", "anything"]) {
    assert.equal((await listRecords(slug, collection, "", "", ANYONE)).status, 401, collection);
    assert.equal((await addRecord(slug, collection, { name: "x" }, "", ANYONE)).status, 401, collection);
  }

  // The owner opens it to anyone: strangers can sign up, but team records still need signing in.
  await chooseAccess(slug, "anyone");
  assert.equal((await join(slug, "stranger@x.io")).result, "ok");
  assert.equal((await listRecords(slug, "accounts", "", "", ANYONE)).status, 401);
  await chooseAccess(slug, "invited");
  // Back to invited only: the stranger can't sign in, and a page key they hold stops working.
  assert.equal((await join(slug, "stranger@x.io", "signin")).result, "invite-only");
});

test("members see the team's records, and in a personal collection only their own; managers see and change all", async () => {
  const slug = await publish(CRM);
  await invite(slug, ["ann@x.io", "bob@x.io"], "member");
  await invite(slug, ["boss@x.io"], "manager");
  const ann = await join(slug, "ann@x.io");
  const bob = await join(slug, "bob@x.io");
  const boss = await join(slug, "boss@x.io");
  assert.deepEqual(boss.caller, { kind: "visitor", id: boss.id, manager: true });
  const [a, b, m] = [ann.caller!, bob.caller!, boss.caller!];

  // "team": everyone in the team sees everything; each changes their own; the manager changes any.
  const acme = record(await addRecord(slug, "accounts", { name: "Acme" }, "", a));
  await addRecord(slug, "accounts", { name: "Globex" }, "", b);
  assert.deepEqual(records(await listRecords(slug, "accounts", "", "", b)).map((r) => r.name).sort(), ["Acme", "Globex"]);
  assert.equal((await patchRecord(slug, "accounts", acme.id, { name: "Hacked" }, "", b)).status, 403);
  assert.equal((await removeRecord(slug, "accounts", acme.id as string, "", b)).status, 403);
  assert.equal((await patchRecord(slug, "accounts", acme.id, { name: "Acme Ltd" }, "", m)).status, 200);
  assert.equal((await patchRecord(slug, "accounts", acme.id, { stage: "won" }, "", a)).status, 200);

  // "personal": each member sees only their deals; the manager sees everyone's.
  const annDeal = record(await addRecord(slug, "deals", { value: 100 }, "", a));
  await addRecord(slug, "deals", { value: 200 }, "", b);
  assert.deepEqual(records(await listRecords(slug, "deals", "", "", a)).map((r) => r.value), [100]);
  assert.deepEqual(records(await listRecords(slug, "deals", "", "", b)).map((r) => r.value), [200]);
  assert.deepEqual(records(await listRecords(slug, "deals", "", "", m)).map((r) => r.value).sort(), [100, 200]);
  assert.deepEqual(records(await listRecords(slug, "deals", "", "", OWNER)).map((r) => r.value).sort(), [100, 200], "the owner in Flash sees all");
  assert.equal((await patchRecord(slug, "deals", annDeal.id, { value: 1 }, "", b)).status, 403, "Bob can't change Ann's deal");
  assert.equal((await patchRecord(slug, "deals", annDeal.id, { value: 150 }, "", m)).status, 200);
  assert.equal((await removeRecord(slug, "deals", annDeal.id as string, "", m)).status, 200);

  // Making Bob a manager takes effect on his next request; taking his invitation back ends his access.
  await invite(slug, ["bob@x.io"], "manager");
  assert.deepEqual(await callerFor(slug, bob.header!), { kind: "visitor", id: bob.id, manager: true });
  assert.equal(await uninvite(slug, "bob@x.io"), true);
  assert.deepEqual(await callerFor(slug, bob.header!), ANYONE);
  assert.equal(await asMember(slug, await visitorForSession(slug, bob.session!)), null);
  assert.equal(await one("SELECT 1 FROM site_sessions WHERE site_user_id = ?", [bob.id!]), null, "his sign-ins ended");
  assert.equal((await listRecords(slug, "accounts", "", "", await callerFor(slug, bob.header!))).status, 401);
  assert.equal((await join(slug, "bob@x.io", "signin")).result, "invite-only");

  const listed = await listInvites(slug);
  assert.deepEqual(listed.map((i) => [i.email, i.role, i.joined]).sort(), [["ann@x.io", "member", true], ["boss@x.io", "manager", true]]);
});

test("the page tells the app who is signed in and their role, and nobody whose invitation was taken back", async () => {
  const slug = await publish(CRM);
  await invite(slug, ["boss@x.io", "ann@x.io"], "manager");
  const boss = await join(slug, "boss@x.io");
  const ann = await join(slug, "ann@x.io");
  const page = async (session: string) =>
    (await (await serveSite(slug, undefined, new Request(`https://www.flash-app.dev/p/${slug}`, { headers: { cookie: `flash_app_session=${session}` } })))!.text());
  assert.match(await page(boss.session!), /"email":"boss@x\.io"[^}]*"role":"manager"/);
  await uninvite(slug, "ann@x.io");
  assert.doesNotMatch(await page(ann.session!), /ann@x\.io/);
});

test("unpublishing takes the invitations too", async () => {
  const slug = await publish(CRM);
  await invite(slug, ["ann@x.io"], "member");
  assert.ok(await unpublishSite("owner", slug));
  assert.equal(await one("SELECT 1 FROM site_invites WHERE site_slug = ?", [slug]), null);
});


