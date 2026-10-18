/**
 * Runs work once the response has gone, with Next's after(), which keeps the server (a serverless
 * function too) running until the work is done, so the request doesn't wait for it (see
 * node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md, which also allows
 * after() inside an after() callback, as in the chat route's reply). Outside a request Next is
 * answering (a script, or a test that loads Flash's files in plain Node, where next/server can't be
 * imported), the work runs now, and the promise returned waits for it and rejects with its error.
 * A caller that doesn't wait (a low-credit check after a spend) catches the work's own errors, so
 * nothing it leaves running can reject.
 *
 * next/server is loaded as this module loads rather than imported by name, so the server modules
 * that use this still load in plain Node. Once it is loaded, after() is called at once, inside the
 * request that asked, never later when that request may be over.
 */
type After = (task: () => Promise<unknown>) => void;

// undefined while next/server is still loading, null where there is none.
let after: After | null | undefined;
const loading = import("next/server").then(
  (m) => void (after = m.after),
  () => void (after = null),
);

export async function afterResponse(work: () => Promise<unknown>): Promise<void> {
  // Only while the server is starting: next/server loads with the first module that uses this.
  if (after === undefined) await loading;
  if (after) {
    try {
      after(work);
      return;
    } catch {
      // Called outside a request scope: it runs now, below.
    }
  }
  await work();
}
