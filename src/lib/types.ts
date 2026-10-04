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
  text: "Write",
  search: "Research",
  code: "Code",
  translate: "Translate",
  docs: "Docs & Sheets",
  image: "Image",
  video: "Video",
  voice: "Voice",
  music: "Music",
  transcribe: "Transcribe",
  app: "App Builder",
  slides: "Slides",
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
      // Answered by a free open-source model because the user is out of credits.
      free?: boolean;
    }
  | { type: "text"; delta: string }
  // What a reply charged by length really cost, sent when it finishes.
  | { type: "cost"; credits: number }
  | { type: "status"; message: string }
  | { type: "image"; url: string; prompt: string }
  | { type: "video"; url: string; prompt: string }
  | { type: "audio"; url: string; label?: string }
  | { type: "sources"; items: Source[] }
  | { type: "app"; app: BuiltApp }
  | { type: "error"; message: string }
  | { type: "done" };
