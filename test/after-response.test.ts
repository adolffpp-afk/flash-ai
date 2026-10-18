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

test("outside a request, a low-credit check that isn't waited for logs its error and never leaves a rejection behind", async () => {
  process.env.DATABASE_URL = ":memory:";
  const { run } = await import("../src/lib/server/db.ts");
  const { noteAppAiOutOfCredits, watchBalance, watchRefusal } = await import("../src/lib/server/low-balance.ts");
  // Every check after a spend or refusal reads these, so each one fails.
  await run("DROP TABLE auto_topups");
  await run("DROP TABLE site_ai");
  const rejections: unknown[] = [];
  const onRejection = (err: unknown) => rejections.push(err);
  process.on("unhandledRejection", onRejection);
  const logged: unknown[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void logged.push(args[0]);
  try {
    watchBalance("someone", 5);
    watchRefusal(["someone"]);
    noteAppAiOutOfCredits("shop", "someone", "Bakery");
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    console.error = realError;
    process.off("unhandledRejection", onRejection);
  }
  assert.deepEqual(rejections, []);
  assert.equal(logged.filter((m) => String(m).includes("low-credit check after the response failed")).length, 3, logged.join("\n"));
});
