import { validTimeZone, type Where } from "../context-note.ts";

/** A header that's a number within [-limit, limit], else undefined. */
function coordinate(value: string | null, limit: number): number | undefined {
  if (!value?.trim()) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : undefined;
}

/**
 * Where the user is, roughly: Vercel's location headers for the city, country and coordinates, and
 * the browser's own time zone (sent with the chat) for the clock, else the connection's, else UTC. A
 * browser's "UTC" says nothing about the user, so the connection's zone is used over it when known.
 * Every value is checked before it's used, since anything in a request can be made up. Local
 * development has no Vercel headers, so only the time zone is known there.
 */
export function whereFrom(request: Request, bodyTimeZone?: unknown): Where {
  const h = request.headers;
  const browser = validTimeZone(bodyTimeZone);
  const connection = validTimeZone(h.get("x-vercel-ip-timezone"));
  const where: Where = { timeZone: (browser && browser !== "UTC" ? browser : (connection ?? browser)) ?? "UTC" };
  // Vercel sends the city percent-encoded (RFC 3986): "S%C3%A3o%20Paulo".
  let city = "";
  try {
    city = decodeURIComponent(h.get("x-vercel-ip-city") ?? "").trim();
  } catch {
    city = "";
  }
  if (/^[\p{L}\p{M} .'-]{1,60}$/u.test(city)) where.city = city;
  const country = (h.get("x-vercel-ip-country") ?? "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(country)) where.country = country;
  const latitude = coordinate(h.get("x-vercel-ip-latitude"), 90);
  const longitude = coordinate(h.get("x-vercel-ip-longitude"), 180);
  if (latitude !== undefined && longitude !== undefined) Object.assign(where, { latitude, longitude });
  return where;
}
