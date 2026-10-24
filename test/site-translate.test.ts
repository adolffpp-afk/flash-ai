import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * Translate my app: the words found on a page, the page shown in a language, and the paid flow. A
 * stand-in Claude answers each numbered phrase with "FR:" before it (or leaves one out, when asked),
 * and keeps what it was sent.
 */
let sent: string[] = [];
let skipLast = false;
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}") as { messages?: { content: string }[] };
    const message = body.messages?.[0]?.content ?? "";
    sent.push(message);
    const lines = message.split("\n").map((l) => l.replace(/^(\d+)\t/, "$1\tFR:"));
    if (skipLast) lines.pop();
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        id: "m",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [{ type: "text", text: lines.join("\n") }],
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

const { looksLikeWords, pagePhrases, pageLanguage, translatePage, readTranslations, pickLanguage, translateCredits, chunksOf, CHUNK_PHRASES } = await import(
  "../src/lib/site-translate.ts"
);
const { SITE_LANGUAGES, siteLanguageOf, AFRICAN } = await import("../src/lib/site-languages.ts");
const { run, one } = await import("../src/lib/server/db.ts");
const { translateSite, translationsView, removeLanguage, translateOpenTo } = await import("../src/lib/server/site-translations.ts");
const { serveSite } = await import("../src/lib/server/serve-site.ts");
const { balance } = await import("../src/lib/server/credits.ts");

const PAGE = `<!doctype html><html lang="en"><head><title>Golden Crumb Bakery</title><meta name="description" content="Fresh bread every morning"><style>.a{color:red}</style></head>
<body><nav><a href="#home">Home</a> <a href="#menu">Our menu</a></nav><h1 class="text-3xl font-bold">Fresh bread &amp; cakes</h1>
<img src="a.png" alt="A loaf of sourdough"><input placeholder="Your email"><button>Order now</button><code>npm i</code><p translate="no">Golden Crumb</p>
<script>const items=[{name:"Croissant",desc:"Buttery and flaky"}];list.innerHTML=items.map(i=>\`<li class="px-4 py-2"><b>\${i.name}</b> <span>Only \${i.left} left</span></li>\`).join("");
el.className="flex items-center gap-2"; el.onclick=()=>alert("Thanks for your order!"); fetch("/api/x"); const k='menu';</script>
<script type="application/ld+json">{"name":"Not shown"}</script></body></html>`;

test("the words a visitor sees are found, and code is left out", () => {
  assert.deepEqual(pagePhrases(PAGE), [
    "Golden Crumb Bakery",
    "Fresh bread every morning",
    "Home",
    "Our menu",
    "Fresh bread & cakes",
    "A loaf of sourdough",
    "Your email",
    "Order now",
    "Croissant",
    "Buttery and flaky",
    "Only {0} left",
    "Thanks for your order!",
  ]);
  assert.equal(pageLanguage(PAGE), "en");
  for (const code of ["flex items-center gap-2", "px-4 py-2", "#menu .item", "/api/x", "menu", "DOMContentLoaded", "Content-Type", "a.png", "0 8px 30px rgba(0,0,0,.25)", "x => y", "https://flash.dev"]) {
    assert.equal(looksLikeWords(code), false, code);
  }
  for (const words of ["Add to cart", "Home", "Book a table for tonight", "مرحبا بكم", "欢迎"]) assert.equal(looksLikeWords(words), true, words);
});

test("the page is shown in a language with its own code untouched", () => {
  const book = Object.fromEntries(pagePhrases(PAGE).map((p) => [p, `FR:${p}`]));
  const page = translatePage(PAGE, { ...book, "Fresh bread & cakes": "Pain & <gâteaux>" }, { id: "fr" });
  assert.match(page, /<html lang="fr">/);
  assert.match(page, /<title>FR:Golden Crumb Bakery<\/title>/);
  assert.match(page, /content="FR:Fresh bread every morning"/);
  assert.match(page, /<h1 class="text-3xl font-bold">Pain &amp; &lt;gâteaux&gt;<\/h1>/, "a translation is written as text, never as tags");
  assert.match(page, /alt="FR:A loaf of sourdough"/);
  assert.match(page, /placeholder="FR:Your email"/);
  assert.match(page, /<code>npm i<\/code><p translate="no">Golden Crumb<\/p>/, "code and translate=no stay");
  assert.ok(page.includes('{name:"Croissant",desc:"Buttery and flaky"}'), "scripts are never changed");
  assert.match(translatePage('<html dir="ltr" lang="en"><p>Home</p>', { Home: "بيت" }, { id: "ar", rtl: true }), /<html lang="ar" dir="rtl"><p>بيت<\/p>/);
});

test("a reply is read line by line, keeping only lines that keep their blanks", () => {
  assert.deepEqual(readTranslations("1\tAccueil\n2\tIl en reste\n3\tMerci\nnoise", ["Home", "Only {0} left", "Thanks"]), { Home: "Accueil", Thanks: "Merci" });
  assert.deepEqual(readTranslations("1\tIl en reste {0}", ["Only {0} left"]), { "Only {0} left": "Il en reste {0}" });
});

test("a visit is shown in the language its address asks for, else its browser's, else as written", () => {
  const pick = (param: string | null, browser: string[]) => pickLanguage(param, browser, ["fr", "sw"], "en", siteLanguageOf);
  assert.equal(pick("fr", ["sw"]), "fr");
  assert.equal(pick("en", ["fr"]), null, "the page's own language");
  assert.equal(pick("de", ["sw-KE"]), "sw", "a language it doesn't have falls back on the browser's");
  assert.equal(pick(null, ["en-GB", "fr"]), null, "a browser that reads its own language first sees it as written");
  assert.equal(pick(null, ["de", "fr-CA"]), "fr");
  assert.equal(pick(null, []), null);
});

test("African languages are offered, each once, and prices grow with the page", () => {
  const ids = SITE_LANGUAGES.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ["sw", "zu", "ha", "yo", "ig", "am", "so"]) assert.ok(ids.includes(id) && AFRICAN.has(id), id);
  const small = translateCredits(["Home", "Order now"], "fr");
  const big = translateCredits(Array.from({ length: 400 }, (_, i) => `Phrase number ${i} on the page`), "fr");
  assert.ok(small.most >= 1 && small.typical <= small.most);
  assert.ok(big.most > small.most && big.typical < big.most);
  assert.ok(translateCredits(["Order now"], "am").most >= translateCredits(["Order now"], "fr").most, "dense scripts hold more");
  assert.equal(chunksOf(Array.from({ length: CHUNK_PHRASES + 1 }, (_, i) => `w${i}`)).length, 2);
});

const owner = { id: "u1", email: "o@x.co", name: "", verified_at: 1 } as never;

test("translating holds the most it can cost, charges what it used, and only sends what is new", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('u1', 'o@x.co', 'h', 0, 1), ('u2', 's@x.co', 'h', 0, 1)");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('crumb', 'u1', 'Golden Crumb', ?, 0, 0)", [PAGE]);
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES ('u1', 1000, 'test', 0)");
  const before = await balance("u1");

  const view = await translationsView("u1", "crumb");
  assert.ok(view);
  assert.equal(view.source.id, "en");
  assert.equal(view.phrases, 12);
  assert.ok(!view.choices.some((c) => c.id === "en"), "its own language isn't offered");
  assert.equal(await translationsView("u2", "crumb"), null, "only the owner");

  sent = [];
  const first = await translateSite(owner, "crumb", "fr");
  assert.ok("ok" in first, JSON.stringify(first));
  assert.equal(first.translated, 12);
  assert.equal(first.missing, 0);
  assert.equal(sent.length, 1);
  assert.ok(first.credits >= 1 && first.credits <= view.most);
  assert.equal(await balance("u1"), before - first.credits, "charged what it used, the rest of the hold given back");

  sent = [];
  const again = await translateSite(owner, "crumb", "fr");
  assert.deepEqual([("ok" in again) && again.credits, sent.length], [0, 0], "nothing new: nothing sent, nothing charged");

  // A change to the app: only its new words are sent.
  await run("UPDATE sites SET html = ? WHERE slug = 'crumb'", [PAGE.replace("<button>Order now</button>", "<button>Order now</button><p>Open on Sundays</p>")]);
  assert.equal((await translationsView("u1", "crumb"))!.languages[0].missing, 1);
  sent = [];
  await translateSite(owner, "crumb", "fr");
  assert.deepEqual(sent, ["1\tOpen on Sundays"]);

  // A reply that leaves a phrase out keeps the rest, and says what is still to do.
  skipLast = true;
  const partial = await translateSite(owner, "crumb", "sw");
  skipLast = false;
  assert.ok("ok" in partial && partial.missing === 1);

  assert.deepEqual(await translateSite(owner, "crumb", "en"), { error: "same" });
  assert.deepEqual(await translateSite(owner, "crumb", "xx"), { error: "language" });
  assert.deepEqual(await translateSite({ id: "u2" } as never, "crumb", "de"), { error: "not_found" });
});

test("visitors see the page in their language, with the language button and an address for each", async () => {
  const req = (query: string, lang = "") => new Request(`https://flash.test/p/crumb${query}`, { headers: lang ? { "accept-language": lang } : {} });
  const fr = await (await serveSite("crumb", "https://flash.test/p/crumb", req("?lang=fr"), "https://flash.test/p/crumb")).text();
  assert.match(fr, /<html lang="fr">/);
  assert.match(fr, /<button>FR:Order now<\/button>/);
  assert.match(fr, /<link rel="canonical" href="https:\/\/flash.test\/p\/crumb\?lang=fr">/);
  assert.match(fr, /hreflang="sw" href="https:\/\/flash.test\/p\/crumb\?lang=sw"/);
  assert.match(fr, /hreflang="x-default" href="https:\/\/flash.test\/p\/crumb"/);
  assert.match(fr, /data-flash-lang/, "the language button");
  assert.ok(fr.includes('"Thanks for your order!":"FR:Thanks for your order!"'), "what the app's code shows is swapped in the browser");

  const browser = await serveSite("crumb", undefined, req("", "fr-CA,en;q=0.5"));
  assert.equal(browser.headers.get("content-language"), "fr");
  const english = await (await serveSite("crumb", undefined, req("", "en-US"))).text();
  assert.match(english, /<html lang="en">/);
  assert.match(english, /<button>Order now<\/button>/);
  assert.match(english, /data-flash-lang/, "the button shows in its own language too");

  assert.equal(await removeLanguage("u2", "crumb", "fr"), false, "only the owner");
  assert.equal(await removeLanguage("u1", "crumb", "fr"), true);
  assert.equal(await removeLanguage("u1", "crumb", "sw"), true);
  const plain = await (await serveSite("crumb", undefined, req("?lang=fr"))).text();
  assert.doesNotMatch(plain, /data-flash-lang/, "an app in no other language has no button");
  assert.equal(await one("SELECT 1 FROM site_translations WHERE site_slug = 'crumb'"), null);
});

test("Translate my app is for admins until it's opened", () => {
  const user = { email: "someone@x.co", verified_at: 1 };
  delete process.env.FLASH_TRANSLATE_OPEN;
  assert.equal(translateOpenTo(user), false);
  process.env.FLASH_TRANSLATE_OPEN = "true";
  assert.equal(translateOpenTo(user), true);
  delete process.env.FLASH_TRANSLATE_OPEN;
});
