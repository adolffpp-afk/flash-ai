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
import { decodeText, hasOwnPreview, sitePreview } from "./site-preview.ts";
import { imageDimensions } from "./imageSize.ts";

/** Changes when the reading changes, so facts saved before are read again (see server/seo.ts). */
export const SEO_VERSION = 8;

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
  /** How wide the first title and description are (see textWidth), measured before they're clipped. */
  titleWidth: number;
  descriptions: string[];
  descriptionCount: number;
  descriptionWidth: number;
  /**
   * The title the page's script gives its home page as it opens (a router's "Home · Golden Crumb" from
   * its { home: "Home" } names or its page ids, or what it sets for home alone), which is what the tab
   * and Google show; null when no code that runs then sets one, or it keeps the page's own <title> there.
   */
  routerTitle: string | null;
  viewport: string | null;
  /** What meta robots and googlebot tags say. */
  robots: string[];
  noindex: boolean;
  nofollow: boolean;
  /** The page names its own main address (a <link rel="canonical"> anywhere in its code): Flash then adds none (see server/seo.ts). */
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
  /** Headings with nothing in them that its script could be filling in (see onStart). */
  emptyHeadings: number;
  emptyHeadingSamples: string[];
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
  /**
   * Blanks like [Phone number] the page shows: in its words, title, description, share tags, alt
   * texts, details for Google (JSON-LD), templates, Alpine's and Vue's data, and its scripts' JSX,
   * strings and template literals. Up to MAX_BLANKS, so the owner can give them all at once.
   */
  placeholders: string[];
  /**
   * Blanks found only in sample entries in its scripts' code: a field of an object in an array the
   * script shows in a list's place while the list is empty, as builder.ts asks (const SAMPLE =
   * [{ price: "[Price]" }], shown as items.length ? items : SAMPLE). They count as shown unless the
   * lists it reads have entries with those fields (sampleFields) and without those blanks.
   */
  scriptPlaceholders: string[];
  /** The fields those blanks are in (price). */
  sampleFields: string[];
  /** The page loads data from Flash when it opens (flashDB lists, prices set in Flash). */
  loadsData: boolean;
  /** The shared lists it reads (flashDB.list("menu")), with "*" for one named while it runs. */
  lists: string[];
  /** Reading the page failed: there is no score. */
  error?: true;
};

const MAX_FACTS = 16_000;
const CLIP = 200;
const SAMPLE = 80;
// Blanks are short (40 characters at most), so every one a page shows is kept, up to this many.
const MAX_BLANKS = 40;

const clip = (text: string, max = CLIP) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
/** Up to max different entries. */
const addOnce = (list: string[], value: string, max: number) => {
  if (list.length < max && !list.includes(value)) list.push(value);
};

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
// An @import's address, to its closing quote or bracket: Google Fonts puts ";" between weights (wght@400;700).
const IMPORT = /@import\s+(?:url\(\s*(?:"([^"]{0,2000})"|'([^']{0,2000})'|([^"'()\s]{0,2000}))|"([^"]{0,2000})"|'([^']{0,2000})')/gi;
const GOOGLE_FONTS = /^\s*(?:https?:)?\/\/fonts\.googleapis\.com\/css2?\?/i;
// A blank like [Phone number], [Dirección] or [מס׳ טלפון] that the builder leaves for the owner to fill
// in: letters, with what Persian writes inside a word (the joiners U+200C and U+200D: [ساعت‌های کاری]) and
// Hebrew in an abbreviation (׳ and ״: [כתובת דוא״ל]). In a script's code, nothing more, so code never looks
// like one; in the words a page shows, also " (Hebrew's דוא"ל), / & and currency signs ([Price in €]).
const SCRIPT_PLACEHOLDER = /\[[\p{Lu}\p{Lo}][\p{L}\p{M}\p{N} '’.\u200c\u200d\u05f3\u05f4-]{1,38}\]/gu;
const PLACEHOLDER = /\[[\p{Lu}\p{Lo}][\p{L}\p{M}\p{N}\p{Sc} '’".\/&\u200c\u200d\u05f3\u05f4-]{1,38}\]/gu;
// An address that is only a blank: href="[Booking link]".
const WHOLE_PLACEHOLDER = new RegExp(`^${PLACEHOLDER.source}$`, "u");
// Bracketed words that are a page's own content, never blanks: keys a game or a guide names ([Space],
// [Enter]), a form's [Optional] and [New], and a song's parts ([Chorus], [Verse 1]).
const NOT_BLANK = new RegExp(
  "^(?:space|spacebar|enter|return|esc|escape|tab|shift|ctrl|control|alt|cmd|command|backspace|delete|del|up|down|left|right" +
    "|optional|opcional|optionnel|facultatif|facultativo|facoltativo|opzionale|required|new" +
    "|chorus|pre-chorus|verse|bridge|intro|outro|hook|refrain|estribillo|coro|verso|refrão|couplet|strophe)(?: \\d{1,2})?$",
  "iu",
);
// Where a blank in a script's code is in its words: after a quote, a tag's ">", a space or "(".
const SCRIPT_TEXT_BEFORE = /[\s"'`>(]/;
// A blank in a string that is an object's field, as a sample entry's are ({ price: "[Price]" }): the
// field's name after a "{", a "," or the line's start, then the string's start, with no quote after it.
const SAMPLE_FIELD = /(?:^|[{,])\s*([A-Za-z_$][\w$]{0,39}|"[\w$ -]{1,40}"|'[\w$ -]{1,40}')\s*:\s*["'`][^"'`\n]*$/;
// An array of objects in a script's code ([{ … }]), which may be sample entries.
const OBJECT_ARRAY = /\[\s*\{/g;
// What comes before an array written in a list's place while it's empty: items.length ? items : [{ … }],
// !items.length ? [{ … }] : items, || [{ … }], ?? [{ … }], or if (!items.length) items = [{ … }].
const INSTEAD_HERE = /\blength\b[^;]{0,40}?\?(?!\.)(?:[^:;]{0,80}:)?\s*$|(?:\|\||\?\?)\s*$|\blength\b[^;{}]{0,40}?\)\s*(?:\{\s*)?(?:[\w$.]+\s*=\s*|return\s+|[\w$.]+\()$/;
// The names used in a list's place, in the same ways (items.length ? items : SAMPLE, || SAMPLE, if (!items.length) items = SAMPLE).
const USED_INSTEAD =
  /\blength\b[^;]{0,40}?\?(?!\.)\s*([A-Za-z_$][\w$]{0,39})(?:[^:;]{0,80}:\s*([A-Za-z_$][\w$]{0,39}))?|(?:\|\||\?\?)\s*([A-Za-z_$][\w$]{0,39})|\blength\b[^;{}]{0,40}?\)\s*(?:\{\s*)?(?:[\w$.]+\s*=\s*|return\s+|[\w$.]+\()([A-Za-z_$][\w$]{0,39})/g;
// A React state an array starts as: const [menu, setMenu] = useState(SAMPLE) (the name), or useState([{ … }]) (written there).
const STATE_OF = /\[\s*[\w$]+\s*,\s*([A-Za-z_$][\w$]{0,39})\s*\]\s*=\s*(?:React\.)?useState\(\s*([A-Za-z_$][\w$]{0,39})\s*\)/g;
const STATE_HERE = /\[\s*[\w$]+\s*,\s*([A-Za-z_$][\w$]{0,39})\s*\]\s*=\s*(?:React\.)?useState\(\s*$/;
// The name an array is given (const SAMPLE = [{ … }]).
const NAMED = /(?<![\w$.])([A-Za-z_$][\w$]{0,39})\s*=(?![=>])\s*$/;
// A line in a script that only logs, throws or is a comment: its words never show on the page.
const NOT_SHOWN_LINE = /console\.|\bthrow\b|Error\(|^\s*(?:\/\/|\/?\*)/;
// A picture or other file a script's HTML or JSX loads over http:// (src="http://…", src={"http://…"}).
const SCRIPT_HTTP_SRC = /\bsrc\s*=\s*(?:\{\s*)?["'`](http:\/\/[^"'`\s<>]{1,200})/gi;
// Tailwind's Play CDN: Tailwind 3's, and Tailwind 4's browser build from jsDelivr or unpkg (which builder.ts allows).
const TAILWIND_PLAY = /^(?:https?:)?\/\/(?:cdn\.tailwindcss\.com|cdn\.jsdelivr\.net\/npm\/@tailwindcss\/browser|unpkg\.com\/@tailwindcss\/browser)(?![\w.-])/i;
const JS_TYPE = /^(?:(?:text|application)\/(?:x-)?(?:java|ecma)script|module)?$/;
const OTHER_SCHEME = /^[a-z][a-z0-9+.-]{0,30}:/i;
// What Alpine.js and Vue (which builder.ts lets apps load) fill an element's words or a picture's alt text from.
const BOUND_TEXT = ["x-text", "x-html", "v-text", "v-html"];
const BOUND_ALT = [":alt", "x-bind:alt", "v-bind:alt"];
const HOME_ROUTES = new Set(["", "home", "index"]);
// A link's settings that are a message the visitor writes and sends (mailto: and sms: body= and subject=, WhatsApp's text=).
const MESSAGE_PARAMS = new Set(["body", "subject", "text", "message", "msg"]);
/** A %-encoded part of an address as it reads, or as it is when it isn't encoded right. */
const uriText = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

type Attrs = Map<string, string>;
// from and to: where its tag is in the page, shown as a sample only when it's needed. id: it has one;
// inner: a tag was seen inside it. An element with an id and nothing in it is one its script fills in.
type Open = { label: boolean; text: string; from: number; to: number; id: boolean; inner: boolean };

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
    titleWidth: 0,
    descriptions: [],
    descriptionCount: 0,
    descriptionWidth: 0,
    routerTitle: null,
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
    emptyHeadingSamples: [],
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
    scriptPlaceholders: [],
    sampleFields: [],
    loadsData: false,
    lists: [],
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
  facts.emptyHeadingSamples = short(facts.emptyHeadingSamples);
  imgs.fileAlt = short(imgs.fileAlt);
  facts.blocking = short(facts.blocking);
  facts.mixed = short(facts.mixed);
  facts.fonts.noSwap = short(facts.fonts.noSwap);
  facts.smallTargets = short(facts.smallTargets);
  facts.sampleFields = short(facts.sampleFields);
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
  // Scripts that set the page's title, read for the title its home page gets (see routerTitle).
  const titleScripts: string[] = [];
  let reactish = false;
  let seenToken = false;
  let inBody = false;
  let foreign = 0;
  let svgTitle = false;
  let codeDepth = 0;
  let link: Open | null = null;
  let button: Open | null = null;
  let heading: (Open & { level: number; page: string }) | null = null;
  // Open <label>s, the ids <label for> names, and small tick boxes with an id that one may name further on.
  let labels = 0;
  const labelled = new Set<string>();
  const boxes: [string, string][] = [];
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

  /** Nothing in it, but an id its script can fill it in by. */
  const filledByScript = (open: Open) => open.id && !open.inner;
  const closeLink = () => {
    if (!link) return;
    const words = link.text.replace(/\s+/g, " ").trim();
    if (!words && !link.label && filledByScript(link)) {
      link = null;
      return;
    }
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
    if (!words && !button.label && filledByScript(button)) {
      button = null;
      return;
    }
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
    if (!text && !heading.label && !filledByScript(heading)) {
      facts.emptyHeadings++;
      addOnce(facts.emptyHeadingSamples, tagSample(heading.from, heading.to), 5);
    }
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

  /**
   * Blanks in an address the page opens: Call us dialling tel:[Phone number], wa.me/[WhatsApp number],
   * a map of [Address] (written as it is, or %-encoded). Only in the address and its other settings,
   * never in a message the visitor fills in and sends (mailto: and sms: body= and subject=, WhatsApp's
   * text=): "Name: [Your name]" there is theirs to write. Whether the whole address is one.
   */
  const addressBlanks = (url: string) => {
    if (codeDepth || (!url.includes("[") && !/%5b/i.test(url))) return false;
    const ask = url.indexOf("?");
    const parts = [ask === -1 ? url : url.slice(0, ask)];
    if (ask !== -1) {
      for (const pair of url.slice(ask + 1).split("&")) {
        const eq = pair.indexOf("=");
        if (!MESSAGE_PARAMS.has(uriText(eq === -1 ? pair : pair.slice(0, eq)).trim().toLowerCase())) parts.push(pair.slice(eq + 1));
      }
    }
    for (const part of parts) {
      const plain = uriText(part);
      findPlaceholders(plain, facts.placeholders);
      if (plain.includes("+")) findPlaceholders(plain.replace(/\+/g, " "), facts.placeholders);
    }
    const plain = uriText(url);
    return WHOLE_PLACEHOLDER.test(plain) && isBlank(plain);
  };

  const onLinkHref = (raw: string) => {
    const href = decodeText(raw).trim();
    // An address left for the owner ([Booking link]) is a blank to fill in, not a link that leads nowhere.
    if (addressBlanks(href)) return;
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
    if (alt === undefined && BOUND_ALT.some((a) => attrs.has(a))) {
      // Its script gives it words: they label what it's in.
      if (link) link.label = true;
      if (button) button.label = true;
      if (heading) heading.label = true;
    } else if (alt === undefined && !decorative) {
      imgs.noAlt++;
      addOnce(imgs.noAltSamples, src ? sampleUrl(src) : "<img>", 5);
    } else if (alt !== undefined) {
      const words = oneLine(alt);
      if (words && (FILE_ALT.test(words) || WORD_ALT.has(words.toLowerCase()))) addOnce(imgs.fileAlt, clip(words, 60), 5);
      // What Google Images and screen readers read: [Photo of the owner] is a blank too.
      if (!codeDepth) findPlaceholders(words, facts.placeholders);
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
    // What Google reads as the page's facts: "telephone": "[Phone number]" is a blank like any other.
    if (text.includes("[")) blanksIn(value);
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

  /** Blanks in the strings of parsed JSON, up to 2,000 values and 20 levels down. */
  const blanksIn = (value: unknown) => {
    let seen = 0;
    const walk = (v: unknown, depth: number) => {
      if (++seen > 2000 || depth > 20) return;
      if (typeof v === "string") findPlaceholders(v, facts.placeholders);
      else if (Array.isArray(v)) for (const item of v) walk(item, depth + 1);
      else if (v && typeof v === "object") for (const item of Object.values(v)) walk(item, depth + 1);
    };
    walk(value, 0);
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
      onScriptWords(content, true);
      return;
    }
    if (!JS_TYPE.test(type)) return;
    jsScripts++;
    if (src === undefined) onScriptWords(content, true);
    if (src !== undefined) {
      markMixed(src);
      if (/babel/i.test(src)) reactish = true;
      const later = attrs.has("async") || attrs.has("defer") || type === "module";
      // Tailwind's Play CDN has to run before the page shows (builder.ts allows it), and has nothing better.
      if (!inBody && !later && !TAILWIND_PLAY.test(src.trim())) addOnce(facts.blocking, tagSample(from, to), 10);
    } else if (content.includes("createRoot(") || content.includes("ReactDOM.render(")) reactish = true;
  };

  /**
   * What a script (or a <template>) writes on the page: blanks like [Phone number] in its strings and
   * JSX, small Tailwind text sizes, and pictures it loads over http://. Pages built by React, Alpine's
   * x-data or sample records shown while a list is empty hold their words here, not in the HTML. A
   * script's blanks in sample entries go apart (see scriptPlaceholders); a template's are shown.
   */
  const onScriptWords = (code: string, script = false) => {
    if (script && titleScripts.length < 5 && code.includes("document.title")) titleScripts.push(code);
    findScriptPlaceholders(code, facts.placeholders, script ? { blanks: facts.scriptPlaceholders, fields: facts.sampleFields } : undefined);
    checkClasses(code);
    if (code.includes("http://")) for (const m of code.matchAll(SCRIPT_HTTP_SRC)) addOnce(facts.mixed, clip(m[1], SAMPLE), 8);
  };

  /** Tailwind text sizes under 12px (text-[10px], text-[0.6rem]) in a class list, or in a script's code. */
  const checkClasses = (text: string) => {
    if (!text.includes("text-[") || facts.smallText.length >= 5) return;
    for (const m of text.matchAll(SMALL_CLASS)) {
      const size = Number(m[1]);
      if (size > 0 && ((m[2] === "px" && size < 12) || (m[2] === "rem" && size < 0.75))) addOnce(facts.smallText, m[0].slice(m[0].indexOf("text-")), 5);
      if (facts.smallText.length >= 5) break;
    }
  };

  const onMeta = (attrs: Attrs) => {
    const name = (attrs.get("name") ?? attrs.get("property") ?? "").trim().toLowerCase();
    const content = oneLine(attrs.get("content") ?? "");
    if (name === "description") {
      if (!facts.descriptionCount++) facts.descriptionWidth = textWidth(content);
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
      if (key !== "image") findPlaceholders(content, facts.placeholders);
    } else if (name === "twitter:card") {
      if (facts.og.twitterCard === undefined) facts.og.twitterCard = clip(content);
    } else if (name === "og:site_name" || name === "twitter:title" || name === "twitter:description") {
      // What share cards show on WhatsApp, Facebook and X.
      findPlaceholders(content, facts.placeholders);
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

  /** Whether something people tap has a size set smaller than a finger in its code. */
  const tiny = (attrs: Attrs) => {
    const style = attrs.get("style") ?? "";
    const cls = attrs.get("class") ?? "";
    if (!style.includes("px") && !cls.includes("-")) return false;
    if (style.includes("px")) for (const m of style.matchAll(TINY_STYLE)) if (Number(m[2]) > 0 && Number(m[2]) < 24) return true;
    const classes = cls.split(/\s+/).filter(Boolean);
    return classes.some((c) => TINY_CLASS.test(c) && (!c.includes("[") || Number(TINY_CLASS.exec(c)?.[1]) < 24)) && !classes.some((c) => PADDED_CLASS.test(c));
  };
  /** A link or button people tap, set smaller than a finger. */
  const checkTarget = (attrs: Attrs, from: number, to: number) => {
    if (facts.smallTargets.length < 5 && tiny(attrs)) addOnce(facts.smallTargets, tagSample(from, to), 5);
  };
  /**
   * A tick box set smaller than a finger, unless it's in a <label> or one names it (<label for>):
   * tapping the label's words ticks it, so the label is what people tap.
   */
  const checkBox = (attrs: Attrs, from: number, to: number) => {
    if (labels || facts.smallTargets.length >= 5 || !tiny(attrs)) return;
    const id = attrs.get("id")?.trim();
    if (!id) addOnce(facts.smallTargets, tagSample(from, to), 5);
    else if (boxes.length < 20) boxes.push([id, tagSample(from, to)]);
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
    if (link) link.inner = true;
    if (button) button.inner = true;
    if (heading) heading.inner = true;
    if (!inBody && !HEAD_TAGS.has(name)) inBody = true;
    const id = attrs.get("id");
    if (id && ids.size < 10_000) ids.add(id.trim());
    const hasId = Boolean(id?.trim());
    const style = attrs.get("style");
    if (style) checkStyle(style);
    const cls = attrs.get("class");
    if (cls) checkClasses(cls);
    // What Alpine and Vue show from code in an attribute (x-data="{ phone: '[Phone number]' }", x-text, :href).
    for (const [attr, value] of attrs) {
      if (value.includes("[") && (attr.startsWith("x-") || attr.startsWith("v-") || attr.startsWith(":"))) findScriptPlaceholders(decodeText(value), facts.placeholders);
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
          if (!selfClosing) link = { label, text: "", from, to, id: hasId, inner: false };
        }
        break;
      }
      case "button":
        closeButton();
        checkTarget(attrs, from, to);
        if (!selfClosing) {
          const label = Boolean(attrs.get("aria-label")?.trim() || attrs.get("aria-labelledby")?.trim() || attrs.get("title")?.trim());
          button = { label, text: "", from, to, id: hasId, inner: false };
        }
        break;
      case "input": {
        const type = (attrs.get("type") ?? "").toLowerCase();
        if (type === "checkbox" || type === "radio") checkBox(attrs, from, to);
        break;
      }
      case "label": {
        const named = attrs.get("for")?.trim();
        if (named && labelled.size < 1000) labelled.add(named);
        if (!selfClosing) labels++;
        break;
      }
      // Code, and the keys a page names (<kbd>[Space]</kbd>): never blanks.
      case "code":
      case "pre":
      case "kbd":
      case "samp":
        if (!selfClosing) codeDepth++;
        break;
      case "iframe":
      case "audio":
      case "video":
      case "source":
      case "embed":
        markMixed(attrs.get("src") ?? "");
        // A map of [Address], a video of [YouTube link].
        addressBlanks(decodeText(attrs.get("src") ?? "").trim());
        break;
      default:
        if (/^h[1-6]$/.test(name) && !selfClosing) {
          closeHeading();
          heading = { level: Number(name[1]), text: "", page: currentPage(), label: false, from, to, id: hasId, inner: false };
        } else if ((attrs.get("role") ?? "").toLowerCase() === "button") checkTarget(attrs, from, to);
    }
    // Words its script writes in (Alpine's x-text, Vue's v-text): what it's in, and itself, aren't empty.
    if (BOUND_TEXT.some((a) => attrs.has(a))) {
      if (link) link.label = true;
      if (button) button.label = true;
      if (heading) heading.label = true;
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
    else if (name === "label") labels = Math.max(0, labels - 1);
    else if (name === "a") closeLink();
    else if (name === "button") closeButton();
    else if (/^h[1-6]$/.test(name)) closeHeading();
    else if (name === "code" || name === "pre" || name === "kbd" || name === "samp") codeDepth = Math.max(0, codeDepth - 1);
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
        const title = oneLine(content);
        if (!facts.titleCount++) facts.titleWidth = textWidth(title);
        if (facts.titles.length < 3) facts.titles.push(clip(title));
        findPlaceholders(title, facts.placeholders);
      } else if (raw === "script") onScript(attrs, content, lt, end + 1);
      else if (raw === "template") onScriptWords(content);
      else if (raw === "style") {
        checkStyle(content);
        if (content.includes("fonts.googleapis.com")) {
          for (const m of content.matchAll(IMPORT)) {
            const url = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "";
            if (GOOGLE_FONTS.test(url)) checkFontUrl(url.trim());
          }
        }
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
  // Small tick boxes no <label for> names.
  for (const [id, tag] of boxes) if (!labelled.has(id)) addOnce(facts.smallTargets, tag, 5);

  // Links to pages and spots the page doesn't have. A target written anywhere in the file (made by
  // its script, or in a template) counts as there: every id="…" and data-page="…" in it, and every id
  // its script sets (see namesWritten), found in one pass.
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
  facts.ownCanonical = facts.canonicalCount > 0;
  facts.photo = sitePreview(html).image !== null;
  facts.loadsData = html.includes("flashDB.list(") || html.includes("data-flash-price");
  // A blank the page shows elsewhere too is shown, whatever its lists hold.
  facts.scriptPlaceholders = facts.scriptPlaceholders.filter((p) => !facts.placeholders.includes(p));
  if (facts.scriptPlaceholders.length && html.includes("flashDB")) facts.lists = listsRead(html);
  if (titleScripts.length) {
    // A script it can't make out leaves the title to the page's own <title>, and the rest of the check stands.
    try {
      facts.routerTitle = homeTitleSet(titleScripts, facts.titles[0] ?? "", facts.pages);
    } catch {}
  }
  return facts;
}

// A script setting the page's title (document.title = …).
const TITLE_SET = /\bdocument\.title\s*=(?![=>])/g;
// Where the title it sets may depend on whether the page is home, in a way not read: ["", "home"].some(…), a home flag.
const HOME_CASE = /["'`](?:home|index|#?\/?)["'`]|\bis_?home\b/i;
// A test of which page it is: page === "home", "home" !== page.
const PAGE_TEST = /^([\w$.]+)\s*(===?|!==?)\s*(["'`])([^"'`]{0,40})\3$|^(["'`])([^"'`]{0,40})\5\s*(===?|!==?)\s*([\w$.]+)$/;
const IS_HOME = /^(!?)\s*[\w$.]*\bis_?home(?:page)?$/i;
const IN_LIST = /^(!?)\s*\[([^\]]{0,200})\]\.includes\(\s*[\w$.]+\s*\)$/;
// Where a block starts: the function, if or else it belongs to (the text before its "{").
const ELSE_HEAD = /(?:^|[^\w$])else\s*$/;
const IF_HEAD = /(?:^|[^\w$.])if\s*\(([\s\S]*)\)\s*$/;
const LOOP_HEAD = /(?:^|[^\w$.])(?:for|while|switch|catch|with)\s*\([\s\S]*\)\s*$|(?:^|[^\w$.])(?:do|try|finally)\s*$/;
const FUNCTION_HEAD =
  /(?:\bfunction\b(?:(?:\s*\*\s*|\s+)([\w$]+)|\s*\*)?\s*\([^()]*\)|(?:\([^()]*\)|(?<![\w$])[\w$]+)\s*=>|(?:^|[\s,{;(])(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\))\s*$/;
// The name a function written as a value is given: const route = () => {, route: function () {.
const FUNCTION_NAMED = /(?<![\w$])([A-Za-z_$][\w$]*)\s*[=:]\s*(?:async\s+)?(?:function\b[^(]{0,80}\([^()]*\)|(?:\([^()]*\)|(?<![\w$])[\w$]+)\s*=>)\s*$/;
// A function written as what an event runs: addEventListener("click", () => {, el.onclick = function () {, JSX's onClick={() => …}.
const EVENT_HEAD =
  /(?:addEventListener\(\s*(["'`])([\w:-]+)\1\s*,|\bon([a-z]+)\s*=|\bon([A-Z]\w*)\s*=\s*\{)\s*(?:async\s+)?(?:function\b[^(]{0,80}\([^()]*\)|(?:\([^()]*\)|(?<![\w$])[\w$]+)\s*=>)\s*$/;
// The same, with a call written as its whole body: addEventListener("hashchange", () => route()).
const EVENT_ARROW = /(?:addEventListener\(\s*(["'`])([\w:-]+)\1\s*,|\bon([a-z]+)\s*=|\bon([A-Z]\w*)\s*=\s*\{)\s*(?:async\s+)?(?:\([^()]*\)|(?<![\w$])[\w$]+)\s*=>[^;{}]*$/;
// What React and Vue run as a page shows: useEffect(() => {, onMounted(() => {.
const EFFECT_HEAD = /\b(?:use(?:Layout)?Effect|onMounted)\(\s*(?:async\s*)?(?:\(\s*\)\s*=>|function\s*\(\s*\))\s*$/;
// Events that come as the page opens or its page changes, not from something the visitor does.
const LOAD_EVENTS = new Set(["hashchange", "popstate", "load", "domcontentloaded", "pageshow"]);
// Functions a library runs as the page opens: Alpine's init(), Vue's mounted(), a web component's connectedCallback().
const RUN_ON_START = new Set(["init", "mounted", "created", "setup", "connectedCallback", "componentDidMount"]);
// A page id with its first letter capitalised: name.charAt(0).toUpperCase() + name.slice(1), or a helper's cap(name).
const CAP_FIRST = /^([\w$.]+)(?:\.charAt\(\s*0\s*\)|\[\s*0\s*\])\.toUpperCase\(\)$/;
const CAP_CALL = /^(?:cap|capitali[sz]e|ucfirst|upperfirst|titlecase|totitlecase)\w*\(\s*[\w$.]+\s*\)$/i;
// The title kept as the script starts: const HOME_TITLE = document.title, the <title>'s textContent, { title } = document.
const KEEPS =
  /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*(?:document\.title|document\.querySelector\(\s*(["'`])title\2\s*\)\??\.(?:textContent|innerText|text)|document\.getElementsByTagName\(\s*(["'`])title\3\s*\)\[\s*0\s*\]\??\.(?:textContent|innerText|text))(?!\s*(?:=(?!=)|[.[(]))/g;
const KEPT_BY_NAME = /\{\s*title\s*(?::\s*([A-Za-z_$][\w$]*)\s*)?\}\s*=\s*document\b/g;

type Block = { open: number; close: number; parent: number };
type TitleRead = { code: string; title: string; pages: string[]; homeId: string; keep: Set<string>; chose: boolean };
/** What a script sets the title to on the home page: words ("Home · Golden Crumb"), the page's own <title>, or a choice for home not read. */
type TitleValue = string | "keep" | "apart" | null;

/**
 * The title a page's script gives its home page as it loads, as Google shows it: what the router
 * sets document.title to there ("Home · <site>" from page names whose home is "Home", as builder.ts
 * asked routers to, a page id capitalised, or what it sets for home alone). Only code that runs as
 * the page opens or its page changes counts (the top of a script, a hashchange or load handler, a
 * function that reads location.hash or that they call, a React effect), never what a click or a
 * key runs. null when none sets one that can be read, or it keeps the page's own <title> for home.
 */
function homeTitleSet(scripts: string[], title: string, pages: string[]): string | null {
  let forHome: TitleValue | undefined;
  let forAll: TitleValue | undefined;
  let apart = false;
  for (const code of scripts) {
    const read: TitleRead = { code, title, pages, homeId: homeIdOf(code, pages), keep: keptTitles(code), chose: false };
    let blocks: ReturnType<typeof blockReader> | undefined;
    let looked = 0;
    for (const m of code.matchAll(TITLE_SET)) {
      if (++looked > 20) break;
      const lineStart = code.lastIndexOf("\n", m.index) + 1;
      if (/(?:^|[^:"'`])\/\/|^\s*\/?\*/.test(code.slice(lineStart, m.index))) continue;
      blocks ??= blockReader(code);
      const inner = blocks.innermost(m.index);
      if (!blocks.runsOnLoad(blocks.functionOf(inner))) continue;
      const side = blocks.sideOf(inner, m.index, read);
      if (side === "other") continue;
      if (side === "unknown") {
        apart = true;
        continue;
      }
      const from = m.index + m[0].length;
      read.chose = false;
      const value = valueOf(code.slice(from, expressionEnd(code, from)), read);
      if (value === "apart") apart = true;
      else if (side === "home" || read.chose) {
        if (value === null) apart = true;
        else forHome ??= value;
      } else if (value !== null) forAll ??= value;
    }
  }
  const value = forHome ?? (apart ? null : forAll);
  if (!value || value === "keep" || value === "apart") return null;
  const text = value.replace(/\s+/g, " ").trim();
  const fold = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return text && fold(text) !== fold(title) ? clip(text, 80) : null;
}

/** The home page's id: what the router falls back to (|| "home") when it's one of the page's sections, else home's section. */
function homeIdOf(code: string, pages: string[]): string {
  for (const m of code.matchAll(/(?:\|\||\?\?)\s*(["'`])([^"'`\s]{1,40})\1/g)) {
    const id = m[2].replace(/^#?\/?/, "");
    if (pages.includes(id)) return id;
  }
  return pages.length && !pages.includes("home") ? pages[0] : "home";
}

/** The names a script keeps the page's own <title> in as it starts (see KEEPS). */
function keptTitles(code: string): Set<string> {
  const names = new Set<string>();
  for (const m of code.matchAll(KEEPS)) if (names.size < 20) names.add(m[1]);
  for (const m of code.matchAll(KEPT_BY_NAME)) if (names.size < 20) names.add(m[1] ?? "title");
  return names;
}

/** Whether a page id or route ("home", "", "#/", "#/home") is the home page's. */
const isHomeId = (id: string, read: TitleRead) => {
  const name = id.replace(/^#?\/?/, "");
  return HOME_ROUTES.has(name.toLowerCase()) || name === read.homeId;
};

/**
 * Which pages a condition holds on: "home" (page === "home", !page || page === "", isHome),
 * "other" (page !== "home", page === "menu" for another of its pages), "unknown" when it is about
 * home in a way not read, null when it isn't about which page it is.
 */
function homeTest(condition: string, read: TitleRead): "home" | "other" | "unknown" | null {
  const and = condition.includes("&&");
  const or = condition.includes("||");
  const kinds = condition.split(/&&|\|\|/).map((raw): "home" | "other" | "notOther" | "unknown" | null => {
    const part = raw.trim().replace(/^\(+/, "").replace(/(?<!\))\)+$/, "").trim();
    const test = PAGE_TEST.exec(part);
    if (test) {
      const value = test[4] ?? test[6];
      const same = (test[2] ?? test[7]).startsWith("=");
      if (isHomeId(value, read)) return same ? "home" : "other";
      if (read.pages.includes(value.replace(/^#?\/?/, ""))) return same ? "other" : "notOther";
      return null;
    }
    const flag = IS_HOME.exec(part);
    if (flag) return flag[1] ? "other" : "home";
    const list = IN_LIST.exec(part);
    if (list) {
      const ids = [...list[2].matchAll(/(["'`])([^"'`]{0,40})\1/g)].map((s) => s[2]);
      if (ids.some((id) => isHomeId(id, read))) return list[1] ? "other" : "home";
      return null;
    }
    return HOME_CASE.test(part) ? "unknown" : null;
  });
  const has = (kind: string) => (kinds as (string | null)[]).includes(kind);
  if (has("unknown")) return "unknown";
  if (!has("home") && !has("other") && !has("notOther")) return null;
  // Every one of the parts, or any one of them.
  if (and) return has("other") ? "other" : has("notOther") ? "unknown" : "home";
  if (or) return has("home") && !has("other") && !has("notOther") ? "home" : has("other") && !has("home") && !has("notOther") ? "other" : "unknown";
  return has("home") ? "home" : has("other") ? "other" : "unknown";
}

/** Where the string or template that starts at i ends (its closing quote, past a template's ${…}), or stop. */
function quoteEnd(code: string, i: number, stop: number, depth = 0): number {
  const q = code[i];
  for (let j = i + 1; j < stop; j++) {
    const c = code[j];
    if (c === "\\") j++;
    else if (c === q) return j;
    else if (q !== "`" && c === "\n") return j;
    else if (q === "`" && c === "$" && code[j + 1] === "{") {
      if (depth > 20) return stop;
      let open = 0;
      for (j++; j < stop; j++) {
        const d = code[j];
        if (d === '"' || d === "'" || d === "`") j = quoteEnd(code, j, stop, depth + 1);
        else if (d === "{") open++;
        else if (d === "}" && --open === 0) break;
      }
    }
  }
  return stop;
}

/** Splits an expression where sep finds a separator (its length) outside brackets, strings and templates. */
function splitTop(expr: string, sep: (i: number) => number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '"' || c === "'" || c === "`") i = quoteEnd(expr, i, expr.length);
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0) {
      const length = sep(i);
      if (length) {
        parts.push(expr.slice(from, i));
        from = i + length;
        i += length - 1;
      }
    }
  }
  parts.push(expr.slice(from));
  return parts;
}

/** Where the value given at from ends: a ; or , or closing bracket outside any, or a line's end where the next line doesn't carry on. At most 400 characters. */
function expressionEnd(code: string, from: number): number {
  const stop = Math.min(code.length, from + 400);
  let depth = 0;
  for (let i = from; i < stop; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") i = quoteEnd(code, i, stop);
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth-- === 0) return i;
    } else if (depth === 0 && (c === ";" || c === ",")) return i;
    else if (depth === 0 && c === "\n") {
      const before = code.slice(from, i).trimEnd();
      if (before && !/[-+*?:=(,|&]$/.test(before) && !/^\s*[-+*?:.|&]/.test(code.slice(i + 1, i + 80))) return i;
    }
  }
  return stop;
}

/** A string literal's words, its escapes written out. */
const literalWords = (text: string) =>
  text.replace(/\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\s\S]))/g, (_, a?: string, b?: string, c?: string, d?: string) =>
    d === undefined ? String.fromCodePoint(Math.min(parseInt((a ?? b ?? c)!, 16), 0x10ffff)) : d === "n" ? "\n" : d === "t" ? "\t" : d,
  );
const LITERAL = /^(["'])((?:\\[\s\S]|(?!\1)[^\\])*)\1$|^`((?:\\[\s\S]|[^`\\$]|\$(?!\{))*)`$/;

/** The words a value gives the home page (see TitleValue), reading choices, page names, ids and the strings around them. */
function valueOf(raw: string, read: TitleRead, depth = 0): TitleValue {
  const expr = raw.trim();
  if (!expr || depth > 6) return null;
  // page === "home" ? A : B: the home page's side.
  let ask = -1;
  let colon = -1;
  let nested = 0;
  splitTop(expr, (i) => {
    const c = expr[i];
    if (c === "?" && expr[i + 1] !== "." && expr[i + 1] !== "?" && expr[i - 1] !== "?") {
      if (ask === -1) ask = i;
      else nested++;
    } else if (c === ":" && ask !== -1 && colon === -1) {
      if (nested) nested--;
      else colon = i;
    }
    return 0;
  });
  if (ask !== -1 && colon !== -1) {
    const side = homeTest(expr.slice(0, ask), read);
    if (side === "unknown") return "apart";
    if (side === null) return null;
    read.chose = true;
    return valueOf(side === "home" ? expr.slice(ask + 1, colon) : expr.slice(colon + 1), read, depth + 1);
  }
  // NAMES[page] || "Page": the first.
  const alternatives = splitTop(expr, (i) => (expr.startsWith("||", i) || expr.startsWith("??", i) ? 2 : 0));
  if (alternatives.length > 1) return valueOf(alternatives[0], read, depth + 1);
  const terms = splitTop(expr, (i) => (expr[i] === "+" && expr[i + 1] !== "+" && expr[i + 1] !== "=" && expr[i - 1] !== "+" ? 1 : 0)).map((t) => t.trim());
  if (terms.length === 1) return termOf(terms[0], read, depth);
  const words: (string | null)[] = [];
  for (let k = 0; k < terms.length; k++) {
    const cap = CAP_FIRST.exec(terms[k]);
    if (cap && terms[k + 1] !== undefined && terms[k + 1].replace(/\s+/g, "") === `${cap[1]}.slice(1)`.replace(/\s+/g, "")) {
      words.push(capitalised(read.homeId));
      k++;
      continue;
    }
    const value = termOf(terms[k], read, depth);
    if (value === "apart") return "apart";
    words.push(value === "keep" ? read.title : value);
  }
  return joined(words);
}

/** Whether a term is one ( … ) as a whole. */
function wrapped(term: string): boolean {
  if (!term.startsWith("(") || !term.endsWith(")")) return false;
  let depth = 0;
  for (let i = 0; i < term.length; i++) {
    const c = term[i];
    if (c === '"' || c === "'" || c === "`") i = quoteEnd(term, i, term.length);
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if ((c === ")" || c === "]" || c === "}") && --depth === 0 && i < term.length - 1) return false;
  }
  return depth === 0;
}

const capitalised = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

/** Words in order, "…" for those not known; null when the first, the page's name, isn't. */
function joined(words: (string | null)[]): string | null {
  if (words[0] === null || words[0] === undefined) return null;
  let text = "";
  for (const word of words) text += word === null ? (/[\p{L}\p{N}]$/u.test(text) ? " · …" : "…") : word;
  return /\p{L}/u.test(text) ? text : null;
}

/** One part of a value: a string, a template, a page name looked up (NAMES[page]), a page id capitalised, a name for a string or the kept <title>. */
function termOf(term: string, read: TitleRead, depth: number): TitleValue {
  if (wrapped(term)) return valueOf(term.slice(1, -1), read, depth + 1);
  const literal = LITERAL.exec(term);
  if (literal) return literalWords(literal[2] ?? literal[3]);
  if (term.startsWith("`") && term.endsWith("`")) return templateOf(term, read, depth);
  const lookup = /^([A-Za-z_$][\w$]*)\s*(?:\?\.)?\[[^\]]*\](?:\s*\??\.\s*([A-Za-z_$][\w$]*))?$/.exec(term);
  if (lookup) return homeEntry(read, lookup[1], lookup[2]);
  if (CAP_CALL.test(term)) return capitalised(read.homeId);
  if (/^[A-Za-z_$][\w$]*$/.test(term)) {
    if (read.keep.has(term)) return "keep";
    const named = new RegExp(`(?<![\\w$.])${term.replace(/\$/g, "\\$")}\\s*=\\s*(["'])((?:\\\\.|(?!\\1)[^\\\\\\n]){0,100})\\1`).exec(read.code);
    return named ? literalWords(named[2]) : null;
  }
  return null;
}

/** A template's words, its ${…} read as values. */
function templateOf(template: string, read: TitleRead, depth: number): TitleValue {
  const words: (string | null)[] = [];
  let text = "";
  for (let i = 1; i < template.length - 1; i++) {
    const c = template[i];
    if (c === "\\") {
      text += literalWords(template.slice(i, i + 2));
      i++;
    } else if (c === "$" && template[i + 1] === "{") {
      let open = 0;
      let j = i + 1;
      for (; j < template.length - 1; j++) {
        const d = template[j];
        if (d === '"' || d === "'" || d === "`") j = quoteEnd(template, j, template.length - 1);
        else if (d === "{") open++;
        else if (d === "}" && --open === 0) break;
      }
      if (text) words.push(text);
      text = "";
      const value = valueOf(template.slice(i + 2, j), read, depth + 1);
      if (value === "apart") return "apart";
      words.push(value === "keep" ? read.title : value);
      i = j;
    } else text += c;
  }
  if (text) words.push(text);
  return words.length ? joined(words) : "";
}

/**
 * What the object literal written for name gives the home page: its home, index, "" or "#/" key
 * ({ home: "Home" }), or that entry's prop when it's an object ({ home: { title: "Home" } }).
 */
function homeEntry(read: TitleRead, name: string, prop: string | undefined): string | null {
  const at = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*=\\s*(?:Object\\.freeze\\(\\s*)?\\{`).exec(read.code);
  if (!at) return null;
  const entry = entryOf(read.code, at.index + at[0].length - 1, (key) => isHomeId(key, read));
  if (entry === null) return null;
  if (prop === undefined) return literalOf(entry);
  if (!entry.startsWith("{")) return null;
  const inner = entryOf(entry, 0, (key) => key === prop);
  return inner === null ? null : literalOf(inner);
}

const literalOf = (text: string) => {
  const literal = LITERAL.exec(text.trim());
  return literal ? literalWords(literal[2] ?? literal[3]) : null;
};

/** The value of the first entry whose key is wanted in the object literal that opens at open (up to 200 entries and 20,000 characters), or null. */
function entryOf(code: string, open: number, wanted: (key: string) => boolean): string | null {
  const stop = Math.min(code.length, open + 20_000);
  const match = (text: string) => {
    const m = /^\s*(?:([A-Za-z_$][\w$]*)|(["'`])([^"'`]*)\2|\[\s*(["'`])([^"'`]*)\4\s*\])\s*:\s*([\s\S]*)$/.exec(text);
    return m && wanted(m[1] ?? m[3] ?? m[5]) ? m[6].trim() : null;
  };
  let depth = 0;
  let from = open + 1;
  let entries = 0;
  for (let i = open; i < stop; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") i = quoteEnd(code, i, stop);
    else if (c === "/" && code[i + 1] === "/") i = code.indexOf("\n", i) === -1 ? stop : code.indexOf("\n", i);
    else if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") {
      if (--depth === 0) return match(code.slice(from, i));
    } else if (c === "," && depth === 1) {
      const value = match(code.slice(from, i));
      if (value !== null) return value;
      if (++entries > 200) return null;
      from = i + 1;
    }
  }
  return null;
}

/**
 * The { } blocks of a script's code, past its strings, templates, comments and patterns, read in one
 * pass (up to 20,000 of them), and what they say about the code inside: which function it's in,
 * whether that runs as the page opens, and which pages an if around it holds on.
 */
function blockReader(code: string) {
  const blocks: Block[] = [];
  // Open blocks: their index, -1 for a template's ${ and -2 for one past the limit; owner: the block each is in.
  const stack: number[] = [];
  const owner: number[] = [];
  const n = code.length;
  let prev = "";
  let template = false;
  for (let i = 0; i < n; i++) {
    const c = code[i];
    if (template) {
      if (c === "\\") i++;
      else if (c === "`") {
        template = false;
        prev = "`";
      } else if (c === "$" && code[i + 1] === "{") {
        stack.push(-1);
        owner.push(owner.length ? owner[owner.length - 1] : -1);
        template = false;
        prev = "{";
        i++;
      }
      continue;
    }
    if (c === "`") {
      template = true;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && code[j] !== c && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
      i = j;
      prev = c;
      continue;
    }
    if (c === "/") {
      const d = code[i + 1];
      if (d === "/") {
        const end = code.indexOf("\n", i);
        i = end === -1 ? n : end - 1;
        continue;
      }
      if (d === "*") {
        const end = code.indexOf("*/", i + 2);
        i = end === -1 ? n : end + 1;
        continue;
      }
      // A pattern (/^#\//), where a value starts; never JSX's </p> or />.
      if (d !== ">" && (!prev || "(,=:[!&|?{};+-*%~^".includes(prev) || /\b(?:return|typeof|case|void|throw)\s*$/.test(code.slice(Math.max(0, i - 8), i)))) {
        let j = i + 1;
        let set = false;
        while (j < n && code[j] !== "\n") {
          const e = code[j];
          if (e === "\\") j++;
          else if (e === "[") set = true;
          else if (e === "]") set = false;
          else if (e === "/" && !set) break;
          j++;
        }
        i = j;
        prev = "a";
        continue;
      }
    }
    if (c === "{") {
      const parent = owner.length ? owner[owner.length - 1] : -1;
      if (blocks.length < 20_000) {
        blocks.push({ open: i, close: n, parent });
        stack.push(blocks.length - 1);
        owner.push(blocks.length - 1);
      } else {
        stack.push(-2);
        owner.push(parent);
      }
    } else if (c === "}") {
      const top = stack.pop();
      owner.pop();
      if (top === -1) {
        template = true;
        continue;
      }
      if (top !== undefined && top >= 0) blocks[top].close = i;
    }
    if (c > " ") prev = c;
  }

  const closedAt = new Map<number, number>();
  for (const [k, b] of blocks.entries()) if (b.close < n) closedAt.set(b.close, k);
  /** The text before a block's "{": the 300 characters before it, and from the statement it starts. */
  const beforeOf = (k: number) => code.slice(Math.max(0, blocks[k].open - 300), blocks[k].open);
  const headOf = (k: number) => {
    const before = beforeOf(k);
    return before.slice(Math.max(before.lastIndexOf(";"), before.lastIndexOf("{"), before.lastIndexOf("}")) + 1);
  };
  type Kind = { fn: boolean; name?: string; event?: string; cond?: string; otherwise?: boolean };
  const kinds = new Map<number, Kind>();
  const kindOf = (k: number): Kind => {
    let kind = kinds.get(k);
    if (kind) return kind;
    const head = headOf(k);
    // A function's own head may hold a "{" (JSX's onClick={() => {), so it's read in all the text before.
    const before = beforeOf(k);
    const iff = IF_HEAD.exec(head);
    const fn = FUNCTION_HEAD.exec(before);
    if (iff) kind = { fn: false, cond: iff[1], otherwise: /(?:^|[^\w$])else\s+if\s*\(/.test(head) };
    else if (ELSE_HEAD.test(head)) kind = { fn: false, otherwise: true };
    else if (LOOP_HEAD.test(head) || !fn) kind = { fn: false };
    else {
      const event = EVENT_HEAD.exec(before);
      kind = {
        fn: true,
        event: event ? (event[2] ?? event[3] ?? event[4]).toLowerCase() : EFFECT_HEAD.test(before) ? "effect" : undefined,
        name: fn[1] || fn[2] || FUNCTION_NAMED.exec(before)?.[1] || undefined,
      };
    }
    kinds.set(k, kind);
    return kind;
  };
  /** The innermost block around position at, or -1. */
  const innermost = (at: number) => {
    let lo = 0;
    let hi = blocks.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].open < at) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    while (k !== -1 && blocks[k].close < at) k = blocks[k].parent;
    return k;
  };
  /** The function a block is in (itself, when it is one), -1 at the top of the script, or -2 more than 64 blocks down. */
  const functionOf = (k: number) => {
    for (let up = 0; k >= 0 && !kindOf(k).fn; up++) k = up < 64 ? blocks[k].parent : -2;
    return k;
  };
  const onLoad = new Map<number, boolean>();
  const named = new Map<string, boolean>();
  // Each named function is looked for in the whole script: at most 30 of them, so a script of many is read quickly.
  let lookups = 0;
  /** Whether the function (-1: the top of the script) runs as the page opens or its page changes. */
  const runsOnLoad = (fn: number): boolean => {
    if (fn === -1) return true;
    if (fn < 0) return false;
    const known = onLoad.get(fn);
    if (known !== undefined) return known;
    onLoad.set(fn, false);
    const kind = kindOf(fn);
    let runs: boolean;
    if (kind.event) runs = kind.event === "effect" || LOAD_EVENTS.has(kind.event);
    else if (kind.name) runs = nameRunsOnLoad(kind.name, fn);
    // A function handed to another (forEach, then, setTimeout): when the one it's in runs.
    else runs = runsOnLoad(functionOf(blocks[fn].parent));
    onLoad.set(fn, runs);
    return runs;
  };
  const nameRunsOnLoad = (name: string, fn: number): boolean => {
    const known = named.get(name);
    if (known !== undefined) return known;
    named.set(name, false);
    if (++lookups > 30) return false;
    const word = name.replace(/\$/g, "\\$");
    const body = code.slice(blocks[fn].open, blocks[fn].close);
    let runs =
      /location\.hash\b(?!\s*=(?!=))/.test(body) ||
      RUN_ON_START.has(name) ||
      new RegExp(`(?:addEventListener\\(\\s*["'\`](?:hashchange|popstate|load|DOMContentLoaded|pageshow)["'\`]\\s*,\\s*|\\bon(?:hashchange|popstate|load)\\s*=\\s*)${word}\\b`).test(code) ||
      (/^[A-Z]/.test(name) && new RegExp(`<${word}\\b`).test(code));
    if (!runs) {
      let calls = 0;
      for (const m of code.matchAll(new RegExp(`(?<![\\w$])${word}\\s*\\(`, "g"))) {
        if (++calls > 50) break;
        const before = code.slice(Math.max(0, m.index - 200), m.index);
        if (/\bfunction(?:\s*\*)?\s*$/.test(before) || (m.index > blocks[fn].open - 300 && m.index < blocks[fn].open)) continue;
        const event = EVENT_ARROW.exec(before);
        if (event) {
          if (LOAD_EVENTS.has((event[2] ?? event[3] ?? event[4]).toLowerCase())) runs = true;
        } else {
          const caller = functionOf(innermost(m.index));
          if (caller !== fn && runsOnLoad(caller)) runs = true;
        }
        if (runs) break;
      }
    }
    named.set(name, runs);
    return runs;
  };
  /**
   * Which pages the code at position at (in block k, -1 for none) runs on, by the ifs around it in its
   * function and the if, else or case it follows: "home", "other", "unknown" (a test about home not
   * read) or null (every page).
   */
  const sideOf = (k: number, at: number, read: TitleRead): "home" | "other" | "unknown" | null => {
    const sides: ("home" | "other" | "unknown" | null)[] = [];
    // The statement it's in: if (page !== "home") document.title = …, case "home": document.title = ….
    const start = Math.max(code.lastIndexOf(";", at - 1), code.lastIndexOf("{", at - 1), code.lastIndexOf("}", at - 1), at - 300) + 1;
    const statement = code.slice(start, at);
    const iff = IF_HEAD.exec(statement);
    if (iff) sides.push(homeTest(iff[1], read));
    const option = /\bcase\s+(["'`])([^"'`]{0,40})\1\s*:\s*$/.exec(statement);
    if (option) sides.push(isHomeId(option[2], read) ? "home" : "other");
    for (let b = k, up = 0; b >= 0 && up < 64 && !kindOf(b).fn; b = blocks[b].parent, up++) {
      const kind = kindOf(b);
      const own = kind.cond !== undefined ? homeTest(kind.cond, read) : null;
      if (kind.otherwise) {
        // The if (or else if) just before: its else holds where it doesn't.
        const end = blocks[b].open - headOf(b).length - 1;
        const before = code[end] === "}" ? closedAt.get(end) : undefined;
        const previous = before === undefined || kindOf(before).cond === undefined ? null : homeTest(kindOf(before).cond!, read);
        if (previous === "home") sides.push("other");
        else if (previous === "unknown") sides.push("unknown");
        else if (previous === "other" && kind.cond === undefined) sides.push("home");
      }
      if (own !== null) sides.push(own);
    }
    if (sides.includes("other")) return "other";
    if (sides.includes("unknown")) return "unknown";
    return sides.includes("home") ? "home" : null;
  };
  return { innermost, functionOf, runsOnLoad, sideOf };
}

/**
 * The shared lists a page reads, by the names its flashDB.list calls give, with "*" for a name made
 * while it runs, or for more than it looks at (10 names, 200 calls).
 */
function listsRead(html: string): string[] {
  const names = new Set<string>();
  let calls = 0;
  for (const m of html.matchAll(/\bflashDB\s*\??\.\s*list\s*\(\s*(?:(["'`])([A-Za-z0-9_-]{1,40})\1\s*[,)])?/g)) {
    if (++calls > 200 || names.size >= 10) {
      names.add("*");
      break;
    }
    names.add(m[2] ?? "*");
  }
  return [...names];
}

// What ends a name written without quotes: a space, ">", a quote or "/".
const ENDS_NAME = new Set([0x20, 0x09, 0x0a, 0x0c, 0x0d, 0x3e, 0x22, 0x27, 0x60, 0x2f]);

// An id a script gives an element by name (lowercased): el.id = "faq", setAttribute("id", "faq").
const SCRIPT_ID = /\.id\s*=(?![=>])\s*(["'`])([^"'`\n]{1,100})\1|setattribute\(\s*(["'`])id\3\s*,\s*(["'`])([^"'`\n]{1,100})\4/g;
// An id a script makes while it runs: el.id = s.key, setAttribute("id", name), id="${…}" in a template, JSX's id={…}.
const SCRIPT_ID_MADE = /\.id\s*=(?![=>])\s*(?!["'`][^"'`$\n]{1,100}["'`])[^\s=]|setattribute\(\s*(["'`])id\1\s*,\s*(?!["'`][^"'`$\n]{1,100}["'`])\S|\bid\s*=\s*(?:\{|["'`]\$\{)/;
// A short string in the code, which such an id may be made from ({ key: "breads" }).
const SHORT_STRING = /(["'`])([^"'`\s<>]{1,60})\1/g;

/**
 * The values of every id=, name= and data-page= written anywhere in the page (lowercased), scripts
 * and templates included, and the ids its scripts set (el.id = "faq", setAttribute("id", "faq")), up
 * to 20,000: one pass through it, whatever the page holds. When a script makes ids from its data
 * (el.id = s.key), every short string in the page may be one, so they all count.
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
  if (lower.includes(".id") || lower.includes("setattribute(")) {
    for (const m of lower.matchAll(SCRIPT_ID)) {
      if (found.size >= 20_000) break;
      found.add((m[2] ?? m[5]).trim());
    }
  }
  if (SCRIPT_ID_MADE.test(lower)) {
    for (const m of lower.matchAll(SHORT_STRING)) {
      if (found.size >= 20_000) break;
      found.add(m[2]);
    }
  }
  return found;
}

/** Whether a [bracketed] text is a blank: all-digit ones ([1]), all-capitals words ([NEW]) and a page's own words ([Space], [Chorus]) aside. */
function isBlank(match: string): boolean {
  const inner = match.slice(1, -1);
  if (/^[\d\s.]+$/.test(inner) || NOT_BLANK.test(inner)) return false;
  return !(/\p{Lu}/u.test(inner) && !/\p{Ll}/u.test(inner) && !/\p{Lo}/u.test(inner));
}

/** Blanks like [Phone number] in a text the page shows. */
function findPlaceholders(text: string, found: string[]) {
  if (found.length >= MAX_BLANKS || !text.includes("[")) return;
  for (const m of text.matchAll(PLACEHOLDER)) {
    if (!isBlank(m[0])) continue;
    addOnce(found, m[0], MAX_BLANKS);
    if (found.length >= MAX_BLANKS) return;
  }
}

/**
 * Blanks like [Phone number] in a script's words: its strings, JSX text and template literals, which
 * show on the page. Code that looks like one never counts: items[Key] (a name or a bracket before it),
 * obj[Symbol.iterator] (a "." inside), a pattern's [A-Za-z], what follows it as code ([A-Za-z]+,
 * [Key](…)), and lines that only log or throw ("[App] failed") or are comments. At most 2,000 are
 * looked at, so a script full of brackets is read as quickly as any other. With samples, a blank that
 * is an object's field in sample entries (see sampleArrays) goes there, with its field. Any other
 * object's are shown: a lone one (const SPECIAL = { price: "[Price]" }), JSX's and createElement's props.
 */
function findScriptPlaceholders(code: string, found: string[], samples?: { blanks: string[]; fields: string[] }) {
  if ((found.length >= MAX_BLANKS && !samples) || !code.includes("[")) return;
  let looked = 0;
  let sampled: [number, number][] | undefined;
  for (const m of code.matchAll(SCRIPT_PLACEHOLDER)) {
    if (++looked > 2000) return;
    const at = m.index;
    const inner = m[0].slice(1, -1);
    const head = code.slice(Math.max(0, at - 160), at);
    // In an address too: href="tel:[Phone number]", wa.me/[WhatsApp number], ?q=[Street address].
    if (at > 0 && !SCRIPT_TEXT_BEFORE.test(code[at - 1]) && !(/[:/=]/.test(code[at - 1]) && (inner.includes(" ") || /\b(?:tel|mailto|sms):$/i.test(head)))) continue;
    if (/^[A-Z]-[A-Z]/.test(inner) || /\p{L}\.\p{L}/u.test(inner)) continue;
    if (/[({+*?]/.test(code[at + m[0].length] ?? "")) continue;
    const line = head.slice(head.lastIndexOf("\n") + 1);
    if (NOT_SHOWN_LINE.test(line) || !isBlank(m[0]) || nameArray(code, inner, line, at + m[0].length)) continue;
    const field = samples && SAMPLE_FIELD.exec(line)?.[1];
    if (samples && field && (sampled ??= sampleArrays(code)).some(([from, to]) => at > from && at < to)) {
      addOnce(samples.blanks, m[0], MAX_BLANKS);
      addOnce(samples.fields, field.replace(/^["']|["']$/g, ""), 8);
    } else addOnce(found, m[0], MAX_BLANKS);
    if (found.length >= MAX_BLANKS && (!samples || samples.blanks.length >= MAX_BLANKS)) return;
  }
}

// What code puts before an array as a value: a property named as code names them (plugins:, after a
// "{", a "," or the line's start), name =, =>, a call's "(", another "[", a "," after code, or return.
// Words before a ":" ("Find us: ", "Phone: ") are a page's text.
const NAME_ARRAY_BEFORE = /(?:(?:^|[{,([])\s*[a-z_$][\w$]*\s*:|(?<![=!<>])=>?|[\w$)\]}]\s*,|\[|[\w$)\]]\(|(?<![\w$])return)\s*$/;
// What code puts after one: a closing bracket, the line's end (or a comment) after an optional , or ;,
// more code after a , (another property, argument or item) or a ; (another statement). Words after
// it (", Lisbon", "; WhatsApp: [WhatsApp]") are a page's text.
const NAME_ARRAY_AFTER =
  /^[ \t]*(?:[\])}]|(?:[,;][ \t]*)?(?:\r?\n|$|\/[/*])|,[ \t]*(?:[\])}[{"'`]|\.\.\.|[a-z_$][\w$]*[ \t]*:|[\w$.]+[ \t]*(?:[=(.[\])},]|=>))|;[ \t]*(?:[}\])]|(?:const|let|var|return|if|for|while|function|class|await|new|export)\b|[\w$.]+[ \t]*(?:[=(.[]|\+\+|--)))/;

/**
 * Whether a [Name] in a script is code: an array of one name (plugins: [ChartDataLabels], scene:
 * [MainScene], return [Header];), outside any string on its line and any tag, after what starts a
 * value and followed by what ends one. A blank in a string, a template or JSX text has a quote or a
 * tag on its line, or words before or after it, even on a line of its own ("Find us: [Address], Lisbon").
 */
function nameArray(code: string, inner: string, line: string, end: number): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(inner) || /<[A-Za-z/]/.test(line)) return false;
  for (const quote of ['"', "'", "`"]) if (line.split(quote).length % 2 === 0) return false;
  return NAME_ARRAY_BEFORE.test(line) && NAME_ARRAY_AFTER.test(code.slice(end, end + 200));
}

/**
 * Where a script's code holds sample entries: arrays of objects it shows in a list's place while the
 * list is empty, as builder.ts asks. Written there (items.length ? items : [{ … }]), or named (const
 * SAMPLE = [{ … }]) and used there (items.length ? items : SAMPLE, if (!items.length) items = SAMPLE),
 * or a React state that starts as one and is set from flashDB.list. At most 50 arrays are looked at,
 * each up to 20,000 characters long, and the names in one pass, so any script is read quickly.
 */
function sampleArrays(code: string): [number, number][] {
  const found: [number, number][] = [];
  let names: Set<string> | undefined;
  let looked = 0;
  for (const m of code.matchAll(OBJECT_ARRAY)) {
    if (++looked > 50) break;
    const before = code.slice(Math.max(0, m.index - 160), m.index);
    let sample = INSTEAD_HERE.test(before) || setFromList(code, STATE_HERE.exec(before)?.[1]);
    const name = !sample && NAMED.exec(before)?.[1];
    if (name) sample = (names ??= namesUsedInstead(code)).has(name);
    const end = sample ? arrayEnd(code, m.index) : -1;
    if (end !== -1) found.push([m.index, end]);
  }
  return found;
}

/** The names a script uses in a list's place while it's empty (see sampleArrays). */
function namesUsedInstead(code: string): Set<string> {
  const names = new Set<string>();
  for (const m of code.matchAll(USED_INSTEAD)) for (const name of m.slice(1)) if (name) names.add(name);
  let states = 0;
  for (const m of code.matchAll(STATE_OF)) {
    if (++states > 20) break;
    if (setFromList(code, m[1])) names.add(m[2]);
  }
  return names;
}

/** Whether a React state's setter (setMenu) is called with what flashDB.list gives, in the 300 characters after a call (of the first 20). */
function setFromList(code: string, setter: string | undefined): boolean {
  if (!setter) return false;
  const word = new RegExp(`(?<![\\w$])${setter.replace(/\$/g, "\\$")}(?![\\w$])`);
  let calls = 0;
  for (const m of code.matchAll(/\bflashDB\s*\??\.\s*list\s*\(/g)) {
    if (++calls > 20) break;
    if (word.test(code.slice(m.index, m.index + 300))) return true;
  }
  return false;
}

/**
 * Where the array that starts at from ends (its "]"), past strings and comments, or -1 when it doesn't
 * within 20,000 characters.
 */
function arrayEnd(code: string, from: number): number {
  const stop = Math.min(code.length, from + 20_000);
  let depth = 0;
  for (let i = from; i < stop; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < stop && code[i] !== c; i++) if (code[i] === "\\") i++;
    } else if (c === "/" && (code[i + 1] === "/" || code[i + 1] === "*")) {
      const end = code[i + 1] === "/" ? code.indexOf("\n", i) : code.indexOf("*/", i + 2) + 1;
      if (end <= 0) return -1;
      i = end;
    } else if (c === "[" || c === "{" || c === "(") depth++;
    else if (c === "]" || c === "}" || c === ")") {
      if (--depth === 0) return c === "]" ? i : -1;
    }
  }
  return -1;
}
