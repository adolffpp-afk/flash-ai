import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { inlineRuns, markdownToWordXml, wordDocument, wordFileName } from "../src/lib/word-export.ts";
import { officeText, readZip } from "../src/lib/office.ts";

const inflate = async (d: Uint8Array) => new Uint8Array(inflateRawSync(d));

const PLAN = `# Bakery plan

Golden Crumb sells **fresh bread** and *pastries* in Montréal.
We open at 7am.

## Prices

| Item | Price |
|---|---|
| Croissant | $3.50 |
| Cake & tea | $25 |

1. Bake
2. Sell
- [x] Rent a shop
- Hire a baker, see [our site](https://crumb.com)

> Bread is life.

\`\`\`
total = 3.5 * 40
\`\`\``;

test("a reply becomes a Word document that opens and reads back", async () => {
  const file = wordDocument(PLAN);
  const parts = await readZip(file, () => true, inflate);
  assert.deepEqual([...parts.keys()], ["[Content_Types].xml", "_rels/.rels", "word/_rels/document.xml.rels", "word/document.xml", "word/styles.xml"]);
  const text = await officeText(file, "docx", inflate);
  assert.equal(
    text,
    [
      "Bakery plan",
      "Golden Crumb sells fresh bread and pastries in Montréal. We open at 7am.",
      "Prices",
      "Item", "Price", "Croissant", "$3.50", "Cake & tea", "$25",
      "",
      "1.\tBake",
      "2.\tSell",
      "☑\tRent a shop",
      "•\tHire a baker, see our site (https://crumb.com)",
      "Bread is life.",
      "total = 3.5 * 40",
    ].join("\n"),
  );
});

test("headings use Word's heading styles, and the XML is escaped", () => {
  const xml = markdownToWordXml("# Title\n### Small <b>\n#### Smaller");
  assert.match(xml, /<w:pStyle w:val="Heading1"\/>/);
  assert.match(xml, /<w:pStyle w:val="Heading3"\/><\/w:pPr><w:r><w:t xml:space="preserve">Small &lt;b&gt;/);
  assert.equal((xml.match(/Heading3/g) ?? []).length, 2, "#### and deeper use the smallest heading");
});

test("bold, italic, code and snake_case", () => {
  const xml = inlineRuns("a **b** *c* `d` my_file_name __e__");
  assert.match(xml, /<w:b\/><\/w:rPr><w:t xml:space="preserve">b</);
  assert.match(xml, /<w:i\/><\/w:rPr><w:t xml:space="preserve">c</);
  assert.match(xml, /Consolas"\/><\/w:rPr><w:t xml:space="preserve">d</);
  assert.match(xml, /my_file_name/);
  assert.match(xml, /<w:b\/><\/w:rPr><w:t xml:space="preserve">e</);
});

test("the file is named after the reply's first line", () => {
  assert.equal(wordFileName("# Bakery plan: 2027\nmore"), "Bakery plan 2027.docx");
  assert.equal(wordFileName("**Dear Ana,**"), "Dear Ana,.docx");
  assert.equal(wordFileName("\n\n"), "Flash reply.docx");
});
