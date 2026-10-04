import { test } from "node:test";
import assert from "node:assert/strict";
import { pickVoice } from "../src/lib/voices.ts";

const name = (message: string) => pickVoice(message).voice.name;

test("voice-overs pick a voice from how the request asks for it", () => {
  assert.equal(name('Say "Welcome to Crumb Bakery"'), "Rachel", "nothing asked: the default");
  assert.equal(name('Read this in a deep man\'s voice: "Welcome"'), "Brian");
  assert.equal(name('Read this aloud in a British man\'s voice: "Welcome"'), "George");
  assert.equal(name("Voice-over in a calm British woman's voice: Welcome to the spa"), "Alice");
  assert.equal(name("Narrate with an Australian accent: G'day"), "Charlie");
  assert.equal(name('Use Daniel to read: "Breaking news"'), "Daniel");
  assert.equal(name("Read aloud like a male news anchor, British: Tonight's headlines"), "Daniel");
  assert.equal(name("Read this in an upbeat young woman's voice: Big sale today"), "Laura");
});

test("the words being read never choose the voice", () => {
  assert.equal(name('Say "Happy birthday George, you deep old man"'), "Rachel");
  assert.equal(name("Read aloud: The British man walked his dog slowly"), "Rachel");
  assert.equal(pickVoice("Read aloud: The British man walked his dog slowly").speed, 1);
});

test("speed follows slow and fast, and a named voice from an app wins", () => {
  assert.equal(pickVoice('Read this slowly: "Breathe in"').speed, 0.85);
  assert.equal(pickVoice('Say it fast: "Limited time offer"').speed, 1.15);
  assert.equal(pickVoice("anything", "lily").voice.name, "Lily");
});

test("asking for a voice or a reading speed goes to the voice engine", async () => {
  const { route } = await import("../src/lib/router.ts");
  assert.equal(route('Read this in a deep man\'s voice: "Welcome"').engine, "voice");
  assert.equal(route('Read this slowly: "Breathe in"').engine, "voice");
  assert.notEqual(route("What voice actor plays Shrek? Read me the answer").engine, "voice");
});
