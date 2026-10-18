/**
 * Runs work once the response is sent, so whatever asked for it (a reply that spent credits, a
 * visitor's question) is never slowed or failed by it: through Next's after() while a request is
 * being answered, which keeps a serverless function alive until the work is done (see
 * node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md, which also allows
 * after() inside an after() callback, as in the chat route's reply). Outside a request (a script,
 * a test without route-hooks.mjs) it simply starts the work. Errors are logged, never thrown.
 *
 * next/server is loaded as this module loads rather than imported by name, so the server modules
 * that use this still load in plain Node (the tests), where there is no next/server to load. Once
 * it is loaded, after() is called at once, inside the request that asked, never later when that
 * request may be over.
 */
type After = (task: () => Promise<unknown>) => void;

// undefined while next/server is still loading, null where there is none.
let after: After | null | undefined;
const loading = import("next/server").then(
  (m) => void (after = m.after),
  () => void (after = null),
);

export function afterResponse(work: () => Promise<unknown>): void {
  const go = () => work().catch((err) => console.error("[flash] work after the response failed", err));
  // Only while the server is starting: next/server loads with the first module that uses this.
  if (after === undefined) return void loading.then(() => afterResponse(work));
  try {
    if (after) return after(go);
  } catch {
    // No request being answered: after() throws, and the work starts now.
  }
  void go();
}
