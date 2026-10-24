import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * Translate a website: the page made safe to keep, the bar on top, and the paid flow with its free
 * copy within a day. A stand-in Claude answers each numbered phrase with "FR:" before it.
 */
let sent = 0;
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    sent++;
    const body = JSON.parse(raw || "{}") as { messages?: { content: string }[] };
    const message = body.messages?.[0]?.content ?? "";
    const text = message.split("\n").map((l) => l.replace(/^(\d+)\t/, "$1\tFR:")).join("\n");
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        id: "m",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 500, output_tokens: 300 },
      }),
    );
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

process.env.DATABASE_URL = ":memory:";
process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const { staticPage, pageTitle, framedPage, ownedPage } = await import("../src/lib/page-translate.ts");
const { pagePhrases } = await import("../src/lib/site-translate.ts");
const { siteLanguage } = await import("../src/lib/site-languages.ts");
const { run, one } = await import("../src/lib/server/db.ts");
const { fetchPage, translateFetchedPage, translatedPage, recentPages, importFetchedPage } = await import("../src/lib/server/page-translations.ts");
const { balance, ensureMonthlyCredits } = await import("../src/lib/server/credits.ts");
const { GET } = await import("../src/app/t/[id]/route.ts");

const PAGE = `<!doctype html><html lang="en"><head><base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example"><title>City Library</title></head>
<body><h1>Opening hours</h1><p>We are open every day.</p><a href="/books">Our books</a>
<script>document.title="Hacked";alert("Welcome back!")</script><noscript>Turn on scripts</noscript></body></html>`;

test("a fetched page keeps its words but none of its scripts, base or refresh", () => {
  const html = staticPage(PAGE);
  assert.doesNotMatch(html, /<script|evil\.example|http-equiv/i);
  assert.equal(pageTitle(html), "City Library");
  assert.deepEqual(pagePhrases(html), ["City Library", "Opening hours", "We are open every day.", "Our books", "Turn on scripts"]);
});

test("the copy opens links on the original site and says where it came from", () => {
  const html = framedPage(staticPage(PAGE), "https://library.example/home", { said: "Translated by Flash.", original: "See the original" });
  assert.match(html, /<head><base href="https:\/\/library\.example\/home" target="_blank">/);
  assert.match(html, /Translated by Flash\./);
  assert.match(html, /href="https:\/\/library\.example\/home"[^>]*>See the original</);
  assert.ok(html.indexOf("Translated by Flash.") > html.indexOf("<body>"), "the bar is inside the body");
});

test("links to Flash's own network, or that aren't links, are refused before anything is sent", async () => {
  for (const link of ["", "   ", 5, "http://127.0.0.1/admin", "https://localhost/", "https://10.0.0.1/", "ftp://x.example/a", "javascript:alert(1)"]) {
    const got = await fetchPage(link);
    assert.ok("error" in got && ["link", "fetch"].includes(got.error), String(link));
  }
});

test("translating a page holds, charges what it used, and the same page today is free", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('u1', 'o@x.co', 'h', 0, 1)");
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES ('u1', 1000, 'test', 0)");
  const html = staticPage(PAGE);
  const page = { url: "https://library.example/home", html, title: pageTitle(html), phrases: pagePhrases(html), from: siteLanguage("en") };
  const t = (s: string, b?: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(b?.[k] ?? ""));

  assert.deepEqual(await translateFetchedPage({ id: "u1" }, page, "xx", t), { error: "language" });
  assert.deepEqual(await translateFetchedPage({ id: "u1" }, page, "en", t), { error: "same" });

  const before = await balance("u1");
  const done = await translateFetchedPage({ id: "u1" }, page, "fr", t);
  assert.ok(!("error" in done));
  assert.equal(done.title, "FR:City Library");
  assert.ok(done.credits >= 1);
  assert.equal(await balance("u1"), before - done.credits);

  const kept = await translatedPage(done.id);
  assert.ok(kept);
  assert.match(kept, /FR:Opening hours/);
  assert.match(kept, /<html lang="fr"/);
  assert.match(kept, /Translated into Français \(French\) by Flash\./);

  const calls = sent;
  const again = await translateFetchedPage({ id: "u1" }, page, "fr", t);
  assert.ok(!("error" in again));
  assert.deepEqual([again.id, again.credits, sent], [done.id, 0, calls], "the copy from earlier today, nothing sent, nothing charged");
  assert.equal((await recentPages("u1")).length, 1);

  // Kept for a month, then gone.
  await run("UPDATE page_translations SET created_at = 0 WHERE id = ?", [done.id]);
  assert.equal(await translatedPage(done.id), null);
  assert.equal(await translatedPage("../../etc"), null);
});

test("the copy is served sandboxed, without scripts, and isn't indexed", async () => {
  await run("INSERT INTO page_translations (id, user_id, url, lang, title, html, created_at) VALUES ('abcdefgh1234', 'u1', 'https://a.example', 'fr', 'A', '<p>Bonjour</p>', ?)", [Date.now()]);
  const res = await GET(new Request("http://x/t/abcdefgh1234"), { params: Promise.resolve({ id: "abcdefgh1234" }) } as never);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy") ?? "", /^sandbox( |$)/);
  assert.doesNotMatch(res.headers.get("content-security-policy") ?? "", /allow-scripts|allow-same-origin/);
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await GET(new Request("http://x/t/nothere123"), { params: Promise.resolve({ id: "nothere123" }) } as never)).status, 404);
});

test("a page brought into Flash keeps its pictures, styles and links, read at where it came from", () => {
  const html = `<html><head><base href="https://cdn.example/"><link rel="stylesheet" href="/css/site.css"><style>.hero{background:url('img/hero.jpg')}</style></head>
<body><a href="#top">Top</a> <a href="about">About us</a> <a href="mailto:hi@x.example">Write</a><img src="logo.png" srcset="logo.png 1x, logo@2x.png 2x" alt="Logo">
<div style="background-image:url(&quot;/bg.png&quot;)">Hi</div><img src="data:image/png;base64,AAAA"><script src="app.js"></script></body></html>`;
  const page = ownedPage(html, "https://shop.example/en/home");
  assert.doesNotMatch(page, /<base|<script|cdn\.example/);
  for (const url of ["https://shop.example/css/site.css", "url('https://shop.example/en/img/hero.jpg')", 'href="https://shop.example/en/about"', 'src="https://shop.example/en/logo.png"', "https://shop.example/en/logo@2x.png 2x", "https://shop.example/bg.png"]) {
    assert.ok(page.includes(url), url);
  }
  for (const kept of ['href="#top"', 'href="mailto:hi@x.example"', 'src="data:image/png;base64,AAAA"']) assert.ok(page.includes(kept), kept);
});

test("bringing your own site in makes it one of your apps, in the language asked, with the copy free", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('u3', 'b@x.co', 'h', 0, 1), ('u4', 'poor@x.co', 'h', 0, 1)");
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES ('u3', 1000, 'test', 0)");
  const html = staticPage(PAGE);
  const page = { url: "https://library.example/home", html, title: pageTitle(html), phrases: pagePhrases(html), from: siteLanguage("en") };
  const t = (s: string, b?: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(b?.[k] ?? ""));
  const user = (id: string, email: string) => ({ id, email, verified_at: 1 }) as never;

  // Too few credits for the translation: no app is made.
  await ensureMonthlyCredits("u4");
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES ('u4', ?, 'test', 0)", [-(await balance("u4"))]);
  assert.deepEqual(await importFetchedPage(user("u4", "poor@x.co"), page, "sw", t), { error: "credits" });
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) AS n FROM sites WHERE user_id = 'u4'"))?.n, 0);

  const before = await balance("u3");
  const made = await importFetchedPage(user("u3", "b@x.co"), page, "sw", t);
  assert.ok(!("error" in made));
  assert.ok(made.credits >= 1);
  assert.equal(await balance("u3"), before - made.credits, "only the translation is charged");
  const site = await one<{ html: string; title: string }>("SELECT html, title FROM sites WHERE slug = ? AND user_id = 'u3'", [made.slug]);
  assert.equal(site?.title, "City Library");
  assert.match(site?.html ?? "", /href="https:\/\/library\.example\/books"/);
  const book = await one<{ phrases: string }>("SELECT phrases FROM site_translations WHERE site_slug = ? AND lang = 'sw'", [made.slug]);
  assert.equal(JSON.parse(book?.phrases ?? "{}")["Opening hours"], "FR:Opening hours");

  // Its own language: brought in as it is, nothing charged.
  const same = await importFetchedPage(user("u3", "b@x.co"), page, "en", t);
  assert.ok(!("error" in same));
  assert.equal(same.credits, 0);
});
