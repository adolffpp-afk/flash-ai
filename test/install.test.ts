import { test } from "node:test";
import assert from "node:assert/strict";
import { INSTALL_STEPS, installPlatform } from "../src/lib/install.ts";

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  android: "Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
  firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
  firefoxMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0",
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0",
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
