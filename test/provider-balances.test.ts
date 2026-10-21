import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
for (const name of ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "ELEVENLABS_API_KEY", "ELEVENLABS_BASE_URL", "RESEND_API_KEY", "STRIPE_SECRET_KEY"]) delete process.env[name];

let clock = Date.UTC(2026, 9, 9, 12);
Date.now = () => clock;
const later = () => (clock += 5 * 60_000 + 1);

// What the providers were asked, and what they answer (the examples in their docs).
type Asked = { url: string; headers: Record<string, string> };
const asked: Asked[] = [];
let answer: (url: string) => Response | Promise<Response> = () => Response.json({});
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  asked.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
  return answer(String(input));
}) as typeof fetch;

const OPENROUTER_KEY = {
  data: {
    label: "flash",
    limit: 20,
    limit_remaining: 12.5,
    limit_reset: null,
    usage: 7.5,
    usage_daily: 0.25,
    usage_weekly: 1,
    usage_monthly: 3,
    is_free_tier: false,
    free_model_daily_requests: { used: 40, limit: 1000, remaining: 960 },
  },
};
const ELEVEN_SUBSCRIPTION = { tier: "creator", character_count: 34_000, character_limit: 100_000, next_character_count_reset_unix: 1_791_331_200, status: "active" };

const { providerBalances } = await import("../src/lib/server/provider-balances.ts");
const { adminStats } = await import("../src/lib/server/admin-stats.ts");

test("nothing is asked for a provider whose key isn't set", async () => {
  assert.deepEqual(await providerBalances(), {});
  assert.equal(asked.length, 0);
});

test("OpenRouter's key and ElevenLabs' subscription are read as their docs give them, at most every five minutes", async () => {
  process.env.OPENROUTER_API_KEY = "sk-or-test";
  process.env.ELEVENLABS_API_KEY = "el-test";
  later();
  answer = (url) => Response.json(url.endsWith("/key") ? OPENROUTER_KEY : ELEVEN_SUBSCRIPTION);
  const balances = await providerBalances();
  assert.deepEqual(balances, {
    openrouter: { text: "$12.50 left on this key · $7.50 used · 960 of 1,000 free requests left today" },
    elevenlabs: { text: "66,000 of 100,000 characters left this period (creator) · resets 2026-10-07" },
  });
  const openRouter = asked.find((a) => a.url === "https://openrouter.ai/api/v1/key")!;
  assert.equal(openRouter.headers.authorization, "Bearer sk-or-test");
  const eleven = asked.find((a) => a.url === "https://api.elevenlabs.io/v1/user/subscription")!;
  assert.equal(eleven.headers["xi-api-key"], "el-test");
  assert.equal(asked.length, 2);

  await providerBalances();
  assert.equal(asked.length, 2, "kept for five minutes");
  later();
  answer = (url) => Response.json(url.endsWith("/key") ? { data: { ...OPENROUTER_KEY.data, limit: null, limit_remaining: null } } : ELEVEN_SUBSCRIPTION);
  assert.equal((await providerBalances()).openrouter.text, "No spending limit on this key · $7.50 used · 960 of 1,000 free requests left today");
  assert.equal(asked.length, 4);
});

test("a refused key, an answer of another shape or no answer shows why, and never throws", async () => {
  later();
  answer = (url) => (url.endsWith("/key") ? new Response("no", { status: 401 }) : Response.json({ characters: 5 }));
  assert.deepEqual(await providerBalances(), {
    openrouter: { text: "Couldn't read the balance (HTTP 401)", error: true },
    elevenlabs: { text: "Couldn't read the balance (unexpected answer)", error: true },
  });
  later();
  answer = (url) => {
    if (url.endsWith("/key")) throw new DOMException("The operation timed out.", "TimeoutError");
    throw new TypeError("fetch failed");
  };
  assert.deepEqual(await providerBalances(), {
    openrouter: { text: "Couldn't read the balance (no answer in 5 seconds)", error: true },
    elevenlabs: { text: "Couldn't read the balance (no connection)", error: true },
  });
});

test("/admin shows them under By provider, and today's alert emails on the Overview", async () => {
  later();
  answer = (url) => Response.json(url.endsWith("/key") ? OPENROUTER_KEY : ELEVEN_SUBSCRIPTION);
  const stats = JSON.parse(JSON.stringify(await adminStats(30)));
  const row = (id: string) => stats.byProvider.find((p: { id: string }) => p.id === id);
  assert.equal(row("openrouter").balance.text, "$12.50 left on this key · $7.50 used · 960 of 1,000 free requests left today");
  assert.equal(row("elevenlabs").balance.text, "66,000 of 100,000 characters left this period (creator) · resets 2026-10-07");
  assert.equal(row("fal").balance, undefined, "no balance endpoint for the key Flash has");
  assert.equal(JSON.stringify(stats).includes("sk-or-test"), false, "key values never leave the server");
  assert.deepEqual(stats.alertEmails, { lowSent: 0, lowBudget: 0, lowWeekly: 0, lowFailed: 0, outSent: 0, outBudget: 0, outFailed: 0, appAiSent: 0, appAiBudget: 0, appAiFailed: 0, share: 10, appAiShare: 5 });
});
