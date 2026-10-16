import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";

/*
 * Reporting what people share or publish: a report is kept as the item it points at (a shared chat,
 * a file link, a published app, found by its custom domain too), only from Flash's own pages,
 * within caps, with repeats from one network for one reason collapsed, and the admins are emailed
 * at most once per item an hour and twice a day for one network's reports. Only admins see reports
 * or act on them, and what reporters type is never HTML.
 */
register("./support/route-hooks.mjs", import.meta.url);
process.env.DATABASE_URL = ":memory:";
process.env.RESEND_API_KEY = "test-key";
process.env.FLASH_ADMIN_EMAILS = "boss@flash.test";
delete process.env.FLASH_DEMO_EMAILS;
delete process.env.FLASH_APP_URL;
delete process.env.VERCEL_API_TOKEN;

const HOUR = 3_600_000;
let clock = Date.UTC(2026, 9, 16, 12);
Date.now = () => clock;

// What Resend was asked to send.
const sent: { to: string; recipients: string[]; subject: string; html: string; text: string }[] = [];
globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  sent.push({ to: body.to[0], recipients: body.to, subject: body.subject, html: body.html, text: body.text });
  return Response.json({ id: "email" });
}) as typeof fetch;
console.info = () => {};
console.warn = () => {};

const { run, one, all } = await import("../src/lib/server/db.ts");
const { createSession } = await import("../src/lib/server/auth.ts");
const { EMAIL_BUDGET, EMAILS, sendEmail } = await import("../src/lib/server/email.ts");
const { reportTarget, MAX_REPORT_DETAILS } = await import("../src/lib/report.ts");
const { REPORT_LIMITS, listReports, plainText } = await import("../src/lib/server/reports.ts");
const { countOf } = await import("../src/lib/server/limits.ts");
const { serveSite } = await import("../src/lib/server/serve-site.ts");
const reportRoute = await import("../src/app/api/reports/route.ts");
const adminRoute = await import("../src/app/api/admin/reports/route.ts");
const { afterwards } = await import("./support/next-server.mjs");

const SITE = "https://www.flash-app.dev";
const SHARE = "ShareAAAAAAAAAAA";
const FILE = "PublicFileAAAAAAAAAAAAAA";
await run(
  "INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('owner', 'owner@x.co', 'h', 0, 1), ('boss', 'boss@flash.test', 'h', 0, 1), ('someone', 'someone@x.co', 'h', 0, 1)",
);
await run("INSERT INTO shares (id, user_id, project_id, title, messages, created_at) VALUES (?, 'owner', 'p1', 'Logo ideas', '[]', 0)", [SHARE]);
await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('bakery-ab12', 'owner', 'Golden Crumb', '<head></head><p>Bread</p>', 0, 0)");
await run("INSERT INTO site_domains (domain, site_slug, user_id, created_at) VALUES ('goldencrumb.ca', 'bakery-ab12', 'owner', 0)");
await run("INSERT INTO files (id, user_id, mime, name, data, created_at) VALUES ('file1', 'owner', 'image/png', 'cat.png', x'00', 0)");
await run("INSERT INTO public_files (id, file_id, user_id, created_at) VALUES (?, 'file1', 'owner', 0)", [FILE]);

const report = (body: object, ip = "203.0.113.1", headers: Record<string, string> = { origin: SITE }) =>
  reportRoute.POST(
    new Request(`${SITE}/api/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers },
      body: JSON.stringify(body),
    }),
  );
const reportsOf = (kind: string, id: string) =>
  all<{ reason: string; details: string; email: string; repeats: number; status: string; reporter: string; via: string }>(
    "SELECT * FROM reports WHERE item_kind = ? AND item_id = ? ORDER BY created_at, rowid",
    [kind, id],
  );
const count = async () => Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM reports"))!.n);
const cookieFor = async (userId: string) => (await createSession(userId, true)).split(";")[0];
const admin = (method: "GET" | "POST", cookie: string, body?: object, headers: Record<string, string> = { origin: SITE }) =>
  adminRoute[method](
    new Request(`${SITE}/api/admin/reports`, {
      method,
      headers: { cookie, ...(body ? { "content-type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );

test("an address is one of Flash's own pages that show someone's work, or a custom domain, and nothing else", () => {
  const own = (host: string) => /(^|\.)flash-app\.dev$/.test(host);
  assert.deepEqual(reportTarget("https://www.flash-app.dev/s/AbC_12-x", own), { kind: "share", id: "AbC_12-x" });
  assert.deepEqual(reportTarget("www.flash-app.dev/s/AbC/files/xyz", own), { kind: "share", id: "AbC" }, "a shared chat's picture is the chat's");
  assert.deepEqual(reportTarget("flash-app.dev/p/bakery-ab12/", own), { kind: "site", id: "bakery-ab12" });
  assert.deepEqual(reportTarget("/p/bakery-ab12/card", own), { kind: "site", id: "bakery-ab12" });
  assert.deepEqual(reportTarget(`${SITE}/api/sites/bakery-ab12/files/up1`, own), { kind: "site", id: "bakery-ab12" }, "a file sent to an app is the app's");
  assert.deepEqual(reportTarget(`${SITE}/f/PublicFile?x=1#y`, own), { kind: "file", id: "PublicFile" });
  assert.deepEqual(reportTarget("  https://GoldenCrumb.ca/menu?x=1 ", own), { kind: "domain", domain: "goldencrumb.ca" });
  assert.deepEqual(reportTarget("goldencrumb.ca.", own), { kind: "domain", domain: "goldencrumb.ca" });
  for (const bad of [
    "",
    "hello",
    `${SITE}/`,
    `${SITE}/settings`,
    `${SITE}/admin`,
    `${SITE}/p/../admin`,
    "/s/",
    "javascript:alert(1)",
    "data:text/html,<p>hi",
    "ftp://goldencrumb.ca/",
    "https://user:pw@goldencrumb.ca/",
    "http://192.168.0.1/",
    `https://goldencrumb.ca/${"a".repeat(600)}`,
  ]) {
    assert.equal(reportTarget(bad, own), null, bad);
  }
  const started = performance.now();
  assert.equal(reportTarget(`${"/s/".repeat(50_000)}x`, own), null);
  assert.ok(performance.now() - started < 50, "a very long address is refused at once");
});

test("a shared chat's report is kept as that chat, as plain text, without the reporter's address, and the admins are emailed", async () => {
  const r = await report({ address: `${SITE}/s/${SHARE}`, reason: "spam", details: "  Fake <b>pills</b>‮\u0007 sold here\r\nTwice  ", email: " Ana@Example.com " });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  await afterwards();
  const [row] = await reportsOf("share", SHARE);
  assert.equal(row.reason, "spam");
  assert.equal(row.details, "Fake <b>pills</b> sold here\nTwice", "control and direction characters go; the words stay as typed");
  assert.equal(row.email, "ana@example.com");
  const stored = await one<Record<string, unknown>>("SELECT * FROM reports");
  assert.equal(stored!.owner_id, "owner");
  assert.equal(stored!.title, "Logo ideas");
  assert.ok(!JSON.stringify(stored).includes("203.0.113.1"), "only a hash of the network is kept");
  const limits = await all<{ key: string }>("SELECT key FROM rate_limits");
  assert.ok(limits.length && limits.every((l) => !l.key.includes("203.0.113.1")), "its limits count the hash too");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "boss@flash.test");
  assert.match(sent[0].subject, /^New report: shared chat Logo ideas$/);
  assert.ok(sent[0].text.includes(`${SITE}/s/${SHARE}`) && sent[0].text.includes("Owner: owner@x.co") && sent[0].text.includes("Spam or scam"));
  assert.ok(sent[0].html.includes("Fake &lt;b&gt;pills&lt;/b&gt;") && !sent[0].html.includes("<b>pills"), "the email escapes what was typed");
  assert.ok(sent[0].text.includes(`${SITE}/admin?tab=reports`));
});

test("an address that isn't Flash's, or an item Flash doesn't have, is refused and nothing is kept", async () => {
  const before = await count();
  const missing = await report({ address: `${SITE}/s/NoSuchShare1234`, reason: "spam" }, "203.0.113.2");
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /couldn't find that page/);
  assert.equal((await report({ address: "https://not-connected.example/", reason: "spam" }, "203.0.113.2")).status, 404, "a domain no app uses");
  assert.equal((await report({ address: `${SITE}/settings`, reason: "spam" }, "203.0.113.2")).status, 400);
  assert.equal((await report({ address: "", reason: "spam" }, "203.0.113.2")).status, 400);
  assert.equal(await count(), before);
});

test("a custom domain is reported as the app connected to it, with or without www, and a file link as the file", async () => {
  assert.equal((await report({ address: "https://www.goldencrumb.ca/", reason: "copyright" }, "198.51.100.1")).status, 200);
  const [site] = await reportsOf("site", "bakery-ab12");
  assert.equal(site.via, "goldencrumb.ca");
  assert.equal((await report({ address: `${SITE}/f/${FILE}`, reason: "sexual" }, "198.51.100.1")).status, 200);
  assert.equal((await reportsOf("file", FILE)).length, 1);
  // A 404 page for a domain is never a published app's.
  await run("DELETE FROM site_domains WHERE domain = 'gone.example'");
  assert.equal((await report({ address: "gone.example", reason: "spam" }, "198.51.100.1")).status, 404);
});

test("one network reporting the same item for the same reason adds to its report; another reason or network counts apart; one email an hour", async () => {
  await afterwards();
  const emails = () => sent.filter((s) => s.subject.includes("Golden Crumb")).length;
  assert.equal(emails(), 1, "the custom-domain report above emailed the admins");
  // The same network again for the same reason, now with details: still one report, counted again.
  assert.equal((await report({ address: `${SITE}/p/bakery-ab12`, reason: "copyright", details: "Copies my bakery's photos" }, "198.51.100.1")).status, 200);
  // More details are added below the ones it has, once.
  for (let i = 0; i < 2; i++) assert.equal((await report({ address: "/p/bakery-ab12", reason: "copyright", details: "And my logo" }, "198.51.100.1")).status, 200);
  // Another address in the same IPv6 /64 is the same network.
  assert.equal((await report({ address: "/p/bakery-ab12", reason: "spam" }, "2001:db8:7:7::1")).status, 200);
  assert.equal((await report({ address: "/p/bakery-ab12", reason: "spam" }, "2001:db8:7:7::2")).status, 200);
  // Another reason from that network is a report of its own, so what it says isn't lost.
  assert.equal((await report({ address: "/p/bakery-ab12", reason: "illegal", details: "Sells stolen cards" }, "2001:db8:7:7::3")).status, 200);
  await afterwards();
  const rows = await reportsOf("site", "bakery-ab12");
  assert.deepEqual(
    rows.map((r) => [r.reason, r.repeats, r.details]),
    [
      ["copyright", 4, "Copies my bakery's photos\nAnd my logo"],
      ["spam", 2, ""],
      ["illegal", 1, "Sells stolen cards"],
    ],
  );
  assert.equal(emails(), 1, "no second email about the same item within the hour");
  clock += HOUR + 1;
  assert.equal((await report({ address: "/p/bakery-ab12", reason: "violence" }, "192.0.2.50")).status, 200);
  await afterwards();
  assert.equal(emails(), 2, "an hour later, a new report emails again");
  assert.match(sent.at(-1)!.text, /Reports about it: 4/);
});

test("reports are capped: a reason from the list, short details, a real email, and so many per network and for everyone", async () => {
  const address = `${SITE}/s/${SHARE}`;
  assert.equal((await report({ address, reason: "nope" }, "192.0.2.1")).status, 400);
  assert.equal((await report({ address }, "192.0.2.1")).status, 400);
  assert.equal((await report({ address, reason: "spam", details: "x".repeat(MAX_REPORT_DETAILS + 1) }, "192.0.2.1")).status, 413);
  assert.equal((await report({ address, reason: "spam", details: "x".repeat(MAX_REPORT_DETAILS) }, "192.0.2.1")).status, 200);
  assert.equal((await report({ address, reason: "spam", email: "not-an-email" }, "192.0.2.1")).status, 400);
  assert.equal((await report({ address, reason: "spam", email: `${"a".repeat(250)}@x.co` }, "192.0.2.1")).status, 400);
  assert.equal((await report({ address: "x".repeat(600), reason: "spam" }, "192.0.2.1")).status, 400);
  assert.equal((await report({ address: { not: "text" }, reason: "spam" }, "192.0.2.1")).status, 400);

  // One network: perHour reports an hour, repeats included.
  let ok = 0;
  for (let i = 0; i < REPORT_LIMITS.perHour + 3; i++) if ((await report({ address, reason: "spam" }, "192.0.2.99")).status === 200) ok++;
  assert.equal(ok, REPORT_LIMITS.perHour);
  const refused = await report({ address, reason: "spam" }, "192.0.2.99");
  assert.equal(refused.status, 429);
  assert.match((await refused.json()).error, /Too many requests/);
  // And perDay a day: then waiting an hour doesn't help, and it says so.
  for (let hour = 1; hour < REPORT_LIMITS.perDay / REPORT_LIMITS.perHour; hour++) {
    clock += HOUR + 1;
    for (let i = 0; i < REPORT_LIMITS.perHour; i++) assert.equal((await report({ address, reason: "spam" }, "192.0.2.99")).status, 200);
  }
  clock += HOUR + 1;
  const today = await report({ address, reason: "spam" }, "192.0.2.99");
  assert.equal(today.status, 429);
  assert.match((await today.json()).error, /Too many tries today/);

  // Everyone together: once the day's reports are used up, a new network waits too.
  await run("UPDATE rate_limits SET count = ? WHERE key = 'report-all'", [REPORT_LIMITS.allPerDay]);
  const full = await report({ address, reason: "spam" }, "192.0.2.150");
  assert.equal(full.status, 429);
  assert.match((await full.json()).error, /Too many tries today/);
  await run("DELETE FROM rate_limits WHERE key = 'report-all'");
  assert.equal((await report({ address, reason: "spam" }, "192.0.2.151")).status, 200);
  // Only reports of something Flash has count for everyone.
  const counted = await countOf("report-all");
  assert.equal((await report({ address: "https://not-connected.example/", reason: "spam" }, "192.0.2.152")).status, 404);
  assert.equal((await report({ address: `${SITE}/settings`, reason: "spam" }, "192.0.2.152")).status, 400);
  assert.equal(await countOf("report-all"), counted);
});

test("another site, a published app or a plain form can't send reports from a visitor's browser", async () => {
  const before = await count();
  const body = { address: `${SITE}/s/${SHARE}`, reason: "spam" };
  const sites: Record<string, string>[] = [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }, { origin: "null" }];
  for (const headers of sites) {
    const r = await report(body, "192.0.2.200", headers);
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /Flash's own page/);
  }
  const form = new Request(`${SITE}/api/reports`, { method: "POST", headers: { "content-type": "text/plain", origin: SITE }, body: JSON.stringify(body) });
  assert.equal((await reportRoute.POST(form)).status, 403);
  assert.equal(await count(), before);
});

test("without email set up a report is still kept; report emails stop at their own daily share", async () => {
  delete process.env.RESEND_API_KEY;
  const before = sent.length;
  assert.equal((await report({ address: `${SITE}/f/${FILE}`, reason: "privacy" }, "192.0.2.220")).status, 200);
  await afterwards();
  assert.equal(sent.length, before);
  assert.equal((await reportsOf("file", FILE)).length, 2);
  process.env.RESEND_API_KEY = "test-key";

  clock += 24 * HOUR;
  const message = EMAILS.report({ what: "Shared chat", title: "T", address: "x", owner: "o", reason: "Spam or scam", count: 1, details: "", reporter: "", link: "x" });
  let n = 0;
  while (n < 50 && (await sendEmail("boss@flash.test", message, "report"))) n++;
  assert.equal(n, EMAIL_BUDGET.reports);
  assert.ok(EMAIL_BUDGET.reports < EMAIL_BUDGET.perDay - EMAIL_BUDGET.keptForAccounts, "reports can't use up the day's other emails");
  assert.equal(await sendEmail("someone@x.co", EMAILS.signin("https://x/s"), "account"), true, "sign-in emails still go");
});

test("only admins see reports, from Flash's own dashboard, and take down a share link, a file link or an app", async () => {
  const owner = await cookieFor("owner");
  const boss = await cookieFor("boss");
  assert.equal((await admin("GET", "")).status, 401);
  assert.equal((await admin("GET", owner)).status, 403);
  assert.equal((await admin("POST", owner, { kind: "share", id: SHARE, action: "take_down" })).status, 403);
  assert.ok(await one("SELECT 1 FROM shares WHERE id = ?", [SHARE]), "nothing changed for someone who isn't an admin");

  const list = await admin("GET", boss);
  assert.equal(list.status, 200);
  const { items } = (await list.json()) as { items: { kind: string; id: string; open: number; total: number; ownerEmail: string; canTakeDown: boolean; live: boolean; reports: { details: string }[] }[] };
  assert.deepEqual(items.map((i) => i.kind).sort(), ["file", "share", "site"]);
  assert.ok(items.every((i) => i.open > 0 && i.ownerEmail === "owner@x.co"));
  const share = items.find((i) => i.kind === "share")!;
  assert.ok(share.reports.some((r) => r.details === "Fake <b>pills</b> sold here\nTwice"), "the dashboard gets what was typed as text, to show as text");
  assert.ok(items.every((i) => i.canTakeDown));

  // Another site can't make the admin's browser act.
  assert.equal((await admin("POST", boss, { kind: "share", id: SHARE, action: "take_down" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await admin("POST", boss, { kind: "share", id: SHARE, action: "delete_everything" })).status, 400);
  assert.equal((await admin("POST", boss, { kind: "share", id: "NeverReported1", action: "reviewed" })).status, 404);

  // Mark reviewed closes the item's open reports, and is logged.
  const reviewed = await admin("POST", boss, { kind: "file", id: FILE, action: "reviewed" });
  assert.equal(reviewed.status, 200);
  assert.ok((await reportsOf("file", FILE)).every((r) => r.status === "reviewed"));
  // Taking down a file link turns that link off; the owner's file stays.
  assert.equal((await admin("POST", boss, { kind: "file", id: FILE, action: "take_down" })).status, 200);
  assert.equal(await one("SELECT 1 FROM public_files WHERE id = ?", [FILE]), null);
  assert.ok(await one("SELECT 1 FROM files WHERE id = 'file1'"));
  assert.ok((await reportsOf("file", FILE)).every((r) => r.status === "taken_down"));

  // Taking down a shared chat turns its link off; the owner's chat stays.
  assert.equal((await admin("POST", boss, { kind: "share", id: SHARE, action: "take_down" })).status, 200);
  assert.equal(await one("SELECT 1 FROM shares WHERE id = ?", [SHARE]), null);
  assert.ok((await reportsOf("share", SHARE)).every((r) => r.status === "taken_down"));

  // Taking down an app unpublishes it with its domain.
  assert.equal((await admin("POST", boss, { kind: "site", id: "bakery-ab12", action: "take_down" })).status, 200);
  assert.equal(await one("SELECT 1 FROM sites WHERE slug = 'bakery-ab12'"), null);
  assert.equal(await one("SELECT 1 FROM site_domains WHERE domain = 'goldencrumb.ca'"), null);
  assert.equal((await report({ address: "goldencrumb.ca", reason: "spam" }, "192.0.2.230")).status, 404, "what's gone can't be reported");

  const log = await all<{ item_kind: string; action: string; admin_email: string }>("SELECT item_kind, action, admin_email FROM report_actions ORDER BY id");
  assert.deepEqual(log.map((l) => `${l.item_kind} ${l.action} ${l.admin_email}`), [
    "file reviewed boss@flash.test",
    "file taken_down boss@flash.test",
    "share taken_down boss@flash.test",
    "site taken_down boss@flash.test",
  ]);
  const after = (await (await admin("GET", boss)).json()) as { items: { kind: string; status: string; live: boolean; last: { action: string } | null }[] };
  assert.deepEqual(after.items.map((i) => `${i.kind} ${i.status} ${i.live} ${i.last?.action}`).sort(), [
    "file taken_down false taken_down",
    "share taken_down false taken_down",
    "site taken_down false taken_down",
  ]);
});

test("what a reporter types is plain text everywhere: escaped in emails, never put in a page as HTML", () => {
  assert.equal(plainText("a\u0000b\r\nc‮d\te⁦f "), "ab\ncd\tef");
  const email = EMAILS.report({
    what: "Published app",
    title: "<img src=x onerror=alert(1)>\nBcc: everyone@x.co",
    address: "https://www.flash-app.dev/p/x",
    owner: "o@x.co",
    reason: "Spam or scam",
    count: 2,
    details: "<script>alert(1)</script> & more",
    reporter: 'a"><svg onload=alert(1)>@x.co',
    link: "https://www.flash-app.dev/admin?tab=reports",
  });
  assert.ok(!/<script|<img|<svg/i.test(email.html));
  assert.ok(email.html.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more"));
  assert.ok(!/[\r\n]/.test(email.subject), "the subject stays one line");
  for (const file of ["ReportForm.tsx", "ReportButton.tsx", "ReportPage.tsx", "AdminReports.tsx"]) {
    const source = readFileSync(new URL(`../src/components/${file}`, import.meta.url), "utf8");
    assert.ok(!/dangerouslySetInnerHTML|innerHTML/.test(source), file);
  }
});

test("published apps get nothing from Flash on their pages: they're reported on /report, which the footers link to", async () => {
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('shop-cd34', 'owner', 'Shop', '<head></head><p>Shop</p>', 0, 0)");
  const html = await (await serveSite("shop-cd34", `${SITE}/p/shop-cd34`, new Request(`${SITE}/p/shop-cd34`))).text();
  assert.ok(!/report/i.test(html), "no Report button or script in a published app");
  const src = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
  for (const path of ["components/Landing.tsx", "components/LegalPage.tsx", "components/AccountMenu.tsx", "components/ReportButton.tsx"]) {
    assert.ok(src(path).includes('href="/report"'), path);
  }
  assert.ok(!src("components/LegalPage.tsx").includes('<Link href="/report"'), "a full page load, so /report's language doesn't stay after Back");
  assert.ok(src("app/s/[id]/page.tsx").includes("<ReportButton"), "shared chats have their own Report form");
  assert.match(src("app/privacy/page.tsx"), /<strong>Reports:<\/strong>[^<]*hashed/);
});

test("one network can't use up the day's report emails, and each report is one email to every admin", async () => {
  clock += 24 * HOUR;
  process.env.FLASH_ADMIN_EMAILS = "boss@flash.test, deputy@flash.test";
  for (let i = 0; i < 3; i++) {
    await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES (?, 'owner', ?, '<p>App</p>', 0, 0)", [`app-${i}`, `App ${i}`]);
  }
  const before = sent.length;
  for (let i = 0; i < 3; i++) assert.equal((await report({ address: `/p/app-${i}`, reason: "spam" }, "198.51.100.77")).status, 200);
  await afterwards();
  assert.equal(sent.length - before, REPORT_LIMITS.emailsPerNetwork, "one network's new reports email the admins twice a day at most");
  assert.deepEqual(sent.at(-1)!.recipients, ["boss@flash.test", "deputy@flash.test"], "one email to every admin");
  // Another network reporting the item that got no email still gets one sent.
  assert.equal((await report({ address: "/p/app-2", reason: "privacy" }, "203.0.113.77")).status, 200);
  await afterwards();
  assert.equal(sent.length - before, REPORT_LIMITS.emailsPerNetwork + 1);
  assert.match(sent.at(-1)!.subject, /App 2$/);
  // Each report counts once against the day's report emails, however many admins it goes to; the
  // day's total counts every admin.
  const day = new Date(clock).toISOString().slice(0, 10);
  assert.equal(await countOf(`email-report:${day}`), REPORT_LIMITS.emailsPerNetwork + 1);
  assert.equal(await countOf(`email-day:${day}`), 2 * (REPORT_LIMITS.emailsPerNetwork + 1));
  process.env.FLASH_ADMIN_EMAILS = "boss@flash.test";
});

test("the dashboard lists every open report, however many newer ones were closed", async () => {
  const add = (id: string, status: string, at: number) =>
    run("INSERT INTO reports (id, item_kind, item_id, owner_id, title, reason, reporter, status, created_at, updated_at) VALUES (?, 'share', ?, 'owner', 'Chat', 'spam', ?, ?, ?, ?)", [
      id,
      `Share-${id}`,
      id,
      status,
      at,
      at,
    ]);
  await add("old-open", "open", 1);
  const open = Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"))!.n);
  for (let i = 0; i <= open; i++) await add(`closed-${i}`, "reviewed", clock + 1 + i);
  // Room for only as many reports as are open, all newer ones closed: every open one is listed.
  const items = await listReports(open);
  assert.ok(items.some((i) => i.id === "Share-old-open" && i.open === 1));
  assert.equal(items.reduce((n, i) => n + i.open, 0), open);
});

test("an app's name taken again by someone else isn't taken down for what was reported about the old app", async () => {
  const boss = await cookieFor("boss");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('reused-ef56', 'someone', 'New app', '<p>New</p>', 0, 0)");
  await run(
    "INSERT INTO reports (id, item_kind, item_id, owner_id, title, reason, reporter, status, created_at, updated_at) VALUES ('old-owner', 'site', 'reused-ef56', 'owner', 'Old app', 'spam', 'r', 'open', 1, 1)",
  );
  assert.equal((await admin("POST", boss, { kind: "site", id: "reused-ef56", action: "take_down" })).status, 409);
  assert.ok(await one("SELECT 1 FROM sites WHERE slug = 'reused-ef56'"), "the new owner's app stays");
  assert.ok((await reportsOf("site", "reused-ef56")).every((r) => r.status === "open"));
  assert.equal((await admin("POST", boss, { kind: "site", id: "reused-ef56", action: "reviewed" })).status, 200);
});
