/*
 * The preview's History: every finished version of the chat's app or deck, numbered from 1, and
 * "Build on this version", a free message that copies an earlier one's file to the end of the chat,
 * so the next change is built on it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BROUGHT_BACK, BROUGHT_BACK_WHY, appVersions, bringBack } from "../src/lib/app-versions.ts";
import { chatRequestBody } from "../src/lib/chat-request.ts";
import { draftStore } from "../src/lib/live-draft.ts";
import type { UIMessage } from "../src/lib/store.ts";

register("./support/tsx-hooks.mjs", import.meta.url);
const { AppPreview } = await import("../src/components/AppPreview.tsx");
const { BuildPanel } = await import("../src/components/BuildPanel.tsx");

const built = (id: string, title: string, html: string, more: Partial<UIMessage> = {}): UIMessage => ({
  id,
  role: "assistant",
  content: "Here it is.",
  engine: "app",
  cost: 4,
  app: { title, html, kind: "app", slug: "golden-crumb" },
  ...more,
});
const chat: UIMessage[] = [
  { id: "u1", role: "user", content: "A bakery site" },
  built("a1", "Golden Crumb", "<h1>v1</h1>"),
  { id: "u2", role: "user", content: "Add a menu" },
  built("a2", "Golden Crumb menu", "<h1>v2</h1>"),
  { id: "u3", role: "user", content: "What time do you open?" },
  { id: "a3", role: "assistant", content: "We open at 8.", engine: "text" },
  { id: "u4", role: "user", content: "Make it darker" },
  built("a4", "Golden Crumb dark", "<h1>v3</h1>", { pending: true }),
];

test("the chat's versions are its finished apps and decks, oldest first, numbered from 1", () => {
  assert.deepEqual(appVersions(chat), [
    { id: "a1", n: 1, title: "Golden Crumb" },
    { id: "a2", n: 2, title: "Golden Crumb menu" },
  ]);
  assert.deepEqual(appVersions([]), []);
  // Once the one being written is finished, it's version 3.
  const done = chat.map((m) => (m.id === "a4" ? { ...m, pending: false } : m));
  assert.equal(appVersions(done).at(-1)?.n, 3);
});

test("Build on this version adds a free copy of that version's file, with no site of its own", () => {
  const back = bringBack(chat, "a1", "b1", (n) => `Version ${n} is back.`)!;
  assert.deepEqual(back, {
    id: "b1",
    role: "assistant",
    content: "Version 1 is back.",
    engine: "app",
    reason: BROUGHT_BACK_WHY,
    cost: 0,
    local: true,
    app: { title: "Golden Crumb", html: "<h1>v1</h1>", kind: "app" },
  });
  // Its site is found again when it's published (siteOf), so the copy never claims the slug.
  assert.equal("slug" in back.app!, false);
  // A deck stays a deck.
  const deck = [built("d1", "Pitch", "<section>1</section>", { engine: "slides", app: { title: "Pitch", html: "<section>1</section>", kind: "slides" } })];
  assert.equal(bringBack(deck, "d1", "b2", String)?.engine, "slides");
  assert.equal(bringBack(deck, "d1", "b2", String)?.app?.kind, "slides");
  // Nothing for a message that isn't a finished version.
  assert.equal(bringBack(chat, "a3", "b3", String), null);
  assert.equal(bringBack(chat, "a4", "b3", String), null);
  assert.equal(bringBack(chat, "gone", "b3", String), null);
  // Its words, in every language, through the table.
  assert.equal(BROUGHT_BACK, "Version {n} is the newest again. Flash builds on it from here.");
});

test("the next change is built on the version brought back, not on the one after it", () => {
  const done = chat.slice(0, 6);
  const back = bringBack(done, "a1", "b1", String)!;
  const body = chatRequestBody([...done, back], { id: "u5", role: "user", content: "Add opening hours" }, {
    choice: "auto",
    preferences: "",
    models: {},
    confirmed: false,
    projectId: "p1",
    connectors: [],
    actions: [],
    replyId: "r5",
    files: [],
  } as never);
  // Only the newest version's code goes with the request: the copy of version 1.
  const sent = body.messages.filter((m) => m.app);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].app, "<h1>v1</h1>");
  assert.equal(body.messages.indexOf(sent[0]), done.length);
  // And the follow-up goes on to the builder, as after any version.
  assert.equal(body.previous, "app");
});

const versions = (shown = "a2") => ({ list: appVersions(chat), shown, onShow: () => {} });
const app = { title: "Golden Crumb", html: "<h1>v1</h1>", kind: "app" as const };

test("History shows in the preview once there are two versions, and Build on this version only on an earlier one", () => {
  const two = renderToStaticMarkup(createElement(AppPreview, { app, onPublished: () => {}, versions: versions() } as never));
  assert.match(two, /aria-expanded="false" aria-label="History"/);
  assert.doesNotMatch(two, /Build on this version/);
  const one = renderToStaticMarkup(
    createElement(AppPreview, { app, onPublished: () => {}, versions: { ...versions(), list: appVersions(chat).slice(0, 1) } } as never),
  );
  assert.doesNotMatch(one, /aria-label="History"/);
  const earlier = renderToStaticMarkup(createElement(AppPreview, { app, onPublished: () => {}, onBuildOn: () => {} } as never));
  assert.match(earlier, /aria-label="Build on this version" title="Make this the newest version, so your next change builds on it"/);
});

const panel = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(BuildPanel, {
      drafts: draftStore(),
      appMsg: chat[3],
      drafting: false,
      live: false,
      busy: false,
      onPublished: () => {},
      onEditCode: () => {},
      onFix: () => {},
      onPick: () => {},
      versions: appVersions(chat),
      onShow: () => {},
      onBuildOn: () => {},
      ...props,
    } as never),
  );

test("an earlier version shows in the panel over the latest, which stays there, hidden, for Back to latest", () => {
  const html = panel({ older: { message: chat[1] } });
  assert.match(html, /role="status"[^>]*>[^]*You&#x27;re looking at version 1 of 2\. Your changes still go to the latest\./);
  assert.match(html, />Back to latest</);
  assert.match(html, />Build on this version</);
  // Both versions are on the page: the earlier one shown, the latest hidden and out of reach.
  assert.equal((html.match(/<iframe/g) ?? []).length, 2);
  assert.match(html, /<div inert="" class="[^"]*\bhidden\b/);
  // While Flash is busy, it can't be built on.
  assert.match(panel({ older: { message: chat[1] }, busy: true }), /<button disabled="" class="[^"]*bg-brand[^"]*">Build on this version</);
  // While Flash builds, the latest shows, as before.
  const building = panel({ older: { message: chat[1] }, building: chat[7], drafting: false });
  assert.doesNotMatch(building, /You&#x27;re looking at version/);
  // With no earlier one picked, only the latest.
  const latest = panel({});
  assert.doesNotMatch(latest, /Back to latest/);
  assert.equal((latest.match(/<iframe/g) ?? []).length, 1);
});
