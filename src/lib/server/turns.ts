import type { UIMessage } from "../store.ts";
import { ENGINES, PENDING_LIMIT_MS, type Engine } from "../types.ts";
import { one, run, now } from "./db.ts";
import { projectTooLarge } from "../project-size.ts";

/*
 * The chat route saves each turn itself, so an answer is kept even when the page that asked for it
 * is closed: the user's message and a pending reply when the request starts, the finished reply
 * when it ends. Each is merged into the saved messages by message id, and written only if nothing
 * saved the project since they were read (projects.version, which every write of messages raises).
 * The browser's own saving (PUT /api/projects/[id]) goes through here too, and keeps the server's
 * copy of every reply a request is still working on (see keepRunning). Other messages are saved as
 * the browser sends them, so a tab with an older copy of a chat still saves over finished ones.
 */

export { PENDING_LIMIT_MS };

// Message ids are made by the browser (newId in store.ts).
export const MESSAGE_ID = /^[\w-]{1,64}$/;

// The same limit as the chat route's for a message.
const MAX_CONTENT_CHARS = 100_000;

/**
 * A request's turn: the user's message, the id of the message it follows (null for the first), and
 * the reply; name is what a new chat is called (a template's title), when the browser named it.
 */
export type Turn = { user: UIMessage; afterId: string | null; reply: UIMessage; name?: string };

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
export function requestTurn(body: { replyId?: unknown; userMessage?: unknown; afterId?: unknown; name?: unknown }): Turn | null {
  const replyId = typeof body.replyId === "string" && MESSAGE_ID.test(body.replyId) ? body.replyId : null;
  const user = cleanUserMessage(body.userMessage);
  const afterId = body.afterId === null ? null : typeof body.afterId === "string" && MESSAGE_ID.test(body.afterId) ? body.afterId : undefined;
  if (!replyId || !user || user.id === replyId || afterId === undefined) return null;
  // The same limit as a name saved with PUT /api/projects/[id].
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  return { user, afterId, reply: { id: replyId, role: "assistant", content: "", pending: true }, ...(name && { name }) };
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
 * "New project" until its first message names it, as the browser names it (a template's chat takes
 * the template's title, which the browser sends).
 */
export function saveTurn(userId: string, projectId: string, turn: Turn): Promise<boolean> {
  return changeMessages(userId, projectId, (messages, name) => ({
    messages: placeTurn(messages, turn),
    name: name === "New project" && !messages.length ? turn.name || turn.user.content.slice(0, 40).trim() || name : name,
  }));
}

/** Saves the finished reply in place of the pending one (see placeReply). */
export function saveReply(userId: string, projectId: string, turn: Turn, reply: UIMessage): Promise<boolean> {
  return changeMessages(userId, projectId, (messages) => {
    const next = placeReply(messages, turn, reply);
    return next && { messages: next };
  });
}

/** A reply a request is still working on: pending, and not yet past its request's time (see PENDING_LIMIT_MS). */
const running = (m: UIMessage, at: number) => Boolean(m.pending) && (m.pendingSince ?? 0) >= at - PENDING_LIMIT_MS;

/**
 * The messages a browser saves (PUT /api/projects/[id]), with the server's copy of every reply a
 * request is still working on, which only that request saves:
 * - a reply the server is still working on is kept as the server has it, whatever the copy says
 *   (Share, or a tab that gave up on it);
 * - a reply the browser still shows as pending is kept as the server has it, so a reply the server
 *   just finished isn't saved over before the page has it;
 * - a pending reply the server hasn't saved (its request saves it in a moment, or a tab with an
 *   older copy saved over it) is kept pending, so its request can still put the answer in its place;
 * - a reply the server is working on that the copy leaves out (a tab with a copy from before it
 *   started, or a save sent just before Retry) goes back after its message, in place of the
 *   answer the copy has there, or with its message after the one it followed.
 * Everything else is saved as the browser sends it.
 */
export function keepRunning(saved: UIMessage[], incoming: UIMessage[], at = now()): UIMessage[] {
  const byId = new Map(saved.map((m) => [m.id, m]));
  const out = incoming.map((m) => {
    const kept = byId.get(m.id);
    if (kept && (running(kept, at) || m.pending)) return kept;
    // The server's clock, never the copy's: a copy can't keep a reply pending for longer than its request's time.
    if (!kept && m.pending) return { ...m, pendingSince: at };
    return m;
  });
  const have = new Set(out.map((m) => m.id));
  saved.forEach((reply, i) => {
    if (!running(reply, at) || have.has(reply.id)) return;
    const asked = saved[i - 1]?.role === "user" ? saved[i - 1] : null;
    const where = asked ? out.findIndex((m) => m.id === asked.id) : -1;
    if (where !== -1) {
      // Retry and Edit answer a message again, so the answer after it in the copy is the old one.
      const old = out[where + 1]?.role === "assistant" && !byId.has(out[where + 1].id) ? 1 : 0;
      out.splice(where + 1, old, reply);
    } else {
      const turn = asked ? [asked, reply] : [reply];
      const before = saved[i - turn.length];
      const from = before ? out.findIndex((m) => m.id === before.id) : -1;
      out.splice(from === -1 ? out.length : from + 1, 0, ...turn);
      for (const m of turn) have.add(m.id);
    }
    have.add(reply.id);
  });
  return out;
}

/**
 * Saves a browser's copy of a chat (PUT /api/projects/[id]) with its name, keeping the server's copy
 * of every reply a request is still working on (see keepRunning). "too large" when the chat as it
 * would be saved, with those replies, is over the size limit; "not saved" when the chat is gone or
 * never got its turn.
 */
export async function saveCopy(
  userId: string,
  projectId: string,
  incoming: UIMessage[],
  name?: string,
): Promise<"saved" | "too large" | "not saved"> {
  let tooLarge = false;
  const saved = await changeMessages(userId, projectId, (messages, current) => {
    const merged = keepRunning(messages, incoming);
    tooLarge = projectTooLarge(JSON.stringify(merged));
    return tooLarge ? null : { messages: merged, name: name ?? current };
  });
  return saved ? "saved" : tooLarge ? "too large" : "not saved";
}

/** Replies still pending long after their request's time ran out (see PENDING_LIMIT_MS), shown as not finished with note. */
export function unfinished(messages: UIMessage[], note: string, at = now()): UIMessage[] {
  return messages.map((m) =>
    m.pending && (m.pendingSince ?? 0) < at - PENDING_LIMIT_MS
      ? { ...m, pending: undefined, pendingSince: undefined, status: undefined, error: m.error ?? note }
      : m,
  );
}
