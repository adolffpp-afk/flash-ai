import { textToSpeak } from "./router.ts";

type Gender = "woman" | "man" | "neutral";
export type Voice = { name: string; gender: Gender; accent: string; traits: string[]; about: string };

const v = (name: string, gender: Gender, accent: string, traits: string[]): Voice => ({
  name,
  gender,
  accent,
  traits,
  about: `${traits[0]} ${accent} ${gender === "neutral" ? "voice" : gender}`,
});

/** The voices fal.ai's ElevenLabs Turbo v2.5 offers. The first of each kind is the one used when only that kind is asked for. */
export const VOICES: Voice[] = [
  v("Rachel", "woman", "American", ["calm", "clear"]),
  v("Aria", "woman", "American", ["expressive", "husky"]),
  v("Sarah", "woman", "American", ["soft", "young", "gentle"]),
  v("Laura", "woman", "American", ["upbeat", "young", "cheerful", "energetic"]),
  v("Matilda", "woman", "American", ["warm", "friendly"]),
  v("Jessica", "woman", "American", ["playful", "young", "expressive"]),
  v("Alice", "woman", "British", ["confident", "clear", "news"]),
  v("Lily", "woman", "British", ["warm", "velvety"]),
  v("Charlotte", "woman", "Swedish", ["smooth", "soft"]),
  v("Roger", "man", "American", ["confident", "casual"]),
  v("Brian", "man", "American", ["deep", "resonant", "narration"]),
  v("Eric", "man", "American", ["friendly", "smooth"]),
  v("Chris", "man", "American", ["casual", "natural"]),
  v("Liam", "man", "American", ["articulate", "young"]),
  v("Will", "man", "American", ["friendly", "young", "upbeat", "cheerful"]),
  v("Bill", "man", "American", ["trustworthy", "old", "calm"]),
  v("George", "man", "British", ["warm", "storytelling", "narration"]),
  v("Daniel", "man", "British", ["authoritative", "news", "deep"]),
  v("Charlie", "man", "Australian", ["casual", "natural", "friendly"]),
  v("Callum", "man", "Transatlantic", ["intense", "dramatic", "husky"]),
  v("River", "neutral", "American", ["calm", "relaxed"]),
];

export const DEFAULT_VOICE = VOICES[0];

const GENDER: [RegExp, Gender][] = [
  [/\b(wom[ae]n'?s?|female|girl|lady|ladies|feminine)\b/i, "woman"],
  [/\b(m[ae]n'?s?|male|guy|boy|masculine|gentleman)\b/i, "man"],
  [/\b(neutral|non-?binary|androgynous)\b/i, "neutral"],
];
const ACCENTS: [RegExp, string][] = [
  [/\b(british|english|uk|london|posh)\b/i, "British"],
  [/\b(australian|aussie)\b/i, "Australian"],
  [/\b(american)\b/i, "American"],
  [/\b(swedish|scandinavian)\b/i, "Swedish"],
  [/\b(transatlantic|mid-atlantic)\b/i, "Transatlantic"],
];
const TRAITS: [RegExp, string][] = [
  [/\b(deep|low|bass)\b/i, "deep"],
  [/\b(calm|soothing|relaxing|relaxed|meditation)\b/i, "calm"],
  [/\b(warm|cozy)\b/i, "warm"],
  [/\b(young|youthful|teen\w*)\b/i, "young"],
  [/\b(old|older|elderly|grandfather|grandpa|wise)\b/i, "old"],
  [/\b(news\w*|anchor|reporter|authoritative|serious|formal)\b/i, "news"],
  [/\b(friendly|kind)\b/i, "friendly"],
  [/\b(casual|chill|conversational|natural)\b/i, "casual"],
  [/\b(upbeat|energetic|excited|cheerful|happy|hype)\b/i, "upbeat"],
  [/\b(soft|gentle|whisper\w*|quiet)\b/i, "soft"],
  [/\b(confident|bold|strong)\b/i, "confident"],
  [/\b(intense|dramatic|epic|trailer)\b/i, "dramatic"],
  [/\b(story\w*|audiobook|narrat\w*|documentary)\b/i, "narration"],
  [/\b(trustworthy|reassuring)\b/i, "trustworthy"],
  [/\b(expressive|lively)\b/i, "expressive"],
];

/** The part of a voice request that says how to read it, not the words to read. */
function instruction(message: string): string {
  const words = textToSpeak(message);
  if (words !== message && message.includes(words)) return message.replace(words, " ");
  // No quotes or colon: only a phrase like "in a deep British man's voice" counts.
  return message.match(/\b(in|with|using)\s+(an?\s+|the\s+)?[\w' -]{0,40}?\b(voice|accent)\b/i)?.[0] ?? "";
}

/** Picks a voice and speed from how the request asks for it to be read. */
export function pickVoice(message: string, requested?: string): { voice: Voice; speed: number } {
  const how = instruction(message);
  const named = VOICES.find((x) => x.name.toLowerCase() === requested?.trim().toLowerCase()) ??
    VOICES.find((x) => new RegExp(`\\b${x.name}('s)?\\b`).test(how));
  const speed = /\b(slow(ly|er)?|calmly)\b/i.test(how) ? 0.85 : /\b(fast(er)?|quick(ly|er)?|rapid(ly)?)\b/i.test(how) ? 1.15 : 1;
  if (named) return { voice: named, speed };
  const gender = GENDER.find(([re]) => re.test(how))?.[1];
  const accent = ACCENTS.find(([re]) => re.test(how))?.[1];
  const traits = TRAITS.filter(([re]) => re.test(how)).map(([, t]) => t);
  if (!gender && !accent && !traits.length) return { voice: DEFAULT_VOICE, speed };
  let best = DEFAULT_VOICE;
  let bestScore = -1;
  for (const x of VOICES) {
    if (gender && x.gender !== gender) continue;
    const score = (accent && x.accent === accent ? 3 : 0) + traits.filter((t) => x.traits.includes(t)).length;
    if (score > bestScore) [best, bestScore] = [x, score];
  }
  return { voice: best, speed };
}
