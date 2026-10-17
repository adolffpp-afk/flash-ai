import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
const { sitePreview, previewTags, hasOwnPreview, hasOwnCanonical, canonicalTag } = await import("../src/lib/site-preview.ts");
const { run } = await import("../src/lib/server/db.ts");
const { serveSite } = await import("../src/lib/server/serve-site.ts");

const BAKERY = `<!doctype html><html><head><title>Golden Crumb Bakery &amp; Café</title>
<meta name="description" content="Fresh bread, cakes and croissants in Montréal."></head><body>
<img src="https://cdn.example/logo.svg"><img src="data:image/png;base64,xx">
<img class="hero" src="https://v3.fal.media/files/cake.jpg?x=1&amp;y=2"><p>Short.</p></body></html>`;

test("a site's title, description and first real picture make its share card", () => {
  assert.deepEqual(sitePreview(BAKERY), {
    title: "Golden Crumb Bakery & Café",
    description: "Fresh bread, cakes and croissants in Montréal.",
    image: "https://v3.fal.media/files/cake.jpg?x=1&y=2",
  });
  const bare = sitePreview("<p>Hi</p><p>We bake <b>sourdough</b> every morning before sunrise, just for you.</p>");
  assert.deepEqual(bare, { title: "Made with Flash", description: "We bake sourdough every morning before sunrise, just for you.", image: null });
  assert.equal(sitePreview("<title>Home · Golden Crumb</title>").title, "Golden Crumb");
  assert.equal(sitePreview(`<title>${"Long ".repeat(40)}</title>`).title.length <= 90, true);
});

test("the card's tags are escaped, and a site's own card wins", () => {
  const tags = previewTags({ title: 'Say "hi" <now>', description: "", image: null }, "https://crumb.com/", "https://www.flash-app.dev/p/x/card");
  assert.match(tags, /property="og:title" content="Say &quot;hi&quot; &lt;now&gt;"/);
  assert.match(tags, /property="og:image" content="https:\/\/www.flash-app.dev\/p\/x\/card"/);
  assert.match(tags, /name="twitter:card" content="summary_large_image"/);
  assert.doesNotMatch(tags, /og:description/);
  assert.equal(hasOwnPreview('<meta property="og:title" content="Mine">'), true);
  assert.equal(hasOwnPreview(BAKERY), false);
});

test("published pages carry the card, with the address they were opened at", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'o@x.co', 'h', 0)");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('crumb-1', 'u1', 'Crumb', ?, 0, 0)", [BAKERY]);
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('own-1', 'u1', 'Own', ?, 0, 0)", [
    '<head><meta property="og:title" content="Mine"></head>',
  ]);
  const page = await (await serveSite("crumb-1", "https://crumbbakery.com/")).text();
  assert.match(page, /<head><meta property="og:type" content="website">/);
  assert.match(page, /property="og:url" content="https:\/\/crumbbakery.com\/"/);
  assert.match(page, /property="og:image" content="https:\/\/v3.fal.media\/files\/cake.jpg\?x=1&amp;y=2"/);
  const own = await (await serveSite("own-1", "https://x/")).text();
  assert.equal(own.match(/og:title/g)?.length, 1, "the site's own card is left alone");
  assert.doesNotMatch(await (await serveSite("crumb-1")).text(), /og:title/);
});

test("a page's main address for search engines comes first, escaped, unless the page names its own", async () => {
  assert.equal(canonicalTag('https://crumb.com/?a=1&b="2"><script>'), '<link rel="canonical" href="https://crumb.com/?a=1&amp;b=&quot;2&quot;&gt;&lt;script&gt;">');
  const page = await (await serveSite("crumb-1", "https://crumbbakery.com/", undefined, "https://crumbbakery.com/")).text();
  assert.match(page, /<head><link rel="canonical" href="https:\/\/crumbbakery.com\/"><meta property="og:type" content="website">/);
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('named-1', 'u1', 'Named', ?, 0, 0)", [
    '<head><link rel="canonical" href="https://crumbbakery.com/"></head><body><p>Hi</p></body>',
  ]);
  assert.equal(hasOwnCanonical(BAKERY), false);
  const named = await (await serveSite("named-1", "https://x/", undefined, "https://www.flash-app.dev/p/named-1")).text();
  assert.equal(named.match(/rel="canonical"/g)?.length, 1, "the page's own is left alone");
  assert.doesNotMatch(named, /flash-app\.dev\/p\/named-1"/);
  assert.doesNotMatch(await (await serveSite("crumb-1", "https://x/")).text(), /rel="canonical"/, "only when asked");
});
