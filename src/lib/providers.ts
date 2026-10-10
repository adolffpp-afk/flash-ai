/**
 * Every AI provider Flash can call, for the owner dashboard's By provider list. id matches the
 * provider recorded in the usage table. keys are the environment variables that switch it on: all
 * of them must be set, and "A|B" means either one. free means Flash only uses the provider's free
 * tier, so it costs nothing.
 */
export type ProviderInfo = { id: string; name: string; does: string; free: boolean; keys: string[] };

export const PROVIDER_LIST: ProviderInfo[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    does: "Claude: chat, writing, code, apps, web search, and the helpers that plan pictures and videos",
    free: false,
    keys: ["ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN"],
  },
  { id: "fal", name: "fal.ai", does: "Pictures, photo edits, videos, music, voice-overs and transcripts", free: false, keys: ["FAL_KEY"] },
  { id: "openai", name: "OpenAI", does: "GPT Image and Sora 2 Pro", free: false, keys: ["OPENAI_API_KEY"] },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    does: "ElevenLabs Music, and voice-overs and transcripts instead of fal.ai when its key is set",
    free: false,
    keys: ["ELEVENLABS_API_KEY"],
  },
  { id: "groq", name: "Groq", does: "Free chat and free transcripts", free: true, keys: ["GROQ_API_KEY"] },
  { id: "gemini", name: "Gemini", does: "Free chat outside the EEA, UK and Switzerland", free: true, keys: ["GEMINI_API_KEY"] },
  { id: "openrouter", name: "OpenRouter", does: "Free chat", free: true, keys: ["OPENROUTER_API_KEY"] },
  {
    id: "cloudflare",
    name: "Cloudflare Workers AI",
    does: "Free chat and free pictures",
    free: true,
    keys: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
  },
  { id: "mistral", name: "Mistral", does: "Free chat, the last backup", free: true, keys: ["MISTRAL_API_KEY"] },
];

/** A provider's name for the dashboard, or its id when Flash doesn't know it. */
export const providerName = (id: string) => PROVIDER_LIST.find((p) => p.id === id)?.name ?? id;

/** The names of a provider's keys missing from env, like "CLOUDFLARE_API_TOKEN" (values are never read out). */
export const missingKeys = (p: ProviderInfo, env: Record<string, string | undefined>) =>
  p.keys.filter((k) => !k.split("|").some((name) => Boolean(env[name]))).map((k) => k.split("|").join(" or "));

/** Whether all of a provider's keys are set in env. */
export const providerSetUp = (p: ProviderInfo, env: Record<string, string | undefined>) => missingKeys(p, env).length === 0;
