import { test } from "node:test";
import assert from "node:assert/strict";

const { FEATURES, FEATURE_GROUPS, FEATURE_PAGES, featureReady, findFeatures, isInstall } = await import("../src/lib/features.ts");
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

test("only planned features are marked coming soon, and paid ones are the site add-ons", () => {
  assert.deepEqual(FEATURES.filter((f) => f.soon).map((f) => f.title), ["Automations"]);
  assert.deepEqual(FEATURES.filter((f) => f.paid).map((f) => f.title), ["Your Own Domain", "Sell on Your Site"]);
});

test("a feature is ready when it's built and its tool, model and server setup are ready", () => {
  const byTitle = (t: string) => FEATURES.find((f) => f.title === t)!;
  const everything: FeatureSetup = { isLive: () => true, modelLive: () => true, payments: true, domains: true };
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
  assert.equal(ready("Automations"), false, "planned, not built");
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
