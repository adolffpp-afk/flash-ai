import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { cellValue, excelWorkbook, sheetNames, tablesIn } from "../src/lib/excel-export.ts";
import { officeText, readZip } from "../src/lib/office.ts";

const inflate = async (d: Uint8Array) => new Uint8Array(inflateRawSync(d));

const BUDGET = `# Golden Crumb budget

## Monthly costs

| Item | Cost | Share |
|---|---|---|
| **Rent** | $2,400 | 60% |
| Flour | $600.50 | 15% |
| Notes | see below | |

Some text.

\`\`\`
| not | a table |
|---|---|
\`\`\`

## Monthly costs

| Day | Loaves |
|:--|--:|
| Monday | 1,200 |
| Tuesday | 0950 |`;

test("tables are found with the heading above them, outside code blocks", () => {
  const tables = tablesIn(BUDGET);
  assert.equal(tables.length, 2);
  assert.deepEqual(tables[0], {
    name: "Monthly costs",
    rows: [
      ["Item", "Cost", "Share"],
      ["Rent", "$2,400", "60%"],
      ["Flour", "$600.50", "15%"],
      ["Notes", "see below", ""],
    ],
  });
  assert.deepEqual(sheetNames(tables), ["Monthly costs", "Monthly costs (2)"]);
  assert.deepEqual(sheetNames([{ name: "Q1: costs/sales [draft] for the whole year 2027", rows: [] }, { name: "", rows: [] }]), [
    "Q1 costssales draft for the who",
    "Table 2",
  ]);
  assert.deepEqual(tablesIn("No tables here."), []);
});

test("numbers, dollars and percentages become numbers", () => {
  assert.deepEqual(cellValue("$2,400"), { number: 2400, style: 1 });
  assert.deepEqual(cellValue("-$5.25"), { number: -5.25, style: 1 });
  assert.deepEqual(cellValue("60%"), { number: 0.6, style: 2 });
  assert.deepEqual(cellValue("1,200"), { number: 1200, style: 0 });
  assert.deepEqual(cellValue("3.5"), { number: 3.5, style: 0 });
  assert.deepEqual(cellValue("0950"), { text: "0950" }, "leading zeros (codes, times) stay text");
  assert.deepEqual(cellValue("€8"), { text: "€8" });
  assert.deepEqual(cellValue("1,2,3"), { text: "1,2,3" });
});

test("the workbook has one sheet per table and reads back", async () => {
  const file = excelWorkbook(tablesIn(BUDGET));
  const parts = await readZip(file, () => true, inflate);
  assert.ok(parts.get("xl/worksheets/sheet1.xml")!.includes('<c r="B2" s="1"><v>2400</v></c>'));
  assert.ok(parts.get("xl/worksheets/sheet1.xml")!.includes('<c r="C2" s="2"><v>0.6</v></c>'));
  assert.equal(
    await officeText(file, "xlsx", inflate),
    "--- Sheet: Monthly costs ---\nItem,Cost,Share\nRent,2400,0.6\nFlour,600.5,0.15\nNotes,see below\n\n--- Sheet: Monthly costs (2) ---\nDay,Loaves\nMonday,1200\nTuesday,0950",
  );
});
