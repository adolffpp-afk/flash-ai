import type { Engine } from "./types.ts";

/*
 * Prompt Helper: one tap in the message box turns a short idea into a strong prompt, written into
 * the box for the user to change before sending. It runs on the level picked for the next message
 * and is priced like a short message on it, by what the call really cost; with too few credits it
 * runs on the free lane as one of the day's free messages. It writes the prompt, never the answer.
 */

// The longest idea it reads, and the most it writes: a prompt of a few hundred words.
export const IDEA_CHARS = 2000;
export const HELPER_TOKENS = 1000;
// Shorter than this there's nothing to work from.
export const MIN_IDEA_CHARS = 3;

/** What a prompt can be for: a tool in the message box, or Infinity AI Studio's story or ad. */
export type HelperTool = Engine | "auto" | "story" | "ad";
export const STUDIO_TARGETS = ["story", "ad"] as const;

// What the prompt is for, by the tool picked in the message box (or the Studio's mode).
const TARGETS: Partial<Record<HelperTool, string>> = {
  search:
    "a research assistant that searches the web and cites its sources. Say what to find out, which questions to answer, how recent the sources should be, and how to lay out the findings",
  code: "a coding assistant. Say the language or framework, what the code must do, its inputs and outputs, edge cases, and whether to explain it",
  translate: "a translator. Say the target language, the tone and who will read it, and keep the text to translate exactly as the user wrote it",
  docs: "an assistant that makes documents and spreadsheets. Say the kind of document, its sections or columns, the data to put in, and the format",
  app: "an app and website builder. Describe the pages, what each does, the main features, who uses it, the look (colours, style) and the words on it",
  slides: "a slide deck maker. Say the topic, the audience, about how many slides, what each covers, and the style",
  image:
    "an image generator. Describe the subject, the setting, the composition, the style or medium, the lighting, the colours and the mood, in one paragraph",
  video: "a video generator. Describe the scene, the action, the camera movement, the lighting, the style and the sound, in one paragraph",
  music: "a music generator. Say the genre, the mood, the tempo, the instruments, the vocals, and what the lyrics are about if it has any",
  voice: "a voice-over. Give the exact words to read, with the tone and pace",
  story:
    "a story film maker that films a short drama in parts, with characters who speak. Say the kind of story, where and when it happens, the main characters (a name, age, look and what each wants), the conflict, the mood, a turn or twist, and how this part ends so viewers want the next one, in one paragraph. Don't write the script or the dialogue",
  ad: "a video ad maker. Say the product or business, who the ad is for, the main message or offer, the setting and look of the scenes, the mood and the music, what the voiceover says, and what viewers should do at the end, in one paragraph",
};
const GENERAL =
  "an AI assistant. Say the goal, the context it needs, who it's for, what to include, the format, the tone and about how long the answer should be";

/** The instructions for the helper, for the tool the prompt is for. */
export function helperSystem(tool: HelperTool): string {
  return [
    "You are Flash's Prompt Helper. The user typed a short idea in their message box.",
    `Rewrite it as one clear, detailed prompt they will send to ${TARGETS[tool] ?? GENERAL}.`,
    "Keep everything they asked for and don't change what they meant. Add only what makes the request clearer and more complete;",
    "where a detail only the user can know is missing, leave a short placeholder in square brackets, like [your city].",
    "Write it as the user speaking, in the same language the user wrote in. Don't answer it or carry it out.",
    "Reply with the prompt only, under 250 words: no title, no quotes around it, no notes before or after it.",
  ].join(" ");
}

/** The idea from a request body: its words, cut to IDEA_CHARS, or null when there's too little to work from. */
export function cleanIdea(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const idea = value.trim().slice(0, IDEA_CHARS);
  return idea.length >= MIN_IDEA_CHARS ? idea : null;
}

/** The prompt from the helper's reply, without quotes or a "Prompt:" label a model may wrap it in. */
export function cleanPrompt(text: string): string {
  let out = text.trim().replace(/^(?:\*\*)?(?:improved |rewritten )?prompt(?:\*\*)?\s*:\s*(?:\*\*)?\s*/i, "");
  const quoted = /^(["“'`]{1,3})([\s\S]+)\1$|^“([\s\S]+)”$/.exec(out);
  if (quoted) out = (quoted[2] ?? quoted[3]).trim();
  return out;
}
