import { CREDIT_LIMITS, CREDIT_PACKS, FREE_MONTHLY_CREDITS, PLANS, TYPICAL_CREDITS } from "../credits.ts";
import { MODELS, modelCredits } from "../models.ts";
import { ENGINES, type Engine } from "../types.ts";
import { elevenConfigured, openaiConfigured } from "../engines/media.ts";
import { falConfigured } from "../engines/fal.ts";
import { paymentsEnabled } from "./stripe.ts";

/** Prices, packs and models, shared by the public pricing section and the signed-in credits panel. */
export function pricingInfo() {
  const live = { openai: openaiConfigured(), elevenlabs: elevenConfigured(), fal: falConfigured() };
  return {
    // Typical credits per request; media engines show their cheapest model.
    costs: Object.fromEntries(
      ENGINES.map((e) => [
        e,
        TYPICAL_CREDITS[e] ?? Math.min(...MODELS.filter((m) => m.engine === e).map((m) => modelCredits(m))),
      ]),
    ) as Record<Engine, number>,
    limits: CREDIT_LIMITS,
    packs: CREDIT_PACKS,
    plans: PLANS,
    freeMonthly: FREE_MONTHLY_CREDITS,
    paymentsEnabled: paymentsEnabled(),
    models: MODELS.map((m) => ({
      id: m.id,
      engine: m.engine,
      label: m.label,
      credits: modelCredits(m),
      blurb: m.blurb,
      live: live[m.provider],
    })),
  };
}

export type PricingInfo = ReturnType<typeof pricingInfo>;
