import { CREDIT_LIMITS, CREDIT_PACKS, FREE_MONTHLY_CREDITS, PLANS, TYPICAL_CREDITS } from "../credits.ts";
import { templateCredits } from "../templates.ts";
import { CHAT_MODEL } from "../engines/claude.ts";
import { MODELS, modelCredits } from "../models.ts";
import { ENGINES, type Engine } from "../types.ts";
import { elevenConfigured, openaiConfigured } from "../engines/media.ts";
import { falConfigured } from "../engines/fal.ts";
import {
  FREE_DAILY_CHATS,
  FREE_DAILY_IMAGES,
  FREE_DAILY_TRANSCRIPTS,
  freeChatConfigured,
  freeImageConfigured,
  freeTranscribeConfigured,
} from "../engines/free.ts";
import { demoPurchases, paymentsEnabled } from "./stripe.ts";

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
    // Typical credits for each written template, priced with the model and markup really in use.
    templates: templateCredits(CHAT_MODEL),
    limits: CREDIT_LIMITS,
    packs: CREDIT_PACKS,
    plans: PLANS,
    freeMonthly: FREE_MONTHLY_CREDITS,
    // Free models once credits run out, per user per day.
    freeLane: {
      chats: freeChatConfigured() ? FREE_DAILY_CHATS : 0,
      images: freeImageConfigured() ? FREE_DAILY_IMAGES : 0,
      transcripts: freeTranscribeConfigured() ? FREE_DAILY_TRANSCRIPTS : 0,
    },
    paymentsEnabled: paymentsEnabled(),
    // FLASH_DEMO_PURCHASES: test purchases without Stripe, for local testing only.
    testPurchases: demoPurchases(),
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
