/*
 * The card shown when someone shares a published site's link (Facebook, WhatsApp, iMessage, X…):
 * its title, a line about it and a picture, read from the site's own HTML.
 */

export type SitePreview = { title: string; description: string; image: string | null };

// The characters pages write by name (&mdash;, &rsquo;, &eacute;, &euro;), as the browser shows them:
// HTML's Latin-1 names in the order of their code points from 160, then the others pages use.
const CHARACTERS = new Map<string, string>([["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"]]);
const LATIN1 =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml";
for (const [k, name] of LATIN1.split(" ").entries()) CHARACTERS.set(name, String.fromCharCode(160 + k));
// A space, as the page's other spaces.
CHARACTERS.set("nbsp", " ");
for (const [name, code] of Object.entries({
  OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710, tilde: 732, Cacute: 262, cacute: 263, Ccaron: 268, ccaron: 269,
  Eogon: 280, eogon: 281, Ecaron: 282, ecaron: 283, Gbreve: 286, gbreve: 287, Idot: 304, imath: 305, inodot: 305, Lstrok: 321, lstrok: 322, Nacute: 323,
  nacute: 324, Rcaron: 344, rcaron: 345, Sacute: 346, sacute: 347, Scedil: 350, scedil: 351, Zacute: 377, zacute: 378, Zdot: 379, zdot: 380, Zcaron: 381,
  zcaron: 382, Aogon: 260, aogon: 261, ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207, ndash: 8211, mdash: 8212,
  lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221, bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240,
  prime: 8242, Prime: 8243, lsaquo: 8249, rsaquo: 8250, oline: 8254, euro: 8364, trade: 8482, larr: 8592, uarr: 8593, rarr: 8594, darr: 8595,
  harr: 8596, lArr: 8656, rArr: 8658, hArr: 8660, minus: 8722, infin: 8734, asymp: 8776, ne: 8800, le: 8804, ge: 8805, loz: 9674, starf: 9733, star: 9734,
  spades: 9824, clubs: 9827, hearts: 9829, diams: 9830, check: 10003, cross: 10007,
})) {
  CHARACTERS.set(name, String.fromCodePoint(code));
}

/**
 * Characters written as &#8217;, &#x2019; or &rsquo;, read in one pass (so &amp;mdash; stays "&mdash;"), as the
 * browser shows them. Flash's search check (seo-scan.ts) reads text with it too, so the share card Flash adds
 * and the check read a page alike.
 */
export const decodeText = (text: string) =>
  !text.includes("&")
    ? text
    : text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (all, dec?: string, hex?: string, name?: string) => {
        if (name !== undefined) return CHARACTERS.get(name) ?? all;
        const code = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : all;
      });

/** A piece of HTML as the words it shows, on one line. */
export const plain = (html: string) => decodeText(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

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
/** The page's address in another language, for search engines (see site-translations.ts). */
export const alternateTag = (lang: string, url: string) => `<link rel="alternate" hreflang="${escapeAttr(lang)}" href="${escapeAttr(url)}">`;

// The title of a site whose page has none, while its link preview says what it was made with (see made-with.ts).
export const MADE_WITH_TITLE = "Made with Flash";

/**
 * The title, description and first real picture of a site. `untitled` is the title when the page
 * has none: "Made with Flash", or something of the app's own when its owner turned that off.
 */
export function sitePreview(page: string, untitled: string = MADE_WITH_TITLE): SitePreview {
  const html = page.slice(0, READ);
  // A many-page site titles its first page "Home · Name": the card shows the name. A hyphen with no
  // space before it is part of a word (Home-Grown Farm Shop); an en or em dash never is (Home—Name).
  const named = plain(html.match(/<title[^<>]{0,200}>([^<]{0,500})<\/title>/i)?.[1] ?? "").replace(/^home(?:\s*[·|:｜・–—]|\s+-)\s*/i, "");
  const title = clip(named || untitled, 90);
  const meta =
    html.match(/<meta[^<>]{1,500}?name\s*=\s*["']description["'][^<>]{0,500}?content\s*=\s*"([^"<>]{0,1000})"/i)?.[1] ??
    html.match(/<meta[^<>]{1,500}?name\s*=\s*["']description["'][^<>]{0,500}?content\s*=\s*'([^'<>]{0,1000})'/i)?.[1] ??
    html.match(/<meta[^<>]{1,500}?content\s*=\s*"([^"<>]{0,1000})"[^<>]{0,500}?name\s*=\s*["']description["']/i)?.[1];
  // No description: the first paragraph long enough to say something.
  const paragraph = [...html.matchAll(/<p(?:\s[^<>]{0,300})?>([\s\S]{0,1500}?)<\/p>/gi)].map((m) => plain(m[1])).find((t) => t.length >= 40);
  const description = clip(decodeText(meta ?? "").trim() || paragraph || "", 200);
  // The page's own share picture first: Flash's tags go before the page's, and share apps use the first.
  const own =
    html.match(/<meta[^<>]{1,500}?property\s*=\s*["']og:image["'][^<>]{0,500}?content\s*=\s*["'](https:\/\/[^"'\s<>]{1,2000})["']/i)?.[1] ??
    html.match(/<meta[^<>]{1,500}?content\s*=\s*["'](https:\/\/[^"'\s<>]{1,2000})["'][^<>]{0,500}?property\s*=\s*["']og:image["']/i)?.[1];
  // Otherwise the first web picture that isn't an icon: data: pictures and SVGs don't show in share cards.
  const image =
    (own && decodeText(own)) ||
    ([...html.matchAll(/<img[^<>]{1,500}?src\s*=\s*["'](https:\/\/[^"'\s<>]{1,2000})["']/gi)]
      .map((m) => decodeText(m[1]))
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
