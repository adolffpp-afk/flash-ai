import { test } from "node:test";
import assert from "node:assert/strict";

const { touchOf, isReturnTrip, taggedLink, shareSource, share, percent, cleanTag, passesForLatin, visitSource, stepName, stepsInHtml, DIRECT, OTHER } = await import("../src/lib/traffic.ts");

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
  assert.equal(cleanTag("<script>alert(1)</script>"), "scriptalert1-script");
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

test("a campaign named for a season, a year and a number, or a date written with slashes keeps it, while phone numbers holding a year are still left out", () => {
  for (const [value, kept] of [
    ["season-2026-2027", "season-2026-2027"],
    ["ski season 2026-2027", "ski-season-2026-2027"],
    ["tax-year-2025-2026", "tax-year-2025-2026"],
    ["school-year-2026-2027", "school-year-2026-2027"],
    ["season-2025-26", "season-2025-26"],
    ["2026-2027-enrolment", "2026-2027-enrolment"],
    ["season 2025–2026", "season-2025-2026"],
    ["2026-100-day-challenge", "2026-100-day-challenge"],
    ["summer-2026-500-giveaway", "summer-2026-500-giveaway"],
    ["giveaway-1000-2026", "giveaway-1000-2026"],
    ["top-100-2026", "top-100-2026"],
    ["newsletter 10/18/2026", "newsletter-10-18-2026"],
    ["black-friday-11/27/2026", "black-friday-11-27-2026"],
    ["fete-18/10/2026", "fete-18-10-2026"],
    // Klaviyo's own campaign name, with its campaign's code: the date and time it was made.
    ["Email Campaign - Oct 18, 2026, 2:15 PM (RjXWsJ)", "email-campaign-oct-18-2026-2-15-pm-rjxws"],
  ]) {
    assert.equal(cleanTag(value), kept, value);
    assert.equal(cleanTag(kept), kept, `${value}, read again from the link`);
  }
  assert.deepEqual(touch("?utm_source=newsletter&utm_medium=email&utm_campaign=season-2026-2027"), { source: "newsletter", medium: "email", campaign: "season-2026-2027" });
  assert.equal(taggedLink(APP, { source: "newsletter", campaign: "newsletter 10/18/2026" }), `${APP}?utm_source=newsletter&utm_campaign=newsletter-10-18-2026`);
  for (const value of ["415-2026-2027", "555-123-2026", "+1 415 555 2026", "(415) 555-1999", "415/555/0123", "415:555:0123", "415–555–0123", "+852 2019 1234"]) {
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
    // Two-letter words and acronyms, alone or with a number.
    "LinkedInB2BLeadsQ3",
    "LinkedInAdsQ4US",
    "B2BWebinarQ1EMEA",
    "BackToSchoolUSA2026Email",
    "BlackFridayUSA2026EmailV2",
    "GoToMarketQ4UK",
    "HowToBakeBreadAtHomeQ4",
    "GoogleAdsPMaxQ4US",
    "iOSAppLaunchUSandCA",
    "iOS iPadOS macOS launch",
    "YouTubeTV-AppleTV-iOS",
  ]) {
    assert.notEqual(cleanTag(value), "", value);
  }
  assert.deepEqual(touch("?utm_source=linkedin&utm_medium=paid&utm_campaign=LinkedInB2BLeadsQ3"), { source: "linkedin.com", medium: "paid", campaign: "linkedinb2bleadsq3" });
  assert.equal(taggedLink(APP, { source: "LinkedIn", campaign: "iOS iPadOS macOS launch" }), `${APP}?utm_source=linkedin&utm_campaign=ios-ipados-macos-launch`);
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
  assert.equal(cleanTag("+1 4́1́5́ 5́5́5́ 0́1́2́3́"), "", "marks on a phone number's digits don't hide it, as they aren't kept");
  assert.deepEqual(touch(`?utm_source=newsletter&utm_campaign=${encodeURIComponent("+1 4́1́5́ 5́5́5́ 0́1́2́3́")}`), { source: "newsletter", medium: "", campaign: "" });
});

test("a word mixing Latin letters with another alphabet's lookalikes is no source", () => {
  for (const query of ["?utm_source=%D1%96nstagram.com", "?utm_source=instagr%D0%B0m.com", "?utm_source=g%CE%BF%CE%BFgle.com&utm_medium=paid"]) {
    assert.deepEqual(touch(query, "https://www.bing.com/"), { source: "bing.com", medium: "", campaign: "" }, query);
  }
  assert.equal(cleanTag("ѕpring-sale"), "", "a Cyrillic ѕ");
  for (const [value, kept] of [
    ["sale распродажа", "sale-распродажа"],
    ["распродажа", "распродажа"],
    ["Tシャツセール", "tシャツセール"],
    ["kpop콘서트", "kpop콘서트"],
    ["Ωmega", ""],
  ]) {
    assert.equal(cleanTag(value), kept, value);
  }
});

test("an email address encoded twice in a link is still an email address, and a name encoded twice reads as written", () => {
  assert.deepEqual(touch("?utm_source=newsletter&utm_campaign=ana.lopez%2540gmail.com"), { source: "newsletter", medium: "", campaign: "" });
  assert.equal(touch("?ref=maria.garcia%2540outlook.com", "https://www.google.com/").source, "google.com");
  assert.equal(cleanTag("ana.lopez%2540gmail.com"), "");
  assert.equal(touch("?utm_source=newsletter&utm_campaign=spring%2520sale").campaign, "spring-sale");
  assert.equal(cleanTag("100%off"), "100off", "a % that is no escape is left out as before");
  assert.equal(cleanTag("%E0%A4"), "e0a4", "nor is a broken one read");
});

test("what people write between words in a tag is a dash", () => {
  assert.equal(cleanTag("Facebook/Instagram"), "facebook-instagram");
  assert.equal(cleanTag("flyer/poster"), "flyer-poster");
  assert.equal(cleanTag("Spring | Facebook"), "spring-facebook");
  assert.equal(cleanTag("ads+organic"), "ads-organic");
  assert.equal(cleanTag("Spring - Sale"), "spring-sale");
  assert.equal(cleanTag("H&M"), "hm");
  assert.equal(taggedLink(APP, { source: "Facebook/Instagram", campaign: "flyer/poster" }), `${APP}?utm_source=facebook-instagram&utm_campaign=flyer-poster`);
  assert.deepEqual(touch("?utm_source=Facebook/Instagram&utm_campaign=flyer/poster"), { source: "facebook-instagram", medium: "", campaign: "flyer-poster" });
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

test("a tag written wholly in letters that look like Latin ones, or with Latin's own lookalikes, is no source", () => {
  // Real sources first: X (from t.co), Yahoo, Instagram and Google.
  assert.equal(touch("", "https://t.co/abc").source, "x.com");
  for (const [lookalike, real] of [
    ["х.com", "x.com"], // a Cyrillic х
    ["уаһоо.com", "yahoo.com"], // Cyrillic у а һ о о
    ["ɡoogle.com", "google.com"], // Latin script g (U+0261)
    ["ᴠᴏᴡ-ꜱᴀʟᴇ", "vow-sale"], // small capitals
    ["gօօgle.com", "google.com"], // an Armenian օ
  ]) {
    assert.equal(cleanTag(lookalike), "", lookalike);
    assert.deepEqual(touch(`?utm_source=${encodeURIComponent(lookalike)}`, "https://www.bing.com/"), { source: "bing.com", medium: "", campaign: "" }, lookalike);
    assert.notEqual(cleanTag(real), "", real);
  }
  // A dotless ı (or i) with a dot above it is the i it shows.
  assert.equal(touch(`?utm_source=${encodeURIComponent("ı̇nstagram.com")}`).source, "instagram.com");
  assert.equal(touch(`?utm_source=${encodeURIComponent("i̇nstagram.com")}`).source, "instagram.com");
  assert.equal(cleanTag("İNDİRİM"), "indirim", "Turkish İ lowercased is i, as Turkish writes it");
  assert.equal(cleanTag("kırmızı-indirim"), "kırmızı-indirim", "Turkish ı on its own is a letter");
  // A campaign or medium wholly in Cyrillic letters that read as Latin ones (ѕаӏе, сра) is left out too.
  assert.deepEqual(touch(`?utm_source=newsletter&utm_medium=${encodeURIComponent("сра")}&utm_campaign=${encodeURIComponent("ѕаӏе")}`), { source: "newsletter", medium: "", campaign: "" });
  // Words in Cyrillic, Greek or Armenian are kept, beside Latin ones too.
  for (const [value, kept] of [
    ["распродажа", "распродажа"],
    ["VK реклама", "vk-реклама"],
    ["москва.рф", "москва.рф"],
    ["Προσφορά", "προσφορά"],
    ["café", "café"],
    ["Ամառ", "ամառ"],
  ]) {
    assert.equal(cleanTag(value), kept, value);
  }
});

test("Thai, Lao, Khmer and Burmese, written without spaces, may run into a Latin word", () => {
  for (const [value, kept] of [
    ["เพจFacebook", "เพจfacebook"],
    ["โปรFlashSale", "โปรflashsale"],
    ["LINEโฆษณา", "lineโฆษณา"],
    ["ໂປຣFacebook", "ໂປຣfacebook"],
    ["ប្រូម៉ូFacebook", "ប្រូម៉ូfacebook"],
    ["Facebookကြော်ငြာ", "facebookကြော်ငြာ"],
  ]) {
    assert.equal(cleanTag(value), kept, value);
  }
  assert.deepEqual(touch(`?utm_source=facebook&utm_campaign=${encodeURIComponent("โปรFlashSale")}`), { source: "facebook.com", medium: "", campaign: "โปรflashsale" });
  // Cyrillic and Greek still don't, as their letters can pass for Latin ones; the link maker says why.
  assert.equal(cleanTag("VKреклама"), "");
  assert.equal(passesForLatin("VKреклама"), true);
  assert.equal(passesForLatin("х.com"), true);
  assert.equal(passesForLatin("ana@example.com"), false, "left out for another reason");
  assert.equal(passesForLatin("instagram"), false);
});

test("the commas and dots Japanese and Chinese write between words are a dash too", () => {
  assert.equal(cleanTag("Facebook・Instagram"), "facebook-instagram");
  assert.equal(cleanTag("ﾌｪｲｽﾌﾞｯｸ･ｲﾝｽﾀ"), "フェイスブック-インスタ", "a half-width middle dot");
  assert.equal(cleanTag("春、夏セール"), "春-夏セール");
  assert.equal(cleanTag("微信、微博"), "微信-微博");
  assert.equal(cleanTag("微信，微博"), "微信-微博");
  assert.equal(cleanTag("flyer · poster"), "flyer-poster");
  assert.equal(cleanTag("flyer•poster"), "flyer-poster");
  assert.equal(taggedLink(APP, { source: "Facebook・Instagram", campaign: "春、夏セール" }), `${APP}?utm_source=facebook-instagram&utm_campaign=${encodeURIComponent("春-夏セール")}`);
});

test("Persian keeps the zero-width non-joiner where it changes how letters join, and nowhere else", () => {
  const ZWNJ = "‌";
  assert.equal(cleanTag(`کتاب${ZWNJ}فروشی`), `کتاب${ZWNJ}فروشی`, "ب would join ف without it");
  assert.equal(cleanTag(`تخفیف${ZWNJ}های پاییزی`), `تخفیف${ZWNJ}های-پاییزی`);
  assert.equal(cleanTag(`می${ZWNJ}خواهم`), `می${ZWNJ}خواهم`);
  assert.equal(touch(`?utm_source=${encodeURIComponent(`کتاب${ZWNJ}فروشی`)}`).source, `کتاب${ZWNJ}فروشی`);
  // Where it draws nothing (after a letter that never joins the next, beside Latin, at an end), it goes.
  assert.equal(cleanTag(`دیوار${ZWNJ}نوشته`), "دیوارنوشته");
  assert.equal(cleanTag(`insta${ZWNJ}gram`), "instagram");
  assert.equal(cleanTag(`کتاب${ZWNJ}`), "کتاب");
  assert.equal(cleanTag(`${ZWNJ}${ZWNJ}`), "");
  // Cut at 40 characters, a name doesn't end in one.
  assert.equal(cleanTag(`${"ب".repeat(39)}${ZWNJ}ب`), "ب".repeat(39));
});
