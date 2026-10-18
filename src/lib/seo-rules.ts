/*
 * Flash's search check (SEO), part two: what the facts read from a page (seo-scan.ts) mean, as a
 * list of checks and a score. Pure, so the server and the browser judge a page the same way. Each
 * check says what it found (problem and values, which seo-words.ts puts in the owner's words) and,
 * when the builder can fix it, exactly what to change (fix, in English, for the builder only).
 *
 * The score counts only checks that passed, could be better or have a problem, each by its weight:
 * 3 for what decides whether Google can list and show the page at all, 2 for important checks and 1
 * for small ones; one that could be better gets half its points. Tips, what Flash takes care of and
 * checks that don't apply never count. Only the page's own code decides it, never the owner's plan
 * or domain (except whether a main address the page names itself is one of its own).
 */
import type { Alphabet, SeoFacts } from "./seo-scan.ts";

export type CheckId =
  | "title"
  | "description"
  | "indexing"
  | "canonical"
  | "sitemap"
  | "structured"
  | "language"
  | "h1"
  | "headings"
  | "alt"
  | "linkText"
  | "links"
  | "placeholders"
  | "card"
  | "photo"
  | "viewport"
  | "textSize"
  | "tapTargets"
  | "direction"
  | "weight"
  | "blocking"
  | "images"
  | "imageFiles"
  | "fonts"
  | "mixed"
  | "doctype"
  | "icon"
  | "robots"
  | "hashPages"
  | "jsBuilt"
  | "externalLinks"
  | "loadsData";

/** The checks in the order they're listed (after the ones to fix, which come first). */
export const CHECK_ORDER: readonly CheckId[] = [
  "title",
  "description",
  "indexing",
  "canonical",
  "sitemap",
  "structured",
  "language",
  "h1",
  "headings",
  "alt",
  "linkText",
  "links",
  "placeholders",
  "card",
  "photo",
  "viewport",
  "textSize",
  "tapTargets",
  "direction",
  "weight",
  "blocking",
  "images",
  "imageFiles",
  "fonts",
  "mixed",
  "doctype",
  "icon",
  "robots",
  "hashPages",
  "jsBuilt",
  "externalLinks",
  "loadsData",
];

/** pass, warn (could be better) and fail count in the score; tip, flash (Flash takes care of it) and na never do. */
export type Status = "pass" | "warn" | "fail" | "tip" | "flash" | "na";
/** fix: the builder can change it (Fix it); tell: only the owner knows (write it in the chat); preview: open the link preview. */
export type Action = "fix" | "tell" | "preview" | null;
export type Check = {
  id: CheckId;
  weight: 0 | 1 | 2 | 3;
  status: Status;
  /** What it found: with id, the key of its message (see seo-words.ts). */
  problem: string;
  /** The blanks in its message. Text from the page is shown as written. */
  values: Record<string, string | number>;
  /** What the builder should change, in English, or null. */
  fix: string | null;
  action: Action;
};
/**
 * slug, Flash's address without a trailing slash (FLASH_APP_URL or SITE_URL), and the app's own
 * domains; live: those of them Flash last saw pointing at it, which show the app (all of domains when
 * left out). listsFilled: every shared list the page reads has entries without the blanks its scripts
 * hold (see server/seo.ts), so those are in sample entries visitors don't see.
 */
export type SeoContext = { slug: string; appBase: string; domains: string[]; live?: string[]; listsFilled?: boolean };
/** score is null when the page couldn't be read: no number is ever shown then. */
export type SeoReport = { score: number | null; passed: number; total: number; checks: Check[] };

const FIX_MAX = 450;
const SAMPLE_MAX = 60;
/** The whole instruction a fix sends stays under what the chat keeps of it (cleanUserMessage in turns.ts keeps 4,000). */
export const MAX_CONTEXT = 3900;

const sample = (text: string) => (text.length <= SAMPLE_MAX ? text : `${text.slice(0, SAMPLE_MAX - 1)}…`);
const samples = (list: string[], max = 5) => list.slice(0, max).map(sample).join(", ");
const quoted = (list: string[], max = 5) =>
  list
    .slice(0, max)
    .map((s) => `"${sample(s)}"`)
    .join(", ");
const fixText = (...parts: (string | false | 0 | null | undefined)[]) => {
  const text = parts.filter(Boolean).join(" ");
  return text.length <= FIX_MAX ? text : `${text.slice(0, FIX_MAX - 1)}…`;
};
const fold = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

// What a site calls its home page in each language Flash is shown in (as a builder names it in the nav),
// by the page's lang. English's "home" is used in every language. Only the page's own language's
// words count, so a business named Lakay or Nyumbani on an English page is a name.
const HOME_WORDS: Record<string, string[]> = {
  es: ["inicio", "página principal"],
  fr: ["accueil"],
  de: ["startseite", "start"],
  pt: ["início", "página inicial"],
  nl: ["startpagina", "start"],
  it: ["pagina iniziale"],
  pl: ["strona główna", "start"],
  tr: ["ana sayfa", "anasayfa"],
  ro: ["acasă", "pagina principală"],
  sv: ["hem", "startsida", "start"],
  id: ["beranda", "halaman utama"],
  ms: ["beranda", "halaman utama"],
  sw: ["nyumbani", "mwanzo"],
  tl: ["tahanan"],
  vi: ["trang chủ"],
  ht: ["akèy", "lakay"],
  el: ["αρχική", "αρχική σελίδα"],
  ru: ["главная", "главная страница"],
  uk: ["головна", "головна сторінка"],
  ar: ["الرئيسية", "الصفحة الرئيسية"],
  he: ["דף הבית", "בית", "ראשי"],
  fa: ["خانه", "صفحه اصلی", "صفحهٔ اصلی"],
  ur: ["ہوم", "صفحہ اول", "مرکزی صفحہ"],
  hi: ["होम", "मुखपृष्ठ", "मुख्य पृष्ठ"],
  bn: ["হোম", "প্রথম পাতা", "মূল পাতা"],
  th: ["หน้าแรก", "หน้าหลัก"],
  ja: ["ホーム", "トップページ", "トップ"],
  ko: ["홈"],
  zh: ["首页", "主页", "首頁", "主頁"],
};
// Titles that say nothing about what the site is (with the home words of the page's language).
const GENERIC_TITLES = new Set([
  "untitled",
  "document",
  "index",
  "welcome",
  "my app",
  "my website",
  "new page",
  "page",
  "app",
  "website",
  "title",
  "react app",
  "vite app",
  "made with flash",
]);
const homeWords = new Map<string, { starts: RegExp; generic: Set<string> }>();
/**
 * A many-page site's "Home · Name" (as site-preview.ts strips it for the share card), "Inicio · Nombre",
 * "ホーム｜名前", "Главная — Пекарня", in the page's language, and the titles that say nothing in it. A
 * dash counts only after a space: one in a word (Start-up, Hem-Tek, בית-שמש) is part of a name.
 */
function homeWordsOf(lang: string) {
  const base = lang.trim().toLowerCase().split("-")[0];
  const key = base === "fil" ? "tl" : HOME_WORDS[base] ? base : "";
  let found = homeWords.get(key);
  if (!found) {
    const words = ["home", ...(HOME_WORDS[key] ?? [])].sort((a, b) => b.length - a.length);
    found = { starts: new RegExp(`^(${words.join("|")})(?:\\s*[·|:｜・]|\\s+[-–—])`, "iu"), generic: new Set([...GENERIC_TITLES, ...words]) };
    homeWords.set(key, found);
  }
  return found;
}
const LANG_CODE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;
const RTL = new Set(["ar", "he", "fa", "ur", "ps", "yi"]);
const ALPHABET_OF: Record<string, Alphabet> = {};
for (const [alphabet, codes] of [
  ["arabic", "ar fa ur ps"],
  ["hebrew", "he yi"],
  ["cyrillic", "ru uk bg mk be kk ky tg mn"],
  ["greek", "el"],
  ["devanagari", "hi mr ne"],
  ["bengali", "bn"],
  ["thai", "th"],
  ["hangul", "ko"],
  ["cjk", "zh ja"],
  [
    "latin",
    "en es fr de it pt nl sv no nb nn da fi is et lv lt pl cs sk sl hr bs ro hu sq tr az uz id ms tl fil sw ht ca eu gl ga cy mt vi af zu xh yo ig ha so om rw mg sm to mi la eo lb fo qu",
  ],
] as const) {
  for (const code of codes.split(" ")) ALPHABET_OF[code] = alphabet;
}

// A script subtag (BCP 47), which says the alphabet the text is in: ur-Latn, sr-Cyrl, zh-Hant.
const SCRIPT_SUBTAG = /^[a-z]{2,3}-(latn|arab|hebr|cyrl|grek|deva|beng|thai|hang|kore|hans|hant|jpan)\b/i;
const SCRIPT_OF: Record<string, Alphabet> = {
  latn: "latin", arab: "arabic", hebr: "hebrew", cyrl: "cyrillic", grek: "greek", deva: "devanagari", beng: "bengali", thai: "thai",
  hang: "hangul", kore: "hangul", hans: "cjk", hant: "cjk", jpan: "cjk",
};
// The subtag for text in an alphabet that isn't its language's usual one (Korean and Chinese have several).
const SUBTAG_OF: Partial<Record<Alphabet, string>> = {
  latin: "Latn", arabic: "Arab", hebrew: "Hebr", cyrillic: "Cyrl", greek: "Grek", devanagari: "Deva", bengali: "Beng", thai: "Thai",
};
// An alphabet's name in the builder's instructions.
const ALPHABET_NAME: Record<Alphabet, string> = {
  latin: "Latin letters", arabic: "the Arabic alphabet", hebrew: "the Hebrew alphabet", cyrillic: "Cyrillic", greek: "the Greek alphabet",
  devanagari: "Devanagari", bengali: "the Bengali alphabet", thai: "the Thai alphabet", hangul: "Hangul", cjk: "Chinese or Japanese characters",
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

/** The domain an app's address shows: the one without www., else the first (as its share card does). */
export const preferredDomain = (domains: string[]) => domains.find((d) => !d.startsWith("www.")) ?? domains[0] ?? "";

/** The app's domains that show it: those Flash last saw pointing at it (see SeoContext). */
export const liveOf = (ctx: Pick<SeoContext, "domains" | "live">) => ctx.live ?? ctx.domains;

/**
 * The domain Check with Google tests the app on: one that shows the app, else one still waiting for
 * its DNS (Google is then told it isn't connected yet, which looks again). "" without a domain.
 */
export const testDomain = (ctx: Pick<SeoContext, "domains" | "live">) => preferredDomain(liveOf(ctx)) || preferredDomain(ctx.domains);

/**
 * The address a page served on domain names as its main one (canonical, and the sitemap's): the
 * domain itself, except www.X when X shows the same app too (live: the app's domains Flash last saw
 * pointing at it), which names X, so the two copies don't compete. Any other domain names itself, as
 * it may lapse or be sold on its own, and so does www.X while X still leads somewhere else.
 */
export const mainDomain = (domain: string, live: string[]) => (domain.startsWith("www.") && live.includes(domain.slice(4)) ? domain.slice(4) : domain);

/** What the page's facts mean, check by check, with the score. */
export function evaluate(facts: SeoFacts | null | undefined, ctx: SeoContext): SeoReport {
  if (!facts || facts.error) return { score: null, passed: 0, total: 0, checks: [] };
  const checks: Check[] = [];
  const add = (
    id: CheckId,
    weight: Check["weight"],
    status: Status,
    problem: string,
    values: Check["values"] = {},
    fix: string | null = null,
    action: Action = fix ? "fix" : null,
  ) => checks.push({ id, weight, status, problem, values, fix, action });
  const { imgs, links } = facts;

  // 1. The title, and the one a script gives the home page as it loads, which Google shows instead.
  const title = facts.titles[0]?.trim() ?? "";
  const width = facts.titleWidth;
  const home = homeWordsOf(facts.lang ?? "");
  const router = facts.routerTitle ?? "";
  const routerHome = router && (home.starts.exec(router)?.[1] ?? (home.generic.has(fold(router)) ? router.trim() : ""));
  const homeWord = home.starts.exec(title)?.[1];
  if (!facts.titleCount || !title) {
    add("title", 3, "fail", "none", {}, "Add a <title> inside <head>: the site's name plus what it offers, at most 60 characters.");
  } else if (facts.titleCount > 1) {
    add("title", 3, "fail", "several", { count: facts.titleCount, tag: "<title>" }, `The page has ${facts.titleCount} <title> elements outside SVG icons. Keep one, inside <head>.`);
  } else if (home.generic.has(fold(title))) {
    add(
      "title",
      3,
      "fail",
      "generic",
      { title },
      fixText(
        `The <title> is "${sample(title)}", which says nothing about the site. Make it the site's name plus what it offers, at most 60 characters,`,
        "and give the home page the same kind of title wherever the script sets document.title.",
      ),
    );
  } else if (routerHome) {
    // The <title> it keeps then is the one Google shows: when that has a problem of its own, it's fixed in the same go.
    const ownFix = homeWord
      ? `Also change the <title> ("${sample(title)}") to "<site name> · <what it offers>", at most 60 characters.`
      : width > 60
        ? `Also cut the <title> ("${sample(title)}", ${width} characters) to at most 60, keeping the name and offer.`
        : width < 20
          ? `Also make the <title> ("${sample(title)}") the site's name plus what it offers, 20 to 60 characters.`
          : `Keep the <title> as it is: "${sample(title)}".`;
    add(
      "title",
      3,
      "warn",
      "router",
      { title: router, word: routerHome },
      fixText(
        `As the page loads, its script sets document.title to "${sample(router)}" for the home page, which Google shows.`,
        `Make the router keep the page's own <title> there (saved in a variable as the script starts), setting "<Page> · <site name>" only on other pages.`,
        ownFix,
      ),
    );
  } else if (homeWord) {
    add(
      "title",
      3,
      "warn",
      "home",
      { title, word: homeWord },
      fixText(
        `The title starts with "${homeWord}" ("${sample(title)}"). Make the home page's title "<site name> · <what it offers>", at most 60 characters,`,
        `in <title> and wherever the script sets document.title for the home page. Keep "<Page> · <site name>" for the other pages.`,
      ),
    );
  } else if (width > 60) {
    add("title", 3, "warn", "long", { count: width, title, max: 60 }, fixText(`The <title> is ${width} characters: "${sample(title)}". Shorten it to at most 60, keeping the name and the main thing the site offers.`));
  } else if (width < 20) {
    add("title", 3, "warn", "short", { title }, fixText(`The <title> "${sample(title)}" is too short to say what the site is. Make it the site's name plus what it offers, 20 to 60 characters.`));
  } else add("title", 3, "pass", "pass", { title, count: width });

  // 2. The description.
  const description = facts.descriptions[0]?.trim() ?? "";
  const dWidth = facts.descriptionWidth;
  const describe = "one or two sentences, 70 to 160 characters, saying what the site offers and for whom";
  if (!facts.descriptionCount || !description) {
    add("description", 3, "fail", "none", {}, `Add <meta name="description" content="…"> inside <head>: ${describe}.`);
  } else if (facts.descriptionCount > 1) {
    add("description", 3, "fail", "several", { count: facts.descriptionCount, tag: '<meta name="description">' }, `The page has ${facts.descriptionCount} description meta tags. Keep one, 70 to 160 characters.`);
  } else if (title && (fold(description) === fold(title) || fold(description) === fold(title.replace(home.starts, "")))) {
    add("description", 3, "warn", "same", {}, `The meta description repeats the title. Rewrite it as ${describe}.`);
  } else if (dWidth > 160) {
    add("description", 3, "warn", "long", { count: dWidth, max: 160 }, `The meta description is ${dWidth} characters. Shorten it to at most 160, keeping the main point first.`);
  } else if (dWidth < 70) {
    add("description", 3, "warn", "short", { count: dWidth, text: description, min: 70, max: 160 }, fixText(`The meta description is ${dWidth} characters ("${sample(description)}"). Rewrite it to 70 to 160 characters, saying what the site offers and for whom.`));
  } else add("description", 3, "pass", "pass", { text: description });

  // 3. Whether the page lets Google list it.
  const robots = facts.robots.join(", ");
  const removeRobots = fixText(`Remove the <meta name="robots"> (or googlebot) tag that says "${sample(robots)}" from <head>.`);
  if (facts.noindex) add("indexing", 3, "fail", "noindex", { value: robots }, removeRobots);
  else if (facts.nofollow) add("indexing", 3, "warn", "nofollow", { value: robots }, removeRobots);
  else add("indexing", 3, "pass", "pass");

  // 4. The main address. Flash names it when the page doesn't (serve-site.ts).
  const flashUrl = `${ctx.appBase}/p/${ctx.slug}`;
  const removeCanonical = "Remove every <link rel=\"canonical\"> from the page. Flash adds the right one when it serves the page.";
  const live = liveOf(ctx);
  if (!facts.ownCanonical || !facts.canonicals.length) {
    // On its own domain too, the app is two pages to Google, each naming itself (see mainDomain).
    if (live.length) add("canonical", 2, "flash", "domains", { url: flashUrl, domain: `https://${preferredDomain(live)}/` });
    else add("canonical", 2, "flash", "flash", { url: flashUrl });
  }
  else if (facts.canonicalCount > 1) add("canonical", 2, "fail", "several", { count: facts.canonicalCount, tag: '<link rel="canonical">' }, removeCanonical);
  else {
    const url = facts.canonicals[0];
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {}
    if (!parsed || parsed.protocol !== "https:") add("canonical", 2, "fail", "invalid", { url }, removeCanonical);
    else {
      const path = parsed.pathname.replace(/\/$/, "");
      // Flash's own address exactly, as Flash names it: not another deployment (any *.vercel.app) or localhost.
      const onFlash = parsed.hostname === hostOf(ctx.appBase) && path === `/p/${ctx.slug}`;
      const onDomain = ctx.domains.includes(parsed.hostname) && path === "";
      if (onFlash || onDomain) add("canonical", 2, "pass", "pass", { url });
      else add("canonical", 2, "fail", "elsewhere", { url }, removeCanonical);
    }
  }

  // 5. Sitemaps: never scored. Flash's own sitemap lists only Flash's pages; a domain has its own.
  const domain = preferredDomain(live);
  if (facts.noindex) add("sitemap", 0, "na", "noindex");
  else if (domain) add("sitemap", 0, "flash", "domain", { url: `https://${domain}/sitemap.xml` });
  else add("sitemap", 0, "na", "flash");

  // 6. Structured data.
  const ld = facts.ldjson;
  if (!ld.total) {
    add(
      "structured",
      0,
      "tip",
      "none",
      {},
      fixText(
        `Add one <script type="application/ld+json"> inside <head> with schema.org data for what this site is (for a business, LocalBusiness or a more specific type, with its name, url, address, phone and opening hours).`,
        "Use only facts the page already shows; leave out anything missing or still a placeholder like [Address].",
      ),
    );
  } else if (ld.bad) {
    add("structured", 2, "fail", "bad", { count: ld.bad, total: ld.total }, `Fix the JSON inside each <script type="application/ld+json"> so it parses (double quotes, no trailing commas, no comments), keeping the same facts.`);
  } else if (ld.noContext || ld.noType) {
    add("structured", 2, "warn", "incomplete", {}, `In each <script type="application/ld+json">, set "@context": "https://schema.org" and an "@type" for what it describes, keeping the same facts.`);
  } else add("structured", 2, "pass", "pass", { types: ld.types.join(", ") });

  // 7. The language, and the alphabet it says the text is in: the language's own, or the one its
  // script subtag names (Roman Urdu is ur-Latn, Hinglish hi-Latn, Serbian in Latin letters sr-Latn).
  const lang = facts.lang?.trim() ?? "";
  const base = lang.toLowerCase().split("-")[0];
  const subtag = SCRIPT_SUBTAG.exec(lang)?.[1].toLowerCase();
  const expected = subtag ? SCRIPT_OF[subtag] : ALPHABET_OF[base];
  const main = facts.script.main;
  if (!lang) add("language", 2, "fail", "none", {}, 'Add a lang attribute to the <html> tag with the language the text is written in (like lang="es").');
  else if (!LANG_CODE.test(lang)) {
    add("language", 2, "fail", "invalid", { lang }, fixText(`The <html> tag has lang="${sample(lang)}", which isn't a valid code. Change it to the code of the language the text is written in (like "en", "es" or "pt-BR").`));
  } else if (expected && main && main !== expected) {
    const written = SUBTAG_OF[main];
    add(
      "language",
      2,
      "warn",
      "mismatch",
      { lang },
      fixText(
        `The <html> tag has lang="${sample(lang)}", but the text is mostly written in ${ALPHABET_NAME[main]}, not ${ALPHABET_NAME[expected]}.`,
        subtag || !written
          ? "Change lang to the code of the language (and script, when it isn't the language's usual one) the text is written in."
          : `If the text is in that language, written in ${ALPHABET_NAME[main]}, add the script: lang="${base}-${written}". Otherwise change lang to the code of the language the text is written in.`,
      ),
    );
  } else add("language", 2, "pass", "pass", { lang });

  // 8 and 9. Headings, read only where the page's code shows them.
  if (!facts.jsBuilt) {
    const keepLook = "keeping the look with CSS";
    if (!facts.pages.length) {
      const total = Object.values(facts.h1s).reduce((a, b) => a + b, 0);
      if (!total) add("h1", 2, "fail", "none", {}, `The page has no <h1>. Make its main title an <h1> (only one), ${keepLook}.`);
      else if (total > 1) {
        add("h1", 2, "warn", "several", { count: total, samples: quoted(facts.h1Texts, 3) }, fixText(`The page has ${total} <h1> elements (${quoted(facts.h1Texts, 3)}). Keep one as the main title and make the others <h2> or lower, keeping their look with CSS.`));
      } else add("h1", 2, "pass", "pass", { text: facts.h1Texts[0] ?? "" });
    } else {
      const outside = facts.h1s[""] ?? 0;
      const count = (page: string) => outside + (facts.h1s[page] ?? 0);
      const none = facts.pages.filter((p) => count(p) === 0);
      const many = facts.pages.filter((p) => count(p) > 1);
      const noneFix = none.length && `These pages (sections with data-page) have no <h1>: ${samples(none, 8)}. Give each page one <h1> as its main title, ${keepLook}.`;
      const manyFix =
        many.length && `These pages have more than one <h1> (counting any outside the page sections, like in the header): ${samples(many, 8)}. Keep one per page; make the rest <h2> or lower, ${keepLook}.`;
      if (none.length) add("h1", 2, "fail", "pages", { pages: samples(none, 8) }, fixText(noneFix, manyFix));
      else if (many.length) add("h1", 2, "warn", "pagesSeveral", { pages: samples(many, 8) }, fixText(manyFix));
      else add("h1", 2, "pass", "pass", { text: facts.h1Texts[0] ?? "" });
    }
    if (facts.headingCount) {
      let skip: { from: number; to: number; text: string } | null = null;
      for (const page of facts.pages.length ? facts.pages : [null]) {
        let previous = 0;
        for (const [level, text, at] of facts.headings) {
          if (page !== null && at !== "" && at !== page) continue;
          if (previous && level > previous + 1) {
            skip = { from: previous, to: level, text };
            break;
          }
          previous = level;
        }
        if (skip) break;
      }
      // Never "remove them": the page's script may fill one in, and would then break without it.
      const emptyFix = facts.emptyHeadings
        ? `These headings are empty in the page's code: ${samples(facts.emptyHeadingSamples, 3)}. Give each one the words it should show, unless the page's script already fills it in.`
        : "";
      if (skip) {
        const values = { from: `h${skip.from}`, to: `h${skip.to}`, text: skip.text };
        add("headings", 1, "warn", "skip", values, fixText(`A heading jumps from h${skip.from} to h${skip.to} at "${sample(skip.text)}". Change heading tags so levels go down one step at a time, ${keepLook}.`, emptyFix));
      } else if (facts.emptyHeadings) add("headings", 1, "warn", "empty", { count: facts.emptyHeadings }, emptyFix);
      else add("headings", 1, "pass", "pass");
    }
  }

  // 10. Picture descriptions.
  if (imgs.total) {
    const fileFix = imgs.fileAlt.length && `These alt texts are file names or single words: ${quoted(imgs.fileAlt)}. Replace each with a few words saying what the picture shows, in the page's language.`;
    if (imgs.noAlt) {
      add(
        "alt",
        2,
        "fail",
        "noAlt",
        { count: imgs.noAlt, total: imgs.total },
        fixText(
          `Add an alt attribute to every <img> that has none (${imgs.noAlt} of ${imgs.total}, like ${samples(imgs.noAltSamples, 3)}): a few words saying what it shows, in the page's language; alt="" only for decorative pictures. Pictures the script adds need alt too.`,
          fileFix,
        ),
      );
    } else if (imgs.fileAlt.length) add("alt", 2, "warn", "fileAlt", { count: imgs.fileAlt.length }, fixText(fileFix));
    else add("alt", 2, "pass", "pass", { total: imgs.total });
  }

  // 11 and 12. Links.
  if (!facts.jsBuilt && links.checked) {
    if (links.empty) {
      add(
        "linkText",
        2,
        "fail",
        "empty",
        { count: links.empty },
        fixText(`These links or buttons have no text or label: ${samples(links.emptySamples, 3)}. Give each a visible text, or an aria-label if it's an icon, saying what it does or where it goes.`),
      );
    } else if (links.vague) {
      add(
        "linkText",
        2,
        "warn",
        "vague",
        { text: links.vagueSamples[0] ?? "", count: links.vague },
        fixText(`Rewrite these link texts so each says where it goes (${quoted(links.vagueSamples)}), like "See the menu" instead of "Click here", keeping the design.`),
      );
    } else add("linkText", 2, "pass", "pass");
  }
  if (!facts.jsBuilt && links.inside) {
    const pagesFix = links.missingPages.length && `These links go to pages the site doesn't have: ${samples(links.missingPages, 8)}. Point each at a page that exists (#/name for a <section data-page="name">), or remove it.`;
    const outsideFix =
      links.outside.length &&
      `These links point at addresses that don't exist for this one-file site: ${samples(links.outside, 8)}. Change each to "#/name" for the right page ("#/" for home), or a full https:// address for another website, or remove it.`;
    const idsFix = links.missingIds.length && `These links go to ids no element has: ${samples(links.missingIds, 8)}. Add the matching id to the right element, or point the link somewhere that exists.`;
    const fix = fixText(pagesFix, outsideFix, idsFix);
    if (links.missingPages.length) add("links", 2, "fail", "missingPages", { links: samples(links.missingPages, 8) }, fix);
    else if (links.outside.length) add("links", 2, "fail", "outside", { links: samples(links.outside, 8) }, fix);
    else if (links.missingIds.length) add("links", 2, "warn", "missingIds", { links: samples(links.missingIds, 8) }, fix);
    else add("links", 2, "pass", "pass", { count: links.inside });
  }

  // 13. Blanks the builder left for the owner: only they know what goes there. Those only in its
  // scripts, while the lists it reads have entries, are in sample entries shown only while a list is empty.
  const blanks = [...facts.placeholders, ...facts.scriptPlaceholders];
  const shown = ctx.listsFilled ? facts.placeholders : blanks;
  if (shown.length) add("placeholders", 2, "fail", "found", { list: shown.join(", ") }, null, "tell");
  else if (blanks.length) add("placeholders", 0, "tip", "samples", { list: blanks.join(", ") });
  else add("placeholders", 2, "pass", "pass");

  // 14 and 15. The share card. Flash adds one when the page has none (serve-site.ts).
  if (!facts.ownCard) {
    add("card", 1, "flash", "flash");
    if (!facts.photo) add("photo", 0, "tip", "tip", {}, null, "preview");
  } else {
    const og = facts.og;
    const missing = (["og:title", "og:description", "og:image"] as const).filter((k) => !og[k.slice(3) as "title" | "description" | "image"]);
    if (missing.length) {
      add(
        "card",
        1,
        "warn",
        "missing",
        { tags: missing.join(", ") },
        `The page has its own Open Graph tags but is missing ${missing.join(", ")}. Add them inside <head> from the page's own title, description and a picture already in it (og:image a full https:// address), or remove all og: and twitter: tags so Flash adds them.`,
      );
    } else if (!/^https:\/\//i.test(og.image ?? "")) {
      add("card", 1, "warn", "image", { url: og.image ?? "" }, fixText(`og:image is "${sample(og.image ?? "")}". Use the full https:// address of a picture already in the page.`));
    } else if (!og.twitterCard) add("card", 1, "warn", "twitter", {}, 'Add <meta name="twitter:card" content="summary_large_image"> inside <head>.');
    else add("card", 1, "pass", "pass");
  }

  // 16 to 19. Phones.
  const viewport = facts.viewport?.trim() ?? "";
  const flat = viewport.toLowerCase().replace(/\s+/g, "");
  const maxScale = /maximum-scale=(\d{1,3}(?:\.\d{1,3})?)/.exec(flat);
  if (!viewport) add("viewport", 3, "fail", "none", {}, 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> inside <head>.');
  else if (/user-scalable=(?:no|0)\b/.test(flat) || (maxScale && Number(maxScale[1]) < 5)) {
    add("viewport", 3, "warn", "zoom", { value: viewport }, fixText(`In the viewport tag ("${sample(viewport)}"), remove user-scalable=no and any maximum-scale below 5.`));
  } else add("viewport", 3, "pass", "pass");
  if (facts.smallText.length) {
    add("textSize", 1, "warn", "small", { list: facts.smallText.join(", ") }, fixText(`Raise these font sizes to at least 12px (14px or more for body text), keeping the design otherwise: ${samples(facts.smallText)}.`));
  } else add("textSize", 1, "pass", "pass");
  if (facts.smallTargets.length) {
    add(
      "tapTargets",
      1,
      "warn",
      "small",
      { list: samples(facts.smallTargets, 3) },
      fixText(`Make these at least 24 by 24 pixels to tap (44 is better; padding counts), keeping their look: ${samples(facts.smallTargets, 3)}.`),
    );
  } else add("tapTargets", 0, "na", "none");
  // Right to left: text in Arabic or Hebrew letters, or a right-to-left language whose text the check
  // couldn't tell, unless lang names a left-to-right script for it (ur-Latn). Never a Latin page.
  const rtl = main ? main === "arabic" || main === "hebrew" : RTL.has(base) && (!subtag || subtag === "arab" || subtag === "hebr");
  if (rtl) {
    if (facts.dir === "rtl") add("direction", 1, "pass", "pass");
    else {
      add(
        "direction",
        1,
        "warn",
        "missing",
        { lang, tag: 'dir="rtl"' },
        fixText(`The page is ${main ? `written in ${ALPHABET_NAME[main]}` : `in ${sample(lang)}`}, which reads right to left. Add dir="rtl" to <html> and make the layout mirror (margin-inline and padding-inline instead of left and right where it matters).`),
      );
    }
  }

  // 20 to 25. Speed.
  const heavy = facts.bytes > 1024 * 1024 ? "fail" : facts.bytes > 300 * 1024 ? "warn" : "pass";
  if (heavy === "pass") add("weight", 2, "pass", "pass", { size: facts.bytes });
  else if (imgs.dataBytes > facts.bytes / 2) add("weight", 2, heavy, "pictures", { size: imgs.dataBytes });
  else add("weight", 2, heavy, "heavy", { size: facts.bytes }, "Make the page's HTML lighter without changing how it looks or works: remove unused CSS and code, repeated blocks and comments.");
  if (facts.blocking.length) {
    add(
      "blocking",
      2,
      "warn",
      "found",
      { list: samples(facts.blocking, 3) },
      fixText(
        `These <script src> tags in <head> stop the page showing until they load: ${samples(facts.blocking, 3)}.`,
        "Add defer to each (keeping their order), or move them in order to just before </body> together with any inline script that uses them, so nothing runs before what it needs. Leave Tailwind's Play CDN (https://cdn.tailwindcss.com, or @tailwindcss/browser from jsDelivr or unpkg) as it is.",
      ),
    );
  } else add("blocking", 2, "pass", "pass");
  if (imgs.total) {
    const sizeFix = imgs.noSize && "Give every <img> without a set size width and height attributes matching its shape (or a CSS aspect-ratio), keeping how it looks.";
    const lazyFix = imgs.total > 3 && !imgs.lazy && 'Add loading="lazy" to every <img> except the first one or two near the top of the page.';
    const fix = sizeFix || lazyFix ? fixText(sizeFix, lazyFix) : null;
    if (imgs.noSize) add("images", 1, "warn", "noSize", { count: imgs.noSize, total: imgs.total }, fix);
    else if (lazyFix) add("images", 1, "warn", "lazy", { total: imgs.total }, fix);
    else if (imgs.bigData) add("images", 1, "warn", "big", { count: imgs.bigData });
    else add("images", 1, "pass", "pass");
  }
  if (imgs.external) add("imageFiles", 0, "na", "external");
  if (facts.fonts.links) {
    if (facts.fonts.noSwap.length) {
      add("fonts", 1, "warn", "noSwap", { count: facts.fonts.noSwap.length }, fixText(`Add display=swap to the Google Fonts address(es) (${samples(facts.fonts.noSwap, 2)}).`));
    } else add("fonts", 1, "pass", "pass");
  }
  if (facts.mixed.length) {
    add("mixed", 2, "fail", "found", { list: samples(facts.mixed, 3) }, fixText(`Change these http:// addresses to https:// (or remove what doesn't work over https): ${samples(facts.mixed, 4)}.`));
  } else add("mixed", 2, "pass", "pass");
  if (!facts.doctype) add("doctype", 1, "fail", "none", { tag: "<!doctype html>" }, "Add <!doctype html> as the very first line.");
  else add("doctype", 1, "pass", "pass");
  if (!facts.icon) {
    add("icon", 1, "warn", "none", {}, `Add a <link rel="icon"> inside <head>: a small SVG icon as a data: URL, in the site's accent colour, with its first letter or a fitting emoji.`);
  } else add("icon", 1, "pass", "pass");

  // What Flash does, what's good to know, and what wasn't counted.
  add("robots", 0, "flash", "flash");
  if (facts.pages.length >= 2) add("hashPages", 0, "tip", "tip", { page: `#/${facts.pages[1]}` });
  if (facts.jsBuilt) add("jsBuilt", 0, "na", "na");
  if (links.external) add("externalLinks", 0, "na", "na");
  // On a domain too, as Google may show Flash's copy of the page.
  if (facts.loadsData) add("loadsData", 0, "tip", "tip");

  const scored = checks.filter((c) => c.status === "pass" || c.status === "warn" || c.status === "fail");
  const possible = scored.reduce((sum, c) => sum + c.weight, 0);
  const earned = scored.reduce((sum, c) => sum + c.weight * (c.status === "pass" ? 1 : c.status === "warn" ? 0.5 : 0), 0);
  return {
    score: possible ? Math.round((100 * earned) / possible) : null,
    passed: scored.filter((c) => c.status === "pass").length,
    total: scored.length,
    checks: ordered(checks),
  };
}

const RANK: Record<Status, number> = { fail: 0, warn: 1, tip: 2, flash: 3, pass: 4, na: 5 };

/** Problems first, then what could be better, each by weight, then everything else in the list's order. */
function ordered(checks: Check[]): Check[] {
  const at = (id: CheckId) => CHECK_ORDER.indexOf(id);
  return [...checks].sort((a, b) => {
    const issue = (c: Check) => c.status === "fail" || c.status === "warn";
    if (issue(a) && issue(b)) return RANK[a.status] - RANK[b.status] || b.weight - a.weight || at(a.id) - at(b.id);
    if (issue(a) !== issue(b)) return issue(a) ? -1 : 1;
    return RANK[a.status] - RANK[b.status] || at(a.id) - at(b.id);
  });
}

// The score's band (90 and up good, under 50 poor), kept on its own for the list of apps.
export { band } from "./seo-band.ts";

/** How many things there are to fix or improve (placeholders included). */
export const issueCount = (report: SeoReport) => report.checks.filter((c) => c.status === "fail" || c.status === "warn").length;

/** The checks Fix all sends: problems and what could be better that the builder can change, in the list's order. */
export const fixableIds = (report: SeoReport): CheckId[] =>
  report.checks.filter((c) => (c.status === "fail" || c.status === "warn") && c.action === "fix" && c.fix).map((c) => c.id);

/**
 * Which of ids the builder can still change on this version of the page, in the order asked: a
 * problem, something that could be better, or the details for Google (structured data) the owner
 * asked to add. What a newer version already fixed drops out, so nothing is asked twice.
 */
export const stillToFix = (report: SeoReport, ids: CheckId[]): CheckId[] =>
  ids.filter((id) =>
    report.checks.some(
      (c) => c.id === id && c.action === "fix" && !!c.fix && (c.status === "fail" || c.status === "warn" || (c.status === "tip" && c.id === "structured")),
    ),
  );

/**
 * The instruction a fix sends the builder, in English: what the check found and what to change,
 * for each of ids that still has a fix, in the list's order, as many as fit in MAX_CONTEXT. sent
 * is what went in; left how many asked for didn't fit.
 */
export function fixContext(report: SeoReport, ids: CheckId[], site: { title: string; address: string }): { context: string; sent: CheckId[]; left: number } {
  const title = site.title.length > 80 ? `${site.title.slice(0, 79)}…` : site.title;
  const address = site.address.slice(0, 160);
  let context =
    `These points come from Flash's search check (SEO) of the published site "${title}" (${address}). ` +
    "Change only what each point asks; keep the design, wording, data and behaviour the same, and send flash-edit pieces when the changes are small. " +
    "Never invent facts (addresses, phone numbers, prices, opening hours, reviews): use only what the page already says, and leave anything unknown out.";
  const wanted = report.checks.filter((c) => ids.includes(c.id) && c.action === "fix" && c.fix);
  const sent: CheckId[] = [];
  for (const check of wanted) {
    const line = `\n${sent.length + 1}. ${check.fix}`;
    if (context.length + line.length > MAX_CONTEXT) break;
    context += line;
    sent.push(check.id);
  }
  return { context, sent, left: wanted.length - sent.length };
}
