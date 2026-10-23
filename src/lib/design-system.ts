/*
 * Flash's design system: professional colour palettes and the design rules every tool that makes
 * something visual follows (apps and sites, slides, documents, emails, pictures), so all of Flash's
 * work comes out with the same polish. Tools put designGuide() in their prompt, or pick a palette
 * with paletteFor() and use its colours directly.
 */

export type Palette = {
  id: string;
  name: string;
  // What it suits, for picking one by the request's words.
  fits: string[];
  dark: boolean;
  colors: { background: string; surface: string; text: string; muted: string; line: string; accent: string; onAccent: string; second: string };
  fonts: { heading: string; body: string };
};

export const PALETTES: Palette[] = [
  {
    id: "midnight",
    name: "Midnight premium",
    fits: ["phone", "gadget", "electronics", "tech", "gaming", "audio", "store", "shop", "luxury", "car"],
    dark: true,
    colors: { background: "#0b0b0f", surface: "#15151c", text: "#f4f4f5", muted: "#a1a1aa", line: "#27272a", accent: "#ff6a1a", onAccent: "#0b0b0f", second: "#38bdf8" },
    fonts: { heading: "Space Grotesk", body: "Inter" },
  },
  {
    id: "electric",
    name: "Electric navy",
    fits: ["software", "saas", "startup", "finance", "bank", "fintech", "crypto", "app", "dashboard", "insurance"],
    dark: false,
    colors: { background: "#f8fafc", surface: "#ffffff", text: "#0f172a", muted: "#475569", line: "#e2e8f0", accent: "#2563eb", onAccent: "#ffffff", second: "#0b1b3a" },
    fonts: { heading: "Manrope", body: "Inter" },
  },
  {
    id: "bakery",
    name: "Warm bakery",
    fits: ["bakery", "cafe", "coffee", "restaurant", "food", "pizza", "catering", "chocolate", "kitchen", "recipe"],
    dark: false,
    colors: { background: "#fbf7f2", surface: "#ffffff", text: "#2b1d14", muted: "#7a6656", line: "#eadfd3", accent: "#c2410c", onAccent: "#ffffff", second: "#3f6212" },
    fonts: { heading: "Playfair Display", body: "DM Sans" },
  },
  {
    id: "fresh",
    name: "Fresh green",
    fits: ["organic", "health", "farm", "garden", "plant", "eco", "nutrition", "yoga", "wellness", "grocery"],
    dark: false,
    colors: { background: "#f6faf6", surface: "#ffffff", text: "#12261b", muted: "#4b6355", line: "#d9e8dc", accent: "#15803d", onAccent: "#ffffff", second: "#ca8a04" },
    fonts: { heading: "Fraunces", body: "Inter" },
  },
  {
    id: "clinic",
    name: "Clinic calm",
    fits: ["clinic", "doctor", "dental", "dentist", "hospital", "pharmacy", "medical", "therapy", "care", "lab"],
    dark: false,
    colors: { background: "#f5f9fc", surface: "#ffffff", text: "#0c2233", muted: "#4f6577", line: "#dbe7ef", accent: "#0e7490", onAccent: "#ffffff", second: "#16a34a" },
    fonts: { heading: "Plus Jakarta Sans", body: "Inter" },
  },
  {
    id: "editorial",
    name: "Editorial mono",
    fits: ["agency", "portfolio", "photographer", "studio", "architect", "fashion", "magazine", "blog", "artist", "design"],
    dark: false,
    colors: { background: "#fafaf9", surface: "#ffffff", text: "#111111", muted: "#6b6b6b", line: "#e7e5e4", accent: "#111111", onAccent: "#ffffff", second: "#e11d48" },
    fonts: { heading: "DM Serif Display", body: "DM Sans" },
  },
  {
    id: "gold",
    name: "Luxury gold",
    fits: ["salon", "spa", "beauty", "jewellery", "jewelry", "hotel", "real estate", "wedding", "barber", "perfume"],
    dark: true,
    colors: { background: "#0f0e0c", surface: "#1a1815", text: "#f5efe6", muted: "#b8ab97", line: "#2c2823", accent: "#c9a45c", onAccent: "#0f0e0c", second: "#e7d8bd" },
    fonts: { heading: "Cormorant Garamond", body: "Inter" },
  },
  {
    id: "coral",
    name: "Playful coral",
    fits: ["kids", "school", "toy", "party", "event", "game", "pet", "music", "festival", "community"],
    dark: false,
    colors: { background: "#fff8f5", surface: "#ffffff", text: "#2a1a1f", muted: "#7b5f66", line: "#f6e1da", accent: "#f43f5e", onAccent: "#ffffff", second: "#6366f1" },
    fonts: { heading: "Poppins", body: "Nunito" },
  },
  {
    id: "ocean",
    name: "Ocean travel",
    fits: ["travel", "tour", "beach", "resort", "airline", "boat", "holiday", "booking", "rental", "surf"],
    dark: false,
    colors: { background: "#f4f9fb", surface: "#ffffff", text: "#0b2530", muted: "#4a6670", line: "#d8e9ef", accent: "#0284c7", onAccent: "#ffffff", second: "#f59e0b" },
    fonts: { heading: "Outfit", body: "Inter" },
  },
  {
    id: "energy",
    name: "Fitness energy",
    fits: ["gym", "fitness", "sport", "football", "coach", "training", "running", "boxing", "club", "team"],
    dark: true,
    colors: { background: "#0a0a0a", surface: "#161616", text: "#fafafa", muted: "#a3a3a3", line: "#262626", accent: "#a3e635", onAccent: "#0a0a0a", second: "#f97316" },
    fonts: { heading: "Bebas Neue", body: "Inter" },
  },
  {
    id: "slate",
    name: "Professional slate",
    fits: ["law", "lawyer", "consulting", "accounting", "business", "corporate", "construction", "logistics", "report", "church"],
    dark: false,
    colors: { background: "#f8f9fb", surface: "#ffffff", text: "#111827", muted: "#4b5563", line: "#e5e7eb", accent: "#1e3a8a", onAccent: "#ffffff", second: "#b45309" },
    fonts: { heading: "Libre Baskerville", body: "Source Sans 3" },
  },
  {
    id: "sunset",
    name: "Sunset market",
    fits: ["market", "fabric", "craft", "african", "boutique", "clothing", "beauty supply", "mobile money", "transfer", "remittance"],
    dark: false,
    colors: { background: "#fffaf3", surface: "#ffffff", text: "#2d1b0e", muted: "#7c6350", line: "#f0e2cf", accent: "#d97706", onAccent: "#ffffff", second: "#065f46" },
    fonts: { heading: "Sora", body: "Inter" },
  },
];

/** The palette that best fits a request's words, or the one to fall back on (Electric navy). */
export function paletteFor(request: string): Palette {
  const words = request.toLowerCase();
  let best = PALETTES[1];
  let score = 0;
  for (const p of PALETTES) {
    const hits = p.fits.filter((f) => new RegExp(`\\b${f}`).test(words)).length;
    if (hits > score) {
      best = p;
      score = hits;
    }
  }
  return best;
}

const line = (p: Palette) =>
  `- ${p.name} (${p.dark ? "dark" : "light"}; for ${p.fits.slice(0, 5).join(", ")}): background ${p.colors.background}, surface ${p.colors.surface}, text ${p.colors.text}, muted ${p.colors.muted}, lines ${p.colors.line}, accent ${p.colors.accent} with ${p.colors.onAccent} on it, second accent ${p.colors.second}; fonts ${p.fonts.heading} for headings and ${p.fonts.body} for text.`;

/** The design rules every visual tool follows, with the palettes to choose from. */
export function designGuide(): string {
  return `Flash's design system (follow it so the result looks as polished as the best paid products):
- Unless the user or their brand kit gives colours, use one of these palettes exactly, chosen for the kind of business or topic. Keep the accent for the main actions and highlights only.
${PALETTES.map(line).join("\n")}
- Type: the palette's heading font, large and tight (hero titles 44 to 72px on a computer, 32 to 40px on a phone, letter-spacing about -0.02em), body text 16 to 18px with line height 1.6, small uppercase labels with wide letter-spacing for eyebrows and categories.
- Space: generous and even, on a 4px rhythm (sections 64 to 112px apart on a computer, 48 to 64px on a phone), side padding of at least 16px on phones and 24 to 32px wider, content no wider than about 1200px.
- Surfaces: soft 12 to 20px corners, thin 1px lines in the palette's line colour, gentle shadows on light palettes and subtle lighter surfaces on dark ones, a sticky header with a blurred background.
- Finish like a premium brand: a slim announcement strip at the top when it suits (free delivery, an offer), real photos everywhere they help, icons from one set, and a full footer with columns, contact details and social links. A shop shows a cart counter in the header, prices with old prices struck through on sale items, ratings only when real, and an add-to-cart button on every product.`;
}
