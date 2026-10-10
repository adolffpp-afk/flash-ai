import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "../src/lib/router.ts";
import {
  PACK_IMAGE_CENTS,
  PACK_VIDEO_CENTS,
  PACK_WRITING_CENTS,
  modelById,
  modelCredits,
  packWantsVideo,
  pickModel,
  type Provider,
} from "../src/lib/models.ts";
import { MAX_POST_CHARS, cleanHashtag, packMarkdown, parsePack, postText } from "../src/lib/post-pack.ts";
import { DEAREST, packMaxTokens, packSystem } from "../src/lib/engines/post-pack.ts";
import { packImageInput, packVideoInput } from "../src/lib/engines/fal-input.ts";
import { tokensAtMost } from "../src/lib/engines/companion.ts";
import { CLAUDE_PRICES, FALLBACKS, MARKUP, claudePrice } from "../src/lib/credits.ts";
import { CHAT_MODEL } from "../src/lib/engines/claude.ts";
import { TEMPLATES, defaultValues, templateById, templateCredits, type TemplateValues } from "../src/lib/templates.ts";

const fal = new Set<Provider>(["fal"]);
const values = (text: Record<string, string>): TemplateValues => ({ text, items: [] });

test("asking for a post pack routes to it, ahead of video, app and photo words", () => {
  for (const ask of [
    "Make a social media pack for my bakery's new sourdough",
    "social post pack for Golden Crumb's grand opening",
    "Create a social pack for our summer sale",
    "Posts for Instagram, TikTok and Facebook about our new menu",
    "Write posts for Instagram and Facebook about the weekend market",
    "Instagram, TikTok and Facebook posts for the new café",
    "Make a social media kit with a video for my bakery website",
    "A social media pack with a photo of our croissants",
  ]) {
    assert.equal(route(ask).engine, "image", ask);
    assert.equal(pickModel("image", ask, fal)?.model.id, "post-pack", ask);
  }
  // A single post or a caption isn't a pack.
  assert.notEqual(pickModel("image", "A photo for an Instagram post of a croissant", fal)?.model.id, "post-pack");
  assert.equal(route("Write an Instagram caption for my latte photo").engine, "text");
  assert.notEqual(route("Write a description of the new DLC content pack").engine, "image");
  assert.notEqual(route("Put together a marketing kit for investors").engine, "image");
  assert.equal(route("Make a video of waves at sunset").engine, "video");
  // Packs never reach apps or the connector, and never the image default.
  assert.equal(pickModel("image", "Draw a cat", fal)?.model.id, "flux-2-pro");
  assert.ok(modelById("post-pack")!.chatOnly);
});

test("a pack has a video only when it is asked for", () => {
  assert.equal(packWantsVideo("social media pack for my bakery"), false);
  assert.equal(packWantsVideo("social media pack with a video"), true);
  assert.equal(packWantsVideo("posts for Instagram Reels and TikTok"), true);
  assert.equal(packWantsVideo("social pack, no video please"), false);
  assert.equal(packWantsVideo("a pack for our video game shop. Pictures only, no video."), false);
  assert.equal(packWantsVideo("social pack without any video"), false);
});

test("a pack's price covers writing, two pictures and the video at a margin", () => {
  const pack = modelById("post-pack")!;
  assert.equal(modelCredits(pack, "social media pack"), Math.ceil((PACK_WRITING_CENTS + 2 * PACK_IMAGE_CENTS) * MARKUP));
  assert.equal(modelCredits(pack, "social media pack with a video"), Math.ceil((PACK_WRITING_CENTS + 2 * PACK_IMAGE_CENTS + PACK_VIDEO_CENTS) * MARKUP));
  // 2.5 times what Flash pays at today's prices: 28 credits, or 168 with the video.
  assert.equal(modelCredits(pack, "social media pack"), 28);
  assert.equal(modelCredits(pack, "social media pack with a video"), 168);
  // A FLUX.2 Pro picture under 1 megapixel, and 5 seconds of silent Kling 3 Pro.
  for (const shape of ["square", "tall"] as const) {
    const { width, height } = packImageInput("bread", shape).image_size;
    assert.ok(width * height <= 1024 * 1024, shape);
  }
  assert.deepEqual(packVideoInput("data:image/png;base64,AA", "slow push in"), {
    start_image_url: "data:image/png;base64,AA",
    prompt: "slow push in",
    duration: "5",
    generate_audio: false,
  });
});

test("the writer can never spend more than the writing part of the price", () => {
  const dearest = DEAREST;
  // At least the price of the model the writer runs on, and of every model it could fall back to.
  for (const model of ["claude-sonnet-5-5", "claude-opus-5-5"]) assert.ok(CLAUDE_PRICES[model].output <= dearest.output && CLAUDE_PRICES[model].input <= dearest.input);
  for (const input of [200, 1500, 4000, 8000]) {
    const out = packMaxTokens(input);
    const cents = (input * dearest.input + out * dearest.output) / 1e6;
    assert.ok(cents <= PACK_WRITING_CENTS + 1e-9, `${input} tokens in costs ${cents}`);
    // The writer declines, and its refusal fallback reads it all again and writes the posts: both are billed.
    const first = claudePrice(CHAT_MODEL);
    const backup = claudePrice(FALLBACKS[CHAT_MODEL]);
    const both = (input * first.input + out * first.output + (input + out) * backup.input + out * backup.output) / 1e6;
    assert.ok(both <= PACK_WRITING_CENTS + 1e-9, `${input} tokens in, declined and written again, costs ${both}`);
  }
  assert.equal(packMaxTokens(1500), 2000, "room for three posts with a normal request");
  assert.equal(packMaxTokens(20_000), 0);
  // The longest saved details (memory, project instructions and brand kit) are cut, so a pack still fits.
  const system = packSystem("x".repeat(20_000));
  assert.ok(packMaxTokens(tokensAtMost(system + "y".repeat(2000)) + 50) >= 1000);
  assert.match(packSystem("Business name: Golden Crumb"), /remember about them:\nBusiness name: Golden Crumb/);
  assert.match(packSystem(""), /never make any up/);
});

const reply = (posts: unknown, extra: Record<string, unknown> = {}) =>
  "Here you go:\n```json\n" + JSON.stringify({ posts, picture: "A warm loaf  of\nbread on a wooden board", motion: "Steam rises", ...extra }) + "\n```";

test("the writer's JSON becomes three tidy posts in a fixed order", () => {
  const pack = parsePack(
    reply([
      { platform: "facebook", caption: "Fresh bread every morning.\nCome say hi!", hashtags: ["#Bakery", "#bread", "#Toronto", "#extra"] },
      { platform: "Tik Tok", caption: "POV: the first slice 🍞", hashtags: "#bread #sourdough #fyp" },
      { platform: "Instagram", caption: "Meet our honey oat loaf.", hashtags: ["Golden Crumb!", "#bakery", "#Bakery", "123", "", 7, "#sour dough"] },
      { platform: "LinkedIn", caption: "Not asked for", hashtags: [] },
    ]),
  )!;
  assert.deepEqual(
    pack.posts.map((p) => p.platform),
    ["Instagram", "TikTok", "Facebook"],
  );
  assert.deepEqual(pack.posts[0].hashtags, ["#GoldenCrumb", "#bakery", "#sourdough"], "cleaned, no repeats, no numbers");
  assert.deepEqual(pack.posts[1].hashtags, ["#bread", "#sourdough", "#fyp"], "a string of hashtags works too");
  assert.deepEqual(pack.posts[2].hashtags, ["#Bakery", "#bread", "#Toronto"], "Facebook keeps three");
  assert.equal(pack.picture, "A warm loaf of bread on a wooden board");
  assert.equal(pack.motion, "Steam rises");
  assert.equal(postText(pack.posts[2]), "Fresh bread every morning.\nCome say hi!\n\n#Bakery #bread #Toronto");

  const md = packMarkdown(pack.posts);
  assert.match(md, /^### Instagram\n\nMeet our honey oat loaf\.\n\n#GoldenCrumb #bakery #sourdough\n\n### TikTok/);
  assert.match(md, /Fresh bread every morning\. {2}\nCome say hi!/, "a caption's line breaks show");
});

test("posts stay within Instagram's limit, and broken replies are refused", () => {
  const long = parsePack(reply([{ platform: "Instagram", caption: "é".repeat(3000), hashtags: ["#a", "#b"] }]))!;
  assert.equal(long.posts.length, 1);
  assert.ok([...postText(long.posts[0])].length <= MAX_POST_CHARS);
  assert.ok(long.posts[0].caption.endsWith("…"));
  assert.equal(parsePack("Sorry, I can't help with that."), null);
  assert.equal(parsePack('{"posts": []}'), null);
  assert.equal(parsePack(reply([{ platform: "Instagram", caption: "   ", hashtags: [] }])), null, "an empty caption isn't a post");
  assert.equal(parsePack(reply([{ platform: "TikTok", caption: "Hi" }], { picture: 5 }))!.picture, "", "the route falls back to the request");
  assert.equal(cleanHashtag("##Café_au_lait"), "#Café_au_lait");
  assert.equal(cleanHashtag("#2026"), "");
});

test("the post pack template asks for a pack, with a video only when picked, and shows both prices", () => {
  const t = templateById("social-pack")!;
  assert.equal(t.engine, "image");
  assert.equal(t.model, "post-pack");
  const base = defaultValues(t);
  const ask = t.request(values({ ...base.text, business: "Golden Crumb", about: "Honey oat loaf, $8, this weekend only", action: "Order at goldencrumb.ca" }));
  assert.match(ask, /^Make a social post pack for Golden Crumb about: Honey oat loaf, \$8, this weekend only/);
  assert.match(ask, /What people should do: Order at goldencrumb\.ca/);
  assert.equal(packWantsVideo(ask), false);
  assert.equal(route(ask).engine, "image", "it routes to the pack even when sent on Auto");
  const withVideo = t.request(values({ ...base.text, business: "GC", about: "Our video game night", video: t.fields.find((f) => f.key === "video")!.options![1] }));
  assert.equal(packWantsVideo(withVideo), true);
  const prices = templateCredits(undefined, 2.5);
  assert.equal(prices["social-pack"], 28);
  assert.equal(prices["social-pack:with"], 168);
  assert.equal(templateCredits(undefined, 3)["social-pack"], Math.ceil(11 * 3), "priced at the markup in use");
  // Only templates with a pricier choice get a second price.
  assert.deepEqual(Object.keys(prices).filter((k) => k.endsWith(":with")), ["social-pack:with"]);
  assert.ok(TEMPLATES.every((t) => !t.model || modelById(t.model)), "template models exist");
});

test("the writer keeps within budget, dropping saved details for the brand kit when they're too long to afford", async () => {
  const { createServer } = await import("node:http");
  const { writePack } = await import("../src/lib/engines/post-pack.ts");
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ url: req.url ?? "", body });
      if (req.url?.includes("count_tokens")) {
        // Long saved details are expensive to read; the brand kit alone is cheap.
        const long = String(body.system).includes("LONG-MEMORY");
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: long ? 9000 : 600 }));
      }
      const posts = [{ platform: "Instagram", caption: "Fresh bread!", hashtags: ["#bread"] }];
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn", stop_sequence: null,
          content: [{ type: "text", text: JSON.stringify({ posts, picture: "Bread", motion: "Steam" }) }],
          usage: { input_tokens: 600, output_tokens: 300 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  process.env.ANTHROPIC_API_KEY = "sk-test";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const spent: number[] = [];
  try {
    const pack = await writePack("social media pack for my bakery", "LONG-MEMORY ".repeat(500), (_p, _m, cents) => spent.push(cents), "Business: Golden Crumb");
    assert.equal(pack.posts[0].caption, "Fresh bread!");
    const create = seen.find((s) => s.url.startsWith("/v1/messages?") || s.url === "/v1/messages")!;
    assert.ok(create, "the writer was called");
    assert.match(String(create.body.system), /Business: Golden Crumb/);
    assert.doesNotMatch(String(create.body.system), /LONG-MEMORY/, "the saved details that didn't fit were left out");
    assert.equal(create.body.max_tokens, packMaxTokens(Math.ceil(600 * 1.1) + 50));
    assert.equal(spent.length, 1, "the writing was metered");
  } finally {
    server.close();
  }
});
