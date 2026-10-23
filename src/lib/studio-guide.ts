import { msg } from "./i18n.ts";

/*
 * Help me write it, in Infinity AI Studio: people who've never written a prompt don't know what a
 * story or an ad needs. Flash asks for the pieces (what kind of story, where, who, the mood, the
 * ending; or the product, who it's for, the message, the mood, what to do next) as answers to tap,
 * and writes the brief from them, here in the browser, so it costs nothing. Ready ideas start it in
 * one tap, and Prompt Helper can grow a one-line idea into a full brief (see prompt-helper.ts).
 */

export type StudioKind = "story" | "ad";

export type StudioQuestion = {
  key: string;
  ask: string;
  answers: string[];
};

export const STUDIO_QUESTIONS: Record<StudioKind, StudioQuestion[]> = {
  story: [
    { key: "kind", ask: msg("What kind of story?"), answers: [msg("a drama"), msg("a love story"), msg("a comedy"), msg("a thriller"), msg("a family story")] },
    { key: "place", ask: msg("Where does it happen?"), answers: [msg("a big city"), msg("a village"), msg("an office"), msg("a school"), msg("a hospital")] },
    {
      key: "cast",
      ask: msg("Who are the main characters?"),
      answers: [msg("a young woman and her rival"), msg("two best friends"), msg("a mother and her son"), msg("a boss and a new worker")],
    },
    { key: "mood", ask: msg("What feeling should it have?"), answers: [msg("emotional"), msg("funny"), msg("full of suspense"), msg("heartwarming")] },
    { key: "ending", ask: msg("How should this part end?"), answers: [msg("a big twist"), msg("a happy ending"), msg("a cliffhanger for Part 2"), msg("a sad ending")] },
  ],
  ad: [
    { key: "product", ask: msg("What is the ad for?"), answers: [msg("my restaurant"), msg("my clothing brand"), msg("my beauty salon"), msg("my shop")] },
    { key: "audience", ask: msg("Who should see it?"), answers: [msg("young people"), msg("families"), msg("business owners"), msg("everyone")] },
    { key: "message", ask: msg("What should people remember?"), answers: [msg("we just opened"), msg("a special offer"), msg("the best quality"), msg("fast delivery")] },
    { key: "mood", ask: msg("What feeling should it have?"), answers: [msg("luxurious"), msg("fun and full of energy"), msg("warm and friendly"), msg("bold and modern")] },
    { key: "action", ask: msg("What should viewers do at the end?"), answers: [msg("visit us"), msg("order online"), msg("call us"), msg("follow us")] },
  ],
};

// Each answer goes in its own sentence, so it reads well in every language.
const LINES: Record<StudioKind, Record<string, string>> = {
  story: {
    kind: msg("Kind of story: {answer}."),
    place: msg("Where it happens: {answer}."),
    cast: msg("Main characters: {answer}."),
    mood: msg("Feeling: {answer}."),
    ending: msg("This part ends with: {answer}."),
  },
  ad: {
    product: msg("An ad for: {answer}."),
    audience: msg("For: {answer}."),
    message: msg("Main message: {answer}."),
    mood: msg("Feeling: {answer}."),
    action: msg("At the end, ask viewers to: {answer}."),
  },
};

/** Ready ideas to start from, one tap each. */
export const STUDIO_IDEAS: Record<StudioKind, string[]> = {
  story: [
    msg("A market seller in Douala finds a lost wallet full of money and must choose between her family's needs and doing what's right."),
    msg("Two best friends open a small restaurant together, until one of them falls in love with the other's fiancé."),
    msg("A shy schoolboy secretly enters a national singing contest, and his strict father finds out on the night of the final."),
  ],
  ad: [
    msg("A fresh, joyful ad for a family restaurant: steaming dishes, friends laughing at the table, warm music, and an invitation to come this weekend."),
    msg("A stylish ad for a new clothing brand: young people walking through the city at golden hour, bold music, and a launch-day discount."),
    msg("A calm, elegant ad for a beauty salon: soft light, happy clients, gentle music, and a call to book online."),
  ],
};

// The most a typed answer keeps.
export const STUDIO_ANSWER_CHARS = 120;

type Words = (text: string, blanks?: Record<string, string>) => string;

/**
 * The brief, from the answers, in the language Flash is shown in: a tapped answer is translated, a
 * typed one kept as written; a question left unanswered says nothing.
 */
export function writeBrief(kind: StudioKind, answers: Record<string, string>, t: Words): string {
  return STUDIO_QUESTIONS[kind]
    .flatMap((q) => {
      const given = (answers[q.key] ?? "").trim();
      if (!given) return [];
      const answer = q.answers.includes(given) ? t(given) : given.slice(0, STUDIO_ANSWER_CHARS);
      return [t(LINES[kind][q.key], { answer })];
    })
    .join(" ");
}
