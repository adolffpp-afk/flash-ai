import { test } from "node:test";
import assert from "node:assert/strict";

const { BASE_SYSTEM, WEATHER_LINE, otherToolsLine, system } = await import("../src/lib/engines/claude.ts");
const { buildSystem } = await import("../src/lib/engines/builder.ts");
const { VOICE_STYLE } = await import("../src/lib/voice-chat.ts");
const { companionSystem } = await import("../src/lib/companion.ts");

const ALL_LIVE = { image: true, video: true, music: true, voice: true, app: true, slides: true, transcribe: true };

test("the system prompt keeps a stable order: who Flash is, tools, web, weather, mode, the user, then the context note", () => {
  const tools = otherToolsLine(ALL_LIVE);
  const context = "Today is Saturday 10 October 2026, and it's 14:05 where the user is.";
  const prompt = system("Call me Ada.", "code", { tools, weather: true, context });
  const order = [BASE_SYSTEM, tools, "You can't search the web in this answer.", WEATHER_LINE, "expert software engineer", "Call me Ada.", context];
  const at = order.map((part) => prompt.indexOf(part));
  assert.ok(at.every((i) => i >= 0), `every part is there: ${at}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, "in this order");
  assert.ok(prompt.endsWith(context), "the context note comes last, so the text before it can be cached");
  // Without options, a mode gets only what it always had, plus the web line.
  assert.equal(
    system("", "text"),
    `${BASE_SYSTEM}\n\nYou can't search the web in this answer. Your training data ends well before today's date, so for anything that may have changed since then (the weather, news, prices, scores, who holds an office, the latest version of something), give what you know and roughly when it dates from, and say that Flash's Research can check it live. Never state a current figure as if you had just checked it.`,
  );
});

test("each web line says what the model can check, and the weather leaves the list once the forecast tool is there", () => {
  const research = system("", "search");
  assert.match(research, /^You can search the web and read web pages\./m);
  assert.match(research, /today's date\. The weather, news, prices/);
  assert.match(research, /This is a research answer/);
  assert.doesNotMatch(research, /One good search is enough/);
  assert.match(system("", "search", { quick: true }), /instead of filling the gap from memory\. One good search is enough here/);
  const withForecast = system("", "search", { weather: true });
  assert.match(withForecast, /today's date\. News, prices and exchange rates/);
  assert.doesNotMatch(withForecast, /The weather, news/);
  const free = system("", "text", { web: "free" });
  assert.match(free, /You're answering on Flash's free model, which can't search the web/);
  assert.match(free, /\(the weather, news, prices, exchange rates/);
  assert.doesNotMatch(system("", "text", { web: "free", weather: true }), /\(the weather, /);
  assert.doesNotMatch(system("", "docs"), /get_weather/, "no weather line without the tool");
});

test("the tools line names only what works now, and never offers a missing tool", () => {
  assert.equal(
    otherToolsLine(ALL_LIVE),
    "Flash also makes pictures, videos, music, voice-overs, apps and websites, slide decks and transcripts of recordings. When the user wants " +
      'one of these, tell them to ask for it in their own words (for example "Make a picture of a red bicycle"); Flash switches tools by ' +
      "itself. Never say Flash can't do them.",
  );
  const noPictures = otherToolsLine({ app: true, slides: true, image: false });
  assert.equal(
    noPictures,
    "Flash also makes apps and websites and slide decks. When the user wants one of these, tell them to ask for it in their own words; " +
      "Flash switches tools by itself. Never say Flash can't do them.",
  );
  assert.doesNotMatch(noPictures, /picture/);
  assert.equal(otherToolsLine({ app: false, image: false }), "", "nothing live, no line");
  assert.match(otherToolsLine({ image: true }, true), /^Flash also makes pictures, most of them with credits\./);
});

test("when the user picked the tool, the line says how to switch instead of promising Flash will", () => {
  for (const free of [false, true]) {
    const line = otherToolsLine(ALL_LIVE, free, true);
    assert.doesNotMatch(line, /switches tools by itself/);
    assert.match(line, /The user picked this tool, so Flash won't switch tools by itself: when they want one of these, tell them to pick it with the tool button by the message box, or to switch back to Auto/);
    assert.match(line, /Never say Flash can't do them\.$/);
  }
});

test("the mode prompts answer first and leave placeholders instead of inventing details", () => {
  assert.match(system("", "code"), /name it in one line instead of asking/);
  const docs = system("", "docs");
  assert.match(docs, /under every answer\. When the user hasn't given the details a document needs/);
  assert.match(docs, /\[Company name\] or \[Start date\]/);
  assert.match(VOICE_STYLE, /^This message was spoken in a live voice conversation with Flash/);
  assert.match(VOICE_STYLE, /Say numbers with their units the way people say them aloud\.$/);
});

test("the builders build first, never invent a business's details, and get the date without the clock", () => {
  const app = buildSystem("app", "", false, "Today is Saturday 10 October 2026 where the user is.");
  assert.match(app, /^Build first\./m);
  assert.match(app, /Output format, except when you reply with the one question allowed above:/);
  assert.match(app, /never invent reviews, testimonials, ratings/);
  assert.doesNotMatch(app, /Use realistic sample data so the result looks alive/);
  assert.ok(app.endsWith("Today is Saturday 10 October 2026 where the user is."));
  assert.match(buildSystem("slides", ""), /labelled "Sample data"/);
  assert.ok(!buildSystem("app", "").includes("Today is"), "no note, no date");
});

test("apps offer news with a box the person ticks themselves, sent with the form", () => {
  const app = buildSystem("app", "");
  assert.match(app, /never ticked to start with/);
  assert.match(app, /flashDB\.send\(formName, fields, \{ news: thatCheckbox \}\)/);
  // Flash counts only the words a visitor sees in the page's HTML (see pageHas), so a label a script writes never counts.
  assert.match(app, /Write that box and its label in the page's HTML itself, never from a script/);
  assert.match(app, /Name form fields name, email and phone/);
});

test("apps count their own key steps with flashDB.track, never the person or what Flash counts already", () => {
  const app = buildSystem("app", "");
  assert.match(app, /flashDB\.track\("step-name"\)/);
  assert.match(app, /nothing about the person/);
  assert.match(app, /Visits, flashDB\.send, flashAuth sign-ups and flashDB\.buy are counted already/);
});

test("the companion sends live questions to the chat instead of answering them from memory", () => {
  const facts = {
    name: "Ada",
    credits: 100,
    plan: null,
    today: "Saturday 10 October 2026",
    live: ["text" as const],
    costs: { text: 1 } as never,
    models: [],
    freeLane: { chats: 25, images: 5, transcripts: 5 },
    context: {},
  };
  assert.match(companionSystem({ ...facts, tools: true }), /call do_next with their question so Flash answers it in their chat/);
  assert.match(companionSystem({ ...facts, tools: false }), /tell them to ask in the chat, where Flash can check a live forecast/);
  assert.match(companionSystem({ ...facts, tools: true }), /- Weather: people ask in the chat in their own words/);
});
