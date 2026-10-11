/*
 * next/server for route handlers loaded in a test (see route-hooks.mjs). after() keeps the work it is
 * given so the test can wait for it (afterwards), as Next keeps it alive after the response.
 */
const pending = (globalThis.__flashAfter ??= []);

export function after(task) {
  pending.push(Promise.resolve(typeof task === "function" ? task() : task));
}

/** Waits for everything after() was given so far. */
export const afterwards = () => Promise.allSettled(pending.splice(0));

export class NextResponse extends Response {}
