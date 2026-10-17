import { test } from "node:test";
import assert from "node:assert/strict";

/*
 * Flash's search check (SEO): what it reads in a page (seo-scan.ts), what that means (seo-rules.ts)
 * and the instruction a fix sends the builder. Pure: nothing here touches a database or a network.
 */
process.env.DATABASE_URL = ":memory:";
const { scanPage, textWidth } = await import("../src/lib/seo-scan.ts");
const { MAX_CONTEXT, band, evaluate, fixContext, fixableIds, issueCount } = await import("../src/lib/seo-rules.ts");
const { LABELS, WHY, fixMessage, messageOf } = await import("../src/lib/seo-words.ts");
const { hasOwnCanonical, hasOwnPreview } = await import("../src/lib/site-preview.ts");
const { cleanUserMessage } = await import("../src/lib/server/turns.ts");
const { translate } = await import("../src/lib/i18n.ts");
type Check = import("../src/lib/seo-rules.ts").Check;
type CheckId = import("../src/lib/seo-rules.ts").CheckId;
type SeoContext = import("../src/lib/seo-rules.ts").SeoContext;
type SeoFacts = import("../src/lib/seo-scan.ts").SeoFacts;

const CTX: SeoContext = { slug: "golden-crumb-x1", appBase: "https://www.flash-app.dev", domains: [] };
const ADDRESS = "https://www.flash-app.dev/p/golden-crumb-x1";
const ICON = `<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E🥖%3C/text%3E%3C/svg%3E">`;
const TITLE = "<title>Golden Crumb · Sourdough bakery in Lisbon</title>";
const DESCRIPTION = '<meta name="description" content="Golden Crumb bakes sourdough, pastries and birthday cakes every morning in Lisbon. Order online and pick up warm.">';
const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';
const STORY =
  "<p>We light the oven at four every morning, so the bread on your table is never more than a few hours old. Our sourdough rests for two days before it is baked, which gives it a deep flavour and a crackling crust.</p>";
const BODY = `<h1>Sourdough baked before sunrise</h1>${STORY}`;

/** A small page that passes everything, with one part swapped for what a fixture tests. */
function page(parts: { doctype?: string; lang?: string; title?: string; description?: string; viewport?: string; icon?: string; head?: string; body?: string } = {}) {
  const { doctype = "<!doctype html>", lang = 'lang="en"', title = TITLE, description = DESCRIPTION, viewport = VIEWPORT, icon = ICON, head = "", body = BODY } = parts;
  return `${doctype}<html ${lang}><head><meta charset="utf-8">${viewport}${title}${description}${icon}${head}</head><body>${body}</body></html>`;
}
const report = (html: string, ctx: SeoContext = CTX) => evaluate(scanPage(html), ctx);
const check = (html: string, id: CheckId, ctx: SeoContext = CTX): Check | undefined => report(html, ctx).checks.find((c) => c.id === id);
const said = (html: string, id: CheckId, ctx?: SeoContext) => {
  const found = check(html, id, ctx);
  return found ? `${found.status} ${found.problem}` : "absent";
};

// A many-page site as Flash's builder writes them: page sections shown by a hash router, Tailwind
// sizes on pictures, inline SVG icons with their own titles, and a link to call the shop.
const BAKERY = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Golden Crumb · Sourdough bakery in Lisbon</title>
  <meta name="description" content="Golden Crumb bakes sourdough, pastries and birthday cakes every morning in Lisbon. Order online and pick up warm.">
  ${ICON}
  <script src="https://cdn.tailwindcss.com"></script>
  <style>body { font-family: Georgia, serif; } .price { font-size: 15px; }</style>
</head>
<body class="bg-amber-50 text-stone-800">
  <header class="sticky top-0 flex items-center justify-between p-4">
    <a href="#/" class="text-xl font-bold">Golden Crumb</a>
    <nav class="hidden gap-6 md:flex">
      <a href="#/menu">Menu</a>
      <a href="#/about">Our story</a>
      <a href="#/contact">Visit us</a>
    </nav>
    <button id="menu-button" class="rounded-full p-2 md:hidden">
      <svg viewBox="0 0 24 24" class="h-6 w-6" fill="none" stroke="currentColor"><title>Open the menu</title><path d="M4 6h16M4 12h16M4 18h16"/></svg>
    </button>
  </header>
  <main>
    <section data-page="home">
      <h1 class="text-5xl font-bold">Sourdough baked before sunrise</h1>
      ${STORY}
      <img src="https://images.unsplash.com/photo-1509440159596-0249088772ff?w=1200" alt="A crusty sourdough loaf cooling on a wooden board" class="h-72 w-full rounded-3xl object-cover">
      <h2>Today's bakes</h2>
      <p>Country loaf, seeded rye, cinnamon buns and our famous custard tarts, while they last.</p>
      <a href="#/menu" class="rounded-full bg-amber-700 px-6 py-3 text-white">See the whole menu</a>
    </section>
    <section data-page="menu" class="hidden">
      <h1>Our menu</h1>
      <h2>Breads</h2>
      <article class="rounded-2xl bg-white p-4">
        <img src="https://images.unsplash.com/photo-1586444248902-2f64eddc13df?w=800" alt="Seeded rye loaf sliced on a plate" class="h-48 w-full object-cover" loading="lazy">
        <h3>Seeded rye</h3>
        <p class="price">€4.50</p>
        <button class="rounded-full bg-stone-900 px-4 py-2 text-white">Add to order</button>
      </article>
      <h2>Pastries</h2>
      <p>Croissants, pains au chocolat and custard tarts, baked twice a day.</p>
    </section>
    <section data-page="about" class="hidden">
      <h1>About Golden Crumb</h1>
      <h2>Our story</h2>
      <p>Ana and Rui opened Golden Crumb in 2016 with one oven and a sourdough starter from Ana's grandmother.</p>
    </section>
    <section data-page="contact" class="hidden">
      <h1>Visit us</h1>
      <a href="#hours">Opening hours</a>
      <div id="hours">
        <h2>Opening hours</h2>
        <p>Tuesday to Sunday, 7am to 3pm.</p>
      </div>
      <a href="tel:+351210000000" class="font-semibold">Call us on +351 21 000 0000</a>
    </section>
  </main>
  <footer class="p-6"><a href="https://instagram.com/goldencrumb">Follow us on Instagram</a></footer>
  <script>
    const show = () => { const name = location.hash.slice(2) || "home"; document.querySelectorAll("[data-page]").forEach((s) => s.classList.toggle("hidden", s.dataset.page !== name)); };
    addEventListener("hashchange", show); show();
  </script>
</body>
</html>`;

test("a many-page site as the builder writes it passes everything", () => {
  const r = report(BAKERY);
  const problems = r.checks.filter((c) => c.status === "fail" || c.status === "warn").map((c) => `${c.id} ${c.problem} ${JSON.stringify(c.values)}`);
  assert.deepEqual(problems, []);
  assert.equal(r.score, 100);
  assert.equal(r.passed, r.total);
  assert.equal(issueCount(r), 0);
  assert.equal(said(BAKERY, "card"), "flash flash");
  assert.equal(said(BAKERY, "canonical"), "flash flash");
  assert.deepEqual(check(BAKERY, "canonical")?.values, { url: ADDRESS });
  assert.equal(said(BAKERY, "sitemap"), "na flash");
  assert.equal(said(BAKERY, "hashPages"), "tip tip");
  assert.deepEqual(check(BAKERY, "hashPages")?.values, { page: "#/menu" });
  assert.equal(said(BAKERY, "robots"), "flash flash");
  assert.equal(said(BAKERY, "structured"), "tip none", "no structured data is a tip, never a problem");
  assert.equal(said(BAKERY, "externalLinks"), "na na");
  assert.equal(said(BAKERY, "photo"), "absent", "the page has a photo the share card shows");
  const facts = scanPage(BAKERY);
  assert.deepEqual(facts.pages, ["home", "menu", "about", "contact"]);
  assert.deepEqual(facts.h1s, { home: 1, menu: 1, about: 1, contact: 1 });
  assert.equal(facts.titleCount, 1, "an SVG icon's <title> isn't the page's");
  assert.equal(facts.links.empty, 0, "the menu button is labelled by its icon's title");
  assert.equal(facts.jsBuilt, false);
  assert.equal(facts.script.main, "latin");
  // Every check that counts says why it matters, and every one has words.
  for (const c of r.checks) {
    assert.ok(LABELS[c.id], c.id);
    if (c.status !== "pass") assert.ok(messageOf(c), `${c.id}:${c.problem} has a message`);
    if (c.weight) assert.ok(WHY[c.id], `${c.id} says why`);
  }
});

test("the title: missing, more than one, generic, starting with Home, too long or short, measured as search results do", () => {
  assert.equal(said(page({ title: "" }), "title"), "fail none");
  assert.equal(said(page({ title: "<title> </title>" }), "title"), "fail none");
  assert.deepEqual(check(page({ title: `${TITLE}<title>Golden Crumb</title>` }), "title")?.values, { count: 2, tag: "<title>" });
  assert.equal(said(page({ title: `${TITLE}<title>Golden Crumb</title>` }), "title"), "fail several");
  assert.equal(said(page({ body: `${BODY}<svg><title>Bread</title></svg>` }), "title"), "pass pass", "an SVG icon's title isn't a second one");
  for (const generic of ["Home", "Untitled", "My App", "  index ", "React App", "Made with Flash"]) {
    assert.equal(said(page({ title: `<title>${generic}</title>` }), "title"), "fail generic", generic);
  }
  assert.deepEqual(check(page({ title: "<title>Home</title>" }), "title")?.values, { title: "Home" });
  assert.equal(said(page({ title: "<title>Home · Golden Crumb</title>" }), "title"), "warn home");
  assert.equal(said(page({ title: "<title>Home | Golden Crumb Bakery</title>" }), "title"), "warn home");
  const long = "Golden Crumb Bakery in Lisbon: sourdough, pastries, cakes and coffee every day";
  assert.deepEqual(check(page({ title: `<title>${long}</title>` }), "title")?.values, { count: long.length, title: long });
  assert.equal(said(page({ title: "<title>Crumb</title>" }), "title"), "warn short");
  // Chinese characters count twice: 14 of them are a fine title, 31 are too long.
  assert.equal(textWidth("黄金面包店 里斯本酸面包和糕点"), 29);
  assert.equal(said(page({ title: "<title>黄金面包店 里斯本酸面包和糕点</title>" }), "title"), "pass pass");
  const wide = "黄金面包店里斯本最好的酸面包和糕点每天早上新鲜出炉欢迎光临本店";
  assert.equal(wide.length, 31);
  assert.equal(said(page({ title: `<title>${wide}</title>` }), "title"), "warn long");
  assert.equal(check(page({ title: `<title>${wide}</title>` }), "title")?.values.count, 62);
  assert.equal(said(page({ title: "<title>Golden Crumb &amp; Co · Sourdough</title>" }), "title"), "pass pass");
  assert.equal(check(page({ title: "<title>Golden Crumb &amp; Co · Sourdough</title>" }), "title")?.values.title, "Golden Crumb & Co · Sourdough");
});

test("the description: missing, more than one, the title again, too long or short", () => {
  assert.equal(said(page({ description: "" }), "description"), "fail none");
  assert.equal(said(page({ description: '<meta name="description" content="">' }), "description"), "fail none");
  assert.equal(said(page({ description: DESCRIPTION + DESCRIPTION }), "description"), "fail several");
  assert.equal(said(page({ description: '<meta name="description" content="Golden Crumb · Sourdough bakery in Lisbon">' }), "description"), "warn same");
  assert.equal(said(page({ title: "<title>Home · Golden Crumb</title>", description: '<meta name="description" content="Golden Crumb">' }), "description"), "warn same");
  assert.equal(said(page({ description: `<meta name="description" content="${"Fresh bread and cakes. ".repeat(9)}">` }), "description"), "warn long");
  assert.deepEqual(check(page({ description: '<meta name="description" content="Fresh bread daily.">' }), "description")?.values, { count: 18, text: "Fresh bread daily." });
  assert.equal(said(page({ description: `<meta content="${"Golden Crumb bakes sourdough and pastries every morning in Lisbon for the whole street."}" name="description">` }), "description"), "pass pass");
});

test("whether the page lets Google list it", () => {
  assert.equal(said(page(), "indexing"), "pass pass");
  assert.equal(said(page({ head: '<meta name="robots" content="noindex">' }), "indexing"), "fail noindex");
  assert.deepEqual(check(page({ head: '<meta name="robots" content="none">' }), "indexing")?.values, { value: "none" });
  assert.equal(said(page({ head: '<meta name="robots" content="none">' }), "indexing"), "fail noindex", "none means noindex and nofollow");
  assert.equal(said(page({ head: '<meta name="googlebot" content="noindex, nofollow">' }), "indexing"), "fail noindex");
  assert.equal(said(page({ head: '<meta name="robots" content="index,nofollow">' }), "indexing"), "warn nofollow");
  assert.equal(said(page({ head: '<meta name="robots" content="noindex">' }), "sitemap"), "na noindex");
  assert.equal(said(page({ head: '<meta name="robots" content="index, follow">' }), "indexing"), "pass pass");
});

test("the main address: Flash names it, and one the page names itself must be this app's", () => {
  const own = (href: string) => page({ head: `<link rel="canonical" href="${href}">` });
  assert.equal(said(page(), "canonical"), "flash flash");
  assert.equal(said(own("https://example.com/"), "canonical"), "fail elsewhere");
  assert.deepEqual(check(own("https://example.com/"), "canonical")?.values, { url: "https://example.com/" });
  assert.equal(said(own("/p/golden-crumb-x1"), "canonical"), "fail invalid", "a relative address");
  assert.equal(said(own("http://www.flash-app.dev/p/golden-crumb-x1"), "canonical"), "fail invalid", "not https");
  assert.equal(said(own("https://flash-ai-pi.vercel.app/p/golden-crumb-x1"), "canonical"), "pass pass", "another of Flash's own addresses");
  assert.equal(said(own("https://www.flash-app.dev/p/golden-crumb-x1/"), "canonical"), "pass pass");
  assert.equal(said(own("https://www.flash-app.dev/p/another-app"), "canonical"), "fail elsewhere", "another app");
  assert.equal(said(own("https://crumbbakery.com/"), "canonical"), "fail elsewhere", "a domain that isn't the app's");
  assert.equal(said(own("https://crumbbakery.com/"), "canonical", { ...CTX, domains: ["crumbbakery.com"] }), "pass pass", "the app's own domain");
  assert.equal(said(own("https://crumbbakery.com/menu"), "canonical", { ...CTX, domains: ["crumbbakery.com"] }), "fail elsewhere");
  assert.equal(said(page({ head: '<link rel="canonical" href="https://a.example/"><link rel="canonical" href="https://b.example/">' }), "canonical"), "fail several");
  assert.equal(said(page({ head: "<link href='https://example.com/' rel=canonical>" }), "canonical"), "fail elsewhere", "attributes in any order, unquoted");
  assert.equal(check(own("https://example.com/"), "canonical")?.fix?.includes("Remove every <link rel=\"canonical\">"), true);
});

test("the sitemap: the app's own domain has one, Flash's address doesn't", () => {
  assert.equal(said(page(), "sitemap"), "na flash");
  assert.equal(said(page(), "sitemap", { ...CTX, domains: ["www.crumbbakery.com", "crumbbakery.com"] }), "flash domain");
  assert.deepEqual(check(page(), "sitemap", { ...CTX, domains: ["www.crumbbakery.com", "crumbbakery.com"] })?.values, { url: "https://crumbbakery.com/sitemap.xml" });
});

test("structured data that can't be read, says too little, or describes the page", () => {
  const ld = (json: string) => page({ head: `<script type="application/ld+json">${json}</script>` });
  assert.equal(said(ld('{"@context":"https://schema.org","@type":"Bakery","name":"Golden Crumb",}'), "structured"), "fail bad", "a trailing comma");
  assert.deepEqual(check(ld('{"@context":"https://schema.org",}'), "structured")?.values, { count: 1, total: 1 });
  assert.equal(said(ld('{"@context":"https://schema.org","name":"Golden Crumb"}'), "structured"), "warn incomplete", "no @type");
  assert.equal(said(ld('{"@type":"Bakery","name":"Golden Crumb"}'), "structured"), "warn incomplete", "no @context");
  const graph = ld('{"@context":"https://schema.org","@graph":[{"@type":"Bakery","name":"Golden Crumb"},{"@type":"WebSite","url":"https://crumbbakery.com/"}]}');
  assert.equal(said(graph, "structured"), "pass pass");
  assert.deepEqual(check(graph, "structured")?.values, { types: "Bakery, WebSite" });
  assert.equal(said(ld('[{"@context":"https://schema.org","@type":["Bakery","CafeOrCoffeeShop"]}]'), "structured"), "pass pass");
  assert.equal(said(page(), "structured"), "tip none");
  assert.equal(check(page(), "structured")?.weight, 0);
});

test("the language and reading direction", () => {
  assert.equal(said(page({ lang: "" }), "language"), "fail none");
  assert.equal(said(page({ lang: 'lang="english"' }), "language"), "fail invalid");
  assert.equal(said(page({ lang: 'lang="pt-BR"' }), "language"), "pass pass");
  const arabic = "<h1>مخبز الكسرة الذهبية</h1><p>نخبز خبز العجين المخمر والمعجنات والكعك كل صباح في لشبونة، ونفتح أبوابنا من الثلاثاء إلى الأحد من السابعة صباحا حتى الثالثة.</p>";
  assert.equal(said(page({ lang: 'lang="en"', body: arabic }), "language"), "warn mismatch", "English said, Arabic written");
  assert.equal(said(page({ lang: 'lang="ar"', body: arabic }), "language"), "pass pass");
  assert.equal(said(page({ lang: 'lang="ar"', body: arabic }), "direction"), "warn missing");
  assert.deepEqual(check(page({ lang: 'lang="ar"', body: arabic }), "direction")?.values, { lang: "ar" });
  assert.equal(said(page({ lang: 'lang="ar" dir="rtl"', body: arabic }), "direction"), "pass pass");
  assert.equal(said(page({ lang: 'lang="he"', body: "<h1>שלום</h1>" }), "direction"), "warn missing");
  assert.equal(said(page({ lang: "", body: arabic }), "direction"), "warn missing", "no language said, but written right to left");
  assert.equal(said(page(), "direction"), "absent");
  assert.equal(said(page({ lang: 'lang="ja"', body: "<h1>ゴールデンクラム</h1><p>毎朝リスボンでサワードウとペストリーを焼いています。火曜日から日曜日まで、朝七時から午後三時まで営業しています。ぜひお越しください。季節のケーキもございます。</p>" }), "language"), "pass pass");
});

test("the main heading, per page on a many-page site, and the heading order", () => {
  assert.equal(said(page({ body: STORY }), "h1"), "fail none");
  assert.equal(said(page({ body: `<h1>One</h1><h1>Two</h1>${STORY}` }), "h1"), "warn several");
  assert.deepEqual(check(page({ body: `<h1>One</h1><h1>Two</h1>${STORY}` }), "h1")?.values, { count: 2, samples: '"One", "Two"' });
  const sections = (inner: string) => page({ body: `<section data-page="home"><h1>Home</h1>${STORY}</section>${inner}` });
  assert.equal(said(sections('<section data-page="menu"><h2>Menu</h2></section>'), "h1"), "fail pages");
  assert.deepEqual(check(sections('<section data-page="menu"><h2>Menu</h2></section>'), "h1")?.values, { pages: "menu" });
  assert.equal(said(sections('<section data-page="menu"><h1>Menu</h1><h1>Cakes</h1></section>'), "h1"), "warn pagesSeveral");
  assert.equal(said(page({ body: `<header><h1>Golden Crumb</h1></header><section data-page="home"><h1>Home</h1></section><section data-page="menu"><h2>Menu</h2></section>` }), "h1"), "warn pagesSeveral", "the header's h1 counts on every page");
  assert.equal(said(page({ body: `<h1>Golden Crumb</h1><h3>Breads</h3>${STORY}` }), "headings"), "warn skip");
  assert.deepEqual(check(page({ body: `<h1>Golden Crumb</h1><h3>Breads</h3>${STORY}` }), "headings")?.values, { from: "h1", to: "h3", text: "Breads" });
  assert.equal(said(page({ body: `<h1>Golden Crumb</h1><h2></h2>${STORY}` }), "headings"), "warn empty");
  assert.equal(said(page({ body: `<h1>Golden Crumb</h1><h2>Breads</h2><h3>Rye</h3><h2>Cakes</h2>${STORY}` }), "headings"), "pass pass");
  // Each page's headings are in order on their own.
  assert.equal(said(sections('<section data-page="menu"><h1>Menu</h1><h2>Breads</h2></section>'), "headings"), "pass pass");
});

test("pictures: descriptions, sizes, lazy loading and pictures built into the page", () => {
  assert.equal(said(page({ body: `${BODY}<img src="https://x.example/loaf.jpg" class="h-48">` }), "alt"), "fail noAlt");
  assert.deepEqual(check(page({ body: `${BODY}<img src="https://x.example/loaf.jpg" class="h-48">` }), "alt")?.values, { count: 1, total: 1 });
  assert.equal(said(page({ body: `${BODY}<img src="a.jpg" alt="IMG_2041.jpg" class="h-48">` }), "alt"), "warn fileAlt");
  assert.equal(said(page({ body: `${BODY}<img src="a.jpg" alt="image" class="h-48">` }), "alt"), "warn fileAlt");
  assert.equal(said(page({ body: `${BODY}<img src="a.jpg" alt="" class="h-48">` }), "alt"), "pass pass", "alt=\"\" says it's decorative");
  assert.equal(said(page(), "alt"), "absent", "no pictures");
  assert.equal(said(page({ body: `${BODY}<img src="https://x.example/a.jpg" alt="Loaf">` }), "images"), "warn noSize");
  assert.equal(said(page({ body: `${BODY}<img src="a.jpg" alt="Loaf" width="800" height="600">` }), "images"), "pass pass");
  assert.equal(said(page({ body: `${BODY}<img src="a.jpg" alt="Loaf" style="aspect-ratio: 4/3">` }), "images"), "pass pass");
  const four = `${BODY}${'<img src="a.jpg" alt="Loaf" class="h-48">'.repeat(4)}`;
  assert.equal(said(page({ body: four }), "images"), "warn lazy");
  assert.equal(said(page({ body: four.replace('class="h-48">', 'class="h-48" loading="lazy">') }), "images"), "pass pass");
  assert.equal(said(page({ body: `${BODY}<img src="https://x.example/a.jpg" alt="Loaf" class="h-48">` }), "imageFiles"), "na external");
  // A big picture built into the page: its header says 4000 pixels wide.
  const png = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(png);
  png.writeUInt32BE(4000, 16);
  png.writeUInt32BE(3000, 20);
  const big = `${BODY}<img src="data:image/png;base64,${png.toString("base64")}" alt="Loaf" class="h-48">`;
  assert.equal(said(page({ body: big }), "images"), "warn big");
  assert.equal(check(page({ body: big }), "images")?.fix, null, "only a smaller picture fixes it");
});

test("links: words, pages that don't exist, addresses a one-file app doesn't have, spots that aren't there", () => {
  const body = (links: string) => page({ body: `<section data-page="home"><h1>Golden Crumb</h1>${STORY}${links}</section><section data-page="menu"><h1>Menu</h1><div id="breads"></div></section>` });
  assert.equal(said(body('<a href="#/menu">See the menu</a>'), "links"), "pass pass");
  assert.equal(said(body('<a href="#/gallery">Gallery</a>'), "links"), "fail missingPages");
  assert.deepEqual(check(body('<a href="#/gallery">Gallery</a>'), "links")?.values, { links: "#/gallery" });
  assert.ok(check(body('<a href="#/gallery">Gallery</a>'), "links")?.fix?.includes("#/gallery"));
  assert.equal(said(body('<a href="about.html">About</a>'), "links"), "fail outside");
  assert.deepEqual(check(body('<a href="about.html">About</a>'), "links")?.values, { links: "about.html" });
  assert.equal(said(body('<a href="/">Home</a>'), "links"), "fail outside");
  assert.equal(said(body('<a href="#reviews">Reviews</a>'), "links"), "warn missingIds");
  assert.equal(said(body('<a href="#breads">Breads</a>'), "links"), "pass pass");
  assert.equal(said(body('<a href="#/menu/breads">Breads</a> <a href="#/">Home</a> <a href="#">Top</a>'), "links"), "pass pass");
  // Link words.
  assert.equal(said(body('<a href="https://instagram.com/goldencrumb"><i class="fa fa-instagram"></i></a>'), "linkText"), "fail empty");
  assert.deepEqual(check(body('<a href="https://instagram.com/goldencrumb"><i class="fa fa-instagram"></i></a>'), "linkText")?.values, { count: 1 });
  assert.equal(said(body('<a href="https://instagram.com/goldencrumb" aria-label="Instagram"><i class="fa fa-instagram"></i></a>'), "linkText"), "pass pass");
  assert.equal(said(body('<button class="p-3"><svg viewBox="0 0 24 24"><path d="M0 0"/></svg></button>'), "linkText"), "fail empty");
  assert.equal(said(body('<a href="#/menu">Read more</a>'), "linkText"), "warn vague");
  assert.deepEqual(check(body('<a href="#/menu">Read more</a>'), "linkText")?.values, { text: "Read more", count: 1 });
  assert.equal(said(body('<a href="#/menu">Leer más</a>'), "linkText"), "warn vague");
  assert.equal(said(body('<a href="#/menu"><img src="a.jpg" alt="Our menu" class="h-8"></a>'), "linkText"), "pass pass", "a picture's alt is the link's words");
  assert.equal(said(body('<a href="#/menu">Golden<span>Crumb</span></a>'), "linkText"), "pass pass");
});

test("blanks the builder left for the owner, but not numbers, capitals or code", () => {
  const found = page({ body: `${BODY}<p>Call us on [Phone number] or visit [Número de teléfono].</p>` });
  assert.equal(said(found, "placeholders"), "fail found");
  assert.deepEqual(check(found, "placeholders")?.values, { list: "[Phone number], [Número de teléfono]" });
  assert.equal(check(found, "placeholders")?.action, "tell", "only the owner knows their phone number");
  assert.equal(check(found, "placeholders")?.fix, null);
  assert.equal(said(page({ body: `${BODY}<p>See note [1] and [NEW] and [2.5].</p>` }), "placeholders"), "pass pass");
  assert.equal(said(page({ body: `${BODY}<pre><code>const list = [Phone number];</code></pre>` }), "placeholders"), "pass pass");
  assert.equal(said(page({ body: `${BODY}<script>const blank = "[Phone number]";</script>` }), "placeholders"), "pass pass");
  assert.equal(said(page({ title: "<title>[Business name] · Sourdough bakery</title>" }), "placeholders"), "fail found");
  assert.equal(said(page({ description: '<meta name="description" content="[Business name] bakes sourdough, pastries and birthday cakes every morning in [City].">' }), "placeholders"), "fail found");
  assert.equal(said(page({ body: `${BODY}<p>[东京店的地址]</p>` }), "placeholders"), "fail found");
});

test("the share card the page sets itself, and a photo for it", () => {
  const card = (tags: string) => page({ head: tags });
  const full = '<meta property="og:title" content="Golden Crumb"><meta property="og:description" content="Sourdough in Lisbon"><meta property="og:image" content="https://x.example/loaf.jpg">';
  assert.equal(said(card(`${full}<meta name="twitter:card" content="summary_large_image">`), "card"), "pass pass");
  assert.equal(said(card(full), "card"), "warn twitter");
  assert.equal(said(card('<meta property="og:title" content="Golden Crumb">'), "card"), "warn missing");
  assert.deepEqual(check(card('<meta property="og:title" content="Golden Crumb">'), "card")?.values, { tags: "og:description, og:image" });
  assert.equal(said(card(full.replace("https://x.example/loaf.jpg", "/loaf.jpg")), "card"), "warn image");
  assert.equal(said(page(), "photo"), "tip tip");
  assert.equal(check(page(), "photo")?.action, "preview");
  assert.equal(said(page({ body: `${BODY}<img src="https://x.example/loaf.jpg" alt="Loaf" class="h-48">` }), "photo"), "absent");
});

test("phones: the viewport, small text and small buttons", () => {
  assert.equal(said(page({ viewport: "" }), "viewport"), "fail none");
  assert.equal(said(page({ viewport: '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">' }), "viewport"), "warn zoom");
  assert.equal(said(page({ viewport: '<meta name="viewport" content="width=device-width, user-scalable=no">' }), "viewport"), "warn zoom");
  assert.equal(said(page({ viewport: '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">' }), "viewport"), "pass pass");
  assert.equal(said(page({ body: `${BODY}<p class="text-[10px]">Small print</p>` }), "textSize"), "warn small");
  assert.deepEqual(check(page({ body: `${BODY}<p class="text-[10px]">Small</p><style>.x { font-size: 11px }</style>` }), "textSize")?.values, { list: "text-[10px], font-size: 11px" });
  assert.equal(said(page({ body: `${BODY}<p style="font-size: 0.7rem">Small</p>` }), "textSize"), "warn small");
  assert.equal(said(page({ body: `${BODY}<p style="font-size: 14px" class="text-[13px]">Fine</p>` }), "textSize"), "pass pass");
  assert.equal(said(page({ body: `${BODY}<button class="h-5 w-5" aria-label="Close">×</button>` }), "tapTargets"), "warn small");
  assert.ok(String(check(page({ body: `${BODY}<button class="h-5 w-5" aria-label="Close">×</button>` }), "tapTargets")?.values.list).includes('<button class="h-5 w-5"'));
  assert.equal(said(page({ body: `${BODY}<button class="h-5 w-5 p-3" aria-label="Close">×</button>` }), "tapTargets"), "na none", "padding makes it bigger");
  assert.equal(said(page({ body: `${BODY}<a href="#/" style="width: 16px; height: 16px">×</a>` }), "tapTargets"), "warn small");
  assert.equal(said(page({ body: `${BODY}<input type="checkbox" class="h-4 w-4">` }), "tapTargets"), "warn small");
  assert.equal(said(page(), "tapTargets"), "na none", "the code doesn't say: Google's check measures them");
});

test("speed: page weight, scripts that hold up the page, fonts and insecure addresses", () => {
  const padded = (bytes: number) => page({ body: `${BODY}<p>${"Fresh bread every morning. ".repeat(Math.ceil(bytes / 27))}</p>` });
  assert.equal(said(padded(400 * 1024), "weight"), "warn heavy");
  assert.equal(said(padded(1.2 * 1024 * 1024), "weight"), "fail heavy");
  assert.ok(check(padded(1.2 * 1024 * 1024), "weight")?.fix);
  assert.equal(said(page(), "weight"), "pass pass");
  const pictures = page({ body: `${BODY}<img src="data:image/jpeg;base64,${"A".repeat(500 * 1024)}" alt="Loaf" class="h-48">` });
  assert.equal(said(pictures, "weight"), "warn pictures");
  assert.equal(check(pictures, "weight")?.fix, null, "the builder can't make a picture smaller");
  assert.equal(check(pictures, "weight")?.action, null);
  const head = (tag: string) => page({ head: tag });
  assert.equal(said(head('<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>'), "blocking"), "warn found");
  assert.deepEqual(check(head('<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>'), "blocking")?.values, {
    list: '<script src="https://code.jquery.com/jquery-3.7.1.min.js">',
  });
  for (const fine of [
    '<script src="https://code.jquery.com/jquery-3.7.1.min.js" defer></script>',
    '<script async src="https://x.example/a.js"></script>',
    '<script type="module" src="https://x.example/a.js"></script>',
    '<script type="text/babel" src="https://x.example/app.jsx"></script>',
    '<script src="https://cdn.tailwindcss.com"></script>',
    '<script src="https://cdn.tailwindcss.com?plugins=forms"></script>',
    '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Bakery"}</script>',
  ]) {
    assert.equal(said(head(fine), "blocking"), "pass pass", fine);
  }
  assert.equal(said(page({ body: `${BODY}<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>` }), "blocking"), "pass pass", "a script at the end of the page doesn't hold it up");
  assert.equal(said(head('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lora:wght@400;700">'), "fonts"), "warn noSwap");
  assert.equal(said(head('<style>@import url("https://fonts.googleapis.com/css2?family=Lora");</style>'), "fonts"), "warn noSwap");
  assert.equal(said(head('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lora&amp;display=swap">'), "fonts"), "pass pass");
  assert.equal(said(page(), "fonts"), "absent");
  assert.equal(said(page({ body: `${BODY}<img src="http://x.example/loaf.jpg" alt="Loaf" class="h-48">` }), "mixed"), "fail found");
  assert.equal(said(head('<link rel="stylesheet" href="http://x.example/a.css">'), "mixed"), "fail found");
  assert.equal(said(head('<script src="http://x.example/a.js" defer></script>'), "mixed"), "fail found");
  assert.equal(said(page({ body: `${BODY}<div style="background: url(http://x.example/a.jpg)"></div>` }), "mixed"), "fail found");
  assert.equal(said(page({ body: `${BODY}<a href="http://x.example/">Our old site</a>` }), "mixed"), "pass pass", "a link to an http:// site is fine");
});

test("the doctype and the icon", () => {
  assert.equal(said(page({ doctype: "" }), "doctype"), "fail none");
  assert.equal(said(page({ doctype: "<!DOCTYPE html>" }), "doctype"), "pass pass");
  assert.equal(said(`<p>hi</p>${page()}`, "doctype"), "fail none", "only at the very start");
  assert.equal(said(page({ icon: "" }), "icon"), "warn none");
  assert.equal(said(page({ icon: '<link rel="shortcut icon" href="/favicon.ico">' }), "icon"), "pass pass");
});

test("rules that must not fire on what Flash's apps do", () => {
  const sections = (inner: string, extra = "") =>
    page({ body: `<section data-page="home"><h1>Golden Crumb</h1>${STORY}${inner}</section><section data-page="product"><h1>Product</h1></section>${extra}` });
  assert.equal(said(sections('<a href="#/product/3">Rye loaf</a>'), "links"), "pass pass", "a page with an id after it");
  assert.equal(said(page({ body: `${BODY}<a href="#/gallery">Gallery</a>` }), "links"), "pass pass", "no page sections: the script decides what #/ links show");
  assert.equal(said(sections('<a href="#reviews">Reviews</a>', '<script>list.innerHTML = `<div id="reviews">${rows}</div>`;</script>'), "links"), "pass pass", "made by the script");
  assert.equal(said(sections('<a href="#/team">Team</a>', "<script>main.innerHTML += '<section data-page=\"team\"><h1>Team</h1></section>';</script>"), "links"), "pass pass");
  assert.equal(said(sections('<a href="#reviews">Reviews</a>', '<template><div id="reviews"></div></template>'), "links"), "pass pass");
  const button = page({ body: `${BODY}<button class="p-2"><svg viewBox="0 0 24 24"><title>Menu</title><path d="M0 0"/></svg></button>` });
  assert.equal(said(button, "linkText"), "pass pass", "labelled by its icon's title");
  assert.equal(said(button, "title"), "pass pass", "and that title isn't the page's");
  assert.equal(said(page({ body: `${BODY}<img src="a.jpg" alt="Loaf" class="h-48 w-full object-cover">` }), "images"), "pass pass", "sized by Tailwind");
  assert.equal(said(page({ body: `${BODY}<img src="a.jpg" alt="Loaf" class="md:h-64 w-full">` }), "images"), "pass pass");
  assert.equal(said(page({ body: `${BODY}<img src="dots.svg" role="presentation" class="h-4">` }), "alt"), "pass pass", "decorative");
  assert.equal(said(page({ body: `${BODY}<img src="dots.svg" aria-hidden="true" class="h-4">` }), "alt"), "pass pass");
  for (const href of ["?lang=es", "/p/other-app", "/api/sites/golden-crumb-x1/files/abc123", "mailto:hello@crumbbakery.com", "tel:+351210000000", "https://maps.google.com/?q=bakery", "javascript:void(0)"]) {
    assert.equal(said(page({ body: `${BODY}<a href="${href}">Somewhere useful</a>` }), "links"), "absent", href);
    assert.equal(said(page({ body: `${BODY}<a href="#/">Home</a><a href="${href}">Somewhere useful</a>` }), "links"), "pass pass", href);
  }
  const fonts = page({ head: '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lora:wght@400;600;700&amp;family=Inter:wght@400;500;700&amp;display=swap">' });
  assert.equal(said(fonts, "fonts"), "pass pass");
  assert.equal(said(page({ body: `${BODY}<p>Prices from €3 &lt; €5 &amp; 2 < 3.</p>` }), "placeholders"), "pass pass");
  assert.equal(said(page({ body: `${BODY}<div class="h-5 w-5 rounded-full bg-amber-500"></div>` }), "tapTargets"), "na none", "not something people tap");
});

test("a page its scripts build: the rules about what it shows don't apply", () => {
  const react = `<!doctype html><html lang="en"><head><meta charset="utf-8">${VIEWPORT}<title>Golden Crumb · Order sourdough online</title>${DESCRIPTION}${ICON}
<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js" defer></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js" defer></script>
<script src="https://unpkg.com/@babel/standalone@7.26.4/babel.min.js" defer></script>
</head><body><div id="root"></div>
<script type="text/babel">
function App() { return <main><h1>Golden Crumb</h1><img src="loaf.jpg" /><a href="#/missing">Read more</a></main>; }
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
</script></body></html>`;
  const facts = scanPage(react);
  assert.equal(facts.jsBuilt, true);
  const r = evaluate(facts, CTX);
  for (const id of ["h1", "headings", "linkText", "links"] as const) assert.equal(said(react, id), "absent", id);
  assert.equal(said(react, "alt"), "absent", "no <img> in its code");
  assert.equal(said(react, "jsBuilt"), "na na");
  assert.ok(messageOf({ id: "jsBuilt", problem: "na" })?.includes("JavaScript"));
  const content: CheckId[] = ["h1", "headings", "alt", "linkText", "links", "placeholders"];
  assert.deepEqual(r.checks.filter((c) => content.includes(c.id) && c.status === "fail").map((c) => c.id), []);
  assert.equal(r.score, 100);
  // A page with a heading in its code shows it itself, however few its words.
  assert.equal(scanPage(page({ body: "<h1>Golden Crumb</h1><script>render()</script>" })).jsBuilt, false);
  assert.equal(scanPage(page({ body: "<div id=app></div><script>render()</script>" })).jsBuilt, true);
});

test("the score: weights, half points for what could be better, and only what counts", () => {
  const base = scanPage(BAKERY);
  const r = evaluate(base, CTX);
  const scored = r.checks.filter((c) => ["pass", "warn", "fail"].includes(c.status));
  const possible = scored.reduce((sum, c) => sum + c.weight, 0);
  assert.ok(possible >= 25, `${possible} points possible`);
  assert.equal(r.total, scored.length);
  for (const c of r.checks.filter((c) => ["tip", "flash", "na"].includes(c.status))) assert.ok(!scored.includes(c), c.id);
  // The title could be better: half of its 3 points.
  const home = evaluate({ ...base, titles: ["Home · Golden Crumb"] }, CTX);
  assert.equal(home.score, Math.round((100 * (possible - 1.5)) / possible));
  // No title at all: none of them.
  const none = evaluate({ ...base, titles: [], titleCount: 0 }, CTX);
  assert.equal(none.score, Math.round((100 * (possible - 3)) / possible));
  // No icon: half of 1 point.
  assert.equal(evaluate({ ...base, icon: false }, CTX).score, Math.round((100 * (possible - 0.5)) / possible));
  // Tips and what Flash does change nothing.
  assert.equal(evaluate({ ...base, pages: base.pages.slice(0, 1), h1s: { home: 1 } }, CTX).score, 100, "without the hashPages tip");
  assert.equal(evaluate({ ...base, ldjson: { total: 1, bad: 0, noContext: 0, noType: 0, types: ["Bakery"] } }, CTX).score, 100);
  // Bands as Google's: 90 and up good, under 50 poor.
  assert.equal(band(49), "poor");
  assert.equal(band(50), "needs");
  assert.equal(band(89), "needs");
  assert.equal(band(90), "good");
  assert.equal(band(100), "good");
  // A page that couldn't be read has no score, never a made-up one.
  assert.deepEqual(evaluate({ ...base, error: true }, CTX), { score: null, passed: 0, total: 0, checks: [] });
  assert.equal(evaluate(null, CTX).score, null);
  // The owner's domains don't change the score, unless the page's own main address is one of them.
  const weak = scanPage(page({ title: "<title>Home</title>", icon: "" }));
  assert.equal(evaluate(weak, CTX).score, evaluate(weak, { ...CTX, domains: ["crumbbakery.com"] }).score);
  const named = scanPage(page({ head: '<link rel="canonical" href="https://crumbbakery.com/">' }));
  assert.ok(evaluate(named, { ...CTX, domains: ["crumbbakery.com"] }).score! > evaluate(named, CTX).score!);
  // Problems first, the heaviest first; then the rest in the list's order.
  const order = report(page({ title: "<title>Home · Golden Crumb</title>", viewport: "", icon: "", doctype: "" })).checks.map((c) => `${c.status} ${c.id}`);
  assert.deepEqual(order.slice(0, 4), ["fail viewport", "fail doctype", "warn title", "warn icon"]);
});

test("each fix says what was found and what to change, short enough to send", () => {
  const generic = check(page({ title: "<title>Home</title>" }), "title")!;
  assert.ok(generic.fix?.includes('"Home"'), generic.fix ?? "");
  const alt = check(page({ body: `${BODY}<img src="https://x.example/sourdough-loaf.jpg" class="h-48">` }), "alt")!;
  assert.ok(alt.fix?.includes("https://x.example/sourdough-loaf.jpg"), alt.fix ?? "");
  assert.ok(alt.fix?.includes("1 of 1"));
  const blocking = check(page({ head: '<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>' }), "blocking")!;
  assert.ok(blocking.fix?.includes("jquery-3.7.1.min.js"));
  assert.ok(blocking.fix?.includes("Leave https://cdn.tailwindcss.com as it is"));
  const mixed = check(page({ body: `${BODY}<img src="http://x.example/loaf.jpg" alt="Loaf" class="h-48">` }), "mixed")!;
  assert.ok(mixed.fix?.includes("http://x.example/loaf.jpg"));
  // Long text from the page is clipped, and every fix stays under 450 characters.
  const long = "Golden Crumb ".repeat(60);
  const worst = page({
    title: `<title>${long}</title>`,
    description: `<meta name="description" content="${long}">`,
    lang: `lang="${"x".repeat(300)}"`,
    viewport: `<meta name="viewport" content="width=device-width, maximum-scale=1, ${"a".repeat(300)}">`,
    head: `<meta name="robots" content="noindex, ${"b".repeat(300)}"><script src="https://x.example/${"c".repeat(300)}.js"></script>`,
    body: `${'<a href="#/a-very-long-page-name-that-goes-on-and-on-and-on-and-on-and-on-and-on">x</a>'.repeat(12)}<img src="https://x.example/${"d".repeat(300)}.jpg"><p class="text-[9px]">x</p>`,
  });
  for (const c of report(worst).checks) {
    if (c.fix) assert.ok(c.fix.length <= 450, `${c.id}: ${c.fix.length}`);
    for (const value of Object.values(c.values)) if (typeof value === "string" && c.id !== "placeholders") assert.ok(value.length <= 500, `${c.id}: ${value.length}`);
  }
  assert.ok(check(worst, "title")!.fix!.includes("…"));
});

test("Fix all sends what the builder can fix, numbered, within what the chat keeps", () => {
  const weak = page({
    title: "<title>Home</title>",
    description: "",
    icon: "",
    body: `<h1>Golden Crumb</h1>${STORY}<p>Call [Phone number].</p><img src="https://x.example/loaf.jpg" class="h-48"><img src="data:image/jpeg;base64,${"A".repeat(400 * 1024)}" alt="Loaf" class="h-48">`,
  });
  const r = report(weak);
  const ids = fixableIds(r);
  assert.ok(ids.includes("title") && ids.includes("description") && ids.includes("alt") && ids.includes("icon"), ids.join());
  assert.ok(!ids.includes("placeholders"), "only the owner knows their details");
  assert.ok(!ids.includes("structured"), "tips aren't sent");
  assert.ok(!ids.includes("weight"), "nothing the builder can do");
  assert.equal(check(weak, "weight")?.problem, "pictures");
  const { context, sent, left } = fixContext(r, ids, { title: "Golden Crumb", address: ADDRESS });
  assert.ok(context.startsWith(`These points come from Flash's search check (SEO) of the published site "Golden Crumb" (${ADDRESS}).`), context.slice(0, 200));
  assert.ok(context.includes("Never invent facts"));
  assert.ok(context.includes("\n1. ") && context.includes("\n2. "));
  assert.deepEqual(sent, ids);
  assert.equal(left, 0);
  // One fix on its own.
  const one = fixContext(r, ["icon"], { title: "Golden Crumb", address: ADDRESS });
  assert.deepEqual(one.sent, ["icon"]);
  assert.ok(one.context.endsWith(`\n1. ${check(weak, "icon")!.fix}`));
  // Asking for one that can't be sent sends nothing more.
  assert.deepEqual(fixContext(r, ["placeholders", "weight"], { title: "Golden Crumb", address: ADDRESS }).sent, []);
});

test("a page where everything fails sends what fits, says how many didn't, and the chat keeps it whole", () => {
  const long = (letter: string) => letter.repeat(300);
  const worst = `<html lang="${long("x")}"><head><title>Home</title><title>${long("t")}</title>
<meta name="description" content="a"><meta name="description" content="b">
<meta name="robots" content="noindex"><meta name="viewport" content="width=device-width, user-scalable=no, ${long("v")}">
<link rel="canonical" href="https://example.com/${long("c")}">
<script type="application/ld+json">{"bad": </script>
<script src="https://x.example/${long("s")}.js"></script>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${long("f")}">
<link rel="stylesheet" href="http://x.example/${long("m")}.css">
<meta property="og:title" content="x">
</head><body>
<section data-page="home"><h2>x</h2><h4></h4>
${Array.from({ length: 10 }, (_, k) => `<a href="#/missing-page-${k}-${long("p").slice(0, 50)}"><i></i></a><a href="#/">Read more</a><a href="page-${k}.html">x</a><a href="#nowhere-${k}">x</a>`).join("")}
${Array.from({ length: 6 }, (_, k) => `<img src="https://x.example/${k}-${long("i")}.jpg" alt="IMG_${k}.jpg">`).join("")}
<p class="text-[8px]">x</p><button class="h-4 w-4"></button>
</section><section data-page="about"></section>
</body></html>`;
  const r = report(worst);
  const ids = fixableIds(r);
  assert.ok(ids.length >= 15, `${ids.length} fixable`);
  const { context, sent, left } = fixContext(r, ids, { title: "T".repeat(500), address: `${ADDRESS}${"/x".repeat(200)}` });
  assert.ok(context.length <= MAX_CONTEXT, `${context.length} characters`);
  assert.ok(left > 0, "some didn't fit");
  assert.equal(sent.length + left, ids.length);
  assert.deepEqual(sent, ids.slice(0, sent.length), "in the list's order");
  // The chat saves the instruction exactly as it was sent.
  const t = Object.assign((text: string, blanks?: Record<string, string | number>) => translate(null, text, blanks), { locale: "en-US" });
  const message = fixMessage(t, r, ids, { title: "Golden Crumb", address: ADDRESS });
  const saved = cleanUserMessage({ id: "m1", role: "user", content: message.content, build: "app", picked: { label: "SEO", context: message.context } });
  assert.deepEqual(saved?.picked, { label: "SEO", context: message.context });
  assert.equal(saved?.build, "app");
});

test("the message in the chat is in the owner's language; the instruction stays in English", () => {
  const r = report(page({ title: "<title>Home</title>", description: "", icon: "" }));
  const table = {
    "Fix what Flash's search check found on my site: {list}.": "Arregla lo que encontró la revisión de búsqueda de Flash en mi sitio: {list}.",
    "Page title": "Título de la página",
    "Page description": "Descripción de la página",
    Icon: "Icono",
  };
  const t = Object.assign((text: string, blanks?: Record<string, string | number>) => translate(table, text, blanks), { locale: "es" });
  const message = fixMessage(t, r, fixableIds(r), { title: "Golden Crumb", address: ADDRESS });
  assert.equal(message.content, "Arregla lo que encontró la revisión de búsqueda de Flash en mi sitio: Título de la página, Descripción de la página e Icono.");
  assert.ok(message.context.startsWith("These points come from Flash's search check (SEO)"));
  assert.deepEqual(message.sent, ["title", "description", "icon"]);
  // robots.txt is a file's name in every language.
  assert.equal(LABELS.robots, "robots.txt");
});

test("the facts stay small whatever the page holds", () => {
  const huge = page({
    body:
      `<section data-page="home"><h1>Golden Crumb</h1>` +
      Array.from({ length: 10_000 }, (_, k) => `<h2>Heading ${k}</h2><img src="https://x.example/${k}.jpg"><a href="#/page-${k}">x</a><a href="#spot-${k}"></a><a href="file-${k}.html">Read more</a>`).join("") +
      `</section>${Array.from({ length: 300 }, (_, k) => `<section data-page="p${k}-${"n".repeat(40)}"></section>`).join("")}`,
  });
  const facts = scanPage(huge);
  assert.ok(JSON.stringify(facts).length <= 16_000, `${JSON.stringify(facts).length} characters`);
  assert.equal(facts.imgs.total, 10_000);
  assert.equal(facts.headingCount, 10_001);
  assert.ok(facts.links.vague >= 10_000);
  assert.ok(evaluate(facts, CTX).score! < 100);
});

test("hostile pages finish quickly and never throw", () => {
  const N = 100_000;
  const fill = (start: string, unit: string) => (start + unit.repeat(Math.ceil(N / unit.length))).slice(0, N);
  const inputs: [string, string][] = [
    ["<a", fill("", "<a")],
    ['<a x="', fill('<a x="', "junk ")],
    ["<img alt=", fill("", "<img alt=")],
    ["unclosed comment", fill("<!--", "x")],
    ["unclosed script", fill("<script>", "x<")],
    ["unclosed style", fill("<style>", "a{b:c}")],
    ["unclosed svg", fill("<svg>", "<title>x")],
    ["[", fill("", "[")],
    ["[A", fill("", "[A")],
    ["<h1>", fill("", "<h1>")],
    ['<section data-page="', fill("", '<section data-page="')],
    ["50,000 page links", '<section data-page="home"></section>' + '<a href="#/x">'.repeat(50_000)],
    ["50,000 missing spots", Array.from({ length: 50_000 }, (_, k) => `<a href="#missing-${k}">`).join("")],
    ["a 100 KB attribute", `<div class="${"x ".repeat(50_000)}">`],
    ["font-size × 20,000", `<style>${"p{font-size:".repeat(20_000)}</style>`],
    ["font-size in a style attribute", `<p style="${"font-size:1px;".repeat(8_000)}">`],
    ["text-[ × 20,000", `<p class="${"text-[".repeat(20_000)}">`],
    ["ids written in a script", `<a href="#a">x</a><script>${"id=".repeat(30_000)}</script>`],
    ["nested sections", '<section data-page="a">'.repeat(30_000)],
    ["data: picture", `<img src="data:image/png;base64,${"iVBORw0KGgo".repeat(9_000)}">`],
    ["ld+json", `<script type="application/ld+json">${"[".repeat(50_000)}</script>`],
    ["entities", fill("<p>", "&#x1F600;&amp;&#99999999;")],
  ];
  for (const [name, input] of inputs) {
    const begun = performance.now();
    const facts = scanPage(input);
    evaluate(facts, CTX);
    const took = performance.now() - begun;
    assert.ok(took < 250, `${name} took ${took.toFixed(0)} ms`);
    assert.ok(JSON.stringify(facts).length <= 16_000, name);
  }
  const mix = inputs.map(([, input]) => input).join("").repeat(1);
  const two = (mix + BAKERY.repeat(200)).slice(0, 2 * 1024 * 1024);
  const begun = performance.now();
  const facts = scanPage(two);
  const took = performance.now() - begun;
  assert.ok(took < 1000, `2 MB took ${took.toFixed(0)} ms`);
  assert.equal(facts.error, undefined);
});

test("Flash's main address is added only when the page has none, and only the start of the page is read", () => {
  assert.equal(hasOwnCanonical('<link rel="canonical" href="https://crumbbakery.com/">'), true);
  assert.equal(hasOwnCanonical("<link href='https://crumbbakery.com/' rel=canonical>"), true);
  assert.equal(hasOwnCanonical('<link rel="canonicalx" href="/">'), false, "another word");
  assert.equal(hasOwnCanonical('<link rel="stylesheet" href="a.css">'), false);
  const far = `${" ".repeat(33 * 1024)}<link rel="canonical" href="https://crumbbakery.com/">`;
  assert.equal(hasOwnCanonical(far), false, "like hasOwnPreview, only the first 32 KB");
  assert.equal(hasOwnPreview(`${" ".repeat(33 * 1024)}<meta property="og:title" content="x">`), false);
  const begun = performance.now();
  hasOwnCanonical("<link ".repeat(20_000));
  assert.ok(performance.now() - begun < 250);
  // The scanner still sees a canonical further down.
  assert.equal(scanPage(page({ body: `${BODY}${" ".repeat(33 * 1024)}<link rel="canonical" href="https://example.com/">` })).ownCanonical, true);
});

test("every check's words exist, and say what they fill in", () => {
  const facts: SeoFacts = scanPage(BAKERY);
  assert.equal(facts.v, 1);
  const blanks = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const pages = [
    BAKERY,
    page({ title: "", description: "", lang: "", viewport: "", icon: "", doctype: "" }),
    page({ title: `${TITLE}${TITLE}`, description: DESCRIPTION + DESCRIPTION, head: '<link rel="canonical" href="https://a.example/"><link rel="canonical" href="https://b.example/">' }),
  ];
  for (const html of pages) {
    for (const c of report(html).checks) {
      const text = messageOf(c);
      if (!text) {
        assert.ok(c.status === "pass", `${c.id}:${c.problem} has no message`);
        continue;
      }
      for (const blank of blanks(text)) assert.ok(blank in c.values, `${c.id}:${c.problem} fills {${blank}}`);
    }
  }
});
