/*
 * The search check's score bands, as Google's own scores are banded: 90 and up is good, under 50
 * poor. On its own so the list of apps and the chat's preview can colour a score without loading
 * the whole check (seo-rules.ts). With them, how a time from Google's test is written.
 */
export type Band = "good" | "needs" | "poor";

export const band = (score: number): Band => (score >= 90 ? "good" : score >= 50 ? "needs" : "poor");

/**
 * A score's pill behind it, in the band's colour. In the light theme its words are a deeper shade, so
 * a small score on its tint still reads (4.5:1 or more).
 */
export const BAND_PILL: Record<Band, string> = {
  good: "bg-emerald-500/15 text-emerald-400 light:text-emerald-200",
  needs: "bg-gold/15 text-gold-soft light:text-amber-200",
  poor: "bg-red-500/15 text-red-400 light:text-red-200",
};

/** A band's colour for its words and its score's ring, deeper in the light theme as the pills are. */
export const BAND_TEXT: Record<Band, string> = { good: "text-emerald-400 light:text-emerald-200", needs: "text-gold-soft light:text-amber-200", poor: "text-red-400 light:text-red-200" };

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

const NUMBER_PARTS = new Set(["integer", "group", "decimal", "fraction", "minusSign", "plusSign"]);

/**
 * A time from Google's test as the owner's language writes it ("3.1 s", "30 ms"). Some languages'
 * short forms leave the number out for one or two: Hebrew writes 1 or 0.5 seconds as just "שנ׳", and
 * 2 as "שתי שנ׳". Then the number goes where that language puts it for ten.
 */
export function timeLabel(value: number, unit: "second" | "millisecond", locale: string): string {
  try {
    const digits = unit === "second" ? 1 : 0;
    const format = new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: digits });
    if (format.formatToParts(value).some((p) => p.type === "integer")) return format.format(value);
    const number = new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
    let placed = false;
    const written = format
      .formatToParts(10)
      .map((p) => (!NUMBER_PARTS.has(p.type) ? p.value : placed ? "" : ((placed = true), number)))
      .join("");
    return placed ? written : `${number} ${unit === "second" ? "s" : "ms"}`;
  } catch {
    return `${value} ${unit === "second" ? "s" : "ms"}`;
  }
}
