import { test } from "node:test";
import assert from "node:assert/strict";

const { touchOf, isReturnTrip, taggedLink, share, percent, cleanTag, visitSource, stepName, stepsInHtml, DIRECT, OTHER } = await import("../src/lib/traffic.ts");

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
  // A phone number or an ID written with spaces, dots or dashes is one too.
  for (const value of ["+1 555 0100 2233", "555-123-4567", "415.555.0123", "+1 415-555-0123", "+44 7911 123456", "f47ac10b-58cc-4372-a567-0e02b2c3d479", "1_415_555_0123"]) {
    assert.equal(cleanTag(value), "", value);
  }
  assert.equal(touch("?ref=f47ac10b-58cc-4372-a567-0e02b2c3d479", "https://www.google.com/").source, "google.com");
  assert.deepEqual(touch("?utm_source=sms&utm_campaign=%2B44%207911%20123456"), { source: "sms", medium: "", campaign: "" });
  assert.deepEqual(touch("?utm_source=newsletter&utm_campaign=a1b2c3d4e5f6a7b8c9"), { source: "newsletter", medium: "", campaign: "" });
  assert.deepEqual(touch("?utm_source=🎉🎉", "https://www.bing.com/"), { source: "bing.com", medium: "", campaign: "" }, "empty once cleaned");
  assert.equal(touch(`?utm_source=${"x".repeat(5000)}`).source.length, 40);
  // Looked for again once cleaned, which joins what other characters kept apart, and in any digits.
  for (const value of ["415'555'0123", "+1(415)555'0123", "a1b2c3d4'e5f6a7b8c9d0", "٤١٥٥٥٥٠١٢٣", "４１５５５５０１２３"]) {
    assert.equal(cleanTag(value), "", value);
  }
  assert.equal(cleanTag("spring-2026"), "spring-2026");
  assert.equal(cleanTag("sale-10-17"), "sale-10-17");
  assert.equal(cleanTag("v1.2.3"), "v1.2.3");
  assert.equal(cleanTag("رمضان ٢٠٢٦"), "رمضان-٢٠٢٦", "a year in Arabic digits is fine");
});

test("an app's step names are the ones written out in its flashDB.track calls, at most 10", () => {
  const html = `<button onclick="flashDB.track('booking-started')">Book</button>
    <script>flashDB.track("Plan-Chosen"); window.flashDB?.track( \`menu-opened\` ); flashDB.track(\`viewed-\${cat}\`); flashDB.track(name);
    flashDB.track("checkout"); flashDB.track("order-12345678"); flashDB.track("booking-started")</script>`;
  assert.deepEqual(stepsInHtml(html), ["booking-started", "plan-chosen", "menu-opened"]);
  const many = Array.from({ length: 12 }, (_, i) => `flashDB.track("step-${i}")`).join(";");
  assert.equal(stepsInHtml(many).length, 10);
  assert.deepEqual(stepsInHtml("<p>no steps</p>"), []);
});

test("coming back from paying or signing in isn't a new visit", () => {
  assert.equal(isReturnTrip(new URL(`${APP}?flash_paid=1`), null), true);
  assert.equal(isReturnTrip(new URL(`${APP}?flash_auth=ok`), null), true);
  assert.equal(isReturnTrip(new URL(APP), "https://checkout.stripe.com/c/pay/cs_test_1"), true);
  assert.equal(isReturnTrip(new URL(APP), "https://www.google.com/"), false);
  assert.equal(isReturnTrip(new URL(`${APP}?utm_source=ig`), null), false);
  assert.equal(isReturnTrip(new URL(APP), "nonsense"), false);
});

test("a tag named like a built-in property of objects is a name like any other", () => {
  for (const name of ["constructor", "__proto__", "tostring", "hasownproperty", "valueof"]) {
    assert.deepEqual(touch(`?utm_source=${name}`), { source: name, medium: "", campaign: "" }, name);
    assert.equal(touch(`?ref=${name}`).source, name, name);
  }
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

test("a step an app reports is a fixed name, never an ID or a step Flash counts itself", () => {
  assert.equal(stepName("Booking-Started"), "booking-started");
  assert.equal(stepName(" plan_chosen "), "plan_chosen");
  assert.equal(stepName("x".repeat(40)), "x".repeat(40));
  assert.equal(stepName("x".repeat(41)), "");
  assert.equal(stepName("has space"), "");
  assert.equal(stepName("-leading"), "");
  assert.equal(stepName("order-1234567"), "", "7 digits in a row are an ID");
  assert.equal(stepName("step-a1b2c3d4e5f6a7b8"), "", "so are 16 hex characters");
  assert.equal(stepName("step-123456"), "step-123456");
  for (const own of ["visit", "form", "signup", "checkout", "order", "capped"]) assert.equal(stepName(own), "", own);
  assert.equal(stepName(42), "");
});
