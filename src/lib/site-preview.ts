/*
 * The card shown when someone shares a published site's link (Facebook, WhatsApp, iMessage, X…):
 * its title, a line about it and a picture, read from the site's own HTML.
 */

export type SitePreview = { title: string; description: string; image: string | null };

/** The few named characters pages use most (&amp;, &nbsp;…), written out. Flash's search check (seo-scan.ts) reads text with it too. */
export const decode = (text: string) =>
  text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** A piece of HTML as the words it shows, on one line. */
export const plain = (html: string) => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…`);

const escapeAttr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/*
 * Read on every view of a site, so each pattern looks only at the start of the page and bounds how
 * far it looks: a page made of half-written tags can't make it slow.
 */
const READ = 32 * 1024;

/** Whether the site already sets its own share card, which then wins. */
export const hasOwnPreview = (html: string) => /<meta[^<>]{1,500}?property\s*=\s*["']og:title["']/i.test(html.slice(0, READ));

/** Whether the site names its own main address (canonical), which then wins over the one Flash adds. */
export const hasOwnCanonical = (html: string) => /<link[^<>]{1,500}?rel\s*=\s*["']?canonical\b/i.test(html.slice(0, READ));

/** The tag that names a page's main address for search engines, so its other addresses don't compete with it. */
export const canonicalTag = (url: string) => `<link rel="canonical" href="${escapeAttr(url)}">`;

// The title of a site whose page has none, while its link preview says what it was made with (see made-with.ts).
export const MADE_WITH_TITLE = "Made with Flash";

/**
 * The title, description and first real picture of a site. `untitled` is the title when the page
 * has none: "Made with Flash", or something of the app's own when its owner turned that off.
 */
export function sitePreview(page: string, untitled: string = MADE_WITH_TITLE): SitePreview {
  const html = page.slice(0, READ);
  // A many-page site titles its first page "Home · Name": the card shows the name.
  const named = plain(html.match(/<title[^<>]{0,200}>([^<]{0,500})<\/title>/i)?.[1] ?? "").replace(/^home\s*[·|:–—-]\s*/i, "");
  const title = clip(named || untitled, 90);
  const meta =
    html.match(/<meta[^<>]{1,500}?name\s*=\s*["']description["'][^<>]{0,500}?content\s*=\s*"([^"<>]{0,1000})"/i)?.[1] ??
    html.match(/<meta[^<>]{1,500}?name\s*=\s*["']description["'][^<>]{0,500}?content\s*=\s*'([^'<>]{0,1000})'/i)?.[1] ??
    html.match(/<meta[^<>]{1,500}?content\s*=\s*"([^"<>]{0,1000})"[^<>]{0,500}?name\s*=\s*["']description["']/i)?.[1];
  // No description: the first paragraph long enough to say something.
  const paragraph = [...html.matchAll(/<p(?:\s[^<>]{0,300})?>([\s\S]{0,1500}?)<\/p>/gi)].map((m) => plain(m[1])).find((t) => t.length >= 40);
  const description = clip(decode(meta ?? "").trim() || paragraph || "", 200);
  // The page's own share picture first: Flash's tags go before the page's, and share apps use the first.
  const own =
    html.match(/<meta[^<>]{1,500}?property\s*=\s*["']og:image["'][^<>]{0,500}?content\s*=\s*["'](https:\/\/[^"'\s<>]{1,2000})["']/i)?.[1] ??
    html.match(/<meta[^<>]{1,500}?content\s*=\s*["'](https:\/\/[^"'\s<>]{1,2000})["'][^<>]{0,500}?property\s*=\s*["']og:image["']/i)?.[1];
  // Otherwise the first web picture that isn't an icon: data: pictures and SVGs don't show in share cards.
  const image =
    (own && decode(own)) ||
    ([...html.matchAll(/<img[^<>]{1,500}?src\s*=\s*["'](https:\/\/[^"'\s<>]{1,2000})["']/gi)]
      .map((m) => decode(m[1]))
      .find((src) => !/\.svg(\?|$)|icon|logo|favicon/i.test(src)) ?? null);
  return { title, description, image };
}

/** The <meta> tags for a site's share card. `card` is the picture to use when the site has none. */
export function previewTags(preview: SitePreview, pageUrl: string, card: string): string {
  const tags: [string, string][] = [
    ["og:type", "website"],
    ["og:site_name", preview.title],
    ["og:title", preview.title],
    ["og:url", pageUrl],
    ["og:image", preview.image ?? card],
    ["twitter:card", "summary_large_image"],
  ];
  if (preview.description) tags.splice(3, 0, ["og:description", preview.description]);
  return tags.map(([key, value]) => `<meta ${key.startsWith("twitter:") ? "name" : "property"}="${key}" content="${escapeAttr(value)}">`).join("");
}
