/*
 * Which chats this page changed that the server may not have yet (see the save in Flash.tsx). A chat
 * changed here waits a moment and is then sent whole. Until the server has answered its newest save,
 * the page's copy is the newer one: while that save is uploading, and after it failed (it's sent
 * again with the chat's next change). The search check reads the server's copy only of a chat with
 * nothing unsaved (see chatForFix), so it never swaps the page's copy for an older one.
 */

export type ChatSaves = {
  /** A chat changed here: it's sent shortly. */
  changed: (id: string) => void;
  /** The chats changed and not sent yet. */
  waiting: () => string[];
  /** Nothing to send for a chat any more (it was deleted, or isn't loaded). */
  drop: (id: string) => void;
  /** Sends a chat (put), which is unsaved until put succeeds; its failure is passed on. */
  send: (id: string, put: () => Promise<unknown>) => Promise<void>;
  /** Whether the server may not have this page's copy of a chat: not sent yet, uploading, or failed. */
  unsaved: (id: string) => boolean;
};

export function chatSaves(): ChatSaves {
  const waiting = new Set<string>();
  // Each chat's saves: how many are uploading, the newest one's number, and whether that one failed.
  // An older save that answers after a newer one says nothing about what the server holds.
  const sent = new Map<string, { uploading: number; newest: number; failed: boolean }>();
  let count = 0;
  return {
    changed: (id) => void waiting.add(id),
    waiting: () => [...waiting],
    drop: (id) => void waiting.delete(id),
    async send(id, put) {
      waiting.delete(id);
      const n = ++count;
      const save = sent.get(id) ?? { uploading: 0, newest: 0, failed: false };
      sent.set(id, save);
      save.uploading++;
      save.newest = n;
      try {
        await put();
        if (save.newest === n) save.failed = false;
      } catch (err) {
        if (save.newest === n) save.failed = true;
        throw err;
      } finally {
        save.uploading--;
      }
    },
    unsaved: (id) => {
      const save = sent.get(id);
      return waiting.has(id) || (!!save && (save.uploading > 0 || save.failed));
    },
  };
}
