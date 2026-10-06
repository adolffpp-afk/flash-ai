import type { Engine } from "./types.ts";

// One-tap actions for attached photos; the router sends each to the right tool. Reading text works on
// several photos at once (a week of receipts, the pages of a note); the others take one photo.
export const PHOTO_ACTIONS: { label: string; prompt: string; engine: Engine; several?: string }[] = [
  {
    label: "📄 Copy the text",
    prompt: "Copy all the text from this photo exactly as written.",
    several: "Copy all the text from these photos exactly as written, photo by photo.",
    engine: "docs",
  },
  {
    label: "📊 Make a spreadsheet",
    prompt: "Turn this photo into a spreadsheet: one row per item, with the amounts as numbers.",
    several: "Turn these photos into one spreadsheet: one row per item, with a column for the photo it came from and the amounts as numbers.",
    engine: "docs",
  },
  { label: "✂️ Remove background", prompt: "Remove the background", engine: "image" },
  { label: "🔍 Upscale", prompt: "Upscale this photo and make it sharper", engine: "image" },
  { label: "🎬 Animate", prompt: "Animate this photo with natural, gentle motion", engine: "video" },
];

// Pictures Claude can read, and photos Flash can edit.
export const READABLE_PHOTO = /^image\/(png|jpeg|gif|webp)$/;
export const EDITABLE_PHOTO = /^image\/(png|jpeg|webp)$/;

/** The buttons for these attached files: reading text for one or several photos, the rest for one editable photo. */
export function photoActionsFor(types: string[], live: (engine: Engine) => boolean): typeof PHOTO_ACTIONS {
  if (!types.length || !types.every((t) => READABLE_PHOTO.test(t))) return [];
  return PHOTO_ACTIONS.filter((a) => live(a.engine) && (types.length > 1 ? Boolean(a.several) : a.engine === "docs" || EDITABLE_PHOTO.test(types[0])));
}
