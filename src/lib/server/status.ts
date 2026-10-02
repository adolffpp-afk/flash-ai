import { claudeConfigured } from "../engines/claude.ts";
import { elevenConfigured, openaiConfigured } from "../engines/media.ts";
import { falConfigured } from "../engines/fal.ts";
import type { Engine } from "../types.ts";

/** Which engines have their AI provider set up. The rest show as coming soon. */
export function engineStatus(): Record<Engine, boolean> {
  const claude = claudeConfigured();
  const openai = openaiConfigured();
  const eleven = elevenConfigured();
  const fal = falConfigured();
  return {
    text: claude,
    search: claude,
    code: claude,
    translate: claude,
    docs: claude,
    image: openai || fal,
    video: openai || fal,
    voice: eleven,
    music: eleven || fal,
    transcribe: eleven,
    app: claude,
    slides: claude,
  };
}
