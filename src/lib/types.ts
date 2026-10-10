import { msg } from "./i18n.ts";
import type { Post } from "./post-pack.ts";

export const ENGINES = [
  "text",
  "app",
  "slides",
  "search",
  "code",
  "translate",
  "docs",
  "image",
  "video",
  "voice",
  "music",
  "transcribe",
] as const;

export type Engine = (typeof ENGINES)[number];

export const ENGINE_LABELS: Record<Engine, string> = {
  text: msg("Write"),
  search: msg("Research"),
  code: msg("Code"),
  translate: msg("Translate"),
  docs: msg("Docs & Sheets"),
  image: msg("Image"),
  video: msg("Video"),
  voice: msg("Voice"),
  music: msg("Music"),
  transcribe: msg("Transcribe"),
  app: msg("App Builder"),
  slides: msg("Slides"),
};

export type Attachment = {
  name: string;
  mediaType: string;
  // Base64 without the data: prefix.
  data: string;
};

export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
  attachment?: Attachment;
  // More files sent with the first one (see attachments.ts).
  more?: Attachment[];
  // Full HTML of an app or deck Flash built in this assistant turn, so follow-ups can edit it.
  app?: string;
};

export type BuiltApp = { title: string; html: string; kind: "app" | "slides" };

export type Source = { title: string; url: string };

// One line of the NDJSON stream sent from /api/chat to the browser.
export type StreamEvent =
  | {
      type: "route";
      engine: Engine;
      reason: string;
      demo: boolean;
      cost: number;
      model?: string;
      modelWhy?: string;
      // Answered by a free model because the user is out of credits.
      free?: boolean;
      // A spoken turn about the app or deck before it that didn't change it (see RouteDecision).
      about?: Engine;
      // The id of the credits held for the request, so a reply the user stops can show what it really cost (see /api/me/charge).
      charge?: number;
    }
  | { type: "text"; delta: string }
  // What a reply charged by length really cost, sent when it finishes.
  | { type: "cost"; credits: number }
  | { type: "status"; message: string }
  // label names a picture that comes with others, like a post pack's "Square" and "Tall".
  | { type: "image"; url: string; prompt: string; label?: string }
  | { type: "video"; url: string; prompt: string }
  | { type: "audio"; url: string; label?: string }
  | { type: "sources"; items: Source[] }
  // A social post pack's posts, each ready to copy.
  | { type: "posts"; posts: Post[] }
  | { type: "app"; app: BuiltApp }
  | { type: "error"; message: string }
  // The reply ended early: the user pressed Stop, or a Claude engine ran out of time.
  | { type: "stopped" }
  | { type: "done" };

/**
 * The engines that write their answer as it comes, which Stop ends at once. The others make a
 * picture, video or sound that the provider bills once it has started, so Stop lets it finish and
 * it's delivered into the chat (see the chat route).
 */
export const STOPPABLE_ENGINES: readonly Engine[] = ["text", "app", "slides", "search", "code", "translate", "docs"];
