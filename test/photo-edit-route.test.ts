import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { register } from "node:module";

/*
 * A photo sent with a change asked for, through the chat route: ChatGPT's editor makes it at once, at
 * its listed price with no question first; FLUX.2 Edit makes it, at its own lower price, when OpenAI
 * is busy or down; the Upscaler makes it bigger; and a change OpenAI's safety system turns down is
 * neither charged nor sent elsewhere. OpenAI and fal.ai are stand-ins on a local server.
 */
register("./support/route-hooks.mjs", import.meta.url);

type EditScript = { status?: number; body?: unknown; usage?: Record<string, unknown> | null };
const openai = { scripts: [] as EditScript[], sent: [] as string[] };
const fal = { sent: [] as { endpoint: string; body: Record<string, unknown> }[] };
const PNG_OUT = Buffer.from("edited-png");
const KEY = "sk-openai-test";
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const json = (value: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    const raw = Buffer.concat(chunks).toString("latin1");
    if (req.url === "/v1/images/edits") {
      if (req.headers.authorization !== `Bearer ${KEY}`) return json({ error: { message: "Incorrect API key" } }, 401);
      openai.sent.push(raw);
      const s = openai.scripts.shift() ?? {};
      if (s.status) return json(s.body ?? { error: { message: "scripted", type: "server_error" } }, s.status);
      const usage = s.usage === null ? undefined : (s.usage ?? { input_tokens: 2100, output_tokens: 1600, input_tokens_details: { text_tokens: 20, image_tokens: 2080 } });
      return json({ created: 1, data: [{ b64_json: PNG_OUT.toString("base64") }], ...(usage && { usage }) });
    }
    // fal.ai's queue: every job finishes on its first status check.
    if (req.url!.startsWith("/fal/")) {
      if (req.method === "POST") {
        const n = fal.sent.push({ endpoint: req.url!.slice(5), body: JSON.parse(raw) });
        return json({ status_url: `${base}/fal-status/${n}`, response_url: `${base}/fal-result/${n}` });
      }
    }
    if (req.url!.startsWith("/fal-status/")) return json({ status: "COMPLETED" });
    if (req.url!.startsWith("/fal-result/")) return json({ images: [{ url: `${base}/fal-file.png`, content_type: "image/png" }] });
    if (req.url === "/fal-file.png") return res.writeHead(200, { "content-type": "image/png" }).end(PNG_OUT);
    res.writeHead(404).end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => server.close());
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

process.env.DATABASE_URL = ":memory:";
process.env.OPENAI_API_KEY = KEY;
process.env.OPENAI_BASE_URL = `${origin}/v1`;
process.env.FAL_KEY = "fal-test";
process.env.FAL_BASE_URL = `${origin}/fal`;
// No Claude: the rules alone decide, so no paid helper reads the request first.
for (const name of ["ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "VERCEL_ENV", "RESEND_API_KEY", "FLASH_APP_URL", "FLASH_IMAGE_MODEL"]) {
  delete process.env[name];
}
const logged: string[] = [];
for (const level of ["log", "error", "warn", "info"] as const) console[level] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));

const { afterwards } = await import("./support/next-server.mjs");
const { all, one, run: sql } = await import("../src/lib/server/db.ts");
const chatRoute = await import("../src/app/api/chat/route.ts");
const { modelById, modelCredits } = await import("../src/lib/models.ts");
const { CONFIRM_CREDITS } = await import("../src/lib/price-question.ts");
const { EDIT_REFUSED } = await import("../src/lib/engines/media.ts");

beforeEach(async () => {
  openai.scripts = [];
  openai.sent = [];
  fal.sent = [];
  logged.length = 0;
  process.env.OPENAI_API_KEY = KEY;
  await sql("DELETE FROM rate_limits");
});

const ORIGIN = "http://localhost";
async function account(id: string, credits: number) {
  const token = `tok_${id}_${randomBytes(6).toString("hex")}`;
  await sql("INSERT INTO users (id, email, name, password_hash, preferences, created_at, last_free_grant, verified_at) VALUES (?, ?, '', 'x', '', 0, 0, 1)", [id, `${id}@example.com`]);
  await sql("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [createHash("sha256").update(token).digest("hex"), id, Date.now() + 3600_000]);
  const d = new Date();
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, 'test', ?, 0)", [id, credits, `free:${id}:${month}`]);
  await sql("INSERT INTO projects (id, user_id, name, messages, updated_at) VALUES (?, ?, 'Photos', '[]', 0)", [`proj_${id}`, id]);
  return { id, cookie: `flash_session=${token}`, projectId: `proj_${id}` };
}
const balance = async (id: string) => Number((await one<{ b: number }>("SELECT COALESCE(SUM(amount), 0) AS b FROM credit_ledger WHERE user_id = ?", [id]))!.b);

// A PNG's header, which is all Flash reads of a photo's size.
const png = (w: number, h: number) => {
  const b = Buffer.alloc(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.toString("base64");
};

type ChatEvent = { type: string; delta?: string; message?: string; engine?: string; model?: string; credits?: number; url?: string; code?: string };
let n = 0;
/** A photo sent with a request, as the page sends it, read to its end. */
async function send(who: Awaited<ReturnType<typeof account>>, content: string, photo = png(1200, 800)) {
  const message = { role: "user", content, attachment: { name: "photo.png", mediaType: "image/png", data: photo } };
  const res = await chatRoute.POST(
    new Request(`${ORIGIN}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: who.cookie },
      body: JSON.stringify({
        projectId: who.projectId,
        replyId: `r${n}${Date.now().toString(36)}`,
        userMessage: { id: `u${n++}${Date.now().toString(36)}`, ...message },
        afterId: null,
        engine: "auto",
        messages: [message],
      }),
    }),
  );
  const events: ChatEvent[] = [];
  if (!res.ok || !res.body) {
    await afterwards();
    return { status: res.status, events, error: await res.text() };
  }
  let buffer = "";
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter((l) => l.trim())) events.push(JSON.parse(line) as ChatEvent);
  }
  await afterwards();
  return { status: res.status, events, error: "" };
}
const charged = (events: ChatEvent[]) => events.find((e) => e.type === "cost")?.credits;
const statuses = (events: ChatEvent[]) => events.filter((e) => e.type === "status").map((e) => e.message);
// A form value's lines are sent with \r\n between them.
const field = (form: string, name: string) => form.match(new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`))?.[1]?.replace(/\r\n/g, "\n");
const usage = (id: string) => one<{ model: string; credits: number; cost_cents: number }>("SELECT model, credits, cost_cents FROM usage WHERE user_id = ? ORDER BY rowid DESC LIMIT 1", [id]);

const gptEdit = modelById("gpt-image-edit")!;
const fluxEdit = modelById("flux-2-edit")!;
const upscaler = modelById("upscale")!;

test("ChatGPT's photo editor is priced under the price question, so a change runs at once, and never at a loss", () => {
  assert.equal(modelCredits(gptEdit), 31);
  assert.ok(modelCredits(gptEdit) < CONFIRM_CREDITS, "no price to agree to first");
  // Medium quality at its largest: about 2,000 tokens made at $30 a million, a 2048 × 2048 photo read as
  // about 6,500 tokens at $8, and 1,000 tokens of request at $5.
  const worst = 2000 * 3e-3 + 6500 * 8e-4 + 1000 * 5e-4;
  assert.ok(modelCredits(gptEdit) / 2.5 >= worst, `${modelCredits(gptEdit)} credits for ${worst.toFixed(2)}¢`);
});

test('"make the picture more clairer" is edited by ChatGPT\'s editor straight away, at its listed price, with no question first', async () => {
  const ana = await account("ana", 500);
  const { status, events } = await send(ana, "make the picture more clairer");
  assert.equal(status, 200);
  assert.ok(!events.some((e) => e.type === "error"), JSON.stringify(events));
  assert.equal(events.filter((e) => e.type === "image").length, 1, "one picture back");
  assert.ok(!events.some((e) => e.type === "text"), "no words, no suggestions, no questions");
  assert.equal(charged(events), 31);
  assert.equal(await balance("ana"), 500 - 31);
  assert.ok(statuses(events).some((s) => s?.includes("GPT Image Edit")), JSON.stringify(statuses(events)));
  // One edit sent to OpenAI: the photo and the words as asked, at medium quality, wide like the photo.
  assert.equal(openai.sent.length, 1);
  assert.equal(fal.sent.length, 0, "FLUX.2 Edit isn't asked");
  const form = openai.sent[0];
  assert.equal(field(form, "model"), "gpt-image-2.5-sunburst");
  assert.equal(field(form, "prompt"), "make the picture more clairer\n\n(Change only what is asked. Keep everything else in the photo as it is.)");
  assert.equal(field(form, "quality"), "medium");
  assert.equal(field(form, "size"), "1536x1024");
  assert.equal(field(form, "n"), "1");
  assert.match(form, /name="image"; filename="photo\.png"\r\nContent-Type: image\/png/);
  // What OpenAI says it cost is what's logged: 20 words at $5 a million, 2,080 photo tokens at $8, 1,600 made at $30.
  const used = await usage("ana");
  assert.equal(used?.model, "gpt-image-edit");
  assert.ok(Math.abs(Number(used?.cost_cents) - (20 * 5e-4 + 2080 * 8e-4 + 1600 * 3e-3)) < 1e-6, String(used?.cost_cents));
});

test("a tall or square photo comes back tall or square", async () => {
  const bo = await account("bo", 500);
  await send(bo, "it's blurry", png(800, 1200));
  await send(bo, "sharpen it", png(1000, 1000));
  assert.deepEqual(
    openai.sent.map((f) => field(f, "size")),
    ["1024x1536", "1024x1024"],
  );
});

test("an edit that costs more than its price is logged for the owner, and still charged only its price", async () => {
  const cy = await account("cy", 500);
  openai.scripts.push({ usage: { input_tokens: 9000, output_tokens: 4000, input_tokens_details: { text_tokens: 1000, image_tokens: 8000 } } });
  const { events } = await send(cy, "make it a cartoon");
  assert.equal(charged(events), 31);
  assert.ok(logged.some((l) => l.includes("over its price")), logged.join("\n"));
});

test("an edit with no usage reported is logged at its listed cost", async () => {
  const di = await account("di", 500);
  openai.scripts.push({ usage: null });
  const { events } = await send(di, "make it a cartoon");
  assert.equal(charged(events), 31);
  assert.equal(Number((await usage("di"))?.cost_cents), gptEdit.costCents);
});

for (const [why, script] of [
  ["busy (429)", { status: 429, body: { error: { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" } } }],
  ["down (503)", { status: 503 }],
] as const) {
  test(`with OpenAI ${why}, FLUX.2 Edit makes the change, charged at its own lower price`, async () => {
    const ed = await account(`ed${script.status}`, 500);
    openai.scripts.push(script);
    const { events } = await send(ed, "make it a cartoon");
    assert.ok(!events.some((e) => e.type === "error"), JSON.stringify(events));
    assert.equal(events.filter((e) => e.type === "image").length, 1);
    assert.equal(openai.sent.length, 1);
    assert.deepEqual(fal.sent.map((s) => s.endpoint), [fluxEdit.endpoint]);
    assert.equal(fal.sent[0].body.prompt, "make it a cartoon");
    assert.equal(charged(events), modelCredits(fluxEdit));
    assert.equal(await balance(`ed${script.status}`), 500 - modelCredits(fluxEdit));
    assert.ok(statuses(events).some((s) => s?.includes("FLUX.2 Edit")), JSON.stringify(statuses(events)));
    // Only FLUX.2 Edit's work was paid for, and the owner sees which editor made it.
    const rows = await all<{ model: string; cost_cents: number }>("SELECT model, cost_cents FROM usage WHERE user_id = ?", [`ed${script.status}`]);
    assert.equal(rows.reduce((sum, r) => sum + Number(r.cost_cents), 0), fluxEdit.costCents);
    assert.ok(rows.some((r) => r.model === "flux-2-edit" && Number(r.cost_cents) === fluxEdit.costCents), JSON.stringify(rows));
  });
}

test("a change OpenAI's safety system turns down isn't charged, says why, and isn't sent to another editor", async () => {
  const fi = await account("fi", 500);
  openai.scripts.push({ status: 400, body: { error: { message: "Your request was rejected by the safety system.", type: "image_generation_user_error", code: "moderation_blocked" } } });
  const { events } = await send(fi, "make it a cartoon");
  assert.equal(fal.sent.length, 0, "not sent to FLUX.2 Edit");
  const error = events.find((e) => e.type === "error");
  assert.equal(error?.message, `${EDIT_REFUSED} Your credits were refunded.`);
  assert.equal(charged(events) ?? 0, 0);
  assert.equal(await balance("fi"), 500);
});

test("any other refusal from OpenAI isn't charged and isn't sent elsewhere", async () => {
  const gu = await account("gu", 500);
  openai.scripts.push({ status: 400, body: { error: { message: "Invalid image", type: "invalid_request_error" } } });
  const { events } = await send(gu, "make it a cartoon");
  assert.equal(fal.sent.length, 0);
  assert.ok(events.some((e) => e.type === "error"));
  assert.equal(await balance("gu"), 500);
});

test("bigger, HD or 4K is the Upscaler's, for a fifth of the price", async () => {
  const ha = await account("ha", 500);
  const { events } = await send(ha, "make it HD");
  assert.equal(openai.sent.length, 0);
  assert.deepEqual(fal.sent.map((s) => s.endpoint), [upscaler.endpoint]);
  assert.equal(charged(events), modelCredits(upscaler));
});

test("too few credits for ChatGPT's editor: the cheaper photo tools make the change instead of asking for credits", async () => {
  const io = await account("io", 30);
  const cartoon = await send(io, "make it a cartoon");
  assert.equal(openai.sent.length, 0);
  assert.deepEqual(fal.sent.map((s) => s.endpoint), [fluxEdit.endpoint]);
  assert.equal(charged(cartoon.events), modelCredits(fluxEdit));
  fal.sent = [];
  const clearer = await send(io, "make it clearer");
  assert.equal(openai.sent.length, 0);
  assert.deepEqual(fal.sent.map((s) => s.endpoint), [upscaler.endpoint]);
  assert.equal(charged(clearer.events), modelCredits(upscaler));
});

test("without OpenAI, clearer is the Upscaler's and other changes FLUX.2 Edit's, as before", async () => {
  delete process.env.OPENAI_API_KEY;
  const jo = await account("jo", 500);
  await send(jo, "make it clearer");
  await send(jo, "make it a cartoon");
  assert.equal(openai.sent.length, 0);
  assert.deepEqual(fal.sent.map((s) => s.endpoint), [upscaler.endpoint, fluxEdit.endpoint]);
});
