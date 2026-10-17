import { test } from "node:test";
import assert from "node:assert/strict";

const { withTax } = await import("../src/lib/server/stripe.ts");

test("sales tax is added on top of the price only when FLASH_STRIPE_TAX is on", () => {
  delete process.env.FLASH_STRIPE_TAX;
  assert.equal(withTax(new URLSearchParams(), 1, false).toString(), "");
  process.env.FLASH_STRIPE_TAX = "true";
  const form = withTax(new URLSearchParams(), 2, true);
  assert.equal(form.get("automatic_tax[enabled]"), "true");
  assert.equal(form.get("line_items[0][price_data][tax_behavior]"), "exclusive");
  assert.equal(form.get("line_items[1][price_data][tax_behavior]"), "exclusive");
  assert.equal(form.get("billing_address_collection"), "required");
  assert.equal(form.get("customer_update[address]"), "auto");
  assert.equal(withTax(new URLSearchParams(), 1, false).get("customer_update[address]"), null, "a new customer gives their address at checkout");
  delete process.env.FLASH_STRIPE_TAX;
});
