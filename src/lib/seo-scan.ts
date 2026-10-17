/*
 * Flash's search check (SEO), part one: what a published app's page says about itself, read from
 * its code exactly as it was saved (without what Flash adds when it serves it). It never runs the
 * page's scripts and never fetches anything: links, pictures and fonts on other websites are counted,
 * never opened. The facts are saved with the page (sites.seo, see server/seo.ts) and judged by
 * seo-rules.ts whenever someone looks, so a change of a rule's threshold needs no new reading.
 *
 * The page is read once, from start to end, with indexOf and character loops: a page made of
 * half-written tags, a million brackets or one huge attribute takes as long to read as any other
 * page of its size. Every list is capped and every text clipped, so the facts stay small whatever
 * the page holds. Pure, with no DOM, so the browser can check a chat's newest copy the same way.
 */
import { decode, hasOwnCanonical, hasOwnPreview, sitePreview } from "./site-preview.ts";
import { imageDimensions } from "./imageSize.ts";

/** Changes when the reading changes, so facts saved before are read again (see server/seo.ts). */
export const SEO_VERSION = 1;

export type Alphabet = "latin" | "arabic" | "hebrew" | "cyrillic" | "greek" | "devanagari" | "bengali" | "thai" | "hangul" | "cjk";

export type SeoFacts = {
  v: number;
  /** The page's size in UTF-8 bytes. */
  bytes: number;
  doctype: boolean;
  lang: string | null;
  dir: string | null;
  /** The alphabet most of the visible text is written in (60% of 50 letters or more), else null. */
  script: { main: Alphabet | null };
  /** Visible words (in Chinese and Japanese, characters / 2). */
  words: number;
  /** Most of what the page shows is built by its scripts (React with Babel, an empty page with scripts). */
  jsBuilt: boolean;
  /** <title> outside SVG icons, and how many there are. */
  titles: string[];
  titleCount: number;
  descriptions: string[];
  descriptionCount: number;
  viewport: string | null;
  /** What meta robots and googlebot tags say. */
  robots: string[];
  noindex: boolean;
  nofollow: boolean;
  ownCanonical: boolean;
  canonicals: string[];
  canonicalCount: number;
  /** The page sets its own share card (og:title), so Flash adds none. */
  ownCard: boolean;
  og: { title?: string; description?: string; image?: string; twitterCard?: string };
  /** A picture Flash's share card would show (see site-preview.ts). */
  photo: boolean;
  icon: boolean;
  /** [level, text, page] in the page's order; page is the <section data-page> it's in, or "" outside them. */
  headings: [number, string, string][];
  headingCount: number;
  emptyHeadings: number;
  /** Main headings (h1) per page section, "" for those outside every section. */
  h1s: Record<string, number>;
  h1Texts: string[];
  /** The names of the page's <section data-page="…"> pages. */
  pages: string[];
  imgs: {
    total: number;
    noAlt: number;
    noAltSamples: string[];
    fileAlt: string[];
    noSize: number;
    lazy: number;
    external: number;
    dataBytes: number;
    bigData: number;
  };
  links: {
    /** Links within the site (#/page, #id and relative addresses) and to other websites. */
    inside: number;
    external: number;
    /** Links and buttons whose words were read. */
    checked: number;
    empty: number;
    emptySamples: string[];
    vague: number;
    vagueSamples: string[];
    missingPages: string[];
    missingIds: string[];
    outside: string[];
  };
  ldjson: { total: number; bad: number; noContext: number; noType: number; types: string[] };
  /** Scripts in the head that hold up the page. */
  blocking: string[];
  fonts: { links: number; noSwap: string[] };
  smallText: string[];
  smallTargets: string[];
  mixed: string[];
  placeholders: string[];
  /** The page loads data from Flash when it opens (flashDB lists, prices set in Flash). */
  loadsData: boolean;
  /** Reading the page failed: there is no score. */
  error?: true;
};

const MAX_FACTS = 16_000;
const CLIP = 200;
const SAMPLE = 80;

const clip = (text: string, max = CLIP) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
/** Up to max different entries. */
const addOnce = (list: string[], value: string, max: number) => {
  if (list.length < max && !list.includes(value)) list.push(value);
};

/** Numbers written as &#8217; or &#x2019;, as well as the common named ones. */
const decodeText = (text: string) =>
  !text.includes("&")
    ? text
    : decode(
        text
          .replace(/&#(\d{1,7});/g, (all, n: string) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : all))
          .replace(/&#x([0-9a-f]{1,6});/gi, (all, n: string) => (parseInt(n, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(n, 16)) : all)),
      );
const oneLine = (text: string) => decodeText(text).replace(/\s+/g, " ").trim();

// Only A to Z lowercased, so every position in it is the same position in the page.
const asciiLower = (text: string) => text.replace(/[A-Z]+/g, (m) => m.toLowerCase());

/** Which alphabet a character is in, or null for anything that isn't a letter of one. */
function alphabetOf(c: number): Alphabet | null {
  if (c < 0x80) return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) ? "latin" : null;
  if ((c >= 0xc0 && c <= 0x24f && c !== 0xd7 && c !== 0xf7) || (c >= 0x1e00 && c <= 0x1eff)) return "latin";
  if (c >= 0x370 && c <= 0x3ff) return "greek";
  if (c >= 0x400 && c <= 0x4ff) return "cyrillic";
  if (c >= 0x590 && c <= 0x5ff) return "hebrew";
  if ((c >= 0x600 && c <= 0x6ff) || (c >= 0x750 && c <= 0x77f) || (c >= 0xfb50 && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff)) return "arabic";
  if (c >= 0x900 && c <= 0x97f) return "devanagari";
  if (c >= 0x980 && c <= 0x9ff) return "bengali";
  if (c >= 0xe00 && c <= 0xe7f) return "thai";
  if ((c >= 0xac00 && c <= 0xd7af) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f)) return "hangul";
  if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0xf900 && c <= 0xfaff)) return "cjk";
  return null;
}

/** How wide a text is where search results cut it: Chinese, Japanese, Korean and fullwidth characters count as two. */
export function textWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x20000 && c <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

/** Size in UTF-8 bytes, counted without making a copy. */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 2 : c >= 0xdc00 && c <= 0xdfff ? 2 : 3;
  }
  return bytes;
}

// Elements whose content is text to the browser, not tags.
const RAW = new Set(["script", "style", "textarea", "template", "noscript", "xmp", "iframe", "noembed", "noframes"]);
// What may be in <head>: anything else starts the page's body.
const HEAD_TAGS = new Set(["html", "head", "meta", "link", "script", "style", "title", "base", "noscript", "template"]);
// Elements a page's sections are written as.
const PAGE_TAGS = new Set(["section", "div", "main", "article"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

// Link words that say nothing about where they go, in the languages Flash's builder writes most.
const VAGUE = new Set([
  "click here", "here", "read more", "more", "learn more", "link", "this", "go", "details", "continue", "more info", "see more",
  "haz clic aquí", "aquí", "leer más", "más", "ver más",
  "cliquez ici", "ici", "en savoir plus", "lire la suite",
  "hier klicken", "hier", "mehr", "weiterlesen", "mehr erfahren",
  "clique aqui", "aqui", "saiba mais", "leia mais",
  "clicca qui", "qui", "leggi di più",
]);
const FILE_ALT = /\.(?:jpe?g|png|gif|webp|svg|avif)$/i;
// The word "picture" or "photo" alone, in the languages Flash is shown in.
const WORD_ALT = new Set([
  "image", "img", "photo", "picture", "pic", "foto", "bild", "imagen", "imagem", "immagine", "afbeelding", "obraz", "zdjęcie", "imagine",
  "изображение", "картинка", "фото", "зображення", "resim", "görsel", "gambar", "hình ảnh", "ảnh", "画像", "写真", "图片", "圖片", "图像",
  "이미지", "사진", "صورة", "תמונה", "تصویر", "عکس", "छवि", "तस्वीर", "εικόνα", "รูปภาพ", "picha", "larawan", "imaj", "ছবি",
]);
// Tailwind classes that give a picture its size (h-48, md:h-64, size-12, aspect-video).
const SIZED_CLASS = /^(?:[a-z0-9]+:)*(?:h|size|aspect)-/;
const SIZED_STYLE = /(?:^|[;{\s])(?:width|height|aspect-ratio)\s*:/i;
const SMALL_STYLE = /font-size\s*:\s*(\d{1,3}(?:\.\d{1,3})?)(px|pt|rem)\b/gi;
const SMALL_CLASS = /\btext-\[(\d{1,3}(?:\.\d{1,3})?)(px|rem)\]/g;
const TINY_CLASS = /^(?:[a-z0-9]+:)*(?:h|w|size)-(?:[1-5](?:\.5)?|0\.5|\[(\d{1,3})px\])$/;
const PADDED_CLASS = /^(?:[a-z0-9]+:)*(?:p|px|py|min-h|min-w)-/;
const TINY_STYLE = /(?:^|[;\s])(height|width)\s*:\s*(\d{1,4}(?:\.\d{1,3})?)px/gi;
const CSS_HTTP = /url\(\s*["']?(http:\/\/[^"')\s]{1,200})/gi;
const FONT_IMPORT = /@import\s+(?:url\(\s*)?["']?((?:https?:)?\/\/fonts\.googleapis\.com\/css2?\?[^"')\s;]{0,2000})/gi;
// A blank like [Phone number] or [Dirección] that the builder leaves for the owner to fill in.
const PLACEHOLDER = /\[[\p{Lu}\p{Lo}][\p{L}\p{M}\p{N} '’.-]{1,38}\]/gu;
const JS_TYPE = /^(?:(?:text|application)\/(?:x-)?(?:java|ecma)script|module)?$/;
const OTHER_SCHEME = /^[a-z][a-z0-9+.-]{0,30}:/i;
const HOME_ROUTES = new Set(["", "home", "index"]);

type Attrs = Map<string, string>;
// from and to: where its tag is in the page, shown as a sample only when it's needed.
type Open = { label: boolean; text: string; from: number; to: number };

/** What a page says about itself. Never throws: a page it can't read gives facts with error set. */
export function scanPage(html: string): SeoFacts {
  try {
    return fit(scan(html));
  } catch {
    return { ...empty(0), error: true };
  }
}

function empty(bytes: number): SeoFacts {
  return {
    v: SEO_VERSION,
    bytes,
    doctype: false,
    lang: null,
    dir: null,
    script: { main: null },
    words: 0,
    jsBuilt: false,
    titles: [],
    titleCount: 0,
    descriptions: [],
    descriptionCount: 0,
    viewport: null,
    robots: [],
    noindex: false,
    nofollow: false,
    ownCanonical: false,
    canonicals: [],
    canonicalCount: 0,
    ownCard: false,
    og: {},
    photo: false,
    icon: false,
    headings: [],
    headingCount: 0,
    emptyHeadings: 0,
    h1s: {},
    h1Texts: [],
    pages: [],
    imgs: { total: 0, noAlt: 0, noAltSamples: [], fileAlt: [], noSize: 0, lazy: 0, external: 0, dataBytes: 0, bigData: 0 },
    links: { inside: 0, external: 0, checked: 0, empty: 0, emptySamples: [], vague: 0, vagueSamples: [], missingPages: [], missingIds: [], outside: [] },
    ldjson: { total: 0, bad: 0, noContext: 0, noType: 0, types: [] },
    blocking: [],
    fonts: { links: 0, noSwap: [] },
    smallText: [],
    smallTargets: [],
    mixed: [],
    placeholders: [],
    loadsData: false,
  };
}

/** Keeps the facts under MAX_FACTS characters of JSON, shortening the longest lists first. */
function fit(facts: SeoFacts): SeoFacts {
  if (JSON.stringify(facts).length <= MAX_FACTS) return facts;
  facts.headings = facts.headings.slice(0, 40).map(([level, text, page]) => [level, clip(text, 40), clip(page, 30)]);
  facts.pages = facts.pages.slice(0, 30).map((p) => clip(p, 30));
  if (JSON.stringify(facts).length <= MAX_FACTS) return facts;
  const short = (list: string[]) => list.slice(0, 5).map((s) => clip(s, 60));
  const { links, imgs } = facts;
  for (const key of ["emptySamples", "vagueSamples", "missingPages", "missingIds", "outside"] as const) links[key] = short(links[key]);
  imgs.noAltSamples = short(imgs.noAltSamples);
  imgs.fileAlt = short(imgs.fileAlt);
  facts.blocking = short(facts.blocking);
  facts.mixed = short(facts.mixed);
  facts.fonts.noSwap = short(facts.fonts.noSwap);
  facts.smallTargets = short(facts.smallTargets);
  facts.placeholders = short(facts.placeholders);
  facts.h1Texts = short(facts.h1Texts);
  facts.headings = facts.headings.slice(0, 20);
  facts.h1s = Object.fromEntries(Object.entries(facts.h1s).slice(0, 30));
  return facts;
}

/** A link or picture address as a short sample: data: pictures by their kind only. */
const sampleUrl = (url: string) => {
  if (!/^data:/i.test(url)) return clip(url, SAMPLE);
  const head = url.slice(0, 40);
  const cut = head.search(/[;,]/);
  return `${cut > 0 ? head.slice(0, cut) : head}…`;
};

function scan(html: string): SeoFacts {
  const facts = empty(utf8Bytes(html));
  const lower = asciiLower(html);
  const n = html.length;
  const ids = new Set<string>();
  const routes = new Map<string, string>();
  const anchors = new Map<string, string>();
  const letters = new Map<Alphabet, number>();
  let wordCount = 0;
  let wideChars = 0;
  let thaiChars = 0;
  let inWord = false;
  let jsScripts = 0;
  let reactish = false;
  let seenToken = false;
  let inBody = false;
  let foreign = 0;
  let svgTitle = false;
  let codeDepth = 0;
  let link: Open | null = null;
  let button: Open | null = null;
  let heading: { level: number; text: string; page: string } | null = null;
  const pageStack: { tag: string; page: string | null }[] = [];
  let pageOverflow = 0;
  const currentPage = () => {
    for (let k = pageStack.length - 1; k >= 0; k--) if (pageStack[k].page !== null) return pageStack[k].page!;
    return "";
  };

  /** Visible text: counted for words and letters, looked at for blanks, and kept as the words of open links and headings. */
  const onText = (raw: string) => {
    if (!raw) return;
    if (!/\S/.test(raw)) {
      if (link) link.text += " ";
      if (button) button.text += " ";
      if (heading) heading.text += " ";
      inWord = false;
      return;
    }
    seenToken = true;
    const text = decodeText(raw);
    if (svgTitle) {
      // An icon's own title labels the link or button it's in, and isn't text on the page.
      if (text.trim()) {
        if (link) link.label = true;
        if (button) button.label = true;
      }
      return;
    }
    for (const ch of text) {
      const c = ch.codePointAt(0)!;
      const a = alphabetOf(c);
      if (a) letters.set(a, (letters.get(a) ?? 0) + 1);
      if (a === "cjk") {
        wideChars++;
        inWord = false;
      } else if (a === "thai") {
        thaiChars++;
        inWord = false;
      } else if (a || (c >= 0x30 && c <= 0x39)) {
        if (!inWord) wordCount++;
        inWord = true;
      } else if (c <= 0x20 || c === 0xa0 || c === 0x3000 || (c >= 0x2000 && c <= 0x200b)) inWord = false;
    }
    if (link && link.text.length < CLIP) link.text += text;
    if (button && button.text.length < CLIP) button.text += text;
    if (heading && heading.text.length < CLIP) heading.text += text;
    if (!codeDepth) findPlaceholders(text, facts.placeholders);
  };

  const closeLink = () => {
    if (!link) return;
    const words = link.text.replace(/\s+/g, " ").trim();
    facts.links.checked++;
    if (!words && !link.label) {
      facts.links.empty++;
      if (facts.links.empty <= 10) addOnce(facts.links.emptySamples, tagSample(link.from, link.to), 10);
    } else if (words && VAGUE.has(words.toLowerCase())) {
      facts.links.vague++;
      addOnce(facts.links.vagueSamples, clip(words, 60), 10);
    }
    link = null;
  };
  const closeButton = () => {
    if (!button) return;
    const words = button.text.replace(/\s+/g, " ").trim();
    facts.links.checked++;
    if (!words && !button.label) {
      facts.links.empty++;
      if (facts.links.empty <= 10) addOnce(facts.links.emptySamples, tagSample(button.from, button.to), 10);
    }
    button = null;
  };
  const closeHeading = () => {
    if (!heading) return;
    const text = heading.text.replace(/\s+/g, " ").trim();
    facts.headingCount++;
    if (!text) facts.emptyHeadings++;
    if (facts.headings.length < 120) facts.headings.push([heading.level, clip(text, 60), clip(heading.page, 40)]);
    if (heading.level === 1) {
      facts.h1s[heading.page] = (facts.h1s[heading.page] ?? 0) + 1;
      if (text) addOnce(facts.h1Texts, clip(text, 60), 5);
    }
    heading = null;
  };

  /** A <tag …>'s source, short, as a sample the owner and the builder can find in the code. */
  const tagSample = (from: number, to: number) => clip(html.slice(from, Math.min(to, from + 4 * SAMPLE)).replace(/\s+/g, " "), SAMPLE);

  const checkStyle = (css: string) => {
    for (const m of css.matchAll(SMALL_STYLE)) {
      const size = Number(m[1]);
      const unit = m[2].toLowerCase();
      if (size > 0 && ((unit === "px" && size < 12) || (unit === "pt" && size < 9) || (unit === "rem" && size < 0.75))) addOnce(facts.smallText, `font-size: ${m[1]}${unit}`, 5);
      if (facts.smallText.length >= 5) break;
    }
    if (css.includes("http://")) for (const m of css.matchAll(CSS_HTTP)) addOnce(facts.mixed, clip(m[1], SAMPLE), 8);
  };

  const checkFontUrl = (href: string) => {
    let url: URL;
    try {
      url = new URL(href, "https://fonts.googleapis.com/");
    } catch {
      return;
    }
    if (url.hostname !== "fonts.googleapis.com" || !/^\/css2?$/.test(url.pathname)) return;
    facts.fonts.links++;
    const display = url.searchParams.get("display");
    if (display !== "swap" && display !== "optional" && display !== "fallback") addOnce(facts.fonts.noSwap, clip(href, SAMPLE), 5);
  };

  const markMixed = (url: string) => {
    if (/^http:\/\//i.test(url.trim())) addOnce(facts.mixed, clip(url.trim(), SAMPLE), 8);
  };

  const onLinkHref = (raw: string) => {
    const href = decodeText(raw).trim();
    if (!href || href.startsWith("?")) return;
    if (href.startsWith("#")) {
      if (href === "#" || href === "#top" || href === "#0" || href.startsWith("#!")) return;
      facts.links.inside++;
      if (href.startsWith("#/")) {
        let name = href.slice(2).split(/[/?#]/)[0];
        try {
          name = decodeURIComponent(name);
        } catch {}
        if (!HOME_ROUTES.has(name.toLowerCase()) && !routes.has(name) && routes.size < 1000) routes.set(name, href);
      } else {
        let id = href.slice(1);
        try {
          id = decodeURIComponent(id);
        } catch {}
        if (!anchors.has(id) && anchors.size < 1000) anchors.set(id, href);
      }
      return;
    }
    if (/^(?:https?:)?\/\//i.test(href)) {
      facts.links.external++;
      return;
    }
    if (OTHER_SCHEME.test(href)) return;
    // Another app on Flash, or a file sent to this one: they're there.
    if (/^\/p\/[a-z0-9-]+\/?$/.test(href)) {
      facts.links.external++;
      return;
    }
    if (/^\/api\/sites\/[\w-]+\/files\//.test(href)) return;
    // A one-file app has no other pages: from /p/<name>, "/" is Flash's home page and about.html doesn't exist.
    facts.links.inside++;
    addOnce(facts.links.outside, clip(href, SAMPLE), 10);
  };

  const onImg = (attrs: Attrs) => {
    const imgs = facts.imgs;
    imgs.total++;
    const src = attrs.get("src") ?? "";
    const alt = attrs.get("alt");
    const role = (attrs.get("role") ?? "").toLowerCase();
    const decorative = role === "presentation" || role === "none" || (attrs.get("aria-hidden") ?? "").toLowerCase() === "true";
    if (alt === undefined && !decorative) {
      imgs.noAlt++;
      addOnce(imgs.noAltSamples, src ? sampleUrl(src) : "<img>", 5);
    } else if (alt !== undefined) {
      const words = oneLine(alt);
      if (words && (FILE_ALT.test(words) || WORD_ALT.has(words.toLowerCase()))) addOnce(imgs.fileAlt, clip(words, 60), 5);
      if (words) {
        if (link) link.label = true;
        if (button) button.label = true;
        if (heading && heading.text.length < CLIP) heading.text += ` ${words}`;
      }
    }
    const style = attrs.get("style") ?? "";
    const sized =
      (attrs.has("width") && attrs.has("height")) ||
      SIZED_STYLE.test(style) ||
      (attrs.get("class") ?? "").split(/\s+/).some((c) => SIZED_CLASS.test(c));
    if (!sized) imgs.noSize++;
    if ((attrs.get("loading") ?? "").toLowerCase() === "lazy") imgs.lazy++;
    const where = src.trim();
    if (/^(?:https?:)?\/\//i.test(where)) imgs.external++;
    else if (/^data:/i.test(where)) onDataPicture(where);
    markMixed(where);
    for (const part of (attrs.get("srcset") ?? "").split(",")) markMixed(part.trim().split(/\s+/)[0] ?? "");
  };

  const onDataPicture = (url: string) => {
    const comma = url.indexOf(",");
    if (comma === -1 || !/;base64$/i.test(url.slice(0, comma))) return;
    const length = url.length - comma - 1;
    const size = Math.floor((length * 3) / 4);
    facts.imgs.dataBytes += size;
    let big = size > 200 * 1024;
    if (!big) {
      try {
        // The first kilobyte or so is enough for its header: whole groups of four characters only.
        const start = url.slice(comma + 1, comma + 1 + 1368).replace(/[^A-Za-z0-9+/]/g, "");
        const bytes = Uint8Array.from(atob(start.slice(0, start.length - (start.length % 4))), (c) => c.charCodeAt(0));
        const dims = imageDimensions(bytes);
        big = Boolean(dims && (dims.width > 2000 || dims.height > 2000));
      } catch {}
    }
    if (big) facts.imgs.bigData++;
  };

  const onLdJson = (text: string) => {
    const ld = facts.ldjson;
    if (ld.total >= 10) return;
    ld.total++;
    if (text.length > 200 * 1024) {
      ld.bad++;
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      ld.bad++;
      return;
    }
    const items = (Array.isArray(value) ? value : [value]).slice(0, 50);
    let context = items.length > 0;
    let typed = items.length > 0;
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        context = typed = false;
        continue;
      }
      const record = item as Record<string, unknown>;
      const ctx = record["@context"];
      if (!(typeof ctx === "string" ? ctx.includes("schema.org") : ctx !== undefined && JSON.stringify(ctx).slice(0, 2000).includes("schema.org"))) context = false;
      const nodes = Array.isArray(record["@graph"]) ? (record["@graph"] as unknown[]).slice(0, 50) : [record];
      let any = false;
      for (const node of nodes) {
        const type = node && typeof node === "object" ? (node as Record<string, unknown>)["@type"] : undefined;
        for (const name of Array.isArray(type) ? type : [type]) {
          if (typeof name === "string" && name.trim()) {
            any = true;
            addOnce(ld.types, clip(name.trim(), 40), 5);
          }
        }
      }
      if (!any) typed = false;
    }
    if (!context) ld.noContext++;
    if (!typed) ld.noType++;
  };

  const onScript = (attrs: Attrs, content: string, from: number, to: number) => {
    const type = (attrs.get("type") ?? "").trim().toLowerCase().split(";")[0];
    const src = attrs.get("src");
    if (type === "application/ld+json") {
      onLdJson(content);
      return;
    }
    if (type === "text/babel" || type === "text/jsx") {
      reactish = true;
      jsScripts++;
      return;
    }
    if (!JS_TYPE.test(type)) return;
    jsScripts++;
    if (src !== undefined) {
      markMixed(src);
      if (/babel/i.test(src)) reactish = true;
      const later = attrs.has("async") || attrs.has("defer") || type === "module";
      // Tailwind's Play CDN has to run before the page shows (builder.ts allows it), and has nothing better.
      if (!inBody && !later && !/^(?:https?:)?\/\/cdn\.tailwindcss\.com/i.test(src.trim())) addOnce(facts.blocking, tagSample(from, to), 10);
    } else if (content.includes("createRoot(") || content.includes("ReactDOM.render(")) reactish = true;
  };

  const onMeta = (attrs: Attrs) => {
    const name = (attrs.get("name") ?? attrs.get("property") ?? "").trim().toLowerCase();
    const content = oneLine(attrs.get("content") ?? "");
    if (name === "description") {
      facts.descriptionCount++;
      if (facts.descriptions.length < 3) facts.descriptions.push(clip(content));
      findPlaceholders(content, facts.placeholders);
    } else if (name === "viewport") {
      if (facts.viewport === null) facts.viewport = clip(content);
    } else if (name === "robots" || name === "googlebot") {
      addOnce(facts.robots, clip(content), 3);
      const said = content.toLowerCase().split(/[\s,]+/);
      if (said.includes("noindex") || said.includes("none")) facts.noindex = true;
      if (said.includes("nofollow") || said.includes("none")) facts.nofollow = true;
    } else if (name === "og:title" || name === "og:description" || name === "og:image") {
      const key = name.slice(3) as "title" | "description" | "image";
      if (facts.og[key] === undefined) facts.og[key] = clip(content);
    } else if (name === "twitter:card") {
      if (facts.og.twitterCard === undefined) facts.og.twitterCard = clip(content);
    }
  };

  const onLink = (attrs: Attrs) => {
    const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
    const href = attrs.get("href") ?? "";
    if (rel.includes("canonical")) {
      facts.canonicalCount++;
      if (facts.canonicals.length < 3) facts.canonicals.push(clip(oneLine(href)));
    }
    if (rel.some((r) => r.includes("icon"))) facts.icon = true;
    if (rel.includes("stylesheet") || rel.some((r) => r.includes("icon")) || rel.includes("preload")) markMixed(href);
    if (rel.includes("stylesheet") && /fonts\.googleapis\.com/i.test(href)) checkFontUrl(decodeText(href.trim()));
  };

  /** A link, button or tick box people tap, with a size set smaller than a finger in its code. */
  const checkTarget = (attrs: Attrs, from: number, to: number) => {
    const style = attrs.get("style") ?? "";
    const cls = attrs.get("class") ?? "";
    if (facts.smallTargets.length >= 5 || (!style.includes("px") && !cls.includes("-"))) return;
    let tiny = false;
    if (style.includes("px")) for (const m of style.matchAll(TINY_STYLE)) if (Number(m[2]) > 0 && Number(m[2]) < 24) tiny = true;
    const classes = cls.split(/\s+/).filter(Boolean);
    if (!tiny && classes.some((c) => TINY_CLASS.test(c) && (!c.includes("[") || Number(TINY_CLASS.exec(c)?.[1]) < 24)) && !classes.some((c) => PADDED_CLASS.test(c))) {
      tiny = true;
    }
    if (tiny) addOnce(facts.smallTargets, tagSample(from, to), 5);
  };

  /** A tag between words: they're two words, even with no space between them. */
  const boundary = () => {
    inWord = false;
    if (link) link.text += " ";
    if (button) button.text += " ";
    if (heading) heading.text += " ";
  };

  const onStart = (name: string, attrs: Attrs, selfClosing: boolean, from: number, to: number) => {
    seenToken = true;
    boundary();
    if (!inBody && !HEAD_TAGS.has(name)) inBody = true;
    const id = attrs.get("id");
    if (id && ids.size < 10_000) ids.add(id.trim());
    const style = attrs.get("style");
    if (style) checkStyle(style);
    const cls = attrs.get("class");
    if (cls?.includes("text-[")) {
      for (const m of cls.matchAll(SMALL_CLASS)) {
        const size = Number(m[1]);
        if (size > 0 && ((m[2] === "px" && size < 12) || (m[2] === "rem" && size < 0.75))) addOnce(facts.smallText, m[0].slice(m[0].indexOf("text-")), 5);
      }
    }
    const page = attrs.get("data-page");
    if (page !== undefined && page.trim()) addOnce(facts.pages, clip(page.trim(), 40), 50);
    if (PAGE_TAGS.has(name) && !selfClosing) {
      if (pageStack.length < 256) pageStack.push({ tag: name, page: page?.trim() ? clip(page.trim(), 40) : null });
      else pageOverflow++;
    }
    if (name === "svg" || name === "math") {
      if (!selfClosing) foreign++;
      if (attrs.get("aria-label")?.trim() || attrs.get("aria-labelledby")?.trim()) {
        if (link) link.label = true;
        if (button) button.label = true;
      }
      return;
    }
    if (foreign) {
      if (name === "title" && !selfClosing) svgTitle = true;
      return;
    }
    switch (name) {
      case "html":
        if (facts.lang === null && attrs.has("lang")) facts.lang = clip(attrs.get("lang")!.trim(), 40);
        if (facts.dir === null && attrs.has("dir")) facts.dir = clip(attrs.get("dir")!.trim().toLowerCase(), 10);
        break;
      case "body":
        inBody = true;
        if (facts.dir === null && attrs.has("dir")) facts.dir = clip(attrs.get("dir")!.trim().toLowerCase(), 10);
        break;
      case "meta":
        onMeta(attrs);
        break;
      case "link":
        onLink(attrs);
        break;
      case "img":
        onImg(attrs);
        break;
      case "a": {
        closeLink();
        const label = Boolean(attrs.get("aria-label")?.trim() || attrs.get("aria-labelledby")?.trim() || attrs.get("title")?.trim());
        const nameAttr = attrs.get("name");
        if (nameAttr && ids.size < 10_000) ids.add(nameAttr.trim());
        if (attrs.has("href")) {
          onLinkHref(attrs.get("href")!);
          checkTarget(attrs, from, to);
          if (!selfClosing) link = { label, text: "", from, to };
        }
        break;
      }
      case "button":
        closeButton();
        checkTarget(attrs, from, to);
        if (!selfClosing) button = { label: Boolean(attrs.get("aria-label")?.trim() || attrs.get("aria-labelledby")?.trim() || attrs.get("title")?.trim()), text: "", from, to };
        break;
      case "input": {
        const type = (attrs.get("type") ?? "").toLowerCase();
        if (type === "checkbox" || type === "radio") checkTarget(attrs, from, to);
        break;
      }
      case "code":
      case "pre":
        if (!selfClosing) codeDepth++;
        break;
      case "iframe":
      case "audio":
      case "video":
      case "source":
      case "embed":
        markMixed(attrs.get("src") ?? "");
        break;
      default:
        if (/^h[1-6]$/.test(name) && !selfClosing) {
          closeHeading();
          heading = { level: Number(name[1]), text: "", page: currentPage() };
        } else if ((attrs.get("role") ?? "").toLowerCase() === "button") checkTarget(attrs, from, to);
    }
  };

  const onEnd = (name: string) => {
    seenToken = true;
    boundary();
    if (name === "svg" || name === "math") {
      foreign = Math.max(0, foreign - 1);
      svgTitle = false;
      return;
    }
    if (foreign) {
      if (name === "title") svgTitle = false;
      return;
    }
    if (name === "head") inBody = true;
    else if (name === "a") closeLink();
    else if (name === "button") closeButton();
    else if (/^h[1-6]$/.test(name)) closeHeading();
    else if (name === "code" || name === "pre") codeDepth = Math.max(0, codeDepth - 1);
    if (PAGE_TAGS.has(name)) {
      if (pageOverflow) pageOverflow--;
      else {
        // The nearest open one of the same kind, a few levels down at most, so a page of unclosed tags stays quick.
        for (let k = pageStack.length - 1; k >= Math.max(0, pageStack.length - 16); k--) {
          if (pageStack[k].tag === name) {
            pageStack.length = k;
            break;
          }
        }
      }
    }
  };

  let i = 0;
  // The text before a "<" that isn't a tag runs on into the next piece, so words aren't split.
  let textFrom = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    const next = html.charCodeAt(lt + 1);
    // A comment: skipped. One that never ends hides the rest of the page, as in a browser.
    if (lower.startsWith("<!--", lt)) {
      onText(html.slice(textFrom, lt));
      const end = html.indexOf("-->", lt + 4);
      if (end === -1) {
        textFrom = n;
        break;
      }
      i = textFrom = end + 3;
      continue;
    }
    if (next === 0x21 /* ! */ || next === 0x3f /* ? */) {
      onText(html.slice(textFrom, lt));
      const end = html.indexOf(">", lt + 2);
      if (end === -1) {
        textFrom = n;
        break;
      }
      if (lower.startsWith("<!doctype", lt) && !seenToken) facts.doctype = true;
      seenToken = true;
      i = textFrom = end + 1;
      continue;
    }
    const closing = next === 0x2f; /* / */
    const nameStart = closing ? lt + 2 : lt + 1;
    const first = lower.charCodeAt(nameStart);
    if (!(first >= 0x61 && first <= 0x7a)) {
      // "<" followed by anything but a letter is text, like "a < b".
      i = lt + 1;
      continue;
    }
    let j = nameStart;
    while (j < n) {
      const c = lower.charCodeAt(j);
      if (c === 0x3e || c === 0x2f || c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0d || c === 0x0c) break;
      j++;
    }
    const name = lower.slice(nameStart, Math.min(j, nameStart + 32));
    // The attributes, up to the ">" that ends the tag. A quoted value runs to its closing quote, however
    // long (a data: picture); a tag that never ends hides the rest of the page, as in a browser.
    const attrs: Attrs = new Map();
    let selfClosing = false;
    let end = -1;
    while (j < n) {
      let c = html.charCodeAt(j);
      if (c === 0x3e) {
        end = j;
        break;
      }
      if (c === 0x2f || c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0d || c === 0x0c) {
        selfClosing = c === 0x2f && html.charCodeAt(j + 1) === 0x3e;
        j++;
        continue;
      }
      const attrStart = j;
      while (j < n) {
        c = html.charCodeAt(j);
        if (c === 0x3e || c === 0x2f || c === 0x3d || c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0d || c === 0x0c) break;
        j++;
      }
      if (j === attrStart) {
        // A "=" with no name before it: skipped.
        j++;
        continue;
      }
      const attrName = lower.slice(attrStart, Math.min(j, attrStart + 64));
      while (j < n && (html.charCodeAt(j) === 0x20 || html.charCodeAt(j) === 0x0a || html.charCodeAt(j) === 0x09 || html.charCodeAt(j) === 0x0d)) j++;
      let value = "";
      if (html.charCodeAt(j) === 0x3d) {
        j++;
        while (j < n && (html.charCodeAt(j) === 0x20 || html.charCodeAt(j) === 0x0a || html.charCodeAt(j) === 0x09 || html.charCodeAt(j) === 0x0d)) j++;
        const q = html.charCodeAt(j);
        if (q === 0x22 || q === 0x27) {
          const close = html.indexOf(q === 0x22 ? '"' : "'", j + 1);
          if (close === -1) {
            j = n;
            break;
          }
          value = html.slice(j + 1, close);
          j = close + 1;
        } else {
          const from = j;
          while (j < n) {
            c = html.charCodeAt(j);
            if (c === 0x3e || c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0d || c === 0x0c) break;
            j++;
          }
          value = html.slice(from, j);
        }
      }
      if (attrs.size < 64 && !attrs.has(attrName)) attrs.set(attrName, value);
    }
    if (end === -1) {
      onText(html.slice(textFrom, lt));
      textFrom = n;
      break;
    }
    onText(html.slice(textFrom, lt));
    if (closing) {
      onEnd(name);
      i = textFrom = end + 1;
      continue;
    }
    onStart(name, attrs, selfClosing || VOID.has(name), lt, end + 1);
    i = textFrom = end + 1;
    // Text that isn't tags: the scripts, styles and templates, read whole up to their end tag.
    const raw = name === "title" && !foreign ? "title" : RAW.has(name) && !selfClosing ? name : "";
    if (raw) {
      const close = lower.indexOf(`</${raw}`, i);
      if (close === -1) {
        textFrom = n;
        break;
      }
      const content = html.slice(i, close);
      if (raw === "title") {
        facts.titleCount++;
        const title = oneLine(content);
        if (facts.titles.length < 3) facts.titles.push(clip(title));
        findPlaceholders(title, facts.placeholders);
      } else if (raw === "script") onScript(attrs, content, lt, end + 1);
      else if (raw === "style") {
        checkStyle(content);
        if (content.includes("fonts.googleapis.com")) for (const m of content.matchAll(FONT_IMPORT)) checkFontUrl(m[1]);
      }
      const gt = html.indexOf(">", close);
      if (gt === -1) {
        textFrom = n;
        break;
      }
      i = textFrom = gt + 1;
    }
  }
  if (textFrom < n) onText(html.slice(textFrom));
  closeLink();
  closeButton();
  closeHeading();

  // Links to pages and spots the page doesn't have. A target written anywhere in the file (made by
  // its script, or in a template) counts as there: every id="…" and data-page="…" in it, found in one pass.
  const pageSet = new Set(facts.pages.map((p) => p.toLowerCase()));
  let written: Set<string> | null = null;
  const writtenSomewhere = (target: string) => (written ??= namesWritten(lower)).has(asciiLower(target));
  if (facts.pages.length) {
    for (const [name, href] of routes) {
      if (pageSet.has(name.toLowerCase()) || ids.has(name) || writtenSomewhere(name)) continue;
      addOnce(facts.links.missingPages, clip(href, SAMPLE), 10);
    }
  }
  for (const [id, href] of anchors) {
    if (ids.has(id) || pageSet.has(id.toLowerCase()) || writtenSomewhere(id)) continue;
    addOnce(facts.links.missingIds, clip(href, SAMPLE), 10);
  }

  // The alphabet most of the text is in.
  let total = 0;
  let top: [Alphabet | null, number] = [null, 0];
  for (const [a, count] of letters) {
    total += count;
    if (count > top[1]) top = [a, count];
  }
  facts.script.main = total >= 50 && top[1] / total >= 0.6 ? top[0] : null;
  facts.words = wordCount + Math.floor(wideChars / 2) + Math.floor(thaiChars / 4);
  // A page with headings or page sections in its code shows them itself, however few its words.
  facts.jsBuilt = (reactish && facts.words < 150) || (facts.words < 40 && jsScripts > 0 && facts.headingCount === 0 && !facts.pages.length);
  facts.ownCard = hasOwnPreview(html);
  facts.ownCanonical = hasOwnCanonical(html) || facts.canonicalCount > 0;
  facts.photo = sitePreview(html).image !== null;
  facts.loadsData = html.includes("flashDB.list(") || html.includes("data-flash-price");
  return facts;
}

// What ends a name written without quotes: a space, ">", a quote or "/".
const ENDS_NAME = new Set([0x20, 0x09, 0x0a, 0x0c, 0x0d, 0x3e, 0x22, 0x27, 0x60, 0x2f]);

/**
 * The values of every id=, name= and data-page= written anywhere in the page (lowercased), scripts
 * and templates included, up to 20,000: one pass through it, whatever the page holds.
 */
function namesWritten(lower: string): Set<string> {
  const found = new Set<string>();
  for (const key of ["id=", "name=", "data-page="]) {
    let at = lower.indexOf(key);
    while (at !== -1 && found.size < 20_000) {
      const before = lower.charCodeAt(at - 1);
      // id= on its own, not the end of grid= or uuid=.
      if (key !== "id=" || !((before >= 0x61 && before <= 0x7a) || (before >= 0x30 && before <= 0x39) || before === 0x2d || before === 0x5f)) {
        let from = at + key.length;
        const q = lower[from];
        let to: number;
        if (q === '"' || q === "'" || q === "`") {
          from++;
          to = lower.indexOf(q, from);
          if (to === -1 || to - from > 100) to = from;
        } else {
          to = from;
          while (to < lower.length && to - from <= 100 && !ENDS_NAME.has(lower.charCodeAt(to))) to++;
        }
        if (to > from) found.add(lower.slice(from, to).trim());
      }
      at = lower.indexOf(key, at + key.length);
    }
  }
  return found;
}

/** Blanks like [Phone number] in a text, all-digit ones ([1]) and all-capitals words ([NEW]) aside. */
function findPlaceholders(text: string, found: string[]) {
  if (found.length >= 8 || !text.includes("[")) return;
  for (const m of text.matchAll(PLACEHOLDER)) {
    const inner = m[0].slice(1, -1);
    if (/^[\d\s.]+$/.test(inner)) continue;
    if (/\p{Lu}/u.test(inner) && !/\p{Ll}/u.test(inner) && !/\p{Lo}/u.test(inner)) continue;
    addOnce(found, m[0], 8);
    if (found.length >= 8) return;
  }
}
