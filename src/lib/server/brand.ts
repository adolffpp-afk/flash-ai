import { EMPTY_BRAND, LOGO_TYPES, MAX_LOGO_BYTES, cleanBrand, type BrandKit } from "../brand.ts";
import { one, run, now } from "./db.ts";
import { saveFile } from "./files.ts";
import { publicFileLink } from "./connector.ts";

type Row = { name: string; tagline: string; voice: string; colors: string; logo_file: string; logo_link: string };

/** A user's brand kit, with the logo as a full web address on `base` (the site's address). */
export async function getBrand(userId: string, base: string): Promise<BrandKit> {
  const row = await one<Row>("SELECT name, tagline, voice, colors, logo_file, logo_link FROM brand_kits WHERE user_id = ?", [userId]);
  if (!row) return EMPTY_BRAND;
  let colors: string[] = [];
  try {
    colors = JSON.parse(row.colors);
  } catch {}
  return { name: row.name, tagline: row.tagline, voice: row.voice, colors, logo: row.logo_link ? `${base}${row.logo_link}` : "" };
}

export type LogoUpload = { mediaType: string; data: string };

/** Why a logo can't be used, or null. */
export function logoProblem(logo: LogoUpload): string | null {
  if (!LOGO_TYPES.includes(logo.mediaType)) return "The logo must be a PNG, JPEG or WebP picture.";
  if (typeof logo.data !== "string" || (logo.data.length * 3) / 4 > MAX_LOGO_BYTES) return "The logo must be 1 MB or smaller.";
  return null;
}

/**
 * Saves a user's brand kit. `logo` is a new picture to use, null to remove the logo, or
 * undefined to keep the current one.
 */
export async function saveBrand(userId: string, input: unknown, logo: LogoUpload | null | undefined): Promise<void> {
  const kit = cleanBrand(input);
  const old = await one<{ logo_file: string }>("SELECT logo_file FROM brand_kits WHERE user_id = ?", [userId]);
  let logoFile = old?.logo_file ?? "";

  let logoLink: string | null = null;
  if (logo !== undefined) {
    // An old logo stays stored, so sites already published with it keep showing it.
    logoFile = "";
    logoLink = "";
    if (logo) {
      const ext = logo.mediaType.split("/")[1].replace("jpeg", "jpg");
      const url = await saveFile(userId, logo.mediaType, `brand-logo.${ext}`, Buffer.from(logo.data, "base64"));
      logoFile = url.split("/").pop()!;
      logoLink = (await publicFileLink(userId, url)) ?? "";
    }
  }
  await run(
    `INSERT INTO brand_kits (user_id, name, tagline, voice, colors, logo_file, logo_link, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET name = excluded.name, tagline = excluded.tagline, voice = excluded.voice,
       colors = excluded.colors, updated_at = excluded.updated_at,
       logo_file = CASE WHEN ? THEN excluded.logo_file ELSE brand_kits.logo_file END,
       logo_link = CASE WHEN ? THEN excluded.logo_link ELSE brand_kits.logo_link END`,
    [userId, kit.name, kit.tagline, kit.voice, JSON.stringify(kit.colors), logoFile, logoLink ?? "", now(), logo !== undefined ? 1 : 0, logo !== undefined ? 1 : 0],
  );
}
