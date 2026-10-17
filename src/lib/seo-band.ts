/*
 * The search check's score bands, as Google's own scores are banded: 90 and up is good, under 50
 * poor. On its own so the list of apps and the chat's preview can colour a score without loading
 * the whole check (seo-rules.ts).
 */
export type Band = "good" | "needs" | "poor";

export const band = (score: number): Band => (score >= 90 ? "good" : score >= 50 ? "needs" : "poor");

/** A score's pill behind it, in the band's colour (each flips in the light theme). */
export const BAND_PILL: Record<Band, string> = { good: "bg-emerald-500/15 text-emerald-400", needs: "bg-gold/15 text-gold-soft", poor: "bg-red-500/15 text-red-400" };

/**
 * Where Google's report colours a number from its test orange and red: Lighthouse's own scoring
 * points (p10 and median, core/audits/metrics/*.js), which are stricter on a computer than on a phone.
 */
const LAB_LIMITS = {
  mobile: { lcp: [2500, 4000], fcp: [1800, 3000], tbt: [200, 600], cls: [0.1, 0.25] },
  desktop: { lcp: [1200, 2400], fcp: [934, 1600], tbt: [150, 350], cls: [0.1, 0.25] },
} as const;

/** A number from Google's test (milliseconds, or the layout shift), banded as Google's report bands it for that device. */
export function labBand(strategy: "mobile" | "desktop", metric: "lcp" | "fcp" | "tbt" | "cls", value: number): Band {
  const [good, poor] = LAB_LIMITS[strategy][metric];
  return value <= good ? "good" : value <= poor ? "needs" : "poor";
}
