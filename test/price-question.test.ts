import { test } from "node:test";
import assert from "node:assert/strict";
import { consents, decidedFor, priceWaiting } from "../src/lib/price-question.ts";
import type { UIMessage } from "../src/lib/store.ts";

// What the 409 sends back for a Sora 2 Pro video, as Go ahead and a spoken yes return it.
const asked = { engine: "video", model: "sora-2-pro", credits: 601 } as const;

test("Go ahead runs exactly the engine, model and price asked, and a dearer one is asked about again", () => {
  const body = { confirmed: true, decided: asked };
  const decided = decidedFor(body, null);
  assert.deepEqual(decided, { engine: "video", fresh: false, model: "sora-2-pro", credits: 601 });
  assert.equal(consents(body, decided, "sora-2-pro", 601), true);
  assert.equal(consents(body, decided, "sora-2-pro", 500), true, "cheaper than asked");
  assert.equal(consents(body, decided, "sora-2-pro", 602), false, "dearer than asked");
  assert.equal(consents(body, decided, "veo-3.1", 601), false, "another model");
});

test("typed Go ahead with a tool picked in the composer runs, instead of asking again and again", () => {
  // The Video tool sends engine "video" (override); Go ahead sends back what the price question asked.
  const body = { confirmed: true, decided: asked };
  const decided = decidedFor(body, "video");
  assert.equal(decided?.model, "sora-2-pro");
  assert.equal(consents(body, decided, "sora-2-pro", 601), true);
  // Another tool picked since: that price isn't this request's, so its own price is asked about.
  const other = decidedFor(body, "image");
  assert.equal(other, null);
  assert.equal(consents(body, other, "gpt-image", 26), false);
});

test("yes to every price still counts, and a chat saved before prices were kept goes ahead as before", () => {
  assert.equal(consents({ confirmed: true }, null, "sora-2-pro", 601), true, "always, on this device");
  const old = { confirmed: true, decided: { engine: "video" } };
  const decided = decidedFor(old, null);
  assert.deepEqual(decided, { engine: "video", fresh: false });
  assert.equal(consents(old, decided, "veo-3.1", 801), true);
});

test("nothing was agreed without confirmed, and junk sent back is ignored", () => {
  assert.equal(decidedFor({ decided: asked }, null), null);
  assert.equal(consents({ decided: asked }, null, "sora-2-pro", 601), false);
  assert.equal(consents({}, null, "sora-2-pro", 601), false);
  for (const decided of [null, "video", { engine: "nonsense" }, { engine: 3 }]) assert.equal(decidedFor({ confirmed: true, decided }, null), null);
  // A price that isn't a price is no price: only the engine counts.
  assert.deepEqual(decidedFor({ confirmed: true, decided: { engine: "image", model: "gpt-image", credits: -5 } }, null), { engine: "image", fresh: false });
  assert.deepEqual(decidedFor({ confirmed: true, decided: { engine: "image", fresh: true } }, null), { engine: "image", fresh: true });
});

const msg = (id: string, role: "user" | "assistant", more: Partial<UIMessage> = {}): UIMessage => ({ id, role, content: "", ...more });

test("a yes only goes ahead while the price question it answers is still waiting", () => {
  const question = msg("r1", "assistant", { error: "This Sora 2 Pro video uses 601 credits.", errorCode: "confirm_cost", decided: asked });
  const chat = [msg("u0", "user"), msg("r0", "assistant"), msg("u1", "user", { content: "a video of a dog surfing" }), question];
  assert.equal(priceWaiting(chat), true);
  assert.equal(priceWaiting(chat, "r1"), true);
  // Go ahead was pressed since: the video replaced the question, so a later "perfect!" makes nothing.
  const made = [...chat.slice(0, 3), msg("r2", "assistant", { videos: [{ url: "/v.mp4", prompt: "" }] })];
  assert.equal(priceWaiting(made), false);
  assert.equal(priceWaiting(made, "r1"), false);
  // Asked again (a new question for a new price): a yes to the old one doesn't count for it.
  const again = [...chat.slice(0, 3), { ...question, id: "r3" }];
  assert.equal(priceWaiting(again, "r1"), false);
  assert.equal(priceWaiting(again, "r3"), true);
  // Still running, a new request after it, or another kind of error: nothing is waiting.
  assert.equal(priceWaiting([...chat.slice(0, 3), { ...question, pending: true }]), false);
  assert.equal(priceWaiting([...chat, msg("u2", "user", { content: "now a cat" })]), false);
  assert.equal(priceWaiting([...chat.slice(0, 3), msg("r4", "assistant", { error: "Busy", errorCode: "busy" })]), false);
  assert.equal(priceWaiting([]), false);
});
