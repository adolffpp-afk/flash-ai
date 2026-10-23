/*
 * What an app's preview in Flash tells Flash: the errors it hits (for the Fix it button) and the
 * part of the page the user clicked while choosing what to change. Only the preview gets this
 * script; published apps never do.
 */
import { msg } from "./i18n.ts";

/** A message from the preview to Flash. */
export type PreviewMessage =
  | { flashPreview: true; type: "error"; message: string; line: number }
  | { flashPreview: true; type: "picked"; tag: string; text: string; path: string; html: string; label: string }
  | { flashPreview: true; type: "pick-cancelled" }
  | { flashPreview: true; type: "pages"; pages: PreviewPage[]; current: string }
  | { flashPreview: true; type: "text-edited"; before: string; after: string }
  | { flashPreview: true; type: "edit-cancelled" };

/** One of an app's pages (a <section data-page="id">), with the words its menu link uses for it. */
export type PreviewPage = { id: string; label: string };

export type PreviewError = { message: string; line: number };

/** A part of the app the user clicked in the preview, to say what to change about it. */
export type PickedElement = { tag: string; text: string; path: string; html: string; label: string };

/** The script at the top of the preview. Errors are sent at most 5 times per page load. */
export const PREVIEW_BRIDGE = `<script>(function () {
  function post(msg) { try { msg.flashPreview = true; parent.postMessage(msg, "*"); } catch (e) {} }
  var sent = 0;
  function report(message, line) {
    if (sent >= 5) return;
    sent++;
    post({ type: "error", message: String(message || "Error").slice(0, 400), line: line || 0 });
  }
  window.addEventListener("error", function (e) {
    var t = e.target;
    if (t && t !== window && t.tagName) {
      // A script or stylesheet that didn't load breaks the app; a missing picture doesn't.
      if (t.tagName === "SCRIPT" || (t.tagName === "LINK" && /stylesheet/i.test(t.rel || ""))) report("Couldn't load " + (t.src || t.href));
      return;
    }
    // Errors inside libraries from other sites come without details, so there's nothing to fix from them.
    if (e.message === "Script error." && !e.lineno) return;
    report(e.message, /srcdoc/.test(e.filename || "") ? e.lineno : 0);
  }, true);
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    report("Unhandled error: " + ((r && r.message) || String(r)));
  });

  var picking = false, box = null, hovered = null;
  function frame() {
    if (!box) {
      box = document.createElement("div");
      box.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #10b981;background:rgba(16,185,129,.12);border-radius:4px;display:none";
      document.documentElement.appendChild(box);
    }
    return box;
  }
  function outline(el) {
    var r = el.getBoundingClientRect(), b = frame();
    b.style.display = "block";
    b.style.left = r.left + "px"; b.style.top = r.top + "px";
    b.style.width = r.width + "px"; b.style.height = r.height + "px";
  }
  function pathOf(el) {
    var parts = [];
    for (var n = el; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement && parts.length < 5; n = n.parentElement) {
      var s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(s + "#" + n.id); break; }
      var cls = (typeof n.className === "string" ? n.className : "").trim().split(/\\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) s += "." + cls.join(".");
      parts.unshift(s);
    }
    return parts.join(" > ");
  }
  function labelOf(el, text) {
    var names = { a: "link", button: "button", img: "picture", h1: "heading", h2: "heading", h3: "heading", h4: "heading", p: "paragraph", nav: "menu", header: "header", footer: "footer", form: "form", input: "field", textarea: "field", select: "menu", ul: "list", ol: "list", li: "list item", table: "table", section: "section", svg: "icon", video: "video" };
    var tag = el.tagName.toLowerCase();
    var name = names[tag] || (tag === "div" || tag === "span" ? "part" : tag);
    var words = text || el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
    if (words.length > 40) words = words.slice(0, 40).trim() + "…";
    return words ? name + " \\u201c" + words + "\\u201d" : name;
  }
  function stop() {
    picking = false;
    hovered = null;
    if (box) box.style.display = "none";
    document.documentElement.style.cursor = "";
  }
  function swallow(e) { if (picking) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); } }
  window.addEventListener("mousemove", function (e) {
    if (!picking) return;
    var el = e.target;
    if (el && el.nodeType === 1 && el !== box && el !== document.documentElement && el !== document.body) { hovered = el; outline(el); }
  }, true);
  // While choosing, taps and clicks only pick: the app's own buttons and links don't react. Touches keep
  // their default, so a tap on a phone still becomes a click.
  ["pointerdown", "mousedown", "mouseup", "pointerup", "touchstart", "touchend", "submit"].forEach(function (type) {
    window.addEventListener(type, function (e) { if (picking) { e.stopPropagation(); e.stopImmediatePropagation(); if (type.indexOf("touch") !== 0) e.preventDefault(); } }, { capture: true, passive: false });
  });
  window.addEventListener("click", function (e) {
    if (!picking) return;
    swallow(e);
    var el = e.target && e.target.nodeType === 1 ? e.target : hovered;
    if (!el || el === document.documentElement || el === document.body) return;
    stop();
    var text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    post({ type: "picked", tag: el.tagName.toLowerCase(), text: text.slice(0, 200), path: pathOf(el), html: el.outerHTML.replace(/\\s+/g, " ").slice(0, 400), label: labelOf(el, text) });
  }, true);
  window.addEventListener("scroll", function () { if (picking && box) box.style.display = "none"; }, true);
  window.addEventListener("keydown", function (e) {
    if (picking && e.key === "Escape") { swallow(e); stop(); post({ type: "pick-cancelled" }); }
  }, true);
  window.addEventListener("message", function (e) {
    if (e.source !== parent || !e.data || !e.data.flashPreview) return;
    if (e.data.type === "pick") {
      if (e.data.on) { if (editMode) endEdit(false); picking = true; document.documentElement.style.cursor = "crosshair"; } else stop();
    } else if (e.data.type === "edit") {
      if (e.data.on) { stop(); editMode = true; document.documentElement.style.cursor = "text"; } else endEdit(false);
    } else if (e.data.type === "go" && typeof e.data.page === "string") {
      location.hash = "#/" + e.data.page;
    }
  });

  // Edit text: a click on words makes them editable in place; Enter or a click elsewhere keeps the
  // change (Flash writes it into the code, for free), Escape puts the words back.
  var editMode = false, editing = null, original = "";
  function textOnly(el) {
    if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement || el === box) return null;
    if (/^(SCRIPT|STYLE|INPUT|TEXTAREA|SELECT|SVG|IMG|VIDEO|IFRAME)$/.test(el.tagName)) return null;
    // Only words with no other parts inside them, so the change maps to one piece of text in the code.
    if (el.children.length || !(el.textContent || "").trim()) return null;
    return el;
  }
  function endEdit(keep) {
    var el = editing;
    editing = null;
    editMode = false;
    document.documentElement.style.cursor = "";
    if (box) box.style.display = "none";
    if (!el) { post({ type: "edit-cancelled" }); return; }
    el.removeAttribute("contenteditable");
    el.style.outline = el.getAttribute("data-flash-outline") || "";
    el.removeAttribute("data-flash-outline");
    var after = el.textContent || "";
    if (!keep || after === original || !after.trim()) { el.textContent = original; post({ type: "edit-cancelled" }); return; }
    post({ type: "text-edited", before: original.slice(0, 2000), after: after.slice(0, 2000) });
  }
  window.addEventListener("mousemove", function (e) {
    if (!editMode || editing) return;
    var el = textOnly(e.target);
    if (el) outline(el); else if (box) box.style.display = "none";
  }, true);
  ["pointerdown", "mousedown", "mouseup", "pointerup", "submit"].forEach(function (type) {
    window.addEventListener(type, function (e) {
      if (!editMode || (editing && editing.contains(e.target))) return;
      e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault();
    }, { capture: true, passive: false });
  });
  window.addEventListener("click", function (e) {
    if (!editMode) return;
    if (editing && editing.contains(e.target)) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (editing) { endEdit(true); return; }
    var el = textOnly(e.target);
    if (!el) return;
    editing = el;
    original = el.textContent || "";
    if (box) box.style.display = "none";
    el.setAttribute("data-flash-outline", el.style.outline || "");
    el.style.outline = "2px solid #10b981";
    el.setAttribute("contenteditable", "plaintext-only");
    el.focus();
    var range = document.createRange(); range.selectNodeContents(el);
    var sel = getSelection(); if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  }, true);
  window.addEventListener("keydown", function (e) {
    if (!editMode) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); endEdit(false); }
    else if (e.key === "Enter" && !e.shiftKey && editing) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); endEdit(true); }
    else if (editing) e.stopPropagation();
  }, true);

  // The app's pages, for the page picker: its <section data-page> parts, named as its menu names them.
  function words(el) { return el ? (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40) : ""; }
  function pages() {
    var list = [], seen = {};
    var all = document.querySelectorAll("[data-page]");
    for (var i = 0; i < all.length && list.length < 30; i++) {
      var id = all[i].getAttribute("data-page") || "";
      if (!id || seen[id]) continue;
      seen[id] = 1;
      var label = "", links = document.querySelectorAll("a[href]");
      for (var j = 0; j < links.length && !label; j++) {
        var href = links[j].getAttribute("href") || "";
        if (href === "#/" + id || (list.length === 0 && (href === "#/" || href === "#"))) label = words(links[j]);
      }
      list.push({ id: id, label: label || words(all[i].querySelector("h1,h2")) || id });
    }
    return list;
  }
  var lastPages = "";
  function tellPages() {
    var list = pages();
    if (list.length < 2) return;
    var m = /^#[/]([^?]*)/.exec(location.hash), current = m ? decodeURIComponent(m[1]) : "";
    var known = false;
    for (var i = 0; i < list.length; i++) if (list[i].id === current) known = true;
    if (!known) current = list[0].id;
    var said = JSON.stringify([list, current]);
    if (said === lastPages) return;
    lastPages = said;
    post({ type: "pages", pages: list, current: current });
  }
  window.addEventListener("load", tellPages);
  window.addEventListener("hashchange", function () { setTimeout(tellPages, 0); });
  document.addEventListener("DOMContentLoaded", tellPages);
  // Apps that draw their pages with a script after load are seen a moment later.
  setTimeout(tellPages, 1200);

  // Words that touch the side of the screen, or a page wider than the screen, make it look cut off:
  // told once per page load like an error, so Fix it can add the missing side padding.
  var edgeTold = false;
  function hiddenByStyle(el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return true;
      // A strip that scrolls sideways (a carousel) may start at the edge on purpose.
      if (n !== document.body && n !== document.documentElement && /auto|scroll/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1) return true;
    }
    return false;
  }
  function checkEdges() {
    if (edgeTold || picking) return;
    var w = document.documentElement.clientWidth;
    if (!w || !document.body) return;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), node, seen = 0, range = document.createRange();
    while ((node = walker.nextNode()) && seen < 3000) {
      var text = node.nodeValue.replace(/\\s+/g, " ").trim();
      if (text.length < 2 || !node.parentElement || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION)$/.test(node.parentElement.tagName)) continue;
      seen++;
      range.selectNodeContents(node);
      var r = range.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.right <= 0 || r.left >= w) continue;
      var side = r.left < 2 ? "left" : r.right > w - 2 ? "right" : "";
      if (!side || hiddenByStyle(node.parentElement)) continue;
      edgeTold = true;
      report("Layout: text touches the " + side + " edge of the screen: \\u201c" + text.slice(0, 60) + "\\u201d", 0);
      return;
    }
    if (document.documentElement.scrollWidth > w + 2) {
      edgeTold = true;
      report("Layout: the page is wider than the screen and scrolls sideways", 0);
    }
  }
  var edgeTimer = 0;
  function checkSoon() { clearTimeout(edgeTimer); edgeTimer = setTimeout(checkEdges, 900); }
  window.addEventListener("load", checkSoon);
  window.addEventListener("resize", checkSoon);
  window.addEventListener("hashchange", checkSoon);
})();</script>`;

/** Whether a message from a preview is one of Flash's own. */
export function isPreviewMessage(data: unknown): data is PreviewMessage {
  return Boolean(data && typeof data === "object" && (data as { flashPreview?: unknown }).flashPreview === true);
}

/** How many lines the scripts Flash puts at the top of the preview add, to point at the app's own lines. */
export const linesIn = (snippet: string) => snippet.split("\n").length - 1;

/** An error in words the user and the builder can act on. */
export function friendlyError(message: string): string {
  if (/localStorage|sessionStorage|indexedDB|document is sandboxed/i.test(message)) {
    return msg("This app saves data in the browser's own storage, which apps on Flash can't use. Use the built-in database (flashDB) instead.");
  }
  if (/^Layout: text touches the (left|right) edge/.test(message)) {
    return msg("Some words touch the edge of the screen, so the page looks cut off. Every section needs space on its sides.");
  }
  if (/^Layout: the page is wider than the screen/.test(message)) {
    return msg("The page is wider than the screen, so it moves sideways. Everything needs to fit the screen's width.");
  }
  return message;
}

/** The request the Fix it button sends: the errors, and the app's line where the first one happened. */
export function fixRequest(errors: PreviewError[], html: string): string {
  const lines = html.split("\n");
  const unique = errors.filter((e, i) => errors.findIndex((x) => x.message === e.message) === i).slice(0, 3);
  const described = unique.map((e) => {
    const code = e.line > 0 && e.line <= lines.length ? lines[e.line - 1].trim().slice(0, 200) : "";
    const message = friendlyError(e.message);
    // A layout problem says where it was seen, and what fixes it everywhere.
    if (e.message.startsWith("Layout: ")) {
      return `${e.message.slice(8)}. Give every section and container side padding (at least 16px on phones, more on wider screens) so no text, button or picture touches the screen's edges, and make sure nothing is wider than the screen, at every size from 320px wide up.`;
    }
    return code ? `${message}\nAround line ${e.line}: ${code}` : message;
  });
  return `Fix ${described.length > 1 ? "these errors" : "this error"} in my app, and keep everything else the same:\n\n${described.join("\n\n")}`;
}

/** What the builder is told about the part the user picked, after their own words. */
export function pickedContext(p: PickedElement): string {
  return [
    `Change only this part of the app, which I selected in the preview: the ${p.label}.`,
    p.path && `Where it is: ${p.path}`,
    p.html && `Its HTML starts: ${p.html}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The pages a preview says it has, kept only when they look right (the app's code wrote them). */
export function readPages(data: { pages?: unknown; current?: unknown }): { list: PreviewPage[]; current: string } | null {
  if (!Array.isArray(data.pages) || typeof data.current !== "string") return null;
  const list: PreviewPage[] = [];
  for (const p of data.pages.slice(0, 30)) {
    if (!p || typeof p.id !== "string" || typeof p.label !== "string" || !p.id) continue;
    list.push({ id: p.id.slice(0, 60), label: (p.label || p.id).slice(0, 40) });
  }
  return list.length >= 2 ? { list, current: list.some((p) => p.id === data.current) ? data.current : list[0].id } : null;
}

const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\u00a0/g, "&nbsp;");

/**
 * The app's code with words changed in the preview written into it, or null when Flash can't tell
 * where they are: the words must stand alone between two tags, exactly once in the file (words a
 * script writes, or the same words in two places, are left to the builder).
 */
export function replaceText(html: string, before: string, after: string): string | null {
  if (!before.trim() || before === after) return null;
  const forms = [...new Set([before, escapeText(before), before.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")])];
  for (const form of forms) {
    const needle = `>${form}<`;
    const at = html.indexOf(needle);
    if (at === -1 || html.indexOf(needle, at + 1) !== -1) continue;
    // Not inside a script or a style, where a quote in the new words could break the code.
    const head = html.slice(0, at).toLowerCase();
    if (head.lastIndexOf("<script") > head.lastIndexOf("</script") || head.lastIndexOf("<style") > head.lastIndexOf("</style")) continue;
    return `${html.slice(0, at + 1)}${escapeText(after)}${html.slice(at + 1 + form.length)}`;
  }
  return null;
}

/** What the builder is asked when words changed in the preview can't be written into the code directly. */
export const textRequest = (before: string, after: string) =>
  `Change the text "${before.trim().slice(0, 300)}" to "${after.trim().slice(0, 300)}" in my app, and keep everything else the same.`;
