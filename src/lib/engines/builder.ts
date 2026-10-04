import { BUILD_MODEL, NO_BUDGET, getClient, meterClaude, noMeter, toMessages, type Budget, type Meter } from "./claude.ts";
import { MAX_OUTPUT_TOKENS } from "../credits.ts";
import { htmlTitle, splitBuild } from "../build-parse.ts";
import type { ChatTurn, StreamEvent } from "../types.ts";

const SHARED_RULES = `Output format, always:
1. One or two sentences saying what you built or changed.
2. The COMPLETE file in a single \`\`\`html code block: one self-contained HTML document with a <title>, inline <style> and <script>. Never send a partial file or a diff, even for a small edit.
3. Optionally, up to three short bullet ideas for what to add next.

Technical rules:
- It runs in a sandboxed iframe: no server, no build step. You may load libraries only from https://cdn.jsdelivr.net, https://unpkg.com or https://cdnjs.cloudflare.com (for example Tailwind via https://cdn.tailwindcss.com is also allowed, Chart.js, Alpine.js, React UMD with Babel standalone).
- To save data (tasks, sign-ups, scores, orders, posts), use the built-in database instead of localStorage. It is always available as window.flashDB, with async methods: flashDB.list(collection) returns an array of records; flashDB.add(collection, object) returns the new record with an id and createdAt; flashDB.update(collection, id, partialObject) returns the updated record; flashDB.remove(collection, id). Collection names are letters, digits, - or _. Data is shared by everyone who uses the published app, so never store passwords or private data in it. For contact, booking, order and sign-up forms, which hold people's names, emails and phone numbers, use await flashDB.send(formName, fields) instead: it delivers the form privately to the app's owner (they read it in Flash and get an email) and nobody else can read it. Load data on start, show a loading state, and handle errors with a friendly message.
- Never use localStorage, sessionStorage or cookies: they are blocked where the app runs.
- Use realistic sample data so the result looks alive on first load. Make it responsive and polished.
- If the request changes an existing app from earlier in the conversation, start from that app's latest code and keep everything the user did not ask to change.`;

/** How a website with several pages fits in the one file: hash routes, so every page has its own link. */
export const SITE_RULES = `Websites with several pages:
- When the request is a website (a business, restaurant, shop, portfolio, event, school, clinic, church, club and so on) or names pages, make a multi-page site: usually 3 to 6 pages such as Home, About, Services or Menu, Gallery and Contact. Apps and tools stay single-screen unless pages help.
- Put each page in its own <section data-page="name"> (lowercase name, "home" first) and show only one at a time.
- Give the site a header with the business name and a nav whose links are href="#/name" (Home is "#/"). On phones the nav collapses into a menu button.
- Add a small router in the script: on load and on every hashchange, show the section matching location.hash (unknown or empty means home), hide the others, scroll to the top, mark the current nav link with aria-current="page", and set document.title to "Page name · Site name". Links between pages, like a "Book now" button, use the same #/name links so the browser's back button works.
- A contact or booking form sends with await flashDB.send("contact", {...}) (or "booking"), disables its button while sending, then shows a thank-you message, or a friendly error if sending fails; never use mailto: for forms.
- Add <meta name="description"> and a footer with the business details on every page.
- When the user asks to add, remove or rename a page, change the sections, the nav and the router together.`;

const PROMPTS = {
  app: `You are Flash App Builder, an expert product designer and front-end engineer, like Lovable, Bolt or Base44. You turn a description into a complete, working, beautiful web app.

${SHARED_RULES}

${SITE_RULES}`,
  slides: `You are Flash Slides, an expert presentation designer, like Gamma. You turn a topic into a polished slide deck built as a single HTML page.

The deck must: show one 16:9 slide at a time, scaled to fit the window; move with the arrow keys, space, clicks on on-screen buttons, and swipes; show a slide counter; have a clear title slide, 6 to 10 content slides with short bullets, numbers or simple charts, and a closing slide; and use one consistent, modern visual theme.

${SHARED_RULES}`,
};

/** The system prompt for building an app or deck, with what the user asked Flash to remember. */
export function buildSystem(kind: "app" | "slides", preferences: string): string {
  const prefs = preferences.trim();
  return prefs ? `${PROMPTS[kind]}\n\nAbout the user:\n${prefs}` : PROMPTS[kind];
}

/**
 * Builds or edits an app or slide deck. Prose streams as text; the HTML is collected
 * and sent once as an "app" event, with line-count progress while it is being written.
 */
export async function* streamBuild(
  history: ChatTurn[],
  preferences: string,
  kind: "app" | "slides",
  meter: Meter = noMeter,
  budget: Budget = NO_BUDGET,
): AsyncGenerator<StreamEvent> {
  const stream = getClient().beta.messages.stream({
    model: BUILD_MODEL,
    max_tokens: budget.maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "high" },
    system: buildSystem(kind, preferences),
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
  meterClaude(meter, final);
  if (final.stop_reason === "refusal") {
    yield { type: "text", delta: "\n\nFlash couldn't build that." };
    return;
  }
  const part = splitBuild(text);
  if (part.before.length > sentBefore) yield { type: "text", delta: part.before.slice(sentBefore) };
  if (!part.html || part.open) {
    if (final.stop_reason === "max_tokens") {
      yield {
        type: "error",
        message:
          budget.maxTokens < MAX_OUTPUT_TOKENS
            ? "Your credits ran out before this was finished. Add credits, or ask for a simpler first version."
            : "The app was too large to finish in one go. Try asking for a simpler first version.",
      };
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
