import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { runsOf, slidesDeck, slidesOf } from "../src/lib/slides-export.ts";
import { officeText } from "../src/lib/office.ts";

const inflate = async (d: Uint8Array) => new Uint8Array(inflateRawSync(d));

const PLAN = `# Bakery plan

Golden Crumb sells **fresh bread** in Montréal.

## Costs

| Item | Monthly |
|---|---|
| Rent | $2,400 |
| Flour | $600 |

## Next steps

1. Rent a shop
2. Hire a baker
   - full time
- [x] Open a bank account`;

test("a reply becomes a deck: title slide, then a slide per heading", async () => {
  const { title, slides } = slidesOf(PLAN, "Flash reply");
  assert.equal(title, "Bakery plan");
  assert.deepEqual(
    slides.map((s) => s.title),
    ["Bakery plan", "Costs", "Next steps"],
  );
  assert.deepEqual(slides[1].table, [["Item", "Monthly"], ["Rent", "$2,400"], ["Flour", "$600"]]);
  assert.deepEqual(
    slides[2].lines.map((l) => [l.bullet, l.level]),
    [["1.", 0], ["2.", 0], ["•", 1], ["☑", 0]],
  );
  const text = await officeText(slidesDeck(PLAN, "Flash reply", "October 4, 2026"), "pptx", inflate);
  assert.match(text, /^--- Slide 1 ---\nBakery plan\nOctober 4, 2026\n\n--- Slide 2 ---\nBakery plan\nGolden Crumb sells fresh bread in Montréal\.\n2 \/ 4/);
  assert.match(text, /--- Slide 4 ---\nNext steps\nRent a shop\nHire a baker\nfull time\nOpen a bank account\n4 \/ 4$/);
});

test("long sections carry on to a next slide", () => {
  const md = "## Ideas\n" + Array.from({ length: 20 }, (_, i) => `- idea ${i + 1}`).join("\n");
  const { title, slides } = slidesOf(md, "Ideas list");
  assert.equal(title, "Ideas");
  const many = slidesOf("Intro\n\n" + md, "Ideas list").slides;
  assert.deepEqual(
    many.map((s) => [s.title, s.lines.length]),
    [["Ideas list", 1], ["Ideas", 9], ["Ideas (continued)", 9], ["Ideas (continued)", 2]],
  );
  assert.equal(slides.length, 3);
});

test("big tables split with their header repeated", () => {
  const rows = Array.from({ length: 12 }, (_, i) => `| r${i} | ${i} |`).join("\n");
  const { slides } = slidesOf(`## Sales\n| Day | Sold |\n|---|---|\n${rows}\nThat's all.`, "x");
  assert.deepEqual(
    slides.map((s) => [s.title, s.table?.length ?? 0, s.lines.length]),
    [["Sales", 9, 0], ["Sales (continued)", 5, 0], ["Sales (continued)", 0, 1]],
  );
  assert.deepEqual(slides[1].table?.[0], ["Day", "Sold"]);
});

test("inline formatting becomes bold, italic and code runs; XML is escaped", () => {
  assert.deepEqual(runsOf("a **b** *c* `d` [e](https://f.com)"), [
    { text: "a " },
    { text: "b", bold: true },
    { text: " " },
    { text: "c", italic: true },
    { text: " " },
    { text: "d", code: true },
    { text: " " },
    { text: "e (https://f.com)" },
  ]);
  const deck = new TextDecoder().decode(slidesDeck("## A <b> & c", "x", "today"));
  assert.match(deck, /A &lt;b&gt; &amp; c/);
});
