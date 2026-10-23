import { isVerified } from "./account.ts";
import { appUrl, getUser, unauthorized, type User } from "./auth.ts";
import { translatorFor } from "./i18n.ts";
import { approvalAllowed } from "./pending-actions.ts";
import { SocialInputError, socialOpenTo } from "./social.ts";
import type { Translate } from "../i18n.ts";

/*
 * What every Social hub route checks first (src/app/api/social): a signed-in user the hub is open
 * to (until FLASH_SOCIAL_OPEN, Flash's owners only; anyone else gets 404, as if it weren't there).
 * A change (connect, post, reply, remove) is taken only from Flash's own page, with its exact
 * Origin and a JSON body, like an approval, and only from an account whose email is confirmed.
 */

const HEADERS = { "cache-control": "no-store" };

export type Guarded = { user: User; t: Translate };

export async function guard(request: Request, change: boolean): Promise<Guarded | Response> {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (!socialOpenTo(user)) return Response.json({ error: t("Not found") }, { status: 404, headers: HEADERS });
  if (change) {
    if (!approvalAllowed(request, [new URL(appUrl(request)).origin, new URL(request.url).origin])) {
      return Response.json({ error: t("Please use Flash's own page.") }, { status: 403, headers: HEADERS });
    }
    if (!isVerified(user)) return Response.json({ error: t("Confirm your email to connect accounts.") }, { status: 403, headers: HEADERS });
  }
  return { user, t };
}

export const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });

/** A problem as an answer: the user's own to fix in Flash's words, or a plain "try again". */
export function problem(err: unknown, t: Translate, what: string): Response {
  if (err instanceof SocialInputError) return reply({ error: t(err.message, err.values) }, err.status);
  console.error(`[flash] social ${what} failed`, err instanceof Error ? err.name : "error");
  return reply({ error: t("Something went wrong. Please try again.") }, 500);
}

export const readBody = async (request: Request): Promise<Record<string, unknown>> => {
  const body: unknown = await request.json().catch(() => ({}));
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
};

export const str = (value: unknown, max = 5000) => (typeof value === "string" ? value.slice(0, max) : "");
