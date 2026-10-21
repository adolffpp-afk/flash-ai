/*
 * The saves a page has under way (a chat's changes, the preferences), so that before a tab leaves
 * its account Flash waits for them too: a switch reloads the tab, and a reload cancels a save the
 * browser is still sending (a chat with its apps can be hundreds of KB on a slow connection).
 */
export function saveTracker() {
  const going = new Set<Promise<boolean>>();
  return {
    /** Counts a save (true when it was kept) until it ends; returns it. */
    track(save: Promise<boolean>): Promise<boolean> {
      going.add(save);
      const done = () => void going.delete(save);
      save.then(done, done);
      return save;
    },
    /** Whether every save under way now ends kept within ms: false when one failed, or is still going then. */
    settled(ms: number): Promise<boolean> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      });
      const all = Promise.all([...going]).then(
        (kept) => kept.every(Boolean),
        () => false,
      );
      return Promise.race([all, late]).finally(() => clearTimeout(timer));
    },
  };
}
