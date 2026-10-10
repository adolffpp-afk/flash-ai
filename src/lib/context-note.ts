/*
 * Where and when the user is, for the models' instructions: today's date and the time in the user's
 * time zone, and roughly where they are from their internet connection. Answers that depend on the
 * date or the place (the weather, opening hours, "what time is it in Tokyo") then need no question.
 * The coordinates stay on the server: only the weather lookup uses them, never a prompt.
 */

export type Where = { timeZone: string; city?: string; country?: string; latitude?: number; longitude?: number };

/** The time zone if it's a real IANA zone, else null. */
export function validTimeZone(zone: unknown): string | null {
  if (typeof zone !== "string" || !zone || zone.length > 64) return null;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** A zone's offset from UTC at a moment, like "UTC+01:00" (UTC itself is "UTC+00:00"). */
export function offsetLabel(timeZone: string, now = new Date()): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  return name === "GMT" ? "UTC+00:00" : name.replace(/^GMT/, "UTC");
}

/** A country's English name from its two-letter code, or the code when it has none. */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** "Saturday 10 October 2026" in the zone, as the browser's own formatter writes it. */
export const longDate = (timeZone: string, now: Date) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now);

/** "14:05" in the zone. */
export const clockTime = (timeZone: string, now: Date) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);

/** Where the user roughly is, as words: "Lagos, Nigeria", or "" when nothing is known. */
export function placeName(where: Where): string {
  return [where.city, where.country && countryName(where.country)].filter(Boolean).join(", ");
}

/**
 * The note on date, time and place at the end of a model's instructions. Builders get the date and
 * the place without the clock (clock: false). now is taken once per request, so every call in it
 * sends the same words.
 */
export function contextNote(where: Where, now = new Date(), { clock = true }: { clock?: boolean } = {}): string {
  const zone = validTimeZone(where.timeZone) ?? "UTC";
  const date = longDate(zone, now);
  const place = placeName(where);
  const located = place ? ` Their approximate location, from their internet connection, is ${place}.` : "";
  if (!clock) return `Today is ${date} where the user is.${located}`;
  const when = `Today is ${date}, and it's ${clockTime(zone, now)} where the user is (time zone ${zone}, ${offsetLabel(zone, now)}; ${clockTime("UTC", now)} UTC).`;
  return place
    ? `${when}${located} It can be wrong (VPNs, mobile networks, travel), so when an answer depends on where they are, say which place you used.`
    : `${when} Their location is unknown. When an answer depends on where they are, give what holds generally and ask for their city in one short question.`;
}
