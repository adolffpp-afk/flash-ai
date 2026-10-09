import { english, msg, type Translate } from "./i18n.ts";
import type { Engine } from "./types.ts";

/*
 * Everything Flash can do, for Home's "Everything Flash can do" section and the search in the top
 * bar. Each feature opens the place where it's used: a tool in the message box, a page, or a link.
 * Only what Flash does today is listed; Automations is the one planned feature, marked as coming.
 */

export type FeatureGroup = "Chat & research" | "Create" | "Build" | "Files" | "Voice" | "Workspace";

export const FEATURE_GROUPS: FeatureGroup[] = [msg("Chat & research"), msg("Create"), msg("Build"), msg("Files"), msg("Voice"), msg("Workspace")];

/** Places a feature opens, besides a tool in the message box. Flash.tsx's openFeature handles each. */
export const FEATURE_PAGES = [
  "attach",
  "build-from-picture",
  "talk",
  "chats",
  "movie",
  "companion",
  "automations",
  "install",
  "templates",
  "template:social-pack",
  "websites",
  "creations",
  "brand",
  "memory",
  "general",
  "credits",
  "invite",
] as const;
export type FeaturePage = (typeof FEATURE_PAGES)[number];

export type FeatureAction = { tool: Engine | "auto" } | { open: FeaturePage } | { href: string };

export type IconName =
  | "chat" | "pen" | "search" | "translate" | "sparkle" | "image" | "wand" | "layers" | "scissors" | "expand" | "video" | "film"
  | "music" | "megaphone" | "slides" | "template" | "app" | "images" | "code" | "globe" | "inbox" | "chart" | "link" | "card"
  | "users" | "paperclip" | "scan" | "file" | "download" | "library" | "voice" | "radio" | "speaker" | "lines" | "headphones"
  | "brand" | "bookmark" | "share" | "plug" | "install" | "star" | "gift" | "bolt";

export type Feature = {
  title: string;
  about: string;
  group: FeatureGroup;
  icon: IconName;
  action: FeatureAction;
  // The tool it needs, and the model within it when only one model does the job (photo edits are fal's).
  needs?: Engine;
  model?: string;
  // Needs the server set up for it: Stripe payments, or custom domains on Vercel.
  setup?: "payments" | "domains";
  // Shown as "Paid plans": sites on a free plan can't use it.
  paid?: boolean;
  // Planned, not built: shown as "Coming soon".
  soon?: boolean;
  // Other words people search for it by.
  also?: string;
};

export const FEATURES: Feature[] = [
  // Chat & research
  { title: msg("AI Chat"), about: msg("Ask anything. Flash picks the right tool"), group: "Chat & research", icon: "chat", action: { tool: "auto" } },
  { title: msg("Write"), about: msg("Emails, posts, plans and stories"), group: "Chat & research", icon: "pen", action: { tool: "text" }, needs: "text", also: "email letter essay blog" },
  { title: msg("Deep Research"), about: msg("Searches the web and cites its sources"), group: "Chat & research", icon: "search", action: { tool: "search" }, needs: "search", also: "web sources" },
  { title: msg("Translate"), about: msg("Natural translations, any language"), group: "Chat & research", icon: "translate", action: { tool: "translate" }, needs: "translate" },
  { title: msg("Search Your Chats"), about: msg("Find a chat by its name or what was said"), group: "Chat & research", icon: "search", action: { open: "chats" } },
  { title: msg("Ask Flash"), about: msg("A helper beside you that answers and lines up requests"), group: "Chat & research", icon: "sparkle", action: { open: "companion" }, also: "companion help" },

  // Create
  { title: msg("Image"), about: msg("Pictures, logos and posters from a sentence"), group: "Create", icon: "image", action: { tool: "image" }, needs: "image", also: "picture photo logo poster" },
  { title: msg("Edit a Photo"), about: msg("Attach a photo, then say what to change"), group: "Create", icon: "wand", action: { open: "attach" }, needs: "image", model: "flux-2-edit", also: "picture" },
  { title: msg("Combine Photos"), about: msg("Attach up to 4 photos and mix them into one"), group: "Create", icon: "layers", action: { open: "attach" }, needs: "image", model: "flux-2-edit", also: "merge" },
  { title: msg("Remove Background"), about: msg("Attach a photo for a clean cut-out"), group: "Create", icon: "scissors", action: { open: "attach" }, needs: "image", model: "remove-bg", also: "transparent cutout" },
  { title: msg("Upscale"), about: msg("Attach a photo to make it sharper and bigger"), group: "Create", icon: "expand", action: { open: "attach" }, needs: "image", model: "upscale", also: "enhance sharpen" },
  { title: msg("Animate a Photo"), about: msg("Attach a photo and watch it move"), group: "Create", icon: "video", action: { open: "attach" }, needs: "video", model: "kling-3-animate" },
  { title: msg("Video"), about: msg("Short clips with sound from a sentence"), group: "Create", icon: "video", action: { tool: "video" }, needs: "video", also: "clip" },
  { title: msg("Movie Maker"), about: msg("Flash writes the scenes, films them and joins them"), group: "Create", icon: "film", action: { open: "movie" }, needs: "video", model: "movie", also: "film short" },
  { title: msg("Music"), about: msg("Songs with lyrics, or instrumentals"), group: "Create", icon: "music", action: { tool: "music" }, needs: "music", also: "song" },
  { title: msg("Social Post Pack"), about: msg("Captions, hashtags and pictures for three networks"), group: "Create", icon: "megaphone", action: { open: "template:social-pack" }, needs: "image", model: "post-pack", also: "instagram tiktok facebook" },
  { title: msg("Slides"), about: msg("A presentation from one sentence"), group: "Create", icon: "slides", action: { tool: "slides" }, needs: "slides", also: "presentation deck powerpoint" },
  { title: msg("Templates"), about: msg("Business plans, invoices, resumes, menus and more"), group: "Create", icon: "template", action: { open: "templates" }, also: "prompts invoice resume" },

  // Build
  { title: msg("App & Website Builder"), about: msg("Working apps and sites from a sentence"), group: "Build", icon: "app", action: { tool: "app" }, needs: "app", also: "website site" },
  { title: msg("Build From a Picture"), about: msg("Attach a screenshot or sketch to turn it into an app"), group: "Build", icon: "images", action: { open: "build-from-picture" }, needs: "app" },
  { title: msg("Code"), about: msg("Write, explain and fix code"), group: "Build", icon: "code", action: { tool: "code" }, needs: "code" },
  { title: msg("My Websites"), about: msg("Your published sites, updated in one click"), group: "Build", icon: "globe", action: { open: "websites" }, also: "apps publish" },
  { title: msg("Form Inbox"), about: msg("Messages people send through your sites"), group: "Build", icon: "inbox", action: { open: "websites" }, also: "messages contact" },
  { title: msg("Visitor Stats"), about: msg("Who visits your sites, without cookies"), group: "Build", icon: "chart", action: { open: "websites" }, also: "analytics" },
  { title: msg("Your Own Domain"), about: msg("Put a site on a domain you own"), group: "Build", icon: "link", action: { open: "websites" }, setup: "domains", paid: true },
  { title: msg("Sell on Your Site"), about: msg("Take payments with Stripe"), group: "Build", icon: "card", action: { open: "websites" }, setup: "payments", paid: true, also: "shop payments" },
  { title: msg("Sign-in, AI and Uploads"), about: msg("Ask the builder to add members, AI or file uploads to an app"), group: "Build", icon: "users", action: { tool: "app" }, needs: "app", also: "login members" },

  // Files
  { title: msg("Analyze Files"), about: msg("PDF, Word, Excel and PowerPoint, up to 5 at once"), group: "Files", icon: "paperclip", action: { open: "attach" }, also: "pdf docx xlsx pptx upload" },
  { title: msg("Read Text in Photos"), about: msg("Attach photos to copy their text or make a spreadsheet"), group: "Files", icon: "scan", action: { open: "attach" }, needs: "docs", also: "receipt ocr" },
  { title: msg("Docs & Sheets"), about: msg("Reports, tables and spreadsheets"), group: "Files", icon: "file", action: { tool: "docs" }, needs: "docs", also: "document spreadsheet excel" },
  { title: msg("Save Answers"), about: msg("Word, Excel, PDF or PowerPoint, from the buttons under any answer"), group: "Files", icon: "download", action: { open: "chats" }, also: "export download" },
  { title: msg("Share or Download a Chat"), about: msg("A read-only link, or the chat as a web page"), group: "Files", icon: "share", action: { open: "chats" }, also: "link" },
  { title: msg("My Creations"), about: msg("Every picture, video and sound you've made"), group: "Files", icon: "library", action: { open: "creations" }, also: "library gallery" },

  // Voice
  { title: msg("Talk with Flash"), about: msg("A live voice conversation"), group: "Voice", icon: "voice", action: { open: "talk" }, also: "voice mode speak" },
  { title: msg("Hey Flash"), about: msg("Wake Flash with your voice in Chrome, Edge or Safari"), group: "Voice", icon: "radio", action: { open: "general" }, also: "wake word" },
  { title: msg("Voice-over"), about: msg("Your text read aloud, as an audio file"), group: "Voice", icon: "speaker", action: { tool: "voice" }, needs: "voice", also: "narration" },
  { title: msg("Transcribe"), about: msg("Recordings and meetings into text"), group: "Voice", icon: "lines", action: { tool: "transcribe" }, needs: "transcribe", also: "audio meeting" },
  { title: msg("Read Aloud"), about: msg("Hear any answer, free. Pick the voice in Settings"), group: "Voice", icon: "headphones", action: { open: "general" } },

  // Workspace
  { title: msg("Brand Kit"), about: msg("Your logo, colours and tone in what Flash makes"), group: "Workspace", icon: "brand", action: { open: "brand" }, also: "brand hub logo" },
  { title: msg("Memory"), about: msg("What Flash should know about you"), group: "Workspace", icon: "bookmark", action: { open: "memory" } },
  { title: msg("Language"), about: msg("The language Flash answers and builds in"), group: "Workspace", icon: "globe", action: { open: "general" } },
  { title: msg("Flash in Claude and ChatGPT"), about: msg("Use Flash's tools from other AI apps"), group: "Workspace", icon: "plug", action: { href: "/connector" }, also: "connector mcp cursor" },
  { title: msg("Install Flash"), about: msg("Its own window and icon on your computer or phone"), group: "Workspace", icon: "install", action: { open: "install" }, also: "app download" },
  { title: msg("Plans & Credits"), about: msg("Your plan, credit packs and top-ups"), group: "Workspace", icon: "star", action: { open: "credits" }, also: "upgrade billing" },
  { title: msg("Invite Friends"), about: msg("You both get credits after their first payment"), group: "Workspace", icon: "gift", action: { open: "invite" }, also: "referral" },
  { title: msg("Automations"), about: msg("Jobs Flash runs on a schedule"), group: "Workspace", icon: "bolt", action: { open: "automations" }, soon: true, also: "schedule" },
];

/** What's set up on this server: tools, models, Stripe payments and custom domains. */
export type FeatureSetup = { isLive: (e: Engine) => boolean; modelLive: (id: string) => boolean; payments: boolean; domains: boolean };

/** Whether a feature works now: it's built, and its tool, model and server setup are ready. */
export function featureReady(f: Feature, on: FeatureSetup): boolean {
  if (f.soon) return false;
  if (f.needs && !on.isLive(f.needs)) return false;
  if (f.model && !on.modelLive(f.model)) return false;
  return !f.setup || on[f.setup];
}

/** The install feature, shown only where Flash can still be installed. */
export const isInstall = (f: Feature) => "open" in f.action && f.action.open === "install";

/** The features whose names (in English or the language Flash is shown in, t) or other words for them contain what was typed. */
export function findFeatures(query: string, features: Feature[] = FEATURES, t: Translate = english): Feature[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return features.filter((f) => `${f.title} ${t(f.title)} ${f.also ?? ""}`.toLowerCase().includes(q));
}
