import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * #126 made an owner's assistants' files count against the same storage as their apps' files. For an
 * owner with no assistants, what an app's visitors and its owner see must not change: these are the
 * answers saveUpload and uploadUse gave before #126 (e62adb7), step by step, and this test passes
 * with that commit's site-files.ts in place of today's too. The one difference is two files sent at
 * the same moment that together would go past the owner's room: the second is now refused (the last
 * test), where before both were kept.
 */
process.env.DATABASE_URL = ":memory:";

// A stand-in virus scanner: every file is clean. While `holdFor` is set it answers no scan until
// that many have come in, so files sent together are all checked before any of them is kept.
let holdFor = 0;
const waiting: (() => void)[] = [];
const scanner = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const answer = () => res.writeHead(200, { "content-type": "application/json" }).end('{"clean":true}');
    if (!holdFor) return answer();
    waiting.push(answer);
    if (waiting.length >= holdFor) waiting.splice(0).forEach((go) => go());
  });
});
await new Promise<void>((r) => scanner.listen(0, "127.0.0.1", r));
after(() => scanner.close());
process.env.VIRUS_SCAN_URL = `http://127.0.0.1:${(scanner.address() as AddressInfo).port}`;
process.env.VIRUS_SCAN_KEY = "k".repeat(32);

const { run, one, all } = await import("../src/lib/server/db.ts");
const { saveUpload, uploadUse, setUploadsOn, FREE_STORAGE_BYTES, MAX_BYTES_PER_SITE, MAX_FILES_PER_SITE, USED_STORAGE_SQL } = await import(
  "../src/lib/server/site-files.ts"
);

const MB = 1024 * 1024;
let bytesSeed = 0;
// A file of `size` bytes, each one different, so none is taken for one already scanned.
const file = (size: number, name = "photo.png", type = "image/png") => {
  const bytes = Buffer.alloc(size, ++bytesSeed % 251);
  if (size >= 4) bytes.writeUInt32BE(bytesSeed, 0);
  return { name, type, bytes };
};
// A saveUpload answer as it reads, with the file's new random id taken out.
const send = async (slug: string, f: ReturnType<typeof file>, owner = "") => {
  const r = await saveUpload(slug, f, owner);
  const body = "url" in r.body ? { ...r.body, url: r.body.url.replace(/[^/]+$/, "ID") } : r.body;
  return { status: r.status, body };
};
// Files already in an app, put straight in the database: `count` of them, `size` bytes each.
let held = 0;
const holds = async (slug: string, count: number, size: number) => {
  for (let i = 0; i < count; i++) {
    await run("INSERT INTO site_uploads (id, site_slug, owner, mime, name, data, size, created_at) VALUES (?, ?, '', 'image/png', 'old.png', x'00', ?, 0)", [
      `held-${++held}`,
      slug,
      size,
    ]);
  }
};
const DAY = 86_400_000;
const plan = (user: string, id: string, paidUntil: number) =>
  run(
    "INSERT INTO subscriptions (id, user_id, plan, interval, status, amount_cents, anchor, paid_until, test, created_at, updated_at) VALUES (?, ?, ?, 'month', 'active', 0, 0, ?, 1, 0, 0)",
    [`sub-${user}`, user, id, paidUntil],
  );

test("with no assistants, saveUpload and uploadUse answer as they did before #126", async () => {
  for (const u of ["ann", "bo", "cy", "dee"]) {
    await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES (?, ?, '', 0, 1)", [u, `${u}@x.io`]);
  }
  // ann: free plan, two apps. bo: a paid plan, so each app's own 100 MB is what stops it. cy: a plan
  // that ran out, so the free room. dee: free, already holding more than the free room (after a
  // plan ended).
  await plan("bo", "lite", Date.now() + 30 * DAY);
  await plan("cy", "pro", Date.now() - DAY);
  const apps: [string, string, number][] = [
    ["ann-a", "ann", 1],
    ["ann-b", "ann", 1],
    ["ann-off", "ann", 0],
    ["bo-a", "bo", 1],
    ["bo-b", "bo", 1],
    ["cy-a", "cy", 1],
    ["dee-a", "dee", 1],
  ];
  for (const [slug, user, on] of apps) {
    await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at, uploads_on) VALUES (?, ?, 'App', '<p>', 0, 0, ?)", [slug, user, on]);
  }
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM assistant_files"))?.n), 0);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM assistants"))?.n), 0);

  const seen: [string, unknown][] = [];
  const step = async (label: string, answer: Promise<unknown>) => void seen.push([label, await answer]);

  await step("empty app", uploadUse("ann-a"));
  await step("no such app", uploadUse("nobody"));
  await step("paid plan, empty", uploadUse("bo-a"));
  await step("plan ran out, empty", uploadUse("cy-a"));
  await step("a photo", send("ann-a", file(2048, "My Holiday!.JPG", "image/jpeg"), "visitor-1"));
  await step("a PDF", send("ann-a", file(3000, "cv", "application/pdf")));
  await step("a CSV", send("ann-a", file(10, "sales.csv", "text/csv")));
  await step("a page that runs", send("ann-a", file(10, "x.html", "text/html")));
  await step("an empty file", send("ann-a", file(0)));
  await step("over 5 MB", send("ann-a", file(5 * MB + 1)));
  await step("files off", send("ann-off", file(10)));
  await step("no such app", send("nobody", file(10)));
  await step("after three files", uploadUse("ann-a"));
  await step("files off, use", uploadUse("ann-off"));

  // ann's other app holds all but 1,000 bytes of what's left of her room.
  await holds("ann-b", 1, FREE_STORAGE_BYTES - 5058 - 1000);
  await step("room left, ann-a", uploadUse("ann-a"));
  await step("room left, ann-b", uploadUse("ann-b"));
  await step("a byte past the owner's room", send("ann-a", file(1001)));
  await step("exactly the owner's room", send("ann-a", file(1000)));
  await step("full, one byte", send("ann-a", file(1)));
  await step("full, ann-a", uploadUse("ann-a"));
  await step("full, ann-b", uploadUse("ann-b"));
  await step("full, other app", send("ann-b", file(1)));

  // bo's plan has room for more, but one app holds at most MAX_BYTES_PER_SITE and MAX_FILES_PER_SITE.
  await holds("bo-a", 24, 4 * MB);
  await holds("bo-a", 1, MAX_BYTES_PER_SITE - 96 * MB - 10);
  await step("app's own bytes nearly full", uploadUse("bo-a"));
  await step("a byte past the app's own", send("bo-a", file(11)));
  await step("exactly the app's own", send("bo-a", file(10)));
  await step("app's own bytes full", uploadUse("bo-a"));
  await holds("bo-b", MAX_FILES_PER_SITE - 1, 1);
  await step("one file short of the app's most", uploadUse("bo-b"));
  await step("the last file", send("bo-b", file(5)));
  await step("one file too many", send("bo-b", file(5)));
  await step("as many files as it holds", uploadUse("bo-b"));

  // cy's plan ran out: the free room.
  await holds("cy-a", 1, FREE_STORAGE_BYTES - 100);
  await step("plan ran out, nearly full", uploadUse("cy-a"));
  await step("plan ran out, over", send("cy-a", file(101)));
  await step("plan ran out, fits", send("cy-a", file(100)));

  // dee holds more than the free room already.
  await holds("dee-a", 1, FREE_STORAGE_BYTES + 50 * MB);
  await step("past the room already", uploadUse("dee-a"));
  await step("past the room already, send", send("dee-a", file(1)));

  // Turning files off, then on again.
  await setUploadsOn("ann-a", false);
  await step("turned off", send("ann-a", file(1)));
  await step("turned off, use", uploadUse("ann-a"));
  await setUploadsOn("ann-a", true);
  await step("on again, still full", send("ann-a", file(1)));

  const kept = await all<{ site_slug: string; n: number; bytes: number }>(
    "SELECT site_slug, COUNT(*) AS n, SUM(size) AS bytes FROM site_uploads GROUP BY site_slug ORDER BY site_slug",
  );
  seen.push(["kept", kept.map((r) => [r.site_slug, Number(r.n), Number(r.bytes)])]);

  const full = { error: "This app can't hold more files. Its owner can remove some in Flash." };
  const notFound = { error: "App not found." };
  const off = { error: "This app isn't taking files yet. Its owner can turn that on in Flash, in My websites & apps > Files." };
  const use = (files: number, bytes: number, maxBytes: number) => ({ files, bytes, maxFiles: MAX_FILES_PER_SITE, maxBytes });
  const saved = (slug: string, name: string, size: number) => ({ status: 201, body: { url: `/api/sites/${slug}/files/ID`, name, size } });
  // What e62adb7 gave for each step.
  const before: [string, unknown][] = [
    ["empty app", use(0, 0, 100 * MB)],
    ["no such app", use(0, 0, 100 * MB)],
    ["paid plan, empty", use(0, 0, 100 * MB)],
    ["plan ran out, empty", use(0, 0, 100 * MB)],
    ["a photo", saved("ann-a", "My Holiday.JPG", 2048)],
    ["a PDF", saved("ann-a", "cv.pdf", 3000)],
    ["a CSV", saved("ann-a", "sales.csv", 10)],
    ["a page that runs", { status: 415, body: { error: "Apps can take pictures, PDFs and text files." } }],
    ["an empty file", { status: 400, body: { error: "That file is empty." } }],
    ["over 5 MB", { status: 413, body: { error: "Files must be 5 MB or smaller." } }],
    ["files off", { status: 403, body: off }],
    ["no such app", { status: 404, body: notFound }],
    ["after three files", use(3, 5058, 100 * MB)],
    ["files off, use", use(0, 0, 100 * MB - 5058)],
    ["room left, ann-a", use(3, 5058, 6058)],
    ["room left, ann-b", use(1, FREE_STORAGE_BYTES - 6058, FREE_STORAGE_BYTES - 5058)],
    ["a byte past the owner's room", { status: 507, body: full }],
    ["exactly the owner's room", saved("ann-a", "photo.png", 1000)],
    ["full, one byte", { status: 507, body: full }],
    ["full, ann-a", use(4, 6058, 6058)],
    ["full, ann-b", use(1, FREE_STORAGE_BYTES - 6058, FREE_STORAGE_BYTES - 6058)],
    ["full, other app", { status: 507, body: full }],
    ["app's own bytes nearly full", use(25, MAX_BYTES_PER_SITE - 10, MAX_BYTES_PER_SITE)],
    ["a byte past the app's own", { status: 507, body: full }],
    ["exactly the app's own", saved("bo-a", "photo.png", 10)],
    ["app's own bytes full", use(26, MAX_BYTES_PER_SITE, MAX_BYTES_PER_SITE)],
    ["one file short of the app's most", use(MAX_FILES_PER_SITE - 1, MAX_FILES_PER_SITE - 1, MAX_BYTES_PER_SITE)],
    ["the last file", saved("bo-b", "photo.png", 5)],
    ["one file too many", { status: 507, body: full }],
    ["as many files as it holds", use(MAX_FILES_PER_SITE, MAX_FILES_PER_SITE + 4, MAX_BYTES_PER_SITE)],
    ["plan ran out, nearly full", use(1, FREE_STORAGE_BYTES - 100, FREE_STORAGE_BYTES)],
    ["plan ran out, over", { status: 507, body: full }],
    ["plan ran out, fits", saved("cy-a", "photo.png", 100)],
    ["past the room already", use(1, FREE_STORAGE_BYTES + 50 * MB, FREE_STORAGE_BYTES + 50 * MB)],
    ["past the room already, send", { status: 507, body: full }],
    ["turned off", { status: 403, body: off }],
    ["turned off, use", use(4, 6058, 6058)],
    ["on again, still full", { status: 507, body: full }],
    [
      "kept",
      [
        ["ann-a", 4, 6058],
        ["ann-b", 1, FREE_STORAGE_BYTES - 6058],
        ["bo-a", 26, MAX_BYTES_PER_SITE],
        ["bo-b", MAX_FILES_PER_SITE, MAX_FILES_PER_SITE + 4],
        ["cy-a", 2, FREE_STORAGE_BYTES],
        ["dee-a", 1, FREE_STORAGE_BYTES + 50 * MB],
      ],
    ],
  ];
  assert.deepEqual(seen, before);
});

test("the storage counts read only an index, never the files' bytes, so an upload doesn't read every file its owner holds", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/lib/server/site-files.ts", import.meta.url), "utf8");
  // Each app's own count (saveUpload, uploadUse) and the owner's (usedStorage, and saveUpload's INSERT again).
  const counts = [...source.matchAll(/"(SELECT COUNT\([^"]*SUM\([^"]*site_uploads[^"]*)"/g)].map((m) => m[1]);
  assert.equal(counts.length, 2, counts.join("\n"));
  for (const sql of [...counts, `SELECT ${USED_STORAGE_SQL}`]) {
    const plan = await all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, Array(sql.split("?").length - 1).fill("x"));
    const reads = plan.map((r) => r.detail).filter((d) => /\b(u|site_uploads)\b/.test(d.split(" USING ")[0]));
    assert.ok(reads.length, `${sql}: ${JSON.stringify(plan)}`);
    for (const read of reads) assert.match(read, /USING COVERING INDEX site_uploads_size/, sql);
  }
});

test("two files sent at once that together pass the owner's room: one is kept, the other refused as full (before #126 both were kept)", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('eve', 'eve@x.io', '', 0, 1)");
  for (const slug of ["eve-a", "eve-b"]) {
    await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at, uploads_on) VALUES (?, 'eve', 'App', '<p>', 0, 0, 1)", [slug]);
  }
  await holds("eve-b", 1, FREE_STORAGE_BYTES - 1500);
  // Each fits the 1,500 bytes left on its own, and both are checked before either is kept.
  holdFor = 2;
  const answers = await Promise.all([send("eve-a", file(1000)), send("eve-b", file(1000))]);
  holdFor = 0;
  assert.deepEqual(answers.map((a) => a.status).sort(), [201, 507]);
  const used = await one<{ bytes: number }>("SELECT SUM(u.size) AS bytes FROM site_uploads u JOIN sites s ON s.slug = u.site_slug WHERE s.user_id = 'eve'");
  assert.equal(Number(used?.bytes), FREE_STORAGE_BYTES - 500, "the owner's files stay within their room");
});
