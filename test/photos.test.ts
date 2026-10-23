import { test } from "node:test";
import assert from "node:assert/strict";

const { fillPhotos, photosOn } = await import("../src/lib/server/photos.ts");
const { buildSystem } = await import("../src/lib/engines/builder.ts");

const shot = (id: number, name = `Ana ${id}`) => ({
  urls: { raw: `https://images.unsplash.com/photo-${id}?ixid=abc&ixlib=rb-4.0.3` },
  user: { name, links: { html: `https://unsplash.com/@ana${id}` } },
  links: { download_location: `https://api.unsplash.com/photos/${id}/download?ixid=abc` },
});

function withUnsplash(answer: (url: URL) => { status: number; results?: unknown[] }) {
  const asked: URL[] = [];
  const counted: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/download")) {
      counted.push(url.pathname);
      return new Response("{}");
    }
    asked.push(url);
    const a = answer(url);
    return new Response(JSON.stringify({ results: a.results ?? [] }), { status: a.status });
  }) as typeof fetch;
  return { asked, counted, restore: () => (globalThis.fetch = real) };
}

test("photos are only promised to the builder when Flash has a photo key", () => {
  delete process.env.UNSPLASH_ACCESS_KEY;
  delete process.env.PEXELS_API_KEY;
  assert.equal(photosOn(), false);
  assert.doesNotMatch(buildSystem("app", ""), /flash-photo:/);
  process.env.UNSPLASH_ACCESS_KEY = "test-key";
  assert.match(buildSystem("app", ""), /flash-photo:black-smartwatch-on-dark-background/);
});

test("each flash-photo: becomes a real photo, a new one each time the same words come back, with its photographer named", async () => {
  process.env.UNSPLASH_ACCESS_KEY = "test-key";
  const api = withUnsplash((url) => ({ status: 200, results: url.searchParams.get("query") === "red sneaker" ? [shot(1), shot(2, "Bo & Co")] : [shot(9)] }));
  try {
    const html = `<html><body><img src="flash-photo:red-sneaker" alt="a"><img src="flash-photo:red-sneaker" alt="b"><div style="background-image:url('flash-photo:city-street-at-night~portrait')"></div><script>const items=[{img:"flash-photo:red-sneaker"}]</script></body></html>`;
    const out = await fillPhotos(html);
    assert.doesNotMatch(out, /flash-photo:/);
    const ids = [...out.matchAll(/https:\/\/images\.unsplash\.com\/photo-(\d+)/g)].map((m) => m[1]);
    assert.deepEqual(ids, ["1", "2", "9", "1"]);
    assert.match(out, /photo-9\?ixid=abc&ixlib=rb-4\.0\.3&w=900&h=1350&fit=crop/, "a portrait photo is cut to its shape");
    const portrait = api.asked.find((u) => u.searchParams.get("query") === "city street at night");
    assert.equal(portrait?.searchParams.get("orientation"), "portrait");
    assert.equal(api.asked.length, 2, "one search per set of words");
    assert.equal(api.counted.length, 3, "each photo used is counted once");
    assert.match(out, /<details data-flash-credits[^>]*><summary[^>]*>Photo credits<\/summary>Photos by <a href="https:\/\/unsplash\.com\/@ana1\?utm_source=flash[^"]*"[^>]*>Ana 1<\/a>, <a[^>]*>Bo &amp; Co<\/a>, <a[^>]*>Ana 9<\/a> on <a[^>]*>Unsplash<\/a><\/details>\n<\/body>/);

    // A change that adds a photo keeps the photographers already named.
    const changed = await fillPhotos(out.replace("</script>", "</script><img src=\"flash-photo:quiet-lake\">"));
    assert.equal(changed.match(/data-flash-credits/g)?.length, 1);
    assert.match(changed, /Ana 1<\/a>, <a[^>]*>Bo &amp; Co<\/a>, <a[^>]*>Ana 9<\/a>/);

    // In an app with a footer, the credit goes at its end; an older app's line of its own is replaced.
    const old = `<html><body><main><img src="flash-photo:quiet-lake"></main><footer><p>© Shop</p></footer>\n<p data-flash-credits style="x">Photos by <a href="https://unsplash.com/@ana1?utm_source=flash">Ana 1</a> on <a href="https://unsplash.com/">Unsplash</a></p>\n</body></html>`;
    const footed = await fillPhotos(old);
    assert.equal(footed.match(/data-flash-credits/g)?.length, 1);
    assert.match(footed, /<p>© Shop<\/p>\n<details data-flash-credits[\s\S]*Ana 1[\s\S]*<\/details>\n<\/footer>/);
  } finally {
    api.restore();
  }
});

test("a photo that can't be found leaves a calm stand-in, never a broken picture", async () => {
  process.env.UNSPLASH_ACCESS_KEY = "test-key";
  const api = withUnsplash(() => ({ status: 429 }));
  try {
    const out = await fillPhotos(`<img src="flash-photo:quiet-mountain-lake~square">`);
    assert.match(out, /^<img src="data:image\/svg\+xml,[^"]+">$/);
    assert.match(decodeURIComponent(out), /width="1000" height="1000"/);
  } finally {
    api.restore();
  }
  assert.equal(await fillPhotos("<p>No photos here</p>"), "<p>No photos here</p>");
});

test("only Unsplash's own photo addresses are put in an app", async () => {
  process.env.UNSPLASH_ACCESS_KEY = "test-key";
  const api = withUnsplash(() => ({ status: 200, results: [{ ...shot(3), urls: { raw: "https://evil.example/x.jpg?a=1" } }, { ...shot(4), urls: { raw: 'https://images.unsplash.com/photo-4?x=")' } }] }));
  try {
    const out = await fillPhotos(`<img src="flash-photo:fresh-bread-loaf">`);
    assert.doesNotMatch(out, /evil|photo-4/);
    assert.match(out, /data:image\/svg\+xml/);
  } finally {
    api.restore();
  }
});

test("every build gets Flash's design system, with a palette that fits the request", async () => {
  const { PALETTES, designGuide, paletteFor } = await import("../src/lib/design-system.ts");
  assert.match(buildSystem("app", ""), /Flash's design system/);
  assert.match(buildSystem("slides", ""), /Midnight premium/);
  assert.equal(paletteFor("a website for a phone and gadget shop").id, "midnight");
  assert.equal(paletteFor("my dental clinic").id, "clinic");
  assert.equal(paletteFor("something nobody planned for").id, "electric");
  for (const p of PALETTES) {
    for (const c of Object.values(p.colors)) assert.match(c, /^#[0-9a-f]{6}$/, p.id);
    assert.ok(designGuide().includes(p.colors.accent), p.id);
  }
});

test("the Suggestions row reads the builder's ideas for what to add next", async () => {
  const { nextIdeas } = await import("../src/lib/build-parse.ts");
  assert.deepEqual(nextIdeas("Ideas:\n- **Add card payments** at checkout.\n* Add a blog\n1. Add a loyalty programme\n- Add a loyalty programme\n- x\n- Add reviews\n- Add a fifth"), [
    "Add card payments at checkout",
    "Add a blog",
    "Add a loyalty programme",
    "Add reviews",
  ]);
  assert.deepEqual(nextIdeas(undefined), []);
  assert.deepEqual(nextIdeas("Just a sentence."), []);
});
