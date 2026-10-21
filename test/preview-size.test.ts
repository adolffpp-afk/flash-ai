/*
 * The build preview's sizes and its "On your phone" button: a tablet or phone frame keeps that
 * width (the app's own layout for it shows) and is drawn smaller in a narrower panel, slides always
 * fill the width, and only the owner of an app, or a published one, gets the phone button.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PREVIEW_SIZES, frameFor, previewSize } from "../src/lib/preview-size.ts";

register("./support/tsx-hooks.mjs", import.meta.url);
const { AppPreview } = await import("../src/components/AppPreview.tsx");

test("the size saved on this device is used only when it's one Flash knows, and never for slides", () => {
  assert.equal(previewSize("", "app"), "");
  assert.equal(previewSize("phone", "app"), "phone");
  assert.equal(previewSize("tablet", "app"), "tablet");
  // Whatever else is in the browser's storage, even a name every object has, means the computer size.
  for (const saved of ["toString", "constructor", "desktop", "PHONE", " phone"]) assert.equal(previewSize(saved, "app"), "", saved);
  assert.equal(previewSize("phone", "slides"), "");
  assert.equal(previewSize("tablet", "slides"), "");
});

test("a tablet or phone frame keeps its width, centred, and is drawn smaller only when the panel is narrower", () => {
  assert.equal(frameFor("", { width: 900, height: 600 }), undefined, "the computer size fills the panel");
  // Room for it: the real width, a 12px gap above and below.
  const phone = frameFor("phone", { width: 900, height: 600 })!;
  assert.equal(phone.width, PREVIEW_SIZES.phone);
  assert.equal(phone.width, 390);
  assert.equal(phone.height, 576);
  assert.equal(phone.top, 12);
  assert.equal(phone.left, "50%");
  assert.equal(phone.transform, "translateX(-50%) scale(1)");
  assert.equal(phone.transformOrigin, "top center");
  // A tablet in a 600px panel: still 820px wide to the app, drawn at the panel's width less the gaps,
  // and taller inside, so once drawn smaller it still reaches the bottom of the panel.
  const tablet = frameFor("tablet", { width: 600, height: 560 })!;
  const scale = 576 / 820;
  assert.equal(tablet.width, 820);
  assert.equal(tablet.transform, `translateX(-50%) scale(${scale})`);
  assert.ok(Math.abs(tablet.width * scale - 576) < 1e-9);
  assert.ok(Math.abs(tablet.height * scale - 536) < 1e-9);
  // Before the panel is measured, full size; a panel smaller than the gaps never gives a zero or negative size.
  assert.equal(frameFor("phone", { width: 0, height: 0 })!.transform, "translateX(-50%) scale(1)");
  assert.equal(frameFor("phone", { width: 0, height: 0 })!.height, 0);
  assert.equal(frameFor("tablet", { width: 10, height: 10 })!.transform, "translateX(-50%) scale(0.1)");
});

const app = (kind: "app" | "slides" = "app") => ({ title: "Golden Crumb", html: "<h1>Golden Crumb</h1>", kind });
const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(AppPreview, { app: app(), ...props } as never));

test("the toolbar offers computer, tablet and phone sizes for an app, with the computer size picked at first", () => {
  const html = render({ onPublished: () => {} });
  for (const label of ["Computer size", "Tablet size", "Phone size"]) assert.match(html, new RegExp(`aria-label="${label}"`));
  assert.match(html, /aria-pressed="true" aria-label="Computer size"/);
  assert.match(html, /aria-pressed="false" aria-label="Tablet size"/);
  assert.match(html, /aria-pressed="false" aria-label="Phone size"/);
  // At the computer size the app fills the panel, as before.
  assert.match(html, /<iframe[^>]*class="block h-full w-full bg-paper"/);
  assert.doesNotMatch(html, /<iframe[^>]*style=/);
  // Slides fill the width: no sizes to pick.
  const slides = renderToStaticMarkup(createElement(AppPreview, { app: app("slides"), onPublished: () => {} } as never));
  assert.doesNotMatch(slides, /Phone size/);
});

test("On your phone shows for the app's owner, not for a draft someone else is looking at", () => {
  assert.match(render({ onPublished: () => {} }), /aria-label="Open on your phone"/);
  assert.doesNotMatch(render({}), /Open on your phone/);
  // Its QR code is made only once it's opened, in the browser.
  assert.doesNotMatch(render({ onPublished: () => {} }), /QR code to open it on your phone/);
});
