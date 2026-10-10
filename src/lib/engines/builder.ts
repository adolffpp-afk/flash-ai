import {
  NO_BUDGET,
  choiceParams,
  defaultChoice,
  getClient,
  meterClaude,
  noMeter,
  toMessages,
  usesFallback,
  type Budget,
  type ClaudeChoice,
  type Meter,
  type Watch,
} from "./claude.ts";
import { tokensWithin } from "../credits.ts";
import { htmlTitle, splitBuild } from "../build-parse.ts";
import { applyEdits, hasPieces, piecesIn, splitEdits, type Edit } from "../edit-blocks.ts";
import type { ChatTurn, StreamEvent } from "../types.ts";
import { english, msg, type Translate } from "../i18n.ts";

const SHARED_RULES = `Output format, always:
1. One or two sentences saying what you built or changed.
2. The COMPLETE file in a single \`\`\`html code block: one self-contained HTML document with a <title>, inline <style> and <script>. Never send a partial file or a diff, unless a "Changing a few places" section below says you may.
3. Optionally, up to three short bullet ideas for what to add next.

Technical rules:
- It runs in a sandboxed iframe: no server, no build step. You may load libraries only from https://cdn.jsdelivr.net, https://unpkg.com or https://cdnjs.cloudflare.com (for example Tailwind via https://cdn.tailwindcss.com is also allowed, Chart.js, Alpine.js, React UMD with Babel standalone).
- To save data (menu items, products, posts, tasks, reviews, scores), use the built-in database instead of localStorage. It is always available as window.flashDB, with async methods: flashDB.list(collection) returns an array of records; flashDB.add(collection, object) returns the new record with an id and createdAt; flashDB.update(collection, id, partialObject) returns the updated record; flashDB.remove(collection, id). Collection names are letters, digits, - or _. Data is shared by everyone who uses the published app, so never store passwords or private data in it. For contact, booking, order and sign-up forms, which hold people's names, emails and phone numbers, use await flashDB.send(formName, fields) instead: it delivers the form privately to the app's owner (they read it in Flash and get an email) and nobody else can read it. Load data on start, show a loading state, and handle errors with a friendly message.
- Flash's server decides who may change each shared collection, whatever the app's own code does, by one of five rules: "read" (visitors see it; only the owner adds or changes it: menus, products, posts, prices), "add" (anyone adds; only the owner, or the signed-in person who added a record, changes or deletes it: reviews, comments, scores), "own" (visitors see it; people signed in with flashAuth add, and change or delete what they added), "private" (anyone adds; only the owner reads it, in Flash's My websites & apps > Data, never in the app itself) and "open" (anyone adds, changes or deletes anything; only for a list a group edits together). Just before </body>, name every shared collection the app uses with the strictest rule that works, in <script type="application/json" id="flash-data">{"menu": "read", "reviews": "add"}</script>, with an HTML comment right above it giving each rule's meaning in this app in one line. The block is strict JSON: double quotes, no comments and no trailing commas inside it. Collections it doesn't name are read-only for visitors, and so is everything while Flash can't read the block. For collection names made while the app runs (like "room-" + id), use one fixed collection with a field for the room instead, or give "*" the rule for every collection the block doesn't name. flashDB.mine needs no rule.
- flashDB.isOwner is true only when the app's owner opens it with Open as owner in Flash (and in Flash's preview). Show the controls that add, edit or delete owner-managed data (menu items, products, posts) only when it is true, so the owner manages the content from the app itself and visitors never see them. Seed sample records with flashDB.add only when flashDB.isOwner is true and the collection is empty; otherwise show built-in sample content while a list is empty.
- A shared record added by the signed-in person using the app has record.byYou set to true: show Edit and Delete on a record only when record.byYou or flashDB.isOwner is true.
- Personal details (emails, phone numbers, addresses) go through flashDB.send, into flashDB.mine or into a "private" collection, never into a collection visitors can read.
- Never put typed text or records into innerHTML, insertAdjacentHTML or document.write: set textContent, or pass every value through a small esc() helper first.
- To let people have their own account in the app (sign up, sign in, their own saved things), use window.flashAuth, which is always there: flashAuth.user is { id, email, name } for the person using the app right now, or null; flashAuth.signedIn says the same as true or false; flashAuth.signUp(email, password, name), flashAuth.signIn(email, password) and flashAuth.signOut() each send the form and reload the page, so write no code after calling them; flashAuth.error holds a message to show when the last try failed (wrong password and so on), and flashAuth.signedOut is true just after signing out. Never store passwords yourself, and never check a password in the app's own code.
- A signed-in person's own private things (their orders, notes, favourites, progress) go in window.flashDB.mine, which works exactly like flashDB but only for them: flashDB.mine.list, .add, .update, .remove. Nobody else using the app can read them. Everything in plain flashDB is shared by everyone, so put anything personal in flashDB.mine. When the app needs an account, show a sign-in and sign-up form first and the app itself after, and give signed-in people a sign-out button with their name or email.
- To take a file someone picks in the app (a photo with a review, a CV with an application, a picture for a listing), use const saved = await flashDB.upload(file) with the File from an <input type="file">: it returns { url, name, size }, and you save saved.url in a record with flashDB.add or flashDB.mine.add and show it with <img src=…> or a link. Pictures, PDFs and text files up to 5 MB are allowed. Taking files is off until the app's owner turns it on in Flash (My websites & apps > Files), so always show the error's message when it throws, and never try to read a file in the app and store it as text.
- When the app itself needs AI (answering questions, writing a draft, summarising, sorting or suggesting), use window.flashAI: const answer = await flashAI.ask("the question", { instructions: "what the assistant should do in this app" }), which returns text. It is off until the app's owner turns it on in Flash (My websites & apps > AI), so always show the error's message when it throws, and keep a sensible screen for when there's no answer. Never put an API key in the app.
- To sell things (products, tickets, classes, gift cards, deposits), give each item a buy button that calls await flashDB.buy("Exact item name") (or flashDB.buy(name, { quantity })): it opens a secure Stripe checkout and the money goes to the app's owner. Use the same exact name everywhere for an item. Show its price in an element with data-flash-price="Exact item name" holding a sample price like $12; Flash replaces it with the owner's real price. Disable the button while the checkout opens, and if buy throws (for example when the owner hasn't set a price yet), show the error's message near the button. After paying, the buyer comes back to the app and Flash shows a thank-you note (flashDB.paid is true then). Never ask for card numbers in the app itself.
- Never use localStorage, sessionStorage or cookies: they are blocked where the app runs.
- Use realistic sample data so the result looks alive on first load. Make it responsive and polished.
- If the request changes an existing app from earlier in the conversation, start from that app's latest code and keep everything the user did not ask to change. The user may have edited that code by hand, so always build on the newest version in the conversation, exactly as it is.
- When the user says they selected a part of the app in the preview, change that part and leave the rest of the file untouched.
- When an error from the app is reported, find its real cause in the code and fix it; don't just hide the symptom.

Pictures in the conversation:
- When a picture is attached (a screenshot of a website or app, a photo of a sketch on paper, a drawing, a mock-up or a design), rebuild it as working code: the same layout, spacing, colours and wording you can see, in the same order, on every screen size. Copy the text exactly where it's readable; where it isn't, write something sensible and say so in your first sentence.
- When several pictures are attached, they're different screens or pages of one thing: build them all, as pages or views of the same file.
- A picture of a logo, product or person is content: show it in a sensible place with a short note that the user can swap it for the real file.

Design, so the result looks professionally made:
- Pick one type scale, one spacing rhythm (multiples of 4px) and a small palette: one accent colour, one neutral for text, light and dark shades of a background. Never use pure black on pure white.
- Use a real font from Google Fonts, with a fallback, and set comfortable line height and line length.
- Give every interactive thing a clear hover, focus and disabled state, with a visible focus ring, and make the main action the most prominent thing on the screen.
- Keep layouts on a grid, align everything to it, and let rows wrap to one column on a phone. Nothing may overflow sideways.
- Use buttons, labels, headings and lists for what they mean, label every field and icon button, and keep text readable against its background (WCAG AA).
- Respect prefers-reduced-motion: keep animation short, and skip it when the user asked for less.
- Show an empty state, a loading state and a friendly error message wherever data is loaded or saved.`;

/**
 * How a small change is sent: only the lines that change, so the answer comes back in seconds
 * instead of a minute. Only offered once there is an app in the conversation to change.
 */
export const EDIT_RULES = `Changing a few places (this replaces point 2 above when the change is small):
- The app is already in this conversation. When the change touches only a few spots (wording, a colour, one function, a new button), do NOT send the whole file. Send the changed pieces instead, in one \`\`\`flash-edit code block, after your sentence:

\`\`\`flash-edit
<<<<<<< FIND
(the lines exactly as they are in the file now)
=======
(the lines that replace them)
>>>>>>> REPLACE
<<<<<<< FIND
(another spot, if you need one)
=======
(what replaces it)
>>>>>>> REPLACE
\`\`\`

- Copy the FIND lines exactly from the newest version of the file in this conversation, including their indentation, and take enough lines that they appear only once. Never invent lines you haven't seen.
- To add something new, FIND a line that is already there and REPLACE it with itself plus the new lines.
- To delete something, REPLACE it with nothing (an empty line between ======= and >>>>>>>).
- Use as many pieces as the change needs, in one block, and change nothing you weren't asked to.
- When a change adds, renames or removes a shared collection, or changes who may change one, update the flash-data block in the same answer. When the app has no flash-data block yet and you add one, name every collection its code already uses with a rule that still allows what the app does with it, so nothing it does today stops working.
- Send the complete \`\`\`html file instead, and no flash-edit block, when the change is big (a new page, a redesign, a rewrite), when it touches most of the file, or when you can't quote the current lines exactly. Never send both in one answer.`;

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

/**
 * The system prompt for building an app or deck, with what the user asked Flash to remember.
 * `canEdit` adds the rules for sending only the changed lines, which only make sense once there
 * is an app in the conversation to change.
 */
export function buildSystem(kind: "app" | "slides", preferences: string, canEdit = false): string {
  const prefs = preferences.trim();
  const parts = [PROMPTS[kind]];
  if (canEdit) parts.push(EDIT_RULES);
  if (prefs) parts.push(`About the user:\n${prefs}`);
  return parts.join("\n\n");
}

/** Asked for when a change couldn't be fitted to the file: the whole thing, once, instead. */
const WHOLE_FILE_AGAIN =
  "Those changed pieces couldn't be used: the FIND lines weren't found exactly, matched more than one " +
  "place, or a piece wasn't complete. Make the same change again, but send the COMPLETE file in one ```html code block " +
  "this time, with no flash-edit block. Start from the newest version of the file in this conversation " +
  "and keep everything else exactly as it is.";

const NO_FIT = msg("Flash couldn't fit that change into your app. Try again, or say exactly which part to change.");

/** A whole HTML file, as opposed to a snippet quoted in an answer. */
const isDocument = (code: string) => /<!doctype html|<html[\s>]|<body[\s>]/i.test(code);

/** Room left for thinking when the whole file is asked for again. */
const THINKING_ROOM = 4200;

// Slower than Claude writes a file, so a whole file asked for again is only started when it can be
// finished before the request's time runs out: one cut off there would be paid for and not delivered.
const SLOW_TOKENS_PER_SECOND = 50;

const TOO_LARGE = msg("The app was too large to finish in one go. Try asking for a simpler first version.");

/** The newest version of the app in the conversation, which a small change is applied to. */
export function latestApp(history: ChatTurn[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant" && history[i].app) return history[i].app ?? null;
  }
  return null;
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
  // The level's model and effort; Vision at high effort by default.
  choice: ClaudeChoice = defaultChoice(kind),
  // The language Flash's own words (progress, notes, errors) are in.
  t: Translate = english,
  { signal, running, endsAt }: Watch = {},
): AsyncGenerator<StreamEvent> {
  const app = kind === "app";
  // The title when the file has none. It names the published site and its downloads, so it stays in English.
  const fallback = app ? "Your app" : "Your slides";
  const tooLong = (): StreamEvent => ({
    type: "error",
    message: budget.byCredits
      ? t("Your credits ran out before this was finished. Add credits, or ask for a simpler first version.")
      : t(TOO_LARGE),
  });
  const noFit = (): StreamEvent => ({ type: "error", message: t(NO_FIT) });

  const base = latestApp(history);
  let messages = toMessages(history);
  // Small changes come back as pieces; if they don't fit the file, the whole file is asked for once.
  let canEdit = base !== null;
  let maxTokens = budget.maxTokens;
  let spent = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    // On the second go the opening sentence has already been said, so only the file is wanted.
    const quiet = attempt > 0;
    // Said before the call starts, so pressing Stop here never leaves a call running.
    yield {
      type: "status",
      message: quiet
        ? app
          ? t("Writing your app…")
          : t("Writing your slides…")
        : base
          ? app
            ? t("Changing your app…")
            : t("Changing your slides…")
          : app
            ? t("Designing your app…")
            : t("Designing your deck…"),
    };
    running?.begin(choice.model, maxTokens);
    const stream = getClient().beta.messages.stream(
      {
        ...choiceParams(choice),
        max_tokens: maxTokens,
        system: buildSystem(kind, preferences, canEdit),
        messages,
      },
      { signal },
    );

    let text = "";
    let sentBefore = 0;
    let lastLines = 0;
    let lastPieces = 0;
    let editAt = -1;
    let final: Awaited<ReturnType<typeof stream.finalMessage>>;
    try {
      for await (const event of stream) {
        running?.see(event);
        if (event.type !== "content_block_delta" || event.delta.type !== "text_delta") continue;
        text += event.delta.text;
        const part = splitBuild(text);
        if (canEdit && part.html === null && editAt === -1) editAt = text.search(/```flash-edit/i);
        // Stream the opening sentences as they arrive, holding back a possible partial ``` fence.
        const prose = editAt !== -1 ? text.slice(0, editAt) : part.html !== null ? part.before : part.before.replace(/`{1,3}[^`]*$/, "");
        if (!quiet && prose.length > sentBefore) {
          yield { type: "text", delta: prose.slice(sentBefore) };
          sentBefore = prose.length;
        }
        if (part.html !== null && editAt === -1) {
          const lines = part.html.split("\n").length;
          if (lines - lastLines >= 25) {
            lastLines = lines;
            yield { type: "status", message: app ? t("Writing your app… {lines} lines", { lines }) : t("Writing your slides… {lines} lines", { lines }) };
          }
        } else if (editAt !== -1) {
          const pieces = splitEdits(text).edits.length;
          if (pieces > lastPieces) {
            lastPieces = pieces;
            const message =
              pieces === 1
                ? app
                  ? t("Changing 1 place in your app…")
                  : t("Changing 1 place in your slides…")
                : app
                  ? t("Changing {count} places in your app…", { count: pieces })
                  : t("Changing {count} places in your slides…", { count: pieces });
            yield { type: "status", message };
          }
        }
      }
      final = await stream.finalMessage();
    } catch (err) {
      // The request's time ran out on a first build: what was written is kept, as when a build
      // reaches its length limit, and the call (which has no usage report) is paid from its estimate.
      const kept = signal?.reason === "deadline" && !base && !quiet && running ? splitBuild(text).html : null;
      if (!kept) throw err;
      meter("anthropic", choice.model, running!.soFar);
      running!.end();
      yield { type: "error", message: t(TOO_LARGE) };
      yield { type: "app", app: { title: htmlTitle(kept, fallback), html: kept, kind } };
      return;
    }
    spent += meterClaude(meter, final, choice.model, running);
    if (final.stop_reason === "refusal") {
      yield { type: "text", delta: "\n\n" + t("Flash couldn't build that.") };
      return;
    }
    const cut = final.stop_reason === "max_tokens";
    const change = splitEdits(text);
    // The file, if one came: looked for outside the pieces, so code inside them is never taken for it.
    const rest = change.before + change.after;
    const part = splitBuild(rest);
    let html = part.html;
    let edits: Edit[] = base ? change.edits : [];
    let broken = base ? change.broken : 0;
    let pieced = base !== null && change.found;
    if (base && html !== null && hasPieces(html)) {
      // Pieces sent in an ```html block are still pieces, never the app.
      const inner = piecesIn(html);
      edits = [...edits, ...inner.edits];
      broken += inner.broken;
      pieced = true;
      html = null;
    } else if (base && html !== null && !isDocument(html)) {
      // A snippet quoted in the answer would replace the whole app with a few lines.
      html = null;
    }

    if (pieced && html === null) {
      const before = change.found ? change.before : part.before;
      if (!quiet && before.length > sentBefore) yield { type: "text", delta: before.slice(sentBefore) };
      // Half a change would break the app, so a piece that can't be read whole stops all of them.
      const made = !cut && !broken && edits.length ? applyEdits(base!, edits) : null;
      if (made && !made.failed.length) {
        yield { type: "app", app: { title: htmlTitle(made.html, fallback), html: made.html, kind } };
        const after = (change.found ? change.after : part.after).trim();
        if (after) yield { type: "text", delta: `\n\n${after}` };
        return;
      }
      if (cut) {
        yield tooLong();
        return;
      }
      if (quiet) {
        yield noFit();
        return;
      }
      // The whole file is asked for only while the credits held for this request still pay for
      // reading everything again and writing all of it, so a retry never runs at a loss.
      const usage = final.usage;
      const reread = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + usage.output_tokens + 200;
      maxTokens = Math.min(budget.maxTokens, tokensWithin(kind, choice.model, reread, budget.capCents - spent, usesFallback(choice)));
      const whole = Math.ceil(base!.length / 3) + THINKING_ROOM;
      // ...and only while there's time to write it all.
      const late = endsAt !== undefined && Date.now() + (whole / SLOW_TOKENS_PER_SECOND) * 1000 > endsAt;
      if (!(maxTokens >= whole) || late) {
        yield noFit();
        return;
      }
      messages = [...messages, { role: "assistant", content: text }, { role: "user", content: WHOLE_FILE_AGAIN }];
      canEdit = false;
      continue;
    }
    // Pieces sent next to a whole file are left out: the whole file is the change. Without a
    // file, the answer is words, and a snippet quoted in it stays in them.
    const words = html === null ? rest : part.before;
    if (!quiet && words.length > sentBefore) yield { type: "text", delta: words.slice(sentBefore) };
    if (html === null) {
      if (cut) yield tooLong();
      else if (quiet) yield noFit();
      return;
    }
    if (part.open && cut) {
      yield tooLong();
      // A half-written file never replaces an app that works.
      if (base || quiet) return;
    }
    yield { type: "app", app: { title: htmlTitle(html, fallback), html, kind } };
    if (part.after.trim()) yield { type: "text", delta: `\n\n${part.after.trim()}` };
    return;
  }
}
