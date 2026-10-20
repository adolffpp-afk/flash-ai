import { publicShowcase } from "@/lib/server/showcase.ts";

export const dynamic = "force-dynamic";

/** The apps and pictures approved for the landing page's "Made with Flash" showcase, for anyone. */
export async function GET() {
  const list = await publicShowcase().catch(() => ({ sites: [], pictures: [] }));
  // Kept for a few minutes, so a busy landing page doesn't read the database for each visitor.
  return Response.json(list, { headers: { "Cache-Control": "public, max-age=60, s-maxage=300" } });
}
