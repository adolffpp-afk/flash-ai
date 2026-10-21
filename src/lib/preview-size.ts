import { msg } from "./i18n.ts";
import type { BuiltApp } from "./types.ts";

/*
 * The sizes the build preview can show an app at, in CSS pixels: a common tablet and phone held
 * upright. The app sees that width, so its own tablet or phone layout shows; a frame wider than the
 * panel is drawn smaller, never cut off.
 */
export const PREVIEW_SIZES = { tablet: 820, phone: 390 } as const;
export type PreviewSize = "" | keyof typeof PREVIEW_SIZES;

export const SIZE_PICKS: { size: PreviewSize; label: string }[] = [
  { size: "", label: msg("Computer size") },
  { size: "tablet", label: msg("Tablet size") },
  { size: "phone", label: msg("Phone size") },
];

// The room around a tablet or phone frame.
const GAP = 12;

/** The size saved on this device, for this app: slides always fill the width, and anything else saved is ignored. */
export function previewSize(saved: string, kind: BuiltApp["kind"]): PreviewSize {
  return kind !== "slides" && (saved === "tablet" || saved === "phone") ? saved : "";
}

/** Where a tablet or phone frame sits in the panel, drawn smaller when the panel is narrower; none at computer size. */
export function frameFor(size: PreviewSize, panel: { width: number; height: number }) {
  if (!size) return undefined;
  const width = PREVIEW_SIZES[size];
  // Not measured yet (the first paint): full size, until the panel's width is known.
  const scale = panel.width ? Math.min(1, Math.max(0.1, (panel.width - 2 * GAP) / width)) : 1;
  return {
    position: "absolute",
    top: GAP,
    left: "50%",
    width,
    height: Math.max(0, panel.height - 2 * GAP) / scale,
    transform: `translateX(-50%) scale(${scale})`,
    transformOrigin: "top center",
  } as const;
}
