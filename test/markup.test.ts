import { test } from "node:test";
import assert from "node:assert/strict";

const { markupFrom } = await import("../src/lib/credits.ts");

test("a FLASH_MARKUP that would sell below cost, or isn't a number, falls back to 2.5", () => {
  assert.equal(markupFrom(undefined), 2.5);
  assert.equal(markupFrom(""), 2.5, "an empty value used to make every request cost 1 credit");
  assert.equal(markupFrom("abc"), 2.5);
  assert.equal(markupFrom("0.5"), 2.5);
  assert.equal(markupFrom("3"), 3);
  assert.equal(markupFrom("1"), 1);
});
