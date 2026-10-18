import { after } from "next/server";
import { countSteps, matchVisit } from "@/lib/server/funnel.ts";
import { MAX_TRACKED, stepName } from "@/lib/traffic.ts";

export const dynamic = "force-dynamic";

// Published sites run on an opaque origin, so this answers any origin and never uses cookies.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
// The most of a request read: 15 names of up to 40 characters, one per line, fit well inside it.
const MAX_BODY = 1024;
// A request that says it is longer than this isn't read at all.
const MAX_SAID = 2048;

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * At most the first 1 KB of the body, read piece by piece, so a body sent without a length is cut
 * too. A name the cut went through is left out.
 */
async function firstBytes(request: Request): Promise<string> {
  const said = Number(request.headers.get("content-length") ?? "");
  if (said > MAX_SAID || !request.body) return "";
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_BODY) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      size += value.length;
    }
  } catch {
    return "";
  } finally {
    reader.cancel().catch(() => {});
  }
  const text = new TextDecoder().decode(Buffer.concat(parts).subarray(0, MAX_BODY));
  return size >= MAX_BODY ? text.slice(0, Math.max(0, text.lastIndexOf("\n"))) : text;
}

/**
 * Steps the app reports with flashDB.track: up to 15 names, one per line, as plain text (so the
 * browser sends no preflight). Each counts once a day for a person matched to their visit (see
 * funnel.ts). It always answers 204 at once, so it tells nobody anything and the page never waits.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/sites/[slug]/track">) {
  const { slug } = await ctx.params;
  const names = [...new Set((await firstBytes(request)).split("\n").map(stepName).filter(Boolean))].slice(0, MAX_TRACKED);
  if (names.length) after(async () => countSteps(slug, await matchVisit(slug, request), names.map((n) => `app:${n}` as const)));
  return new Response(null, { status: 204, headers: CORS });
}
