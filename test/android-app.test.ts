import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ANDROID_PACKAGE, ANDROID_CERT_SHA256, assetLinks } from "../src/lib/android-app.ts";

test("assetlinks.json vouches only for Flash's own Android app, with well-formed fingerprints", () => {
  const links = assetLinks();
  assert.equal(links.length, 1);
  assert.equal(links[0].target.package_name, ANDROID_PACKAGE);
  assert.ok(ANDROID_CERT_SHA256.length > 0);
  for (const sha of ANDROID_CERT_SHA256) assert.match(sha, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});

test("the Android project uses the same package name and site", () => {
  const gradle = readFileSync(new URL("../android/app/build.gradle", import.meta.url), "utf8");
  assert.ok(gradle.includes(`applicationId "${ANDROID_PACKAGE}"`));
  assert.ok(gradle.includes("hostName: 'www.flash-app.dev'"));
});

test("the Android app is recognised by its launch link or Chrome's referrer, and nothing else", async () => {
  const { isAndroidLaunch } = await import("../src/lib/android-shell.ts");
  assert.equal(isAndroidLaunch("?app=android", ""), true);
  assert.equal(isAndroidLaunch("", `android-app://${ANDROID_PACKAGE}/`), true);
  assert.equal(isAndroidLaunch("", "https://www.google.com/"), false);
  assert.equal(isAndroidLaunch("?app=ios", "android-app://com.example.other/"), false);
  const gradle = readFileSync(new URL("../android/app/build.gradle", import.meta.url), "utf8");
  assert.ok(gradle.includes("launchUrl: '/?app=android'"), "the app opens with the launch link");
});
