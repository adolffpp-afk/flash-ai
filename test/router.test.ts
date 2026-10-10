import { test } from "node:test";
import assert from "node:assert/strict";
import { checksSpoken, route, spokenFollowUp, takesGuess, textToSpeak, wantsAudioFile } from "../src/lib/router.ts";

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

test("in a voice conversation, reading out the news, the weather or a price looks it up", () => {
  for (const m of [
    "read me the latest news out loud",
    "can you read the weather forecast out loud",
    "say the price of bitcoin today",
    "say what's the weather like in paris right now",
  ]) {
    assert.equal(route(m).engine, "voice", `typed: ${m}`);
    assert.equal(route(m, undefined, undefined, { spoken: true }).engine, "search", m);
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

test("spoken small talk about today isn't a web search; today's news and weather are", () => {
  for (const m of ["How are you today?", "I'm feeling sad today", "what are you doing right now", "I'm so tired today", "what should I cook tonight"]) {
    assert.equal(route(m).engine, "search", `typed: ${m}`);
    const r = route(m, undefined, undefined, { spoken: true });
    // Answered in words: the guess may still search, when the user can pay for that.
    assert.deepEqual([r.engine, r.guessed, r.answersOnly], ["text", true, true], m);
  }
  for (const m of ["what's the news today", "what's the weather like today", "is the pharmacy open right now", "who won the game last night", "what's the latest on the election"]) {
    assert.equal(route(m, undefined, undefined, { spoken: true }).engine, "search", m);
  }
});
