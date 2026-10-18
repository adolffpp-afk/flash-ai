/*
 * Flash's search check (SEO) in the owner's words: each check's name, why it matters, and what it
 * found (see seo-rules.ts), marked msg("…") here and shown with t() where they're read. Text from the
 * page itself (a title, an address, a piece of code) fills the blanks as it's written.
 */
import { msg, type Translate } from "./i18n.ts";
import { fixContext, type Check, type CheckId, type SeoReport } from "./seo-rules.ts";

export const LABELS: Record<CheckId, string> = {
  title: msg("Page title"),
  description: msg("Page description"),
  indexing: msg("Listing on Google"),
  canonical: msg("Main address"),
  sitemap: msg("Sitemap"),
  structured: msg("Details for Google"),
  language: msg("Language"),
  h1: msg("Main heading"),
  headings: msg("Heading order"),
  alt: msg("Picture descriptions"),
  linkText: msg("Link words"),
  links: msg("Links inside your site"),
  placeholders: msg("Unfinished details"),
  card: msg("Share card"),
  photo: msg("Share picture"),
  viewport: msg("Phone layout"),
  textSize: msg("Text size"),
  tapTargets: msg("Buttons on phones"),
  direction: msg("Reading direction"),
  weight: msg("Page size"),
  blocking: msg("Scripts that hold up the page"),
  images: msg("Pictures"),
  imageFiles: msg("Picture files"),
  fonts: msg("Fonts"),
  mixed: msg("Secure loading"),
  doctype: msg("Doctype"),
  icon: msg("Icon"),
  // A file's name, the same in every language.
  robots: "robots.txt",
  hashPages: msg("Your site's pages"),
  jsBuilt: msg("Built by JavaScript"),
  externalLinks: msg("Links to other websites"),
  loadsData: msg("Content from your app's data"),
};

/** A check's name in the owner's language (robots.txt stays as it is). */
export const labelOf = (t: Translate, id: CheckId) => (id === "robots" ? LABELS.robots : t(LABELS[id]));

/** Why each check that counts in the score matters, shown under what it found. */
export const WHY: Partial<Record<CheckId, string>> = {
  title: msg("The title is the headline people click in Google's results, and the name on the browser tab."),
  description: msg("Google often shows it under your title, and it's what people read before deciding to click."),
  indexing: msg("With noindex, the page never shows up on Google, whatever else you fix. Keep it only for a page you want kept off Google."),
  canonical: msg("Your app opens at more than one address. Naming the main one (canonical) stops the copies competing on Google."),
  structured: msg("Structured data tells Google facts in a form it reads for sure, like your opening hours or a product's price."),
  language: msg("It tells Google who to show your page to, and tells screen readers and translation tools how to read it."),
  h1: msg("The main heading tells Google and screen readers what the page is about."),
  headings: msg("Headings in order (h1, then h2, then h3) give your page an outline Google and screen readers follow."),
  alt: msg("Google can't see pictures. Alt text tells it, and people using screen readers, what each one shows, and helps them come up in Google Images."),
  linkText: msg("Google and screen readers go by a link's words. “Click here” tells them nothing about what's behind it."),
  links: msg("A link that leads nowhere is a dead end for visitors and for Google."),
  placeholders: msg("Text like [Phone number] tells visitors and Google the page isn't finished. Tell Flash your real details, then press Update site."),
  card: msg("It's what people see when your link is shared on WhatsApp, Facebook, X or iMessage."),
  viewport: msg("Google looks at the phone version of your page. Without this tag, phones show a shrunken desktop page."),
  textSize: msg("Text below 12px is hard to read on a phone without zooming."),
  tapTargets: msg("Small buttons close together make people tap the wrong one."),
  direction: msg("Without it, phones and browsers lay out right-to-left text from the wrong side."),
  weight: msg("Every visit downloads the whole page. A lighter page shows sooner on a phone, and speed is one of the things Google looks at."),
  blocking: msg("A script in the page's head stops the browser showing anything until it has downloaded and run."),
  images: msg("Pictures are most of what a page downloads. Pictures with a set size keep the page from jumping, which Google measures."),
  fonts: msg("Without display=swap, text stays blank until its font arrives."),
  mixed: msg("Your page is served over https, so browsers block scripts and styles from http:// addresses, and switch pictures to https or drop them."),
  doctype: msg("Without it, browsers fall back to a layout mode from the 1990s, and parts of the page can look broken."),
  icon: msg("The icon is how people spot your tab and bookmark. On your own domain, Google can show it next to your page in results."),
};

// The same words for a tag a page has more than once (<title>, its description, its main address).
const SEVERAL = msg("Your page has {count} {tag} tags. Keep one.");
const QUOTED = msg("“{text}”");

/** What each check found, by "id:problem". A check that passed with nothing more to say has none. */
const MESSAGES: Record<string, string> = {
  "title:none": msg("Your page has no title."),
  "title:several": SEVERAL,
  "title:generic": msg("Your page's title is just “{title}”, which doesn't say what you offer."),
  "title:home": msg("Your title starts with “{word}”, which tells Google nothing. Put your name and what you offer first."),
  "title:long": msg("Your title is {count} characters, so Google will cut it off. Keep it to about {max}."),
  "title:short": msg("Your title “{title}” is short. Say what you offer, and where if it matters."),
  "title:pass": msg("“{title}” ({count} characters)"),
  "description:none": msg("Your page has no description."),
  "description:several": SEVERAL,
  "description:same": msg("Your description just repeats the title."),
  "description:long": msg("Your description is {count} characters, so Google will cut it off. Keep it under {max}."),
  "description:short": msg("Your description is short ({count} characters). Aim for {min} to {max}."),
  "description:pass": QUOTED,
  "indexing:noindex": msg("Your page tells Google not to list it (noindex)."),
  "indexing:nofollow": msg("Your page tells Google not to follow its links (nofollow)."),
  "canonical:flash": msg("Flash names your page's main address (canonical) for Google wherever it's served, like {url}."),
  "canonical:domains": msg("Your page is served at {url} and at {domain}, and Flash names each one as its own main address (canonical). Google shows one of the two, and may pick Flash's."),
  "canonical:several": SEVERAL,
  "canonical:invalid": msg("Your page's main address (canonical) “{url}” isn't a full https:// address."),
  "canonical:elsewhere": msg("Your page tells Google its main address is {url}, which isn't this app, so Google may leave this page out."),
  // The value alone, after the check's name ("Main address · https://…"): nothing to translate.
  "canonical:pass": "{url}",
  "sitemap:noindex": msg("A page that tells Google not to list it stays out of sitemaps."),
  "sitemap:domain": msg("Your domain's sitemap.xml lists your app for Google: {url}."),
  "sitemap:flash": msg("Flash's sitemap lists only Flash's own pages, so Google finds your app through links to it. Your own domain gets a sitemap of its own."),
  "structured:none": msg("Your page has no details for Google (structured data). For a business, they can let Google show your opening hours, address and prices."),
  "structured:bad": msg("Google can't read some of your page's details for Google (structured data): the JSON has a mistake ({count} of {total})."),
  "structured:incomplete": msg("Your page's details for Google (structured data) don't say they use schema.org, or what they describe (@type)."),
  "structured:pass": msg("Your page describes itself to Google as: {types}."),
  "language:none": msg("Your page doesn't say what language it's in."),
  "language:invalid": msg("Your page's language code “{lang}” isn't a real one."),
  "language:mismatch": msg("Your page says it's in “{lang}”, but its text is written in another alphabet."),
  "language:pass": "{lang}",
  "h1:none": msg("Your page has no main heading (h1)."),
  "h1:pages": msg("Pages with no main heading (h1): {pages}."),
  "h1:several": msg("Your page has {count} main headings (h1). Keep one."),
  "h1:pagesSeveral": msg("Pages with more than one main heading (h1): {pages}."),
  "h1:pass": QUOTED,
  "headings:skip": msg("Your headings jump from {from} to {to} at “{text}”."),
  "headings:empty": msg("Headings with no text: {count}."),
  "alt:noAlt": msg("Pictures with no alt text: {count} of {total}."),
  "alt:fileAlt": msg("Alt texts that are only a file name or a word like “image”: {count}."),
  "alt:pass": msg("Every picture has alt text ({total})."),
  "linkText:empty": msg("Links and buttons with no words or label: {count}."),
  "linkText:vague": msg("Links that only say things like “{text}”: {count}."),
  "links:missingPages": msg("Links to pages your site doesn't have: {links}."),
  "links:outside": msg("Links that leave your app for an address that doesn't exist: {links}."),
  "links:missingIds": msg("Links to spots on the page that don't exist: {links}."),
  "links:pass": msg("Links inside your site all lead somewhere ({count})."),
  "placeholders:found": msg("Your page still shows placeholders: {list}."),
  "placeholders:samples": msg("Placeholders like {list} are only in your page's script, in sample entries it shows while a list is empty. Your lists have entries now, so visitors see those instead."),
  "card:flash": msg("Flash adds your share card: the title, description and picture people see when your link is shared."),
  "card:missing": msg("Your page sets its own share card, but it's missing {tags}."),
  "card:image": msg("Your share picture isn't a full https:// address, so apps can't show it."),
  "card:twitter": msg("Your page sets its own share card without twitter:card, so X shows a small one."),
  "photo:tip": msg("Your link shows a picture Flash draws from your title. A photo near the top of your page shows instead."),
  "viewport:none": msg("Your page isn't set up for phones (it has no viewport tag)."),
  "viewport:zoom": msg("Your page stops people from zooming in."),
  "textSize:small": msg("Text set smaller than 12px, hard to read on a phone: {list}."),
  "tapTargets:small": msg("Buttons or links set smaller than 24px, hard to tap: {list}."),
  "tapTargets:none": msg("Flash can only see sizes written in your page's code. Google's check below (Accessibility) measures every button on a phone screen."),
  // Code goes in a blank, so it's shown left to right in a right-to-left sentence.
  "direction:missing": msg("Your page is in a right-to-left language but doesn't say so ({tag})."),
  "weight:heavy": msg("Your page's code is {size}, heavy on mobile data."),
  "weight:pictures": msg("Pictures built into your page's code: {size}. Every visit downloads them all."),
  "weight:pass": msg("Your page's code is {size}."),
  "blocking:found": msg("Scripts that make the page wait before showing anything: {list}."),
  "images:noSize": msg("Pictures with no size set, so the page jumps as they load: {count} of {total}."),
  "images:lazy": msg("All {total} pictures load at once. The ones further down can wait until they're needed."),
  "images:big": msg("Pictures in your page's code that are bigger than needed: {count}."),
  "imageFiles:external": msg("Flash doesn't download pictures from other websites, so it can't see how big they are. Google's check below does."),
  "fonts:noSwap": msg("Fonts from Google Fonts that hide your text until they load (no display=swap): {count}."),
  "mixed:found": msg("Parts of your page load from insecure http:// addresses, which browsers block or switch to https: {list}."),
  "doctype:none": msg("Your page doesn't start with {tag}, so browsers show it in an old layout mode."),
  "icon:none": msg("Your page has no icon of its own, so browser tabs and bookmarks show Flash's icon or none."),
  "robots:flash": msg("Google may visit your app: robots.txt lets it in, on Flash's address and on your own domain if you connect one."),
  "hashPages:tip": msg("Your site's pages (like {page}) share one address, so Google lists your site as one page and finds it through the home page."),
  "jsBuilt:na": msg("Your page builds most of what it shows with JavaScript, so Flash could only check the parts written in its code. Google's check below looks at the finished page."),
  "externalLinks:na": msg("Flash doesn't open links to other websites, so it can't tell whether they work."),
  "loadsData:tip": msg(
    "Part of your page (what flashDB loads, and prices you set in Flash) appears only when it opens. On Flash's address Google can't fetch it, so Google sees the rest of the page, and any sample prices written in its code. On your own domain it can.",
  ),
};

/** Why a check matters, shown under what it found: nothing for blanks visitors don't see (sample entries). */
export const whyOf = (check: Pick<Check, "id" | "status">): string | undefined => (check.id === "placeholders" && check.status === "tip" ? undefined : WHY[check.id]);

/** What a check found, as its English phrase (translate it with t), or null when it passed with nothing more to say. */
export const messageOf = (check: Pick<Check, "id" | "problem">): string | null => MESSAGES[`${check.id}:${check.problem}`] ?? null;

/** A list in the owner's language: "A, B and C". */
export function listOf(items: string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);
  } catch {
    return items.join(", ");
  }
}

/**
 * The message a fix sends to the builder: content is what the owner sees in the chat, in their
 * language; context the English instructions the builder follows (see fixContext), shown as "◎ SEO".
 */
export function fixMessage(
  t: Translate & { locale?: string },
  report: SeoReport,
  ids: CheckId[],
  site: { title: string; address: string },
): { content: string; context: string; sent: CheckId[]; left: number } {
  const { context, sent, left } = fixContext(report, ids, site);
  const list = listOf(
    sent.map((id) => labelOf(t, id)),
    t.locale ?? "en-US",
  );
  return { content: t("Fix what Flash's search check found on my site: {list}.", { list }), context, sent, left };
}
