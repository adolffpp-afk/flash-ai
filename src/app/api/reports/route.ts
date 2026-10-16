import { after } from "next/server";
import { appUrl, fromOwnPage } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { clientIp } from "@/lib/server/limits.ts";
import { submitReport, tellAdmins } from "@/lib/server/reports.ts";

export const dynamic = "force-dynamic";

/**
 * Someone reports a shared chat, a file or a published app, from the Report form on a shared chat
 * or the /report page: { address, reason, details?, email? }. Anyone may, signed in or not.
 */
export async function POST(request: Request) {
  // Often signed out, so the words follow the browser's language (see server/i18n.ts).
  const t = await translatorFor(request);
  // Only Flash's own pages may send reports, so another site, or a published app, can't send them
  // from its visitors' browsers.
  if (!fromOwnPage(request)) return Response.json({ error: t("Please send reports from Flash's own page.") }, { status: 403 });
  const result = await submitReport(await request.json().catch(() => ({})), clientIp(request), t);
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  // The same network reporting the same item again adds to its report, with no new email.
  if (!result.repeat) {
    const origin = appUrl(request);
    after(() => tellAdmins(result.id, origin).catch((err) => console.error("[flash] report email failed", err)));
  }
  return Response.json({ ok: true });
}
