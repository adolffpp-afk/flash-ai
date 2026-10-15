import { useId, type CSSProperties } from "react";
import { BRAND_NAME, PRODUCT_NAME } from "@/lib/product";

/*
 * The Flash ∞ AI brand: an "F" whose stem drops into a lightning bolt (cyan to blue to violet to pink),
 * with an infinity loop for its middle arm (pink to gold). One drawing serves the favicon, the in-app
 * logo and the generated images (app icon, social preview), so they always match. It is plain SVG, so
 * the generated images don't need to download a font. The names themselves are in src/lib/product.ts.
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
// The F's middle arm: an infinity loop, tucked behind the stem.
const LOOP =
  "M51.18 24.61C51.42 24.95 51.47 25.26 51.42 25.63C51.36 26 51.17 26.47 50.76 26.93C50.34 27.4 49.7 27.84 48.99 28.1C48.28 28.35 47.51 28.41 46.89 28.3C46.58 28.25 46.31 28.16 46.08 28.04C45.84 27.92 45.63 27.77 45.37 27.51C44.87 27.01 44.21 26.16 43.59 25.38C42.98 24.61 42.46 23.86 41.63 22.92C41.2 22.43 40.64 21.91 39.99 21.49C39.34 21.07 38.62 20.75 37.85 20.55C36.33 20.14 34.67 20.18 33.12 20.63C31.56 21.08 30.11 21.94 29 23.14C27.89 24.34 27.14 25.9 27.04 27.57C26.93 29.23 27.53 30.95 28.66 32.2L32.57 28.64C32.33 28.38 32.21 28.14 32.18 27.77C32.16 27.4 32.29 26.87 32.68 26.33C33.08 25.79 33.74 25.27 34.51 24.98C35.27 24.69 36.12 24.62 36.79 24.77C37.13 24.84 37.43 24.96 37.68 25.12C37.93 25.27 38.14 25.46 38.38 25.75C38.86 26.31 39.45 27.2 40.01 28.02C40.56 28.84 41.01 29.62 41.82 30.62C42.23 31.14 42.79 31.7 43.45 32.15C44.12 32.61 44.87 32.96 45.66 33.18C47.25 33.62 48.98 33.58 50.59 33.09C52.19 32.6 53.67 31.67 54.76 30.4C55.85 29.12 56.53 27.5 56.56 25.83C56.59 24.17 55.92 22.51 54.79 21.34ZM29 23.14C27.89 24.34 27.14 25.9 27.04 27.57C26.93 29.23 27.53 30.95 28.66 32.2C29.78 33.45 31.37 34.23 33.02 34.48C34.67 34.73 36.39 34.47 37.91 33.81C39.43 33.15 40.76 31.98 41.61 30.88C42.44 29.82 42.97 28.93 43.6 28.01C44.22 27.09 44.87 26.12 45.45 25.41C46.05 24.68 46.65 24.23 47.44 23.94C48.22 23.65 49.09 23.6 49.78 23.76C50.46 23.92 50.95 24.27 51.18 24.61C51.42 24.95 51.47 25.26 51.42 25.63C51.36 26 51.17 26.47 50.76 26.93L54.76 30.4C55.85 29.12 56.53 27.5 56.56 25.83C56.59 24.17 55.92 22.51 54.79 21.34C53.65 20.17 52.11 19.48 50.52 19.26C48.94 19.04 47.29 19.29 45.82 19.9C44.34 20.52 43.03 21.6 42.14 22.65C41.29 23.66 40.69 24.51 40 25.39C39.32 26.26 38.6 27.2 37.99 27.85C37.36 28.53 36.77 28.9 36.04 29.15C35.3 29.39 34.51 29.43 33.88 29.3C33.25 29.18 32.82 28.9 32.57 28.64C32.33 28.38 32.21 28.14 32.18 27.77C32.16 27.4 32.29 26.87 32.68 26.33Z";
// The loop's own box (x y width height), for the infinity in the wordmark.
const LOOP_BOX = "26.6 18.8 30.4 16.1";
// Centres the mark, or (small) enlarges it to fill a favicon tile.
const PLACE = "translate(-2.5 2)";
const PLACE_SMALL = "translate(32 32.5) scale(1.07) translate(-35 -32.6)";

// The gradients' directions, in each shape's own box.
const BOLT_SWEEP = "matrix(-0.65 1 1 0.65 0.85 0)";
const LOOP_SWEEP = "matrix(.982 .39 -.203 1.884 .08 .032)";
// The loop's colours: soft pink to gold on the navy tile, deeper pink to amber on a page, so it holds by day.
const LOOP_ON_NAVY = ["#f9a8d4", "#fcd34d"] as const;
const LOOP_ON_PAGE = ["#f472b6", "#f59e0b"] as const;

/**
 * The logo mark. `id` keeps the gradient ids unique when several marks share a page. `tile` puts it on
 * the deep navy square of the app icon; `onNavy` gives it the app icon's softer loop without the tile,
 * for icons that draw their own navy around it; `small` enlarges it so it still reads at 16px.
 */
export function BrandMark({
  size,
  id = "flash",
  tile = false,
  onNavy = false,
  small = false,
}: {
  size: number;
  id?: string;
  tile?: boolean;
  onNavy?: boolean;
  small?: boolean;
}) {
  const [from, to] = tile || onNavy ? LOOP_ON_NAVY : LOOP_ON_PAGE;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-f`} gradientTransform={BOLT_SWEEP}>
          <stop offset="0" stopColor="#5eeaf4" />
          <stop offset="0.32" stopColor="#5b8cf6" />
          <stop offset="0.62" stopColor="#9b6cf4" />
          <stop offset="1" stopColor="#f472b6" />
        </linearGradient>
        <linearGradient id={`${id}-loop`} gradientTransform={LOOP_SWEEP}>
          <stop offset="0" stopColor={from} />
          <stop offset="1" stopColor={to} />
        </linearGradient>
        {tile && (
          <linearGradient id={`${id}-tile`} gradientTransform="matrix(1 1 -1 1 0 0)">
            <stop offset="0" stopColor="#222944" />
            <stop offset="1" stopColor="#0d1124" />
          </linearGradient>
        )}
      </defs>
      {tile && <rect width="64" height="64" rx="14" fill={`url(#${id}-tile)`} />}
      {tile && (
        <rect x="0.75" y="0.75" width="62.5" height="62.5" rx="13.25" fill="none" stroke="#5b8cf6" strokeOpacity="0.35" strokeWidth="1.5" />
      )}
      <g transform={small ? PLACE_SMALL : PLACE}>
        <path d={LOOP} fill={`url(#${id}-loop)`} />
        <path d={F_BOLT} fill={`url(#${id}-f)`} />
      </g>
    </svg>
  );
}

/** The logo mark for React pages, with gradient ids unique to each copy. */
export function LogoMark({ size = 32, className = "" }: { size?: number; className?: string }) {
  const id = `flash${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    // By day a faint navy edge keeps the mark from fading into the light page.
    <span className={`flex w-fit shrink-0 light:[filter:drop-shadow(0_1px_1.5px_rgb(16_22_48/0.35))] ${className}`}>
      <BrandMark size={size} id={id} small={size < 40} />
    </span>
  );
}

/**
 * The infinity of the wordmark, pink to amber. Sized in em by default, so it matches the text around
 * it; the generated images pass sizes in pixels.
 */
export function InfinitySymbol({
  id,
  width = "0.98em",
  height = "0.52em",
  className,
  style,
}: {
  id: string;
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg width={width} height={height} viewBox={LOOP_BOX} className={className} style={style} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-inf`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#f472b6" />
          <stop offset="1" stopColor="#f59e0b" />
        </linearGradient>
      </defs>
      <path d={LOOP} fill={`url(#${id}-inf)`} />
    </svg>
  );
}

/**
 * "Flash ∞ AI", with the logo's infinity drawn rather than typed: the app's font has no ∞, and another
 * font's would not match. It takes the font, size, weight and colour around it, and screen readers read
 * it as "Flash Infinity AI".
 */
export function Wordmark({ className = "" }: { className?: string }) {
  const id = `wordmark${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <span role="img" aria-label={BRAND_NAME} className={`whitespace-nowrap ${className}`}>
      Flash
      {/* As in the logo: about half the text's height, just above the line, with a space either side. */}
      <InfinitySymbol id={id} className="mx-[0.24em] inline-block align-[0.06em]" />
      AI
    </span>
  );
}

/** A line of text, such as a translated "Install Flash ∞ AI", with the name in it drawn as the Wordmark. */
export function WithWordmark({ text }: { text: string }) {
  const [before, ...after] = text.split(PRODUCT_NAME);
  if (!after.length) return text;
  return (
    <>
      {before}
      <Wordmark />
      {after.join(PRODUCT_NAME)}
    </>
  );
}

/** A small four-point sparkle, as around the orb on Home. It takes the text colour. */
export function Sparkle({ className = "h-2.5 w-2.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true" focusable="false">
      <path d="M8 0l1.9 6.1L16 8l-6.1 1.9L8 16l-1.9-6.1L0 8l6.1-1.9z" fill="currentColor" />
    </svg>
  );
}

/** The mark plus the "Flash ∞ AI" wordmark. */
export function Logo({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <LogoMark size={size} />
      <Wordmark />
    </span>
  );
}

/** The mark in a single colour for inline use, such as credit counts. It takes the text colour. */
export function BoltIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      <g transform={PLACE_SMALL}>
        <path d={LOOP} fill="currentColor" />
        <path d={F_BOLT} fill="currentColor" />
      </g>
    </svg>
  );
}
