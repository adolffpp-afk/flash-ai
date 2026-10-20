/*
 * What is left on Flash's own accounts at the AI providers, for /admin > By provider: only where the
 * provider's official docs give an endpoint the key Flash already has can read, with the answer's
 * documented shape.
 * - OpenRouter: GET {OPENROUTER_BASE_URL}/key with OPENROUTER_API_KEY as a bearer token, "to check
 *   the rate limit or credits left on an API key" (https://openrouter.ai/docs/limits,
 *   https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key): data.limit_remaining
 *   (USD the key may still spend, null with no limit), data.usage (USD used) and
 *   data.free_model_daily_requests (used, limit, remaining today). The account's own credits
 *   (GET /credits) need a management key, which Flash doesn't have.
 * - ElevenLabs: GET {ELEVENLABS_BASE_URL}/user/subscription with ELEVENLABS_API_KEY in xi-api-key
 *   (https://elevenlabs.io/docs/api-reference/user/subscription/get,
 *   https://elevenlabs.io/docs/api-reference/authentication): tier, character_count and
 *   character_limit this period, next_character_count_reset_unix. A key restricted to other
 *   endpoints can't read it: that shows as the error.
 * The rest have no such endpoint, or only one that needs another key (fal's billing: a BILLING,
 * READONLY or FULL key, not the one for running models; Anthropic's usage and cost: an Admin key, and
 * no balance; Resend's usage: a full access key), so nothing is asked of them.
 *
 * Asked only when /admin loads, both at once, at most every five minutes (kept in this server's
 * memory), five seconds at most each. A failure is shown, never thrown.
 */
export type ProviderBalance = { text: string; error?: boolean };

const KEEP_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;
let kept: { at: number; balances: Record<string, ProviderBalance> } | null = null;

const usd = (n: number) => `$${n.toFixed(2)}`;
const count = (n: number) => n.toLocaleString("en-US");
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Reads one provider: the documented answer as text, or why it couldn't. */
async function ask(url: string, headers: Record<string, string>, read: (body: unknown) => string | null): Promise<ProviderBalance> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { text: `Couldn't read the balance (HTTP ${res.status})`, error: true };
    const text = read(await res.json());
    return text ? { text } : { text: "Couldn't read the balance (unexpected answer)", error: true };
  } catch (err) {
    return { text: `Couldn't read the balance (${err instanceof Error && err.name === "TimeoutError" ? "no answer in 5 seconds" : "no connection"})`, error: true };
  }
}

function openRouter(body: unknown): string | null {
  const d = (body as { data?: Record<string, unknown> } | null)?.data;
  const free = d?.free_model_daily_requests as { remaining?: unknown; limit?: unknown } | undefined;
  if (!d || !isNumber(d.usage) || !(d.limit_remaining === null || isNumber(d.limit_remaining))) return null;
  const left = d.limit_remaining === null ? "No spending limit on this key" : `${usd(d.limit_remaining)} left on this key`;
  const freeLeft = free && isNumber(free.remaining) && isNumber(free.limit) ? ` · ${count(free.remaining)} of ${count(free.limit)} free requests left today` : "";
  return `${left} · ${usd(d.usage)} used${freeLeft}`;
}

function elevenLabs(body: unknown): string | null {
  const s = body as { tier?: unknown; character_count?: unknown; character_limit?: unknown; next_character_count_reset_unix?: unknown } | null;
  if (!s || !isNumber(s.character_count) || !isNumber(s.character_limit)) return null;
  const reset = isNumber(s.next_character_count_reset_unix) ? ` · resets ${new Date(s.next_character_count_reset_unix * 1000).toISOString().slice(0, 10)}` : "";
  const tier = typeof s.tier === "string" && s.tier ? ` (${s.tier})` : "";
  return `${count(Math.max(0, s.character_limit - s.character_count))} of ${count(s.character_limit)} characters left this period${tier}${reset}`;
}

/** The balances by provider id, for the providers whose key is set. */
export async function providerBalances(): Promise<Record<string, ProviderBalance>> {
  if (kept && Date.now() - kept.at < KEEP_MS) return kept.balances;
  const jobs: [string, Promise<ProviderBalance>][] = [];
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  if (openRouterKey) {
    const base = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    jobs.push(["openrouter", ask(`${base}/key`, { Authorization: `Bearer ${openRouterKey}` }, openRouter)]);
  }
  const elevenKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (elevenKey) {
    const base = (process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io/v1").replace(/\/+$/, "");
    jobs.push(["elevenlabs", ask(`${base}/user/subscription`, { "xi-api-key": elevenKey }, elevenLabs)]);
  }
  const balances = Object.fromEntries(await Promise.all(jobs.map(async ([id, job]) => [id, await job] as const)));
  kept = { at: Date.now(), balances };
  return balances;
}
