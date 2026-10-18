import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

/*
 * As shipped, assistants are off: every assistant route, for every method, is a 404, whoever asks
 * and however, before it reads the database (here one that can't be opened, so any read fails).
 * Each route answers every method itself, the ones it doesn't take too: Next would answer OPTIONS
 * with the methods it takes and the others with 405, which tells it from a path that isn't there.
 * Their work is tested with the switch on in assistants-api.test.ts.
 */
register("./support/route-hooks.mjs", import.meta.url);
process.env.DATABASE_URL = "file:/nonexistent-folder/flash-assistants-off/never.db";

const { ASSISTANTS_ON } = await import("../src/lib/assistants.ts");
const routes = {
  "/api/assistants": await import("../src/app/api/assistants/route.ts"),
  "/api/assistants/[id]": await import("../src/app/api/assistants/[id]/route.ts"),
  "/api/assistants/[id]/files": await import("../src/app/api/assistants/[id]/files/route.ts"),
  "/api/assistants/[id]/files/[fileId]": await import("../src/app/api/assistants/[id]/files/[fileId]/route.ts"),
  "/api/assistants/[id]/chats": await import("../src/app/api/assistants/[id]/chats/route.ts"),
};
// Every method a route can answer (see node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md).
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

test("every assistant route is a 404 while assistants are off, without reading the database", async () => {
  assert.equal(ASSISTANTS_ON, false, "nothing about assistants reaches anyone before the price line ships");
  const id = "0123456789abcdef".repeat(2);
  const params = { id, fileId: "f1" };
  let answered = 0;
  for (const [path, route] of Object.entries(routes)) {
    const handlers = route as unknown as Record<string, ((r: Request, c: unknown) => Promise<Response>) | undefined>;
    assert.deepEqual(METHODS.filter((m) => typeof handlers[m] !== "function"), [], `${path} answers every method itself`);
    for (const method of METHODS) {
      const url = `http://localhost${path.replace("[id]", id).replace("[fileId]", "f1")}`;
      const res = await handlers[method]!(
        new Request(url, {
          method,
          headers: { origin: "http://localhost", cookie: "flash_session=anything", "content-type": "application/json" },
          ...(method !== "GET" && method !== "HEAD" && { body: JSON.stringify({ name: "Bakery helper", version: 0 }) }),
        }),
        { params: Promise.resolve(params) },
      );
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.deepEqual(await res.json(), { error: "Not found" });
      answered++;
    }
  }
  assert.equal(answered, 5 * METHODS.length, "every method of each of the five routes");
});
