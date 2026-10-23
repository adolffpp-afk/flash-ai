import { clientIp, overLimit } from "@/lib/server/limits.ts";
import { metaRequest } from "@/lib/server/social.ts";
import { metaSignedRequest } from "@/lib/server/social-signin.ts";

/*
 * Meta's deauthorize (uninstall) callback: a person removed Flash in their Facebook, Instagram or
 * Threads settings. Taken only when signed with one of Flash's Meta secrets; their accounts are
 * marked "needs to be connected again" (nothing is posted there until they do).
 */
export async function POST(request: Request) {
  if (await overLimit(`social-meta:${clientIp(request)}`, 60, 60 * 60_000)) return new Response("Too many requests", { status: 429 });
  const form = await request.formData().catch(() => null);
  const found = metaSignedRequest(String(form?.get("signed_request") ?? ""));
  if (!found) return new Response("Bad request", { status: 400 });
  await metaRequest("deauthorize", found.networks, found.userId);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
