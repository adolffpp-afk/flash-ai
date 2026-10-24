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
 * each result", a run's result by email to their own confirmed address, one email a run, within an
 * account's and Flash's daily share, in their language, in plain text (its links written out), with a
 * stop link that works signed out and in one click (and a page that changes nothing by being opened).
 * The API keeps the switch and its secret, the Describe helper ticks it when asked, and chat says where
 * results go.
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
for (const name of ["VERCEL_ENV", "VERCEL", "FLASH_DEMO_EMAILS", "FRED_API_KEY", "AUTOMATION_MAX_PAID", "RESEND_BASE_URL", "FLASH_CONTACT_EMAIL"]) delete process.env[name];
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
// 200 sends; another status is the provider's answer; 0 is no answer at all (a time-out).
let resendStatus = 200;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith("https://api.resend.com/")) {
    if (resendStatus === 0) throw new TypeError("fetch failed");
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
const { EMAIL_BUDGET, answerText } = await import("../src/lib/server/email.ts");
const { SUPPORT_EMAIL } = await import("../src/lib/product.ts");
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
/** A run's email waiting to be sent, written as its notify step writes it; its id is its run's. */
async function queueEmail(userId: string, automationId: string, step: string, text = "Sunny today.", o: { runId?: string; sources?: { title?: unknown; url?: unknown }[] } = {}) {
  const runId = o.runId ?? `run_${step}_${randomBytes(3).toString("hex")}`;
  const notice = { userId, kind: "run_done" as const, phrase: A.NOTICES.ready, blanks: { name: "Morning note", text }, link: automationLink(automationId, runId), ref: `run:${runId}:${step}` };
  const st = AL.emailStatement({ notice, runId, automationId, text, sources: o.sources });
  await sql(st.sql, st.args);
  return runId;
}
/** The day in a subject, as its reader writes it. */
const dayOf = (at: number, locale = "en", timeZone = "UTC") => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(at);
const createdOf = async (id: string) => Number((await one<{ c: number }>("SELECT created_at AS c FROM automation_emails WHERE id = ?", [id]))!.c);
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

test("a run of an automation that emails its results: one email to its owner, in plain text, with its stop link, sent once", async () => {
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
  assert.equal(e.subject, `\u2068Morning note\u2069: your result for ${dayOf(Date.now())}`, "its day, so a mail app doesn't stack each day's under the first");
  assert.equal(e.key, `automation-email-${rid}`, "the email provider sends it once, however often it's asked");
  assert.deepEqual(e.headers, { "List-Unsubscribe": `<${BASE}/api/stop-email/${token}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click", "X-Entity-Ref-ID": `flash-result-${rid}` });
  // Its HTML shows the answer's words, never its markup, and none of it is a link.
  assert.ok(!e.html.includes("<img"), "the answer's HTML is shown as text");
  assert.ok(e.html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
  assert.ok(e.html.includes("Rain later."), "no bold");
  assert.ok(e.html.includes("See the map (https://example.com/a?b=1&amp;c=2) or javascript:alert(2)"), "a link is written out, its address in full");
  const links = [...e.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(links, [`${BASE}/?automations=${aid}&amp;run=${rid}&amp;as=${u.id}`, `${BASE}/stop-email/${token}`, `mailto:${SUPPORT_EMAIL}`].sort(), "its only links are Flash's own: its button, its stop link and help");
  assert.ok(e.html.includes(AL.EMAIL_WORDS.ai.slice(0, 40)), "it says AI wrote it");
  assert.ok(e.text.includes("See the map (https://example.com/a?b=1&c=2) or javascript:alert(2)"));
  assert.ok(e.text.includes(`${BASE}/?automations=${aid}&run=${rid}&as=${u.id}`));
  assert.ok(e.text.includes(`${BASE}/stop-email/${token}`));
  // Kept as sent, without its result.
  const row = await stateOf(rid);
  assert.deepEqual([row.state, row.blanks], ["sent", "{}"]);
  // Asked again (the tick, another run's end): nothing more.
  await AL.deliverAlerts();
  await AL.deliverAlerts(u.id);
  assert.equal(emails.length, 1);
  // Its receipt says it was emailed, and stops asking.
  const r = await receiptRoute.GET(req(`/api/automations/runs/${rid}`, { cookie: u.cookie }), ctx({ runId: rid }));
  const shown = ((await r.json()) as { run: { emailText: string; emailing: boolean } }).run;
  assert.deepEqual([shown.emailText, shown.emailing], ["Emailed to you", false]);
});

test("a run sends one email: a later result takes the place of one still waiting, and none goes after one went", async () => {
  const u = await F.account("once1", 10);
  const aid = await emailing(u.id);
  const rid = await F.runRow({ automationId: aid, userId: u.id, status: "done" });
  await sql("UPDATE automation_runs SET finished_at = ? WHERE id = ?", [Date.now(), rid]);
  await queueEmail(u.id, aid, "n1", "First result.", { runId: rid });
  const receipt = async () => ((await (await receiptRoute.GET(req(`/api/automations/runs/${rid}`, { cookie: u.cookie }), ctx({ runId: rid }))).json()) as { run: { emailText: string; emailing: boolean } }).run;
  const waiting = await receipt();
  assert.deepEqual([waiting.emailText, waiting.emailing], ["Emailing you the result…", true], "its receipt keeps asking while it waits");
  await queueEmail(u.id, aid, "n2", "Second result.", { runId: rid });
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM automation_emails WHERE run_id = ?", [rid]))!.n), 1);
  await AL.deliverAlerts(u.id);
  assert.equal(emails.length, 1);
  assert.ok(emails[0].text.includes("Second result.") && !emails[0].text.includes("First result."), "the later result");
  // Its spending limit's notice after the email went (the cap path): nothing more.
  await queueEmail(u.id, aid, "cap", "Third result.", { runId: rid });
  await AL.deliverAlerts(u.id);
  assert.equal(emails.length, 1);
  assert.deepEqual(Object.values(await stateOf(rid)), ["sent", "{}"]);
});

test("a long run's email waits for the run to end, so the tick sends its last result, late counting from that end", async () => {
  const u = await F.account("once-long", 10);
  const aid = await emailing(u.id);
  const rid = await F.runRow({ automationId: aid, userId: u.id, status: "running" });
  await queueEmail(u.id, aid, "n1", "First result.", { runId: rid });
  // Its first Notify step was long ago (a slow step after it): the tick leaves it while the run goes on.
  await sql(`UPDATE automation_emails SET created_at = ${NOW} - ? WHERE id = ?`, [AL.EMAIL_LATE_MS + 60_000, rid]);
  const due = async () => Boolean(await one(AL.ALERT_DUE_CHECKS[1]));
  assert.equal(await due(), false);
  await AL.deliverAlerts();
  await AL.deliverAlerts(u.id);
  assert.equal(emails.length, 0);
  assert.equal((await stateOf(rid)).state, "queued", "not late while its run goes on");
  // Its last Notify step's result takes its place; the run ends and its worker died before sending it.
  await queueEmail(u.id, aid, "n2", "Last result.", { runId: rid });
  await sql(`UPDATE automation_runs SET status = 'done', finished_at = ${NOW} - 31000 WHERE id = ?`, [rid]);
  assert.equal(await due(), true);
  await AL.deliverAlerts();
  assert.equal(emails.length, 1);
  assert.ok(emails[0].text.includes("Last result.") && !emails[0].text.includes("First result."));

  // A run that ended more than EMAIL_LATE_MS ago doesn't send it.
  const late = await F.runRow({ automationId: aid, userId: u.id, status: "done" });
  await queueEmail(u.id, aid, "n1", "Old result.", { runId: late });
  await sql(`UPDATE automation_runs SET finished_at = ${NOW} - ? WHERE id = ?`, [AL.EMAIL_LATE_MS + 1000, late]);
  await sql(`UPDATE automation_emails SET created_at = ${NOW} - ? WHERE id = ?`, [AL.EMAIL_LATE_MS + 2000, late]);
  await AL.deliverAlerts();
  assert.equal(emails.length, 1);
  assert.equal((await stateOf(late)).state, "expired");
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
  const id = await queueEmail(u.id, aid, "n1");
  await AL.deliverAlerts(u.id);
  const fr = await translatorIn("fr");
  assert.equal(emails[0].subject, fr(AL.EMAIL_WORDS.subject, { name: "\u2068Morning note\u2069", date: dayOf(await createdOf(id), fr.locale) }));
  assert.doesNotMatch(emails[0].subject, /your result for/, "translated");
  assert.ok(emails[0].subject.includes(dayOf(await createdOf(id), fr.locale)), "its day as they write it");
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
    assert.equal((await stateOf(refused)).state, "busy", "Flash's share, not theirs");
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
  assert.deepEqual([(await stateOf(old)).state, (await stateOf(halfSent)).state], ["expired", "unknown"], "one that may have gone isn't sent again, and says it may not have");
  assert.equal((await stateOf(old)).blanks, "{}", "its result isn't kept");

  // Turned off on this server: none goes.
  delete process.env.RESEND_API_KEY;
  const off = await F.account("no4", 10);
  const noServer = await queueEmail(off.id, await emailing(off.id), "a");
  await AL.deliverAlerts();
  assert.equal((await stateOf(noServer)).state, "off");
  assert.equal(emails.length, 0);
});

test("an email the provider refuses says so and gives its account's place back; one with no answer may have gone, so it keeps it", async () => {
  const u = await F.account("fail1", 10);
  const aid = await emailing(u.id);
  resendStatus = 500;
  const failed = await queueEmail(u.id, aid, "a");
  await AL.deliverAlerts();
  resendStatus = 429;
  const busy = await queueEmail(u.id, aid, "b");
  await AL.deliverAlerts();
  resendStatus = 0;
  const unknown = await queueEmail(u.id, aid, "c");
  await AL.deliverAlerts();
  assert.deepEqual([(await stateOf(failed)).state, (await stateOf(busy)).state, (await stateOf(unknown)).state], ["failed", "busy", "unknown"]);
  resendStatus = 200;
  const rest = [];
  for (const step of ["d", "e", "f"]) rest.push(await queueEmail(u.id, aid, step));
  await AL.deliverAlerts();
  assert.equal(emails.length, 2, "the one with no answer kept its place");
  assert.deepEqual((await Promise.all(rest.map(stateOf))).map((r) => r.state).sort(), ["limit", "sent", "sent"]);
  // What each says on its run, in the reader's words.
  const t = await translatorIn("en");
  const line = async (id: string) => (await AL.runEmailLine(id, aid, t)).text;
  assert.equal(await line(busy), "Not emailed: Flash has sent all the emails it can today. The result is here.");
  assert.equal(await line(unknown), "Flash may not have emailed this result. It's here.");
  const limited = (await Promise.all(rest.map(async (id) => [id, (await stateOf(id)).state] as const))).find(([, st]) => st === "limit")![0];
  assert.equal(await line(limited), `Not emailed: you've had today's ${AL.EMAILS_PER_ACCOUNT} emails. The result is here.`);
});

test("the stop link: only its own automation's, a POST stops them (one click too), opening the page changes nothing", async () => {
  const u = await F.account("stop1", 10);
  await sql("UPDATE users SET language = 'de' WHERE id = ?", [u.id]);
  const aid = await emailing(u.id, { name: "Daily prices" });
  const other = await emailing(u.id);
  const token = AL.stopEmailToken(aid, SECRET);
  const signature = token.split(".")[1];
  assert.deepEqual(await AL.tokenAutomation(token), { id: aid, name: "Daily prices", emailing: true, language: "de" }, "its page is in its emails' language");
  assert.equal(await AL.tokenAutomation(`${other}.${signature}`), null, "another automation's id with this one's signature");
  assert.equal(await AL.tokenAutomation(`${aid}.${"A".repeat(22)}`), null);
  assert.equal(await AL.tokenAutomation(token.slice(0, -1)), null);
  assert.equal(await AL.tokenAutomation(`${aid}.${AL.stopEmailToken(aid, "f".repeat(32)).split(".")[1]}`), null, "signed with another secret");
  assert.equal(Number((await one<{ e: number }>("SELECT email_me AS e FROM automations WHERE id = ?", [aid]))!.e), 1, "reading a link changes nothing");
  // A mail app that opens the List-Unsubscribe address: the page, which asks first.
  const opened = await stopRoute.GET(new Request(`${BASE}/api/stop-email/${token}`), ctx({ token }));
  assert.deepEqual([opened.status, opened.headers.get("location")], [303, `${BASE}/stop-email/${encodeURIComponent(token)}`]);
  assert.equal(Number((await one<{ e: number }>("SELECT email_me AS e FROM automations WHERE id = ?", [aid]))!.e), 1, "only a POST stops them");

  // The page's button: back to the page, which says they're off.
  const waiting = await queueEmail(u.id, aid, "q");
  const form = await stopRoute.POST(new Request(`${BASE}/api/stop-email/${token}`, { method: "POST" }), ctx({ token }));
  assert.equal(form.status, 303);
  assert.equal(form.headers.get("location"), `${BASE}/stop-email/${encodeURIComponent(token)}`);
  assert.deepEqual(await AL.tokenAutomation(token), { id: aid, name: "Daily prices", emailing: false, language: "de" });
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
  assert.match(automationReach({ email: 3, alerts: true }), /Email me each result/);
  assert.match(automationReach({ email: 3, alerts: true }), /one email per run and up to 3 a day/, "what it can promise");
  assert.match(automationReach({ email: 3, alerts: true }), /alert their phone or computer/);
  assert.match(automationReach({ email: 3, alerts: false }), /can't send phone alerts yet/);
  assert.match(automationReach({ email: 0, alerts: true }), /can't email results yet/);
  assert.match(automationReach(), /can't email results or send phone alerts yet/);
});

test("an answer as plain text: its links written out in full, Markdown's marks out, its lists, tables and code kept, nothing turned around", () => {
  const md = [
    "# Today's prices",
    "",
    "1. **Gold** up 2%",
    "2. _Silver_ down",
    "- one",
    "* two",
    "",
    "> quoted [here](https://a.example/x)",
    "",
    "| Name | Price |",
    "|---|---:|",
    "| AAPL | $1 |",
    "",
    "```js",
    "const a = **b**;",
    "```",
  ].join("\n");
  assert.equal(answerText(md), "Today's prices\n\n1. Gold up 2%\n2. Silver down\n• one\n• two\n\nquoted here (https://a.example/x)\n\nName | Price\nAAPL | $1\n\nconst a = **b**;");
  // A link's words can't pass for another address: words that look like one show the real one alone.
  assert.equal(answerText("[https://bank.example](https://evil.example/login) and [bank.com](https://evil.example)"), "https://evil.example/login and https://evil.example");
  assert.equal(answerText("Version [v2.0](https://rel.example/2)"), "Version v2.0 (https://rel.example/2)", "a version number isn't an address");
  assert.equal(answerText("[Foo (bar)](https://en.wikipedia.org/wiki/Foo_(bar)) and <https://c.example/y>."), "Foo (bar) (https://en.wikipedia.org/wiki/Foo_(bar)) and https://c.example/y.");
  assert.equal(answerText("Ends at https://d.example/p_q. Then https://e.example/a_(b)"), "Ends at https://d.example/p_q. Then https://e.example/a_(b)", "an address keeps its underscores and ends before its stop");
  assert.equal(answerText("[click](javascript:alert(1)) and [mail](mailto:a@b.c?subject=x) and [p](/page)"), "click and mail (a@b.c) and p", "only web and email addresses are written out");
  assert.equal(answerText("abc‮gnp.exe ⁦x⁩ \u0007bell \\*kept\\* 2*3*4 snake_case_name ~~gone~~"), "abcgnp.exe x bell *kept* 2*3*4 snake_case_name gone");
  assert.equal(answerText("a\r\n\r\n\r\n\r\nb\n---\nc"), "a\n\nb\n\nc");
});

test("a long result: the email has its start, cut where a paragraph ends, says the rest is in Flash, and lists its sources", async () => {
  const para = "Word ".repeat(200).trim();
  const long = Array.from({ length: 30 }, () => para).join("\n\n");
  const cut = AL.emailCut(long);
  assert.equal(cut.cut, true);
  assert.ok(cut.text.length <= AL.EMAIL_TEXT_CHARS && cut.text.endsWith("Word") && long.startsWith(cut.text) && long.slice(cut.text.length).startsWith("\n\n"), "a whole paragraph");
  assert.deepEqual(AL.emailCut("short"), { text: "short", cut: false });
  assert.equal(AL.emailCut(`${"a".repeat(9)}😀b`, 10).text, "a".repeat(9), "never half of an emoji");
  // Its sources: web pages only, each once, their titles on one line, EMAIL_SOURCES at most.
  const many = Array.from({ length: 12 }, (_, i) => ({ title: `Page ${i}`, url: `https://news.example/${i}` }));
  const sources = AL.emailSources([
    { title: "Bank\nnews ‮update", url: "https://bank.example/a" },
    { title: "Again", url: "https://bank.example/a" },
    { title: "Script", url: "javascript:alert(1)" },
    { title: "Spaced", url: "https://x.example/a b" },
    { title: "Turned", url: "https://x.example/‮exe" },
    { url: "http://plain.example" },
    ...many,
  ]);
  assert.equal(sources.length, AL.EMAIL_SOURCES);
  assert.deepEqual(sources.slice(0, 2), [
    { title: "Bank news update", url: "https://bank.example/a" },
    { title: "", url: "http://plain.example" },
  ]);
  const u = await F.account("long1", 10);
  const aid = await emailing(u.id);
  await queueEmail(u.id, aid, "n1", long, { sources: [{ title: "Bank news", url: "https://bank.example/a" }] });
  await AL.deliverAlerts(u.id);
  const [e] = emails;
  assert.ok(e.text.includes(AL.EMAIL_WORDS.more) && e.html.includes(AL.EMAIL_WORDS.more));
  assert.ok(e.text.includes(`${AL.EMAIL_WORDS.sources}\n- Bank news\n  https://bank.example/a`));
  assert.ok(e.html.includes("Bank news<br>https://bank.example/a") && !e.html.includes('href="https://bank.example'), "listed, not linked");
});

test("alerts of one run claimed together go as one (the newest), so an older one can't arrive last and stay", async () => {
  const u = await F.account("al-tag", 10);
  await alertsOn(u);
  const link = automationLink("tag-a", "tag-r");
  for (const name of ["First", "Second", "Third"]) await notify({ userId: u.id, kind: "paused", phrase: A.NOTICES.paused, blanks: { name }, link });
  await notify({ userId: u.id, kind: "paused", phrase: A.NOTICES.paused, blanks: { name: "Other" }, link: automationLink("tag-b") });
  const report = await AL.deliverAlerts(u.id);
  assert.equal(report.alerts, 2, "one for the run, one for the other automation");
  assert.deepEqual(await pushedOf(u.id), [1, 1, 1, 1]);
});

test("a receipt saved while its email was on its way still matches once it went, as does one saved before emails", async () => {
  const u = await F.account("cmp1", 100);
  const aid = await emailing(u.id);
  const rid = await F.runRow({ automationId: aid, userId: u.id });
  claude.state.replies.push({ text: "Clear skies all day." });
  await advance(rid);
  // Saved while its email waited: it says it's on its way.
  await sql("UPDATE automation_emails SET state = 'queued', blanks = '{}' WHERE id = ?", [rid]);
  const saved = (await (await receiptRoute.GET(req(`/api/automations/runs/${rid}?format=json`, { cookie: u.cookie }), ctx({ runId: rid }))).json()) as { run: Record<string, unknown> };
  assert.equal(saved.run.emailing, true);
  await sql("UPDATE automation_emails SET state = 'sent' WHERE id = ?", [rid]);
  const check = async (receipt: unknown) =>
    ((await (await receiptRoute.POST(req(`/api/automations/runs/${rid}`, { cookie: u.cookie, json: { action: "check", receipt } }), ctx({ runId: rid }))).json()) as { matches: boolean }).matches;
  assert.equal(await check(saved), true);
  const older = structuredClone(saved);
  delete older.run.emailText;
  delete older.run.emailing;
  assert.equal(await check(older), true, "saved before Flash emailed results");
  const changed = structuredClone(saved);
  changed.run.name = "Something else";
  assert.equal(await check(changed), false, "anything else still counts");
});

test("an account's waiting alerts and emails are found on the small index of what waits, not its whole history", async () => {
  const plan = async (q: string) => (await all<{ detail: string }>(`EXPLAIN QUERY PLAN ${q}`, ["u"])).map((r) => r.detail).join(" | ");
  assert.match(await plan("SELECT 1 AS x FROM notifications WHERE pushed = 0 AND +user_id = ? LIMIT 1"), /notifications_unpushed/);
  const ended = "NOT EXISTS (SELECT 1 FROM automation_runs r WHERE r.id = automation_emails.run_id AND r.finished_at = 0)";
  const emailPlan = await plan(`SELECT id FROM automation_emails WHERE state IN ('queued','sending') AND state = 'queued' AND +user_id = ? AND ${ended} ORDER BY created_at LIMIT 2`);
  assert.match(emailPlan, /automation_emails_waiting/);
  assert.match(emailPlan, /automation_runs r USING INDEX sqlite_autoindex_automation_runs_1|SEARCH r USING INDEX sqlite_autoindex_automation_runs_1/, "each one's run by its id");
});
