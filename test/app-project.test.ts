import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32 as zlibCrc32 } from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, zip } from "../src/lib/zip.ts";
import { appSlug, projectFiles, projectZip, standalonePage } from "../src/lib/app-project.ts";

const PAGE = '<!doctype html>\n<html>\n<head><title>Bakery Orders</title></head>\n<body><h1>Orders</h1></body>\n</html>';

test("checksums match the ones unzip tools expect", () => {
  for (const text of ["", "hello", "a".repeat(5000), "héllo wörld"]) {
    assert.equal(crc32(new TextEncoder().encode(text)), zlibCrc32(Buffer.from(text)), text.slice(0, 10));
  }
});

test("a zip holds every file, and real unzip tools read it", (t) => {
  const bytes = zip([
    { name: "my-app/index.html", data: PAGE },
    { name: "my-app/README.md", data: "# My app\n" },
  ]);
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04], "starts with the zip signature");
  // The end record says how many files are inside.
  const end = new DataView(bytes.buffer, bytes.byteLength - 22);
  assert.equal(end.getUint16(8, true), 2);

  const dir = mkdtempSync(join(tmpdir(), "flash-zip-"));
  writeFileSync(join(dir, "app.zip"), bytes);
  try {
    execFileSync("unzip", ["-q", "app.zip"], { cwd: dir });
  } catch (err) {
    // Without the unzip command, the signature and file-count checks above are what we have.
    t.skip(`unzip isn't available here: ${(err as Error).message}`);
    return;
  }
  assert.deepEqual(readdirSync(join(dir, "my-app")).sort(), ["README.md", "index.html"]);
  assert.equal(readFileSync(join(dir, "my-app/index.html"), "utf8"), PAGE);
});

test("the project folder opens in an editor: a page, a README, package.json", () => {
  const files = projectFiles({ title: "Bakery Orders", html: PAGE }, "https://www.flash-app.dev/p/bakery");
  assert.deepEqual(
    files.map((f) => f.name),
    ["bakery-orders/index.html", "bakery-orders/README.md", "bakery-orders/package.json", "bakery-orders/.gitignore"],
  );
  const pkg = JSON.parse(files[2].data) as { name: string; scripts: Record<string, string>; devDependencies: Record<string, string> };
  assert.equal(pkg.name, "bakery-orders");
  assert.equal(pkg.scripts.dev, "vite");
  assert.match(pkg.devDependencies.vite, /^\^\d+\./);
  const readme = files[1].data;
  assert.match(readme, /npm run dev/);
  assert.match(readme, /Cursor or VS Code/);
  assert.match(readme, /flash-app\.dev\/p\/bakery/);
  assert.ok(projectZip({ title: "Bakery Orders", html: PAGE }).length > 500);
});

test("a downloaded app runs anywhere: it brings its own flashDB", () => {
  const page = projectFiles({ title: "x", html: PAGE })[0].data;
  assert.match(page, /if \(!window\.flashDB\)/);
  assert.match(page, /window\.flashDB = \{/);
  // The stand-in goes inside <head>, before the app's own code.
  assert.ok(page.indexOf("window.flashDB") < page.indexOf("<h1>Orders</h1>"));
  assert.ok(page.includes("<h1>Orders</h1>"), "the app itself is untouched");
  // Downloading an app that was downloaded before doesn't add it twice.
  assert.equal(standalonePage(page), page);
  // A page with no head still gets it.
  assert.match(standalonePage("<h1>Hi</h1>"), /^\s*<script>/);
});

test("file names come from the title, whatever it holds", () => {
  assert.equal(appSlug("Bakery Orders"), "bakery-orders");
  assert.equal(appSlug("Café Münchën!"), "cafe-munchen");
  assert.equal(appSlug("  "), "flash-app");
  assert.equal(appSlug("../../etc/passwd"), "etc-passwd");
  assert.ok(appSlug("word ".repeat(40)).length <= 60);
  assert.ok(!appSlug("word ".repeat(40)).endsWith("-"));
});
