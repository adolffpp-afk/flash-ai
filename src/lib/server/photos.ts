/*
 * Real photos in what Flash builds. The builder writes flash-photo:search-words (with ~portrait,
 * ~square or ~landscape for the shape) wherever a photo goes: an <img> src, a CSS url(), a field in
 * the app's data. Before the app reaches the user, each one becomes a high-definition photo from
 * Unsplash (or Pexels), whose licences let any business use them for free, so photos cost no credits.
 * Unsplash asks that its photos are shown from its own servers, that each use is counted, and that
 * the photographers are named, so a short credit line goes at the end of the page.
 */

// Photos per search, so the same words used for several products give different photos.
const PER_SEARCH = 12;
// Searches per build, and how long Flash waits for them all.
const MAX_SEARCHES = 24;
const WAIT_MS = 6000;
const TOKEN = /flash-photo:([a-z0-9][a-z0-9+_-]{0,79})(?:~(portrait|square|landscape))?/gi;
const UTM = "utm_source=flash&utm_medium=referral";

type Shape = "portrait" | "square" | "landscape" | "";
type Found = {
  // The photo's address, sized and cut for its shape by sized().
  base: string;
  from: "unsplash" | "pexels";
  // Unsplash's: who took it, and the address that counts a use.
  by?: { name: string; link: string };
  track?: string;
};

// Searches already made, for the life of this server: a change to the app reuses them.
const cache = new Map<string, Found[]>();

/** Whether built apps get real photos: only when Flash has an Unsplash or Pexels key. */
export const photosOn = () => Boolean(process.env.UNSPLASH_ACCESS_KEY || process.env.PEXELS_API_KEY);

/** A calm grey picture with the right shape, for a photo that couldn't be found. */
function standIn(shape: Shape): string {
  const [w, h] = shape === "portrait" ? [800, 1200] : shape === "square" ? [1000, 1000] : [1600, 1000];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#e2e8f0"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function sized(photo: Found, shape: Shape): string {
  const [w, h] = shape === "portrait" ? [900, 1350] : shape === "square" ? [1000, 1000] : shape === "landscape" ? [1600, 900] : [1600, 0];
  const size = `w=${w}${h ? `&h=${h}&fit=crop` : ""}`;
  return photo.from === "unsplash" ? `${photo.base}&${size}&q=80&auto=format` : `${photo.base}?auto=compress&cs=tinysrgb&${size}`;
}

async function unsplash(words: string, shape: Shape, signal: AbortSignal): Promise<Found[]> {
  const url = new URL("https://api.unsplash.com/search/photos");
  url.searchParams.set("query", words);
  url.searchParams.set("per_page", String(PER_SEARCH));
  url.searchParams.set("content_filter", "high");
  if (shape) url.searchParams.set("orientation", shape === "square" ? "squarish" : shape);
  const res = await fetch(url, { headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}`, "Accept-Version": "v1" }, signal });
  if (!res.ok) throw new Error(`Unsplash ${res.status}`);
  type Result = { urls?: { raw?: string }; user?: { name?: string; links?: { html?: string } }; links?: { download_location?: string } };
  const body = (await res.json()) as { results?: Result[] };
  return (body.results ?? []).flatMap((r) => {
    const raw = r.urls?.raw;
    if (typeof raw !== "string" || !/^https:\/\/images\.unsplash\.com\/[^"'()<>\s]+\?[^"'()<>\s]*$/.test(raw)) return [];
    const link = r.user?.links?.html;
    return [
      {
        base: raw,
        from: "unsplash" as const,
        by: r.user?.name && typeof link === "string" && /^https:\/\/unsplash\.com\//.test(link) ? { name: String(r.user.name).slice(0, 60), link } : undefined,
        track: typeof r.links?.download_location === "string" && /^https:\/\/api\.unsplash\.com\//.test(r.links.download_location) ? r.links.download_location : undefined,
      },
    ];
  });
}

async function pexels(words: string, shape: Shape, signal: AbortSignal): Promise<Found[]> {
  const url = new URL("https://api.pexels.com/v1/search");
  url.searchParams.set("query", words);
  url.searchParams.set("per_page", String(PER_SEARCH));
  if (shape) url.searchParams.set("orientation", shape);
  const res = await fetch(url, { headers: { Authorization: process.env.PEXELS_API_KEY ?? "" }, signal });
  if (!res.ok) throw new Error(`Pexels ${res.status}`);
  const body = (await res.json()) as { photos?: { src?: { original?: string } }[] };
  return (body.photos ?? []).flatMap((p) => {
    const original = p.src?.original?.split("?")[0];
    return typeof original === "string" && /^https:\/\/images\.pexels\.com\/[^"'()<>\s?]+$/.test(original) ? [{ base: original, from: "pexels" as const }] : [];
  });
}

async function search(words: string, shape: Shape, signal: AbortSignal): Promise<Found[]> {
  const key = `${words}~${shape}`;
  const known = cache.get(key);
  if (known) return known;
  let photos: Found[] = [];
  if (process.env.UNSPLASH_ACCESS_KEY) photos = await unsplash(words, shape, signal).catch(() => []);
  if (!photos.length && process.env.PEXELS_API_KEY) photos = await pexels(words, shape, signal).catch(() => []);
  if (photos.length) cache.set(key, photos);
  return photos;
}

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const unescape = (text: string) => text.replace(/&(amp|lt|gt|quot);/g, (_m, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"' })[e]!);

/**
 * The credit Unsplash asks for: each photographer named with a link, and Unsplash. It stays out of
 * the way, as a small "Photo credits" in the app's footer that opens to the names when clicked.
 */
function credits(by: { name: string; link: string }[]): string {
  const names = by.map((b) => `<a href="${escape(b.link)}?${UTM}" target="_blank" rel="noopener" style="color:inherit">${escape(b.name)}</a>`);
  return `\n<details data-flash-credits style="display:block;width:100%;order:9999;margin:0;padding:6px 16px;text-align:center;font:11px/1.5 system-ui,sans-serif;opacity:.5"><summary style="cursor:pointer">Photo credits</summary>Photos by ${names.join(", ")} on <a href="https://unsplash.com/?${UTM}" target="_blank" rel="noopener" style="color:inherit">Unsplash</a></details>\n`;
}

/** Puts the credit at the end of the app's last footer, or just before </body> when it has none. */
function placeCredits(html: string, line: string): string {
  if (/<\/footer>/i.test(html)) return html.replace(/<\/footer>(?![\s\S]*<\/footer>)/i, `${line}</footer>`);
  return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${line}</body>`) : html + line;
}

/** The app with every flash-photo: in it turned into a real photo's address (or a calm stand-in). */
export async function fillPhotos(html: string, outer?: AbortSignal): Promise<string> {
  const wanted = [...html.matchAll(TOKEN)];
  if (!wanted.length) return html;
  const signal = AbortSignal.any([AbortSignal.timeout(WAIT_MS), ...(outer ? [outer] : [])]);
  const keys = [...new Set(wanted.map((m) => `${m[1].toLowerCase()}~${(m[2] ?? "").toLowerCase()}`))].slice(0, MAX_SEARCHES);
  const found = new Map<string, Found[]>();
  if (photosOn()) {
    await Promise.all(
      keys.map(async (key) => {
        const [words, shape] = key.split("~");
        found.set(key, await search(words.replace(/[+_-]+/g, " ").trim(), shape as Shape, signal).catch(() => []));
      }),
    );
  }
  // Each use of the same words takes the next photo, so a grid of products doesn't repeat one.
  const used = new Map<string, number>();
  const chosen: Found[] = [];
  let out = html.replace(TOKEN, (_all, words: string, shape?: string) => {
    const s = (shape ?? "").toLowerCase() as Shape;
    const key = `${words.toLowerCase()}~${s}`;
    const photos = found.get(key) ?? [];
    if (!photos.length) return standIn(s);
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    const photo = photos[n % photos.length];
    if (!chosen.includes(photo)) chosen.push(photo);
    return sized(photo, s);
  });
  // Unsplash counts each photo used (it asks apps to), and its photographers are named.
  for (const photo of chosen) if (photo.track) fetch(photo.track, { headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` } }).catch(() => {});
  // Photographers named by an earlier version stay named alongside the new ones.
  // Older apps have the credit as a line of its own (<p>), newer ones as a small "Photo credits" (<details>).
  const line = /\n?<(p|details) data-flash-credits[^>]*>([\s\S]*?)<\/\1>\n?/.exec(out);
  const before = line ? [...line[2].matchAll(/<a href="(https:\/\/unsplash\.com\/@[^"?]+)\?[^"]*"[^>]*>([^<]*)<\/a>/g)].map((m) => ({ link: m[1], name: unescape(m[2]) })) : [];
  const by = [...new Map([...before, ...chosen.flatMap((p) => (p.by ? [p.by] : []))].map((b) => [b.link, b] as const)).values()];
  if (chosen.some((p) => p.by)) {
    if (line) out = out.replace(line[0], "");
    out = placeCredits(out, credits(by));
  }
  return out;
}
