import { isAdmin, type User } from "./auth.ts";

/*
 * Flash Infinity AI Studio is tried out by the owner first: admins only, until FLASH_STUDIO_OPEN is
 * "true" in Vercel (after the owner has made a few ads and says to open it).
 */
export const studioOpen = () => process.env.FLASH_STUDIO_OPEN === "true";

export const studioOpenTo = (user: Pick<User, "email" | "verified_at">): boolean => studioOpen() || isAdmin(user);
