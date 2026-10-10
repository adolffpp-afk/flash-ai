import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

process.env.DATABASE_URL = ":memory:";
process.env.FAL_KEY = "test-key";
delete process.env.OPENAI_API_KEY;
delete process.env.ELEVENLABS_API_KEY;
const { run, one } = await import("../src/lib/server/db.ts");
const c = await import("../src/lib/server/connector.ts");
const { tools, callTool } = await import("../src/lib/server/mcp-tools.ts");
const { balance, ensureMonthlyCredits } = await import("../src/lib/server/credits.ts");

const challengeFor = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const VERIFIER = "v".repeat(50);
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";

await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('u1', 'a@x.co', 'h', 0, 1), ('u2', 'b@x.co', 'h', 0, 1)");

test("apps may only be sent back to safe addresses", () => {
  assert.equal(c.validRedirectUri(CLAUDE), true);
  assert.equal(c.validRedirectUri("http://localhost:6274/oauth/callback"), true);
  assert.equal(c.validRedirectUri("cursor://anysphere.cursor-mcp/oauth/callback"), true);
  assert.equal(c.validRedirectUri("http://evil.example/cb"), false);
  assert.equal(c.validRedirectUri("javascript:alert(1)"), false);
  assert.equal(c.validRedirectUri("https://claude.ai/cb#frag"), false);
  assert.equal(c.validRedirectUri("not a url"), false);
});

test("register, approve and swap the code for tokens, with PKCE", async () => {
  const reg = await c.registerClient({ client_name: "Claude", redirect_uris: [CLAUDE] });
  assert.ok(!("error" in reg));
  const id = reg.client.id;
  assert.equal(reg.secret, undefined, "a public app gets no secret");
  assert.equal(await c.clientAuthenticates(id, null), true);

  const issuer = "https://www.flash-app.dev";
  const good = { client_id: id, redirect_uri: CLAUDE, response_type: "code", code_challenge: challengeFor(VERIFIER), code_challenge_method: "S256", state: "s1" };
  const checked = await c.checkAuthorize(good, issuer);
  assert.ok("ok" in checked);
  assert.ok("fatal" in (await c.checkAuthorize({ ...good, redirect_uri: "https://evil.example/cb" }, issuer)), "never redirects to an unregistered address");
  assert.ok("fatal" in (await c.checkAuthorize({ ...good, client_id: "nope" }, issuer)));
  const plain = await c.checkAuthorize({ ...good, code_challenge_method: "plain" }, issuer);
  assert.ok("redirect" in plain && plain.redirect.startsWith(CLAUDE) && plain.redirect.includes("error=invalid_request") && plain.redirect.includes("state=s1"));

  const code = await c.createCode({ clientId: id, userId: "u1", redirectUri: CLAUDE, challenge: challengeFor(VERIFIER) });
  assert.equal(await c.redeemCode(code, id, CLAUDE, "w".repeat(50)), null, "a wrong verifier fails");
  assert.equal(await c.redeemCode(code, id, CLAUDE, VERIFIER), null, "and the code is then used up");

  const code2 = await c.createCode({ clientId: id, userId: "u1", redirectUri: CLAUDE, challenge: challengeFor(VERIFIER) });
  assert.equal(await c.redeemCode(code2, "other", CLAUDE, VERIFIER), null, "another app can't use it");
  const code3 = await c.createCode({ clientId: id, userId: "u1", redirectUri: CLAUDE, challenge: challengeFor(VERIFIER) });
  assert.equal(await c.redeemCode(code3, id, CLAUDE, VERIFIER), "u1");

  const tokens = await c.issueTokens(id, "u1");
  assert.equal((await c.tokenUser(tokens.access_token))?.user.email, "a@x.co");
  assert.equal(await c.tokenUser(tokens.refresh_token), null, "a refresh token isn't an access token");
  assert.equal(await one("SELECT 1 FROM oauth_tokens WHERE token_hash = ?", [tokens.access_token]), null, "only hashes are stored");

  const next = await c.refreshTokens(tokens.refresh_token, id);
  assert.ok(next);
  assert.equal(await c.refreshTokens(tokens.refresh_token, id), null, "each refresh token works once");
  assert.deepEqual((await c.connectedApps("u1")).map((a) => a.name), ["Claude"]);

  await c.disconnectApp("u1", id);
  assert.equal(await c.tokenUser(next!.access_token), null, "disconnecting ends access at once");
  assert.deepEqual(await c.connectedApps("u1"), []);
});

test("an app that asks for a secret must send it", async () => {
  const reg = await c.registerClient({ client_name: "Bot", redirect_uris: [CLAUDE], token_endpoint_auth_method: "client_secret_post" });
  assert.ok(!("error" in reg) && reg.secret);
  assert.equal(await c.clientAuthenticates(reg.client.id, null), false);
  assert.equal(await c.clientAuthenticates(reg.client.id, "wrong"), false);
  assert.equal(await c.clientAuthenticates(reg.client.id, reg.secret!), true);
  assert.ok("error" in (await c.registerClient({ redirect_uris: ["http://evil.example/cb"] })));
});

test("the tools list only set-up models and never the Movie maker", () => {
  const list = tools();
  assert.deepEqual(list.map((t) => t.name), ["flash_create_image", "flash_create_video", "flash_create_music", "flash_speak", "flash_remove_background", "flash_upscale_image", "flash_edit_photo", "flash_animate_photo", "flash_publish_app", "flash_list_apps", "flash_check_credits"]);
  const video = list.find((t) => t.name === "flash_create_video")!;
  const models = (video.inputSchema.properties as { model: { enum: string[] } }).model.enum;
  assert.deepEqual(models, ["veo-3.1", "kling-3"]);
  assert.doesNotMatch(video.description, /sora/i);
  // The prices the tools give are the ones they charge.
  assert.match(video.description, /176 for 5 seconds, 526 for 15/);
  assert.match(list.find((t) => t.name === "flash_speak")!.description, /about 13 credits per 1,000 characters/);
  assert.match(list.find((t) => t.name === "flash_animate_photo")!.description, /a 5 second clip: 141 credits, or 211 with sound/);
});

/** Pretends to be fal.ai: every job finishes and returns a tiny file, or fails when asked. */
function fakeFal(fail = false) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (fail && init?.method === "POST") return new Response("boom", { status: 500 });
    if (init?.method === "POST") return Response.json({ status_url: "https://q.fal/status", response_url: "https://q.fal/result" });
    if (url.endsWith("/status")) return Response.json({ status: "COMPLETED" });
    if (url.endsWith("/result")) return Response.json({ images: [{ url: "https://cdn.fal/x.jpg", content_type: "image/jpeg" }] });
    return new Response(Buffer.from("JPEGDATA"), { headers: { "content-type": "image/jpeg" } });
  }) as typeof fetch;
  return calls;
}

const ctx = (userId: string) => ({
  user: { id: userId, email: `${userId}@x.co`, name: "", preferences: "", created_at: 0, last_free_grant: 0, verified_at: 1 },
  origin: "https://www.flash-app.dev",
  app: "Claude",
  progress: () => {},
});

test("making an image charges its price and returns the picture with a public link", async () => {
  // This month's free credits first, so the balance below only moves by the charge.
  await ensureMonthlyCredits("u2");
  const before = await balance("u2");
  const calls = fakeFal();
  const result = (await callTool("flash_create_image", { prompt: "a red fox" }, ctx("u2")))!;
  assert.equal(result.isError, undefined);
  assert.ok(calls.some((x) => x.includes("fal-ai/flux-2-pro")));
  const image = result.content.find((x) => x.type === "image") as { data: string; mimeType: string };
  assert.equal(Buffer.from(image.data, "base64").toString(), "JPEGDATA");
  const link = result.content.find((x) => x.type === "resource_link") as { uri: string };
  assert.match(link.uri, /^https:\/\/www\.flash-app\.dev\/f\/[\w-]+$/);
  const file = await c.publicFile(link.uri.split("/").pop()!);
  assert.equal(Buffer.from(file!.data).toString(), "JPEGDATA");
  assert.equal(before - (await balance("u2")), 8, "FLUX.2 Pro is 8 credits");
  assert.equal(await c.publicFile("nope"), null);
});

test("a failed job costs nothing, and too few credits makes nothing", async () => {
  const before = await balance("u2");
  fakeFal(true);
  const failed = (await callTool("flash_create_image", { prompt: "a red fox" }, ctx("u2")))!;
  assert.equal(failed.isError, true);
  assert.match((failed.content[0] as { text: string }).text, /No credits were used/);
  assert.equal(await balance("u2"), before);

  const calls = fakeFal();
  const poor = (await callTool("flash_create_video", { prompt: "a fox runs", seconds: 15 }, ctx("u2")))!;
  assert.equal(poor.isError, true);
  assert.match((poor.content[0] as { text: string }).text, /needs 526 Flash credits/);
  assert.equal(calls.length, 0, "nothing was sent to fal");
  assert.equal(await balance("u2"), before);
});

test("unknown tools and models are refused", async () => {
  assert.equal(await callTool("flash_delete_everything", {}, ctx("u2")), null);
  const r = (await callTool("flash_create_video", { prompt: "x", model: "movie" }, ctx("u2")))!;
  assert.equal(r.isError, true);
  const credits = (await callTool("flash_check_credits", {}, ctx("u2")))!;
  assert.match((credits.content[0] as { text: string }).text, /has \d+ Flash credits/);
});

test("photo tools take the user's own Flash links or a photo, and charge 5 credits", async () => {
  const png = Buffer.alloc(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  png.writeUInt32BE(1000, 16);
  png.writeUInt32BE(500, 20);
  const before = await balance("u2");
  const calls = fakeFal();
  const sent: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") sent.push(JSON.parse(String(init.body)));
    return realFetch(input, init);
  }) as typeof fetch;
  const up = (await callTool("flash_upscale_image", { image_base64: png.toString("base64") }, ctx("u2")))!;
  assert.equal(up.isError, undefined);
  assert.ok(calls.some((x) => x.includes("fal-ai/seedvr/upscale/image")));
  assert.equal((sent[0] as { upscale_factor: number }).upscale_factor, 4, "1000 px long side → 4×, at most 4,096 px");
  assert.equal(before - (await balance("u2")), 5);

  // Its result link can go straight into the background remover.
  const link = (up.content.find((x) => x.type === "resource_link") as { uri: string }).uri;
  const cut = (await callTool("flash_remove_background", { image_url: link }, ctx("u2")))!;
  assert.match((cut.content[0] as { text?: string }).text ?? "", /PNG, JPEG and WebP/, "the fake upscale returned no real photo");
  const someoneElse = (await callTool("flash_remove_background", { image_url: link }, ctx("u1")))!;
  assert.match((someoneElse.content[0] as { text: string }).text, /from this account/);
  const big = Buffer.from(png);
  big.writeUInt32BE(5000, 16);
  big.writeUInt32BE(3000, 20);
  const tooBig = (await callTool("flash_remove_background", { image_base64: big.toString("base64") }, ctx("u2")))!;
  assert.match((tooBig.content[0] as { text: string }).text, /too big/);
});

test("photo editing needs an instruction, sends it to FLUX.2 Edit and charges 18 credits", async () => {
  const png = Buffer.alloc(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  png.writeUInt32BE(800, 16);
  png.writeUInt32BE(600, 20);
  const noPrompt = (await callTool("flash_edit_photo", { image_base64: png.toString("base64") }, ctx("u2")))!;
  assert.equal(noPrompt.isError, true);
  assert.match((noPrompt.content[0] as { text: string }).text, /what to change/);

  const before = await balance("u2");
  const calls = fakeFal();
  const sent: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") sent.push(JSON.parse(String(init.body)));
    return realFetch(input, init);
  }) as typeof fetch;
  const edited = (await callTool("flash_edit_photo", { image_base64: png.toString("base64"), prompt: "Make it snow" }, ctx("u2")))!;
  assert.equal(edited.isError, undefined);
  assert.ok(calls.some((x) => x.includes("fal-ai/flux-2/turbo/edit")));
  const input = sent[0] as { prompt: string; image_urls: string[]; image_size: { width: number; height: number } };
  assert.equal(input.prompt, "Make it snow");
  assert.match(input.image_urls[0], /^data:image\/png;base64,/);
  assert.deepEqual(input.image_size, { width: 800, height: 600 });
  assert.equal(before - (await balance("u2")), 18);
  const link = edited.content.find((x) => x.type === "resource_link") as { name: string };
  assert.match(link.name, /^flash-edited\./);
});

test("apps can be published and updated through the connector for free", async () => {
  const before = await balance("u2");
  const first = (await callTool("flash_publish_app", { html: "<h1>Hi</h1>", title: "Tip Calculator" }, ctx("u2")))!;
  const text = (first.content[0] as { text: string }).text;
  const slug = text.match(/slug: ([\w-]+)/)![1];
  assert.match(text, /^Published "Tip Calculator" at https:\/\/www\.flash-app\.dev\/p\/tip-calculator-/);
  const again = (await callTool("flash_publish_app", { html: "<h1>Hi 2</h1>", title: "Tip Calculator", slug }, ctx("u2")))!;
  assert.match((again.content[0] as { text: string }).text, new RegExp(`slug: ${slug}`), "an update keeps the address");
  assert.equal((await one<{ html: string }>("SELECT html FROM sites WHERE slug = ?", [slug]))?.html, "<h1>Hi 2</h1>");
  assert.equal(await balance("u2"), before, "publishing is free");
  const list = (await callTool("flash_list_apps", {}, ctx("u2")))!;
  assert.match((list.content[0] as { text: string }).text, new RegExp(slug));

  // Someone else's slug makes a new app rather than changing theirs.
  const other = (await callTool("flash_publish_app", { html: "x", title: "Mine", slug }, ctx("u1")))!;
  assert.doesNotMatch((other.content[0] as { text: string }).text, new RegExp(`slug: ${slug}\\)`));
  const unverified = { ...ctx("u2"), user: { ...ctx("u2").user, verified_at: 0 } };
  process.env.FLASH_DEMO_EMAILS = "true"; // so email confirmation is required, as in production
  const blocked = (await callTool("flash_publish_app", { html: "x", title: "T" }, unverified))!;
  delete process.env.FLASH_DEMO_EMAILS;
  assert.equal(blocked.isError, true);
  assert.match((blocked.content[0] as { text: string }).text, /confirm their email/);
});

test("animating a photo charges by length, and sound only when asked", async () => {
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES ('u2', 1000, 'test top-up', 0)");
  const png = Buffer.alloc(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  png.writeUInt32BE(800, 16);
  png.writeUInt32BE(600, 20);
  fakeFal();
  const sent: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") sent.push(JSON.parse(String(init.body)));
    return realFetch(input, init);
  }) as typeof fetch;
  let before = await balance("u2");
  const quiet = (await callTool("flash_animate_photo", { image_base64: png.toString("base64"), prompt: "the waves roll in, soft music" }, ctx("u2")))!;
  assert.equal(quiet.isError, undefined);
  assert.equal(before - (await balance("u2")), 141, "5 seconds without sound, and the picture check its price includes");
  assert.equal(sent[0].generate_audio, false, "music in the motion text doesn't switch sound on");
  assert.equal(sent[0].duration, "5");

  before = await balance("u2");
  await callTool("flash_animate_photo", { image_base64: png.toString("base64"), seconds: 10, sound: true }, ctx("u2"));
  assert.equal(before - (await balance("u2")), 421, "10 seconds with sound");
  assert.equal(sent[1].generate_audio, true);
  assert.equal(sent[1].duration, "10");
});

test("each tool call in a batch counts against the hourly limit", async () => {
  const { tooManyCalls } = await import("../src/lib/server/connector-http.ts");
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "flash_check_credits" } };
  // Listing tools and pinging aren't tool calls, so they never count.
  assert.equal(await tooManyCalls("batcher", [{ method: "tools/list" }, { method: "ping" }]), false);
  // A batch over the hourly limit is refused whole.
  assert.equal(await tooManyCalls("batcher", Array(61).fill(call)), true);
  // One at a time, 60 an hour go through, then the 61st waits, and a batch adds up the same way.
  assert.equal(await tooManyCalls("single", [call]), false);
  assert.equal(await tooManyCalls("single", Array(58).fill(call)), false);
  assert.equal(await tooManyCalls("single", [call, { method: "tools/list" }]), false, "the 60th");
  assert.equal(await tooManyCalls("single", [call]), true, "the 61st");
});
