/*
 * The brand kit: a business's name, tagline, colours, tone of voice and logo, saved once and
 * used by Flash for anything made for that business (sites, decks, posts, pictures).
 */

export type BrandKit = {
  name: string;
  tagline: string;
  voice: string;
  colors: string[];
  // A public link to the logo, or "" when there is none.
  logo: string;
};

export const EMPTY_BRAND: BrandKit = { name: "", tagline: "", voice: "", colors: [], logo: "" };
export const MAX_COLORS = 5;
export const MAX_LOGO_BYTES = 1024 * 1024;
// SVG is left out: it can carry scripts, and logos are served from Flash's own address.
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** A brand kit from untrusted input: trimmed, cut to size, colours as #rrggbb. */
export function cleanBrand(input: unknown): Omit<BrandKit, "logo"> {
  const v = (input ?? {}) as Record<string, unknown>;
  const colors = (Array.isArray(v.colors) ? v.colors : [])
    .map((c) => (typeof c === "string" ? c.trim().toLowerCase() : ""))
    .map((c) => (/^#[0-9a-f]{3}$/.test(c) ? `#${[...c.slice(1)].map((x) => x + x).join("")}` : c))
    .filter((c, i, all) => /^#[0-9a-f]{6}$/.test(c) && all.indexOf(c) === i)
    .slice(0, MAX_COLORS);
  return {
    name: text(v.name, 80),
    tagline: text(v.tagline, 140),
    voice: typeof v.voice === "string" ? v.voice.trim().slice(0, 600) : "",
    colors,
  };
}

export const hasBrand = (b: BrandKit | null | undefined): b is BrandKit =>
  Boolean(b && (b.name || b.tagline || b.voice || b.colors.length || b.logo));

/** The brand kit as lines for Flash's instructions. */
export function brandLines(b: BrandKit): string {
  return [
    b.name && `Business name: ${b.name}`,
    b.tagline && `Tagline: ${b.tagline}`,
    b.colors.length && `Brand colours: ${b.colors.join(", ")} (main colour first)`,
    b.voice && `Tone of voice: ${b.voice}`,
    b.logo && `Logo image (a web address that works in websites and apps): ${b.logo}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** What Flash knows about the user, with their brand kit after it. */
export function withBrand(preferences: string, b: BrandKit | null): string {
  if (!hasBrand(b)) return preferences;
  const section =
    "The user's brand kit. Use it for anything made for their business (websites, apps, slides, posts, " +
    "flyers, emails, documents): their colours, name, tone and logo. Ignore it for unrelated requests.\n" +
    brandLines(b);
  return preferences.trim() ? `${preferences.trim()}\n\n${section}` : section;
}

/** Notes for the prompt writer of pictures and videos, which decides whether the brand fits. */
export function brandForMedia(b: BrandKit | null): string {
  if (!hasBrand(b)) return "";
  const lines = [b.name && `Business: ${b.name}`, b.colors.length && `Colours: ${b.colors.join(", ")}`, b.voice && `Style: ${b.voice}`];
  return (
    "If (and only if) this is for the user's business (a post, ad, flyer, menu, poster, banner or their products), " +
    "match their brand. Never invent a logo; leave room for one instead.\n" +
    lines.filter(Boolean).join("\n")
  );
}
