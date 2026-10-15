import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * Files people upload are checked by Flash's virus scanner when it's set up: an infected file is
 * refused and never stored, a clean one is remembered, and a scanner that's down lets files
 * through rather than stopping people working.
 */
process.env.DATABASE_URL = ":memory:";
delete process.env.VIRUS_SCAN_URL;
delete process.env.VIRUS_SCAN_KEY;

const { run, one } = await import("../src/lib/server/db.ts");
const { infectedFile, scannerMissing, scannerReady } = await import("../src/lib/server/virus-scan.ts");
const { saveUpload } = await import("../src/lib/server/site-files.ts");

const EICAR = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
let calls: { auth: string | undefined; size: number }[] = [];
let down = false;
const scanner = createServer((req, res) => {
  if (req.url === "/health") return res.writeHead(down ? 503 : 200).end("{}");
  const parts: Buffer[] = [];
  req.on("data", (d: Buffer) => parts.push(d));
  req.on("end", () => {
    const body = Buffer.concat(parts);
    calls.push({ auth: req.headers.authorization, size: body.length });
    if (down) return res.writeHead(503).end('{"error":"ClamAV isn\'t ready"}');
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body.includes(Buffer.from("EICAR")) ? { clean: false, virus: "Eicar-Test-Signature" } : { clean: true }));
  });
});
await new Promise<void>((done) => scanner.listen(0, "127.0.0.1", done));
const scannerUrl = `http://127.0.0.1:${(scanner.address() as AddressInfo).port}`;
const turnOn = () => {
  process.env.VIRUS_SCAN_URL = `${scannerUrl}/`;
  process.env.VIRUS_SCAN_KEY = "k".repeat(32);
};

test.after(() => scanner.close());

test("without the scanner set up, nothing is scanned", async () => {
  assert.deepEqual(scannerMissing(), ["VIRUS_SCAN_URL", "VIRUS_SCAN_KEY"]);
  assert.equal(await infectedFile([{ name: "eicar.txt", bytes: EICAR }]), null);
  assert.equal(await scannerReady(), null);
  assert.equal(calls.length, 0);
});

test("an infected file is named, with the scanner's key sent; clean files are scanned once", async () => {
  turnOn();
  calls = [];
  assert.deepEqual(scannerMissing(), []);
  assert.equal(await scannerReady(), true);
  const clean = Buffer.from("just a note");
  assert.equal(await infectedFile([{ name: "note.txt", bytes: clean }, { name: "eicar.txt", bytes: EICAR }]), "eicar.txt");
  assert.equal(calls[0].auth, `Bearer ${"k".repeat(32)}`);
  calls = [];
  assert.equal(await infectedFile([{ name: "note.txt", bytes: clean }, { name: "copy.txt", bytes: clean }]), null);
  assert.equal(await infectedFile([{ name: "note.txt", bytes: clean }]), null);
  assert.equal(calls.length, 0, "the clean file was remembered from the first scan");
  // An infected file is never remembered as clean.
  assert.equal(await infectedFile([{ name: "eicar.txt", bytes: EICAR }]), "eicar.txt");
});

test("a scanner that's down lets files through, and they're scanned again once it's back", async () => {
  turnOn();
  down = true;
  calls = [];
  try {
    const file = Buffer.from("scanned later");
    assert.equal(await infectedFile([{ name: "a.txt", bytes: file }]), null);
    assert.equal(await scannerReady(), false);
    down = false;
    assert.equal(await infectedFile([{ name: "a.txt", bytes: file }]), null);
    assert.equal(calls.length, 2);
  } finally {
    down = false;
  }
});

test("a published app refuses an infected upload and doesn't store it", async () => {
  turnOn();
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('owner', 'o@x.io', '', 0, 1)");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at, uploads_on) VALUES ('jobs', 'owner', 'Jobs', '<p>', 0, 0, 1)");
  const bad = await saveUpload("jobs", { name: "cv.txt", type: "text/plain", bytes: EICAR }, "");
  assert.equal(bad.status, 422);
  assert.match((bad.body as { error: string }).error, /virus/);
  const good = await saveUpload("jobs", { name: "cv.txt", type: "text/plain", bytes: Buffer.from("My CV") }, "");
  assert.equal(good.status, 201);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_uploads WHERE site_slug = 'jobs'"))!.n), 1);
});
