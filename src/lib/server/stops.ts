import { one, run, now } from "./db.ts";

/*
 * Stop for a chat reply. Closing the page doesn't stop a request (it goes on, and its answer is
 * saved), so the Stop button says so itself: POST /api/chat/stop records it here by the reply's id.
 * The request answering it hears at once when it runs on the same server instance, else from the
 * database within POLL_MS. A Stop pressed before its request started is still heard.
 */
const POLL_MS = 1500;
// Stops older than this are cleared away; no request runs nearly that long.
const KEEP_MS = 24 * 3600_000;

type Listeners = Map<string, () => void>;
// Each route is bundled on its own, so the requests running on this instance are kept on globalThis.
const KEY = Symbol.for("flash.chatStops");
const scope = globalThis as typeof globalThis & { [KEY]?: Listeners };
const listeners: Listeners = (scope[KEY] ??= new Map());

const keyOf = (userId: string, replyId: string) => `${userId}:${replyId}`;

/** Records Stop for a reply, and tells its request at once when it runs on this instance. */
export async function requestStop(userId: string, replyId: string): Promise<void> {
  listeners.get(keyOf(userId, replyId))?.();
  await run("INSERT OR IGNORE INTO chat_stops (user_id, reply_id, created_at) VALUES (?, ?, ?)", [userId, replyId, now()]);
  await run("DELETE FROM chat_stops WHERE created_at < ?", [now() - KEEP_MS]);
}

/**
 * Calls onStop once, when Stop is pressed for this reply (or already was). Returns the function that
 * ends the watch, which the request calls when it ends.
 */
export function watchStop(userId: string, replyId: string, onStop: () => void, pollMs = POLL_MS): () => void {
  const key = keyOf(userId, replyId);
  let over = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const end = () => {
    over = true;
    clearTimeout(timer);
    if (listeners.get(key) === heard) listeners.delete(key);
  };
  const heard = () => {
    if (over) return;
    end();
    onStop();
  };
  const check = async () => {
    try {
      if (await one("SELECT 1 FROM chat_stops WHERE user_id = ? AND reply_id = ?", [userId, replyId])) heard();
    } catch (err) {
      console.error("[flash] checking for Stop failed", err);
    }
    if (!over) timer = setTimeout(check, pollMs);
  };
  listeners.set(key, heard);
  void check();
  return end;
}
