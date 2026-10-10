/*
 * Times for Home: the greeting, the date line under it ("Friday • Oct 9, 2026 • Your workspace is
 * ready") and how long ago a chat or site changed. All by the visitor's own clock, in the locale
 * Flash is shown in (see i18n.ts): English as written here, other languages from the browser's own
 * words for dates and times.
 */
import { msg } from "./i18n.ts";

/** Good morning, afternoon or evening, in English: show it with t(). */
export function greeting(now = new Date()): string {
  const hour = now.getHours();
  return hour < 5 ? msg("Good evening") : hour < 12 ? msg("Good morning") : hour < 18 ? msg("Good afternoon") : msg("Good evening");
}

const english = (locale: string) => locale.toLowerCase().startsWith("en");

/** "Friday • Oct 9, 2026 • Your workspace is ready", as on Home. ready is that last part, translated. */
export function dateLine(now = new Date(), locale = "en-US", ready = "Your workspace is ready"): string {
  const day = now.toLocaleDateString(locale, { weekday: "long" });
  const date = now.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });
  return `${day} • ${date} • ${ready}`;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;

type Unit = "minute" | "hour" | "day";

/** How long ago, in steps: under a minute, minutes, hours, then days up to a month. null when older. */
function step(then: number, now: number): [number, Unit] | 0 | null {
  const seconds = Math.max(0, (now - then) / 1000);
  if (seconds < 60) return 0;
  if (seconds < 3600) return [Math.floor(seconds / 60), "minute"];
  if (seconds < 86_400) return [Math.floor(seconds / 3600), "hour"];
  if (seconds < 30 * 86_400) return [Math.floor(seconds / 86_400), "day"];
  return null;
}

/** "just now", "5 minutes ago", "2 hours ago", "1 day ago", then the date for anything older than a month. */
export function timeAgo(then: number, now = Date.now(), locale = "en-US"): string {
  const ago = step(then, now);
  if (ago === null) return new Date(then).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });
  if (!english(locale)) {
    const words = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    return ago === 0 ? words.format(0, "second") : words.format(-ago[0], ago[1]);
  }
  return ago === 0 ? "just now" : plural(ago[0], ago[1]);
}

/** The same, short enough for a small tile: "just now", "5m ago", "2h ago", "3d ago", then "Aug 25". */
export function shortAgo(then: number, now = Date.now(), locale = "en-US"): string {
  const ago = step(then, now);
  if (ago === null) {
    const date = new Date(then);
    const year = date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" as const };
    return date.toLocaleDateString(locale, { month: "short", day: "numeric", ...year });
  }
  if (!english(locale)) {
    const words = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });
    return ago === 0 ? words.format(0, "second") : words.format(-ago[0], ago[1]);
  }
  return ago === 0 ? "just now" : `${ago[0]}${ago[1][0]} ago`;
}
