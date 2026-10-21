import { msg } from "./i18n.ts";

/*
 * What Flash is building next, for the menu's Coming soon. None of these work yet, so each is shown
 * as coming and opens nothing. The first three are Flash's signature projects, then the developer
 * API, Flash AML & KYC (business suite B14) and the Worksheet Maker; their names are working names
 * until a lawyer has cleared them. Automations and AI Agents are the menu's two "Soon" items. Buying a
 * domain waits on the domain partner's written yes. Then the new ideas of 2026-10-21 (private mode,
 * finding money, presenter videos, 3D views, free tools), and the strongest planned features from the
 * idea lists (big-lead-ideas.md, overtake-ideas-2026-10-18.md, the competitor table). Ideas that wait
 * on someone else's yes (a lawyer, a partner company) stay off it. When one ships, it moves to
 * features.ts and leaves this list.
 */
export type ComingSoon = {
  title: string;
  about: string;
  icon:
    | "bookmark" | "arrow" | "columns" | "code" | "users" | "file" | "bolt" | "sparkle" | "globe" | "lock" | "search" | "film" | "cube" | "gift"
    | "chat" | "card" | "pen" | "scan" | "link" | "expand" | "chart" | "star" | "template" | "download" | "plug" | "clock" | "bell";
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
  {
    title: msg("Private mode"),
    about: msg("Chat with a small AI that runs inside your own browser. Nothing you type leaves your device, and it uses no credits."),
    icon: "lock",
  },
  {
    title: msg("Find money for my business"),
    about: msg("Flash will look for grants, loans and government contracts your business may qualify for, from official sources, and help you write the application. You always send it yourself."),
    icon: "search",
  },
  {
    title: msg("AI presenter videos"),
    about: msg("Short ad videos with a ready-made AI presenter reading your script, labelled as made with AI. No copying of real people's faces or voices."),
    icon: "film",
  },
  {
    title: msg("3D product views"),
    about: msg("Turn photos of a product into a 3D model that shoppers can turn around and, on phones that support it, place in their own room."),
    icon: "cube",
  },
  {
    title: msg("Free tools, no sign-up"),
    about: msg("Quick free tools anyone can try without an account: see how AI assistants describe your business, check your website and get name ideas."),
    icon: "gift",
  },
  {
    title: msg("Front Desk"),
    about: msg("A chat bubble on your published apps that answers visitors in their own language from your pages, prices and FAQ, saves leads and hands the chat to you."),
    icon: "chat",
  },
  {
    title: msg("Get paid from chat"),
    about: msg("Ask for an invoice in the chat, check it and approve it. Your customer gets a Pay button and reminders, and the invoice marks itself paid."),
    icon: "card",
  },
  {
    title: msg("Quick edits by hand"),
    about: msg("Click any text in your app's preview and retype it, or swap a picture, with no AI and no credits."),
    icon: "pen",
  },
  {
    title: msg("Safety check"),
    about: msg("Before you publish, Flash will check your app's security, accessibility and legal pages, and offer a fix for each problem it finds."),
    icon: "scan",
  },
  {
    title: msg("One sign-in for your customers"),
    about: msg("One account your customers can use in every app made with Flash, so they sign in once. Loyalty cards will come after."),
    icon: "link",
  },
  {
    title: msg("Move your website to Flash"),
    about: msg("Paste the link to your Wix, Squarespace, Shopify or WordPress site and Flash will rebuild it here, with redirects that help keep your place in search results."),
    icon: "expand",
  },
  {
    title: msg("Ask my business"),
    about: msg("Ask about your own sales, orders and visitors in plain words. Every number will come from your own data, never from a guess."),
    icon: "chart",
  },
  {
    title: msg("Start my business"),
    about: msg("One guided checklist from idea to opening day: a name, a brand, a website, payments and your first customers, each step done in Flash."),
    icon: "star",
  },
  {
    title: msg("Ready-made business kits"),
    about: msg("Starting kits for businesses like a restaurant, a salon or a shop: a website, bookings or orders, and messages, set up in one go."),
    icon: "template",
  },
  {
    title: msg("Bring your chats to Flash"),
    about: msg("Bring in your chat history from ChatGPT, Claude or Gemini, search it and carry on any chat, and choose which memories Flash keeps."),
    icon: "download",
  },
  {
    title: msg("Use your own AI key"),
    about: msg("Add your own key from an AI company, and chat answers on that key will use no Flash credits."),
    icon: "plug",
  },
  {
    title: msg("Restore your app's data"),
    about: msg("Take your app's data back to an earlier day, with a preview of what will change before you confirm."),
    icon: "clock",
  },
  {
    title: msg("Morning brief"),
    about: msg("An optional summary each morning with your reminders and yesterday's real numbers: visits, orders, leads and unpaid invoices."),
    icon: "bell",
  },
];
