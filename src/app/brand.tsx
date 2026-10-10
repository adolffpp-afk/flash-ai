import { useId } from "react";

/*
 * The Flash brand: an "F" whose stem drops into a lightning bolt, drawn as two swept ribbons (cyan to
 * blue to violet to pink, and pink to gold), with a small red spark. After the owner's own sketch, in the
 * iridescent colours of the new look. One drawing serves the favicon, the in-app logo and the generated
 * images (app icon, social preview), so they always match. It is plain SVG, so the generated images
 * don't need to download a font.
 */

// Brand colours, mirrored by the CSS tokens in globals.css (for places CSS can't reach, like ImageResponse).
export const BRAND = {
  ink: "#0a0c10",
  emerald: "#10b981",
  emeraldDeep: "#064e3b",
  gold: "#f5c542",
  amber: "#f59e0b",
  spark: "#ff4545",
  holoSilver: "#e4e8ee",
  holoRose: "#f5b6cf",
  holoPeach: "#f6d39e",
  holoLavender: "#bcc4f6",
  holoMint: "#a5eadb",
} as const;

// The holographic sheen as a CSS background, for places the utilities in globals.css can't reach.
export const HOLO = `linear-gradient(100deg, ${BRAND.holoSilver}, ${BRAND.holoRose} 22%, ${BRAND.holoPeach} 42%, ${BRAND.holoLavender} 62%, ${BRAND.holoMint} 80%, ${BRAND.holoSilver})`;

// The deep navy behind the mark on app icons, as a CSS background (the same as --brand-fill in globals.css).
export const GRADIENT = "linear-gradient(135deg, #222944, #0d1124)";

// The F's top arm, stem and bolt, as one shape.
const F_BOLT = "M24 10C34 6.5 46 7 57 7L52.5 15.5C44 15.5 36 16 32.5 19L27.5 30H33L15 58L20.5 36H14Z";
// The F's middle arm, tucked behind the stem.
const F_ARM = "M26 26C32 23 40 22.5 51 22.5C49 27 46 30.5 40 31C35 31.2 31 32 27 35Z";
const SPARK = "M49 42l1.4 3.6 3.6 1.4-3.6 1.4L49 52l-1.4-3.6-3.6-1.4 3.6-1.4z";
// Centres the F, or (small) enlarges it to fill a favicon tile.
const PLACE = "translate(-3 0.5)";
const PLACE_SMALL = "translate(32 32.5) scale(1.12) translate(-35.5 -32.5)";

/**
 * The logo mark. `id` keeps the gradient ids unique when several marks share a page. `tile` puts it on a
 * deep navy square, for icons; `small` drops the spark and enlarges the F so it still reads at 16px.
 */
export function BrandMark({
  size,
  id = "flash",
  tile = false,
  small = false,
}: {
  size: number;
  id?: string;
  tile?: boolean;
  small?: boolean;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-f`} x1="0.85" y1="0" x2="0.2" y2="1">
          <stop offset="0" stopColor="#5eeaf4" />
          <stop offset="0.32" stopColor="#5b8cf6" />
          <stop offset="0.62" stopColor="#9b6cf4" />
          <stop offset="1" stopColor="#f472b6" />
        </linearGradient>
        <linearGradient id={`${id}-arm`} x1="0" y1="0" x2="1" y2="0.6">
          <stop offset="0" stopColor="#f9a8d4" />
          <stop offset="1" stopColor="#fcd34d" />
        </linearGradient>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#222944" />
          <stop offset="1" stopColor="#0d1124" />
        </linearGradient>
      </defs>
      {tile && <rect width="64" height="64" rx="14" fill={`url(#${id}-tile)`} />}
      {tile && (
        <rect x="0.75" y="0.75" width="62.5" height="62.5" rx="13.25" fill="none" stroke="#5b8cf6" strokeOpacity="0.35" strokeWidth="1.5" />
      )}
      <g transform={small ? PLACE_SMALL : PLACE}>
        <path d={F_ARM} fill={`url(#${id}-arm)`} />
        <path d={F_BOLT} fill={`url(#${id}-f)`} />
        {!small && <path d={SPARK} fill={BRAND.spark} />}
      </g>
    </svg>
  );
}

/** The logo mark for React pages, with gradient ids unique to each copy. */
export function LogoMark({ size = 32, className = "" }: { size?: number; className?: string }) {
  const id = `flash${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  // The spark is too fine to read in a small mark, so small marks show the F alone.
  return (
    // By day a faint navy edge keeps the mark from fading into the light page.
    <span className={`flex w-fit shrink-0 light:[filter:drop-shadow(0_1px_1.5px_rgb(16_22_48/0.35))] ${className}`}>
      <BrandMark size={size} id={id} small={size < 40} />
    </span>
  );
}

/** A small four-point sparkle, as after "AI" in the wordmark. It takes the text colour. */
export function Sparkle({ className = "h-2.5 w-2.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true" focusable="false">
      <path d="M8 0l1.9 6.1L16 8l-6.1 1.9L8 16l-1.9-6.1L0 8l6.1-1.9z" fill="currentColor" />
    </svg>
  );
}

/** The mark plus the "Flash AI" wordmark, with the sparkle after "AI". */
export function Logo({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <LogoMark size={size} />
      <span>
        Flash <span className="text-holo">AI</span>
        <Sparkle className="ml-0.5 inline-block h-2 w-2 align-top text-spark" />
      </span>
    </span>
  );
}

/** The F-bolt in a single colour for inline use, such as credit counts. It takes the text colour. */
export function BoltIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      <g transform={PLACE_SMALL}>
        <path d={F_ARM} fill="currentColor" />
        <path d={F_BOLT} fill="currentColor" />
      </g>
    </svg>
  );
}
