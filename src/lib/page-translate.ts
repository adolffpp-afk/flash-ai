/*
 * Translate a website: any page on the web, by its link, shown translated (see
 * server/page-translations.ts). The copy Flash shows is the page's HTML with its words swapped (see
 * site-translate.ts) and its scripts taken out, read at its own address, so its pictures and styles
 * still load from the site. It is served with a sandbox that runs no scripts at all, so nothing on
 * the page can act as Flash or as the person reading it.
 */
import { attrsOf, decodeHtml, partsOf, phraseKey } from "./site-translate.ts";

/**
 * The page with no scripts and nothing that sends the reader elsewhere by itself: <script> with its
 * insides, <base> (Flash sets its own) and <meta http-equiv="refresh">. Inline handlers (onclick=…)
 * stay, as the sandbox never runs them.
 */
export function staticPage(html: string): string {
  let out = "";
  let at = 0;
  for (const p of partsOf(html)) {
    const drop =
      (p.kind === "raw" && p.name === "script") ||
      (p.kind === "tag" && (p.name === "script" || p.name === "base")) ||
      (p.kind === "tag" &&
        p.name === "meta" &&
        attrsOf(html.slice(p.start, p.end)).some((a) => a.name === "http-equiv" && a.value.trim().toLowerCase() === "refresh"));
    if (!drop) continue;
    out += html.slice(at, p.start);
    at = p.end;
  }
  return out + html.slice(at);
}

/** The page's title (its <title>), or "". */
export function pageTitle(html: string): string {
  const parts = partsOf(html.slice(0, 200_000));
  const i = parts.findIndex((p) => p.kind === "tag" && p.name === "title" && !p.closing);
  const text = i >= 0 ? parts[i + 1] : undefined;
  return text?.kind === "text" ? phraseKey(decodeHtml(html.slice(text.start, text.end))).slice(0, 200) : "";
}

const escapeAttr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The translated page ready to show: read at the original address (<base>, its links opening the
 * original site), with a bar on top saying it is Flash's translation of that page and linking to it.
 */
export function framedPage(html: string, url: string, bar: { said: string; original: string }): string {
  const head = `<base href="${escapeAttr(url)}" target="_blank">`;
  const top =
    `<div translate="no" style="all:initial;display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:10px 16px;background:#18181b;color:#f4f4f5;font:500 13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;position:relative;z-index:2147483647">` +
    `<span style="all:unset">${escapeText(bar.said)}</span>` +
    `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" style="all:unset;color:#a5b4fc;text-decoration:underline;cursor:pointer">${escapeText(bar.original)}</a></div>`;
  const parts = partsOf(html);
  const headTag = parts.find((p) => p.kind === "tag" && p.name === "head" && !p.closing);
  const bodyTag = parts.find((p) => p.kind === "tag" && p.name === "body" && !p.closing);
  // The base first in the head, and the bar first in the body (right after the head, or at the start,
  // for a page with neither), placed from the end so each place is where it was read.
  const at = headTag?.end ?? 0;
  const edits = [
    { at, text: head },
    { at: bodyTag?.end ?? at, text: top },
  ].sort((a, b) => b.at - a.at);
  let page = html;
  for (const e of edits) page = page.slice(0, e.at) + e.text + page.slice(e.at);
  return page;
}
