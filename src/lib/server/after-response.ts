/**
 * Runs work once the response has gone, with Next's after(), which keeps the server (a serverless
 * function too) running until the work is done, so the request doesn't wait for it. Outside a
 * request Next is answering (a script, or a test that loads Flash's files in plain Node, where
 * next/server can't be imported), the work runs now and is waited for.
 */
export async function afterResponse(work: () => Promise<unknown>): Promise<void> {
  const after = await import("next/server").then(
    (next) => next.after,
    () => null,
  );
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
