import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { overLimit } from "@/lib/server/limits.ts";
import { domainSalesFor, searchDomains } from "@/lib/server/domain-orders.ts";

export const dynamic = "force-dynamic";

/** Names Flash can sell for what was typed, with Flash's price for the first year and each later one. Searching is free. */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const mode = domainSalesFor(user);
  if (!mode) return Response.json({ error: t("Buying a domain in Flash is coming soon.") }, { status: 403 });
  if (await overLimit(`domain-search:${user.id}`, 30, 60_000)) return Response.json({ error: t("Too many searches. Please wait a minute.") }, { status: 429 });
  const q = (new URL(request.url).searchParams.get("q") ?? "").slice(0, 100);
  const found = await searchDomains(mode, q);
  if (!found) return Response.json({ error: t("Couldn't search for names right now. Please try again.") }, { status: 502 });
  return Response.json({ ...found, sandbox: mode === "sandbox" });
}
