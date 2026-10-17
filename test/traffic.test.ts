import { test } from "node:test";
import assert from "node:assert/strict";

const { touchOf, isReturnTrip, taggedLink, share, percent, cleanTag, visitSource, DIRECT, OTHER } = await import("../src/lib/traffic.ts");

const APP = "https://www.flash-app.dev/p/crumb-1";
const touch = (query: string, referer: string | null = null, host = "www.flash-app.dev") => touchOf(new URL(`${APP}${query}`), referer, host);

test("link tags say where a visit came from, folded to the names a referrer gives", () => {
  assert.deepEqual(touch("?utm_source=Facebook&utm_medium=Paid&utm_campaign=Spring Sale"), { source: "facebook.com", medium: "paid", campaign: "spring-sale" });
  for (const [tag, source] of [
    ["fb", "facebook.com"],
    ["ig", "instagram.com"],
    ["twitter", "x.com"],
    ["x", "x.com"],
    ["yt", "youtube.com"],
    ["m.facebook.com", "facebook.com"],
    ["www.google.de", "google.com"],
    ["newsletter", "newsletter"],
    ["QR flyer", "qr-flyer"],
  ]) {
    assert.equal(touch(`?utm_source=${encodeURIComponent(tag)}`).source, source, tag);
  }
  assert.deepEqual(touch("?ref=producthunt&utm_medium=email"), { source: "producthunt", medium: "", campaign: "" }, "ref, with no utm_source, has no medium or campaign");
  assert.deepEqual(touch("?utm_source=newsletter&ref=producthunt").source, "newsletter");
  assert.deepEqual(touch("?utm_medium=email&utm_campaign=x"), DIRECT, "a medium alone says nothing");
  // utm_content and utm_term are never read.
  assert.deepEqual(touch("?utm_source=ig&utm_content=story-2&utm_term=cake"), { source: "instagram.com", medium: "", campaign: "" });
});

test("ad clicks count as paid, and a tag beats them", () => {
  assert.deepEqual(touch("?gclid=Cj0KCQjw"), { source: "google.com", medium: "paid", campaign: "" });
  assert.deepEqual(touch("?gbraid=0AAAAA"), { source: "google.com", medium: "paid", campaign: "" });
  assert.deepEqual(touch("?wbraid=Cj0K"), { source: "google.com", medium: "paid", campaign: "" });
  assert.deepEqual(touch("?msclkid=5f2a"), { source: "bing.com", medium: "paid", campaign: "" });
  assert.equal(touch("?gclid=Cj0KCQjw&utm_source=newsletter").source, "newsletter");
  assert.deepEqual(touch("?fbclid=IwAR0", "https://l.facebook.com/"), { source: "facebook.com", medium: "", campaign: "" }, "fbclid is on unpaid links too");
});

test("without tags the referring website is the source, as before", () => {
  for (const [referer, host, source] of [
    [null, "www.flash-app.dev", ""],
    ["https://www.flash-app.dev/", "www.flash-app.dev", ""],
    ["https://crumbbakery.com/#/menu", "crumbbakery.com", ""],
    ["https://www.google.ca/", "crumbbakery.com", "google.com"],
    ["https://l.instagram.com/?u=x", "crumbbakery.com", "instagram.com"],
    ["https://m.facebook.com/", "crumbbakery.com", "facebook.com"],
    ["https://t.co/abc", "crumbbakery.com", "x.com"],
    ["https://www.yelp.ca/biz/crumb", "crumbbakery.com", "yelp.ca"],
    ["android-app://com.google.android.gm", "crumbbakery.com", ""],
    ["not a url", "crumbbakery.com", ""],
  ] as const) {
    assert.equal(visitSource(referer, host), source, String(referer));
    assert.deepEqual(touch("", referer, host), { source, medium: "", campaign: "" }, String(referer));
  }
});

test("tags are cleaned, and ones that look like personal data are left out", () => {
  assert.ok(cleanTag("a".repeat(300)).length <= 40);
  assert.equal(cleanTag("🎉🎉 party 🎉"), "party");
  assert.equal(cleanTag("春セール"), "春セール", "campaign names in any script");
  assert.equal(cleanTag("दिवाली ऑफ़र"), "दिवाली-ऑफ़र", "with their vowel signs");
  assert.equal(cleanTag("<script>alert(1)</script>"), "scriptalert1script");
  assert.equal(cleanTag("  Spring   Sale  "), "spring-sale");
  assert.equal(cleanTag(""), "");
  assert.equal(cleanTag(null), "");
  // An email address, a phone number, a subscriber's ID: the tag counts as missing, and the referrer is used.
  assert.equal(touch("?utm_source=jane@x.com", "https://www.google.com/").source, "google.com");
  assert.equal(touch("?ref=12345678", "https://www.google.com/").source, "google.com");
  assert.equal(touch("?ref=+1 555 0100 2233").source, "1-555-0100-2233", "a number with spaces in it isn't seven digits in a row");
  assert.deepEqual(touch("?utm_source=newsletter&utm_campaign=a1b2c3d4e5f6a7b8c9"), { source: "newsletter", medium: "", campaign: "" });
  assert.deepEqual(touch("?utm_source=🎉🎉", "https://www.bing.com/"), { source: "bing.com", medium: "", campaign: "" }, "empty once cleaned");
  assert.equal(touch(`?utm_source=${"x".repeat(5000)}`).source.length, 40);
});

test("coming back from paying or signing in isn't a new visit", () => {
  assert.equal(isReturnTrip(new URL(`${APP}?flash_paid=1`), null), true);
  assert.equal(isReturnTrip(new URL(`${APP}?flash_auth=ok`), null), true);
  assert.equal(isReturnTrip(new URL(APP), "https://checkout.stripe.com/c/pay/cs_test_1"), true);
  assert.equal(isReturnTrip(new URL(APP), "https://www.google.com/"), false);
  assert.equal(isReturnTrip(new URL(`${APP}?utm_source=ig`), null), false);
  assert.equal(isReturnTrip(new URL(APP), "nonsense"), false);
});

test("a tagged link counts under exactly the names it shows", () => {
  const link = taggedLink(`${APP}#/menu`, { source: "Instagram", campaign: "Spring Sale" });
  assert.equal(link, `${APP}?utm_source=instagram&utm_campaign=spring-sale#/menu`);
  assert.deepEqual(touchOf(new URL(link), null, "www.flash-app.dev"), { source: "instagram.com", medium: "", campaign: "spring-sale" });
  assert.equal(taggedLink(APP, { source: "QR flyer" }), `${APP}?utm_source=qr-flyer`);
  assert.equal(touchOf(new URL(taggedLink(APP, { source: "春", campaign: "セール" })), null, null).campaign, "セール");
  assert.equal(taggedLink(`${APP}?utm_campaign=old`, { source: "ig" }), `${APP}?utm_source=ig`, "an old campaign doesn't stay on");
  assert.equal(taggedLink(APP, { source: "" }), APP);
  assert.equal(taggedLink(APP, { source: "jane@x.com" }), APP, "never a link carrying an email address");
  assert.equal(OTHER.source, "(other)");
});

test("a share of visitors only from 100 visitors, written the reader's way", () => {
  assert.equal(share(3, 99), null);
  assert.equal(share(120, 100), null, "never more than everyone");
  assert.equal(share(14, 612), 14 / 612);
  assert.equal(percent(share(14, 612)!, "en-US"), "2.3%", "one decimal under 10%");
  assert.equal(percent(share(300, 612)!, "en-US"), "49%");
  assert.match(percent(0.023, "fr-FR"), /^2,3\s%$/u);
  assert.match(percent(0.023, "tr-TR"), /^%2,3$/u);
});
