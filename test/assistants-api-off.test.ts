import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire, register } from "node:module";
import { fileURLToPath } from "node:url";

/*
 * As shipped, assistants are off, and their routes aren't routes: they're in src/app/api/_assistants,
 * a private folder, which Next leaves out of routing, so every method on every path under
 * /api/assistants gets Next's own 404, as any path Flash doesn't have does, and the proxy runs
 * before it as before any other. Should they be routed early, each still answers every method with
 * a 404, whoever asks and however, before it reads the database (here one that can't be opened, so
 * any read fails). Their work is tested with the switch on in assistants-api.test.ts.
 */
register("./support/route-hooks.mjs", import.meta.url);
process.env.DATABASE_URL = "file:/nonexistent-folder/flash-assistants-off/never.db";

const { ASSISTANTS_ON } = await import("../src/lib/assistants.ts");
const routes = {
  "/api/assistants": await import("../src/app/api/_assistants/route.ts"),
  "/api/assistants/[id]": await import("../src/app/api/_assistants/[id]/route.ts"),
  "/api/assistants/[id]/files": await import("../src/app/api/_assistants/[id]/files/route.ts"),
  "/api/assistants/[id]/files/[fileId]": await import("../src/app/api/_assistants/[id]/files/[fileId]/route.ts"),
  "/api/assistants/[id]/chats": await import("../src/app/api/_assistants/[id]/chats/route.ts"),
};
const require = createRequire(import.meta.url);

test("while assistants are off, Next finds no assistant route, and the proxy runs for every path there", async () => {
  assert.equal(ASSISTANTS_ON, false);
  // Next's own route discovery, as next build and next start run it.
  const { collectAppFiles } = require("next/dist/build/route-discovery.js");
  const { createValidFileMatcher } = require("next/dist/server/lib/find-page-file.js");
  const app = fileURLToPath(new URL("../src/app", import.meta.url));
  const { appPaths } = (await collectAppFiles(app, createValidFileMatcher(["tsx", "ts", "jsx", "js"], app))) as { appPaths: string[] };
  assert.ok(appPaths.includes("/api/projects/route.ts"), "it finds Flash's other routes");
  assert.deepEqual(appPaths.filter((p) => /assistant/.test(p)), []);
  for (const path of Object.keys(routes)) assert.ok(existsSync(new URL(`../src/app${path.replace("assistants", "_assistants")}/route.ts`, import.meta.url)), path);
  assert.equal(existsSync(new URL("../src/app/api/assistants", import.meta.url)), false, "renamed only when assistants are turned on");

  // So a custom domain, or Flash's own request out, gets the proxy's answer there as anywhere else.
  const { config } = await import("../src/proxy.ts");
  const { getMiddlewareMatchers } = require("next/dist/build/analysis/get-page-static-info.js");
  const matchers = (getMiddlewareMatchers(config.matcher, {}) as { regexp: string }[]).map((m) => new RegExp(m.regexp));
  const id = "0123456789abcdef".repeat(2);
  for (const p of ["/api/assistants", `/api/assistants/${id}`, `/api/assistants/${id}/files`, `/api/assistants/${id}/files/f1`, `/api/assistants/${id}/chats`, "/api/nothing-here"]) {
    assert.ok(matchers.some((m) => m.test(p)), `the proxy runs for ${p}`);
  }
});
// Every method a route can answer (see node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md).
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

test("routed early, every assistant route is still a 404 for every method while assistants are off, without reading the database", async () => {
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
