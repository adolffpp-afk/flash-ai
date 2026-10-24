import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createECDH, createHash, randomBytes } from "node:crypto";

register("./support/route-hooks.mjs", import.meta.url);
// Flash's word tables load as Next loads them, so an email in the owner's language can be checked.
register(
  "data:text/javascript," +
    encodeURIComponent(
      'export async function resolve(s, c, next) { const r = await next(s, c); return r.url.endsWith(".json") ? { ...r, importAttributes: { type: "json" } } : r; }',
    ),
);

/*
 * An automation's results where its owner is (automation-alerts.ts): each notice as an alert where
 * they turned alerts on, sent once, never late and never once read in the Bell; and with "Email me
 * each result", each result by email to their own confirmed address, once per run and step, within an
 * account's and Flash's daily share, in their language, safe to show, with a stop link that works
 * signed out and in one click (and a page that changes nothing by being opened). The API keeps the
 * switch and its secret, the Describe helper ticks it when asked, and chat says where results go.
 */
const { claudeStandIn } = await import("./support/claude-stand-in.ts");
const claude = await claudeStandIn();
process.env.DATABASE_URL = ":memory:";
process.env.ANTHROPIC_BASE_URL = claude.url;
process.env.ANTHROPIC_API_KEY = "chat-key-for-tests";
process.env.ANTHROPIC_AUTOMATIONS_API_KEY = "automations-key-for-tests";
process.env.AUTOMATIONS_DEV = "1";
process.env.FLASH_APP_URL = "http://flash.test";
process.env.RESEND_API_KEY = "test-key";
for (const name of ["VERCEL_ENV", "VERCEL", "FLASH_DEMO_EMAILS", "FRED_API_KEY", "AUTOMATION_MAX_PAID", "RESEND_BASE_URL"]) delete process.env[name];
console.warn = () => {};

// Alerts' keys, made the way /admin makes them.
const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const KEYS = { VAPID_PUBLIC_KEY: ecdh.getPublicKey().toString("base64url"), VAPID_PRIVATE_KEY: ecdh.getPrivateKey().toString("base64url"), VAPID_SUBJECT: "mailto:hello@flash-app.dev" };
const setKeys = (on: boolean) => {
  for (const [name, value] of Object.entries(KEYS)) {
    if (on) process.env[name] = value;
    else delete process.env[name];
  }
};
setKeys(true);

// Resend and the push service, stood in for: every call is kept. Anthropic's stand-in is reached as it is.
type Sent = { to: string[]; subject: string; html: string; text: string; headers?: Record<string, string>; key: string | null };
const emails: Sent[] = [];
const pushes: string[] = [];
let resendStatus = 200;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith("https://api.resend.com/")) {
    if (resendStatus !== 200) return new Response("busy", { status: resendStatus });
    const body = JSON.parse(String(init?.body)) as Sent;
    emails.push({ ...body, key: new Headers(init?.headers).get("idempotency-key") });
    return Response.json({ id: `em_${emails.length}` });
  }
  if (url.startsWith("https://fcm.googleapis.com/")) {
    pushes.push(url);
    return new Response(null, { status: 201 });
  }
  return realFetch(input, init);
}) as typeof fetch;

const { one, all, run: sql } = await import("../src/lib/server/db.ts");
const F = await import("./support/automation-fixtures.ts");
const A = await import("../src/lib/automations.ts");
const R = await import("../src/lib/server/automation-runner.ts");
const T = await import("../src/lib/server/automation-tick.ts");
const AL = await import("../src/lib/server/automation-alerts.ts");
const { EMAIL_BUDGET } = await import("../src/lib/server/email.ts");
const { notify, noticeStatement, automationLink } = await import("../src/lib/server/notifications.ts");
const { translatorIn } = await import("../src/lib/server/i18n.ts");
const { formFromDraft } = await import("../src/lib/server/automation-draft.ts");
const { AUTOMATION_LINE, automationReach } = await import("../src/lib/engines/claude.ts");
const E = await import("../src/lib/server/automation-estimate.ts");
const listRoute = await import("../src/app/api/automations/route.ts");
const estimateRoute = await import("../src/app/api/automations/estimate/route.ts");
const oneRoute = await import("../src/app/api/automations/[id]/route.ts");
const receiptRoute = await import("../src/app/api/automations/runs/[runId]/route.ts");
const stopRoute = await import("../src/app/api/stop-email/[token]/route.ts");
type Spec = import("../src/lib/automations.ts").Spec;

after(() => claude.close());
beforeEach(async () => {
  claude.state.replies = [];
  claude.state.count = { tokens: 1200, status: 0 };
  E.forgetCounts();
  emails.length = 0;
  pushes.length = 0;
  resendStatus = 200;
  setKeys(true);
  process.env.RESEND_API_KEY = "test-key";
  // Each test has today's emails to itself.
  await sql("DELETE FROM rate_limits WHERE key LIKE 'email-%'");
});

const BASE = "http://flash.test";
const SECRET = "e".repeat(32);
const NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
function req(path: string, o: { cookie?: string; method?: string; json?: unknown } = {}) {
  const method = o.method ?? (o.json !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = {};
  if (o.cookie) headers.cookie = o.cookie;
  if (method !== "GET") Object.assign(headers, { "content-type": "application/json", origin: BASE });
  return new Request(BASE + path, { method, headers, body: method === "GET" ? undefined : JSON.stringify(o.json ?? {}) });
}
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;

/** Leases a run to this test as a claim would, and runs it here until it ends. */
async function advance(runId: string) {
  await sql(`UPDATE automation_runs SET lease_owner = 'w:' || id, lease_until = ${NOW} + 120000, status = 'running' WHERE id = ?`, [runId]);
  await R.advanceRun(runId, `w:${runId}`, Date.now() + 760_000);
}
/** An automation that emails its results, with its link's secret. */
async function emailing(userId: string, o: { name?: string; spec?: Spec } = {}) {
  const id = await F.automation({ userId, ...o });
  await sql("UPDATE automations SET email_me = 1, email_secret = ? WHERE id = ?", [SECRET, id]);
  return id;
}
/** Alerts turned on in a browser where this account is signed in (its session from F.account). */
async function alertsOn(account: { id: string; cookie: string }) {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const token = account.cookie.split("=")[1];
  const endpoint = `https://fcm.googleapis.com/fcm/send/${account.id}-${randomBytes(4).toString("hex")}`;
  await sql("INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, session_hash, created_at) VALUES (?, ?, ?, ?, ?, 0)", [
    endpoint,
    account.id,
    ua.getPublicKey().toString("base64url"),
    randomBytes(16).toString("base64url"),
    createHash("sha256").update(token).digest("hex"),
  ]);
  return endpoint;
}
/** A result's email waiting to be sent, written as a run's notify step writes it. */
async function queueEmail(userId: string, automationId: string, step: string, text = "Sunny today.") {
  const runId = `run_${step}_${randomBytes(3).toString("hex")}`;
  const notice = { userId, kind: "run_done" as const, phrase: A.NOTICES.ready, blanks: { name: "Morning note", text }, link: automationLink(automationId, runId), ref: `run:${runId}:${step}` };
  const st = AL.emailStatement({ notice, runId, stepId: step, automationId, text });
  await sql(st.sql, st.args as never);
  return `${runId}:${step}`;
}
const stateOf = async (id: string) => (await one<{ state: string; blanks: string }>("SELECT state, blanks FROM automation_emails WHERE id = ?", [id]))!;
// In the order they were added (a late one's time is moved back).
const pushedOf = async (userId: string) => (await all<{ pushed: number }>("SELECT pushed FROM notifications WHERE user_id = ? ORDER BY rowid", [userId])).map((r) => Number(r.pushed));

test("an alert says what the notice says: the automation's name, the result's first line, and a tap opens the run", async () => {
  const t = await translatorIn("en");
  const ready = AL.noticeAlert({ phrase: A.NOTICES.ready, blanks: JSON.stringify({ name: "Morning note", text: "**Sunny** today.\nMore below." }), link: automationLink("a1", "r1") }, t);
  assert.equal(ready.title, "Morning note");
  assert.match(ready.body, /^Sunny today\./);
  assert.equal(ready.url, "/?automations=a1&run=r1");
  assert.equal(ready.tag, "flash-run-r1", "the run's later alerts replace it");
  const paused = AL.noticeAlert({ phrase: A.NOTICES.paused, blanks: JSON.stringify({ name: "Morning note" }), link: automationLink("a1") }, t);
  assert.equal(paused.body, t(A.NOTICES.paused, { name: "Morning note" }), "a notice that isn't a result says its own line");
  assert.equal(paused.tag, "flash-automation-a1");
});

test("a notice waits to be an alert only for an owner who turned alerts on; each goes once, never once read, never late", async () => {
  const on = await F.account("al-on", 10);
  const off = await F.account("al-off", 10);
  const endpoint = await alertsOn(on);
  await notify({ userId: on.id, kind: "paused", phrase: A.NOTICES.paused, blanks: { name: "One" }, link: automationLink("x1") });
  await notify({ userId: off.id, kind: "paused", phrase: A.NOTICES.paused, blanks: { name: "Two" }, link: automationLink("x2") });
  assert.deepEqual(await pushedOf(on.id), [0], "waits for its alert");
  assert.deepEqual(await pushedOf(off.id), [1], "nothing to wait for");

  // Three servers at once (a run's end and two ticks) send it once.
  const reports = await Promise.all([AL.deliverAlerts(), AL.deliverAlerts(), AL.deliverAlerts(on.id)]);
  assert.deepEqual(pushes, [endpoint]);
  assert.equal(reports.reduce((n, r) => n + r.alerts, 0), 1);
  assert.deepEqual(await pushedOf(on.id), [1]);

  // Read in the Bell before it went: not sent.
  await notify({ userId: on.id, kind: "paused", phrase: A.NOTICES.paused, blanks: { name: "Read" }, link: automationLink("x3") });
  await sql("UPDATE notifications SET read_at = 1 WHERE user_id = ? AND pushed = 0", [on.id]);
  await AL.deliverAlerts();
  assert.equal(pushes.length, 1);

  // An hour late: kept in the Bell only.
  await notify({ userId: on.id, kind: "paused", phrase: A.NOTICES.paused, blanks: { name: "Late" }, link: automationLink("x4") });
  await sql(`UPDATE notifications SET created_at = ${NOW} - ? WHERE user_id = ? AND pushed = 0`, [AL.ALERT_LATE_MS + 1000, on.id]);
  await AL.deliverAlerts();
  assert.equal(pushes.length, 1);
  assert.deepEqual(await pushedOf(on.id), [1, 1, 2]);

  // Without alerts' keys on this server, nothing waits for them.
  setKeys(false);
  await notify({ userId: on.id, kind: "paused", phrase: A.NOTICES.paused, blanks: { name: "No keys" }, link: automationLink("x5") });
  await AL.deliverAlerts();
  assert.equal(pushes.length, 1);
  assert.deepEqual(await pushedOf(on.id), [1, 1, 2, 1]);
});

test("the tick sends an alert or an email a run's own worker didn't, and only after a moment", async () => {
  const u = await F.account("al-tick", 10);
  await alertsOn(u);
  const aid = await emailing(u.id);
  const st = noticeStatement({ userId: u.id, kind: "paused", phrase: A.NOTICES.paused, blanks: { name: "Morning note" }, link: automationLink(aid) });
  await sql(st.sql, st.args);
  const id = await queueEmail(u.id, aid, "n1");
  const due = async () => (await Promise.all(AL.ALERT_DUE_CHECKS.map((q) => one(q)))).filter(Boolean).length;
  assert.equal(await due(), 0, "a worker sends what it just wrote");
  await sql(`UPDATE notifications SET created_at = ${NOW} - 31000 WHERE user_id = ?`, [u.id]);
  await sql(`UPDATE automation_emails SET created_at = ${NOW} - 31000 WHERE id = ?`, [id]);
  assert.equal(await due(), 2);
  await sql("INSERT INTO settings (key, value) VALUES ('auto:daily', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [new Date().toISOString().slice(0, 10)]);
  const report = await T.runTick("tk", { dispatch: async () => {} });
  assert.equal(report.alerts, 1);
  assert.equal(report.emails, 1);
  assert.equal(pushes.length, 1);
  assert.equal(emails.length, 1);
  assert.equal(await due(), 0);
});

test("a run of an automation that emails its results: one email to its owner, safe to show, with its stop link, sent once", async () => {
  const u = await F.account("mail1", 100);
  const aid = await emailing(u.id);
  const rid = await F.runRow({ automationId: aid, userId: u.id });
  claude.state.replies.push({ text: 'Rain **later**. <img src=x onerror="alert(1)"> See [the map](https://example.com/a?b=1&c=2) or javascript:alert(2)' });
  await advance(rid);
  assert.equal((await one<{ status: string }>("SELECT status FROM automation_runs WHERE id = ?", [rid]))!.status, "done");
  assert.equal(emails.length, 1, "sent as the run ended");
  const [e] = emails;
  const token = AL.stopEmailToken(aid, SECRET);
  assert.deepEqual(e.to, ["mail1@example.com"]);
  assert.equal(e.subject, "Morning note: your latest result");
  assert.equal(e.key, `automation-email-${rid}:n1`, "the email provider sends it once, however often it's asked");
  assert.deepEqual(e.headers, { "List-Unsubscribe": `<${BASE}/api/stop-email/${token}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  // Its HTML shows the answer's words, never its markup.
  assert.ok(!e.html.includes("<img"), "the answer's HTML is shown as text");
  assert.ok(e.html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
  assert.match(e.html, /<(strong|b)>later<\/(strong|b)>/);
  assert.ok(e.html.includes('href="https://example.com/a?b=1&amp;c=2"'), "a web link stays a link");
  assert.ok(!/href="javascript:/i.test(e.html), "nothing else becomes one");
  assert.ok(e.html.includes(AL.EMAIL_WORDS.ai.slice(0, 40)), "it says AI wrote it");
  assert.ok(e.html.includes(`href="${BASE}/stop-email/${token}"`), "its stop link opens the page, which asks first");
  assert.ok(e.html.includes(`${BASE}/?automations=${aid}&amp;run=${rid}&amp;as=${u.id}`), "its button opens the run, as its owner");
  assert.ok(e.text.includes(`${BASE}/?automations=${aid}&run=${rid}&as=${u.id}`));
  assert.ok(e.text.includes(`${BASE}/stop-email/${token}`));
  // Kept as sent, without its result.
  const row = await stateOf(`${rid}:n1`);
  assert.deepEqual([row.state, row.blanks], ["sent", "{}"]);
  // Asked again (the tick, another run's end): nothing more.
  await AL.deliverAlerts();
  await AL.deliverAlerts(u.id);
  assert.equal(emails.length, 1);
  // Its receipt says it was emailed.
  const r = await receiptRoute.GET(req(`/api/automations/runs/${rid}`, { cookie: u.cookie }), ctx({ runId: rid }));
  assert.equal(((await r.json()) as { run: { emailText: string } }).run.emailText, "Emailed to you");
});

test("an automation that doesn't email its results queues no email", async () => {
  const u = await F.account("mail0", 100);
  const aid = await F.automation({ userId: u.id });
  const rid = await F.runRow({ automationId: aid, userId: u.id });
  claude.state.replies.push({ text: "Sunny." });
  await advance(rid);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM automation_emails WHERE automation_id = ?", [aid]))!.n), 0);
  assert.equal(emails.length, 0);
  const r = await receiptRoute.GET(req(`/api/automations/runs/${rid}`, { cookie: u.cookie }), ctx({ runId: rid }));
  assert.equal(((await r.json()) as { run: { emailText: string } }).run.emailText, "");
});

test("the email is in its owner's language, and right to left for Arabic", async () => {
  const u = await F.account("mail-fr", 10);
  await sql("UPDATE users SET language = 'fr' WHERE id = ?", [u.id]);
  const aid = await emailing(u.id);
  await queueEmail(u.id, aid, "n1");
  await AL.deliverAlerts(u.id);
  const fr = await translatorIn("fr");
  assert.equal(emails[0].subject, fr(AL.EMAIL_WORDS.subject, { name: "Morning note" }));
  assert.notEqual(emails[0].subject, "Morning note: your latest result", "translated");
  assert.match(emails[0].html, /<html lang="fr" dir="ltr">/);
  const ar = await F.account("mail-ar", 10);
  await sql("UPDATE users SET language = 'ar' WHERE id = ?", [ar.id]);
  await queueEmail(ar.id, await emailing(ar.id), "n1");
  await AL.deliverAlerts(ar.id);
  assert.match(emails[1].html, /<html lang="ar" dir="rtl">/);
});

test("emails are shared out: 3 a day for an account and Flash's share for everyone, and one refused takes nothing from its account", async () => {
  const many = await F.account("cap1", 10);
  const aid = await emailing(many.id);
  const ids = [];
  for (const step of ["s1", "s2", "s3", "s4"]) ids.push(await queueEmail(many.id, aid, step));
  await AL.deliverAlerts();
  assert.equal(emails.length, AL.EMAILS_PER_ACCOUNT);
  assert.deepEqual((await Promise.all(ids.map(stateOf))).map((r) => r.state).sort(), ["limit", "sent", "sent", "sent"]);

  // Flash's own share used up: refused, and its account's place given back.
  const other = await F.account("cap2", 10);
  const bid = await emailing(other.id);
  const kept = EMAIL_BUDGET.automations;
  EMAIL_BUDGET.automations = 0;
  try {
    const refused = await queueEmail(other.id, bid, "f1");
    await AL.deliverAlerts();
    assert.equal((await stateOf(refused)).state, "limit");
  } finally {
    EMAIL_BUDGET.automations = kept;
  }
  for (const step of ["g1", "g2", "g3"]) await queueEmail(other.id, bid, step);
  await AL.deliverAlerts();
  assert.equal(emails.filter((e) => e.to[0] === "cap2@example.com").length, 3, "the refused one didn't count for its account");

  // And Flash's share stops everyone's at EMAIL_BUDGET.automations a day.
  for (let i = 0; i < 4; i++) {
    const a = await F.account(`cap-many${i}`, 10);
    const id = await emailing(a.id);
    for (const step of ["h1", "h2", "h3"]) await queueEmail(a.id, id, step);
  }
  await AL.deliverAlerts();
  assert.equal(emails.length, EMAIL_BUDGET.automations, "no more than Flash's share in a day");
});

test("an email isn't sent once emails stop, to an address not confirmed, after waiting too long, or twice after a server stopped mid-send", async () => {
  const u = await F.account("no1", 10);
  const aid = await emailing(u.id);
  const stopped = await queueEmail(u.id, aid, "a");
  await sql("UPDATE automations SET email_me = 0 WHERE id = ?", [aid]);
  await AL.deliverAlerts();
  assert.equal((await stateOf(stopped)).state, "off");

  const unconfirmed = await F.account("no2", 10, { verified: false });
  const waiting = await queueEmail(unconfirmed.id, await emailing(unconfirmed.id), "a");
  await AL.deliverAlerts();
  assert.equal((await stateOf(waiting)).state, "off");

  const late = await F.account("no3", 10);
  const lid = await emailing(late.id);
  const old = await queueEmail(late.id, lid, "a");
  await sql(`UPDATE automation_emails SET created_at = ${NOW} - ? WHERE id = ?`, [AL.EMAIL_LATE_MS + 1000, old]);
  const halfSent = await queueEmail(late.id, lid, "b");
  await sql(`UPDATE automation_emails SET state = 'sending', sent_at = ${NOW} - ? WHERE id = ?`, [AL.SENDING_MS + 1000, halfSent]);
  await AL.deliverAlerts();
  assert.deepEqual([(await stateOf(old)).state, (await stateOf(halfSent)).state], ["expired", "failed"]);
  assert.equal((await stateOf(old)).blanks, "{}", "its result isn't kept");

  // Turned off on this server: none goes.
  delete process.env.RESEND_API_KEY;
  const off = await F.account("no4", 10);
  const noServer = await queueEmail(off.id, await emailing(off.id), "a");
  await AL.deliverAlerts();
  assert.equal((await stateOf(noServer)).state, "off");
  assert.equal(emails.length, 0);
});

test("an email the provider refuses says so, and gives its account's place back", async () => {
  const u = await F.account("fail1", 10);
  const aid = await emailing(u.id);
  resendStatus = 500;
  const failed = await queueEmail(u.id, aid, "a");
  await AL.deliverAlerts();
  assert.equal((await stateOf(failed)).state, "failed");
  resendStatus = 200;
  for (const step of ["b", "c", "d"]) await queueEmail(u.id, aid, step);
  await AL.deliverAlerts();
  assert.equal(emails.length, 3);
});

test("the stop link: only its own automation's, a POST stops them (one click too), opening the page changes nothing", async () => {
  const u = await F.account("stop1", 10);
  const aid = await emailing(u.id, { name: "Daily prices" });
  const other = await emailing(u.id);
  const token = AL.stopEmailToken(aid, SECRET);
  const signature = token.split(".")[1];
  assert.deepEqual(await AL.tokenAutomation(token), { id: aid, name: "Daily prices", emailing: true });
  assert.equal(await AL.tokenAutomation(`${other}.${signature}`), null, "another automation's id with this one's signature");
  assert.equal(await AL.tokenAutomation(`${aid}.${"A".repeat(22)}`), null);
  assert.equal(await AL.tokenAutomation(token.slice(0, -1)), null);
  assert.equal(await AL.tokenAutomation(`${aid}.${AL.stopEmailToken(aid, "f".repeat(32)).split(".")[1]}`), null, "signed with another secret");
  assert.equal(Number((await one<{ e: number }>("SELECT email_me AS e FROM automations WHERE id = ?", [aid]))!.e), 1, "reading a link changes nothing");
  assert.equal((stopRoute as Record<string, unknown>).GET, undefined, "only a POST stops them");

  // The page's button: back to the page, which says they're off.
  const waiting = await queueEmail(u.id, aid, "q");
  const form = await stopRoute.POST(new Request(`${BASE}/api/stop-email/${token}`, { method: "POST" }), ctx({ token }));
  assert.equal(form.status, 303);
  assert.equal(form.headers.get("location"), `${BASE}/stop-email/${encodeURIComponent(token)}`);
  assert.deepEqual(await AL.tokenAutomation(token), { id: aid, name: "Daily prices", emailing: false });
  assert.equal((await stateOf(waiting)).state, "off", "one still waiting doesn't go");
  assert.equal(Number((await one<{ e: number }>("SELECT email_me AS e FROM automations WHERE id = ?", [other]))!.e), 1, "its other automations keep theirs");

  // A mail app's one-click unsubscribe, again: nothing more changes.
  const oneClick = (t: string, ip = "10.9.0.1") =>
    stopRoute.POST(
      new Request(`${BASE}/api/stop-email/${t}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip }, body: "List-Unsubscribe=One-Click" }),
      ctx({ token: t }),
    );
  const again = await oneClick(token);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { ok: true });

  // Links that don't work: 404, then 429 for an address that keeps trying.
  const bad = `${aid}.${"B".repeat(22)}`;
  assert.equal((await oneClick(bad, "10.9.0.2")).status, 404);
  for (let i = 0; i < 30; i++) await oneClick(bad, "10.9.0.2");
  assert.equal((await oneClick(bad, "10.9.0.2")).status, 429);
  assert.equal((await oneClick(AL.stopEmailToken(other, SECRET), "10.9.0.2")).status, 200, "a link that works always works");
});

test("the API keeps the switch: on when asked, kept on a rename, its secret kept when turned off and on, refused while Flash can't email", async () => {
  const u = await F.account("api1", 500);
  const spec: Spec = { ...F.WRITE_SPEC, trigger: { type: "schedule", when: { kind: "daily", at: "08:00" } } };
  const priced = await estimateRoute.POST(req("/api/automations/estimate", { cookie: u.cookie, json: { spec, timeZone: "UTC" } }));
  const worst = ((await priced.json()) as { estimate: { worst: number } }).estimate.worst;
  const made = await listRoute.POST(req("/api/automations", { cookie: u.cookie, json: { spec, name: "Morning note", timeZone: "UTC", seenMax: worst, status: "on", emailMe: true } }));
  assert.equal(made.status, 201);
  const view = ((await made.json()) as { automation: { id: string; emailMe: boolean } }).automation;
  assert.equal(view.emailMe, true);
  const secretOf = async () => (await one<{ s: string; e: number }>("SELECT email_secret AS s, email_me AS e FROM automations WHERE id = ?", [view.id]))!;
  const first = await secretOf();
  assert.ok(first.s.length >= 32);

  const listed = (await (await listRoute.GET(req("/api/automations", { cookie: u.cookie }))).json()) as { email: { to: string; perDay: number } | null };
  assert.deepEqual(listed.email, { to: "api1@example.com", perDay: AL.EMAILS_PER_ACCOUNT });

  const patch = (json: Record<string, unknown>) => oneRoute.PATCH(req(`/api/automations/${view.id}`, { cookie: u.cookie, method: "PATCH", json: { spec, name: "Morning note", timeZone: "UTC", seenMax: worst, ...json } }), ctx({ id: view.id }));
  assert.equal((await patch({ name: "Renamed" })).status, 200);
  assert.deepEqual(await secretOf(), first, "a rename keeps it");
  assert.equal((await patch({ emailMe: false })).status, 200);
  assert.deepEqual(await secretOf(), { ...first, e: 0 });
  assert.equal((await patch({ emailMe: true })).status, 200);
  assert.deepEqual(await secretOf(), first, "on again: the same secret, so its old links still work");
  assert.equal((await patch({ emailMe: "yes" })).status, 400);

  // A new automation without it: no secret until it's turned on.
  const plain = await listRoute.POST(req("/api/automations", { cookie: u.cookie, json: { spec, name: "Plain", timeZone: "UTC", seenMax: worst, status: "draft" } }));
  const pid = ((await plain.json()) as { automation: { id: string; emailMe: boolean } }).automation;
  assert.equal(pid.emailMe, false);
  assert.equal((await one<{ s: string }>("SELECT email_secret AS s FROM automations WHERE id = ?", [pid.id]))!.s, "");

  delete process.env.RESEND_API_KEY;
  const refused = await patch({ emailMe: true });
  assert.equal(refused.status, 400);
  assert.equal(((await refused.json()) as { error: string }).error, "Flash can't send emails right now.");
  assert.equal((await patch({ emailMe: false })).status, 200, "it can always be turned off");
  const none = (await (await listRoute.GET(req("/api/automations", { cookie: u.cookie }))).json()) as { email: unknown };
  assert.equal(none.email, null);
});

test("deleting an automation deletes its emails", async () => {
  const u = await F.account("del1", 10);
  const aid = await emailing(u.id);
  await queueEmail(u.id, aid, "a");
  await sql("UPDATE automations SET status = 'deleting' WHERE id = ?", [aid]);
  assert.equal(await T.deleteAutomationNow({ id: aid, user_id: u.id }), true);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM automation_emails WHERE automation_id = ?", [aid]))!.n), 0);
});

test("Describe ticks the switch when they ask for each result by email, and chat says where results can go on this server", () => {
  assert.equal(formFromDraft({ name: "News", instruction: "Today's AI news", repeat: "daily", mode: "research", email_me: true }, "email me the news daily", "UTC").emailMe, true);
  assert.equal(formFromDraft({ name: "News", instruction: "Today's AI news", repeat: "daily", mode: "research" }, "news daily", "UTC").emailMe, undefined);
  assert.equal(formFromDraft({ name: "News", instruction: "Today's AI news", repeat: "daily", mode: "research", email_me: "yes" }, "news daily", "UTC").emailMe, undefined);
  assert.doesNotMatch(AUTOMATION_LINE, /doesn't send emails/);
  assert.match(automationReach({ email: true, alerts: true }), /Email me each result/);
  assert.match(automationReach({ email: true, alerts: true }), /alert their phone or computer/);
  assert.match(automationReach({ email: true, alerts: false }), /can't send phone alerts yet/);
  assert.match(automationReach({ email: false, alerts: true }), /can't email results yet/);
  assert.match(automationReach(), /can't email results or send phone alerts yet/);
});
