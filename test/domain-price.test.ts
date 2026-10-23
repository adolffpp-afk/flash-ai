import { test } from "node:test";
import assert from "node:assert/strict";

const { domainPriceCents, domainKeepsCents, domainMarginCents, domainFeeCents, sellableName, searchKeyword, priceSettings } = await import("../src/lib/domain-price.ts");

test("every domain price leaves at least Flash's margin after Stripe's worst-case fees and Name.com's cost", () => {
  const settings = [priceSettings(), { fx: 0, marginCents: 300, icannCents: 0 }, { fx: 0.05, marginCents: 500, icannCents: 20 }];
  for (const s of settings) {
    for (let v = 99; v <= 10_000; v += 37) {
      const p = domainPriceCents(v, s);
      assert.equal(p % 100, 99, `${v}: ends in .99`);
      assert.ok(domainKeepsCents(p, v, s) >= domainMarginCents(v, s), `${v}: keeps the margin at ${p}`);
      assert.ok(domainMarginCents(v, s) >= s.marginCents);
      // The smallest such price: a dollar less would not be enough (or would be rounded the same).
      assert.ok(domainKeepsCents(p - 100, v, s) < domainMarginCents(v, s), `${v}: ${p} is not dearer than it needs to be`);
    }
  }
});

test("a .com at Name.com's US$11 is about US$16, cheaper than most website builders", () => {
  const p = domainPriceCents(1100);
  assert.ok(p <= 1699 && p >= 1499, String(p));
  assert.ok(domainKeepsCents(p, 1100) >= 300);
});

test("Stripe's fee counts the international card and Stripe Tax's share", () => {
  // 2.9% + 2% conversion + tax share + 0.8% international, plus 37¢.
  assert.ok(domainFeeCents(1000) > 1000 * 0.057 + 37);
});

test("only plain names in the endings sold at launch, with no brand or phishing words", () => {
  assert.equal(sellableName("goldencrumb.com"), true);
  assert.equal(sellableName("golden-crumb.shop"), true);
  assert.equal(sellableName("goldencrumb.ca"), false, "needs papers");
  assert.equal(sellableName("goldencrumb.ai"), false, "sold for 2 years");
  assert.equal(sellableName("shop.goldencrumb.com"), false);
  assert.equal(sellableName("xn--bcher-kva.com"), false);
  assert.equal(sellableName("paypal-help.com"), false);
  assert.equal(sellableName("mybank-login.net"), false);
  assert.equal(sellableName("-crumb.com"), false);
});

test("what people type becomes Name.com's keyword", () => {
  assert.equal(searchKeyword("Golden Crumb Bakery"), "goldencrumbbakery");
  assert.equal(searchKeyword("https://www.GoldenCrumb.com/menu"), "goldencrumb");
  assert.equal(searchKeyword("Café Été"), "cafeete");
  assert.equal(searchKeyword("!!!"), "");
});
