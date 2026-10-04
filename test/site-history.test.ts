import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
const { run, one } = await import("../src/lib/server/db.ts");
const { publishSite, listVersions, restoreVersion, versionHtml, MAX_VERSIONS } = await import("../src/lib/server/sites.ts");

const owner = { id: "u1", email: "o@x.co", name: "", verified_at: 1 } as never;
const stranger = { id: "u2", email: "s@x.co", name: "", verified_at: 1 } as never;
const live = async (slug: string) => (await one<{ html: string }>("SELECT html FROM sites WHERE slug = ?", [slug]))?.html;

test("updating a site keeps the version it replaces, and it can come back", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('u1', 'o@x.co', 'h', 0, 1), ('u2', 's@x.co', 'h', 0, 1)");
  const first = await publishSite(owner, { html: "<p>v1</p>", title: "Crumb" });
  assert.ok("slug" in first);
  const { slug } = first;
  assert.deepEqual(await listVersions(slug), [], "a new site has no earlier versions");

  await publishSite(owner, { html: "<p>v2</p>", title: "Crumb", slug });
  await publishSite(owner, { html: "<p>v2</p>", title: "Crumb", slug }); // no change: nothing kept
  const versions = await listVersions(slug);
  assert.equal(versions.length, 1);
  assert.equal(await versionHtml(slug, versions[0].id), "<p>v1</p>");

  // Someone else can't update it, so nothing of theirs is kept either.
  await publishSite(stranger, { html: "<p>evil</p>", title: "X", slug });
  assert.equal((await listVersions(slug)).length, 1);

  assert.equal(await restoreVersion("u1", slug, versions[0].id), true);
  assert.equal(await live(slug), "<p>v1</p>");
  const after = await listVersions(slug);
  assert.equal(after.length, 1, "v1 is live, so only the replaced v2 is listed");
  assert.equal(await versionHtml(slug, after[0].id), "<p>v2</p>", "so the restore can be undone");
  assert.equal(await restoreVersion("u2", slug, after[0].id), false, "only the owner");
  assert.equal(await restoreVersion("u1", slug, "nope"), false);

  for (let i = 3; i < 20; i++) await publishSite(owner, { html: `<p>v${i}</p>`, title: "Crumb", slug });
  const kept = await listVersions(slug);
  assert.equal(kept.length, MAX_VERSIONS);
  assert.equal(await versionHtml(slug, kept[0].id), "<p>v18</p>", "newest first");

  await run("DELETE FROM sites WHERE slug = ?", [slug]);
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_versions"))?.n, 0, "unpublishing deletes them");
});
