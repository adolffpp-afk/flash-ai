/*
 * The card shown when someone shares a published site's link (Facebook, WhatsApp, iMessage, X…):
 * its title, a line about it and a picture, read from the site's own HTML.
 */

export type SitePreview = { title: string; description: string; image: string | null };

const decode = (text: string) =>
  text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");

const plain = (html: string) => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…`);

const escapeAttr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Whether the site already sets its own share card, which then wins. */
export const hasOwnPreview = (html: string) => /<meta[^>]+property\s*=\s*["']og:title["']/i.test(html);

/** The title, description and first real picture of a site. */
export function sitePreview(html: string): SitePreview {
  // A many-page site titles its first page "Home · Name": the card shows the name.
  const named = plain(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/^home\s*[·|:–—-]\s*/i, "");
  const title = clip(named || "Made with Flash", 90);
  const meta =
    html.match(/<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*"([^"]*)"/i)?.[1] ??
    html.match(/<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*'([^']*)'/i)?.[1] ??
    html.match(/<meta[^>]+content\s*=\s*"([^"]*)"[^>]*name\s*=\s*["']description["']/i)?.[1];
  // No description: the first paragraph long enough to say something.
  const paragraph = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => plain(m[1])).find((t) => t.length >= 40);
  const description = clip(decode(meta ?? "").trim() || paragraph || "", 200);
  // The first web picture that isn't an icon: data: pictures and SVGs don't show in share cards.
  const image =
    [...html.matchAll(/<img[^>]+src\s*=\s*["'](https:\/\/[^"'\s]+)["']/gi)]
      .map((m) => decode(m[1]))
      .find((src) => !/\.svg(\?|$)|icon|logo|favicon/i.test(src)) ?? null;
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
