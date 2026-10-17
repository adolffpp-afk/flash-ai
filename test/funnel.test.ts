import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./support/route-hooks.mjs", import.meta.url);
process.env.DATABASE_URL = ":memory:";
process.env.STRIPE_SECRET_KEY = "rk_test";
delete process.env.FLASH_APP_URL;
console.error = () => {};
console.info = () => {};
const { run, one, all, db } = await import("../src/lib/server/db.ts");
const { recordVisit, forgetServerMemory, visitTests, dayOf } = await import("../src/lib/server/visits.ts");
const { matchVisit, countSteps } = await import("../src/lib/server/funnel.ts");
const shop = await import("../src/lib/server/shop.ts");
const { FORM_COOKIE } = await import("../src/lib/server/site-auth.ts");
const { routeHost } = await import("../src/lib/site-host.ts");
const inboxRoute = await import("../src/app/api/sites/[slug]/inbox/route.ts");
const authRoute = await import("../src/app/api/sites/[slug]/auth/route.ts");
const shopRoute = await import("../src/app/api/sites/[slug]/shop/route.ts");
const trackRoute = await import("../src/app/api/sites/[slug]/track/route.ts");
const { afterwards } = await import("./support/next-server.mjs");

const BROWSER = "Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0";
const page = (slug: string, headers: Record<string, string> = {}, query = "") =>
  new Request(`https://www.flash-app.dev/p/${slug}${query}`, {
    headers: { "user-agent": BROWSER, host: "www.flash-app.dev", "accept-language": "en", "x-forwarded-for": "1.2.3.4", ...headers },
  });
/** A request the app's page makes: no Accept-Language rule, and no cookies. */
const call = (slug: string, path: string, init: { headers?: Record<string, string>; body?: BodyInit; method?: string } = {}) =>
  new Request(`https://www.flash-app.dev/api/sites/${slug}/${path}`, {
    method: init.method ?? "POST",
    body: init.body,
    headers: { "user-agent": BROWSER, host: "www.flash-app.dev", "x-forwarded-for": "1.2.3.4", ...init.headers },
  });
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) }) as never;
const n = async (sql: string, args: (string | number)[] = []) => Number((await one<{ n: number }>(sql, args))?.n ?? 0);
const events = (slug: string) =>
  all<{ day: string; step: string; source: string; medium: string; campaign: string; n: number }>(
    "SELECT day, step, source, medium, campaign, n FROM site_events WHERE site_slug = ? AND step NOT IN ('visit') ORDER BY day, step, source",
    [slug],
  ).then((rows) => rows.map((r) => ({ ...r, n: Number(r.n) })));
const site = (slug: string, owner = "u1") =>
  run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES (?, ?, ?, '<p>', 0, 0)", [slug, owner, slug]);
const sendForm = (slug: string, headers: Record<string, string> = {}, data: unknown = { name: "Ana", email: "ana@example.com" }) =>
  inboxRoute.POST(call(slug, "inbox", { headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ form: "contact", data }) }), ctx(slug));

await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('u1', 'o@x.co', 'h', 0, 1), ('u2', 'p@x.co', 'h', 0, 1), ('u3', 'q@x.co', 'h', 0, 1)");

test("a form counts once a day for the person who sent it, under where their visit came from", async () => {
  forgetServerMemory();
  await site("form-1");
  const at = Date.now();
  await recordVisit("form-1", page("form-1", { referer: "https://www.google.com/" }), null, at);
  const match = await matchVisit("form-1", call("form-1", "inbox"), at);
  assert.equal(match.kind, "visit");
  await countSteps("form-1", match, ["form"], at);
  await countSteps("form-1", await matchVisit("form-1", call("form-1", "inbox"), at), ["form"], at);
  assert.deepEqual(await events("form-1"), [{ day: dayOf(at), step: "form", source: "google.com", medium: "", campaign: "", n: 1 }], "a second send that day doesn't count again");

  // Another address isn't that visit: counted per send, as not matched.
  const other = call("form-1", "inbox", { headers: { "x-forwarded-for": "8.8.8.8" } });
  await countSteps("form-1", await matchVisit("form-1", other, at), ["form"], at);
  await countSteps("form-1", await matchVisit("form-1", other, at), ["form"], at);
  assert.deepEqual((await events("form-1")).find((e) => e.source === "?"), { day: dayOf(at), step: "form", source: "?", medium: "", campaign: "", n: 2 });

  // Robots count nothing, and nor does the owner.
  assert.deepEqual(await matchVisit("form-1", call("form-1", "inbox", { headers: { "user-agent": "curl/8.0" } }), at), { kind: "robot" });
  await countSteps("form-1", await matchVisit("form-1", call("form-1", "inbox", { headers: { "user-agent": "python-requests/2" } }), at), ["form"], at);
  await recordVisit("form-1", page("form-1", { "x-forwarded-for": "9.9.9.9" }), "u1", at);
  const owner = await matchVisit("form-1", call("form-1", "inbox", { headers: { "x-forwarded-for": "9.9.9.9" } }), at);
  assert.deepEqual(owner, { kind: "owner" });
  await countSteps("form-1", owner, ["form", "signup", "app:booking"], at);
  assert.equal((await events("form-1")).reduce((sum, e) => sum + e.n, 0), 3, "nothing more was counted");
});

test("a step just after midnight counts on the day of the visit it found, and a new visit today counts again", async () => {
  forgetServerMemory();
  await site("night-1");
  const late = Date.UTC(2026, 9, 6, 23, 59);
  const early = Date.UTC(2026, 9, 7, 0, 0, 30);
  await recordVisit("night-1", page("night-1", {}, "?utm_source=ig"), null, late);
  forgetServerMemory(); // another server, which knows no key yet
  await countSteps("night-1", await matchVisit("night-1", call("night-1", "inbox"), early), ["form"], early);
  assert.deepEqual(await events("night-1"), [{ day: "2026-10-06", step: "form", source: "instagram.com", medium: "", campaign: "", n: 1 }]);
  assert.equal(await n("SELECT COUNT(*) AS n FROM visit_keys WHERE day = '2026-10-07'"), 0, "matching never makes a key");

  // Coming back today is a new person-day, whose own form counts once on today.
  await recordVisit("night-1", page("night-1"), null, early + 60_000);
  const today = await matchVisit("night-1", call("night-1", "inbox"), early + 120_000);
  assert.equal(today.kind === "visit" && today.day, "2026-10-07");
  await countSteps("night-1", today, ["form"], early + 120_000);
  await countSteps("night-1", await matchVisit("night-1", call("night-1", "inbox"), early + 180_000), ["form"], early + 180_000);
  assert.deepEqual(
    (await events("night-1")).map((e) => [e.day, e.step, e.source, e.n]),
    [
      ["2026-10-06", "form", "instagram.com", 1],
      ["2026-10-07", "form", "", 1],
    ],
  );
});

test("someone past the owner's people limit isn't matched, so their form counts as not matched", async () => {
  forgetServerMemory();
  visitTests.freePeople = 1;
  try {
    await site("full-1", "u3");
    const at = Date.now();
    await recordVisit("full-1", page("full-1"), null, at);
    await recordVisit("full-1", page("full-1", { "x-forwarded-for": "5.5.5.5" }), null, at);
    await countSteps("full-1", await matchVisit("full-1", call("full-1", "inbox", { headers: { "x-forwarded-for": "5.5.5.5" } }), at), ["form"], at);
    await countSteps("full-1", await matchVisit("full-1", call("full-1", "inbox"), at), ["form"], at);
    assert.deepEqual(
      (await events("full-1")).filter((e) => e.step === "form").map((e) => [e.source, e.n]),
      [
        ["", 1],
        ["?", 1],
      ],
    );
  } finally {
    visitTests.freePeople = 0;
  }
});

test("the inbox counts a form only when it was taken, and a failed match never stops it", async () => {
  forgetServerMemory();
  await site("inbox-1");
  await recordVisit("inbox-1", page("inbox-1", { "x-forwarded-for": "2.2.2.2" }));
  const ip = { "x-forwarded-for": "2.2.2.2" };
  assert.equal((await inboxRoute.POST(call("inbox-1", "inbox", { headers: ip, body: JSON.stringify({ form: "bad name!", data: {} }) }), ctx("inbox-1"))).status, 400);
  assert.equal((await sendForm("inbox-1", ip, { note: "x".repeat(20_000) })).status, 413);
  await afterwards();
  assert.deepEqual(await events("inbox-1"), [], "refused sends count nothing");

  const res = await sendForm("inbox-1", ip);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  await afterwards();
  assert.deepEqual((await events("inbox-1")).map((e) => [e.step, e.source, e.n]), [["form", "", 1]]);
  assert.equal(await n("SELECT COUNT(*) AS n FROM site_contacts WHERE site_slug = 'inbox-1'"), 1, "the sender is still noted as a contact");

  // Past the inbox's own limit (10 an hour from one address), nothing more counts.
  for (let i = 0; i < 9; i++) await sendForm("inbox-1", ip);
  assert.equal((await sendForm("inbox-1", ip)).status, 429);
  await afterwards();
  assert.deepEqual((await events("inbox-1")).map((e) => [e.step, e.source, e.n]), [["form", "", 1]], "once a day per person");

  // A database that fails while matching gives "not matched", and the form is still taken.
  const client = await db();
  const execute = client.execute.bind(client);
  client.execute = ((s: { sql: string }, ...rest: unknown[]) => {
    if (typeof s === "object" && s.sql.includes("FROM site_people")) return Promise.reject(new Error("down"));
    return (execute as (...a: unknown[]) => unknown)(s, ...rest);
  }) as typeof client.execute;
  try {
    const sent = await sendForm("inbox-1", { "x-forwarded-for": "3.3.3.3" });
    assert.equal(sent.status, 200);
    await afterwards();
  } finally {
    client.execute = execute;
  }
  assert.deepEqual((await events("inbox-1")).map((e) => [e.step, e.source, e.n]), [
    ["form", "", 1],
    ["form", "?", 1],
  ]);
});

test("a sign-up counts once, only for a new member", async () => {
  forgetServerMemory();
  await site("join-1");
  const key = "k".repeat(24);
  const auth = (fields: Record<string, string>) => {
    const body = new URLSearchParams({ form_key: key, ...fields });
    return authRoute.POST(
      call("join-1", "auth", { headers: { cookie: `${FORM_COOKIE}=${key}`, "content-type": "application/x-www-form-urlencoded" }, body: body.toString() }),
      ctx("join-1"),
    );
  };
  await recordVisit("join-1", page("join-1", {}, "?utm_source=newsletter&utm_campaign=Spring"));
  const joined = await auth({ action: "signup", email: "bea@example.com", password: "longenough1", name: "Bea" });
  assert.equal(joined.status, 303);
  assert.match(joined.headers.get("location") ?? "", /flash_auth=ok/);
  await afterwards();
  assert.deepEqual((await events("join-1")).map((e) => [e.step, e.source, e.campaign, e.n]), [["signup", "newsletter", "spring", 1]]);

  // Signing up again with the account's password signs in instead; a wrong one is "taken"; signing in isn't a sign-up.
  await auth({ action: "signup", email: "bea@example.com", password: "longenough1" });
  await auth({ action: "signup", email: "bea@example.com", password: "wrongwrong1" });
  await auth({ action: "signin", email: "bea@example.com", password: "longenough1" });
  // Another new member from the same browser the same day is the same person.
  await auth({ action: "signup", email: "cy@example.com", password: "longenough1" });
  await afterwards();
  assert.deepEqual((await events("join-1")).map((e) => [e.step, e.n]), [["signup", 1]]);
  // A new member from another address counts as not matched.
  const other = new URLSearchParams({ form_key: key, action: "signup", email: "di@example.com", password: "longenough1" });
  await authRoute.POST(
    call("join-1", "auth", {
      headers: { cookie: `${FORM_COOKIE}=${key}`, "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "4.4.4.4" },
      body: other.toString(),
    }),
    ctx("join-1"),
  );
  await afterwards();
  assert.deepEqual((await events("join-1")).map((e) => [e.step, e.source, e.n]), [
    ["signup", "?", 1],
    ["signup", "newsletter", 1],
  ]);
});

test("a checkout keeps only its buyer's source beside the session, and its order adds to that source's daily total", async () => {
  forgetServerMemory();
  await site("cake-1");
  await run("INSERT INTO seller_accounts (user_id, stripe_account, country, currency, ready, created_at) VALUES ('u1', 'acct_1', 'CA', 'cad', 1, 0)");
  await run("INSERT INTO site_products (id, site_slug, name, price, currency, delivery, created_at) VALUES ('p1', 'cake-1', 'Cake', 1250, 'cad', 0, 0)");
  const forms: URLSearchParams[] = [];
  let sessionId = "cs_test_a";
  let hold: Promise<void> | null = null;
  const sessions: Record<string, unknown> = {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/v1", "") + url.search;
    if (path === "/checkout/sessions" && init?.method === "POST") {
      forms.push(new URLSearchParams(String(init.body)));
      return Response.json({ id: sessionId, url: `https://checkout.stripe.com/c/pay/${sessionId}` });
    }
    if (path.startsWith("/checkout/sessions/")) return Response.json(sessions[decodeURIComponent(path.split("/")[3].split("?")[0])]);
    if (path.startsWith("/checkout/sessions?")) return Response.json({ data: Object.values(sessions) });
    return Response.json({ id: "e" });
  }) as typeof fetch;
  const buy = (headers: Record<string, string> = {}) =>
    shopRoute.POST(call("cake-1", "shop", { headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ item: "Cake" }) }), ctx("cake-1"));
  const paid = (id: string, amount: number, currency = "cad") => ({
    id,
    payment_status: "paid",
    amount_total: amount,
    currency,
    created: Math.floor(Date.now() / 1000),
    metadata: { flash_site: "cake-1", flash_item: "Cake" },
    customer_details: { email: `${id}@example.com`, name: "Buyer" },
    line_items: { data: [{ quantity: 1 }] },
  });

  await recordVisit("cake-1", page("cake-1", {}, "?utm_source=instagram&utm_medium=social&utm_campaign=Spring%20Sale"));
  // The buyer never waits for the match: with its read held open, the link still comes back.
  const client = await db();
  const execute = client.execute.bind(client);
  let release = () => {};
  hold = new Promise<void>((resolve) => (release = resolve));
  client.execute = ((s: { sql: string }, ...rest: unknown[]) => {
    if (typeof s === "object" && s.sql.includes("FROM site_people") && hold) return hold.then(() => (execute as (...a: unknown[]) => unknown)(s, ...rest));
    return (execute as (...a: unknown[]) => unknown)(s, ...rest);
  }) as typeof client.execute;
  let answer: Response;
  try {
    answer = await buy();
  } finally {
    client.execute = execute;
  }
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { url: "https://checkout.stripe.com/c/pay/cs_test_a" }, "the page gets the link only, never the session's id");
  assert.equal(await n("SELECT COUNT(*) AS n FROM site_checkouts"), 0, "nothing is written before the match is done");
  release();
  hold = null;
  await afterwards();
  assert.deepEqual(await all("SELECT session_id, site_slug, source, medium, campaign FROM site_checkouts"), [
    { session_id: "cs_test_a", site_slug: "cake-1", source: "instagram.com", medium: "social", campaign: "spring-sale" },
  ]);
  assert.deepEqual((await events("cake-1")).map((e) => [e.step, e.source, e.n]), [["checkout", "instagram.com", 1]]);
  // Nothing about where the buyer came from goes to Stripe.
  assert.deepEqual(
    [...forms[0].keys()].filter((k) => k.startsWith("metadata")),
    ["metadata[flash_site]", "metadata[flash_item]"],
  );
  assert.ok(![...forms[0].values()].some((v) => /instagram|spring/.test(v)));

  // A buyer Flash can't match, and the owner, leave no source: their orders show as not matched.
  sessionId = "cs_test_b";
  await buy({ "x-forwarded-for": "7.7.7.7" });
  await recordVisit("cake-1", page("cake-1", { "x-forwarded-for": "9.9.9.9" }), "u1");
  sessionId = "cs_test_c";
  await buy({ "x-forwarded-for": "9.9.9.9" });
  await afterwards();
  assert.equal(await n("SELECT COUNT(*) AS n FROM site_checkouts"), 1);
  assert.deepEqual((await events("cake-1")).map((e) => [e.step, e.source, e.n]), [
    ["checkout", "?", 1],
    ["checkout", "instagram.com", 1],
  ]);

  // The order joins its source's total for the day, its source row goes, and the buyer is still a contact.
  sessions.cs_test_a = paid("cs_test_a", 1250);
  sessions.cs_test_b = paid("cs_test_b", 900, "eur");
  const done = await shop.finishCheckout("cake-1", "cs_test_a", null, "https://www.flash-app.dev");
  assert.equal(done.paid, true);
  assert.deepEqual(await all("SELECT source, medium, campaign, currency, orders, amount FROM site_revenue WHERE site_slug = 'cake-1'"), [
    { source: "instagram.com", medium: "social", campaign: "spring-sale", currency: "cad", orders: 1, amount: 1250 },
  ]);
  assert.equal(await n("SELECT COUNT(*) AS n FROM site_checkouts"), 0);
  assert.equal(await n("SELECT COUNT(*) AS n FROM site_contacts WHERE site_slug = 'cake-1' AND email = 'cs_test_a@example.com'"), 1);
  // The same order again adds nothing; an order found later by syncing has no source row, so adds nothing here.
  await shop.finishCheckout("cake-1", "cs_test_a", null, "https://www.flash-app.dev");
  await shop.syncOrders("u1", "cake-1");
  assert.deepEqual(await all("SELECT currency, orders, amount FROM site_revenue WHERE site_slug = 'cake-1'"), [{ currency: "cad", orders: 1, amount: 1250 }]);
  assert.equal(await n("SELECT COUNT(*) AS n FROM site_orders WHERE site_slug = 'cake-1'"), 2, "both orders are saved");

  // syncOrders attributes an order the same way when its buyer never came back.
  sessionId = "cs_test_d";
  await buy();
  await afterwards();
  sessions.cs_test_d = paid("cs_test_d", 1250);
  await shop.syncOrders("u1", "cake-1");
  assert.deepEqual(await all("SELECT currency, orders, amount FROM site_revenue WHERE site_slug = 'cake-1'"), [{ currency: "cad", orders: 2, amount: 2500 }]);

  // Orders keep no source of their own.
  const columns = (await all<{ name: string }>("PRAGMA table_info(site_orders)")).map((c) => c.name);
  assert.ok(!columns.some((c) => /source|medium|campaign/.test(c)), columns.join());
});

test("the track route counts the steps an app reports, without a source, and always answers 204 at once", async () => {
  forgetServerMemory();
  await site("track-1");
  const track = (body: BodyInit, headers: Record<string, string> = {}) =>
    trackRoute.POST(call("track-1", "track", { headers: { "content-type": "text/plain", ...headers }, body }), ctx("track-1"));
  const appSteps = async () =>
    (await events("track-1")).filter((e) => e.step.startsWith("app:")).map((e) => [e.step, e.source, e.medium, e.campaign, e.n]);

  // Nobody matched: nothing counts, and nothing says so.
  const nobody = await track("booking");
  assert.equal(nobody.status, 204);
  assert.equal(nobody.headers.get("access-control-allow-origin"), "*");
  await afterwards();
  assert.deepEqual(await events("track-1"), []);

  await recordVisit("track-1", page("track-1", { referer: "https://www.google.com/" }));
  const client = await db();
  const execute = client.execute.bind(client);
  let lists = 0;
  client.execute = ((s: { sql: string }, ...rest: unknown[]) => {
    if (typeof s === "object" && s.sql.startsWith("UPDATE site_people SET steps")) lists++;
    return (execute as (...a: unknown[]) => unknown)(s, ...rest);
  }) as typeof client.execute;
  try {
    assert.equal((await track("booking\nPlan-Chosen\ncheckout\norder-1234567\n" + "a1b2c3d4e5f6a7b8\nnot ok\n" + "x".repeat(41))).status, 204);
    await afterwards();
  } finally {
    client.execute = execute;
  }
  assert.equal(lists, 1, "one write to the person's list for the whole request");
  assert.deepEqual(await appSteps(), [
    ["app:booking", "", "", "", 1],
    ["app:plan-chosen", "", "", "", 1],
  ]);
  // Reported again: once a day per person.
  await track("booking");
  await afterwards();
  assert.equal((await appSteps())[0][4], 1);

  // A body that says it is long isn't read at all; one sent without a length is cut at 1 KB.
  const long = call("track-1", "track", { headers: { "content-length": "4096", "content-type": "text/plain" }, body: "survey" });
  assert.equal((await trackRoute.POST(long, ctx("track-1"))).status, 204);
  assert.equal(long.bodyUsed, false);
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("menu-opened\n" + "z".repeat(1100) + "\nafter-the-cut"));
      c.close();
    },
  });
  const unsized = new Request("https://www.flash-app.dev/api/sites/track-1/track", {
    method: "POST",
    body: stream,
    duplex: "half",
    headers: { "user-agent": BROWSER, "x-forwarded-for": "1.2.3.4" },
  } as RequestInit);
  assert.equal((await trackRoute.POST(unsized, ctx("track-1"))).status, 204);
  await afterwards();
  const names = (await appSteps()).map((r) => r[0]);
  assert.ok(names.includes("app:menu-opened"));
  assert.ok(!names.includes("app:survey") && !names.includes("app:after-the-cut"), names.join());
});

test("an app counts 10 names a day, a person 15 tries, and the owner's apps their plan's number of app steps", async () => {
  forgetServerMemory();
  await site("names-1");
  const at = Date.now();
  const ip = (i: number) => `10.1.0.${i}`;
  const step = async (i: number, names: string[]) =>
    countSteps("names-1", await matchVisit("names-1", call("names-1", "track", { headers: { "x-forwarded-for": ip(i) } }), at), names.map((s) => `app:${s}` as const), at);
  await recordVisit("names-1", page("names-1", { "x-forwarded-for": ip(1) }), null, at);
  await step(1, ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9", "n10", "n11"]);
  const counted = await all<{ step: string }>("SELECT step FROM site_events WHERE site_slug = 'names-1' AND step LIKE 'app:%'");
  assert.equal(counted.length, 10, "the 11th name of the day isn't counted");
  assert.equal(await n("SELECT COUNT(*) AS n FROM site_step_names WHERE site_slug = 'names-1'"), 10);
  // The refused name used one of the person's 15 tries; after 15, nothing else is read.
  await step(1, ["n1", "m1", "m2", "m3", "m4", "m5"]);
  const row = await one<{ steps: string }>("SELECT steps FROM site_people WHERE site_slug = 'names-1'");
  assert.equal(JSON.parse(row!.steps).length, 15);
  const client = await db();
  const execute = client.execute.bind(client);
  const batch = client.batch.bind(client);
  let sent = 0;
  client.execute = ((...a: unknown[]) => (sent++, (execute as (...a: unknown[]) => unknown)(...a))) as typeof client.execute;
  client.batch = ((...a: unknown[]) => (sent++, (batch as (...a: unknown[]) => unknown)(...a))) as typeof client.batch;
  try {
    const match = await matchVisit("names-1", call("names-1", "track", { headers: { "x-forwarded-for": ip(1) } }), at);
    sent = 0;
    await countSteps("names-1", match, ["app:z1", "form"], at);
  } finally {
    client.execute = execute;
    client.batch = batch;
  }
  assert.equal(sent, 0, "a person who used their 15 tries costs nothing more past the match");

  // The owner's daily app steps, here 3, across all their apps; built-in steps still count.
  visitTests.freePeople = 3;
  try {
    forgetServerMemory();
    await site("budget-1", "u2");
    await site("budget-2", "u2");
    const later = Date.now();
    await recordVisit("budget-1", page("budget-1", { "x-forwarded-for": ip(7) }), null, later);
    await recordVisit("budget-2", page("budget-2", { "x-forwarded-for": ip(8) }), null, later);
    const on = (slug: string, i: number) => matchVisit(slug, call(slug, "track", { headers: { "x-forwarded-for": ip(i) } }), later);
    await countSteps("budget-1", await on("budget-1", 7), ["app:a", "app:b"], later);
    await countSteps("budget-2", await on("budget-2", 8), ["app:c", "app:d", "form"], later);
    const rows = await all<{ site_slug: string; step: string; n: number }>(
      "SELECT site_slug, step, n FROM site_events WHERE site_slug IN ('budget-1', 'budget-2') AND step <> 'visit' ORDER BY site_slug, step",
    );
    assert.deepEqual(
      rows.map((r) => [r.site_slug, r.step, Number(r.n)]),
      [
        ["budget-1", "app:a", 1],
        ["budget-1", "app:b", 1],
        ["budget-2", "app:c", 1],
        ["budget-2", "capped-app", 3],
        ["budget-2", "form", 1],
      ],
    );
    assert.equal(await n("SELECT steps AS n FROM owner_people WHERE user_id = 'u2' AND day = ?", [dayOf(later)]), 3);
  } finally {
    visitTests.freePeople = 0;
  }
});

test("a custom domain's app can report steps", () => {
  assert.deepEqual(routeHost("crumbbakery.com", "/api/sites/x/track", "POST"), { siteApi: "x" });
});

test("unpublishing takes the funnel's tables with the app", async () => {
  forgetServerMemory();
  await site("gone-1");
  await recordVisit("gone-1", page("gone-1", { "x-forwarded-for": "6.6.6.6" }));
  await countSteps("gone-1", await matchVisit("gone-1", call("gone-1", "track", { headers: { "x-forwarded-for": "6.6.6.6" } })), ["app:x", "form"]);
  await run("INSERT INTO site_checkouts (session_id, site_slug, source, medium, campaign, created_at) VALUES ('cs_gone', 'gone-1', '', '', '', 0)");
  await run("INSERT INTO site_revenue (site_slug, day, source, medium, campaign, currency, orders, amount) VALUES ('gone-1', '2026-10-01', '', '', '', 'usd', 1, 1)");
  const { unpublishSite } = await import("../src/lib/server/sites.ts");
  assert.equal(await unpublishSite("u1", "gone-1"), true);
  for (const table of ["site_events", "site_revenue", "site_checkouts", "site_step_names", "site_people"]) {
    assert.equal(await n(`SELECT COUNT(*) AS n FROM ${table} WHERE site_slug = 'gone-1'`), 0, table);
  }
});
