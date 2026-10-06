import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TEMPLATES,
  billMarkdown,
  parseDecimal,
  templateCredits,
  decimalsOf,
  longDate,
  missingField,
  nextNumber,
  parseAmount,
  templateById,
  workOutBill,
  writingCredits,
  type TemplateValues,
} from "../src/lib/templates.ts";
import { ENGINES } from "../src/lib/types.ts";
import { tablesIn, cellValue } from "../src/lib/excel-export.ts";
import { documentText } from "../src/lib/chat-export.ts";
import { system } from "../src/lib/engines/claude.ts";
import { MARKUP, CLAUDE_PRICES } from "../src/lib/credits.ts";

const values = (text: Record<string, string>, items: TemplateValues["items"] = []): TemplateValues => ({ text, items });

test("amounts are read the way people type them", () => {
  assert.equal(parseAmount("8"), 8);
  assert.equal(parseAmount("$1,200.50"), 1200.5);
  assert.equal(parseAmount("1,200"), 1200, "a comma between thousands");
  assert.equal(parseAmount("8,50"), 8.5, "a decimal comma");
  assert.equal(parseAmount("CAD 14"), 14);
  assert.equal(parseAmount("€ 3.5"), 3.5);
  assert.equal(parseAmount("-5"), -5, "a discount line");
  assert.ok(Number.isNaN(parseAmount("abc")));
  assert.ok(Number.isNaN(parseAmount("1.2.3")));
  assert.ok(Number.isNaN(parseAmount("")));
  // Currency words with an abbreviation dot, and spaces between thousands.
  assert.equal(parseAmount("Rs. 4,500"), 4500);
  assert.equal(parseAmount("Ksh.1,000"), 1000);
  assert.equal(parseAmount("R$ 80,00"), 80);
  assert.equal(parseAmount("1 250,00"), 1250);
  assert.equal(parseAmount("1.200,50"), 1200.5);
  assert.equal(parseAmount("14 dollars"), 14);
  assert.equal(parseAmount(".5"), 0.5);
  assert.equal(parseAmount("0.125"), 0.125);
  // Never guessed: "2k" isn't a currency.
  assert.ok(Number.isNaN(parseAmount("2k")));
  assert.ok(Number.isNaN(parseAmount("1.5K")));
  // "1.459" is a price per litre in dollars, but in reais or euros "1.200" may be twelve hundred, so it's refused there.
  assert.deepEqual(parseDecimal("1.459", "CAD"), { digits: BigInt(1459), scale: 3 });
  assert.equal(parseDecimal("R$ 1.200", "BRL"), null);
  assert.deepEqual(parseDecimal("R$ 1.200,00", "BRL"), { digits: BigInt(120000), scale: 2 });
  assert.deepEqual(parseDecimal("9.975%"), { digits: BigInt(9975), scale: 3 });
});

test("prices below a cent and hours with decimals are multiplied exactly, then rounded once", () => {
  const line = (quantity: string, price: string) => {
    const bill = workOutBill([{ description: "x", quantity, price }], "CAD", []);
    assert.ok(!("error" in bill), `${quantity} × ${price}`);
    return bill;
  };
  assert.equal(line("5000", "0.125").totalMinor, 62500, "5,000 words at 12.5¢ is 625.00, not 650.00");
  assert.equal(line("1000", "0.035").totalMinor, 3500);
  assert.equal(line("40", "1.459").totalMinor, 5836);
  assert.equal(line("1.15", "17.50").totalMinor, 2013, "20.125 rounds up to 20.13");
  assert.equal(line("4.35", "65.50").totalMinor, 28493);
  assert.equal(line("0.29", "0.50").totalMinor, 15);
  const shown = line("5000", "0.125");
  assert.deepEqual(shown.lines[0], { description: "x", quantity: "5,000", unitPrice: "0.125", amountMinor: 62500 });
  assert.match((workOutBill([{ description: "x", quantity: "1", price: "2k" }], "CAD", []) as { error: string }).error, /price for "x" isn't clear/);
  const reais = workOutBill([{ description: "Bolo", quantity: "1", price: "1.200" }], "BRL", []);
  assert.match((reais as { error: string }).error, /Write it like 1200 or 12\.50/);
  // A rate reads the same in any currency.
  const euros = workOutBill([{ description: "x", quantity: "1", price: "100" }], "EUR", [{ name: "TVA", rate: "5.500" }]);
  assert.equal((euros as { totalMinor: number }).totalMinor, 10550);
  const discount = workOutBill([{ description: "Cake", quantity: "1", price: "5" }, { description: "Discount", quantity: "1", price: "-9" }], "CAD", []);
  assert.match((discount as { error: string }).error, /less than zero/);
});

test("invoice totals are worked out exactly, in cents, with two taxes on the subtotal", () => {
  const bill = workOutBill(
    [
      { description: "Sourdough loaves", quantity: "20", price: "8" },
      { description: "Croissant box", quantity: "3", price: "24.50" },
      { description: "", quantity: "1", price: "" },
    ],
    "CAD",
    [
      { name: "GST", rate: "5" },
      { name: "QST", rate: "9.975%" },
    ],
  );
  assert.ok(!("error" in bill));
  assert.equal(bill.lines.length, 2, "an empty row is skipped");
  assert.equal(bill.subtotalMinor, 23350);
  // 233.50 × 5% = 11.675, rounded half up to 11.68; × 9.975% = 23.29.
  assert.deepEqual(bill.taxes.map((t) => t.minor), [1168, 2329]);
  assert.equal(bill.totalMinor, 26847);

  // Hours at a decimal quantity, and floating-point traps like 0.1 + 0.2.
  const hours = workOutBill([{ description: "Design", quantity: "2.5", price: "0.1" }, { description: "Fix", quantity: "1", price: "0.2" }], "USD", []);
  assert.ok(!("error" in hours));
  assert.equal(hours.subtotalMinor, 45, "25 + 20 cents, with no stray fractions");

  // Yen and CFA francs have no cents.
  assert.equal(decimalsOf("JPY"), 0);
  assert.equal(decimalsOf("XOF"), 0);
  const yen = workOutBill([{ description: "Bread", quantity: "3", price: "450" }], "JPY", [{ name: "Tax", rate: "10" }]);
  assert.ok(!("error" in yen));
  assert.equal(yen.totalMinor, 1485);
});

test("a bill with a mistake says what to fix instead of guessing", () => {
  const err = (items: TemplateValues["items"], rate = "") => {
    const r = workOutBill(items, "CAD", [{ name: "HST", rate }]);
    return "error" in r ? r.error : "";
  };
  assert.match(err([]), /at least one item/);
  assert.match(err([{ description: "", quantity: "1", price: "5" }]), /Item 1 needs a description/);
  assert.match(err([{ description: "Cake", quantity: "two", price: "5" }]), /quantity for "Cake"/);
  assert.match(err([{ description: "Cake", quantity: "0", price: "5" }]), /quantity for "Cake"/);
  assert.match(err([{ description: "Cake", quantity: "1", price: "five" }]), /price for "Cake"/);
  assert.match(err([{ description: "Cake", quantity: "1", price: "5" }], "150"), /between 0 and 100/);
  assert.equal(err([{ description: "Cake", quantity: "", price: "5" }]), "", "a missing quantity means one");
});

test("an invoice reads well, and its table downloads to Excel with real numbers", () => {
  const md = billMarkdown(
    "invoice",
    values(
      {
        business: "Golden Crumb Bakery",
        yourDetails: "123 Queen St\nhello@gc.ca",
        client: "Maple Café",
        number: "INV-007",
        date: "2026-10-06",
        due: "2026-10-20",
        currency: "CAD",
        tax1Name: "HST",
        tax1Rate: "13",
        notes: "Pay by e-Transfer",
      },
      [
        { description: "Loaves | sliced", quantity: "20", price: "8" },
        { description: "Delivery", quantity: "1", price: "15" },
      ],
    ),
  );
  assert.equal(typeof md, "string");
  const doc = md as string;
  assert.match(doc, /^# Invoice INV-007$/m);
  assert.match(doc, /\*\*From:\*\* Golden Crumb Bakery {2}\n123 Queen St {2}\nhello@gc\.ca/);
  assert.match(doc, /\*\*Bill to:\*\* Maple Café\n/, "no line break is left hanging when there are no details");
  assert.match(doc, /\*\*Due date:\*\* October 20, 2026/);
  assert.match(doc, /\*\*Amount due:\*\* CAD 197\.75/);
  assert.match(doc, /\| Loaves \/ sliced \| 20 \| 8\.00 \| 160\.00 \|/, "a | in a description can't break the table");
  assert.match(doc, /\| HST \(13%\) \| \| \| 22\.75 \|/);
  assert.match(doc, /Pay by e-Transfer/);
  assert.match(doc, /Thank you for your business!/);

  const [table] = tablesIn(doc);
  assert.equal(table.name, "Invoice INV-007", "the sheet is named after the invoice");
  assert.equal(table.rows.length, 6, "header, two items, subtotal, tax, total");
  assert.deepEqual(table.rows[0], ["Item", "Quantity", "Unit price (CAD)", "Amount (CAD)"]);
  assert.deepEqual(cellValue(table.rows[1][3]), { number: 160, style: 0 });
  assert.deepEqual(table.rows[5][0], "Total due", "bold marks are dropped in the sheet");
  assert.deepEqual(cellValue(table.rows[5][3]), { number: 197.75, style: 0 });

  const quote = billMarkdown("quote", values({ business: "GC", client: "Maple", currency: "USD", due: "2026-11-05" }, [{ description: "Cake", quantity: "1", price: "1,250" }]));
  assert.match(quote as string, /^# Quote$/m, "no number given, so none is shown");
  assert.match(quote as string, /\*\*Valid until:\*\* November 5, 2026/);
  assert.match(quote as string, /\*\*Quote total:\*\* USD 1,250\.00/);
  assert.match(quote as string, /To accept this quote/);

  assert.deepEqual(billMarkdown("invoice", values({ business: "GC" }, [{ description: "x", quantity: "1", price: "1" }])), { error: "Add who the invoice is for." });
});

test("invoice and quote numbers count up from the last one", () => {
  assert.equal(nextNumber("INV-007"), "INV-008");
  assert.equal(nextNumber("2026-099"), "2026-100");
  assert.equal(nextNumber("Q9"), "Q10");
  assert.equal(nextNumber("INV-099-B"), "INV-100-B");
  assert.equal(nextNumber("A"), "A-2");
  assert.equal(longDate("2026-01-31"), "January 31, 2026", "the date never shifts a day with the time zone");
  assert.equal(longDate("soon"), "soon");
});

test("every template is complete, and goes to an engine Flash has", () => {
  const ids = new Set<string>();
  for (const t of TEMPLATES) {
    assert.ok(!ids.has(t.id), `${t.id} is used twice`);
    ids.add(t.id);
    assert.ok(t.engine === "local" || (ENGINES as readonly string[]).includes(t.engine), `${t.id} engine`);
    assert.ok(t.fields.some((f) => f.required), `${t.id} asks for something`);
    const keys = t.fields.map((f) => f.key);
    assert.equal(new Set(keys).size, keys.length, `${t.id} field keys are unique`);
  }
  for (const id of ["business-plan", "resume", "menu", "flyer", "invoice"]) assert.ok(templateById(id), `${id} exists`);
});

test("template requests carry only what was filled in, and ask Flash not to make things up", () => {
  const plan = templateById("business-plan")!;
  const v = values({ business: "Golden Crumb", offer: "Bread and coffee", city: "  ", goals: "Break even\nOpen a stall" });
  const ask = plan.request(v);
  assert.match(ask, /^Write a complete business plan for Golden Crumb\./);
  assert.match(ask, /What it sells or does: Bread and coffee/);
  assert.doesNotMatch(ask, /Where:/, "an empty field is left out");
  assert.match(ask, /Goals for the first year:\nBreak even\nOpen a stall/, "several lines start on their own line");
  assert.match(ask, /12-month forecast table/);
  assert.match(ask, /\[square brackets\] instead of making one up/);
  assert.match(ask, /Don't put it in a code block/);
  assert.equal(plan.title(v), "Business plan: Golden Crumb");

  const resume = templateById("resume")!.request(values({ name: "Ada", role: "Head baker", experience: "Baker, Maple Café, 2019–2024" }));
  assert.match(resume, /never add ones that weren't given/);

  const flyer = templateById("flyer")!.request(values({ business: "Golden Crumb", headline: "Grand opening!", look: "Elegant" }));
  assert.match(flyer, /tall vertical/, "the image engine reads this as a tall picture");
  assert.match(flyer, /headline "Grand opening!"/);
  assert.match(flyer, /Elegant style/);

  assert.equal(missingField(plan, values({ business: "GC" })), "What you sell or do");
  assert.equal(missingField(plan, v), "");
  assert.equal(missingField(templateById("invoice")!, values({ business: "GC", client: "M" }, [{ description: " ", quantity: "1", price: "1" }])), "Items");
});

test("a written template's price estimate follows the real prices", () => {
  const price = CLAUDE_PRICES["claude-sonnet-5-5"];
  assert.equal(writingCredits(6000), Math.ceil(((6000 * price.output + 3000 * price.input) / 1e6) * MARKUP));
  // The server prices them with the model and markup really in use.
  const opus = CLAUDE_PRICES["claude-opus-5-5"];
  assert.equal(templateCredits("claude-opus-5-5", 3)["resume"], Math.ceil(((1500 * opus.output + 3000 * opus.input) / 1e6) * 3));
  assert.equal(templateCredits()["invoice"], undefined, "free templates have no price");
  // A business plan stays well inside what a Docs & Sheets reply may hold (60 credits plus its input).
  assert.ok(writingCredits(templateById("business-plan")!.answerTokens!) < 60);
});

test("documents come out of their code block for Word, PDF and PowerPoint, and Docs no longer fences them", () => {
  const reply = "Here is your resume:\n\n```markdown\n# Ada Lovelace\n\n- Baker\n```\n\nGood luck!";
  assert.equal(documentText(reply), "Here is your resume:\n\n# Ada Lovelace\n\n- Baker\n\nGood luck!");
  const code = "```python\nprint(1)\n```";
  assert.equal(documentText(code), code, "real code stays code");
  const lesson = `${"A table in Markdown is written with pipes and dashes between the header and the rows. ".repeat(4)}\n\n\`\`\`md\n| a | b |\n|---|---|\n| 1 | 2 |\n\`\`\`\n\nThat's all there is to it.`;
  assert.equal(documentText(lesson), lesson, "an example inside an explanation stays an example");
  const readme = "```markdown\n# App\n\n```bash\nnpm i\n```\n\nThen run it.\n```";
  assert.equal(documentText(readme), readme, "a block with its own code fences is left alone");
  assert.doesNotMatch(system("", "docs"), /fenced ```markdown/);
  assert.match(system("", "docs"), /not inside a code block/);
  assert.match(system("", "docs"), /```csv/, "spreadsheets still come as CSV blocks");
});
