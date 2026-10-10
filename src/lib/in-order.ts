/*
 * Changes that must reach the server in the order they were made, like the rules an owner picks in
 * My websites & apps › Data, where moving through a list with the arrow keys picks one after
 * another. Each key (an app) sends one change at a time, so the server saves the last one last,
 * and only the answer to the last change is shown: it was read after every change before it, so
 * it's what the server holds. When a change fails, what the server holds is loaded and shown
 * instead, so the screen never keeps a choice that may not have been saved.
 */

export type InOrder<T> = {
  /** Sends a change once the ones made before it for this key have their answers. */
  save: (key: string, send: () => Promise<T>) => Promise<void>;
  /** Waits until every change made so far for this key has its answer, and it's shown. */
  settled: (key: string) => Promise<void>;
};

export function inOrder<T>(on: {
  // What the server holds now, after a change failed.
  reload: (key: string) => Promise<T>;
  // The server's state after the last change, or null when it couldn't be loaded.
  show: (key: string, state: T | null) => void;
  // A change failed.
  failed: (key: string) => void;
}): InOrder<T> {
  const queues = new Map<string, { last: Promise<void>; pending: number; failed: boolean }>();
  const queue = (key: string) => {
    let q = queues.get(key);
    if (!q) queues.set(key, (q = { last: Promise.resolve(), pending: 0, failed: false }));
    return q;
  };
  const answer = (promise: Promise<T>) => promise.then((state): T | null => state, () => null);
  return {
    save(key, send) {
      const q = queue(key);
      q.pending++;
      q.last = q.last
        .then(async () => {
          let state = await answer(send());
          if (state === null) q.failed = true;
          // A later change is on its way, and its answer will be newer.
          if (--q.pending > 0) return;
          if (q.failed) {
            q.failed = false;
            on.failed(key);
            state = await answer(on.reload(key));
            if (q.pending > 0) return;
          }
          on.show(key, state);
        })
        // The next change is sent whatever happened to this one.
        .catch((err) => console.error("[flash] saving in order failed", err));
      return q.last;
    },
    settled: (key) => queue(key).last,
  };
}
