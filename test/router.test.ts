import { test } from "node:test";
import assert from "node:assert/strict";
import { checksSpoken, followsForecast, pictureFollowUp, route, spokenFollowUp, takesGuess, textToSpeak, wantsAudioFile } from "../src/lib/router.ts";
import { FIRM_MAX_CHARS, asksWeather, weatherQuestion } from "../src/lib/weather-words.ts";
import { freeFacts } from "../src/lib/free-order.ts";
import { A, B, C } from "./fixtures/weather-messages.ts";

const cases: [string, string][] = [
  ["Write a short poem about the ocean", "text"],
  ["Explain how compound interest works", "text"],
  ["Give me 5 names for a bakery", "text"],
  ["Draw a cat astronaut in watercolor", "image"],
  ["Create a logo for my bakery called Sunrise", "image"],
  ["Generate an image of a red sports car", "image"],
  ["Make a video of waves crashing on a beach at sunset", "video"],
  ["Create a 8 second animation of a bouncing ball", "video"],
  ["Compose a happy jingle for my bakery", "music"],
  ["Make a lofi beat to study to", "music"],
  ["Write a song about summer love", "music"],
  ["What is the latest news about the Mars mission?", "search"],
  ["Who won the Champions League final in 2026?", "search"],
  ["Summarize https://example.com/article", "search"],
  ["Search for the best laptops for students with sources", "search"],
  ["Read this aloud: Welcome to Flash AI", "voice"],
  ["Turn this paragraph into audio: Hello there", "voice"],
  ['Say "good morning everyone"', "voice"],
  ["Write a Python function that checks if a number is prime", "code"],
  ["Why does my React component render twice?", "code"],
  ["Fix this bug: TypeError undefined is not a function", "code"],
  ["Translate 'good morning' to Spanish", "translate"],
  ["How do you say thank you in Japanese?", "translate"],
  ["Create a monthly budget spreadsheet for a family of four", "docs"],
  ["Write a cover letter for a barista job", "docs"],
  ["Make a table comparing iPhone and Pixel", "docs"],
  ["Transcribe this interview", "transcribe"],
  ["Build a todo app with categories and due dates", "app"],
  ["Make a landing page for my bakery", "app"],
  ["Create a website like Airbnb for renting cars", "app"],
  ["Make a snake game", "app"],
  ["Build a video game where you dodge asteroids", "app"],
  ["Create a dashboard to track my sales", "app"],
  ["Create a budget tracker spreadsheet", "docs"],
  ["Make a presentation about climate change", "slides"],
  ["Create a pitch deck for my startup", "slides"],
  ["Design a logo for my app", "image"],
];

for (const [msg, engine] of cases) {
  test(`routes "${msg}" to ${engine}`, () => {
    assert.equal(route(msg).engine, engine);
  });
}

test("audio attachments are transcribed", () => {
  assert.equal(route("", "audio/mpeg").engine, "transcribe");
});

test("a PDF goes to a text engine even if the message mentions a picture", () => {
  assert.equal(route("Draw conclusions from this", "application/pdf").engine, "text");
});

test("a CSV goes to docs and sheets", () => {
  assert.equal(route("What stands out here?", "text/csv").engine, "docs");
});

test("a general follow-up after an app edits the app", () => {
  assert.equal(route("Make the header blue and add a dark mode", undefined, "app").engine, "app");
  assert.equal(route("Add a slide about costs", undefined, "slides").engine, "slides");
});

test("a clear new request after an app goes to its own engine", () => {
  assert.equal(route("Draw a logo for it", undefined, "app").engine, "image");
  assert.equal(route("What's the latest news on AI?", undefined, "app").engine, "search");
});

test("textToSpeak pulls out the words to say", () => {
  assert.equal(textToSpeak('Say "good morning everyone"'), "good morning everyone");
  assert.equal(textToSpeak("Read this aloud: Welcome to Flash AI"), "Welcome to Flash AI");
  // A time's colon isn't where the words start, and "can you" isn't said.
  assert.equal(textToSpeak("Say good night at 9:30"), "good night at 9:30");
  assert.equal(textToSpeak("Can you say happy birthday Sam"), "happy birthday Sam");
});

test("in a voice conversation, talk about how Flash speaks is answered, and audio asked for is still made", () => {
  for (const m of ["Say that again", "Speak slower", "Can you read that out loud", "Narrate what you see"]) {
    assert.equal(route(m).engine, "voice", `typed: ${m}`);
    const spoken = route(m, undefined, undefined, { spoken: true });
    assert.deepEqual([spoken.engine, spoken.reason, spoken.guessed], ["text", "Flash answers in the conversation.", undefined], m);
  }
  for (const m of [
    "Read this aloud: Welcome to Flash AI",
    'Say "good morning everyone"',
    "Turn this poem into audio",
    "Convert my notes into speech",
    "Say happy birthday in a deep voice",
    "Make a voiceover of happy birthday in a British accent",
  ]) {
    assert.equal(route(m, undefined, undefined, { spoken: true }).engine, "voice", m);
  }
  // Words that point back at what was said, or only say how to speak, are talk, not a voice-over of them.
  for (const m of [
    "say that again in a louder voice",
    "say it again in a slower voice",
    "can you speak in a lower voice",
    "read the rest of the speech aloud",
    "read the file out loud",
    "Say good night at 9:30.",
    // "This" is what was said before, which a voice-over can't read: it would say "in a British accent".
    "Read this in a British accent",
    "Read this aloud as an mp3",
    "can you speak with a british accent",
    "speak with a deeper voice",
    "talk like a pirate",
    "use a deeper voice",
    "change your voice",
    "I love your voice",
  ]) {
    assert.ok(!wantsAudioFile(m), m);
    assert.equal(route(m, undefined, undefined, { spoken: true }).engine, "text", m);
  }
  assert.equal(route("make a voiceover of: hello", undefined, undefined, { spoken: true }).engine, "voice");
});

test("in a voice conversation, reading out the news or a price looks it up, and the weather comes from the forecast", () => {
  for (const m of ["read me the latest news out loud", "say the price of bitcoin today"]) {
    assert.equal(route(m).engine, "voice", `typed: ${m}`);
    assert.equal(route(m, undefined, undefined, { spoken: true }).engine, "search", m);
  }
  for (const m of ["can you read the weather forecast out loud", "say what's the weather like in paris right now"]) {
    assert.equal(route(m).engine, "voice", `typed: ${m}`);
    const r = route(m, undefined, undefined, { spoken: true });
    assert.deepEqual([r.engine, r.live], ["text", "weather"], m);
  }
});

test("after an app, a spoken follow-up edits it only when it asks for a change; typed ones as before", () => {
  for (const m of ["Thank you.", "How does it work?", "show me how it works", "let me think", "What's the function of the liver?"]) {
    assert.equal(route(m, undefined, "app").engine, "app", `typed: ${m}`);
    assert.notEqual(route(m, undefined, "app", { spoken: true }).engine, "app", m);
  }
  for (const m of ["Make the button blue", "Can you add a contact page", "Let's add a footer", "change the title to Bakery"]) {
    assert.equal(route(m, undefined, "app", { spoken: true }).engine, "app", m);
  }
  assert.equal(route("Now add a slide about costs", undefined, "slides", { spoken: true }).engine, "slides");
});

test("spoken changes to a build: with an opener, as a wish, or as a complaint", () => {
  for (const m of [
    "yeah make the button blue",
    "alright now add a footer",
    "um, make the button blue",
    "Flash, make the button blue",
    "can we make the button blue",
    "could we add a login page",
    "I want the button to be blue",
    "I'd like a dark mode",
    "the button should be blue",
    "I need a contact form",
    "dark mode please",
    "the menu has a bug",
    "the menu doesn't work",
    "No, make it red",
    "Thanks, now add a footer",
    "Looks great, but make the title bigger",
    "I think the header should be bigger",
    "put the logo on the left",
    "turn the header green",
    "use a darker font",
    "set the background to black",
    "give it a dark mode",
    "let's make it darker",
    "move the logo left",
    "undo",
  ]) {
    assert.equal(spokenFollowUp(m), "change", m);
    assert.equal(route(m, undefined, "app", { spoken: true }).engine, "app", m);
  }
});

test("spoken talk after a build is answered in words, and keeps the build for the next follow-up", () => {
  for (const m of [
    "Thank you.",
    "thank you so much",
    "great job",
    "okay",
    "let's take a break",
    "okay let's go to bed",
    "okay let's move on",
    "let's talk about something else",
    "let's see",
    "change the subject",
    "change of plans",
    "move on",
    "give us a minute",
    "give it a second",
    "can you show how it works",
    "show us how it works",
    "put it simply",
    "make me laugh",
    "set a timer for five minutes",
    "now let's do something else",
    "How do I use it?",
    "Can I use it on my phone?",
    "I'd like to know how it works",
  ]) {
    assert.equal(spokenFollowUp(m), "talk", m);
    const r = route(m, undefined, "app", { spoken: true });
    assert.notEqual(r.engine, "app", m);
    assert.equal(r.about, "app", m);
    assert.ok(!r.guessed, m);
  }
  // Typed, the same words change the app, as before.
  assert.equal(route("let's take a break", undefined, "app").engine, "app");
});

test("unclear spoken follow-ups get the router's guess, which may change the build or answer, nothing else", () => {
  for (const m of ["Nice layout", "it's too dark", "How about a dark mode?", "Can we use it offline?", "make a plan for my week", "add 2 and 2"]) {
    const r = route(m, undefined, "app", { spoken: true });
    assert.deepEqual([r.guessed, r.answersOnly, r.about], [true, true, "app"], m);
    const asked = { spoken: true, recheck: true, about: r.about };
    assert.ok(takesGuess("app", r.engine, m, asked), m);
    for (const g of ["image", "video", "music", "slides", "voice"] as const) assert.ok(!takesGuess(g, r.engine, m, asked), `${m}: ${g}`);
  }
});

test("after spoken thanks, the next follow-up, spoken or typed, still changes the app", () => {
  const thanks = route("Thank you.", undefined, "app", { spoken: true });
  assert.equal(thanks.engine, "text");
  // The reply keeps what it was about, and the next request is sent with that.
  const previous = thanks.about ?? thanks.engine;
  assert.equal(route("Make the button blue", undefined, previous, { spoken: true }).engine, "app");
  assert.equal(route("make the button blue", undefined, previous).engine, "app");
  assert.equal(route("the header should be bigger", undefined, previous, { spoken: true }).engine, "app");
});

test("the router's guess: typed requests as before; spoken ones aren't made into builds, prices or voice-overs by it", () => {
  // Typed: a guess moves a request off text to anything but transcribing.
  for (const g of ["image", "video", "app", "voice", "search", "code"] as const) assert.ok(takesGuess(g, "text", "Speak slower"), g);
  assert.ok(!takesGuess("text", "text", "Hello") && !takesGuess("transcribe", "text", "Hello"));
  // Spoken: "speak slower" isn't a voice-over, an mp3 is.
  assert.ok(!takesGuess("voice", "text", "Speak slower", { spoken: true }));
  assert.ok(takesGuess("voice", "text", "Make it an mp3", { spoken: true }));
  // Spoken code, docs and search are checked again, and only move between the engines that answer in words.
  assert.ok(checksSpoken("code") && checksSpoken("docs") && checksSpoken("search"));
  assert.ok(!checksSpoken("text") && !checksSpoken("image") && !checksSpoken("app"));
  const recheck = { spoken: true, recheck: true };
  for (const g of ["text", "translate", "docs", "search"] as const) assert.ok(takesGuess(g, "code", "What's the function of the liver?", recheck), g);
  for (const g of ["code", "app", "slides", "image", "video", "music", "voice", "transcribe"] as const) {
    assert.ok(!takesGuess(g, "code", "What's the function of the liver?", recheck), g);
  }
});

test("spoken changes asked as a question, or after wait or never mind, still change the build", () => {
  for (const m of [
    "Is it possible to add a dark mode?",
    "Would it be possible to add a footer?",
    "Do you think you could make the header bigger?",
    "Are you able to make it darker?",
    "Why don't you make the button blue?",
    "When I click the button nothing happens.",
    "I'd like to see a bigger logo.",
    "wait, make the button blue",
    "hold on, add a footer",
    "oh wait, can you make the title bigger",
    "I see, now add a footer",
    "never mind, change it back",
    "sorry, make the title smaller",
    "fix my app",
  ]) {
    assert.equal(spokenFollowUp(m), "change", m);
    assert.equal(route(m, undefined, "app", { spoken: true }).engine, "app", m);
  }
  assert.equal(route("Is it possible to add a slide about costs?", undefined, "slides", { spoken: true }).engine, "slides");
  // A yes may answer Flash's own offer to change it, and a question about changing it may be one: the guess reads them.
  for (const m of ["Yes.", "Yes please.", "Sure, go ahead.", "Go ahead", "What about a dark mode?", "How do I change the font?"]) {
    assert.equal(spokenFollowUp(m), "unclear", m);
    assert.deepEqual(route(m, undefined, "app", { spoken: true }).about, "app", m);
  }
  for (const m of ["wait", "hold on a second", "never mind", "I see the problem", "okay", "wait for it"]) assert.equal(spokenFollowUp(m), "talk", m);
});

test("spoken navigation, Flash's voice and the user's account don't rebuild the app or deck", () => {
  for (const m of [
    "Show the next slide.",
    "Can you show the second slide",
    "switch to the next slide",
    "go back to the first slide",
    "Turn the page.",
    "can you make it louder",
    "make it quieter",
    "change the voice",
    "use a different voice",
    "change my password",
    "delete my account",
    "update my email address",
  ]) {
    assert.equal(spokenFollowUp(m), "talk", m);
    assert.notEqual(route(m, undefined, "slides", { spoken: true }).engine, "slides", m);
  }
  // Looking around, a speed that may be the game's, or fixing something that isn't the build: the guess decides.
  for (const m of ["show the chart again", "Bring up the menu.", "Try the login.", "let's try the dark mode", "make it slower", "fix my sleep schedule"]) {
    assert.equal(spokenFollowUp(m), "unclear", m);
    assert.equal(route(m, undefined, "app", { spoken: true }).guessed, true, m);
  }
  // Saying how still changes it.
  for (const m of ["show the price in euros", "turn the header green", "turn off the dark mode", "move the chart to the next slide", "try a darker font"]) {
    assert.equal(spokenFollowUp(m), "change", m);
  }
  // Typed, the same words change the deck, as before.
  assert.equal(route("Show the next slide", undefined, "slides").engine, "slides");
});

test("spoken talk that mentions something to make is answered in words unless the guess reads an ask", () => {
  for (const [m, made] of [
    ["how do I make a website?", "app"],
    ["how do I build an app", "app"],
    ["I have a presentation tomorrow and I'm nervous", "slides"],
    ["what's that song about?", "music"],
    ["what is a good beat for running", "music"],
    ["I like to draw in my free time", "image"],
    ["my daughter loves to paint, what should I get her", "image"],
    ["I saw a picture of my grandma yesterday", "image"],
    ["did you draw that", "image"],
    ["okay so I watched a video of a cat on youtube", "video"],
  ] as const) {
    assert.equal(route(m).engine, made, `typed: ${m}`);
    const r = route(m, undefined, undefined, { spoken: true });
    assert.deepEqual([r.engine, r.guessed, r.answersOnly, r.maybe], ["text", true, true, made], m);
    // The guess may still make it, or answer in words, but not make something else.
    const asked = { spoken: true, recheck: true, maybe: r.maybe };
    assert.ok(takesGuess(made, "text", m, asked) && takesGuess("search", "text", m, asked), m);
    for (const g of ["app", "slides", "image", "video", "music", "voice"] as const) if (g !== made) assert.ok(!takesGuess(g, "text", m, asked), `${m}: ${g}`);
  }
  // Asked for, it's made as before.
  for (const [m, made] of [
    ["draw a cat", "image"],
    ["can you draw a cat", "image"],
    ["I'd like a song about my dog", "music"],
    ["make a video of a dog surfing", "video"],
    ["build me a website for my bakery", "app"],
  ] as const) {
    assert.equal(route(m, undefined, undefined, { spoken: true }).engine, made, m);
  }
});

test("spoken small talk about today isn't a web search; today's news is, and the weather comes from the forecast", () => {
  for (const m of ["How are you today?", "I'm feeling sad today", "what are you doing right now", "I'm so tired today", "what should I cook tonight"]) {
    assert.equal(route(m).engine, "search", `typed: ${m}`);
    const r = route(m, undefined, undefined, { spoken: true });
    // Answered in words: the guess may still search, when the user can pay for that.
    assert.deepEqual([r.engine, r.guessed, r.answersOnly], ["text", true, true], m);
  }
  for (const m of ["what's the news today", "is the pharmacy open right now", "who won the game last night", "what's the latest on the election"]) {
    assert.equal(route(m, undefined, undefined, { spoken: true }).engine, "search", m);
  }
  const weather = route("what's the weather like today", undefined, undefined, { spoken: true });
  assert.deepEqual([weather.engine, weather.live], ["text", "weather"], "the weather comes from the forecast");
});

const WEATHER_REASON = "Weather questions are answered from a live forecast.";

test("a precise weather question is answered in words with the forecast; the date and time from the clock", () => {
  const rain = route("Will it rain tomorrow?");
  assert.deepEqual([rain.engine, rain.live, rain.reason, rain.guessed], ["text", "weather", WEATHER_REASON, undefined]);
  assert.deepEqual([route("Give me the weather report for Nairobi").engine, route("Give me the weather report for Nairobi").live], ["text", "weather"]);
  // Asked for as a spreadsheet: Docs & Sheets, which gets the forecast tool too.
  assert.equal(route("What's the weather in Lagos? Put it in a spreadsheet").engine, "docs");
  for (const m of ["Quel temps fait-il à Paris ?", "北京明天天气怎么样？", "هل ستمطر غدا في القاهرة؟"]) {
    assert.deepEqual([route(m).engine, route(m).live], ["text", "weather"], m);
  }
  // Not a question: the guess decides, with the hint.
  const montreal = route("météo à Montréal demain");
  assert.deepEqual([montreal.engine, montreal.guessed, montreal.hint, montreal.live], ["text", true, "weather", undefined]);
  for (const m of ["what time is it in Tokyo", "what's today's date"]) {
    const r = route(m);
    assert.deepEqual([r.engine, r.live, r.reason], ["text", "clock", "Flash answers this from today's date and time."], m);
  }
  // A question about an attached file isn't one about the weather.
  assert.equal(route("Will it rain tomorrow?", "application/pdf").live, undefined);
});

test("questions about today's office holders and opening hours are searched; building, drawing and look-alikes aren't", () => {
  for (const m of ["who is the president of France", "is the Louvre open now", "how much is one dollar in naira", "Is there a hurricane coming to Miami this week?"]) {
    assert.equal(route(m).engine, "search", m);
  }
  assert.equal(route("build a weather app").engine, "app");
  assert.equal(route("draw a stormy sky").engine, "image");
  assert.equal(route("Make a weather report template for my class").engine, "docs");
  for (const m of ["Who is the king of pop?", "How much is a pound of rice in kg?", "Light fixtures for a small bathroom", "How do I install a light fixture?"]) {
    assert.notEqual(route(m).engine, "search", m);
  }
  for (const m of ["What time is it best to post on Instagram?", "What date is it on the Chinese calendar?", "What day is it on the Hebrew calendar?"]) {
    assert.equal(route(m).live, undefined, m);
  }
});

test("other weather words stay with the router's guess, with the hint", () => {
  for (const m of [
    "Dessine un parapluie rouge",
    "Comment dit-on « il pleut » en anglais ?",
    "How does weather affect stock prices?",
    // A weather word with a word about when isn't a web search: the guess picks the forecast or Research.
    "Any rain expected in Accra this week?",
    "Make a packing list for Paris based on this week's weather",
  ]) {
    const r = route(m);
    assert.deepEqual([r.engine, r.guessed, r.hint, r.live], ["text", true, "weather", undefined], m);
  }
  // A link is still read by Research.
  assert.equal(route("Make a packing list for Paris based on this week's weather: https://example.com/trip").engine, "search");
});

test("after an app or deck: changes that mention the weather change it, weather and clock questions are answered", () => {
  for (const m of ["show the temperature in Celsius", "add a 5 day forecast for the selected city", "add a weather widget to the header", "make the header blue"]) {
    const r = route(m, undefined, "app");
    assert.deepEqual([r.engine, r.captured], ["app", undefined], m);
  }
  // Another weather word stays the change, but the guess, which knows about the app, may read it otherwise.
  const paint = route("Pinta un paraguas bajo la lluvia", undefined, "app");
  assert.deepEqual([paint.engine, paint.guessed, paint.captured, paint.hint], ["app", true, true, "weather"]);
  const hot = route("how hot is it in Lagos", undefined, "app");
  assert.deepEqual([hot.engine, hot.live], ["text", "weather"]);
  const date = route("what's the date", undefined, "slides");
  assert.deepEqual([date.engine, date.live], ["text", "clock"]);
  // Spoken, it's answered and the app is kept for the next follow-up.
  const spoken = route("will it rain tomorrow?", undefined, "app", { spoken: true });
  assert.deepEqual([spoken.engine, spoken.live, spoken.about], ["text", "weather", "app"]);
  assert.equal(pictureFollowUp("make it rainy"), true);
});

test("in all three message sets, nothing to make goes to the forecast rule and nothing but the clock to the clock rule", () => {
  const all = [...A.WEATHER, ...A.CLOCK, ...A.EVERYDAY, ...A.TRAPS, ...B.WEATHER, ...B.BY_DESIGN, ...B.ORDINARY_EN, ...B.ORDINARY_OTHER, ...C.BLIND];
  assert.equal(all.length, 67 + 5 + 72 + 73 + 75 + 9 + 89 + 54 + 73);
  const making = all.filter((m) => !["weather", "clock", "text", "other", "search", "followup"].includes(m.intent));
  assert.ok(making.length >= 30);
  for (const m of making) assert.equal(route(m.q).live, undefined, m.q);
  // A drawing, a translation or a song in another language is guessed as today, never answered with a forecast.
  for (const m of B.ORDINARY_OTHER.filter((x) => x.intent !== "text")) assert.equal(route(m.q).guessed, true, m.q);
  assert.deepEqual(
    all.filter((m) => m.intent !== "clock" && route(m.q).live === "clock").map((m) => m.q),
    [],
  );
  assert.ok(all.filter((m) => m.intent === "clock").every((m) => route(m.q).live === "clock"));
  // Known: two questions about weather words, answered in words anyway (see weather-words.test.ts).
  assert.deepEqual(
    all.filter((m) => m.intent !== "weather" && route(m.q).live === "weather").map((m) => m.q),
    ["आम का मौसम कब आता है?", "天气预报的原理是什么？"],
  );
  // After an app, the edits stay edits (one already went to Image before the forecast: "make the weather icon bigger").
  for (const m of A.AFTER_APP) {
    const r = route(m.q, undefined, "app");
    if (m.intent === "weather") assert.equal(r.live, "weather", m.q);
    else if (m.q !== "make the weather icon bigger") assert.equal(r.engine, "app", m.q);
  }
});

test("live questions phrased as requests still go to Research as on main; only a whole question about a changing fact is added", () => {
  // Words about now and years, news, prices and scores: the web rule as on main, a request to write included.
  for (const m of [
    "Can you help me find out who the current president of Ghana is?",
    "Make a summary of today's headlines",
    "Please help, what's the current dollar rate in Nigeria?",
    "Could you help me check if the British Museum is open today?",
    "Tell me a quick update on today's Premier League results",
    "Help me understand what happened in the 2026 election",
    "Generate a briefing on the current situation in Sudan",
    "Who scored in the game yesterday?",
    "Write an Instagram post for today's sale",
    "Write a summary of today's news in Ghana",
    "What's the latest news about Tesla?",
  ]) {
    assert.equal(route(m).engine, "search", m);
  }
  // A whole question about a fact that changes, start to end.
  for (const m of [
    "What are the opening hours of the British Museum?",
    "Is Tesco open on Sunday?",
    "is the Louvre open now",
    "who is the president of France",
    "Who is the president of the senate in Nigeria?",
    "how much is one dollar in naira",
    "How much is a dollar in naira?",
    "Is there a hurricane coming to Florida?",
    "Any hurricane warnings for Florida?",
  ]) {
    assert.equal(route(m).engine, "search", m);
  }
  // Anything longer or different is routed as on main: to the guess.
  for (const m of [
    "Write a short story about a hurricane hitting a small fishing town",
    "Write an Instagram post announcing our new opening hours",
    "Create a flyer with our new opening hours",
    "Write a WhatsApp message to customers about our closing time changing",
    "What's closing time at most banks in Nigeria?",
    "Why do hurricanes hit Florida?",
    "What should I do if a tornado is coming?",
    "How should I prepare if a cyclone is coming?",
    "Tips for staying safe when a hurricane is heading your way",
    "hurricane evacuation tips",
    "What do I pack if a wildfire is near my home?",
    "My character hears the flood warning siren, continue the story",
    "What does a flood warning mean?",
    "What is a hurricane watch?",
    "What's the difference between a tornado watch and a tornado warning?",
    "How much is one euro in dollars at 1.08?",
    "How much is a pound in naira at 2000 naira per pound?",
    "How much is a dollar in pesos if the rate is 18?",
    "Who is the president of the USA in the movie Independence Day?",
    "Who is the king of pop?",
    "When is the next Arsenal match?",
  ]) {
    const r = route(m);
    assert.deepEqual([r.engine, r.guessed], ["text", true], m);
  }
});

test("after an app or deck, only an unmistakable forecast question is answered; anything else is the change, as on main", () => {
  for (const previous of ["app", "slides"] as const) {
    for (const m of [
      "chance of rain should be a percentage",
      "temperature in Celsius please",
      "the hourly forecast is cut off",
      "Weather for London doesn't load",
      // Feedback that starts like a question.
      "is it raining shows false",
      "how hot is it label is cut off on mobile",
      "do I need an umbrella should be a big yes or no",
      "how hot is it in Lagos shows 300 degrees, it's in Kelvin",
      // Terse, with no question: it may be about the build.
      "give me the weather in Paris",
      "weather in Accra",
      "rain tomorrow in Lagos",
      "5 day forecast for Toronto",
    ]) {
      const r = route(m, undefined, previous);
      // The change, unless the guess, which sees the build, reads it otherwise.
      assert.deepEqual([r.engine, r.guessed, r.captured, r.live], [previous, true, true, undefined], m);
    }
    for (const m of ["can you show me the weather in Accra?", "what's the weather in Accra?", "how hot is it in Lagos", "Should I bring an umbrella tomorrow in London?"]) {
      const r = route(m, undefined, previous);
      assert.deepEqual([r.engine, r.live, r.about], ["text", "weather", previous], m);
    }
    for (const m of ["show the temperature in Celsius", "add a weather widget to the header", "let the user pick the city", "make the header blue"]) {
      assert.deepEqual([route(m, undefined, previous).engine, route(m, undefined, previous).captured], [previous, undefined], m);
    }
  }
});

test("programming questions about weather data go where they did on main; Java the island and a church program get the forecast; Bugün isn't a bug", () => {
  for (const m of [
    "Debug: weather in Tokyo returns 404 from OpenWeather",
    "In TypeScript, how do I type the weather forecast for Paris response?",
    "The weather in Lagos endpoint times out in my Django view",
    "My python script that fetches the weather in London crashes",
    "Why is the chance of rain null in my Swift model?",
    "what time is it in python",
  ]) {
    assert.deepEqual([route(m).engine, route(m).live], ["code", undefined], m);
  }
  for (const m of [
    "Parse this JSON forecast for Berlin in Go",
    "How do I cache the weather forecast for Paris in Redis?",
    "In Flutter, how do I show the forecast for Lagos?",
    "How do I show the weather in London in my Vue component?",
    "Why does my Next.js page show the temperature in Tokyo as undefined?",
    "In Laravel, how do I store the weather in Accra?",
    "The forecast for Paris request returns 401, what's wrong with my token?",
  ]) {
    assert.deepEqual([route(m).engine, route(m).guessed, route(m).live], ["text", true, undefined], m);
  }
  for (const m of ["Will it rain in Java tomorrow?", "Is it going to rain at the Taylor Swift concert tonight?", "Will it rain during our church program on Sunday?", "Will it be sunny at Ruby's wedding on Saturday?", "Bugün Ankara'da hava nasıl?"]) {
    assert.equal(route(m).live, "weather", m);
  }
  // Everyday Turkish with "Bugün" (today) isn't Code; a bug is.
  for (const m of ["Bugün ne yapsam?", "Bugün yağmur hakkında bir şiir yaz", "Bugün doğum günüm, anneme bir mesaj yaz", "Bugünkü toplantı için bir gündem hazırla"]) {
    assert.notEqual(route(m).engine, "code", m);
  }
  for (const m of ["Bugün Python'da bir bug buldum", "Bugün bu kodu debug etmem lazım", "fix this bug in my python script", "fix this c++ code", "what does this ```code``` do"]) {
    assert.equal(route(m).engine, "code", m);
  }
});

test("spoken: words about now are talk only when no web rule is left once they are taken out", () => {
  for (const m of ["Who is the current president of Ghana?", "What are the recent changes to UK visa rules?", "Will it be cheaper to rent or buy in 2027?", "What's the current inflation in Nigeria?"]) {
    assert.equal(route(m, undefined, undefined, { spoken: true }).engine, "search", m);
  }
  for (const m of ["how are you today?", "I'm tired right now", "what are you doing tonight?"]) {
    assert.deepEqual([route(m, undefined, undefined, { spoken: true }).engine, route(m, undefined, undefined, { spoken: true }).answersOnly], ["text", true], m);
  }
});

test("a short follow-up to a forecast question: a bare one is a hint the guess can override; other messages are left alone", () => {
  const earlier = "Will it rain tomorrow in London?";
  for (const m of ["and tonight?", "and today?", "what about tonight?", "and this week?", "and right now?", "what about later today?", "and tomorrow?", "what about Saturday?", "tomorrow?", "and in Abuja?"]) {
    for (const spoken of [false, true]) {
      const r = followsForecast(route(m, undefined, "text", { spoken }), m, earlier);
      assert.deepEqual([r.engine, r.guessed, r.hint, r.followUp, r.live], ["text", true, "weather", true, undefined], `${m} ${spoken}`);
    }
  }
  // Searches stay searches, and other short messages get nothing.
  for (const m of [
    "Search for cheap flights to Paris",
    "Who won the Arsenal game today?",
    "latest news on the tube strike?",
    "What's the bitcoin price today?",
    "Any news about the election?",
    "search the web for the best umbrellas",
    "look up the population of Lagos",
    "Who is the current UK prime minister?",
    "news today?",
    "Is the British Museum open today?",
    "and the latest news?",
    "what about the match today?",
    "thanks!",
    "make it shorter",
    "Write me a haiku",
    "and tonight?",
  ]) {
    const r = route(m, undefined, "text");
    const before = m === "and tonight?" ? "Write a poem about London" : earlier;
    assert.deepEqual(followsForecast(r, m, before), r, m);
  }
  // With a file or a link, too long, or already decided by a rule: unchanged.
  for (const [m, attached] of [
    ["and tonight?", true],
    ["and tonight? https://example.com/events", false],
    ["and what's on tonight at the theatres and the cinemas near the river?", false],
    ["draw it as a watercolor", false],
    ["what's the weather in Paris tomorrow?", false],
  ] as const) {
    const r = route(m, undefined, "text");
    assert.deepEqual(followsForecast(r, m, earlier, attached), r, m);
  }
});

test("after a forecast answered beside an app or deck, a bare follow-up that only says when or where goes on with the forecast", () => {
  const earlier = "Will it rain tomorrow in London?";
  for (const previous of ["app", "slides"] as const) {
    for (const m of ["and tomorrow?", "what about Saturday?", "and in Abuja?", "and tonight?", "how about next week?"]) {
      const r = followsForecast(route(m, undefined, previous), m, earlier, false, previous);
      assert.deepEqual([r.engine, r.hint, r.followUp, r.about], ["text", "weather", true, previous], m);
    }
    // Anything else is the change, as on main.
    for (const m of ["make the header blue", "and make the header blue", "add a 5 day forecast", "what about a dark mode?", "and bigger font", "in Fahrenheit please", "thanks!", "and the logo too", "tomorrow?", "Lagos", "in New York", "Book now", "Golden Crumb!"]) {
      assert.equal(followsForecast(route(m, undefined, previous), m, earlier, false, previous).engine, previous, m);
    }
  }
});

test("routing and the weather checks stay fast on 100,000-character hostile messages", () => {
  const N = 100_000;
  const hostile = [
    "what time is it " + " ".repeat(N) + "x",
    "prévisions ".repeat(N / 11),
    "weather in Paris ".repeat(N / 17),
    "is a open ".repeat(N / 10),
    "hurricane coming " + "a".repeat(N),
    "match " + "fixtures ".repeat(N / 9),
    "天" + "Aa ".repeat(N / 3) + "?",
    "Is it cold in " + "Aaaa ".repeat(N / 5) + "?",
    "temperature " + " ".repeat(N) + "?",
    "Weather in Aaa " + "? ".repeat(N / 2) + "x",
  ];
  // The fastest of three runs, so a slow moment of the test machine doesn't count; a pattern that
  // backtracks takes seconds here.
  const fastest = (f: () => unknown) =>
    Math.min(
      ...[0, 1, 2].map(() => {
        const start = performance.now();
        f();
        return performance.now() - start;
      }),
    );
  for (const m of hostile) {
    const label = JSON.stringify(m.slice(0, 24));
    assert.ok(fastest(() => route(m)) < 80, `route ${label}`);
    assert.ok(fastest(() => route(m, undefined, "app")) < 80, `route after an app ${label}`);
    assert.ok(fastest(() => route(m, undefined, "text", { spoken: true })) < 80, `spoken ${label}`);
    assert.ok(fastest(() => asksWeather(m)) < 20, `asksWeather ${label}`);
    assert.ok(fastest(() => weatherQuestion(m)) < 20, `weatherQuestion ${label}`);
    assert.ok(fastest(() => freeFacts({ message: m, inputChars: m.length })) < 20, `freeFacts ${label}`);
    assert.ok(fastest(() => followsForecast(route("and tonight?"), "and tonight?", m)) < 20, `followsForecast ${label}`);
  }
  // A precise question is short; a long message is never one.
  assert.equal(weatherQuestion("Will it rain tomorrow in London? " + "x".repeat(FIRM_MAX_CHARS)), false);
});
