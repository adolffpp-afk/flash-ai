import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./support/route-hooks.mjs", import.meta.url);

process.env.DATABASE_URL = ":memory:";
process.env.PAWAPAY_SANDBOX_KEY = "sandbox-token";
delete process.env.PAWAPAY_LIVE_KEY;
const { run, one } = await import("../src/lib/server/db.ts");
const { balance } = await import("../src/lib/server/credits.ts");
const { activeSubscription, planSummary } = await import("../src/lib/server/subscriptions.ts");
const { mobileMoneyFor, pawapayMode, settleMobileMoney, startMobileMoney } = await import("../src/lib/server/pawapay.ts");
const { forgetRates } = await import("../src/lib/server/fx.ts");
const { FX_ALLOWANCE, MOBILE_MONEY_COUNTRIES, MOBILE_MONEY_PRODUCTS, keptAfterFee, mobileMoneyAmount, mobileMoneyCountry } = await import(
  "../src/lib/mobile-money.ts"
);
const { CREDIT_PACKS, PLANS, planCredits } = await import("../src/lib/credits.ts");
const { POST: callback } = await import("../src/app/api/pawapay/callback/route.ts");

// Local money per US dollar, about what each costs today.
const RATES: Record<string, number> = { XOF: 600, XAF: 600, CDF: 2800, ETB: 140, GHS: 15, KES: 129, MWK: 1740, MZN: 64, RWF: 1450 };

type Deposit = { depositId: string; status: string; amount: string; currency: string };
const deposits = new Map<string, Deposit>();
const pages: { body: Record<string, unknown>; auth: string | null }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "open.er-api.com") return Response.json({ result: "success", rates: { USD: 1, ...RATES } });
  assert.equal(url.hostname, "api.sandbox.pawapay.io", "only the sandbox without a live key");
  const auth = new Headers(init?.headers).get("authorization");
  if (url.pathname === "/v2/paymentpage") {
    pages.push({ body: JSON.parse(String(init?.body)), auth });
    return Response.json({ redirectUrl: "https://paywith.pawapay.io/?token=t" });
  }
  const id = url.pathname.split("/").pop()!;
  const d = deposits.get(id);
  return Response.json(d ? { status: "FOUND", data: d } : { status: "NOT_FOUND" });
}) as typeof fetch;

const pay = (depositId: string, status = "COMPLETED", over: Partial<Deposit> = {}) => {
  const page = pages.find((p) => p.body.depositId === depositId)!;
  const details = page.body.amountDetails as { amount: string; currency: string };
  deposits.set(depositId, { depositId, status, amount: details.amount, currency: details.currency, ...over });
};
const callbackFor = (body: unknown) => callback(new Request("https://flash.test/api/pawapay/callback", { method: "POST", body: JSON.stringify(body) }));
const start = async (product: string, country = "GH", user = "u1") => {
  const res = await startMobileMoney({ id: user }, "sandbox", product, country, "https://flash.test");
  assert.ok("url" in res, JSON.stringify(res));
  return res.depositId;
};

test("after the fee and conversion, every price leaves Flash at least the US dollar price, in every country", () => {
  for (const country of MOBILE_MONEY_COUNTRIES) {
    for (const p of MOBILE_MONEY_PRODUCTS) {
      for (const rate of [RATES[country.currency], RATES[country.currency] * 3.7, 0.9]) {
        const amount = mobileMoneyAmount(p.usdCents, rate, country);
        // Only what's over M-Pesa Kenya's largest payment (150,000 shillings) has no price.
        if (amount === null && country.code === "KE" && (p.usdCents / 100) * rate > 150000 * 0.9) continue;
        assert.ok(amount && Number.isInteger(amount), `${country.code} ${p.id}`);
        const keptUsdCents = (keptAfterFee(amount, country.fee) / rate / (1 + FX_ALLOWANCE)) * 100;
        assert.ok(keptUsdCents >= p.usdCents - 1e-6, `${country.code} ${p.id}: ${keptUsdCents} < ${p.usdCents}`);
        // And it isn't far above what's needed (no more than 8% over, plus rounding).
        assert.ok(amount <= Math.ceil(((p.usdCents / 100) * rate * (1 + FX_ALLOWANCE)) / (1 - country.fee.share)) * 1.08 + 1, `${country.code} ${p.id}`);
      }
    }
  }
  // Kenya's fixed M-Pesa fee is counted: the Starter pack (about 650 shillings) pays a 10 shilling fee.
  const kenya = mobileMoneyCountry("ke")!;
  const starter = mobileMoneyAmount(500, 129, kenya)!;
  assert.ok(keptAfterFee(starter, kenya.fee) >= 5 * 129 * (1 + FX_ALLOWANCE));
  assert.equal(mobileMoneyAmount(500, 0, kenya), null, "no rate, no price");
  assert.equal(mobileMoneyCountry("NG"), undefined, "Nigeria needs Flash's own accounts there");
});

test("every pack and plan can be bought, as a month or a year", () => {
  assert.equal(MOBILE_MONEY_PRODUCTS.filter((p) => p.kind === "pack").length, CREDIT_PACKS.length);
  assert.equal(MOBILE_MONEY_PRODUCTS.filter((p) => p.kind === "pass").length, PLANS.length * 2);
});

test("the sandbox is for admins only; the live key is for everyone", () => {
  assert.equal(pawapayMode(), "sandbox");
  assert.equal(mobileMoneyFor(false), null);
  assert.equal(mobileMoneyFor(true), "sandbox");
  process.env.PAWAPAY_LIVE_KEY = "live";
  assert.equal(mobileMoneyFor(false), "live");
  delete process.env.PAWAPAY_LIVE_KEY;
});

test("a pack is paid on pawaPay's page and its credits come once, only after pawaPay's API says it's paid", async () => {
  forgetRates();
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'u1@t.io', 'x', 0)");
  const id = await start("pack:starter");
  const page = pages.at(-1)!;
  assert.equal(page.auth, "Bearer sandbox-token");
  assert.deepEqual(page.body.amountDetails, { amount: String(mobileMoneyAmount(500, 15, mobileMoneyCountry("GH")!)), currency: "GHS" });
  assert.equal(page.body.country, "GHA");
  assert.equal(page.body.returnUrl, "https://flash.test/?mobile-money=1");

  // A callback saying it's paid gives nothing while pawaPay's API says otherwise.
  pay(id, "PROCESSING");
  assert.equal((await callbackFor({ depositId: id, status: "COMPLETED" })).status, 200);
  assert.equal(await balance("u1"), 0);
  assert.equal((await settleMobileMoney(id))?.status, "pending");

  pay(id);
  const [a, b] = await Promise.all([settleMobileMoney(id), callbackFor({ depositId: id })]);
  assert.equal(a?.status, "completed");
  assert.equal(b.status, 200);
  await settleMobileMoney(id);
  assert.equal(await balance("u1"), 500, "once, however many times it's checked");
  const purchase = await one<{ test: number; ref: string }>("SELECT test, ref FROM purchases WHERE user_id = 'u1'");
  assert.deepEqual({ ...purchase }, { test: 1, ref: `pawapay-sandbox:${id}` }, "sandbox purchases are test purchases");
});

test("a deposit for less, in another currency, or that failed gives nothing", async () => {
  const less = await start("pack:creator");
  pay(less, "COMPLETED", { amount: "1" });
  assert.equal((await settleMobileMoney(less))?.status, "failed");
  const other = await start("pack:creator");
  pay(other, "COMPLETED", { currency: "USD" });
  assert.equal((await settleMobileMoney(other))?.status, "failed");
  const failed = await start("pack:creator");
  pay(failed, "FAILED");
  assert.equal((await settleMobileMoney(failed))?.status, "failed");
  // Once failed, a later "paid" changes nothing.
  pay(failed);
  assert.equal((await settleMobileMoney(failed))?.status, "failed");
  assert.equal(await balance("u1"), 500);
  assert.equal(await settleMobileMoney("not-a-deposit"), null);
  assert.equal((await callbackFor({ payoutId: "x" })).status, 200, "payout and refund callbacks are ignored");
});

test("a pass gives the plan for a month without renewing, and buying it again adds a month", async () => {
  const pro = PLANS.find((p) => p.id === "pro")!;
  const first = await start("pass:pro:month", "KE");
  pay(first);
  await settleMobileMoney(first);
  const sub = (await activeSubscription("u1"))!;
  assert.equal(sub.id, `pawapay:${first}`);
  assert.equal(sub.cancel_at_period_end, 1, "never renews by itself");
  assert.equal(sub.test, 1);
  assert.equal(await balance("u1"), 500 + planCredits(pro));
  const summary = (await planSummary("u1"))!;
  assert.equal(summary.prepaid, true);
  assert.equal(summary.renews, false);

  const again = await start("pass:pro:month", "KE");
  pay(again);
  await settleMobileMoney(again);
  const renewed = (await activeSubscription("u1"))!;
  assert.equal(renewed.id, sub.id, "the same pass goes on");
  const month = 31 * 24 * 3600 * 1000;
  assert.ok(renewed.paid_until > sub.paid_until + month - 4 * 24 * 3600 * 1000, "a month more");
  assert.equal(await balance("u1"), 500 + planCredits(pro), "next month's credits come next month");

  // Another plan starts a new pass today and ends the old one.
  const power = await start("pass:power:year", "CM");
  pay(power);
  await settleMobileMoney(power);
  const yearly = (await activeSubscription("u1"))!;
  assert.equal(yearly.id, `pawapay:${power}`);
  assert.equal(yearly.interval, "year");
  const old = await one<{ status: string }>("SELECT status FROM subscriptions WHERE id = ?", [sub.id]);
  assert.equal(old?.status, "canceled");
});

test("an unknown product or country is refused before pawaPay is asked", async () => {
  const before = pages.length;
  assert.deepEqual(await startMobileMoney({ id: "u1" }, "sandbox", "pack:nope", "GH", "x"), { error: "product" });
  assert.deepEqual(await startMobileMoney({ id: "u1" }, "sandbox", "pack:starter", "NG", "x"), { error: "country" });
  assert.equal(pages.length, before);
});
