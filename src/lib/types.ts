export const ENGINES = [
  "text",
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
};

export type Source = { title: string; url: string };

// One line of the NDJSON stream sent from /api/chat to the browser.
export type StreamEvent =
  | { type: "route"; engine: Engine; reason: string; demo: boolean }
  | { type: "text"; delta: string }
  | { type: "status"; message: string }
  | { type: "image"; url: string; prompt: string }
  | { type: "video"; url: string; prompt: string }
  | { type: "audio"; url: string; label?: string }
  | { type: "sources"; items: Source[] }
  | { type: "error"; message: string }
  | { type: "done" };
