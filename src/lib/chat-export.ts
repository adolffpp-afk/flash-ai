import type { UIMessage } from "./store.ts";

// Shared by the downloaded chat and the printed answer: light, readable and print-friendly.
const STYLE = `  :root { --ink: #16201c; --muted: #5d6b65; --line: #dde5e1; --accent: #0f7a5a; --you: #eef6f2; }
  body { margin: 0; background: #fff; color: var(--ink); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 40px 20px 64px; }
  header { border-bottom: 2px solid var(--accent); padding-bottom: 12px; margin-bottom: 28px; }
  header h1 { margin: 0; font-size: 28px; line-height: 1.25; }
  header p { margin: 4px 0 0; color: var(--muted); font-size: 14px; }
  section { margin: 0 0 24px; break-inside: avoid-page; }
  section h2 { margin: 0 0 6px; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); }
  section h2 span { color: var(--muted); letter-spacing: 0; text-transform: none; font-weight: 400; }
  .you { background: var(--you); border-radius: 12px; padding: 12px 16px; }
  .you .said { margin: 0; white-space: normal; }
  .file, .note { color: var(--muted); font-size: 14px; }
  .file { margin: 0 0 4px; }
  img { max-width: 100%; border-radius: 10px; border: 1px solid var(--line); }
  figure { margin: 12px 0; }
  figcaption { color: var(--muted); font-size: 13px; margin-top: 4px; }
  a { color: var(--accent); }
  pre { background: #f4f7f5; border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow-x: auto; font-size: 14px; }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .92em; }
  table { border-collapse: collapse; display: block; overflow-x: auto; }
  th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; }
  blockquote { margin: 0; padding-left: 14px; border-left: 3px solid var(--line); color: var(--muted); }
  footer { margin-top: 40px; color: var(--muted); font-size: 13px; }
  @page { margin: 18mm 16mm; }
  @media print { main { padding: 0; } }
`;

const esc = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * A reply's text for downloads. Documents Flash used to wrap in a ```markdown block come out as
 * the document itself, so Word, PDF and PowerPoint show the formatting instead of raw code.
 */
export function documentText(text: string): string {
  return text.replace(/^```(?:markdown|md)[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm, "$1");
}

/** A file name for the downloaded chat, from the project's name. */
export function chatFileName(name: string): string {
  const base = name.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().replace(/\s+/g, "-").slice(0, 60);
  return `${base || "flash-chat"}.html`;
}

/**
 * The chat as one web page that opens in any browser and keeps its pictures, so it can be saved,
 * printed to PDF or sent on. `markdown` turns Flash's answers into HTML; `picture` gives each
 * picture as a data URL (or null when it couldn't be fetched); `link` makes a Flash address absolute.
 */
export function chatDocument(
  name: string,
  messages: UIMessage[],
  opts: { markdown: (text: string) => string; picture: (url: string) => string | null; link: (url: string) => string; date: string },
): string {
  const parts = messages
    .filter((m) => !m.pending)
    .map((m) => {
      if (m.role === "user") {
        const file = m.attachmentName ? `<p class="file">📎 ${esc(m.attachmentName)}</p>` : "";
        return `<section class="you"><h2>You</h2>${file}<p class="said">${esc(m.content).replace(/\n/g, "<br>")}</p></section>`;
      }
      const body: string[] = [];
      if (m.content.trim()) body.push(opts.markdown(m.content));
      for (const img of m.images ?? []) {
        const src = img.url && opts.picture(img.url);
        body.push(
          src
            ? `<figure><img src="${src}" alt="${esc(img.prompt)}"><figcaption>${esc(img.prompt)}</figcaption></figure>`
            : `<p class="note">Picture: ${esc(img.prompt)}</p>`,
        );
      }
      for (const v of m.videos ?? []) {
        body.push(`<p class="note">🎬 Video: <a href="${esc(opts.link(v.url))}">${esc(v.prompt)}</a> (opens in Flash)</p>`);
      }
      if (m.audio) body.push(`<p class="note">🎵 <a href="${esc(opts.link(m.audio))}">${esc(m.audioLabel || "Audio")}</a> (opens in Flash)</p>`);
      if (m.app) {
        const where = m.app.slug ? ` <a href="${esc(opts.link(`/p/${m.app.slug}`))}">Open it</a>` : "";
        body.push(`<p class="note">${m.app.kind === "slides" ? "🖥️ Slides" : "🧩 App"}: ${esc(m.app.title)}.${where}</p>`);
      }
      if (m.after?.trim()) body.push(opts.markdown(m.after));
      if (m.sources?.length) {
        body.push(`<p class="note">Sources: ${m.sources.map((s) => `<a href="${esc(s.url)}">${esc(s.title)}</a>`).join(" · ")}</p>`);
      }
      if (m.error) body.push(`<p class="note">${esc(m.error)}</p>`);
      if (!body.length) return "";
      return `<section class="flash"><h2>Flash${m.model ? ` <span>${esc(m.model)}</span>` : ""}</h2>${body.join("")}</section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} · Flash AI</title>
<style>
${STYLE}</style>
</head>
<body>
<main>
<header><h1>${esc(name)}</h1><p>A chat with Flash AI · ${esc(opts.date)}</p></header>
${parts}
<footer>Made with Flash AI · <a href="https://www.flash-app.dev">flash-app.dev</a></footer>
</main>
</body>
</html>
`;
}

/**
 * One answer as a page to print or save as PDF: `title` heads it and names the PDF, `html` is the
 * answer already turned from Markdown into HTML.
 */
export function answerDocument(title: string, html: string, date: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
${STYLE}</style>
</head>
<body>
<main>
${html}
<footer>Made with Flash AI · ${esc(date)}</footer>
</main>
</body>
</html>
`;
}
