/*
 * Translate my app: an app built with Flash shown in other languages, with one page kept. Flash reads
 * the words a visitor sees in the published page (its text, the words in a few attributes, and the
 * words its scripts put on the page), the translator writes each once per language, and the page is
 * served in the visitor's language: its own HTML with the words swapped, and a small script that
 * swaps the words the app's code shows later, with a language button. The app's code is never
 * changed, so nothing it does breaks, and a change to the app only translates the words that are new.
 *
 * Everything here is read without a parser library: the page is cut into text, tags and the insides
 * of scripts and styles by indexOf, and each regex only reads a bounded stretch at a time.
 */
import { callMaxCents, claudePrice, creditsFor } from "./credits.ts";
import type { SiteLanguage } from "./site-languages.ts";

// What one site may send to be translated, so a hold stays within what anyone would pay for a website.
export const MAX_PHRASES = 3000;
export const MAX_PHRASE_CHARS = 120_000;
// Phrases longer than this are paragraphs of code or data, not words on a page.
const MAX_PHRASE = 600;
// What one call translates at most, so each is quick and they run side by side.
export const CHUNK_PHRASES = 120;
export const CHUNK_CHARS = 6000;
export const TRANSLATE_MODEL = "claude-sonnet-5-5";
// The system prompt and title each call reads besides the phrases (it is shorter than this).
const PROMPT_CHARS = 1400;

/** The visitor's choice of language rides in the page's address as ?lang=…, so a link opens in it. */
export const LANG_PARAM = "lang";

/** A phrase as a key: its words with runs of white space as one space, as the browser shows them. */
export const phraseKey = (text: string) => text.replace(/\s+/g, " ").trim();

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", reg: "®", trade: "™", hellip: "…",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", bull: "•",
  middot: "·", euro: "€", pound: "£", yen: "¥", cent: "¢", times: "×", deg: "°", eacute: "é", egrave: "è",
  agrave: "à", ccedil: "ç", ocirc: "ô", uuml: "ü", ouml: "ö", auml: "ä", szlig: "ß", ntilde: "ñ", rarr: "→", larr: "←",
};

/** The text a run of HTML shows: its character references read. One Flash doesn't know stays as written. */
export function decodeHtml(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (all, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : all;
    }
    return Object.hasOwn(NAMED, ref.toLowerCase()) ? NAMED[ref.toLowerCase()] : all;
  });
}

const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (text: string) => escapeText(text).replace(/"/g, "&quot;");

type Part = { kind: "text" | "tag" | "raw" | "skip"; start: number; end: number; name?: string; closing?: boolean };

/** Where a tag that starts at lt ends (its >), with > inside quoted attribute values skipped. */
function tagEnd(html: string, lt: number): number {
  let quote = "";
  for (let i = lt + 1; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i;
  }
  return html.length - 1;
}

/**
 * The page cut into its runs of text, its tags, the insides of its scripts and styles (raw) and what is
 * neither (comments, the doctype: skip), in order. A < that starts no tag is text.
 */
export function partsOf(html: string): Part[] {
  const parts: Part[] = [];
  const lower = html.toLowerCase();
  let text = 0;
  let i = 0;
  const flush = (to: number) => {
    if (to > text) parts.push({ kind: "text", start: text, end: to });
  };
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      flush(lt);
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      parts.push({ kind: "skip", start: lt, end: i });
      text = i;
      continue;
    }
    const next = html[lt + 1] ?? "";
    if (!/[a-zA-Z/!?]/.test(next)) {
      i = lt + 1;
      continue;
    }
    flush(lt);
    const gt = tagEnd(html, lt);
    const m = /^<(\/?)([a-zA-Z][\w:-]*)/.exec(html.slice(lt, Math.min(gt + 1, lt + 64)));
    const name = m?.[2].toLowerCase();
    parts.push({ kind: name ? "tag" : "skip", start: lt, end: gt + 1, name, closing: m?.[1] === "/" });
    i = gt + 1;
    text = i;
    if (name && !m?.[1] && /^(script|style|textarea)$/.test(name) && html[gt - 1] !== "/") {
      let close = lower.indexOf(`</${name}`, i);
      if (close === -1) close = html.length;
      parts.push({ kind: name === "textarea" ? "skip" : "raw", start: i, end: close, name });
      i = close;
      text = i;
    }
  }
  flush(html.length);
  return parts;
}

type Attr = { name: string; value: string; start: number; end: number };

/** A tag's attributes, each with where it is in the tag. */
function attrsOf(tag: string): Attr[] {
  const out: Attr[] = [];
  const at = /^<\/?[a-zA-Z][\w:-]*/.exec(tag)?.[0].length ?? 1;
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  re.lastIndex = at;
  for (let m = re.exec(tag); m; m = re.exec(tag)) {
    out.push({ name: m[1].toLowerCase(), value: decodeHtml(m[2] ?? m[3] ?? m[4] ?? ""), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const WORD_ATTRS = new Set(["alt", "title", "placeholder", "aria-label"]);
const META_WORDS = /^(description|og:title|og:description|og:site_name|twitter:title|twitter:description)$/i;

/** The attributes of a tag whose words a visitor sees (or a share card shows). */
function wordAttrs(name: string, attrs: Attr[]): Attr[] {
  const get = (n: string) => attrs.find((a) => a.name === n)?.value ?? "";
  return attrs.filter((a) => {
    if (WORD_ATTRS.has(a.name)) return true;
    if (a.name === "value") return name === "input" && /^(submit|button|reset)$/i.test(get("type"));
    if (a.name === "content") return name === "meta" && META_WORDS.test(get("name") || get("property"));
    return false;
  });
}

// Tags whose insides are never translated: code shown on the page, and anything marked translate="no".
const KEEP_TAGS = new Set(["code", "pre", "kbd", "samp", "var"]);
const keeps = (name: string, attrs: Attr[]) =>
  KEEP_TAGS.has(name) ||
  attrs.some((a) => (a.name === "translate" && a.value.toLowerCase() === "no") || (a.name === "class" && /(^|\s)notranslate(\s|$)/.test(a.value)));

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** Whether a text is words a visitor reads: letters, in something other than code. */
export function isWords(text: string): boolean {
  const s = phraseKey(text);
  if (s.length < 2 || s.length > MAX_PHRASE || !/\p{L}/u.test(s)) return false;
  const letters = s.match(/\p{L}/gu)?.length ?? 0;
  return letters >= s.replace(/\s/g, "").length * 0.4;
}

/**
 * Whether a quoted text in a script reads as words shown to people, not code: a sentence, a few words
 * or a capitalised label ("Add to cart", "Home"), never a class list, a selector, an address, a key or
 * a CSS value. One read wrongly only costs a phrase translated for nothing: the script itself is never changed.
 */
export function looksLikeWords(raw: string): boolean {
  const s = phraseKey(raw);
  if (!isWords(s)) return false;
  if (/^(https?:|mailto:|tel:|data:|blob:|javascript:|[#./@])/i.test(s)) return false;
  if (/\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|mp4|webm|mp3|wav|pdf|woff2?)(\?|$)/i.test(s)) return false;
  if (/[{}<>;=\\]|=>|&&|\|\||\$\{|\bfunction\b|\breturn\b/.test(s)) return false;
  if (/\d(px|rem|em|vh|vw|ms|deg)\b|rgba?\(|hsla?\(|var\(--|calc\(|!important/i.test(s)) return false;
  const words = s.split(" ");
  if (words.length === 1) {
    // One word: a capitalised label, or a word in a script without capitals (Arabic, Chinese, Hindi…).
    return /^\p{Lu}[\p{Ll}'’]+[.!?:…]?$/u.test(s) || (/^[\p{L}\p{M}'’]+[.!?:…]?$/u.test(s) && !/[A-Za-z]/.test(s) && !/\p{Lu}|\p{Ll}/u.test(s));
  }
  // A class list or a value list: lower-case tokens, some with -, : or digits (flex items-center, px-4 py-2).
  if (words.every((w) => /^[a-z0-9:\-/[\].!%#_,]+$/.test(w)) && words.some((w) => /[-:\d_[\]/]/.test(w))) return false;
  return true;
}

/** Reads a quoted text the way the script does: its escapes undone. */
function unescapeJs(text: string): string {
  return text.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (all, e: string) => {
    if (e[0] === "u" && e.length > 1) {
      const code = parseInt(e[1] === "{" ? e.slice(2, -1) : e.slice(1), 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    if (e[0] === "x" && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    return e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "" : e;
  });
}

// A blank in a phrase the app's code fills in (`Only ${n} left`), as the translator keeps it: {0}, {1}…
const BLANK = "\u0000";
const withBlanks = (text: string) => {
  let n = 0;
  return text.replace(/\u0000+/g, () => `{${n++}}`);
};

/** The phrases a piece of a script holds: its quoted texts, its JSX text, and the words in any HTML it writes. */
function scriptPhrases(code: string, add: (text: string, strict: boolean) => void) {
  // Empty and one-letter quotes are matched too, so each quote mark pairs with its own: "b" never ends up opening the next string.
  const literal = /"((?:[^"\\\n]|\\.){0,2000})"|'((?:[^'\\\n]|\\.){0,2000})'|`((?:[^`\\]|\\[\s\S]){0,8000})`/g;
  for (let m = literal.exec(code); m; m = literal.exec(code)) {
    let text = m[3] !== undefined ? m[3].replace(/\$\{[^}]*\}/g, BLANK) : (m[1] ?? m[2]);
    text = unescapeJs(text);
    if (text.includes("<") && /<\/?[a-zA-Z]/.test(text)) htmlPhrases(text, add, true);
    else add(text, true);
  }
  // JSX: words between > and < (<h1>Fresh bread daily</h1>), the {…} in them being the code's blanks.
  const jsx = />([^<>]{2,600})</g;
  for (let m = jsx.exec(code); m; m = jsx.exec(code)) {
    const text = m[1].replace(/\$?\{[^{}]*\}/g, BLANK);
    if (!/&&|\|\||==|=>|;|\breturn\b|\(\)/.test(text)) add(decodeHtml(text), true);
  }
}

/** The phrases in a run of HTML: its text, the words in its attributes and, unless inScript, the words its scripts show. */
function htmlPhrases(html: string, add: (text: string, strict: boolean) => void, inScript = false) {
  const kept: string[] = [];
  // The type of the script whose inside comes next.
  let type = "";
  for (const p of partsOf(html)) {
    if (p.kind === "tag" && p.name) {
      const tag = html.slice(p.start, p.end);
      if (p.name === "script" && !p.closing) type = attrsOf(tag).find((a) => a.name === "type")?.value.toLowerCase() ?? "";
      if (p.closing) {
        if (kept.at(-1) === p.name) kept.pop();
        continue;
      }
      const attrs = attrsOf(tag);
      if (!kept.length) for (const a of wordAttrs(p.name, attrs)) add(a.value, inScript);
      if (keeps(p.name, attrs) && !VOID.has(p.name) && !tag.endsWith("/>")) kept.push(p.name);
    } else if (p.kind === "text" && !kept.length) {
      add(decodeHtml(html.slice(p.start, p.end)), false);
    } else if (p.kind === "raw" && p.name === "script" && !inScript) {
      // Data and JSON-LD aren't shown; text/babel (React with JSX) and modules are code like any other.
      if (!type || /javascript|module|babel|jsx/.test(type)) scriptPhrases(html.slice(p.start, p.end), add);
    }
  }
}

/**
 * Every phrase a visitor can see on the page, each once, in the order they come, up to what one site
 * may send. A phrase with blanks the app fills in ({0}) is kept with them.
 */
export function pagePhrases(html: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let chars = 0;
  htmlPhrases(html, (raw, strict) => {
    const key = withBlanks(phraseKey(raw));
    const words = key.replace(/\{\d+\}/g, " ");
    if (!(strict ? looksLikeWords(words) : isWords(words)) || seen.has(key)) return;
    if (out.length >= MAX_PHRASES || chars + key.length > MAX_PHRASE_CHARS) return;
    seen.add(key);
    out.push(key);
    chars += key.length;
  });
  return out;
}

/** The language a page says it is written in (<html lang="…">), or "". */
export function pageLanguage(html: string): string {
  for (const p of partsOf(html.slice(0, 20_000))) {
    if (p.kind === "tag" && p.name === "html" && !p.closing) return attrsOf(html.slice(p.start, p.end)).find((a) => a.name === "lang")?.value.trim() ?? "";
    if (p.kind === "tag" && p.name === "body") break;
  }
  return "";
}

export type Phrasebook = Readonly<Record<string, string>>;

/** A text with its phrase swapped for its translation, its white space kept; null when it has none. */
function swap(text: string, book: Phrasebook): string | null {
  const key = phraseKey(text);
  if (!key || !Object.hasOwn(book, key)) return null;
  const lead = /^\s*/.exec(text)![0];
  const trail = /\s*$/.exec(text)![0];
  return lead + book[key] + trail;
}

/**
 * The page in a language: its text and the words in its attributes swapped for their translations,
 * and lang (with dir for a right-to-left language) on its <html>. Its scripts aren't touched: what
 * they show is swapped in the browser (see translateScript).
 */
export function translatePage(html: string, book: Phrasebook, lang: Pick<SiteLanguage, "id" | "rtl">): string {
  let out = "";
  let at = 0;
  const kept: string[] = [];
  let sawHtml = false;
  for (const p of partsOf(html)) {
    if (p.kind === "tag" && p.name) {
      if (p.closing) {
        if (kept.at(-1) === p.name) kept.pop();
        continue;
      }
      const tag = html.slice(p.start, p.end);
      const attrs = attrsOf(tag);
      let changed = tag;
      const edits: { start: number; end: number; text: string }[] = [];
      if (!kept.length) {
        for (const a of wordAttrs(p.name, attrs)) {
          const swapped = swap(a.value, book);
          if (swapped !== null) edits.push({ start: a.start, end: a.end, text: `${a.name}="${escapeAttr(swapped)}"` });
        }
      }
      if (p.name === "html" && !sawHtml) {
        sawHtml = true;
        for (const a of attrs) if (a.name === "lang" || a.name === "dir") edits.push({ start: /\s/.test(tag[a.start - 1]) ? a.start - 1 : a.start, end: a.end, text: "" });
        const end = tag.endsWith("/>") ? tag.length - 2 : tag.length - 1;
        edits.push({ start: end, end, text: ` lang="${lang.id}"${lang.rtl ? ' dir="rtl"' : ""}` });
      }
      for (const e of edits.sort((a, b) => b.start - a.start)) changed = changed.slice(0, e.start) + e.text + changed.slice(e.end);
      if (keeps(p.name, attrs) && !VOID.has(p.name) && !tag.endsWith("/>")) kept.push(p.name);
      if (changed !== tag) {
        out += html.slice(at, p.start) + changed;
        at = p.end;
      }
    } else if (p.kind === "text" && !kept.length) {
      const swapped = swap(decodeHtml(html.slice(p.start, p.end)), book);
      if (swapped !== null) {
        out += html.slice(at, p.start) + escapeText(swapped);
        at = p.end;
      }
    }
  }
  return out + html.slice(at);
}

/** JSON that can sit inside a <script> without ending it. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export type LanguageChoice = { id: string; own: string };

/**
 * What goes in the head of a page shown with a language button: the phrases in the language shown
 * (book, empty for the page's own language), and a script that swaps the words the app's code puts
 * on the page as it does, and shows the button that opens the page in each of choices.
 */
export function translateScript(book: Phrasebook, shown: string, choices: readonly LanguageChoice[], label: string): string {
  return `<script>(function(){var D=${scriptJson(book)},L=${scriptJson(shown)},C=${scriptJson(choices)},T=${scriptJson(label)},P=${scriptJson(LANG_PARAM)};
var A=["alt","title","placeholder","aria-label"],set=new WeakMap(),has=Object.prototype.hasOwnProperty,any=false;for(var k in D){any=true;break}
function key(s){return s.replace(/\\s+/g," ").trim()}
function look(s){var k=key(s);if(!k)return null;if(has.call(D,k))return D[k];var n=[],t=k.replace(/\\d+(?:[.,]\\d+)*/g,function(d){n.push(d);return"{"+(n.length-1)+"}"});if(n.length&&has.call(D,t))return D[t].replace(/\\{(\\d+)\\}/g,function(a,i){return i<n.length?n[i]:a});return null}
function swap(s){var v=look(s);if(v==null)return null;return s.match(/^\\s*/)[0]+v+s.match(/\\s*$/)[0]}
function skip(e){return !e||/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|CODE|PRE|KBD|SAMP|VAR)$/.test(e.nodeName)||(e.closest&&e.closest('[translate="no"],.notranslate,[data-flash-lang]'))}
function text(n){if(skip(n.parentElement))return;var v=n.nodeValue;if(set.get(n)===v)return;var t=swap(v);if(t!=null&&t!==v){set.set(n,t);n.nodeValue=t}}
function attr(e,a){var v=e.getAttribute(a);if(!v)return;var m=set.get(e)||{};if(m[a]===v)return;var t=swap(v);if(t!=null&&t!==v){m[a]=t;set.set(e,m);e.setAttribute(a,t)}}
function el(e){if(skip(e))return;for(var i=0;i<A.length;i++)attr(e,A[i]);if(e.nodeName==="INPUT"&&/^(submit|button|reset)$/i.test(e.type))attr(e,"value")}
function walk(r){if(r.nodeType===3)return text(r);if(r.nodeType!==1)return;el(r);var w=document.createTreeWalker(r,5),n;while((n=w.nextNode()))n.nodeType===3?text(n):el(n)}
if(any){new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var m=ms[i];if(m.type==="characterData")text(m.target);else if(m.type==="attributes")el(m.target);else for(var j=0;j<m.addedNodes.length;j++)walk(m.addedNodes[j])}}).observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:A.concat("value")});
walk(document.documentElement);document.addEventListener("DOMContentLoaded",function(){walk(document.documentElement)})}
function button(){if(C.length<2||!document.body)return;var h=document.createElement("div");h.setAttribute("data-flash-lang","");h.setAttribute("translate","no");var s=h.attachShadow?h.attachShadow({mode:"closed"}):h;
s.innerHTML='<style>:host{all:initial}label{position:fixed;bottom:16px;inset-inline-start:16px;z-index:2147483646;display:flex;align-items:center;gap:6px;height:36px;padding:0 10px 0 12px;border-radius:999px;background:rgba(255,255,255,.96);color:#18181b;border:1px solid rgba(0,0,0,.08);box-shadow:0 6px 24px rgba(0,0,0,.14);font:500 13px/1 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;backdrop-filter:blur(8px)}@media (prefers-color-scheme:dark){label{background:rgba(24,24,27,.94);color:#f4f4f5;border-color:rgba(255,255,255,.1)}}select{appearance:none;-webkit-appearance:none;background:transparent;border:0;color:inherit;font:inherit;padding:0 14px 0 0;cursor:pointer;outline:none;max-width:40vw}select:focus-visible{text-decoration:underline}span.c{margin-inline-start:-12px;pointer-events:none;opacity:.6;font-size:10px}svg{flex:none}option{color:#18181b}</style><label><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/></svg><select></select><span class="c">\\u25BE</span></label>';
var sel=s.querySelector("select");sel.setAttribute("aria-label",T);for(var i=0;i<C.length;i++){var o=document.createElement("option");o.value=C[i].id;o.textContent=C[i].own;o.lang=C[i].id;if(C[i].id===L)o.selected=true;sel.appendChild(o)}
sel.addEventListener("change",function(){var u=new URL(location.href);u.searchParams.set(P,sel.value);location.href=u.href});document.body.appendChild(h)}
if(document.body)button();else document.addEventListener("DOMContentLoaded",button)})();</script>`;
}

/**
 * The language a visit is shown in: the one in the page's address when the app has it, else the first
 * of the browser's languages it has (or its own language, when the browser reads that first). null
 * shows the page as it was written.
 */
export function pickLanguage(param: string | null, browser: readonly string[], offered: readonly string[], source: string, of: (tag: string) => { id: string } | null): string | null {
  if (param) {
    const asked = of(param)?.id ?? param;
    if (asked === source) return null;
    if (offered.includes(asked)) return asked;
  }
  for (const tag of browser) {
    const id = of(tag)?.id;
    if (!id) continue;
    if (id === source) return null;
    if (offered.includes(id)) return id;
  }
  return null;
}

/** The phrases a language's book lacks, in the page's order. */
export const missingPhrases = (phrases: readonly string[], book: Phrasebook) => phrases.filter((p) => !Object.hasOwn(book, p));

/** Phrases cut into the calls that translate them, each within CHUNK_PHRASES and CHUNK_CHARS. */
export function chunksOf(phrases: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let chars = 0;
  for (const p of phrases) {
    if (cur.length && (cur.length >= CHUNK_PHRASES || chars + p.length > CHUNK_CHARS)) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(p);
    chars += p.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// Languages whose words take more tokens than English's: written in scripts other than Latin.
const DENSE = new Set(["ar", "he", "fa", "ur", "hi", "bn", "zh-Hans", "zh-Hant", "ja", "ko", "th", "ru", "uk", "el", "am"]);

/** The most a call may write for a chunk into a language: the translation of every phrase, with its number. */
export const chunkMaxTokens = (chunk: readonly string[], lang: string) =>
  Math.min(32_000, Math.ceil(chunk.reduce((n, p) => n + p.length, 0) * (DENSE.has(lang) ? 3 : 2)) + chunk.length * 6 + 200);

/** What a call for a chunk reads: the instructions, the title and each phrase with its number. */
const chunkInputChars = (chunk: readonly string[]) => PROMPT_CHARS + chunk.reduce((n, p) => n + p.length + 6, 0);

/** The most one chunk's call can cost, in cents. */
export const chunkMaxCents = (chunk: readonly string[], lang: string, model = TRANSLATE_MODEL) => callMaxCents(model, chunkInputChars(chunk), chunkMaxTokens(chunk, lang));

/**
 * What translating these phrases into a language is held at (most, the whole worst case, which is the
 * "Up to" the owner sees) and what it usually costs (typical): a token about every 3.5 characters read,
 * and translations about as long as the English, a little longer in dense scripts.
 */
export function translateCredits(phrases: readonly string[], lang: string, model = TRANSLATE_MODEL): { most: number; typical: number } {
  if (!phrases.length) return { most: 0, typical: 0 };
  const chunks = chunksOf(phrases);
  const most = creditsFor(chunks.reduce((n, c) => n + chunkMaxCents(c, lang, model), 0));
  const price = claudePrice(model);
  const cents = chunks.reduce((n, c) => {
    const chars = c.reduce((m, p) => m + p.length + 6, 0);
    const inTokens = (PROMPT_CHARS + chars) / 3.5;
    const outTokens = (chars / 3.5) * (DENSE.has(lang) ? 2 : 1.3);
    return n + (inTokens * price.input + outTokens * price.output) / 1e6;
  }, 0);
  return { most, typical: Math.min(most, creditsFor(cents)) };
}

/** The instructions for one call. */
export function translatorSystem(from: SiteLanguage | null, to: SiteLanguage, title: string): string {
  return [
    `You translate the words of a website${title ? ` called "${title.replace(/"/g, "'").slice(0, 120)}"` : ""} ${from ? `from ${from.name} ` : ""}into ${to.name}.`,
    "Each line of the message is a number, a tab, then one phrase from the page: a heading, a button, a menu item, a sentence or a label.",
    "Answer with one line for each phrase, in the same order: the same number, a tab, then its translation. Write nothing else.",
    "Translate the meaning naturally, as a professional website in that language would say it, keeping the tone. Keep short labels short.",
    "Keep blanks like {0} and {1} exactly as they are, where they belong in the translated sentence.",
    "Keep names of people, businesses, brands and products, email addresses, phone numbers, prices, web addresses and emoji as they are.",
    `A phrase that is already in ${to.name}, or is only a name or a number, comes back unchanged. Each translation stays on one line.`,
  ].join("\n");
}

/** The message for one call: each phrase on its own line, numbered from 1. */
export const translatorMessage = (chunk: readonly string[]) => chunk.map((p, i) => `${i + 1}\t${p}`).join("\n");

const blanksOf = (text: string) => (text.match(/\{\d+\}/g) ?? []).sort().join();

/**
 * The translations in a reply, by phrase: only lines that name one of the chunk's phrases and keep its
 * blanks. A reply cut short gives what it holds, and the rest is translated next time.
 */
export function readTranslations(reply: string, chunk: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of reply.split("\n")) {
    const m = /^\s*(\d+)\s*[\t.:)-]\s*(.*)$/.exec(line);
    if (!m) continue;
    const phrase = chunk[Number(m[1]) - 1];
    const text = phraseKey(m[2]);
    if (!phrase || !text || text.length > phrase.length * 6 + 40 || blanksOf(text) !== blanksOf(phrase)) continue;
    out[phrase] = text;
  }
  return out;
}
