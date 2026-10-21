/*
 * Mobile money in Africa, through pawaPay (see server/pawapay.ts). Mobile money can't charge
 * anyone without their PIN, so there are no renewing plans here: a plan is a prepaid pass of one
 * month or one year (its credits still come each month), and packs are the same top-ups as by card.
 *
 * No loss: the price in local money is set so that after pawaPay's fee for that country and
 * FX_ALLOWANCE for currency conversion, Flash still gets at least the full US dollar price. That is
 * more than a card payment leaves after Stripe's fees, so every plan and pack keeps the profit
 * test/pricing.test.ts checks. test/mobile-money.test.ts checks this for every country and product.
 */
import { CREDIT_PACKS, PLANS, planCredits, planPrice, type Interval } from "./credits.ts";

/** What a country's mobile money costs Flash: a share of the amount plus a fixed fee in local money. */
export type MobileMoneyFee = { share: number; fixed?: (amount: number) => number };

export type MobileMoneyCountry = {
  code: string; // two letters, as Vercel's location header gives it
  pawapay: string; // three letters, as pawaPay names it
  name: string;
  currency: string;
  // The highest collection fee among the country's networks (pawapay.io/fees, 2026-10-21).
  fee: MobileMoneyFee;
};

// M-Pesa Kenya: 1% plus a fixed fee that grows with the amount, in shillings.
const KENYA_TIERS: [below: number, fixed: number][] = [
  [101, 0], [501, 5], [1001, 10], [1501, 15], [2501, 20], [3501, 25], [5001, 34], [7501, 42], [10001, 48],
  [15001, 57], [20001, 62], [25001, 67], [30001, 72], [35001, 83], [40001, 99], [45001, 103], [150001, 108],
];
const kenyaFixed = (amount: number) => KENYA_TIERS.find(([below]) => amount < below)?.[1] ?? Infinity;

/*
 * The countries pawaPay collects in for Flash. Left out for now: Nigeria, Liberia, Mali, Lesotho
 * and South Sudan (pawaPay needs Flash's own accounts with the networks there), and Senegal, Sierra
 * Leone, Tanzania, Uganda and Zambia, whose fees pawaPay's page doesn't list yet. A country is added
 * with its highest fee.
 */
export const MOBILE_MONEY_COUNTRIES: MobileMoneyCountry[] = [
  { code: "BJ", pawapay: "BEN", name: "Benin", currency: "XOF", fee: { share: 0.022 } },
  { code: "BF", pawapay: "BFA", name: "Burkina Faso", currency: "XOF", fee: { share: 0.033 } },
  { code: "CM", pawapay: "CMR", name: "Cameroon", currency: "XAF", fee: { share: 0.0177 } },
  { code: "CG", pawapay: "COG", name: "Congo", currency: "XAF", fee: { share: 0.04 } },
  { code: "CD", pawapay: "COD", name: "DR Congo", currency: "CDF", fee: { share: 0.03 } },
  { code: "CI", pawapay: "CIV", name: "Côte d'Ivoire", currency: "XOF", fee: { share: 0.025 } },
  { code: "ET", pawapay: "ETH", name: "Ethiopia", currency: "ETB", fee: { share: 0.025 } },
  { code: "GA", pawapay: "GAB", name: "Gabon", currency: "XAF", fee: { share: 0.02 } },
  { code: "GH", pawapay: "GHA", name: "Ghana", currency: "GHS", fee: { share: 0.02 } },
  { code: "KE", pawapay: "KEN", name: "Kenya", currency: "KES", fee: { share: 0.01, fixed: kenyaFixed } },
  { code: "MW", pawapay: "MWI", name: "Malawi", currency: "MWK", fee: { share: 0.0333 } },
  { code: "MZ", pawapay: "MOZ", name: "Mozambique", currency: "MZN", fee: { share: 0.0457 } },
  { code: "RW", pawapay: "RWA", name: "Rwanda", currency: "RWF", fee: { share: 0.031 } },
];

export const mobileMoneyCountry = (code: unknown): MobileMoneyCountry | undefined =>
  typeof code === "string" ? MOBILE_MONEY_COUNTRIES.find((c) => c.code === code.toUpperCase()) : undefined;

/*
 * Currency conversion: pawaPay turning local money into US dollars, the day's rate moving while
 * it's kept (server/fx.ts keeps it 12 hours), and the 2% for US dollars into Canadian payouts.
 */
export const FX_ALLOWANCE = 0.06;

/** What Flash keeps of a local amount after the country's fee, in local money. */
export const keptAfterFee = (amount: number, fee: MobileMoneyFee) => amount * (1 - fee.share) - (fee.fixed?.(amount) ?? 0);

/**
 * The price in local money, in whole units (most networks take no decimals): the least amount
 * that leaves the US dollar price, plus conversion, after the fee. `rate` is local money per dollar.
 */
export function mobileMoneyAmount(usdCents: number, rate: number, country: MobileMoneyCountry): number | null {
  if (!(rate > 0) || !(usdCents > 0)) return null;
  const target = (usdCents / 100) * rate * (1 + FX_ALLOWANCE);
  let amount = Math.ceil(target / (1 - country.fee.share));
  // A fixed fee raises the amount, which can move it to a higher tier: try again until it fits.
  for (let i = 0; i < 20 && keptAfterFee(amount, country.fee) < target; i++) {
    amount = Math.ceil((target + (country.fee.fixed?.(amount) ?? 0)) / (1 - country.fee.share));
  }
  return Number.isFinite(amount) && keptAfterFee(amount, country.fee) >= target ? amount : null;
}

/** Something to buy with mobile money: a credit pack, or a plan's prepaid pass. */
export type MobileMoneyProduct =
  | { id: string; kind: "pack"; packId: string; name: string; usdCents: number; credits: number }
  | { id: string; kind: "pass"; planId: string; interval: Interval; name: string; usdCents: number; credits: number };

export const MOBILE_MONEY_PRODUCTS: MobileMoneyProduct[] = [
  ...CREDIT_PACKS.map((p) => ({ id: `pack:${p.id}`, kind: "pack" as const, packId: p.id, name: p.name, usdCents: p.priceCents, credits: p.credits })),
  ...PLANS.flatMap((p) =>
    (["month", "year"] as const).map((interval) => ({
      id: `pass:${p.id}:${interval}`,
      kind: "pass" as const,
      planId: p.id,
      interval,
      name: p.name,
      usdCents: planPrice(p, interval),
      credits: planCredits(p),
    })),
  ),
];

export const mobileMoneyProduct = (id: unknown) => MOBILE_MONEY_PRODUCTS.find((p) => p.id === id);
