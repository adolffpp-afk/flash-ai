import { test } from "node:test";
import assert from "node:assert/strict";

const { FEATURES, FEATURE_GROUPS, FEATURE_PAGES, comingSoon, createLine, featureReady, findFeatures, hiddenUntilReady, isInstall } = await import("../src/lib/features.ts");
const { MODELS } = await import("../src/lib/models.ts");
type FeatureSetup = import("../src/lib/features.ts").FeatureSetup;
const { ENGINES } = await import("../src/lib/types.ts");
const { TEMPLATES } = await import("../src/lib/templates.ts");

test("Everything Flash can do lists each feature once, in a known group, opening a known place", () => {
  const titles = FEATURES.map((f) => f.title);
  assert.equal(new Set(titles).size, titles.length, "no feature twice");
  for (const group of FEATURE_GROUPS) assert.ok(FEATURES.some((f) => f.group === group), `${group} has features`);
  for (const f of FEATURES) {
    assert.ok(FEATURE_GROUPS.includes(f.group), f.title);
    assert.ok(f.about.length > 0 && f.about.length <= 70, `${f.title}: one short line`);
    if ("tool" in f.action) assert.ok(f.action.tool === "auto" || ENGINES.includes(f.action.tool), f.title);
    if ("open" in f.action) assert.ok(FEATURE_PAGES.includes(f.action.open), f.title);
    if ("href" in f.action) assert.match(f.action.href, /^\/[a-z]/, `${f.title} links inside Flash`);
    if (f.needs) assert.ok(ENGINES.includes(f.needs), f.title);
  }
  // Every engine Flash has is somewhere in the list.
  for (const e of ENGINES) assert.ok(FEATURES.some((f) => ("tool" in f.action && f.action.tool === e) || f.needs === e), e);
  // A template a feature opens exists.
  for (const page of FEATURE_PAGES.filter((p) => p.startsWith("template:"))) {
    assert.ok(TEMPLATES.some((t) => t.id === page.slice("template:".length)), page);
  }
});

test("no feature is only planned now, and paid ones are the site add-ons", () => {
  assert.deepEqual(FEATURES.filter((f) => f.soon).map((f) => f.title), []);
  assert.deepEqual(FEATURES.filter((f) => f.paid).map((f) => f.title), ["Your Own Domain", "Sell on Your Site"]);
});

test("a feature is ready when it's built and its tool, model and server setup are ready", () => {
  const byTitle = (t: string) => FEATURES.find((f) => f.title === t)!;
  const everything: FeatureSetup = { isLive: () => true, modelLive: () => true, payments: true, domains: true, connectors: true, automations: true };
  const ready = (t: string, change: Partial<FeatureSetup> = {}) => featureReady(byTitle(t), { ...everything, ...change });
  assert.equal(ready("AI Chat", { isLive: () => false, modelLive: () => false }), true, "needs nothing");
  assert.equal(ready("Image"), true);
  assert.equal(ready("Image", { isLive: (e: string) => e !== "image" }), false);
  // Photo edits run only on fal's models, so OpenAI alone (image live, edit models not) isn't enough.
  for (const t of ["Edit a Photo", "Combine Photos", "Remove Background", "Upscale", "Animate a Photo", "Social Post Pack", "Movie Maker"]) {
    assert.equal(ready(t, { modelLive: () => false }), false, t);
    assert.equal(ready(t), true, t);
  }
  assert.equal(ready("Movie Maker", { isLive: (e: string) => e !== "video" }), false, "no video tool");
  assert.equal(ready("Sell on Your Site", { payments: false }), false);
  assert.equal(ready("Your Own Domain", { domains: false }), false);
  assert.equal(ready("Your Own Domain", { payments: false }), true);
  // Automations are ready once they are set up here and open to the account; until then they show as coming.
  assert.equal(ready("Automations"), true);
  assert.equal(ready("Automations", { automations: false }), false);
  assert.equal(comingSoon(byTitle("Automations"), { ...everything, automations: false }), true);
  assert.equal(comingSoon(byTitle("Automations"), everything), false);
  assert.deepEqual(FEATURES.filter((f) => comingSoon(f, everything)).map((f) => f.title), []);
  // Connectors work only once CONNECTOR_KEYS is set, and until then they aren't listed at all.
  assert.equal(ready("Use Your Accounts in Chat"), true);
  assert.equal(ready("Use Your Accounts in Chat", { connectors: false }), false);
  assert.equal(hiddenUntilReady(byTitle("Use Your Accounts in Chat"), { ...everything, connectors: false }), true);
  assert.equal(hiddenUntilReady(byTitle("Use Your Accounts in Chat"), everything), false);
  assert.deepEqual(FEATURES.filter((f) => hiddenUntilReady(f, { ...everything, connectors: false })).map((f) => f.title), ["Use Your Accounts in Chat"]);
  // Every model a feature names exists.
  for (const f of FEATURES.filter((f) => f.model)) assert.ok(MODELS.some((m) => m.id === f.model && m.engine === f.needs), f.title);
});

test("Install Flash is the one feature hidden inside the installed app", () => {
  assert.deepEqual(FEATURES.filter(isInstall).map((f) => f.title), ["Install Flash"]);
});

test("the search finds features by name and by other words for them", () => {
  const titles = (q: string) => findFeatures(q).map((f) => f.title);
  assert.deepEqual(titles("background"), ["Remove Background"]);
  assert.deepEqual(titles("  REMOVE bAck "), ["Remove Background"]);
  assert.ok(titles("powerpoint").includes("Slides"));
  assert.ok(titles("instagram").includes("Social Post Pack"));
  assert.ok(titles("mcp").includes("Flash in Claude and ChatGPT"));
  assert.deepEqual(titles(""), []);
  assert.deepEqual(titles("zzz"), []);
});

test("Create on the landing page names only the media tools that are live: video needs fal.ai, pictures don't", () => {
  const with_ = (...live: string[]) => createLine((e) => live.includes(e));
  // fal.ai: everything.
  assert.equal(with_("image", "video", "music", "voice"), "Pictures, video, music and voice-overs from a few words.");
  // OpenAI alone makes pictures but no videos; with ElevenLabs, music and voice-overs too.
  assert.equal(with_("image"), "Pictures from a few words.");
  assert.equal(with_("image", "music", "voice"), "Pictures, music and voice-overs from a few words.");
  assert.equal(with_("music", "voice"), "Music and voice-overs from a few words.");
  assert.equal(with_("image", "video"), "Pictures and video from a few words.");
});
