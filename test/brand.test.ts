import { test } from "node:test";
import assert from "node:assert/strict";
import { brandForMedia, brandLines, cleanBrand, hasBrand, withBrand, EMPTY_BRAND } from "../src/lib/brand.ts";

process.env.DATABASE_URL = ":memory:";
const { run } = await import("../src/lib/server/db.ts");
const { getBrand, saveBrand, logoProblem } = await import("../src/lib/server/brand.ts");
const { listFiles } = await import("../src/lib/server/files.ts");
const { publicFile } = await import("../src/lib/server/connector.ts");

const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");

test("a brand kit is cleaned: short text, real colours, no repeats", () => {
  const kit = cleanBrand({ name: "  Golden   Crumb ", tagline: 7, voice: " Warm. ", colors: ["#C8102E", "#fff", "red", "#c8102e", "#123456", "#000000", "#111111", "#222222"] });
  assert.deepEqual(kit, { name: "Golden Crumb", tagline: "", voice: "Warm.", colors: ["#c8102e", "#ffffff", "#123456", "#000000", "#111111"] });
  assert.equal(hasBrand(EMPTY_BRAND), false);
  assert.equal(hasBrand({ ...EMPTY_BRAND, colors: ["#000000"] }), true);
});

test("the brand kit joins Flash's instructions only when there is one", () => {
  assert.equal(withBrand("I bake.", EMPTY_BRAND), "I bake.");
  const kit = { name: "Golden Crumb", tagline: "Fresh daily", voice: "Warm", colors: ["#c8102e"], logo: "https://flash.test/f/abc" };
  const text = withBrand("I bake.", kit);
  assert.match(text, /^I bake\.\n\nThe user's brand kit\. Use it for anything made for their business/);
  assert.match(text, /Business name: Golden Crumb\nTagline: Fresh daily\nBrand colours: #c8102e \(main colour first\)\nTone of voice: Warm\nLogo image .*: https:\/\/flash\.test\/f\/abc$/);
  assert.equal(brandLines({ ...EMPTY_BRAND, name: "X" }), "Business name: X");
  assert.match(brandForMedia(kit), /only if\) this is for the user's business[\s\S]*\nBusiness: Golden Crumb\nColours: #c8102e\nStyle: Warm$/);
  assert.equal(brandForMedia(EMPTY_BRAND), "");
});

test("logos must be small PNG, JPEG or WebP pictures", () => {
  assert.equal(logoProblem({ mediaType: "image/png", data: PNG }), null);
  assert.match(logoProblem({ mediaType: "image/svg+xml", data: PNG })!, /PNG, JPEG or WebP/);
  assert.match(logoProblem({ mediaType: "image/png", data: "A".repeat(1_500_000) })!, /1 MB/);
});

test("the brand kit is saved with a public logo link, kept or replaced", async () => {
  await run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'a@b.c', 'A', 'x', 0)");
  assert.deepEqual(await getBrand("u1", "https://flash.test"), EMPTY_BRAND);
  await saveBrand("u1", { name: "Golden Crumb", colors: ["#c8102e"] }, { mediaType: "image/png", data: PNG });
  const first = await getBrand("u1", "https://flash.test");
  assert.equal(first.name, "Golden Crumb");
  assert.match(first.logo, /^https:\/\/flash\.test\/f\/[\w-]+$/);
  const link = first.logo.split("/f/")[1];
  assert.equal((await publicFile(link))?.mime, "image/png", "anyone can open the logo");
  assert.deepEqual(await listFiles("u1"), [], "the logo isn't one of My creations");
  // Leaving the logo out keeps it.
  await saveBrand("u1", { name: "Golden Crumb Bakery" }, undefined);
  const kept = await getBrand("u1", "https://flash.test");
  assert.equal(kept.logo, first.logo);
  assert.deepEqual(kept.colors, []);
  // Removing it clears the kit's logo, but sites already published keep theirs.
  await saveBrand("u1", { name: "Golden Crumb Bakery" }, null);
  assert.equal((await getBrand("u1", "https://flash.test")).logo, "");
  assert.ok(await publicFile(link));
});
