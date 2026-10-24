import { CREDIT_LIMITS, CREDIT_PACKS, EXTRA_SEAT, FREE_MONTHLY_CREDITS, MAX_EXTRA_SEATS, PLANS, TYPICAL_CREDITS, YEARLY_SAVING } from "../credits.ts";
import { templateCredits } from "../templates.ts";
import { CHAT_MODEL } from "../engines/claude.ts";
import { MODELS, STUDIO_MODELS, modelCredits } from "../models.ts";
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
import { domainsConfigured } from "./domains.ts";
import { connectorsReady } from "./secret-box.ts";
import { studioOpen } from "./studio.ts";
import { playBillingConfigured } from "./play-billing.ts";

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
    // About how much less yearly billing costs, for the Monthly / Yearly switch.
    yearlySaving: YEARLY_SAVING,
    // More people on a team plan, each with more monthly credits.
    extraSeat: { ...EXTRA_SEAT, max: MAX_EXTRA_SEATS },
    freeMonthly: FREE_MONTHLY_CREDITS,
    // Free models once credits run out, per user per day.
    freeLane: {
      chats: freeChatConfigured() ? FREE_DAILY_CHATS : 0,
      images: freeImageConfigured() ? FREE_DAILY_IMAGES : 0,
      transcripts: freeTranscribeConfigured() ? FREE_DAILY_TRANSCRIPTS : 0,
    },
    paymentsEnabled: paymentsEnabled(),
    // Credit packs can be bought inside the Android app, through Google Play (see play-billing.ts).
    playBilling: playBillingConfigured(),
    // Custom domains for published sites (Vercel's API is set up).
    domainsEnabled: domainsConfigured(),
    // The user's own accounts in chat (CONNECTOR_KEYS is set; see secret-box.ts).
    connectorsEnabled: connectorsReady(),
    // The ChatGPT models in the Intelligence menu (OPENAI_API_KEY is set; see openai-chat.ts).
    chatgpt: openaiConfigured(),
    // FLASH_DEMO_PURCHASES: test purchases without Stripe, for local testing only.
    testPurchases: demoPurchases(),
    // The Ads Studio is listed once it's open to everyone (see studio.ts).
    models: MODELS.filter((m) => !STUDIO_MODELS.includes(m.id) || studioOpen()).map((m) => ({
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
