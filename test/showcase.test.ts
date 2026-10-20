import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
process.env.FLASH_ADMIN_EMAILS = "boss@x.co";
const { run, one } = await import("../src/lib/server/db.ts");
const { saveFile, listFiles, deleteFile } = await import("../src/lib/server/files.ts");
const { unpublishSite } = await import("../src/lib/server/sites.ts");
const { setShowcase, showcaseFor, publicShowcase, showcasePicture, adminShowcase, decideShowcase } = await import("../src/lib/server/showcase.ts");

const owner = { id: "u1", email: "a@x.co", verified_at: 1 };
const other = { id: "u2", email: "b@x.co", verified_at: 1 };
const boss = { id: "u3", email: "boss@x.co", verified_at: 1 };

test("nothing shows in the showcase until it's offered and approved, and taking it back or deleting it removes it", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('u1', 'a@x.co', 'h', 0, 1), ('u2', 'b@x.co', 'h', 0, 1), ('u3', 'boss@x.co', 'h', 0, 1)");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('shop-ab12', 'u1', 'My Shop', '<p>hi</p>', 0, 0), ('mine-cd34', 'u3', 'Boss App', '<p>hi</p>', 0, 0)");
  const pic = (await saveFile("u1", "image/png", "sunset.png", Buffer.from("PNG"))).split("/").pop()!;
  const svg = (await saveFile("u1", "image/svg+xml", "logo.svg", Buffer.from("<svg/>"))).split("/").pop()!;

  assert.deepEqual(await publicShowcase(), { sites: [], pictures: [] });
  assert.equal(await setShowcase(other, "site", "shop-ab12", true), null, "only the owner can offer their app");
  assert.equal(await setShowcase(owner, "picture", svg, true), null, "SVG pictures can't be offered");

  assert.deepEqual(await setShowcase(owner, "site", "shop-ab12", true), { on: true, status: "waiting" });
  assert.deepEqual(await setShowcase(owner, "picture", pic, true), { on: true, status: "waiting" });
  assert.equal((await listFiles("u1")).find((f) => f.id === pic)?.showcase, "waiting");
  assert.deepEqual(await publicShowcase(), { sites: [], pictures: [] }, "offered isn't shown");
  assert.equal(await showcasePicture(pic), null);

  assert.deepEqual(await setShowcase(boss, "site", "mine-cd34", true), { on: true, status: "shown" }, "the owner of Flash's own show at once");
  assert.equal((await adminShowcase())[0].status, "waiting", "waiting first");

  assert.equal(await decideShowcase("site", "shop-ab12", "shown"), true);
  assert.equal(await decideShowcase("picture", pic, "shown"), true);
  const list = await publicShowcase();
  assert.deepEqual(list.sites.map((s) => s.slug).sort(), ["mine-cd34", "shop-ab12"]);
  assert.deepEqual(list.pictures, [{ id: pic, title: "sunset" }]);
  assert.ok(await showcasePicture(pic));

  await decideShowcase("picture", pic, "hidden");
  assert.equal(await showcasePicture(pic), null, "hidden stops at once");
  await setShowcase(owner, "picture", pic, true);
  assert.equal((await showcaseFor("u1", "picture", pic))?.status, "hidden", "offering again doesn't undo a hide");

  await setShowcase(owner, "site", "shop-ab12", false);
  assert.deepEqual((await publicShowcase()).sites.map((s) => s.slug), ["mine-cd34"], "taken back by its owner");

  assert.equal(await unpublishSite("u3", "mine-cd34"), true);
  assert.equal(await one("SELECT 1 FROM showcase WHERE ref = 'mine-cd34'"), null, "unpublishing removes it");
  await deleteFile("u1", pic);
  assert.equal(await one("SELECT 1 FROM showcase WHERE ref = ?", [pic]), null, "deleting the picture removes it");
  assert.deepEqual(await adminShowcase(), []);
});
