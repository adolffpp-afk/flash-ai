import { claudeConfigured } from "@/lib/engines/claude.ts";
import { elevenConfigured, openaiConfigured } from "@/lib/engines/media.ts";
import type { Engine } from "@/lib/types.ts";

export const dynamic = "force-dynamic";

export function GET() {
  const claude = claudeConfigured();
  const openai = openaiConfigured();
  const eleven = elevenConfigured();
  const status: Record<Engine, boolean> = {
    text: claude,
    search: claude,
    code: claude,
    translate: claude,
    docs: claude,
    image: openai,
    video: openai,
    voice: eleven,
    music: eleven,
    transcribe: eleven,
    app: claude,
    slides: claude,
  };
  return Response.json(status);
}
