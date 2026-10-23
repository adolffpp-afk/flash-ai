import { msg } from "./i18n.ts";
import type { Engine } from "./types.ts";

/*
 * Help me ask: for people new to AI, two taps instead of a blank box. They pick what to make and
 * what it's about, and Flash writes the whole request at once, guessing the rest. What it should
 * have, who it's for and the style are there to tap on the written request if they want, never
 * asked one by one. It's put together right here from their taps, so it costs nothing; Prompt
 * Helper can still polish it afterwards.
 */

export type GuideGoal = {
  id: string;
  label: string;
  // The tool the request is sent to.
  engine: Engine | "auto";
  // The icon's key in Home's ICONS.
  icon: "globe" | "app" | "card" | "image" | "template" | "file" | "chat";
  // What it's about: the question, a few answers to tap, and the first sentence of the request.
  ask: string;
  subjects: string[];
  opening: string;
  // What it should have, as answers to tap (any number of them).
  extras: string[];
  // Whether "Who is it for?" and "What style do you like?" are offered.
  audience: boolean;
  style: boolean;
};

export const GUIDE_GOALS: GuideGoal[] = [
  {
    id: "website",
    label: msg("Website"),
    engine: "app",
    icon: "globe",
    ask: msg("What is the website for?"),
    subjects: [msg("my business"), msg("my restaurant"), msg("an event"), msg("my portfolio")],
    opening: msg("Build a website for {subject}."),
    extras: [msg("a contact form"), msg("a photo gallery"), msg("prices"), msg("online booking"), msg("a map and opening hours"), msg("customer reviews")],
    audience: true,
    style: true,
  },
  {
    id: "app",
    label: msg("App"),
    engine: "app",
    icon: "app",
    ask: msg("What should the app help with?"),
    subjects: [msg("taking bookings"), msg("tracking sales"), msg("managing my team"), msg("customer orders")],
    opening: msg("Build an app that helps with {subject}."),
    extras: [msg("sign-in"), msg("a dashboard with charts"), msg("reminders"), msg("search"), msg("a phone-friendly layout")],
    audience: true,
    style: true,
  },
  {
    id: "store",
    label: msg("Online store"),
    engine: "app",
    icon: "card",
    ask: msg("What will you sell?"),
    subjects: [msg("clothes"), msg("food"), msg("handmade crafts"), msg("beauty products")],
    opening: msg("Build an online store that sells {subject}."),
    extras: [msg("card payments"), msg("product photos"), msg("delivery options"), msg("discount codes"), msg("order tracking")],
    audience: false,
    style: true,
  },
  {
    id: "picture",
    label: msg("Picture"),
    engine: "image",
    icon: "image",
    ask: msg("What should the picture show?"),
    subjects: [msg("a logo for my business"), msg("a product photo"), msg("a poster"), msg("a portrait")],
    opening: msg("Create a picture of {subject}."),
    extras: [msg("bright colours"), msg("a dark background"), msg("soft light"), msg("words on it"), msg("lots of detail")],
    audience: false,
    style: true,
  },
  {
    id: "slides",
    label: msg("Slides"),
    engine: "slides",
    icon: "template",
    ask: msg("What is the presentation about?"),
    subjects: [msg("my business plan"), msg("a school lesson"), msg("a new product"), msg("sales results")],
    opening: msg("Make a slide deck about {subject}."),
    extras: [msg("charts"), msg("pictures"), msg("short bullet points"), msg("speaker notes"), msg("a summary slide")],
    audience: true,
    style: true,
  },
  {
    id: "document",
    label: msg("Document"),
    engine: "docs",
    icon: "file",
    ask: msg("What do you need to write?"),
    subjects: [msg("a cover letter"), msg("a business plan"), msg("a letter to a customer"), msg("a report")],
    opening: msg("Write {subject}."),
    extras: [msg("simple words"), msg("a formal tone"), msg("a friendly tone"), msg("a table"), msg("a short summary at the top")],
    audience: true,
    style: false,
  },
  {
    id: "advice",
    label: msg("Advice"),
    engine: "auto",
    icon: "chat",
    ask: msg("What do you need help with?"),
    subjects: [msg("growing my business"), msg("marketing ideas"), msg("a money question"), msg("learning something new")],
    opening: msg("Give me advice on {subject}."),
    extras: [msg("a step-by-step plan"), msg("simple words"), msg("examples"), msg("a checklist"), msg("pros and cons")],
    audience: false,
    style: false,
  },
];

export const AUDIENCES = [msg("customers"), msg("my team"), msg("students"), msg("children"), msg("everyone")];
export const STYLES = [msg("clean and simple"), msg("bold and colourful"), msg("elegant"), msg("fun and playful"), msg("professional")];

// The longest answer typed into a step, and into "Anything else".
export const ANSWER_CHARS = 120;
export const NOTE_CHARS = 600;

export type GuideAnswers = {
  subject: string;
  extras: string[];
  audience: string;
  style: string;
  note: string;
};

export const NO_ANSWERS: GuideAnswers = { subject: "", extras: [], audience: "", style: "", note: "" };

type Words = ((text: string, blanks?: Record<string, string>) => string) & { locale: string };

/**
 * The request, written from the answers in the language Flash is shown in. Answers picked from the
 * list are Flash's own words and are translated; typed ones are kept as written. Nothing is said
 * for a question left unanswered.
 */
export function writeRequest(goal: GuideGoal, answers: GuideAnswers, t: Words): string {
  const word = (answer: string, list: string[]) => (list.includes(answer) ? t(answer) : answer.trim().slice(0, ANSWER_CHARS));
  const subject = word(answers.subject, goal.subjects) || t(goal.subjects[0]);
  const lines = [t(goal.opening, { subject })];
  const extras = answers.extras.map((e) => word(e, goal.extras)).filter(Boolean);
  if (extras.length) lines.push(t("Include {extras}.", { extras: new Intl.ListFormat(t.locale, { type: "conjunction" }).format(extras) }));
  const audience = goal.audience ? word(answers.audience, AUDIENCES) : "";
  if (audience) lines.push(t("It's for {audience}.", { audience }));
  const style = goal.style ? word(answers.style, STYLES) : "";
  if (style) lines.push(t("Style: {style}.", { style }));
  const note = answers.note.trim().slice(0, NOTE_CHARS);
  if (note) lines.push(note);
  return lines.join(" ");
}
