import type { UIMessage } from "../store.ts";
import { ENGINES, type Engine } from "../types.ts";
import { one, run, now } from "./db.ts";

/*
 * The chat route saves each turn itself, so an answer is kept even when the page that asked for it
 * is closed: the user's message and a pending reply when the request starts, the finished reply
 * when it ends. Each is merged into the saved messages by message id, and written only if nothing
 * saved the project since they were read (projects.version, which every write of messages raises),
 * so the browser's own saving and the server's never undo each other.
 */

// A request runs for at most 800 seconds (maxDuration in the chat route), so a reply still pending
// well after that was never finished: its server stopped (a deploy, a crash).
export const PENDING_LIMIT_MS = 15 * 60_000;

// Message ids are made by the browser (newId in store.ts).
export const MESSAGE_ID = /^[\w-]{1,64}$/;

// The same limit as the chat route's for a message.
const MAX_CONTENT_CHARS = 100_000;

/** A request's turn: the user's message, the id of the message it follows (null for the first), and the reply. */
export type Turn = { user: UIMessage; afterId: string | null; reply: UIMessage };

const short = (value: unknown, max: number) => (typeof value === "string" && value.length <= max ? value : undefined);

/**
 * The user's message as the browser sent it, with only the fields a user message has, each of a
 * sensible size, or null when it isn't one. It's saved into the chat as it is.
 */
export function cleanUserMessage(raw: unknown): UIMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== "string" || !MESSAGE_ID.test(m.id)) return null;
  if (typeof m.content !== "string" || m.content.length > MAX_CONTENT_CHARS) return null;
  const out: UIMessage = { id: m.id, role: "user", content: m.content };
  const attachmentName = short(m.attachmentName, 1000);
  if (attachmentName) out.attachmentName = attachmentName;
  const template = m.template as Record<string, unknown> | undefined;
  const templateName = short(template?.name, 80);
  if (templateName && (ENGINES as readonly unknown[]).includes(template?.engine)) {
    const model = short(template?.model, 80);
    out.template = { engine: template!.engine as Engine, name: templateName, ...(model && { model }) };
  }
  if (m.queued === true) out.queued = true;
  if (m.auto === true) out.auto = true;
  if (m.voice === true) out.voice = true;
  if (m.build === "app" || m.build === "slides") out.build = m.build;
  const picked = m.picked as Record<string, unknown> | undefined;
  const label = short(picked?.label, 200);
  const context = short(picked?.context, 4000);
  if (label && context) out.picked = { label, context };
  // The picture above's link, so Retry can fetch it again; a link too long to keep is saved as true, like older chats.
  if (m.pictureAbove === true || (typeof m.pictureAbove === "string" && m.pictureAbove)) {
    out.pictureAbove = short(m.pictureAbove, 2000) ?? true;
  }
  return out;
}

/**
 * The turn a chat request asks the server to save, from the reply's id, the user's message and the
 * id of the message it follows (null for a chat's first) as the browser sent them. Null when any of
 * them is missing or isn't what the browser makes: a page loaded before the server saved turns sends
 * none, and keeps its answers itself.
 */
export function requestTurn(body: { replyId?: unknown; userMessage?: unknown; afterId?: unknown }): Turn | null {
  const replyId = typeof body.replyId === "string" && MESSAGE_ID.test(body.replyId) ? body.replyId : null;
  const user = cleanUserMessage(body.userMessage);
  const afterId = body.afterId === null ? null : typeof body.afterId === "string" && MESSAGE_ID.test(body.afterId) ? body.afterId : undefined;
  if (!replyId || !user || user.id === replyId || afterId === undefined) return null;
  return { user, afterId, reply: { id: replyId, role: "assistant", content: "", pending: true } };
}

/**
 * The messages with a new turn in place, as the browser places it: after the message it follows,
 * in place of whatever came after that (Retry and Edit answer the last message again). When that
 * message isn't saved yet (the browser saves its own changes a moment later), the turn goes last.
 */
export function placeTurn(messages: UIMessage[], { user, afterId, reply }: Turn): UIMessage[] {
  const others = messages.filter((m) => m.id !== user.id && m.id !== reply.id);
  if (afterId === null) return [user, reply];
  const at = others.findIndex((m) => m.id === afterId);
  return at === -1 ? [...others, user, reply] : [...others.slice(0, at + 1), user, reply];
}

/**
 * The messages with the finished reply in place of its pending one. Null when there's nothing to
 * save: the pending reply is gone but the user's message is there, so the message was answered
 * again (Retry or Edit). When both are gone, an older copy of the chat was saved over them (from
 * another tab), so the turn goes back after the message it follows, keeping everything else.
 */
export function placeReply(messages: UIMessage[], { user, afterId }: Turn, reply: UIMessage): UIMessage[] | null {
  if (messages.some((m) => m.id === reply.id)) return messages.map((m) => (m.id === reply.id ? reply : m));
  if (messages.some((m) => m.id === user.id)) return null;
  const at = afterId === null ? -1 : messages.findIndex((m) => m.id === afterId);
  if (afterId !== null && at === -1) return [...messages, user, reply];
  return [...messages.slice(0, at + 1), user, reply, ...messages.slice(at + 1)];
}

/**
 * Changes a project's saved messages (and name) with change(), written only if nothing saved the
 * project since they were read; tries again up to 3 times. False when the project is gone, change()
 * has nothing to save, or it never got its turn.
 */
export async function changeMessages(
  userId: string,
  projectId: string,
  change: (messages: UIMessage[], name: string) => { messages: UIMessage[]; name?: string } | null,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await one<{ name: string; messages: string; version: number }>(
      "SELECT name, messages, version FROM projects WHERE id = ? AND user_id = ?",
      [projectId, userId],
    );
    if (!row) return false;
    const next = change(JSON.parse(row.messages) as UIMessage[], row.name);
    if (!next) return false;
    // The name is written only when it changes: renaming doesn't raise the version, so a name read
    // here may already be out of date.
    const named = next.name !== undefined && next.name !== row.name;
    const r = await run(
      `UPDATE projects SET messages = ?, ${named ? "name = ?, " : ""}updated_at = ?, version = version + 1 WHERE id = ? AND user_id = ? AND version = ?`,
      [JSON.stringify(next.messages), ...(named ? [next.name!] : []), now(), projectId, userId, Number(row.version)],
    );
    if (r.rowsAffected === 1) return true;
  }
  return false;
}

/**
 * Saves a request's turn as it starts: the user's message and the pending reply. A chat is called
 * "New project" until its first message names it, as the browser names it.
 */
export function saveTurn(userId: string, projectId: string, turn: Turn): Promise<boolean> {
  return changeMessages(userId, projectId, (messages, name) => ({
    messages: placeTurn(messages, turn),
    name: name === "New project" && !messages.length ? turn.user.content.slice(0, 40).trim() || name : name,
  }));
}

/** Saves the finished reply in place of the pending one (see placeReply). */
export function saveReply(userId: string, projectId: string, turn: Turn, reply: UIMessage): Promise<boolean> {
  return changeMessages(userId, projectId, (messages) => {
    const next = placeReply(messages, turn, reply);
    return next && { messages: next };
  });
}

/** Replies still pending long after their request's time ran out (see PENDING_LIMIT_MS), shown as not finished with note. */
export function unfinished(messages: UIMessage[], note: string, at = now()): UIMessage[] {
  return messages.map((m) =>
    m.pending && (m.pendingSince ?? 0) < at - PENDING_LIMIT_MS
      ? { ...m, pending: undefined, pendingSince: undefined, status: undefined, error: m.error ?? note }
      : m,
  );
}
