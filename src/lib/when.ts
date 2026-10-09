/*
 * Times for Home: the greeting, the date line under it ("Friday • Oct 9, 2026 • Your workspace is
 * ready") and how long ago a chat or site changed. All by the visitor's own clock.
 */

/** Good morning, afternoon or evening. */
export function greeting(now = new Date()): string {
  const hour = now.getHours();
  return hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

/** "Friday • Oct 9, 2026 • Your workspace is ready", as on Home. */
export function dateLine(now = new Date()): string {
  const day = now.toLocaleDateString("en-US", { weekday: "long" });
  const date = now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${day} • ${date} • Your workspace is ready`;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;

/** "just now", "5 minutes ago", "2 hours ago", "1 day ago", then the date for anything older than a month. */
export function timeAgo(then: number, now = Date.now()): string {
  const seconds = Math.max(0, (now - then) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return plural(Math.floor(seconds / 60), "minute");
  if (seconds < 86_400) return plural(Math.floor(seconds / 3600), "hour");
  if (seconds < 30 * 86_400) return plural(Math.floor(seconds / 86_400), "day");
  return new Date(then).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** The same, short enough for a small tile: "just now", "5m ago", "2h ago", "3d ago", then "Aug 25". */
export function shortAgo(then: number, now = Date.now()): string {
  const seconds = Math.max(0, (now - then) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 30 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  const date = new Date(then);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }) });
}
