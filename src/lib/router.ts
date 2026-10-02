import type { Engine } from "./types.ts";

export type RouteDecision = { engine: Engine; reason: string };

const IMAGE_PATTERNS = [
  /\b(draw|paint|sketch|illustrate|render)\b/i,
  /\b(generate|create|make|design|give me)\b.{0,40}\b(image|picture|photo|illustration|logo|poster|icon|artwork|wallpaper|drawing)s?\b/i,
  /\b(image|picture|photo|logo|poster) of\b/i,
];

const VOICE_PATTERNS = [
  /\b(read|say|speak|narrate)\b.{0,30}\b(aloud|out loud)\b/i,
  /\b(text to speech|tts|voiceover|voice over|voice-over)\b/i,
  /\b(turn|convert|make)\b.{0,40}\b(into|to|as)\b.{0,10}\b(audio|speech|voice|mp3)\b/i,
  /^(say|speak|narrate)\b/i,
];

const SEARCH_PATTERNS = [
  /\b(latest|today|tonight|yesterday|this week|this month|right now|currently|current|recent|breaking)\b/i,
  /\b(news|price of|stock price|weather|score|release date|who won)\b/i,
  /\b(search|look up|google|find sources|with sources|cite|citations)\b/i,
  /\b20(2[5-9]|3\d)\b/,
];

/**
 * Picks the engine for a request. Deterministic keyword rules, checked from
 * the most specific output (image, voice) to the most general (text), so a
 * request is only sent to a costlier engine when it clearly asks for one.
 */
export function route(message: string, hasAttachment = false): RouteDecision {
  const text = message.trim();
  if (hasAttachment) {
    return { engine: "text", reason: "A file is attached, so the writing model reads it." };
  }
  if (IMAGE_PATTERNS.some((p) => p.test(text))) {
    return { engine: "image", reason: "You asked for a picture." };
  }
  if (VOICE_PATTERNS.some((p) => p.test(text))) {
    return { engine: "voice", reason: "You asked for spoken audio." };
  }
  if (SEARCH_PATTERNS.some((p) => p.test(text))) {
    return { engine: "search", reason: "This needs fresh information from the web." };
  }
  return { engine: "text", reason: "Writing and reasoning task." };
}

/** Strips the instruction part of a voice request, keeping the words to speak. */
export function textToSpeak(message: string): string {
  const quoted = message.match(/["“]([\s\S]+?)["”]/);
  if (quoted) return quoted[1].trim();
  const afterColon = message.split(":");
  if (afterColon.length > 1) return afterColon.slice(1).join(":").trim();
  return message.replace(/^(please\s+)?(say|speak|narrate|read( this)?( aloud| out loud)?)\s*/i, "").trim() || message;
}
