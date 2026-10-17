/*
 * The search check's score bands, as Google's own scores are banded: 90 and up is good, under 50
 * poor. On its own so the list of apps and the chat's preview can colour a score without loading
 * the whole check (seo-rules.ts).
 */
export type Band = "good" | "needs" | "poor";

export const band = (score: number): Band => (score >= 90 ? "good" : score >= 50 ? "needs" : "poor");

/** A score's pill behind it, in the band's colour (each flips in the light theme). */
export const BAND_PILL: Record<Band, string> = { good: "bg-emerald-500/15 text-emerald-400", needs: "bg-gold/15 text-gold-soft", poor: "bg-red-500/15 text-red-400" };
