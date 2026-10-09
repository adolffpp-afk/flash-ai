/*
 * How Flash names people. Accounts made with an email link have no name, and some older ones
 * saved the whole email address as the name, so an email never shows where a name should.
 */
import { msg } from "./i18n.ts";
import { languageNote } from "./languages.ts";
import type { Engine } from "./types.ts";

export type Named = { name: string; email: string; nickname?: string };

export const looksLikeEmail = (text: string) => /\S+@\S+/.test(text);

const capitalize = (word: string) => (word ? word[0].toUpperCase() + word.slice(1) : "");

/** "Adolff" from adolff.pierre92@example.com: the first word of the address, without numbers. */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const word = local.split(/[^\p{L}]+/u).find((w) => w.length >= 2) ?? "";
  return capitalize(word.toLowerCase());
}

/** The person's full name, or one made from their email when they never gave one. */
export function fullName(user: Named): string {
  const name = user.name.trim();
  return name && !looksLikeEmail(name) ? name : nameFromEmail(user.email);
}

/** What Flash calls the person: the name they asked for, else their first name. "there" when nothing fits. */
export function firstName(user: Named): string {
  const asked = user.nickname?.trim();
  if (asked && !looksLikeEmail(asked)) return asked;
  const name = user.name.trim();
  const first = name && !looksLikeEmail(name) ? name.split(/\s+/)[0] : nameFromEmail(user.email);
  return first ? capitalize(first) : "there";
}

/** Initials for the round badge: "AP" for Adolff Pierre, "A" for adolff@example.com. */
export function initials(user: Named): string {
  const words = fullName(user).split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0]?.[0] ?? user.email[0] ?? "?");
  return letters.toUpperCase();
}

// "What best describes your work?" in Settings, like Claude's.
export const WORK_OPTIONS = [
  msg("Small business owner"),
  msg("Creator or influencer"),
  msg("Marketing or sales"),
  msg("Student"),
  msg("Teacher or trainer"),
  msg("Software developer"),
  msg("Designer"),
  msg("Writer or editor"),
  msg("Consultant or freelancer"),
  msg("Other"),
] as const;

/**
 * A line for Flash's instructions about who it is talking to, from Settings. Empty when the person
 * filled in nothing. The name comes from the account, so it is quoted and kept short. The language
 * sentence depends on the engine (see languageNote).
 */
export function profileNote(user: Named & { work?: string; language?: string }, engine?: Engine): string {
  const parts: string[] = [];
  const call = user.nickname?.trim();
  if (call && !looksLikeEmail(call)) parts.push(`Call the user "${call.slice(0, 40)}" when you use their name.`);
  const work = user.work?.trim();
  if (work && (WORK_OPTIONS as readonly string[]).includes(work) && work !== "Other") parts.push(`Their work: ${work}.`);
  const language = languageNote(user.language, engine);
  if (language) parts.push(language);
  return parts.join(" ");
}
