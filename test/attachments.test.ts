import { test } from "node:test";
import assert from "node:assert/strict";
import { addAttachment, checkFiles, MAX_FILES } from "../src/lib/attachments.ts";
import { toMessages } from "../src/lib/engines/claude.ts";

const file = (name: string, mediaType = "text/plain", bytes = 30) => ({ name, mediaType, data: "A".repeat(Math.ceil((bytes * 4) / 3)) });

test("files add up to five, one per name", () => {
  let files = [file("a.txt")];
  for (const n of ["b.pdf", "c.png", "d.csv", "e.txt"]) {
    const r = addAttachment(files, file(n));
    assert.ok("files" in r);
    files = r.files;
  }
  assert.equal(files.length, MAX_FILES);
  assert.deepEqual(addAttachment(files, file("f.txt")), { error: "You can attach up to 5 files to one message." });
  // The same name again replaces the old copy.
  const again = addAttachment(files, file("b.pdf", "application/pdf", 60));
  assert.ok("files" in again);
  assert.deepEqual(again.files.map((f) => f.name), ["a.txt", "c.png", "d.csv", "e.txt", "b.pdf"]);
});

test("audio and video go alone, and files must fit 3 MB together", () => {
  assert.match((addAttachment([file("a.txt")], file("talk.mp3", "audio/mpeg")) as { error: string }).error, /on their own/);
  assert.match((addAttachment([file("talk.mp3", "audio/mpeg")], file("a.txt")) as { error: string }).error, /on their own/);
  assert.ok("files" in addAttachment([], file("talk.mp3", "audio/mpeg")));
  const big = file("big.pdf", "application/pdf", 2 * 1024 * 1024);
  assert.match((addAttachment([big], file("b.pdf", "application/pdf", 1.5 * 1024 * 1024)) as { error: string }).error, /add up to more than 3 MB\. Send b\.pdf/);
});

test("the server checks the files it receives", () => {
  assert.equal(checkFiles(file("a"), undefined), null);
  assert.equal(checkFiles(file("a"), [file("b")]), null);
  assert.match(checkFiles(undefined, [file("b")])!, /Couldn't read/);
  assert.match(checkFiles(file("a"), "x")!, /Couldn't read/);
  assert.match(checkFiles(file("a"), [{ name: 1 }])!, /Couldn't read/);
  assert.match(checkFiles(file("a"), Array.from({ length: 5 }, (_, i) => file(`f${i}`)))!, /up to 5/);
  assert.match(checkFiles(file("a"), [file("v.mp4", "video/mp4")])!, /on their own/);
  assert.match(checkFiles(file("a", "text/plain", 2e6), [file("b", "text/plain", 2e6)])!, /3 MB/);
});

test("Claude gets every file, named in order", () => {
  const [m] = toMessages([
    {
      role: "user",
      content: "Which is cheaper?",
      attachment: { name: "quote-a.txt", mediaType: "text/plain", data: Buffer.from("A: $500").toString("base64") },
      more: [{ name: "quote-b.png", mediaType: "image/png", data: "iVBO" }],
    },
  ]);
  const blocks = m.content as { type: string; title?: string; text?: string; source?: { data: string } }[];
  assert.deepEqual(blocks.map((b) => b.type), ["document", "image", "text"]);
  assert.equal(blocks[0].source?.data, "A: $500");
  assert.equal(blocks[2].text, "Attached files, in order: quote-a.txt, quote-b.png.\n\nWhich is cheaper?");
  // One file reads as before.
  const [one] = toMessages([{ role: "user", content: "", attachment: { name: "a.txt", mediaType: "text/plain", data: "" } }]);
  assert.equal((one.content as { text?: string }[])[1].text, "Please look at this file.");
});
