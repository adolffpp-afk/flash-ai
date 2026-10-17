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
const { recordVisit, forgetServerMemory, visitTests, visitStats, dayOf } = await import("../src/lib/server/visits.ts");
const { matchVisit, countSteps, funnelStats, funnelRange, funnelTests } = await import("../src/lib/server/funnel.ts");
const { createSession } = await import("../src/lib/server/auth.ts");
const shop = await import("../src/lib/server/shop.ts");
const { FORM_COOKIE } = await import("../src/lib/server/site-auth.ts");
const { routeHost } = await import("../src/lib/site-host.ts");
const inboxRoute = await import("../src/app/api/sites/[slug]/inbox/route.ts");
const authRoute = await import("../src/app/api/sites/[slug]/auth/route.ts");
const shopRoute = await import("../src/app/api/sites/[slug]/shop/route.ts");
const trackRoute = await import("../src/app/api/sites/[slug]/track/route.ts");
const funnelRoute = await import("../src/app/api/sites/[slug]/funnel/route.ts");
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
/** An app, with the step names its code reports with flashDB.track (as publishing keeps them, see stepsInHtml). */
const site = (slug: string, owner = "u1", stepNames: string[] = []) =>
  run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at, step_names) VALUES (?, ?, ?, '<p>', 0, 0, ?)", [
    slug,
    owner,
    slug,
    JSON.stringify(stepNames),
  ]);
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
  // The page the buyer is on, which they go back to, with the tags of the link they came by.
  const onPage = "https://www.flash-app.dev/p/cake-1?utm_source=instagram&utm_medium=social&utm_campaign=Spring%20Sale&gclid=Cj0x&ttclid=E.C.P&mc_eid=6f1e2d3c4b&menu=cakes#/shop";
  const buy = (headers: Record<string, string> = {}) =>
    shopRoute.POST(call("cake-1", "shop", { headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ item: "Cake", page: onPage }) }), ctx("cake-1"));
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
  assert.ok(![...forms[0].values()].some((v) => /instagram|spring|utm_|clid|mc_eid/i.test(v)), "not even in the address the buyer goes back to");
  assert.equal(forms[0].get("cancel_url"), "https://www.flash-app.dev/p/cake-1#/shop", "only the page and its #/route, so no other tool's click ID goes either");

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
  await site("track-1", "u1", ["booking", "plan-chosen", "menu-opened", "survey", "after-the-cut"]);
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
    assert.equal((await track("booking\nPlan-Chosen\ncall-us-now\ncheckout\norder-1234567\n" + "a1b2c3d4e5f6a7b8\nnot ok\n" + "x".repeat(41))).status, 204);
    await afterwards();
  } finally {
    client.execute = execute;
  }
  assert.equal(lists, 1, "one write to the person's list for the whole request");
  assert.deepEqual(
    await appSteps(),
    [
      ["app:booking", "", "", "", 1],
      ["app:plan-chosen", "", "", "", 1],
    ],
    "call-us-now isn't in the app's code",
  );
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
  // More names than one page can have (10), as when the app is changed during the day.
  await site("names-1", "u1", [..."123456789", "10", "11"].map((i) => `n${i}`).concat(["m1", "m2", "m3", "m4", "m5", "z1"]));
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
    await countSteps("names-1", match, ["app:z1"], at);
  } finally {
    client.execute = execute;
    client.batch = batch;
  }
  assert.equal(sent, 0, "a person who used their 15 tries costs nothing more past the match");
  // Their form, sign-up and checkout still count: the tries are for the app's own names.
  await step(1, ["z1"]);
  await countSteps("names-1", await matchVisit("names-1", call("names-1", "inbox", { headers: { "x-forwarded-for": ip(1) } }), at), ["app:z1", "form"], at);
  await countSteps("names-1", await matchVisit("names-1", call("names-1", "shop", { headers: { "x-forwarded-for": ip(1) } }), at), ["checkout"], at);
  assert.deepEqual(
    (await all<{ step: string; n: number }>("SELECT step, n FROM site_events WHERE site_slug = 'names-1' AND step IN ('form', 'checkout', 'app:z1') ORDER BY step")).map((r) => [
      r.step,
      Number(r.n),
    ]),
    [
      ["checkout", 1],
      ["form", 1],
    ],
  );

  // The owner's daily app steps, here 3, across all their apps; built-in steps still count.
  visitTests.freePeople = 3;
  try {
    forgetServerMemory();
    await site("budget-1", "u2", ["a", "b"]);
    await site("budget-2", "u2", ["c", "d"]);
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

test("a paid owner whose apps reach the free number of app steps within one request counts them all, with no limit note", async () => {
  visitTests.freePeople = 3;
  const { PLAN_PEOPLE } = await import("../src/lib/server/visits.ts");
  const pro = PLAN_PEOPLE.pro;
  PLAN_PEOPLE.pro = 100;
  try {
    forgetServerMemory();
    await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('pro1', 'pro1@x.co', 'h', 0, 1)");
    await run(
      `INSERT INTO subscriptions (id, user_id, plan, interval, status, amount_cents, anchor, paid_until, test, created_at, updated_at)
       VALUES ('sub-pro1', 'pro1', 'pro', 'month', 'active', 100, 0, ?, 1, 0, 0)`,
      [Date.UTC(2100, 0, 1)],
    );
    await site("cross-1", "pro1", ["a", "b", "c", "d"]);
    const at = Date.now();
    await recordVisit("cross-1", page("cross-1", { "x-forwarded-for": "10.2.0.1" }), null, at);
    const on = () => matchVisit("cross-1", call("cross-1", "track", { headers: { "x-forwarded-for": "10.2.0.1" } }), at);
    await countSteps("cross-1", await on(), ["app:a", "app:b", "app:c", "app:d"], at);
    const rows = (await events("cross-1")).map((e) => [e.step, e.n]);
    assert.deepEqual(rows, [
      ["app:a", 1],
      ["app:b", 1],
      ["app:c", 1],
      ["app:d", 1],
    ]);
    assert.equal((await funnelStats("cross-1", 30, at))!.stepsPaused.length, 0, "no note saying their steps stopped at the free number");
  } finally {
    visitTests.freePeople = 0;
    PLAN_PEOPLE.pro = pro;
  }
});

test("app steps sent at once by many people stay within the owner's daily number", async () => {
  visitTests.freePeople = 5;
  try {
    forgetServerMemory();
    await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('par1', 'par1@x.co', 'h', 0, 1)");
    await site("par-1", "par1", ["a", "b"]);
    const at = Date.now();
    const ip = (i: number) => `10.3.${i}.1`;
    for (let i = 0; i < 5; i++) await recordVisit("par-1", page("par-1", { "x-forwarded-for": ip(i) }), null, at);
    const matches = await Promise.all(Array.from({ length: 5 }, (_, i) => matchVisit("par-1", call("par-1", "track", { headers: { "x-forwarded-for": ip(i) } }), at)));
    await Promise.all(matches.map((m) => countSteps("par-1", m, ["app:a", "app:b"], at)));
    const counted = await n("SELECT COALESCE(SUM(n), 0) AS n FROM site_events WHERE site_slug = 'par-1' AND step LIKE 'app:%'");
    assert.equal(counted, 5, "5 people sending 2 steps each at once count the owner's 5");
    assert.ok((await n("SELECT steps AS n FROM owner_people WHERE user_id = 'par1'")) >= 5, "the owner's count says their day is used up");
    const f = (await funnelStats("par-1", 30, at))!;
    assert.equal(f.stepsPausedToday, 5);
  } finally {
    visitTests.freePeople = 0;
  }
});

test("only the names written out in the app's code count, so a stranger can't fill the app's day with others", async () => {
  forgetServerMemory();
  const { publishSite } = await import("../src/lib/server/sites.ts");
  await run("DELETE FROM rate_limits");
  const published = await publishSite({ id: "u3", email: "q@x.co", name: "", verified_at: 1 } as never, {
    title: "Bookings",
    html: `<button onclick="flashDB.track('booking-started')">Book</button><script>flashDB.track("Plan-Chosen"); flashDB.track(\`viewed-\${x}\`)</script>`,
  });
  assert.ok("slug" in published, JSON.stringify(published));
  const slug = published.slug;
  assert.equal((await one<{ step_names: string }>("SELECT step_names FROM sites WHERE slug = ?", [slug]))?.step_names, '["booking-started","plan-chosen"]');
  const track = (ip: string, body: string) =>
    trackRoute.POST(call(slug, "track", { headers: { "content-type": "text/plain", "x-forwarded-for": ip }, body }), ctx(slug));
  // A stranger: one visit, then ten made-up names.
  await recordVisit(slug, page(slug, { "x-forwarded-for": "6.6.6.6" }));
  await track("6.6.6.6", Array.from({ length: 10 }, (_, i) => `call-us-now-${"abcdefghij"[i]}`).join("\n"));
  await afterwards();
  for (let i = 1; i <= 3; i++) {
    await recordVisit(slug, page(slug, { "x-forwarded-for": `10.4.0.${i}` }));
    await track(`10.4.0.${i}`, "booking-started");
    await afterwards();
  }
  assert.deepEqual((await funnelStats(slug, 30))!.appSteps, [{ step: "booking-started", people: 3 }]);
  assert.deepEqual(
    (await all<{ name: string }>("SELECT name FROM site_step_names WHERE site_slug = ?", [slug])).map((r) => r.name),
    ["booking-started"],
  );
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

// The funnel's numbers, from daily totals put in by hand, on a fixed day.
const NOW = Date.UTC(2026, 9, 20, 12);
const D0 = "2026-10-20";
const D1 = "2026-10-19";
const D40 = "2026-09-10";
const since = async (day: string) => {
  await run("INSERT INTO settings (key, value) VALUES ('funnel_since', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [day]);
  forgetServerMemory();
};
const event = (slug: string, day: string, step: string, source: string, n: number, medium = "", campaign = "") =>
  run("INSERT INTO site_events (site_slug, day, step, source, medium, campaign, n) VALUES (?, ?, ?, ?, ?, ?, ?)", [slug, day, step, source, medium, campaign, n]);
const revenue = (slug: string, day: string, source: string, currency: string, orders: number, amount: number, medium = "", campaign = "") =>
  run("INSERT INTO site_revenue (site_slug, day, source, medium, campaign, currency, orders, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    slug,
    day,
    source,
    medium,
    campaign,
    currency,
    orders,
    amount,
  ]);
let orders = 0;
const order = (slug: string, at: number, currency: string, amount: number) =>
  run("INSERT INTO site_orders (session_id, site_slug, item, quantity, amount, currency, created_at) VALUES (?, ?, 'Loaf', 1, ?, ?, ?)", [
    `cs_f${++orders}`,
    slug,
    amount,
    currency,
    at,
  ]);
const zeroCounts = { visitors: 0, form: 0, signup: 0, checkout: 0, orders: 0, revenue: [] };

test("the funnel adds up each step for people matched to a visit, per source with campaigns, and every paid order per currency", async () => {
  await since("2026-08-01");
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('u4', 'r@x.co', 'h', 0, 1)");
  await site("fun-1", "u4");
  await run("INSERT INTO site_domains (domain, site_slug, user_id, created_at) VALUES ('crumbfunnel.com', 'fun-1', 'u4', 0)");
  await event("fun-1", D0, "visit", "google.com", 100);
  await event("fun-1", D1, "visit", "google.com", 140);
  await event("fun-1", D0, "visit", "newsletter", 60, "email", "spring-sale");
  await event("fun-1", D1, "visit", "newsletter", 28);
  await event("fun-1", D0, "visit", "", 201);
  await event("fun-1", D0, "visit", "(other)", 5);
  for (let i = 1; i <= 10; i++) await event("fun-1", D0, "visit", `s${i}`, i);
  // People counted before B2: in Visitors, under no source.
  await event("fun-1", D1, "visit-old", "", 7);
  await event("fun-1", D40, "visit", "google.com", 50);
  await event("fun-1", D0, "form", "google.com", 6);
  await event("fun-1", D0, "form", "newsletter", 4, "email", "spring-sale");
  await event("fun-1", D0, "form", "?", 5);
  await event("fun-1", D1, "signup", "google.com", 2);
  await event("fun-1", D0, "signup", "newsletter", 3, "email", "spring-sale");
  await event("fun-1", D0, "checkout", "google.com", 3);
  await event("fun-1", D0, "checkout", "?", 2);
  await event("fun-1", D0, "app:booking", "", 31);
  await event("fun-1", D1, "app:menu-open", "", 12);
  await event("fun-1", D1, "capped", "", 10_000);
  await event("fun-1", D1, "capped-app", "", 10_000);
  await event("fun-1", D0, "capped-net", "", 100);
  await revenue("fun-1", D0, "google.com", "usd", 1, 2900);
  await revenue("fun-1", D0, "newsletter", "usd", 2, 5800, "email", "spring-sale");
  await revenue("fun-1", D1, "newsletter", "eur", 1, 1000, "email", "spring-sale");
  for (const [amount, currency] of [[2900, "usd"], [2900, "usd"], [2900, "usd"], [1200, "usd"], [1000, "eur"]] as const) await order("fun-1", NOW - 3600_000, currency, amount);
  await order("fun-1", Date.parse(`${D40}T10:00:00Z`), "usd", 500);

  const f = (await funnelStats("fun-1", 30, NOW))!;
  assert.deepEqual([f.days, f.today, f.from, f.shownDays], [30, D0, "2026-09-21", 30]);
  // Visitors as the tile counts them, for the same days.
  assert.equal(f.totals.visitors, 100 + 140 + 60 + 28 + 201 + 5 + 55 + 7);
  assert.equal(f.totals.visitors, (await visitStats("fun-1", NOW)).visitors, "the same number as the Visitors tile");
  // Steps count matched people only; sends nobody matched are their own row, never added in.
  assert.deepEqual(
    { form: f.totals.form, signup: f.totals.signup, checkout: f.totals.checkout, orders: f.totals.orders, revenue: f.totals.revenue },
    { form: 10, signup: 5, checkout: 3, orders: 5, revenue: [{ currency: "usd", amount: 9900 }, { currency: "eur", amount: 1000 }] },
  );
  assert.deepEqual(f.unmatched, { form: 5, signup: 0, checkout: 2, orders: 1, revenue: [{ currency: "usd", amount: 1200 }] }, "paid minus what sources took, per currency");
  assert.deepEqual(
    f.sources.map((s) => s.source),
    ["google.com", "", "newsletter", "s10", "s9", "s8", "s7", "s6", "s5", "s4"],
    "the 10 with the most visitors",
  );
  assert.deepEqual(f.sources[0], { source: "google.com", visitors: 240, form: 6, signup: 2, checkout: 3, orders: 1, revenue: [{ currency: "usd", amount: 2900 }], campaigns: [] });
  assert.deepEqual(f.sources[2], {
    source: "newsletter",
    visitors: 88,
    form: 4,
    signup: 3,
    checkout: 0,
    orders: 3,
    revenue: [{ currency: "usd", amount: 5800 }, { currency: "eur", amount: 1000 }],
    campaigns: [{ medium: "email", campaign: "spring-sale", visitors: 60, form: 4, signup: 3, checkout: 0, orders: 3, revenue: [{ currency: "usd", amount: 5800 }, { currency: "eur", amount: 1000 }] }],
  });
  assert.deepEqual(f.rest, { ...zeroCounts, visitors: 3 + 2 + 1 + 5 }, "the others, (other) among them, and never the old count");
  assert.ok(!f.sources.some((s) => s.source === "?" || s.source === "(other)"));
  assert.deepEqual(f.appSteps, [{ step: "booking", people: 31 }, { step: "menu-open", people: 12 }]);
  assert.deepEqual([f.paused, f.stepsPaused, f.netCapped], [[{ day: D1, people: 10_000 }], [{ day: D1, steps: 10_000 }], 100]);
  assert.deepEqual([f.pausedToday, f.stepsPausedToday, f.free], [null, null, false], "the owner's day isn't at the limit");
  assert.deepEqual(f.addresses, ["https://www.flash-app.dev/p/fun-1", "https://crumbfunnel.com/"]);

  // 7 and 90 days; anything else asks for 30.
  const week = (await funnelStats("fun-1", 7, NOW))!;
  assert.deepEqual([week.from, week.shownDays, week.totals.visitors], ["2026-10-14", 7, f.totals.visitors]);
  const quarter = (await funnelStats("fun-1", 90, NOW))!;
  assert.deepEqual([quarter.from, quarter.sources[0].visitors, quarter.totals.orders], ["2026-08-01", 290, 6], "from the day counting began");
  assert.equal(quarter.shownDays, 81);
  assert.deepEqual(["7", "30", "90", 90, "14", "abc", null, undefined].map(funnelRange), [7, 30, 90, 90, 30, 30, 30, 30]);
  assert.equal(await funnelStats("nobody-1", 30, NOW), null);
});

test("the funnel starts on the day counting began, or the app's first day, and never shows the days before as zeros", async () => {
  await site("fun-2", "u4");
  await event("fun-2", D0, "visit", "", 4);
  await since(D0);
  // On the deploy day, the morning's people (counted the old way) are in Visitors, under no source.
  await run("INSERT INTO site_visitors (site_slug, day, visitor) VALUES ('fun-2', ?, 'old-a'), ('fun-2', ?, 'old-b')", [D0, D0]);
  const deploy = (await funnelStats("fun-2", 30, NOW))!;
  assert.deepEqual([deploy.from, deploy.shownDays, deploy.totals.visitors], [D0, 1, 6]);
  assert.equal(deploy.totals.visitors, (await visitStats("fun-2", NOW)).days.at(-1)!.visitors, "the tile's today, the deploy day included");
  assert.deepEqual(
    deploy.sources.map((s) => [s.source, s.visitors]),
    [["", 4]],
    "the old count is under no source, not even Direct",
  );
  await since("2026-10-15");
  assert.deepEqual([(await funnelStats("fun-2", 30, NOW))!.from, (await funnelStats("fun-2", 30, NOW))!.shownDays], ["2026-10-15", 6]);
  await run("UPDATE sites SET created_at = ? WHERE slug = 'fun-2'", [Date.UTC(2026, 9, 18, 15)]);
  const young = (await funnelStats("fun-2", 7, NOW))!;
  assert.deepEqual([young.from, young.shownDays], ["2026-10-18", 3]);
});

test("today's limit notes come from the owner's count across their apps, and their plan is read only past the free number", async () => {
  visitTests.freePeople = 3;
  try {
    await since("2026-08-01");
    await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('u5', 's@x.co', 'h', 0, 1)");
    await site("fun-3", "u5");
    await site("fun-3b", "u5");
    await run("INSERT INTO owner_people (user_id, day, people, steps) VALUES ('u5', ?, 2, 0)", [D0]);
    const client = await db();
    const execute = client.execute.bind(client);
    const read: string[] = [];
    client.execute = ((s: { sql: string } | string, ...rest: unknown[]) => {
      read.push(typeof s === "string" ? s : s.sql);
      return (execute as (...a: unknown[]) => unknown)(s, ...rest);
    }) as typeof client.execute;
    try {
      const below = (await funnelStats("fun-3", 30, NOW))!;
      assert.deepEqual([below.pausedToday, below.stepsPausedToday, below.free], [null, null, false]);
    } finally {
      client.execute = execute;
    }
    assert.ok(!read.some((sql) => /subscriptions|FROM users/.test(sql)), "no plan read below the free number");

    // At the free number: paused today on every app of theirs, with the upgrade note.
    await run("UPDATE owner_people SET people = 3 WHERE user_id = 'u5'");
    await event("fun-3", D0, "capped", "", 3);
    for (const slug of ["fun-3", "fun-3b"]) {
      const f = (await funnelStats(slug, 30, NOW))!;
      assert.deepEqual([f.pausedToday, f.stepsPausedToday, f.free], [3, null, true], slug);
    }
    assert.deepEqual((await funnelStats("fun-3", 30, NOW))!.paused, [{ day: D0, people: 3 }], "the app's own mark, which the note for today stands for");
    await run("UPDATE owner_people SET steps = 3 WHERE user_id = 'u5'");
    assert.equal((await funnelStats("fun-3b", 30, NOW))!.stepsPausedToday, 3);

    // A paid plan counts more: not paused, and no upgrade note.
    await run(
      `INSERT INTO subscriptions (id, user_id, plan, interval, status, amount_cents, anchor, paid_until, test, created_at, updated_at)
       VALUES ('sub-u5', 'u5', 'pro', 'month', 'active', 100, 0, ?, 1, 0, 0)`,
      [Date.UTC(2100, 0, 1)],
    );
    forgetServerMemory();
    const paid = (await funnelStats("fun-3", 30, NOW))!;
    assert.deepEqual([paid.pausedToday, paid.stepsPausedToday, paid.free], [null, null, false]);
  } finally {
    visitTests.freePeople = 0;
  }
});

test("only the owner reads an app's funnel, at most 120 times an hour", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('u6', 't@x.co', 'h', 0, 1)");
  await site("fun-4", "u6");
  const cookie = (await createSession("u6", true)).split(";")[0];
  const get = (slug: string, query = "") =>
    funnelRoute.GET(new Request(`https://www.flash-app.dev/api/sites/${slug}/funnel${query}`, { headers: { cookie } }), ctx(slug));
  const week = await get("fun-4", "?days=7");
  assert.equal(week.status, 200);
  assert.equal(((await week.json()) as { days: number }).days, 7);
  assert.equal(((await (await get("fun-4", "?days=365")).json()) as { days: number }).days, 30);
  assert.equal((await get("fun-1")).status, 404, "another owner's app");
  assert.equal((await funnelRoute.GET(new Request("https://www.flash-app.dev/api/sites/fun-4/funnel"), ctx("fun-4"))).status, 401);
  funnelTests.calls = 5;
  try {
    // Three calls so far this hour (a refused one counts too).
    assert.equal((await get("fun-4")).status, 200, "the 4th call this hour");
    assert.equal((await get("fun-4")).status, 200, "the 5th");
    const over = await get("fun-4");
    assert.equal(over.status, 429, "the 6th");
    assert.equal(((await over.json()) as { error: string }).error, "Too many requests. Try again in an hour.");
  } finally {
    funnelTests.calls = 0;
  }
});
