import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { register } from "node:module";
import type { AddressInfo } from "node:net";

register("./support/route-hooks.mjs", import.meta.url);

// A stand-in for the exchange rate service, so nothing here reaches the real one.
let rateCalls = 0;
let ratesUp = true;
const rates = createServer((_req, res) => {
  rateCalls++;
  res.writeHead(ratesUp ? 200 : 500, { "Content-Type": "application/json" });
  res.end(ratesUp ? JSON.stringify({ result: "success", rates: { USD: 1, EUR: 0.9, NGN: 1500, JPY: 150, BAD: "x" } }) : "{}");
});
await new Promise<void>((resolve) => rates.listen(0, "127.0.0.1", resolve));
process.env.FLASH_FX_URL = `http://127.0.0.1:${(rates.address() as AddressInfo).port}/latest/USD`;
after(() => rates.close());

const { paidInFlashCurrency } = await import("../src/lib/server/stripe.ts");
const { LOCAL_BUFFER, currencyForCountry, localPrice } = await import("../src/lib/local-currency.ts");
const { forgetRates, usdRate } = await import("../src/lib/server/fx.ts");
const localRoute = await import("../src/app/api/pricing/local/route.ts");

test("a pack paid in the customer's own currency counts by its value in Flash's (Adaptive Pricing)", () => {
  assert.equal(paidInFlashCurrency({ amount_total: 500, currency: "usd" }), 500);
  assert.equal(paidInFlashCurrency({ amount_total: 470, currency: "eur", currency_conversion: { amount_total: 500, source_currency: "usd" } }), 500);
  assert.equal(paidInFlashCurrency({ amount_total: 470, currency: "eur" }), null, "another currency with no conversion gives nothing");
  assert.equal(
    paidInFlashCurrency({ amount_total: 470, currency: "eur", currency_conversion: { amount_total: 500, source_currency: "gbp" } }),
    null,
    "a conversion from a currency that isn't Flash's gives nothing",
  );
});

test("each country gets its own currency, and dollar countries none", () => {
  assert.equal(currencyForCountry("fr"), "EUR");
  assert.equal(currencyForCountry("NG"), "NGN");
  assert.equal(currencyForCountry("CI"), "XOF");
  assert.equal(currencyForCountry("US"), null);
  assert.equal(currencyForCountry("EC"), null, "Ecuador pays in US dollars");
  assert.equal(currencyForCountry(""), null);
});

test("a local price is rounded the way people say it, and never below the day's rate", () => {
  const eur = { currency: "EUR", rate: 0.9, adaptive: true };
  assert.equal(localPrice(2500, eur, "en-US"), "€23");
  assert.ok(2500 / 100 * 0.9 * LOCAL_BUFFER >= 23, "the buffer covers the conversion fee");
  assert.equal(localPrice(2500, { currency: "NGN", rate: 1500, adaptive: false }, "en-US"), "₦38,600");
  assert.equal(localPrice(500, { currency: "JPY", rate: 150, adaptive: false }, "en-US"), "¥773");
  assert.equal(localPrice(2500, null), null);
  assert.equal(localPrice(2500, { currency: "USD", rate: 1, adaptive: false }), null);
  assert.equal(localPrice(2500, { currency: "EUR", rate: 0, adaptive: false }), null);
  assert.equal(localPrice(2500, { currency: "NOTACODE", rate: 2, adaptive: false }), null, "a currency the browser doesn't know shows nothing");
});

test("rates are fetched once and kept, and yesterday's stay when the service is down", async () => {
  forgetRates();
  rateCalls = 0;
  assert.equal(await usdRate("eur"), 0.9);
  assert.equal(await usdRate("NGN"), 1500);
  assert.equal(await usdRate("BAD"), null, "a rate that isn't a number is dropped");
  assert.equal(rateCalls, 1);
  ratesUp = false;
  forgetRates();
  assert.equal(await usdRate("EUR"), null, "no rates at all when the service is down from the start");
  ratesUp = true;
});

test("the pricing page asks for the visitor's currency by their country", async () => {
  forgetRates();
  const ask = (country?: string) =>
    localRoute.GET(new Request("http://flash.test/api/pricing/local", { headers: country ? { "x-vercel-ip-country": country } : {} }));
  delete process.env.FLASH_ADAPTIVE_PRICING;
  assert.deepEqual(await (await ask("DE")).json(), { currency: "EUR", rate: 0.9, adaptive: false });
  process.env.FLASH_ADAPTIVE_PRICING = "true";
  assert.deepEqual(await (await ask("NG")).json(), { currency: "NGN", rate: 1500, adaptive: true });
  assert.equal(await (await ask("US")).json(), null);
  assert.equal(await (await ask()).json(), null);
  assert.equal(await (await ask("ZA")).json(), null, "no rate known, nothing shown");
  delete process.env.FLASH_ADAPTIVE_PRICING;
});
