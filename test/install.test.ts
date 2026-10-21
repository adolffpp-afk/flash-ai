import { test } from "node:test";
import assert from "node:assert/strict";
import { INSTALL_STEPS, installPlatform, onIos } from "../src/lib/install.ts";

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  android: "Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
  firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
  firefoxMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0",
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0",
  chromeIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1",
  instagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0 (iPhone15,2; iOS 18_0; en_US)",
  facebookAndroid: "Mozilla/5.0 (Linux; Android 15; SM-S938B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0.0.0;]",
};

test("each browser gets its own install steps", () => {
  assert.equal(installPlatform(UA.iphone), "ios");
  assert.equal(installPlatform(UA.ipad, 5), "ios");
  assert.equal(installPlatform(UA.ipad, 0), "mac-safari");
  assert.equal(installPlatform(UA.android), "android");
  // Firefox installs web apps on Windows only, from a button in its address bar.
  assert.equal(installPlatform(UA.firefox), "firefox-windows");
  assert.equal(installPlatform(UA.firefoxMac), "firefox");
  assert.match(INSTALL_STEPS["firefox-windows"][0], /address bar/);
  assert.equal(installPlatform(UA.chromeMac), "desktop");
  assert.equal(installPlatform(UA.edge), "desktop");
  for (const steps of Object.values(INSTALL_STEPS)) assert.ok(steps.length >= 2);
});

test("an iPhone gets steps for its own browser, and an app's browser is sent to the real one", () => {
  // Safari on iOS 26 hides Share behind •••, and Add to Home Screen behind View More.
  assert.match(INSTALL_STEPS.ios[0], /iOS 26.*•••/);
  assert.match(INSTALL_STEPS.ios[1], /View More/);
  assert.equal(installPlatform(UA.chromeIphone), "ios-browser");
  assert.match(INSTALL_STEPS["ios-browser"].at(-1)!, /Safari/);
  assert.equal(installPlatform(UA.instagram), "in-app");
  assert.equal(installPlatform(UA.facebookAndroid), "in-app");
  assert.match(INSTALL_STEPS["in-app"][1], /Open in browser/);
  assert.ok(onIos(UA.chromeIphone) && onIos(UA.instagram) && onIos(UA.ipad, 5));
  assert.ok(!onIos(UA.ipad, 0) && !onIos(UA.android));
});
