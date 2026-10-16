import { test } from "node:test";
import assert from "node:assert/strict";

const { MARKUP } = await import("../src/lib/credits.ts");
const { TEXT_PRICES, textCredits, textSegments, numberMonthlyCredits, NUMBER_MONTHLY_CENTS, callCredits, CALL_MINUTE_CENTS, emailCredits, EMAIL_CENTS } =
  await import("../src/lib/messaging-prices.ts");

// A price makes a profit when its credits, at the most a credit can cost Flash (1/MARKUP cents), cover the cost.
const pays = (credits: number, cents: number) => credits / MARKUP >= cents;

test("texts are charged at least their cost in every country Flash texts, and nowhere else", () => {
  for (const [country, p] of Object.entries(TEXT_PRICES)) {
    assert.ok(pays(textCredits(country)!, p.smsCents), country);
    assert.ok(pays(textCredits(country, true)!, p.mmsCents), country);
  }
  assert.equal(textCredits("US"), 4);
  assert.equal(textCredits("GB"), null);
  assert.equal(textCredits("__proto__"), null);
});

test("a long or non-Latin text is several segments", () => {
  assert.equal(textSegments("Your table is ready."), 1);
  assert.equal(textSegments("x".repeat(160)), 1);
  assert.equal(textSegments("x".repeat(161)), 2);
  assert.equal(textSegments("Merci 🙂"), 1);
  assert.equal(textSegments("🙂".repeat(71)), 2);
  assert.equal(textSegments("こんにちは".repeat(15)), 2);
});

test("phone numbers, calls and emails pay for themselves", () => {
  for (const kind of ["local", "tollFree"] as const) assert.ok(pays(numberMonthlyCredits(kind), NUMBER_MONTHLY_CENTS[kind]), kind);
  for (const kind of ["outbound", "inboundLocal", "inboundTollFree"] as const) {
    assert.ok(pays(callCredits(kind, 1), CALL_MINUTE_CENTS[kind]), kind);
    assert.ok(pays(callCredits(kind, 61), 2 * CALL_MINUTE_CENTS[kind]), `${kind}: a started minute counts`);
    assert.ok(pays(callCredits(kind, 60, true), CALL_MINUTE_CENTS[kind] + 0.3), `${kind}: recording is paid for`);
  }
  assert.equal(emailCredits(0), 0);
  for (const n of [1, 4, 100, 10000]) assert.ok(pays(emailCredits(n), n * EMAIL_CENTS), String(n));
});
