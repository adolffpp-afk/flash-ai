import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { register } from "node:module";

/*
 * Google PageSpeed Insights for a published app: only addresses Flash makes itself are tested, the key
 * (when set) goes in a header, results are kept per version and address for a day, each owner and each
 * app is limited, Google refusing stops the checks for a while, and nothing is ever charged.
 */
register("./support/route-hooks.mjs", import.meta.url);
process.env.DATABASE_URL = ":memory:";
process.env.FLASH_ADMIN_EMAILS = "";
process.env.FLASH_APP_URL = "https://www.flash-app.dev";
process.env.VERCEL_API_BASE_URL = "https://vercel.test";
process.env.VERCEL_API_TOKEN = "t";
process.env.VERCEL_PROJECT_ID = "flash-ai";
delete process.env.PAGESPEED_API_KEY;
delete process.env.FLASH_PAGESPEED_DAILY_REQUESTS;
delete process.env.FLASH_TEST_PAGESPEED_URL;

const { all, db, one, run } = await import("../src/lib/server/db.ts");
const { pagespeedKeyProblem, runLock, runPageSpeed, REFUSED } = await import("../src/lib/server/pagespeed.ts");
const { adminStats } = await import("../src/lib/server/admin-stats.ts");
const { countOf, overLimit } = await import("../src/lib/server/limits.ts");
const { FETCHERS_URL } = await import("../src/lib/server/lighthouse.ts");
const { cachePut } = await import("../src/lib/server/source-fetch.ts");
const route = await import("../src/app/api/sites/[slug]/pagespeed/route.ts");
const seoRoute = await import("../src/app/api/sites/[slug]/seo/route.ts");
const aiRoute = await import("../src/app/api/sites/[slug]/ai/route.ts");
const { labBand, timeLabel } = await import("../src/lib/seo-band.ts");

const GOOGLE = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const KEY = `AIza${"Sy0_k-".repeat(5)}abcde`;
const REFUSAL = readFileSync(new URL("./fixtures/pagespeed-refused.json", import.meta.url), "utf8");
const HOUR = 3_600_000;

/** What Google answers for one strategy: scores, its lab numbers, real visitors' numbers, and a screenshot that is never kept. */
function result(strategy: string, overrides: { runtimeError?: unknown; originFallback?: boolean } = {}) {
  const phone = strategy === "MOBILE";
  return {
    loadingExperience: {
      id: "https://www.flash-app.dev/p/x",
      metrics: {
        LARGEST_CONTENTFUL_PAINT_MS: { percentile: phone ? 2900 : 1400, category: phone ? "AVERAGE" : "FAST" },
        INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: "FAST" },
        CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 31, category: "SLOW" },
        FIRST_INPUT_DELAY_MS: { percentile: 9, category: "FAST" },
      },
      ...(overrides.originFallback && { origin_fallback: true }),
      overall_category: "AVERAGE",
    },
    lighthouseResult: {
      ...(overrides.runtimeError ? { runtimeError: overrides.runtimeError } : {}),
      categories: {
        performance: { id: "performance", score: phone ? 0.734 : 0.98, auditRefs: [{ id: "largest-contentful-paint", weight: 25 }] },
        accessibility: { id: "accessibility", score: 0.91 },
        "best-practices": { id: "best-practices", score: 1 },
        seo: { id: "seo", score: phone ? null : 0.9 },
      },
      audits: {
        "largest-contentful-paint": { numericValue: phone ? 3123.4 : 812.9, displayValue: "3.1 s" },
        "cumulative-layout-shift": { numericValue: 0.042 },
        "total-blocking-time": { numericValue: phone ? 410 : 20 },
        "first-contentful-paint": { numericValue: phone ? 1820 : 610 },
        "final-screenshot": { details: { data: `data:image/jpeg;base64,${"A".repeat(50_000)}` } },
      },
    },
  };
}

type Reply = { status: number; body: string } | "never" | Promise<{ status: number; body: string }>;
const ok = (strategy: string) => ({ status: 200, body: JSON.stringify(result(strategy)) });
let googleReply: (strategy: string) => Reply = ok;
const google: { url: URL; key: string | null }[] = [];
const elsewhere: string[] = [];
// What Vercel says about each domain: connected, or its DNS leading somewhere else.
const vercel: Record<string, boolean> = { "crumb.pt": true, "www.crumb.pt": true, "lapsed.pt": false };
// While a press is answered (see check): each request to Vercel, and each statement that writes to the database.
let watching = false;
let vercelCalls = 0;
let writes = 0;
const client = await db();
const execute = client.execute.bind(client) as unknown as (stmt: { sql: string }) => ReturnType<typeof client.execute>;
client.execute = ((stmt: { sql: string }) => {
  if (watching && /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(stmt.sql)) writes++;
  return execute(stmt);
}) as unknown as typeof client.execute;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.href.startsWith(GOOGLE)) {
    const headers = new Headers(init?.headers);
    google.push({ url, key: headers.get("x-goog-api-key") });
    const reply = googleReply(url.searchParams.get("strategy") ?? "");
    if (reply === "never") {
      // A request's timeout doesn't keep Node running by itself, so this does until it fires.
      const alive = setTimeout(() => {}, 60_000);
      return new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(alive);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        }),
      );
    }
    const { status, body } = await reply;
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }
  // Google's list of its user-triggered fetchers' addresses (see lighthouse.ts).
  if (url.href === FETCHERS_URL) return Response.json({ prefixes: [{ ipv4Prefix: "66.102.9.32/27" }, { ipv4Prefix: "66.249.81.64/27" }] });
  if (url.origin === "https://vercel.test") {
    if (watching) vercelCalls++;
    const domain = Object.keys(vercel).find((d) => url.pathname.includes(`/${d}`));
    if (!domain) return Response.json({ error: { code: "not_found" } }, { status: 404 });
    if (url.pathname.endsWith("/config")) return Response.json({ misconfigured: !vercel[domain] });
    return Response.json({ verified: true });
  }
  elsewhere.push(url.href);
  throw new Error(`unexpected fetch: ${url.href}`);
}) as typeof fetch;

/** A confirmed user with a session and a published app of theirs, at version 1000. */
async function owner(id: string, domains: string[] = []) {
  const token = `tok_${id}`;
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES (?, ?, 'x', 0, 1)", [id, `${id}@example.com`]);
  await run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [createHash("sha256").update(token).digest("hex"), id, Date.now() + 3600_000]);
  const slug = `crumb-${id}`;
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES (?, ?, 'Golden Crumb', '<!doctype html><title>Golden Crumb</title><h1>Bread</h1>', 0, 1000)", [
    slug,
    id,
  ]);
  for (const [i, domain] of domains.entries()) await run("INSERT INTO site_domains (domain, site_slug, user_id, created_at) VALUES (?, ?, ?, ?)", [domain, slug, id, i]);
  return { id, slug, cookie: `flash_session=${token}` };
}
type Owner = Awaited<ReturnType<typeof owner>>;

/**
 * The owner presses Check with Google. Each press starts with Flash's 3 requests a second to Google
 * free, unless other owners' checks hold them for the next othersHoldMs.
 */
async function check(who: Owner, body: unknown = {}, slug = who.slug, othersHoldMs = 0) {
  await run("DELETE FROM rate_limits WHERE key LIKE 'source:pagespeed:%'");
  const until = Date.now() + othersHoldMs;
  for (let second = Math.floor(Date.now() / 1000); othersHoldMs > 0 && second * 1000 < until; second++) {
    await run("INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 3, ?)", [`source:pagespeed:${second}`, (second + 1) * 1000]);
  }
  watching = true;
  const res = await route.POST(
    new Request(`http://localhost/api/sites/${slug}/pagespeed`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost", cookie: who.cookie },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) } as never,
  ).finally(() => (watching = false));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { pagespeed?: Record<string, unknown>; code?: string; error?: string } };
}
const seo = async (who: Owner) =>
  (await (
    await seoRoute.GET(new Request(`http://localhost/api/sites/${who.slug}/seo`, { headers: { cookie: who.cookie } }), { params: Promise.resolve({ slug: who.slug }) } as never)
  ).json()) as { checkedAt: number; pagespeed: { for: number; url: string } | null; pagespeedStale: boolean; pagespeedAvailable: boolean; pagespeedRunning: boolean };
const saved = async (slug: string) => (await one<{ pagespeed: string }>("SELECT pagespeed FROM sites WHERE slug = ?", [slug]))!.pagespeed;
const republish = (slug: string) => run("UPDATE sites SET updated_at = updated_at + 1 WHERE slug = ?", [slug]);
const fresh = async () => {
  google.length = 0;
  googleReply = ok;
  await run("DELETE FROM source_cache");
};

test("Google is asked about the app's own address, phone and computer, with the key only in a header", async () => {
  await fresh();
  const who = await owner("req", ["www.crumb.pt", "crumb.pt"]);
  const res = await check(who, { url: "https://evil.example", address: "flash" });
  assert.equal(res.status, 200);
  assert.equal(google.length, 2);
  assert.deepEqual(google.map((c) => c.url.searchParams.get("strategy")).sort(), ["DESKTOP", "MOBILE"]);
  for (const { url, key } of google) {
    assert.equal(url.origin + url.pathname, GOOGLE);
    assert.equal(url.searchParams.get("url"), `https://www.flash-app.dev/p/${who.slug}`);
    assert.deepEqual(url.searchParams.getAll("category"), ["PERFORMANCE", "ACCESSIBILITY", "BEST_PRACTICES", "SEO"]);
    assert.equal(key, null, "no key, no header");
    assert.ok(!url.href.includes("evil.example"), "an address in the request is never used");
    assert.ok(!url.searchParams.has("key"));
  }
  assert.ok(!elsewhere.length, "nothing else was fetched");

  // On its own domain: the bare one is preferred over www.
  google.length = 0;
  process.env.PAGESPEED_API_KEY = KEY;
  const onDomain = await check(who, { address: "domain" });
  assert.equal(onDomain.status, 200);
  assert.equal(google.length, 2);
  for (const { url, key } of google) {
    assert.equal(url.searchParams.get("url"), "https://crumb.pt/");
    assert.equal(key, KEY, "the key goes in X-goog-api-key");
    assert.ok(!url.href.includes(KEY), "never in the address");
  }
  delete process.env.PAGESPEED_API_KEY;

  // With no domain, there's nothing to check there.
  const bare = await owner("req-bare");
  assert.equal((await check(bare, { address: "domain" })).status, 400);
});

test("a domain that doesn't point at Flash isn't checked", async () => {
  await fresh();
  const who = await owner("lapsed", ["lapsed.pt"]);
  const res = await check(who, { address: "domain" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "domain_not_connected");
  assert.equal(res.body.error, "Your domain doesn't point at Flash yet, so Google can't check your app there.");
  assert.equal(google.length, 0, "Google was never asked");
  assert.equal(await saved(who.slug), "");
});

test("only the scores, Google's test numbers and real visitors' numbers are kept, and shown", async () => {
  await fresh();
  const who = await owner("trim");
  const before = Date.now();
  const res = await check(who);
  assert.equal(res.status, 200);
  const record = res.body.pagespeed as Record<string, unknown> & { mobile: { at: number }; desktop: { at: number } };
  assert.ok(Number(record.at) >= before);
  assert.equal(record.at, Math.min(record.mobile.at, record.desktop.at), "as old as its older half");
  assert.deepEqual({ ...record, at: 0, mobile: { ...record.mobile, at: 0 }, desktop: { ...record.desktop, at: 0 } }, {
    v: 1,
    at: 0,
    for: 1000,
    url: `https://www.flash-app.dev/p/${who.slug}`,
    mobile: {
      ok: true,
      at: 0,
      scores: { performance: 73, accessibility: 91, bestPractices: 100, seo: null },
      lab: { lcpMs: 3123.4, cls: 0.042, tbtMs: 410, fcpMs: 1820 },
      field: { lcp: { p75: 2900, rating: "needs" }, inp: { p75: 180, rating: "good" }, cls: { p75: 0.31, rating: "poor" } },
    },
    desktop: {
      ok: true,
      at: 0,
      scores: { performance: 98, accessibility: 91, bestPractices: 100, seo: 90 },
      lab: { lcpMs: 812.9, cls: 0.042, tbtMs: 20, fcpMs: 610 },
      field: { lcp: { p75: 1400, rating: "good" }, inp: { p75: 180, rating: "good" }, cls: { p75: 0.31, rating: "poor" } },
    },
  });
  assert.deepEqual(JSON.parse(await saved(who.slug)), record, "stored with the app");
  assert.ok((await saved(who.slug)).length < 2000, "no screenshot");
  const view = await seo(who);
  assert.deepEqual(view.pagespeed, record);
  assert.equal(view.pagespeedStale, false);
  assert.equal(view.pagespeedAvailable, true);
  assert.equal(view.pagespeedRunning, false);
  await republish(who.slug);
  assert.equal((await seo(who)).pagespeedStale, true, "from before the last update");
});

test("a check is kept a day for the same version and address", async () => {
  await fresh();
  const who = await owner("cache", ["crumb-cache.pt"]);
  vercel["crumb-cache.pt"] = true;
  assert.equal((await check(who)).status, 200);
  assert.equal(google.length, 2);
  const again = await check(who);
  assert.equal(again.body.cached, true);
  assert.equal(google.length, 2, "no new check");

  await republish(who.slug);
  assert.equal((await check(who)).body.cached, undefined);
  assert.equal(google.length, 4, "a new version is checked again");

  const record = JSON.parse(await saved(who.slug));
  await run("UPDATE sites SET pagespeed = ? WHERE slug = ?", [JSON.stringify({ ...record, at: Date.now() - 25 * HOUR }), who.slug]);
  assert.equal((await check(who)).body.cached, undefined);
  assert.equal(google.length, 6, "after a day it's checked again");

  await run("DELETE FROM rate_limits WHERE key = ?", [`pagespeed:${who.id}`]);
  const domain = await check(who, { address: "domain" });
  assert.equal(domain.body.cached, undefined, "the other address isn't answered with this one's result");
  assert.equal((domain.body.pagespeed as { url: string }).url, "https://crumb-cache.pt/");
  assert.equal(google.length, 8);
});

const thisHour = (n: number) => `You've used this hour's checks with Google (${n} an hour). Try again in an hour.`;
const today = (n: number) => `You've used today's checks with Google (${n} a day). Try again tomorrow.`;
/** The owner's hour of checks is over, as an hour on. */
const nextHour = (who: Owner) => run("UPDATE rate_limits SET reset_at = 0 WHERE key = ?", [`pagespeed:${who.id}`]);

test("without a key each owner has 3 checks an hour and 5 a day, with one 10 and 30, and a kept result uses none", async () => {
  await fresh();
  // Without a key every owner shares Flash's 200 requests a day: one owner uses at most 10 of them.
  const who = await owner("limits");
  assert.equal((await check(who)).status, 200);
  assert.equal((await check(who)).body.cached, true, "a kept result doesn't count");
  for (let i = 2; i <= 3; i++) {
    await republish(who.slug);
    assert.equal((await check(who)).status, 200, `check ${i}`);
  }
  await republish(who.slug);
  const fourth = await check(who);
  assert.equal(fourth.status, 429);
  assert.equal(fourth.body.error, thisHour(3));
  await nextHour(who);
  for (let i = 4; i <= 5; i++) {
    assert.equal((await check(who)).status, 200, `check ${i}`);
    await republish(who.slug);
  }
  await nextHour(who);
  const sixth = await check(who);
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.error, today(5));
  assert.equal(google.length, 10, "two of Google's requests a check");

  // With a key, Google gives Flash its own quota: 10 an hour and 30 a day.
  process.env.PAGESPEED_API_KEY = KEY;
  try {
    const keyed = await owner("limits-key");
    for (let hour = 1; hour <= 3; hour++) {
      for (let i = 1; i <= 10; i++) {
        await republish(keyed.slug);
        assert.equal((await check(keyed)).status, 200, `hour ${hour}, check ${i}`);
      }
      await republish(keyed.slug);
      const over = await check(keyed);
      assert.equal(over.status, 429);
      assert.equal(over.body.error, thisHour(10));
      await nextHour(keyed);
    }
    const over = await check(keyed);
    assert.equal(over.status, 429);
    assert.equal(over.body.error, today(30));
    assert.equal(google.length, 70);
  } finally {
    delete process.env.PAGESPEED_API_KEY;
  }
});

test("without a key an owner's 5 checks a day are counted by the UTC day Flash's 200 requests are counted by, so they're at most 10 of a day's", async () => {
  await fresh();
  const who = await owner("utc-day");
  await run("UPDATE sessions SET expires_at = ? WHERE user_id = ?", [Date.UTC(2100, 0, 1), who.id]);
  // The clock is set to days no other test uses: 2031-03-03 to 03-05, UTC.
  const midnight = Date.UTC(2031, 2, 4);
  const SECOND = 1000;
  const presses: [string, number, string?][] = [];
  const at = async (ms: number) => {
    mock.timers.setTime(ms);
    await republish(who.slug);
    const { status, body } = await check(who);
    const time = new Date(ms).toISOString().slice(0, 19);
    presses.push(status === 429 ? [time, status, body.error] : [time, status]);
  };
  mock.timers.enable({ apis: ["Date"], now: midnight - 3 * HOUR });
  try {
    // A check the evening before, then the day's 5 (3 in its first hour, 2 in its second), and none
    // after, also once 24 hours have passed since the evening's: only the next UTC day has more.
    for (const ms of [-3 * HOUR, SECOND, 2 * SECOND, 3 * SECOND, HOUR + 5 * SECOND, HOUR + 6 * SECOND, HOUR + 7 * SECOND, 21 * HOUR + SECOND, 24 * HOUR - SECOND, 24 * HOUR]) {
      await at(midnight + ms);
    }
  } finally {
    mock.timers.reset();
  }
  try {
    assert.deepEqual(presses, [
      ["2031-03-03T21:00:00", 200],
      ["2031-03-04T00:00:01", 200],
      ["2031-03-04T00:00:02", 200],
      ["2031-03-04T00:00:03", 200],
      ["2031-03-04T01:00:05", 200],
      ["2031-03-04T01:00:06", 200],
      ["2031-03-04T01:00:07", 429, today(5)],
      ["2031-03-04T21:00:01", 429, today(5)],
      ["2031-03-04T23:59:59", 429, today(5)],
      ["2031-03-05T00:00:00", 200],
    ]);
    const requests = await one<{ requests: number }>("SELECT requests FROM free_quota WHERE day = '2031-03-04' AND provider = 'pagespeed'");
    assert.equal(requests?.requests, 10, "one owner's checks are 10 of the day's 200");
    // The owner's counts of earlier days are cleared by their first check of a day.
    const kept = await all<{ key: string }>("SELECT key FROM rate_limits WHERE key LIKE ?", [`pagespeed-day:${who.id}:%`]);
    assert.deepEqual(
      kept.map((r) => r.key),
      [`pagespeed-day:${who.id}:2031-03-05`],
    );
  } finally {
    await run("DELETE FROM free_quota WHERE day LIKE '2031-%'");
  }
});

test("a check on the app's domain asks Vercel only when Google is about to test it, and a kept answer, a remembered failure or a press over a limit asks and writes nothing", async () => {
  await fresh();
  const who = await owner("vercel", ["count.pt"]);
  vercel["count.pt"] = true;
  /** What some presses of Check with Google on the domain cost: Vercel's and Google's requests, and the database's writes. */
  const presses = async (n: number, by = who) => {
    const [v, w, g] = [vercelCalls, writes, google.length];
    const statuses = new Set<number>();
    for (let i = 0; i < n; i++) statuses.add((await check(by, { address: "domain" })).status);
    return { vercel: vercelCalls - v, google: google.length - g, writes: writes - w, statuses: [...statuses] };
  };
  // The first: Vercel is asked once (the domain, and where its DNS leads), then Google is.
  const first = await presses(1);
  assert.deepEqual([first.vercel, first.google, first.statuses], [2, 2, [200]]);
  assert.ok(first.writes > 0);
  // Kept for the day: nothing asked or written, however often it's pressed.
  assert.deepEqual(await presses(25), { vercel: 0, google: 0, writes: 0, statuses: [200] });
  // A new version Google couldn't load: one check, then the same answer for free.
  await republish(who.slug);
  googleReply = () => ({ status: 502, body: "{}" });
  const failing = await presses(1);
  assert.deepEqual([failing.vercel, failing.google, failing.statuses], [2, 2, [502]]);
  assert.deepEqual(await presses(25), { vercel: 0, google: 0, writes: 0, statuses: [502] });
  googleReply = ok;
  // While Google refuses, and while a check of the app runs: the same.
  await run("DELETE FROM source_cache");
  await cachePut(REFUSED, 1, 60_000);
  assert.deepEqual(await presses(10), { vercel: 0, google: 0, writes: 0, statuses: [503] });
  await run("DELETE FROM source_cache");
  await overLimit(runLock(who.slug), 1, 180_000);
  assert.deepEqual(await presses(10), { vercel: 0, google: 0, writes: 0, statuses: [409] });
  await run("DELETE FROM rate_limits WHERE key = ?", [runLock(who.slug)]);
  assert.equal(await countOf(`pagespeed:${who.id}`), 2, "none of those used one of the owner's checks");
  // The owner's last check this hour, then presses over the limit: nothing asked or written.
  assert.deepEqual((await presses(1)).statuses, [200]);
  await republish(who.slug);
  assert.deepEqual(await presses(25), { vercel: 0, google: 0, writes: 0, statuses: [429] });

  // A domain that doesn't point at Flash: Google is never asked, Vercel at most 10 times an hour (each
  // time its answer is noted with the domain), and none of the owner's checks is used.
  const lapsed = await owner("vercel-lapsed", ["gone.pt"]);
  vercel["gone.pt"] = false;
  const tries = await presses(25, lapsed);
  assert.deepEqual(tries, { vercel: 20, google: 0, writes: 20, statuses: [409, 429] });
  assert.equal(await countOf(`pagespeed:${lapsed.id}`), 0);
  assert.deepEqual(await presses(25, lapsed), { vercel: 0, google: 0, writes: 0, statuses: [429] });
  // Once it points at Flash, an hour on, Google tests it.
  vercel["gone.pt"] = true;
  await run("UPDATE rate_limits SET reset_at = 0 WHERE key = ?", [`pagespeed-domain:${lapsed.id}`]);
  const connected = await presses(1, lapsed);
  assert.deepEqual([connected.vercel, connected.google, connected.statuses], [2, 2, [200]]);
});

test("waiting for a running check uses none, the app's visitors are answered meanwhile, and Flash's daily allowance holds", async () => {
  await fresh();
  // One check of an app at a time: a second press while it runs waits for it, and doesn't count.
  const other = await owner("parallel");
  let release!: () => void;
  const held = new Promise<{ status: number; body: string }>((resolve) => (release = () => resolve(ok("MOBILE"))));
  googleReply = () => held;
  const first = check(other);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await countOf(`pagespeed:${other.id}`), 1);
  assert.equal((await seo(other)).pagespeedRunning, true);
  const second = await check(other);
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "running");
  assert.equal(second.body.error, "Google is still checking this page. The result shows here when it's done.");
  assert.equal(await countOf(`pagespeed:${other.id}`), 1, "waiting used up no check");
  // Meanwhile Lighthouse opens the app like a visitor: Google's test, as its servers were seen sending
  // it, gets "not available", so the check spends nothing. A visitor on a Mac is answered as always
  // (this app's AI is off: 403).
  const askAi = (agent: string, address: string) =>
    aiRoute.POST(
      new Request(`http://localhost/api/sites/${other.slug}/ai`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": agent, "x-forwarded-for": address },
        body: JSON.stringify({ prompt: "What's fresh today?" }),
      }),
      { params: Promise.resolve({ slug: other.slug }) } as never,
    );
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
  assert.equal((await askAi(`${mac} Chrome-Lighthouse`, "66.102.9.33")).status, 503);
  assert.equal((await askAi(mac, "66.102.9.40")).status, 503, "Lighthouse's computer from Google's fetchers' addresses");
  assert.equal((await askAi(mac, "203.0.113.9")).status, 403, "a visitor on a Mac");
  release();
  assert.equal((await first).status, 200);
  assert.equal((await seo(other)).pagespeedRunning, false);
  googleReply = ok;

  // Flash's daily allowance for everyone together: then Google isn't asked, and the owner is told it's busy.
  const capped = await owner("capped");
  const used = await one<{ requests: number }>("SELECT requests FROM free_quota WHERE provider = 'pagespeed'");
  process.env.FLASH_PAGESPEED_DAILY_REQUESTS = String(used!.requests);
  google.length = 0;
  const busy = await check(capped);
  delete process.env.FLASH_PAGESPEED_DAILY_REQUESTS;
  assert.equal(busy.status, 503);
  assert.equal(busy.body.code, "busy");
  assert.equal(busy.body.error, "Google's free speed check is busy right now. Try again later.");
  assert.equal(google.length, 0);
});

test("while Flash's daily allowance can't take a press, Google is busy for everyone, and the press uses none of the owner's checks and writes nothing", async () => {
  await fresh();
  const who = await owner("busy-free");
  const day = new Date().toISOString().slice(0, 10);
  const used = (requests: number) =>
    run("INSERT INTO free_quota (day, provider, requests) VALUES (?, 'pagespeed', ?) ON CONFLICT(day, provider) DO UPDATE SET requests = excluded.requests", [day, requests]);
  const before = await one<{ requests: number }>("SELECT requests FROM free_quota WHERE day = ? AND provider = 'pagespeed'", [day]);
  const checksUsed = async () => [await countOf(`pagespeed:${who.id}`), await countOf(`pagespeed-day:${who.id}:${day}`)];
  try {
    // Without a key every owner shares 200 requests a day, all used today: pressed more often than the
    // owner's 3 checks an hour, each press is told it's busy, for free.
    await used(200);
    const w = writes;
    for (let i = 0; i < 5; i++) {
      const busy = await check(who);
      assert.equal(busy.status, 503, `press ${i + 1}`);
      assert.equal(busy.body.code, "busy");
      assert.equal(busy.body.error, "Google's free speed check is busy right now. Try again later.");
    }
    assert.equal(google.length, 0);
    assert.equal(writes - w, 0, "nothing written");
    assert.deepEqual(await checksUsed(), [0, 0]);
    // One request left: not enough for both halves.
    await used(199);
    assert.equal((await check(who)).body.code, "busy");
    assert.deepEqual(await checksUsed(), [0, 0]);
    // Enough for the one half Google couldn't do last time (once that failure is no longer remembered).
    await used(0);
    googleReply = (s) => (s === "MOBILE" ? { status: 500, body: "{}" } : ok(s));
    assert.equal((await check(who)).status, 200);
    await run("DELETE FROM source_cache WHERE key != ?", [REFUSED]);
    googleReply = ok;
    await used(199);
    assert.equal((await check(who)).status, 200);
    assert.deepEqual(google.slice(2).map((c) => c.url.searchParams.get("strategy")), ["MOBILE"]);
    assert.deepEqual(await checksUsed(), [2, 2], "only the presses Google was asked for used a check");
  } finally {
    googleReply = ok;
    await used(Number(before?.requests ?? 0));
  }
});

test("a press Flash's own limits keep from Google once it was counted gives the owner's check back: its 3 requests a second, or the day's last requests, taken by other presses", async () => {
  await fresh();
  const who = await owner("busy-back");
  const day = new Date().toISOString().slice(0, 10);
  const used = (requests: number) =>
    run("INSERT INTO free_quota (day, provider, requests) VALUES (?, 'pagespeed', ?) ON CONFLICT(day, provider) DO UPDATE SET requests = excluded.requests", [day, requests]);
  const before = await one<{ requests: number }>("SELECT requests FROM free_quota WHERE day = ? AND provider = 'pagespeed'", [day]);
  // The owner's counts this hour and today, as kept: 0 is a check counted, then given back.
  const counts = () =>
    Promise.all([`pagespeed:${who.id}`, `pagespeed-day:${who.id}:${day}`].map(async (key) => (await one<{ count: number }>("SELECT count FROM rate_limits WHERE key = ?", [key]))?.count));
  try {
    // Other owners' checks hold Flash's 3 requests a second for longer than a press waits (5 seconds).
    await used(0);
    const slots = await check(who, {}, who.slug, 7000);
    assert.deepEqual([slots.status, slots.body.code, slots.body.error], [503, "busy", "Google's free speed check is busy right now. Try again later."]);
    assert.equal(google.length, 0);
    assert.deepEqual(await counts(), [0, 0], "counted, then given back");
    // The day's last 2 requests, there when the press was counted, are taken by another press while
    // this one waits a few seconds for Flash's requests a second.
    await used(198);
    const pressing = check(who, {}, who.slug, 3000);
    while ((await counts())[0] !== 1) await new Promise((r) => setTimeout(r, 5));
    await used(200);
    const race = await pressing;
    assert.deepEqual([race.status, race.body.code], [503, "busy"]);
    assert.equal(google.length, 0);
    assert.deepEqual(await counts(), [0, 0]);
    // Then a press Google is asked for uses one, and the hour's 3 are all still there.
    await used(0);
    assert.equal((await check(who)).status, 200);
    assert.equal(google.length, 2);
    assert.deepEqual(await counts(), [1, 1]);
    for (let i = 2; i <= 3; i++) {
      await republish(who.slug);
      assert.equal((await check(who)).status, 200, `check ${i}`);
    }
  } finally {
    await used(Number(before?.requests ?? 0));
  }
});

test("Google refusing stops the checks for a while, and the view says so", async () => {
  await fresh();
  const who = await owner("refused");
  googleReply = () => ({ status: 429, body: REFUSAL });
  const refused = await check(who);
  assert.equal(refused.status, 503);
  assert.equal(refused.body.code, "quota");
  const cooldown = await one<{ expires_at: number }>("SELECT expires_at FROM source_cache WHERE key = ?", [REFUSED]);
  assert.ok(Math.abs(Number(cooldown!.expires_at) - Date.now() - 6 * HOUR) < 60_000, "six hours without a key");
  assert.equal(await saved(who.slug), "", "nothing kept");

  google.length = 0;
  const next = await check(who);
  assert.equal(next.status, 503);
  assert.equal(next.body.code, "pagespeed_unavailable");
  assert.equal(next.body.error, "Google's speed check isn't available right now. Flash's own check above still works.");
  assert.equal(google.length, 0, "Google isn't asked again");
  assert.equal((await seo(who)).pagespeedAvailable, false);

  // With a key, Google refusing is usually a burst: a short pause.
  await run("DELETE FROM source_cache");
  process.env.PAGESPEED_API_KEY = KEY;
  await republish(who.slug);
  await check(who);
  delete process.env.PAGESPEED_API_KEY;
  const short = await one<{ expires_at: number }>("SELECT expires_at FROM source_cache WHERE key = ?", [REFUSED]);
  assert.ok(Math.abs(Number(short!.expires_at) - Date.now() - 10 * 60_000) < 60_000, "ten minutes with a key");
});

test("a run Google couldn't finish shows no scores, and Flash's own numbers for the whole site are never shown as the app's", async () => {
  await fresh();
  const target = "https://www.flash-app.dev/p/bad-runs";
  googleReply = (s) => ({ status: 200, body: JSON.stringify(result(s, { runtimeError: { code: "NO_FCP", message: "The page did not paint any content." } })) });
  assert.deepEqual(await runPageSpeed(target, "mobile"), { ok: false, error: "unreachable" });

  googleReply = (s) => ({ status: 200, body: JSON.stringify(result(s, { originFallback: true })) });
  const fallback = await runPageSpeed(target, "mobile");
  assert.ok(fallback.ok);
  assert.equal(fallback.field, null, "the origin's numbers aren't this app's");
  assert.equal(fallback.scores.performance, 73);

  googleReply = () => "never";
  assert.deepEqual(await runPageSpeed(target, "mobile", { timeoutMs: 50 }), { ok: false, error: "slow" });

  googleReply = ok;
  assert.deepEqual(await runPageSpeed(target, "mobile", { maxBytes: 1000 }), { ok: false, error: "unreachable" });

  googleReply = () => ({ status: 400, body: JSON.stringify({ error: { code: 400, message: "Lighthouse returned error: FAILED_DOCUMENT_REQUEST." } }) });
  assert.deepEqual(await runPageSpeed(target, "desktop"), { ok: false, error: "unreachable" });
  googleReply = () => ({ status: 500, body: "{}" });
  assert.deepEqual(await runPageSpeed(target, "desktop"), { ok: false, error: "unreachable" });
  googleReply = () => ({ status: 200, body: "not json" });
  assert.deepEqual(await runPageSpeed(target, "desktop"), { ok: false, error: "unreachable" });
  assert.ok(!(await one("SELECT 1 FROM source_cache WHERE key = ?", [REFUSED])), "none of these stop the checks");

  // One that failed on both is answered the same for a while, without asking Google again.
  const who = await owner("failing");
  googleReply = () => ({ status: 502, body: "{}" });
  const failed = await check(who);
  assert.equal(failed.status, 502);
  assert.equal(failed.body.code, "unreachable");
  assert.equal(failed.body.error, "Google couldn't load your page this time. Try again in a few minutes.");
  google.length = 0;
  assert.equal((await check(who)).body.code, "unreachable");
  assert.equal(google.length, 0);
  // One that fails on a phone only is kept, with the computer's scores.
  await republish(who.slug);
  googleReply = (s) => (s === "MOBILE" ? "never" : ok(s));
  const half = await runPageSpeed(target, "mobile", { timeoutMs: 50 });
  assert.deepEqual(half, { ok: false, error: "slow" });
  googleReply = (s) => (s === "MOBILE" ? { status: 502, body: "{}" } : ok(s));
  const partial = await check(who);
  assert.equal(partial.status, 200);
  const record = partial.body.pagespeed as { mobile: unknown; desktop: { ok: boolean } };
  assert.deepEqual(record.mobile, { ok: false, error: "unreachable" });
  assert.equal(record.desktop.ok, true);
});

test("a check that failed on a phone only is asked again for the phone, not answered from the saved one for a day", async () => {
  await fresh();
  const who = await owner("half");
  googleReply = (s) => (s === "MOBILE" ? { status: 500, body: "{}" } : ok(s));
  const first = await check(who);
  assert.equal(first.status, 200);
  assert.deepEqual((first.body.pagespeed as { mobile: unknown }).mobile, { ok: false, error: "unreachable" });
  assert.equal(google.length, 2);
  // Right away: the same answer for a few minutes, as for a check that failed on both, without asking Google.
  googleReply = ok;
  const soon = await check(who);
  assert.equal(soon.status, 502);
  assert.equal(soon.body.code, "unreachable");
  assert.equal(google.length, 2);
  // A few minutes on: only the phone is asked again, and the computer's result is kept.
  await run("DELETE FROM source_cache WHERE key != ?", [REFUSED]);
  const desktop = JSON.parse(await saved(who.slug)).desktop;
  const again = await check(who);
  assert.equal(again.status, 200);
  assert.equal(again.body.cached, undefined, "not the saved one");
  assert.deepEqual(google.slice(2).map((c) => c.url.searchParams.get("strategy")), ["MOBILE"]);
  const record = again.body.pagespeed as { mobile: { ok: boolean }; desktop: unknown };
  assert.equal(record.mobile.ok, true);
  assert.deepEqual(record.desktop, desktop);
  assert.deepEqual(JSON.parse(await saved(who.slug)), record);
  // Both halves done: kept for the day.
  assert.equal((await check(who)).body.cached, true);
  assert.equal(google.length, 3);
});

test("a half kept while the other is asked again keeps when it was tested, and the check is kept a day from the older one", async () => {
  await fresh();
  const realNow = Date.now;
  const T0 = realNow();
  try {
    const who = await owner("restamp");
    await run("UPDATE sessions SET expires_at = ? WHERE user_id = ?", [T0 + 100 * HOUR, who.id]);
    Date.now = () => T0;
    googleReply = (s) => (s === "DESKTOP" ? { status: 500, body: "{}" } : ok(s));
    const first = (await check(who)).body.pagespeed as { at: number; mobile: { at: number } };
    assert.equal(first.mobile.at, T0);
    // 23 hours on, Google can do the computer: the phone's half says it's from 23 hours ago, and so does the check.
    Date.now = () => T0 + 23 * HOUR;
    await run("DELETE FROM source_cache WHERE key != ?", [REFUSED]);
    await run("DELETE FROM rate_limits");
    googleReply = ok;
    const again = await check(who);
    assert.deepEqual(google.slice(2).map((c) => c.url.searchParams.get("strategy")), ["DESKTOP"]);
    const record = again.body.pagespeed as { at: number; mobile: { at: number }; desktop: { at: number } };
    assert.deepEqual([record.at, record.mobile.at, record.desktop.at], [T0, T0, T0 + 23 * HOUR]);
    assert.equal((await check(who)).body.cached, true, "both halves done: kept");
    // A day after the phone was tested, both are asked again rather than answered as kept.
    Date.now = () => T0 + 25 * HOUR;
    await run("DELETE FROM rate_limits");
    const later = await check(who);
    assert.equal(later.body.cached, undefined);
    assert.deepEqual(google.slice(3).map((c) => c.url.searchParams.get("strategy")).sort(), ["DESKTOP", "MOBILE"]);
    assert.equal((later.body.pagespeed as { at: number }).at, T0 + 25 * HOUR);
    // A check saved before halves had their own time: a kept half is as old as that check.
    const old = { v: 1, at: T0, for: 1000, url: `https://www.flash-app.dev/p/${who.slug}`, mobile: { ...first.mobile, at: undefined }, desktop: { ok: false, error: "unreachable" } };
    await run("UPDATE sites SET pagespeed = ? WHERE slug = ?", [JSON.stringify(old), who.slug]);
    await run("DELETE FROM rate_limits");
    Date.now = () => T0 + 2 * HOUR;
    const mixed = (await check(who)).body.pagespeed as { at: number; mobile: { at: number } };
    assert.deepEqual([mixed.at, mixed.mobile.at], [T0, T0]);
  } finally {
    Date.now = realNow;
    googleReply = ok;
  }
});

test("Google's test numbers are banded as its report bands them: stricter on a computer than on a phone", () => {
  // Lighthouse's scoring points (p10 and median) for each device: at or under p10 is good, over the median poor.
  const said = (strategy: "mobile" | "desktop", metric: "lcp" | "fcp" | "tbt" | "cls", values: number[]) => values.map((v) => labBand(strategy, metric, v)).join(" ");
  assert.equal(said("mobile", "lcp", [2000, 2500, 3000, 4000, 4001]), "good good needs needs poor");
  assert.equal(said("desktop", "lcp", [1200, 2000, 2400, 3000]), "good needs needs poor");
  assert.equal(said("mobile", "fcp", [1500, 1800, 2200, 3001]), "good good needs poor");
  assert.equal(said("desktop", "fcp", [934, 1500, 2200]), "good needs poor");
  assert.equal(said("mobile", "tbt", [150, 200, 500, 601]), "good good needs poor");
  assert.equal(said("desktop", "tbt", [150, 200, 500]), "good needs poor");
  for (const strategy of ["mobile", "desktop"] as const) assert.equal(said(strategy, "cls", [0.05, 0.1, 0.2, 0.3]), "good good needs poor");
});

test("Google's times always show their number, in every language", () => {
  assert.deepEqual([0.98, 3.1].map((s) => timeLabel(s, "second", "en")), ["1 sec", "3.1 sec"]);
  assert.equal(timeLabel(30, "millisecond", "en"), "30 ms");
  assert.equal(timeLabel(0.5, "second", "ru"), "0,5 с");
  // Chromium writes Hebrew's short seconds without the number for one (1, and 0.1 to 0.9) and in words
  // for two, as its CLDR data has them: "שנ׳" and "שתי שנ׳". Node's data writes the number, so that's
  // what's stood in for here.
  const Real = Intl.NumberFormat;
  const Chromium = function (locale: string, options?: Intl.NumberFormatOptions) {
    const real = new Real(locale, options);
    if (locale !== "he" || options?.unit !== "second") return real;
    const plain = new Real("he", { maximumFractionDigits: options.maximumFractionDigits });
    const parts = (n: number): Intl.NumberFormatPart[] =>
      n === 2 ? [{ type: "unit", value: "שתי שנ׳" }] : n === 1 || (n > 0 && n < 1) ? [{ type: "unit", value: "שנ׳" }] : [...plain.formatToParts(n), { type: "literal", value: " " }, { type: "unit", value: "שנ׳" }];
    return { formatToParts: parts, format: (n: number) => parts(n).map((p) => p.value).join("") } as unknown as Intl.NumberFormat;
  } as unknown as typeof Intl.NumberFormat;
  Intl.NumberFormat = Chromium;
  try {
    assert.equal(new Intl.NumberFormat("he", { style: "unit", unit: "second", unitDisplay: "short", maximumFractionDigits: 1 }).format(0.98), "שנ׳", "the stand-in");
    assert.deepEqual([0.98, 0.52, 1, 2, 3.1, 12].map((s) => timeLabel(s, "second", "he")), ["1 שנ׳", "0.5 שנ׳", "1 שנ׳", "2 שנ׳", "3.1 שנ׳", "12 שנ׳"]);
    assert.equal(timeLabel(30, "millisecond", "he"), "30 ms");
  } finally {
    Intl.NumberFormat = Real;
  }
});

test("the key never shows in the logs or in what's kept", async () => {
  await fresh();
  process.env.PAGESPEED_API_KEY = KEY;
  const logged: string[] = [];
  const { error, warn } = console;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  try {
    const who = await owner("secret");
    googleReply = (s) => (s === "MOBILE" ? { status: 500, body: JSON.stringify({ error: { message: `bad key ${KEY}` } }) } : ok(s));
    assert.equal((await check(who)).status, 200);
    await runPageSpeed("https://www.flash-app.dev/p/x", "desktop", { timeoutMs: 1, maxBytes: 10 });
    assert.ok(logged.length >= 1, "the failure is logged");
    assert.ok(logged.every((line) => !line.includes("AIza") && !line.includes("googleapis")), logged.join("\n"));
    assert.ok(!(await saved(who.slug)).includes("AIza"));
  } finally {
    console.error = error;
    console.warn = warn;
    delete process.env.PAGESPEED_API_KEY;
  }
});

test("the owner dashboard lists PageSpeed Insights, with its uses and any problem with its key", async () => {
  assert.equal(pagespeedKeyProblem({}), "");
  assert.equal(pagespeedKeyProblem({ PAGESPEED_API_KEY: KEY }), "");
  assert.equal(KEY.length, 39);
  assert.match(pagespeedKeyProblem({ PAGESPEED_API_KEY: "AIzaTooShort" }), /39-character key/);
  assert.match(pagespeedKeyProblem({ PAGESPEED_API_KEY: `xyz${KEY.slice(3)}` }), /starts with AIza/);
  const body = JSON.parse(JSON.stringify(await adminStats(30)));
  const row = body.byProvider.find((p: { id: string }) => p.id === "pagespeed");
  assert.ok(row);
  assert.deepEqual([row.provider, row.free, row.noKey, row.setUp], ["PageSpeed Insights", true, true, true]);
  const sent = await one<{ n: number }>("SELECT COALESCE(SUM(requests), 0) AS n FROM free_quota WHERE provider = 'pagespeed'");
  assert.ok(Number(sent?.n) > 0);
  assert.equal(row.requests, Number(sent?.n), "its uses are the requests Flash sent");
  process.env.PAGESPEED_API_KEY = "nope";
  const wrong = JSON.parse(JSON.stringify(await adminStats(30))).byProvider.find((p: { id: string }) => p.id === "pagespeed");
  delete process.env.PAGESPEED_API_KEY;
  assert.equal(wrong.setUp, false);
  assert.match(wrong.missing[0], /PAGESPEED_API_KEY must be/);
});

test("checking with Google never charges anything", async () => {
  await fresh();
  const who = await owner("free");
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, 300, 'grant', 0)", [who.id]);
  const total = async () => Number((await one<{ b: number }>("SELECT COALESCE(SUM(amount), 0) AS b FROM credit_ledger"))?.b);
  const before = await total();
  await check(who);
  await check(who);
  await republish(who.slug);
  googleReply = () => ({ status: 500, body: "{}" });
  await check(who);
  await seo(who);
  assert.equal(await total(), before);
});
