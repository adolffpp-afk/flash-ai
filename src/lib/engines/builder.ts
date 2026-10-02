import { getClient, TEXT_MODEL, toMessages } from "./claude.ts";
import { htmlTitle, splitBuild } from "../build-parse.ts";
import type { ChatTurn, StreamEvent } from "../types.ts";

const SHARED_RULES = `Output format, always:
1. One or two sentences saying what you built or changed.
2. The COMPLETE file in a single \`\`\`html code block: one self-contained HTML document with a <title>, inline <style> and <script>. Never send a partial file or a diff, even for a small edit.
3. Optionally, up to three short bullet ideas for what to add next.

Technical rules:
- It runs in a sandboxed iframe: no server, no build step. You may load libraries only from https://cdn.jsdelivr.net, https://unpkg.com or https://cdnjs.cloudflare.com (for example Tailwind via https://cdn.tailwindcss.com is also allowed, Chart.js, Alpine.js, React UMD with Babel standalone).
- Wrap every localStorage call in try/catch and keep working in memory if it throws.
- Use realistic sample data so the result looks alive on first load. Make it responsive and polished.
- If the request changes an existing app from earlier in the conversation, start from that app's latest code and keep everything the user did not ask to change.`;

const PROMPTS = {
  app: `You are Flash App Builder, an expert product designer and front-end engineer, like Lovable, Bolt or Base44. You turn a description into a complete, working, beautiful web app.

${SHARED_RULES}`,
  slides: `You are Flash Slides, an expert presentation designer, like Gamma. You turn a topic into a polished slide deck built as a single HTML page.

The deck must: show one 16:9 slide at a time, scaled to fit the window; move with the arrow keys, space, clicks on on-screen buttons, and swipes; show a slide counter; have a clear title slide, 6 to 10 content slides with short bullets, numbers or simple charts, and a closing slide; and use one consistent, modern visual theme.

${SHARED_RULES}`,
};

/**
 * Builds or edits an app or slide deck. Prose streams as text; the HTML is collected
 * and sent once as an "app" event, with line-count progress while it is being written.
 */
export async function* streamBuild(
  history: ChatTurn[],
  preferences: string,
  kind: "app" | "slides",
): AsyncGenerator<StreamEvent> {
  const prefs = preferences.trim();
  const stream = getClient().beta.messages.stream({
    model: TEXT_MODEL,
    max_tokens: 64000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "xhigh" },
    system: prefs ? `${PROMPTS[kind]}\n\nAbout the user:\n${prefs}` : PROMPTS[kind],
    messages: toMessages(history),
  });

  const noun = kind === "app" ? "app" : "slides";
  let text = "";
  let sentBefore = 0;
  let lastLines = 0;
  yield { type: "status", message: kind === "app" ? "Designing your app…" : "Designing your deck…" };
  for await (const event of stream) {
    if (event.type !== "content_block_delta" || event.delta.type !== "text_delta") continue;
    text += event.delta.text;
    const part = splitBuild(text);
    // Stream the opening sentences as they arrive, holding back a possible partial ``` fence.
    const safe = part.html === null ? part.before.replace(/`{1,3}[^`]*$/, "") : part.before;
    if (safe.length > sentBefore) {
      yield { type: "text", delta: safe.slice(sentBefore) };
      sentBefore = safe.length;
    }
    if (part.html !== null) {
      const lines = part.html.split("\n").length;
      if (lines - lastLines >= 25) {
        lastLines = lines;
        yield { type: "status", message: `Writing your ${noun}… ${lines} lines` };
      }
    }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") {
    yield { type: "text", delta: "\n\nFlash couldn't build that." };
    return;
  }
  const part = splitBuild(text);
  if (part.before.length > sentBefore) yield { type: "text", delta: part.before.slice(sentBefore) };
  if (!part.html || part.open) {
    if (final.stop_reason === "max_tokens") {
      yield { type: "error", message: "The app was too large to finish in one go. Try asking for a simpler first version." };
    } else if (!part.html) {
      return;
    }
  }
  if (part.html) {
    const fallback = kind === "app" ? "Your app" : "Your slides";
    yield { type: "app", app: { title: htmlTitle(part.html, fallback), html: part.html, kind } };
  }
  if (part.after.trim()) yield { type: "text", delta: `\n\n${part.after.trim()}` };
}
