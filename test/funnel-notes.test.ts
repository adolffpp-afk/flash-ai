/*
 * The Visitors view's notes on its limits (FunnelNotes), rendered as the page shows them: the upgrade
 * offer for a free owner whose counting paused on 2 or more of the last 7 days, the paused note's own
 * upgrade link on a single day, none for a paid plan, and today's pause under the plan the owner had
 * before buying one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FunnelStats } from "../src/lib/server/funnel.ts";

register("./support/tsx-hooks.mjs", import.meta.url);
const { FunnelNotes } = await import("../src/components/FunnelView.tsx");

const zero = { visitors: 0, form: 0, signup: 0, checkout: 0, orders: 0, revenue: [] };
const stats = (over: Partial<FunnelStats>): FunnelStats => ({
  days: 30,
  today: "2026-10-18",
  from: "2026-09-19",
  shownDays: 30,
  totals: zero,
  sources: [],
  rest: null,
  unmatched: { form: 0, signup: 0, checkout: 0, orders: 0, revenue: [] },
  refunded: { orders: 0, revenue: [] },
  appSteps: [],
  paused: [],
  pausedToday: null,
  stepsPaused: [],
  stepsPausedToday: null,
  netCapped: null,
  free: false,
  pausedWeek: null,
  addresses: ["https://www.flash-app.dev/p/bakery"],
  empty: false,
  ...over,
});
const render = (over: Partial<FunnelStats>, onPlans: (() => void) | null = () => {}) =>
  renderToStaticMarkup(createElement(FunnelNotes, { stats: stats(over), onPlans: onPlans ?? undefined }));
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
const WEEK = "Your apps reached the free plan&#x27;s 1,000 people a day on 2 of the last 7 days.";
const TODAY = "Counting paused at 1,000 people across your apps";

test("a free owner paused on 2 of the last 7 days, but not today, sees the week's sentence and Upgrade to count more visitors", () => {
  const html = render({ free: true, pausedWeek: { days: 2, people: 1_000 }, paused: [{ day: "2026-10-17", people: 1_000 }] });
  assert.ok(html.includes(WEEK), html);
  assert.ok(html.includes("Paid plans count more people: 20,000 a day on Lite, up to 500,000 on Agency."), html);
  assert.deepEqual(buttons(html), ["Upgrade to count more visitors"]);
  assert.ok(!html.includes(TODAY), html);
  // With its app steps paused today too: one offer, after the week's sentence.
  const steps = render({ free: true, pausedWeek: { days: 2, people: 1_000 }, stepsPausedToday: 100 });
  assert.ok(steps.indexOf(WEEK) < steps.indexOf("Your apps&#x27; own steps stopped counting at 100"), steps);
  assert.deepEqual(buttons(steps), ["Upgrade to count more visitors"]);
});

test("paused today and on other days this week: today's note, with Upgrade to count more visitors", () => {
  const html = render({ free: true, pausedToday: 1_000, pausedWeek: { days: 3, people: 1_000 } });
  assert.ok(html.includes(TODAY), html);
  assert.ok(!html.includes("of the last 7 days"), html);
  assert.deepEqual(buttons(html), ["Upgrade to count more visitors"]);
});

test("paused on one day only: today's note keeps Upgrade plan, and a paid plan sees no offer", () => {
  const once = render({ free: true, pausedToday: 1_000 });
  assert.ok(once.includes(TODAY), once);
  assert.ok(!once.includes("of the last 7 days"), once);
  assert.deepEqual(buttons(once), ["Upgrade plan"]);
  const paid = render({ free: false, pausedToday: 20_000 });
  assert.ok(paid.includes("Counting paused at 20,000 people across your apps"), paid);
  assert.deepEqual(buttons(paid), []);
  assert.ok(!paid.includes("Paid plans count more"), paid);
  // Nothing paused at all: no notes.
  assert.equal(render({ free: false }), "");
  // Where the plans can't be opened, the offer is said without a button.
  const noButton = render({ free: true, pausedWeek: { days: 2, people: 1_000 } }, null);
  assert.ok(noButton.includes(WEEK), noButton);
  assert.deepEqual(buttons(noButton), []);
});

test("the offer's button is aligned with its note, so a long label (French, Russian...) doesn't wrap as a centred block", () => {
  for (const html of [render({ free: true, pausedWeek: { days: 2, people: 1_000 } }), render({ free: true, pausedToday: 1_000 }), render({ free: true, stepsPausedToday: 100 })]) {
    const button = html.match(/<button[^>]*>/)![0];
    assert.match(button, /class="[^"]*\btext-start\b/, button);
  }
});

test("after a plan bought today, today's pause is said as earlier today under the previous plan, never as that plan's limit on a past day", () => {
  // As funnelStats gives it right after the purchase (see visit-limits.test.ts): today's marks, with
  // counting going on today, and an earlier day.
  const after = render({ free: false, paused: [{ day: "2026-10-18", people: 1_000 }, { day: "2026-10-13", people: 1_000 }], stepsPaused: [{ day: "2026-10-18", steps: 100 }] });
  assert.ok(after.includes("Earlier today, counting paused at 1,000 people across your apps, your previous plan&#x27;s daily limit. Your new plan counts more."), after);
  assert.ok(after.includes("Earlier today, your apps&#x27; own steps stopped counting at 100, your previous plan&#x27;s daily limit. Your new plan counts more."), after);
  assert.ok(!after.includes("Oct 18"), after);
  assert.ok(!after.includes(TODAY), after);
  assert.ok(after.includes("On Oct 13, counting paused at 1,000 people across your apps"), after);
  assert.deepEqual(buttons(after), []);
  // Still paused today: today's note only, said once.
  const still = render({ free: true, pausedToday: 1_000, paused: [{ day: "2026-10-18", people: 1_000 }], stepsPausedToday: 100, stepsPaused: [{ day: "2026-10-18", steps: 100 }] });
  assert.ok(still.includes(TODAY), still);
  assert.ok(still.includes("Your apps&#x27; own steps stopped counting at 100 (your plan&#x27;s daily limit)."), still);
  assert.ok(!still.includes("Earlier today") && !still.includes("Oct 18"), still);
});
