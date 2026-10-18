import { test } from "node:test";
import assert from "node:assert/strict";

const { touchOf, isReturnTrip, taggedLink, shareSource, share, percent, cleanTag, visitSource, stepName, stepsInHtml, DIRECT, OTHER } = await import("../src/lib/traffic.ts");

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
  assert.equal(cleanTag("community-forum.bakers-and-pastry-chefs-association.example"), "community-forum.bakers-and-pastry-chefs", "a name cut in the middle ends in no dash");
  assert.equal(cleanTag(`${"x".repeat(39)}.com`), "x".repeat(39), "nor in a dot");
  assert.equal(cleanTag("spring-sale-"), "spring-sale-", "a name that fits is kept as it is");
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

test("a campaign named with its date keeps it, while phone numbers and IDs written with separators are still left out", () => {
  for (const [value, kept] of [
    ["newsletter-2026-10-18", "newsletter-2026-10-18"],
    ["black-friday-2026-11-27", "black-friday-2026-11-27"],
    ["spring_sale_2026_03_14", "spring_sale_2026_03_14"],
    ["2026-10-18", "2026-10-18"],
    ["2026.10.18", "2026.10.18"],
    ["event-10-18-2026", "event-10-18-2026"],
    ["18.10.2026", "18.10.2026"],
    ["webinar 2026 10 18", "webinar-2026-10-18"],
    ["2026-10-18-to-2026-10-25", "2026-10-18-to-2026-10-25"],
    // Mailchimp's own campaign tag: its campaign's code, then the day and time it was sent.
    ["c2b0b8f1a6-EMAIL_CAMPAIGN_2026_10_18_02_15", "c2b0b8f1a6-email_campaign_2026_10_18_02"],
  ]) {
    assert.equal(cleanTag(value), kept, value);
  }
  assert.deepEqual(touch("?utm_source=newsletter&utm_medium=email&utm_campaign=newsletter-2026-10-18"), { source: "newsletter", medium: "email", campaign: "newsletter-2026-10-18" });
  assert.equal(touch("?utm_source=newsletter-2026-10-18", "https://www.google.com/").source, "newsletter-2026-10-18");
  assert.equal(taggedLink(APP, { source: "newsletter", campaign: "2026-10-18" }), `${APP}?utm_source=newsletter&utm_campaign=2026-10-18`);
  // A date doesn't let a phone number or an ID through, beside it or in its shape.
  for (const value of ["+1 415-555-0123", "f47ac10b-58cc-4372-a567-0e02b2c3d479", "2026-10-18 415-555-0123", "+49 30 1234 5678", "+44 20 7946 0958", "promo_20261018", "2026-10-18-4155550123"]) {
    assert.equal(cleanTag(value), "", value);
  }
});

test("a machine's code is left out like an ID, and so is an email address written in base64, while names people write are kept", () => {
  for (const value of [
    "01GDDKASAP8TKDDA2GRZDSVP4H", // a ULID, as Klaviyo's profile IDs are
    "01gddkasap8tkdda2grzdsvp4h",
    "V1StGXR8_Z5jdHi6B-myT", // nanoid
    "cus_NffrFeUfNV2Hib", // Stripe
    "pi_3MtwBwLkdIwHu7ix28a3tqPa",
    "-JhLeOlGIEjaIOFHR0xd", // Firebase
    "-NxYzAbCdEfGhIjKlMnO",
    "0ujtsYcgvSTl8PAuAdqWYSMnLOv", // KSUID
    "cjld2cjxh0000qzrmn831i7rn", // cuid
    "aGVsbG8td29ybGQtdXNlcg",
    "YW5hLmxvcGV6QGV4YW1wbGUuY29t", // ana.lopez@example.com
    "Ym9iQHguaW8", // bob@x.io
    "KzEgNDE1IDU1NSAwMTIz", // +1 415 555 0123
  ]) {
    assert.equal(cleanTag(value), "", value);
  }
  assert.equal(touch("?ref=YW5hLmxvcGV6QGV4YW1wbGUuY29t", "https://www.google.com/").source, "google.com");
  for (const value of [
    "InstagramStory",
    "SpringSale2026",
    "FacebookAdsSpringSale2026",
    "YouTubeTikTokInstagram",
    "SummerSale2026EmailV2",
    "GiftGuide2026Top10Picks",
    "iPhoneLaunch",
    "LinkedInPost",
    "McDonalds",
    "FY26Q4Launch",
    "covid19relief2026",
    "Welcome Series (RjXWsJ)",
    "newsletter",
    "producthunt",
    "BFCM26EarlyBird",
  ]) {
    assert.notEqual(cleanTag(value), "", value);
  }
});

test("a tag keeps no character that draws nothing, so it can't pass for another source or for none", () => {
  assert.equal(touch("?utm_source=instagram.com%EF%B8%8F").source, "instagram.com", "a variation selector");
  assert.equal(touch("?utm_source=goo%CD%8Fgle.com").source, "google.com", "the combining grapheme joiner");
  assert.equal(touch("?utm_source=ig%F3%A0%84%80").source, "instagram.com", "a supplementary variation selector");
  assert.deepEqual(touch("?utm_source=%E3%85%A4%E3%85%A4", "https://www.bing.com/"), { source: "bing.com", medium: "", campaign: "" }, "Hangul fillers are no name");
  for (const blank of ["ᅟᅠ", "ﾠ", "឴឵", "᠋", "-", "._-", "́́"]) assert.equal(cleanTag(blank), "", JSON.stringify(blank));
  assert.equal(cleanTag("ｉｎｓｔａｇｒａｍ"), "instagram", "written the one way");
  assert.equal(cleanTag("jane＠x.com"), "", "a full-width @ is an @");
  assert.equal(cleanTag("415͏555͏0123"), "", "nor does one keep a phone number's digits apart");
  assert.equal(cleanTag("دیوار‌نوشته"), "دیوارنوشته", "Persian's joiner-free spelling, as before");
  assert.equal(cleanTag("दिवाली ऑफ़र"), "दिवाली-ऑफ़र", "vowel signs after their letter stay");
});

test("a web address typed as where a link is shared counts under its site's name, as the link shows", () => {
  for (const [typed, name] of [
    ["https://mybakeryblog.com/autumn-post", "mybakeryblog.com"],
    ["facebook.com/groups/bakers", "facebook.com"],
    ["https://www.instagram.com/mybakery/", "instagram.com"],
    ["http://partner.example:8080/x?y=1", "partner.example"],
  ]) {
    const link = taggedLink(APP, { source: typed, campaign: "autumn" });
    assert.equal(link, `${APP}?utm_source=${name}&utm_campaign=autumn`, typed);
    assert.equal(touchOf(new URL(link), null, "www.flash-app.dev").source, name, typed);
    assert.equal(shareSource(typed), name, typed);
  }
  assert.equal(shareSource("TikTok / Reels"), "tiktok-reels", "a name with a slash in it is a name");
  assert.equal(shareSource("https://jane@x.com/"), "", "never an address carrying an email address");
  assert.equal(shareSource("Instagram"), "instagram");
});

test("steps written as optional calls, or with spaces, are the app's steps too", () => {
  const html = `<script>flashDB.track?.("booked"); window.flashDB?.track?.('paid'); flashDB .track ( "viewed" ); flashDB?.track("shared")</script>`;
  assert.deepEqual(stepsInHtml(html), ["booked", "paid", "viewed", "shared"]);
  assert.deepEqual(stepsInHtml(`flashDB.tracking("x"); myflashDB.trackers("y")`), []);
});
