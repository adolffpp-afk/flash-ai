import { appUrl, getUser, unauthorized } from "@/lib/server/auth.ts";
import { getBrand, logoProblem, saveBrand, type LogoUpload } from "@/lib/server/brand.ts";
import { translatorFor } from "@/lib/server/i18n.ts";

/** The user's brand kit. */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  return Response.json({ brand: await getBrand(user.id, appUrl(request)) });
}

/** Saves the brand kit. `logo`: a new picture, null to remove it, or left out to keep it. */
export async function PUT(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const body = (await request.json().catch(() => null)) as (Record<string, unknown> & { logo?: LogoUpload | null }) | null;
  if (!body) return Response.json({ error: t("Invalid JSON") }, { status: 400 });
  const logo = body.logo;
  if (logo) {
    const problem = logoProblem(logo, t);
    if (problem) return Response.json({ error: problem }, { status: 400 });
  }
  await saveBrand(user.id, body, logo === undefined ? undefined : logo ? { mediaType: logo.mediaType, data: logo.data } : null);
  return Response.json({ brand: await getBrand(user.id, appUrl(request)) });
}
