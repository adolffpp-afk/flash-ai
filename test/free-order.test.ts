import { test } from "node:test";
import assert from "node:assert/strict";
import { LONG_INPUT_CHARS, freeFacts, freeOrder, looksEnglish } from "../src/lib/free-order.ts";
import { A, B } from "./fixtures/weather-messages.ts";

// The usual order, and the providers that take tools (Cloudflare's are off until checked live).
const BASE = ["groq", "gemini", "openrouter", "cloudflare", "mistral"] as const;
const TOOLS = ["groq", "gemini", "mistral"] as const;
const order = (facts: Parameters<typeof freeOrder>[0]) => freeOrder(facts, BASE, TOOLS);

test("Groq leads for short questions, maths and code; Gemini for long inputs and other languages; the rest keep their order", () => {
  assert.deepEqual(order({ short: true }), ["groq", "gemini", "openrouter", "cloudflare", "mistral"]);
  assert.deepEqual(order({ technical: true }), ["groq", "gemini", "openrouter", "cloudflare", "mistral"]);
  assert.deepEqual(order({ long: true }), ["gemini", "groq", "openrouter", "cloudflare", "mistral"]);
  assert.deepEqual(order({ foreign: true, short: true }), ["gemini", "groq", "openrouter", "cloudflare", "mistral"]);
  // Maths or code in another language stays on the fastest; a long input goes to Gemini whatever it is.
  assert.deepEqual(order({ foreign: true, technical: true }), ["groq", "gemini", "openrouter", "cloudflare", "mistral"]);
  assert.deepEqual(order({ long: true, technical: true }), ["gemini", "groq", "openrouter", "cloudflare", "mistral"]);
  // Anything else: the usual order.
  assert.deepEqual(order({}), [...BASE]);
});

test("with the forecast tool, the providers that take tools come first, each group in its order", () => {
  assert.deepEqual(order({ weather: true, short: true }), ["groq", "gemini", "mistral", "openrouter", "cloudflare"]);
  assert.deepEqual(order({ weather: true, foreign: true }), ["gemini", "groq", "mistral", "openrouter", "cloudflare"]);
  // Once Cloudflare's tools are switched on, it joins them.
  assert.deepEqual(freeOrder({ weather: true }, BASE, [...TOOLS, "cloudflare"]), ["groq", "gemini", "cloudflare", "mistral", "openrouter"]);
});

test("the order only reorders: every provider is still tried once, and none is added", () => {
  const facts = [{}, { long: true }, { foreign: true }, { technical: true }, { short: true }, { weather: true }, { long: true, weather: true, foreign: true }];
  for (const f of facts) assert.deepEqual([...order(f)].sort(), [...BASE].sort(), JSON.stringify(f));
  // A provider missing from the usual list never leads.
  assert.deepEqual(freeOrder({ long: true }, ["groq", "openrouter"], TOOLS), ["groq", "openrouter"]);
});

test("the facts come from the request: its size, the language of the message or the answers, sums and code", () => {
  const facts = (message: string, more: Partial<Parameters<typeof freeFacts>[0]> = {}) => freeFacts({ message, inputChars: message.length, ...more });
  assert.deepEqual(facts("What's the capital of Peru?"), { long: false, foreign: false, technical: false, short: true, weather: false });
  assert.equal(facts("Write me a cover letter", { inputChars: LONG_INPUT_CHARS + 1 }).long, true);
  assert.equal(facts("¿Cómo puedo ahorrar dinero cada mes?").foreign, true);
  assert.equal(facts("Explain inflation", { language: "fr" }).foreign, true, "answers set to French");
  assert.equal(facts("Explain inflation", { language: "en" }).foreign, false);
  assert.equal(facts("What's 15% tip on $86?").technical, true);
  assert.equal(facts("why does this loop never end", { code: true }).technical, true);
  assert.equal(facts("Will it rain tomorrow?", { weather: true }).weather, true);
  assert.equal(facts("x".repeat(200)).short, false);
});

test("English is told from Flash's other languages on the message sets", () => {
  const english = [...A.EVERYDAY.slice(0, 60), ...B.ORDINARY_EN, ...A.WEATHER.slice(0, 35)];
  const other = [...A.EVERYDAY.slice(60), ...B.ORDINARY_OTHER, ...A.WEATHER.slice(35)];
  assert.deepEqual(english.filter((m) => !looksEnglish(m.q)).map((m) => m.q), []);
  assert.deepEqual(other.filter((m) => looksEnglish(m.q)).map((m) => m.q), []);
  // Too short to tell: the usual order.
  assert.equal(looksEnglish("hi"), true);
  assert.equal(looksEnglish("12 * 7"), true);
});
