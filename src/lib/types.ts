import { msg } from "./i18n.ts";
import type { Post } from "./post-pack.ts";
import type { ActionCard, ConnectorUse } from "./connectors.ts";

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
  // Set by the server only, for a reply continued with connector results the user approved: the
  // calls (on the assistant turn before) and what they returned (on the user's turn), as tool blocks.
  toolCalls?: { id: string; name: string; input: Record<string, unknown> }[];
  toolResults?: { id: string; content: string; isError?: boolean }[];
  // Set by the server only, on its copy of the newest turn of a chat with an assistant: what the
  // message reads from the assistant's files (see assistant-search.ts). Never saved.
  passages?: { title: string; text: string }[];
  // A reply that used a connected account (see accountReplies in connectors.ts): what it says can
  // hold that account's data, so a chat with one never goes to the free lane.
  usedConnector?: boolean;
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
  // writing: the first pieces of a change to the app or deck are written (see startsWriting in live-draft.ts).
  | { type: "status"; message: string; writing?: boolean }
  // label names a picture that comes with others, like a post pack's "Square" and "Tall".
  | { type: "image"; url: string; prompt: string; label?: string }
  | { type: "video"; url: string; prompt: string }
  | { type: "audio"; url: string; label?: string }
  | { type: "sources"; items: Source[] }
  // What a reply in a chat with an assistant read from its files: each passage's title ("Handbook.pdf,
  // page 4", or "Passage 2, page 4" when its file names aren't shown), and nomatch when none matched.
  | { type: "read"; items: { label: string }[]; nomatch?: boolean }
  // The connected accounts' tools a reply used (never what they returned), sent once at its end.
  | { type: "connector_used"; items: ConnectorUse[] }
  // A connector call waiting for the user to approve it (see pending-actions.ts).
  | { type: "approve_action"; action: ActionCard }
  // A social post pack's posts, each ready to copy.
  | { type: "posts"; posts: Post[] }
  // An Infinity AI Studio storyboard (see ad-studio.ts, story-studio.ts): its saved file, and the request
  // that films it in HD, on the Studio model it is for (the Ads Studio when none); next: a finished part,
  // whose request writes the next one.
  | { type: "storyboard"; id: string; film: string; model?: string; next?: number }
  | { type: "app"; app: BuiltApp }
  // The file being written, for the live preview: delta continues the draft at offset at (at 0
  // starts it over; an empty delta at 0 clears it). Shown while it streams, never saved.
  | { type: "draft"; at: number; delta: string }
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

/**
 * How long a reply may show as pending. A request runs for at most 800 seconds (maxDuration in the
 * chat route), so a reply still pending well after that was never finished: its server stopped (a
 * deploy, a crash). Until then the page waits for it, and nothing saved over the chat removes it.
 */
export const PENDING_LIMIT_MS = 15 * 60_000;
