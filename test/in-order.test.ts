import { test } from "node:test";
import assert from "node:assert/strict";
import { inOrder } from "../src/lib/in-order.ts";

/** A server that saves one rule, answers each request when told to, and says what it holds. */
function server() {
  let rule = "read";
  let most = 0;
  const waiting: (() => void)[] = [];
  const later = <T,>(work: () => T) =>
    new Promise<T>((resolve, reject) => {
      waiting.push(() => {
        try {
          resolve(work());
        } catch (err) {
          reject(err);
        }
      });
      most = Math.max(most, waiting.length);
    });
  return {
    held: () => rule,
    // The most requests that were on their way at once.
    most: () => most,
    save: (next: string, fail = false) => later(() => {
      if (fail) throw new Error("offline");
      rule = next;
      return rule;
    }),
    load: () => later(() => rule),
    // Answers the requests waiting, oldest first (or newest first), as a network might, until no
    // more come.
    answer: async (newestFirst = false) => {
      for (;;) {
        await new Promise((r) => setTimeout(r, 0));
        if (!waiting.length) return;
        (newestFirst ? waiting.pop() : waiting.shift())!();
      }
    },
  };
}

test("changes reach the server one at a time, and only the last answer is shown", async () => {
  const api = server();
  const shown: (string | null)[] = [];
  const errors: string[] = [];
  const saves = inOrder<string>({ reload: () => api.load(), show: (_, state) => shown.push(state), failed: (key) => errors.push(key) });
  // Arrowing through the list picks three rules, one after another.
  for (const rule of ["open", "add", "private"]) void saves.save("app", () => api.save(rule));
  // Only one is on its way at a time, so however the network answers, the server saves them in
  // order, and the screen shows the last.
  await api.answer(true);
  await saves.settled("app");
  assert.equal(api.most(), 1);
  assert.equal(api.held(), "private");
  assert.deepEqual(shown, ["private"]);
  assert.deepEqual(errors, []);
});

test("when a change fails, the screen shows what the server holds", async () => {
  const api = server();
  const shown: (string | null)[] = [];
  const errors: string[] = [];
  const saves = inOrder<string>({ reload: () => api.load(), show: (_, state) => shown.push(state), failed: (key) => errors.push(key) });
  // The first change is saved, the second fails: the screen goes back to the first, not to what was there before both.
  void saves.save("app", () => api.save("open"));
  void saves.save("app", () => api.save("add", true));
  await api.answer();
  await saves.settled("app");
  assert.equal(api.held(), "open");
  assert.deepEqual(shown, ["open"]);
  assert.deepEqual(errors, ["app"]);
  // A failure that's followed by a change that works shows that change's answer, and still says one failed.
  void saves.save("app", () => api.save("own", true));
  void saves.save("app", () => api.save("private"));
  await api.answer();
  await saves.settled("app");
  assert.deepEqual(shown, ["open", "private"]);
  assert.deepEqual(errors, ["app", "app"]);
  // When even that can't be loaded, the screen is told so (null) rather than keeping a guess.
  const offline = () => Promise.reject(new Error("offline"));
  const lost: (string | null)[] = [];
  const cut = inOrder<string>({ reload: offline, show: (_, state) => lost.push(state), failed: () => {} });
  await cut.save("app", offline);
  assert.deepEqual(lost, [null]);
});

test("each app's changes are kept apart", async () => {
  const one = server();
  const two = server();
  const shown: string[] = [];
  const saves = inOrder<string>({ reload: async () => "", show: (key, state) => shown.push(`${key}:${state}`), failed: () => {} });
  void saves.save("one", () => one.save("add"));
  void saves.save("two", () => two.save("open"));
  await two.answer();
  await saves.settled("two");
  assert.deepEqual(shown, ["two:open"], "one app's answer doesn't wait for the other's");
  await one.answer();
  await saves.settled("one");
  assert.deepEqual(shown, ["two:open", "one:add"]);
});
