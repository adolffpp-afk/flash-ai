import { useId } from "react";

/*
 * The Flash brand: a gold bolt on a deep emerald tile, with a small red spark. One drawing serves the
 * favicon, the in-app logo and the generated images (app icon, social preview), so they always match.
 * It is plain SVG, so the generated images don't need to download an emoji font.
 */

// Brand colours, mirrored by the CSS tokens in globals.css (for places CSS can't reach, like ImageResponse).
export const BRAND = {
  ink: "#060d0a",
  emerald: "#10b981",
  emeraldDeep: "#064e3b",
  gold: "#f5c542",
  amber: "#f59e0b",
  spark: "#ff4545",
} as const;

// The tile behind the bolt, as a CSS background.
export const GRADIENT = "linear-gradient(135deg, #0b8a5f, #064e3b 55%, #04291e)";

const BOLT = "M37 6 14 36h14.5L24 58l27-32H36.5z";
const SPARK = "M51 5.5l2.1 5.4 5.4 2.1-5.4 2.1L51 20.5l-2.1-5.4-5.4-2.1 5.4-2.1z";

/**
 * The logo mark. `id` keeps the gradient ids unique when several marks share a page; `tile` false
 * draws the bolt and spark alone, for placing on a background of your own.
 */
export function BrandMark({ size, id = "flash", tile = true }: { size: number; id?: string; tile?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0b8a5f" />
          <stop offset="0.55" stopColor="#064e3b" />
          <stop offset="1" stopColor="#04291e" />
        </linearGradient>
        <linearGradient id={`${id}-bolt`} x1="0.3" y1="0" x2="0.7" y2="1">
          <stop offset="0" stopColor="#fff3b0" />
          <stop offset="0.45" stopColor="#f5c542" />
          <stop offset="1" stopColor="#f08c00" />
        </linearGradient>
      </defs>
      {tile && <rect width="64" height="64" rx="15" fill={`url(#${id}-tile)`} />}
      {tile && (
        <rect x="1" y="1" width="62" height="62" rx="14" fill="none" stroke="#34d399" strokeOpacity="0.35" strokeWidth="1.5" />
      )}
      <path d={BOLT} fill={`url(#${id}-bolt)`} stroke="#7a4a00" strokeOpacity="0.45" strokeWidth="1" strokeLinejoin="round" />
      <path d={SPARK} fill={BRAND.spark} />
    </svg>
  );
}

/** The logo mark for React pages, with gradient ids unique to each copy. */
export function LogoMark({ size = 32, className = "" }: { size?: number; className?: string }) {
  const id = `flash${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <span className={`flex w-fit shrink-0 drop-shadow-[0_4px_14px_rgba(16,185,129,0.25)] ${className}`}>
      <BrandMark size={size} id={id} />
    </span>
  );
}

/** The mark plus the "Flash AI" wordmark. */
export function Logo({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <LogoMark size={size} />
      <span>
        Flash <span className="text-gold-gradient">AI</span>
      </span>
    </span>
  );
}

/** A single-colour bolt for inline use, such as credit counts. It takes the text colour. */
export function BoltIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      <path d={BOLT} fill="currentColor" />
    </svg>
  );
}
