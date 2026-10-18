import type { Attachment, ChatTurn, Engine } from "./types.ts";
import type { UIMessage } from "./store.ts";
import { accountReplies } from "./connectors.ts";

/*
 * The request the chat page sends to POST /api/chat for a message (see respond in Flash.tsx). Fix all in
 * the search check (SEO) asks the chat route what that same request would hold before it's sent (quote),
 * so both are made here, from the same messages and settings, and price the same.
 */

/** A message as the AI reads it: with text that came after an app, and the part of the app it's about. */
export function turnText(m: UIMessage): string {
  const text = m.content + (m.after ?? "");
  return m.picked ? `${text}\n\n${m.picked.context}` : text;
}

/**
 * The latest message as Edit asks again with new words (see editLast in Flash.tsx). Typed words replace
 * what was heard, so they're routed and answered as typed. What Fix all said its change would hold (cap)
 * was for its own words, not these: the edited message goes without it, priced as any typed change.
 */
export function editedMessage(old: UIMessage, text: string): UIMessage {
  return { ...old, content: text, voice: undefined, cap: undefined };
}

/** What the page sends with a message besides the chat itself, read when it's sent. */
export type ChatSettings = {
  // The tool picked in the composer, for a message that names none of its own.
  choice: Engine | "auto";
  // Memory and the user's preferences ("" with memory off).
  preferences: string;
  // The level picked (see levels.ts), when one is.
  level?: string;
  // The image, video or music model picked for each engine.
  models: Partial<Record<Engine, string>>;
  // The user agreed to this request's price, or to every price (see CONFIRM_CREDITS).
  confirmed: boolean;
  decided?: UIMessage["decided"];
  projectId: string;
  // A new chat's name when it isn't its first message (a template's title).
  name?: string;
  timeZone?: string;
  // The user's accounts on for this request, and approved results to continue the answer with.
  connectors: string[];
  actions: string[];
  // The reply's id, and the files sent with the message.
  replyId: string;
  files: Attachment[];
};

/** The body of the chat request for userMsg after earlier (the chat as it is before it). */
export function chatRequestBody(earlier: UIMessage[], userMsg: UIMessage, s: ChatSettings) {
  // A template's request always goes to its own engine, and one the companion lined up to Auto
  // (the tool picked in the composer was for something else); anything else to the one picked.
  const engine = userMsg.template?.engine ?? userMsg.build ?? (userMsg.queued || userMsg.auto ? "auto" : s.choice);
  // Only the most recent app's code is sent back, so edits build on it without resending every version.
  const lastAppId = [...earlier].reverse().find((m) => m.app)?.id;
  // A spoken "thanks" after an app is answered in words but is still about the app, so the next
  // follow-up can change it.
  const lastReply = [...earlier].reverse().find((m) => m.role === "assistant" && m.engine);
  const previous = lastReply?.about ?? lastReply?.engine;
  // Replies that used a connected account are marked, so the chat never goes to the free lane.
  const fromAccounts = accountReplies(earlier);
  const messages: ChatTurn[] = [
    ...earlier
      // A price Flash asked about stays, so "how much was it?" is answered with the real price.
      .filter((m) => !m.error || m.content || m.app || m.errorCode === "confirm_cost")
      .map((m) => ({
        role: m.role,
        content: m.errorCode === "confirm_cost" && !m.content ? (m.error ?? "") : turnText(m),
        app: m.id === lastAppId ? m.app?.html : undefined,
        usedConnector: fromAccounts.has(m.id) || undefined,
      })),
    { role: "user", content: turnText(userMsg), attachment: s.files[0], more: s.files.length > 1 ? s.files.slice(1) : undefined },
  ];
  return {
    messages,
    engine,
    preferences: s.preferences,
    previous,
    // Read when sent, so a queued request uses the level picked by then.
    ...(s.level !== undefined && { level: s.level }),
    model: userMsg.template?.model ?? (engine === "auto" ? undefined : s.models[engine]),
    template: userMsg.template?.name,
    confirmed: s.confirmed,
    ...(s.confirmed && s.decided && { decided: s.decided }),
    projectId: s.projectId,
    ...(userMsg.voice && { voice: true }),
    ...(userMsg.build && { build: true }),
    // The server only needs to know it's the picture above, for the reason it shows.
    ...(userMsg.pictureAbove ? { pictureAbove: true } : {}),
    // The server saves the turn too, so the answer is kept if this page is closed (see turns.ts).
    replyId: s.replyId,
    userMessage: userMsg,
    afterId: earlier.at(-1)?.id ?? null,
    ...(s.name && { name: s.name }),
    // The device's time zone, so answers use the user's own date and time.
    ...(s.timeZone && { timeZone: s.timeZone }),
    ...(s.connectors.length && { connectors: s.connectors }),
    // Sent even with the accounts off, so the server refuses it rather than answer without the results.
    ...(s.actions.length && { actions: s.actions }),
    // The most Fix all said this message would hold, so it never holds or is charged more (see the chat route).
    ...(userMsg.cap !== undefined && { maxCredits: userMsg.cap }),
  };
}
