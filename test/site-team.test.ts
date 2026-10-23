import { test } from "node:test";
import assert from "node:assert/strict";

/*
 * Teams in published apps: an app open only to the people its owner invited, members and managers,
 * and the "team" and "personal" rules, all checked by Flash's server whatever the app's code does.
 */
process.env.DATABASE_URL = ":memory:";
// Emails go nowhere: each one sent is kept here, so the tests can open the links in them.
process.env.RESEND_API_KEY = "re_test";
const sent: { to: string; text: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).includes("resend.com")) {
    const body = JSON.parse(String(init?.body));
    sent.push({ to: body.to[0], text: body.text });
    return new Response("{}", { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;
/** The token in the newest link emailed to this address. */
const lastLink = (to: string) => [...sent].reverse().find((m) => m.to === to)?.text.match(/verify\?t=([\w-]+)/)?.[1] ?? "";

const { run, one } = await import("../src/lib/server/db.ts");
const { siteAuth, visitorForSession, newPageToken } = await import("../src/lib/server/site-auth.ts");
const { listRecords, addRecord, patchRecord, removeRecord, chooseRule } = await import("../src/lib/server/site-data.ts");
const { callerFor } = await import("../src/lib/server/site-owner.ts");
const { publishSite, unpublishSite } = await import("../src/lib/server/sites.ts");
const { appAccess, chooseAccess, invite, uninvite, listInvites, asMember } = await import("../src/lib/server/site-team.ts");
const { serveSite } = await import("../src/lib/server/serve-site.ts");
const { confirmVerifyLink } = await import("../src/lib/server/site-verify.ts");
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
async function join(slug: string, email: string, action = "signup", password = "longenough1") {
  await run("DELETE FROM rate_limits");
  const done = await siteAuth(slug, action, { email, password }, `10.0.0.${++ips}`, `/p/${slug}`, true, null);
  if (done.result !== "ok") return { result: done.result };
  const session = cookieToken(done.cookie);
  const who = (await visitorForSession(slug, session))!;
  const header = `Bearer ${await newPageToken(who.id, slug, session)}`;
  return { result: "ok", session, header, caller: await callerFor(slug, header), id: who.id };
}
/** Joins an invite-only app as its invited people do: sign up, open the emailed link, sign in. */
async function joinInvited(slug: string, email: string, password = "longenough1") {
  assert.equal((await join(slug, email, "signup", password)).result, "check-email");
  assert.equal(await confirmVerifyLink(slug, lastLink(email)), true);
  return join(slug, email, "signin", password);
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

  // Strangers get the same answer as invited people, so the invitations can't be guessed; nothing is made or sent.
  assert.equal((await join(slug, "stranger@x.io")).result, "check-email", "nobody signs themselves up");
  assert.equal(await one("SELECT 1 FROM site_users WHERE site_slug = ? AND email = 'stranger@x.io'", [slug]), null);
  assert.equal(lastLink("stranger@x.io"), "");
  assert.deepEqual(await invite(slug, ["Ann@X.io", "bob@x.io"], "member"), { saved: 2 });
  assert.deepEqual(await invite(slug, ["not an email"], "member"), { error: "bad-email" });
  assert.equal((await join(slug, "ann@x.io")).result, "check-email", "an invited person proves their address first");
  assert.equal((await join(slug, "ann@x.io", "signin")).result, "check-email", "and can't sign in before");
  assert.equal(await confirmVerifyLink(slug, lastLink("ann@x.io")), true);
  assert.equal(await confirmVerifyLink(slug, lastLink("ann@x.io")), false, "a link works once");
  const ann = await join(slug, "ann@x.io", "signin");
  assert.equal(ann.result, "ok");
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
  // Back to invited only: the stranger can't sign in, with the same answer as a wrong password.
  assert.equal((await join(slug, "stranger@x.io", "signin")).result, "wrong");
  assert.equal((await join(slug, "ann@x.io", "signin", "not-her-password")).result, "wrong");
});

test("nobody can take someone else's invitation by signing up with their address first", async () => {
  const slug = await publish(CRM);
  await invite(slug, ["carol@x.io"], "manager");
  // Someone who knows Carol's address signs up with it, and then also while the app was open.
  assert.equal((await join(slug, "carol@x.io", "signup", "attacker-pass")).result, "check-email");
  assert.equal((await join(slug, "carol@x.io", "signin", "attacker-pass")).result, "check-email", "not in until the address is proved");
  const attackerLink = lastLink("carol@x.io");
  // The real Carol signs up with her own password and opens her link: her password is the one that holds.
  assert.equal((await join(slug, "carol@x.io", "signup", "carols-own-pass")).result, "check-email");
  assert.equal(await confirmVerifyLink(slug, lastLink("carol@x.io")), true);
  assert.equal(await confirmVerifyLink(slug, attackerLink), false, "the other links are spent");
  assert.equal((await join(slug, "carol@x.io", "signin", "attacker-pass")).result, "wrong");
  const carol = await join(slug, "carol@x.io", "signin", "carols-own-pass");
  assert.deepEqual(carol.caller, { kind: "visitor", id: carol.id, manager: true });

  // In an app open to anyone, an account made with an invited manager's address before it was proved is only a member.
  const open = await publish(CRM, "Open CRM");
  await chooseAccess(open, "anyone");
  const early = await join(open, "dan@x.io", "signup", "whoever-long");
  assert.equal(early.result, "ok");
  await invite(open, ["dan@x.io"], "manager");
  assert.deepEqual(await callerFor(open, early.header!), { kind: "visitor", id: early.id });
});

test("members see the team's records, and in a personal collection only their own; managers see and change all", async () => {
  const slug = await publish(CRM);
  await invite(slug, ["ann@x.io", "bob@x.io"], "member");
  await invite(slug, ["boss@x.io"], "manager");
  const ann = await joinInvited(slug, "ann@x.io");
  const bob = await joinInvited(slug, "bob@x.io");
  const boss = await joinInvited(slug, "boss@x.io");
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
  assert.equal((await join(slug, "bob@x.io", "signin")).result, "wrong");

  const listed = await listInvites(slug);
  assert.deepEqual(listed.map((i) => [i.email, i.role, i.joined]).sort(), [["ann@x.io", "member", true], ["boss@x.io", "manager", true]]);
});

test("the page tells the app who is signed in and their role, and nobody whose invitation was taken back", async () => {
  const slug = await publish(CRM);
  await invite(slug, ["boss@x.io", "ann@x.io"], "manager");
  const boss = await joinInvited(slug, "boss@x.io");
  const ann = await joinInvited(slug, "ann@x.io");
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


