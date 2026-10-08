import type { Engine } from "./types.ts";
import { POST_PACK_REQUEST } from "./models.ts";

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
    // Before video and app, which "with a video" or "for my website" would match too.
    engine: "image",
    reason: "You asked for a social post pack.",
    patterns: [POST_PACK_REQUEST],
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
// Pictures Claude can read.
const PHOTO_TYPE = /^image\/(png|jpeg|gif|webp)$/;
// Questions about a photo, which the writing model answers.
const ABOUT_PHOTO = /^\s*(what|who|where|why|which|when|how (many|much|old)|describe|explain|tell me|read|is|are|does|do)\b/i;
// Asking to change an attached photo, rather than asking about it, in the everyday words people
// use with ChatGPT: "give him sunglasses", "fix the lighting", "he should be wearing a suit".
const EDIT_REQUEST = new RegExp(
  [
    String.raw`\b(edit|retouch|photoshop|remove|erase|delete|replace|swap|add(?! up\b)|put|place|change|transform|convert|restore|colou?ri[sz]e|recolou?r|enhance|upscale|sharpen|blur|brighten|darken|lighten|relight|crop|zoom (in|out)|dye)\b`,
    String.raw`\bfix (the|its|his|her|their) (lighting|light|colou?rs?|exposure|contrast|white balance|red ?eyes?|shadows?|glare|blur|skin|teeth|hair|background)\b`,
    String.raw`\bfix (this|the|my) (photo|picture|image|pic|selfie)\b`,
    String.raw`\b(turn|make) (it|this|that|me|us|them|him|her|the|my|his|their)\b`,
    String.raw`\b(make|create|turn|design)\b[\s\S]{0,40}\b(from|out of|using|based on) (it|this|that|the (picture|image|photo|pic))\b`,
    String.raw`\bgive (him|her|them|the \w+)\b`,
    String.raw`\blet (me|him|her|them|us) (be|have|wear|look|hold|stand|sit)\b`,
    String.raw`\b(wear|wears|wearing|dressed (up )?(as|in)|should (be|have|look|wear|hold))\b`,
    String.raw`\b(background|cartoon\w*|anime|pixar|ghibli|sketch|painting|watercolou?r|oil paint\w*|pencil drawing|comic book|pixel art|black (and|&) white|sepia|vintage look|cinematic|style|filter|headshot|passport photo|profile (picture|photo)|brighter|darker|lighter|warmer|cooler|older|younger|smiling|haircut|hairstyle)\b`,
    // A short follow-up that only makes sense about a picture: "more red", "less busy", "without the text".
    String.raw`^\s*(now |and |also |but |ok,? |okay,? )?(a bit |a little |slightly |much |even |way )?((more|less)(?! than\b)|bigger|smaller|without)\b`,
  ].join("|"),
  "i",
);

// Asking for a new picture after one Flash made ("another one", "draw me a dragon"), rather than a
// change to that one. A request that points back at the picture ("a poster from it") is a change.
const NEW_PICTURE = new RegExp(
  [
    String.raw`\b(new|another|different|second|separate|fresh)\b[\s\S]{0,30}\b(picture|image|photo|pic|drawing|painting|logo|poster|one|version|design)s?\b`,
    String.raw`\b(try again|regenerate|redo|re-?roll|start over|from scratch|variations?|more like (this|it))\b`,
    String.raw`\b(make|create|generate|draw|design|paint|give) (me |us )?(a|an|some|\d+)\b(?![\s\S]*\b(from|of|with|using|based on) (it|this|that|the (picture|image|photo|pic|one))\b)`,
  ].join("|"),
  "i",
);

// Engines a request goes to on its own words, whatever picture came before: "make it into a song".
const NOT_ABOUT_THE_PICTURE: Engine[] = ["app", "slides", "music", "voice", "search", "transcribe", "translate", "code"];

// A screenshot, sketch or design photo to rebuild as a working app or website, rather than a
// picture to change. Checked before the photo-editing rules, which "turn this into…" also matches.
const BUILD_FROM_PHOTO = new RegExp(
  [
    String.raw`\b(build|make|create|code|turn|convert|recreate|replicate|clone|copy|rebuild|redesign|design|develop|prototype)\b[\s\S]{0,60}\b(web ?app|application|app|web ?site|website|site|web ?page|landing page|home ?page|page|dashboard|html|working code|code|online (store|shop)|prototype)s?\b`,
    String.raw`\b(screenshot|screen shot|sketch|drawing|mock-?up|wireframe|design|figma)\b[\s\S]{0,40}\b(into|to|as)\b[\s\S]{0,30}\b(app|site|website|page|html|code)s?\b`,
  ].join("|"),
  "i",
);
// The same, for a slide deck made from what's in the picture.
const DECK_FROM_PHOTO =
  /\b(build|make|create|turn|convert|recreate|design|write|put|into)\b[\s\S]{0,40}\b(presentation|slide ?deck|slideshow|slides|pitch deck|powerpoint)s?\b/i;

// Asking for the words in a photo (a receipt, a menu, a handwritten note) as text or a spreadsheet,
// rather than to change the picture: "copy the text", "turn this into a spreadsheet", "transcribe it".
const READ_TEXT = new RegExp(
  [
    String.raw`\b(ocr|transcribe|transcription)\b`,
    String.raw`\b(read|copy|extract|type (out|up)|write (out|down)|pull( out)?|grab|scan|digiti[sz]e|list)\b[\s\S]{0,40}\b(text|words|writing|handwriting|numbers|prices|items|amounts|totals?|receipts?|notes?|menus?|pages?|documents?|letters?|tables?)\b`,
    String.raw`\b(into|to|as)\s+(an?\s+)?(spreadsheet|excel( sheet)?|google sheets?|csv|table|plain text|text|word( document)?|document|list)\b`,
    String.raw`\b(spreadsheet|excel|csv|google sheets?)\b`,
  ].join("|"),
  "i",
);

// Asking for an attached photo to move: it becomes a video.
const ANIMATE_REQUEST =
  /\b(animate\w*|bring (it|this|her|him|them|the \w+) to life|come alive|make (it|this|them|her|him|the \w+) (move|moving|walk|dance|talk|blink|smile and wave)|(make|turn) (it|this|them|her|him) (into )?an? (video|clip|animation)|into an? (video|clip|animation)|video (of|from) (it|this)|moving (photo|picture|image)|live photo|cinemagraph)\b/i;

/**
 * Whether a message, sent with nothing attached right after Flash made a picture, asks to change
 * that picture ("make it darker", "add a hat", "now put him on a beach") or to bring it to life.
 * When it does, the picture goes with the message, so it's edited the way an attached photo is.
 */
export function pictureFollowUp(message: string): boolean {
  const text = message.trim();
  if (!text || ABOUT_PHOTO.test(text) || NEW_PICTURE.test(text)) return false;
  if (NOT_ABOUT_THE_PICTURE.includes(routeOne(text).engine)) return false;
  const withPicture = routeOne(text, "image/png").engine;
  return withPicture === "image" || withPicture === "video";
}

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
  // Reading a photo's text goes to Docs & Sheets, which gives tables as spreadsheets. Checked first, since
  // "turn this into a spreadsheet" would otherwise read as a photo edit.
  if (attachmentType && PHOTO_TYPE.test(attachmentType) && READ_TEXT.test(text)) {
    return { engine: "docs", reason: "Flash reads the text in your photo." };
  }
  // A picture of a screen, a sketch or a design, to rebuild as something that works.
  if (attachmentType && PHOTO_TYPE.test(attachmentType) && !ABOUT_PHOTO.test(text)) {
    if (DECK_FROM_PHOTO.test(text)) return { engine: "slides", reason: "Flash builds a deck from your picture." };
    if (BUILD_FROM_PHOTO.test(text)) return { engine: "app", reason: "Flash builds this from your picture." };
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
