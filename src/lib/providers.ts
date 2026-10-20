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
  { id: "openai", name: "OpenAI", does: "GPT Image", free: false, keys: ["OPENAI_API_KEY"] },
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
  // Data the models look up (see research.ts). Uses counts the requests Flash sent them.
  {
    id: "searxng",
    name: "SearXNG",
    does: "Free web search for the free models, on your own server (the password gate's https address)",
    free: true,
    keys: ["SEARXNG_URL", "SEARXNG_USERNAME", "SEARXNG_PASSWORD"],
  },
  { id: "sec", name: "SEC EDGAR", does: "US public companies' filings and reported figures (no key needed)", free: true, keys: [] },
  { id: "fred", name: "FRED", does: "US economic data from the Federal Reserve Bank of St. Louis", free: true, keys: ["FRED_API_KEY"] },
  // Not something answers look up: scores for published apps (see pagespeed.ts). Its key is optional.
  {
    id: "pagespeed",
    name: "PageSpeed Insights",
    does: "Google's speed, accessibility and SEO scores for published apps (My websites & apps › SEO). Free; without PAGESPEED_API_KEY Google usually refuses (its shared keyless quota can be 0), so set one",
    free: true,
    keys: [],
  },
];

/** The data sources on the list: their uses are the requests counted in free_quota, not the usage log. */
export const DATA_SOURCES = ["searxng", "sec", "fred", "pagespeed"];

/** A provider's name for the dashboard, or its id when Flash doesn't know it. */
export const providerName = (id: string) => PROVIDER_LIST.find((p) => p.id === id)?.name ?? id;

/** The names of a provider's keys missing from env, like "CLOUDFLARE_API_TOKEN" (values are never read out). */
export const missingKeys = (p: ProviderInfo, env: Record<string, string | undefined>) =>
  p.keys.filter((k) => !k.split("|").some((name) => Boolean(env[name]))).map((k) => k.split("|").join(" or "));

/** Whether all of a provider's keys are set in env. */
export const providerSetUp = (p: ProviderInfo, env: Record<string, string | undefined>) => missingKeys(p, env).length === 0;

/**
 * Connectors (the user's own accounts in chat) aren't an AI provider, but need a key of their own:
 * CONNECTOR_KEYS, which seals what users connect with (see server/secret-box.ts). Listed on its own
 * under By provider, with what's missing.
 */
export const CONNECTOR_SETUP: ProviderInfo = {
  id: "connectors",
  name: "Connectors",
  does: "Seals the keys and tokens users connect their own accounts with (Settings > Connectors)",
  free: true,
  keys: ["CONNECTOR_KEYS"],
};

/**
 * GitHub in chat needs Flash's own GitHub App (see server/github.ts and docs/connectors-setup.md):
 * its client ID and slug (Config) and client secret (Secret). Until all three are set, and
 * CONNECTOR_KEYS, users don't see GitHub anywhere. The GitHub sign-in (GITHUB_CLIENT_ID) is another
 * app, and isn't needed here.
 */
export const GITHUB_SETUP: ProviderInfo = {
  id: "github-connector",
  name: "GitHub (connector)",
  does: "Lets users connect GitHub in chat: read code, issues and pull requests, and create issues and pull requests after they approve each one",
  free: true,
  keys: ["GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_SLUG"],
};

/**
 * Google Drive in chat needs Flash's own Google Cloud project (see server/google.ts and
 * docs/connectors-setup.md): its OAuth client ID (Config) and secret (Sensitive), the Picker's API
 * key (Config) and the project number (Config). Until all four are set, and CONNECTOR_KEYS, users
 * don't see Google Drive anywhere. The Google sign-in (GOOGLE_CLIENT_ID) is another client, and isn't
 * needed here.
 */
export const GOOGLE_SETUP: ProviderInfo = {
  id: "google-connector",
  name: "Google Drive (connector)",
  does: "Lets users connect Google Drive in chat: read the Docs, Sheets, Slides, PDFs and text files they pick, and create Docs, Sheets and Slides or add rows to a Sheet after they approve each one",
  free: true,
  keys: ["GOOGLE_CONNECT_CLIENT_ID", "GOOGLE_CONNECT_CLIENT_SECRET", "GOOGLE_PICKER_API_KEY", "GOOGLE_CONNECT_PROJECT_NUMBER"],
};
