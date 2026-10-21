import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./support/route-hooks.mjs", import.meta.url);
process.env.DATABASE_URL = ":memory:";

const { run, one } = await import("../src/lib/server/db.ts");
const { createSession } = await import("../src/lib/server/auth.ts");
const projects = await import("../src/app/api/projects/route.ts");
const { newChatId } = await import("../src/lib/store.ts");

const make = (cookie: string, body: unknown) =>
  projects.POST(new Request("https://www.flash-app.dev/api/projects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));

test("a new chat takes the id the page made, so the first message shows before the server answers; a taken one is refused", async () => {
  for (const id of ["ua", "ub"]) await run("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, '', 0)", [id, `${id}@example.com`]);
  const ann = (await createSession("ua", true)).split(";")[0];
  const ben = (await createSession("ub", true)).split(";")[0];

  const id = newChatId();
  assert.match(id, /^[A-Za-z0-9_-]{16}$/, "made like the server's ids");
  const res = await make(ann, { id });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { project: { id: string } }).project.id, id);
  assert.equal((await one<{ user_id: string }>("SELECT user_id FROM projects WHERE id = ?", [id]))?.user_id, "ua");

  // Someone else's id is never taken over, nor the same one made twice.
  assert.equal((await make(ben, { id })).status, 409);
  assert.equal((await make(ann, { id })).status, 409);
  assert.equal((await one<{ user_id: string }>("SELECT user_id FROM projects WHERE id = ?", [id]))?.user_id, "ua");

  // Anything else isn't an id: the server makes one, as before.
  for (const odd of ["short", "x".repeat(40), "a/b;c'd=e f-g_hi", 12345]) {
    const made = ((await (await make(ann, { id: odd })).json()) as { project: { id: string } }).project.id;
    assert.notEqual(made, odd);
    assert.match(made, /^[A-Za-z0-9_-]{16}$/);
  }
});
