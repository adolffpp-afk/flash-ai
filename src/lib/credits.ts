import type { Engine } from "./types.ts";

// Credits per request. Roughly tracks what each engine costs Flash to run.
export const CREDIT_COSTS: Record<Engine, number> = {
  text: 1,
  search: 2,
  code: 2,
  translate: 1,
  docs: 2,
  app: 10,
  slides: 8,
  image: 5,
  voice: 3,
  transcribe: 3,
  music: 15,
  video: 40,
};

export const FREE_MONTHLY_CREDITS = Number(process.env.FLASH_FREE_CREDITS ?? 100);

export type CreditPack = { id: string; name: string; credits: number; priceCents: number; blurb: string };

export const CREDIT_PACKS: CreditPack[] = [
  { id: "starter", name: "Starter", credits: 500, priceCents: 500, blurb: "Plenty for daily writing and research" },
  { id: "creator", name: "Creator", credits: 2500, priceCents: 2000, blurb: "Apps, images and music every week" },
  { id: "studio", name: "Studio", credits: 7500, priceCents: 5000, blurb: "Heavy video and app building" },
];
