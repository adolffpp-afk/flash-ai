import { appUrl } from "@/lib/server/auth.ts";
import { randomId } from "@/lib/server/ids.ts";
import { clientIp, overLimit } from "@/lib/server/limits.ts";
import { metaRequest } from "@/lib/server/social.ts";
import { metaSignedRequest } from "@/lib/server/social-signin.ts";

/*
 * Meta's data-deletion callback (set in Flash's Meta app for Facebook, Instagram and Threads): a
 * person asked Meta to have Flash delete what it keeps from them. Taken only when signed with one of
 * Flash's Meta secrets; their accounts are removed with their posts and inbox, and Meta gets the
 * address and code it shows the person.
 */
export async function POST(request: Request) {
  if (await overLimit(`social-meta:${clientIp(request)}`, 60, 60 * 60_000)) return new Response("Too many requests", { status: 429 });
  const form = await request.formData().catch(() => null);
  const found = metaSignedRequest(String(form?.get("signed_request") ?? ""));
  if (!found) return new Response("Bad request", { status: 400 });
  await metaRequest("delete", found.networks, found.userId);
  const code = randomId(12);
  return Response.json({ url: `${appUrl(request)}/privacy?deletion=${code}#social-hub`, confirmation_code: code }, { headers: { "cache-control": "no-store" } });
}
