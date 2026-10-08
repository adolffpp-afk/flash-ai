/*
 * What an app's preview in Flash tells Flash: the errors it hits (for the Fix it button) and the
 * part of the page the user clicked while choosing what to change. Only the preview gets this
 * script; published apps never do.
 */

/** A message from the preview to Flash. */
export type PreviewMessage =
  | { flashPreview: true; type: "error"; message: string; line: number }
  | { flashPreview: true; type: "picked"; tag: string; text: string; path: string; html: string; label: string }
  | { flashPreview: true; type: "pick-cancelled" };

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
      if (e.data.on) { picking = true; document.documentElement.style.cursor = "crosshair"; } else stop();
    }
  });
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
    return "This app saves data in the browser's own storage, which apps on Flash can't use. Use the built-in database (flashDB) instead.";
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
