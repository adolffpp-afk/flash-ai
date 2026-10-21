import { msg } from "./i18n.ts";

/*
 * What Flash is building next, for the menu's Coming soon. None of these work yet, so each is shown
 * as coming and opens nothing. The first three are Flash's signature projects, then the developer
 * API, Flash AML & KYC (business suite B14) and the Worksheet Maker; their names are working names
 * until a lawyer has cleared them. Automations and AI Agents are the menu's two "Soon" items. Buying a
 * domain waits on the domain partner's written yes. When one ships, it moves to features.ts and leaves
 * this list.
 */
export type ComingSoon = {
  title: string;
  about: string;
  icon: "bookmark" | "arrow" | "columns" | "code" | "users" | "file" | "bolt" | "sparkle" | "globe";
};

export const COMING_SOON: ComingSoon[] = [
  {
    title: msg("Infinity Memory"),
    about: msg("Flash will learn what matters from your chats, if you turn it on, and find it again by meaning. It tidies old memories by itself, and you can see, change or delete each one."),
    icon: "bookmark",
  },
  {
    title: msg("Next Steps"),
    about: msg("After each answer, Flash will suggest up to three next steps, like testing or publishing your app. Nothing runs until you tap one, and you see its price first."),
    icon: "arrow",
  },
  {
    title: msg("Side-by-side view"),
    about: msg("Your chat and its next steps side by side on bigger screens, with your connected apps' tools one tap from the message box."),
    icon: "columns",
  },
  {
    title: msg("Flash API"),
    about: msg("Use Flash's pictures, video, music, voices and app building from your own apps, with a developer key paid in Flash credits."),
    icon: "code",
  },
  {
    title: msg("Flash AML & KYC"),
    about: msg("For small businesses, microfinance institutions and cooperatives: customer onboarding, an investigator workspace and case management, to help with your anti-money-laundering and know-your-customer checks."),
    icon: "users",
  },
  {
    title: msg("Worksheet Maker"),
    about: msg("Turn any topic into a worksheet with key words, questions, a worked problem, a discussion task and an answer key, ready to download as Word or PDF."),
    icon: "file",
  },
  {
    title: msg("Automations"),
    about: msg("Set up a job once, like a weekly sales summary or a daily social post, and Flash will do it on time without being asked."),
    icon: "bolt",
  },
  {
    title: msg("AI Agents"),
    about: msg("Your own AI agents are on the way: an assistant with its own instructions and files, ready in any chat."),
    icon: "sparkle",
  },
  {
    title: msg("Buy a domain"),
    about: msg("Find a web address like yourshop.com and buy it inside Flash, in your own name, through a domain partner. Flash connects it to your app for you, with no DNS settings to change."),
    icon: "globe",
  },
];
