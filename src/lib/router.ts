import type { Engine } from "./types.ts";

export type RouteDecision = { engine: Engine; reason: string; guessed?: boolean };

const LANGUAGES =
  "english|french|spanish|portuguese|german|italian|dutch|arabic|chinese|mandarin|japanese|korean|hindi|russian|turkish|swahili|yoruba|igbo|hausa|zulu|amharic|polish|greek|hebrew|vietnamese|thai|indonesian|creole";

type Rule = { engine: Engine; reason: string; patterns: RegExp[]; unless?: RegExp };

// Checked in order: the most specific outputs first, plain writing last.
const RULES: Rule[] = [
  {
    engine: "transcribe",
    reason: "You asked for a transcript.",
    patterns: [/\b(transcribe|transcription|transcript)\b/i, /\bspeech to text\b/i],
  },
  {
    engine: "translate",
    reason: "You asked for a translation.",
    patterns: [
      /\btranslat(e|ion)\b/i,
      new RegExp(`\\b(say|write|put|convert)\\b.{0,60}\\b(in|into|to)\\s+(${LANGUAGES})\\b`, "i"),
      new RegExp(`\\bhow do (you|i) say\\b.{0,60}\\bin\\s+(${LANGUAGES})\\b`, "i"),
    ],
  },
  {
    engine: "slides",
    reason: "You asked for a slide deck.",
    patterns: [/\b(presentation|slide ?deck|slideshow|slides|pitch deck|keynote|powerpoint)s?\b/i],
  },
  {
    engine: "app",
    reason: "You asked Flash to build an app.",
    patterns: [
      /\b(build|create|make|generate|design|develop|prototype|code up|spin up)\b.{0,50}\b(app|application|web ?app|website|web ?site|site|landing page|home ?page|dashboard|portfolio|game|calculator|tracker|planner|online store|shop|quiz|timer|clone|crm|saas|mvp|prototype|booking system|to-?do list)s?\b/i,
    ],
    unless: /\b(spreadsheet|excel|csv|logo|icon|poster|song|jingle|video clip)\b/i,
  },
  {
    engine: "video",
    reason: "You asked for a video.",
    patterns: [
      /\b(generate|create|make|produce|render|animate)\b.{0,40}\b(video|clip|animation|footage|film|reel|trailer)s?\b/i,
      /\b(video|clip|animation) of\b/i,
      /^animate\b/i,
    ],
  },
  {
    engine: "music",
    reason: "You asked for music.",
    patterns: [
      /\b(compose|generate|create|make|produce|write)\b.{0,40}\b(song|music|melody|beat|jingle|soundtrack|tune|instrumental|track)s?\b/i,
      /\b(song|music|beat|jingle|soundtrack) (about|for|with)\b/i,
    ],
  },
  {
    engine: "image",
    reason: "You asked for a picture.",
    patterns: [
      /\b(draw|paint|sketch|illustrate)\b/i,
      /\b(generate|create|make|design|give me|render)\b.{0,40}\b(image|picture|photo|illustration|logo|poster|icon|artwork|wallpaper|drawing|banner|thumbnail)s?\b/i,
      /\b(image|picture|photo|logo|poster) of\b/i,
    ],
  },
  {
    engine: "voice",
    reason: "You asked for spoken audio.",
    patterns: [
      /\b(read|say|speak|narrate)\b.{0,30}\b(aloud|out loud)\b/i,
      /\b(text to speech|tts|voiceover|voice over|voice-over)\b/i,
      /\b(turn|convert|make)\b.{0,40}\b(into|to|as)\b.{0,10}\b(audio|speech|voice|mp3)\b/i,
      /^(say|speak|narrate)\b/i,
      /\b(read|say|speak|narrate)\b.{0,40}\b(voice|accent)\b/i,
      /^(please\s+)?read\b.{0,30}\b(slowly|quickly|fast|calmly)\b/i,
    ],
  },
  {
    engine: "code",
    reason: "This is a programming task.",
    patterns: [
      /```/,
      /\b(python|javascript|typescript|java|c\+\+|c#|golang|rust|php|ruby|kotlin|swift|sql|html|css|bash|regex|react|node\.?js|django|flask)\b/i,
      /\b(code|function|script|api|endpoint|algorithm|bug|debug|stack trace|compile|refactor|unit test|program)\b/i,
    ],
  },
  {
    engine: "docs",
    reason: "This is document or spreadsheet work.",
    patterns: [
      /\b(spreadsheet|excel|google sheets?|csv|table|budget|invoice|pivot|formula)s?\b/i,
      /\b(resume|cv|cover letter|report|proposal|contract|memo|business plan|meeting notes|agenda|outline|template)s?\b/i,
      /\bsummari[sz]e\b.{0,30}\b(document|pdf|file|report)\b/i,
    ],
  },
  {
    engine: "search",
    reason: "This needs fresh information from the web.",
    patterns: [
      /https?:\/\/\S+/i,
      /\b(latest|today|tonight|yesterday|this week|this month|right now|currently|current|recent|breaking)\b/i,
      /\b(news|price of|stock price|exchange rate|weather|score|release date|who won)\b/i,
      /\b(search|look up|google|find sources|with sources|cite|citations)\b/i,
      /\b20(2[5-9]|3\d)\b/,
    ],
  },
];

const AUDIO_TYPE = /^(audio|video)\//;
const SHEET_TYPE = /(csv|spreadsheet|excel)/i;
// Photos Flash can edit.
export const EDITABLE_TYPE = /^image\/(png|jpeg|webp)$/;
// Questions about a photo, which the writing model answers.
const ABOUT_PHOTO = /^\s*(what|who|where|why|which|when|how (many|much|old)|describe|explain|tell me|read|is|are|does|do)\b/i;
// Asking to change an attached photo, rather than asking about it.
const EDIT_REQUEST =
  /\b(edit|retouch|remove|erase|replace|swap|add|put|change|turn (it|this|me|us|them|him|her)|make (it|this|me|us|them|him|her|the)|transform|convert|restore|colou?ri[sz]e|enhance|upscale|sharpen|blur|background|cartoon\w*|anime|pixar|ghibli|sketch|painting|style|filter|headshot|brighter|darker)\b/i;

// Asking for an attached photo to move: it becomes a video.
const ANIMATE_REQUEST =
  /\b(animate\w*|bring (it|this|her|him|them|the \w+) to life|come alive|make (it|this|them|her|him|the \w+) (move|moving|walk|dance|talk|blink|smile and wave)|into an? (video|clip|animation)|video (of|from) (it|this)|moving (photo|picture|image)|live photo|cinemagraph)\b/i;

// Engines whose answers are general enough that a follow-up may really be an edit to the last build.
const GENERAL: Engine[] = ["text", "code", "docs"];

/**
 * Picks the engine for a request with deterministic keyword rules. When the previous
 * reply was an app or deck, a general follow-up ("make the header blue") edits it.
 */
export function route(message: string, attachmentType?: string, previous?: Engine): RouteDecision {
  const decision = routeOne(message, attachmentType);
  if ((previous === "app" || previous === "slides") && GENERAL.includes(decision.engine) && !attachmentType) {
    return { engine: previous, reason: previous === "app" ? "Updating your app." : "Updating your slides." };
  }
  return decision;
}

function routeOne(message: string, attachmentType?: string): RouteDecision {
  const text = message.trim();
  if (attachmentType && AUDIO_TYPE.test(attachmentType)) {
    return { engine: "transcribe", reason: "An audio or video file is attached, so Flash transcribes it." };
  }
  if (attachmentType && EDITABLE_TYPE.test(attachmentType) && ANIMATE_REQUEST.test(text) && !ABOUT_PHOTO.test(text)) {
    return { engine: "video", reason: "A photo is attached and you asked to bring it to life." };
  }
  if (attachmentType && EDITABLE_TYPE.test(attachmentType) && EDIT_REQUEST.test(text) && !ABOUT_PHOTO.test(text)) {
    return { engine: "image", reason: "A photo is attached and you asked to change it." };
  }
  for (const rule of RULES) {
    // An attached file is read by a text engine, so media-making rules don't apply to it.
    if (attachmentType && ["video", "music", "image", "voice", "search", "app", "slides"].includes(rule.engine)) continue;
    if (rule.unless?.test(text)) continue;
    if (rule.patterns.some((p) => p.test(text))) return { engine: rule.engine, reason: rule.reason };
  }
  if (attachmentType) {
    return SHEET_TYPE.test(attachmentType)
      ? { engine: "docs", reason: "A spreadsheet is attached." }
      : { engine: "text", reason: "A file is attached, so the writing model reads it." };
  }
  // No rule matched: the caller may ask a small model to decide.
  return { engine: "text", reason: "Writing and reasoning task.", guessed: true };
}

/** Strips the instruction part of a voice request, keeping the words to speak. */
export function textToSpeak(message: string): string {
  const quoted = message.match(/["“]([\s\S]+?)["”]/);
  if (quoted) return quoted[1].trim();
  const afterColon = message.split(":");
  if (afterColon.length > 1) return afterColon.slice(1).join(":").trim();
  return message.replace(/^(please\s+)?(say|speak|narrate|read( this)?( aloud| out loud)?)\s*/i, "").trim() || message;
}
