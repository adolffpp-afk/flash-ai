import { claudeConfigured } from "@/lib/engines/claude.ts";
import { imageConfigured, voiceConfigured } from "@/lib/engines/media.ts";

export const dynamic = "force-dynamic";

export function GET() {
  const claude = claudeConfigured();
  return Response.json({ text: claude, search: claude, image: imageConfigured(), voice: voiceConfigured() });
}
