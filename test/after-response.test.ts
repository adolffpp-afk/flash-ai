import { test } from "node:test";
import assert from "node:assert/strict";

/*
 * afterResponse outside a request Next is answering (a script, or a test in plain Node, where
 * next/server can't be imported): the work runs at once and is waited for, as before. Inside one,
 * Next's after() runs it once the response has gone (see push.test.ts).
 */
const { afterResponse } = await import("../src/lib/server/after-response.ts");

test("outside a request, the work runs at once and is waited for, and its error comes back", async () => {
  let done = false;
  await afterResponse(async () => {
    await new Promise((r) => setTimeout(r, 50));
    done = true;
  });
  assert.equal(done, true);
  await assert.rejects(
    afterResponse(async () => {
      throw new Error("push service down");
    }),
    /push service down/,
  );
});
