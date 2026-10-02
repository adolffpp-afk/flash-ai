import { demoEmails, emailEnabled } from "@/lib/server/email.ts";
import { enabledProviders } from "@/lib/server/oauth.ts";

export const dynamic = "force-dynamic";

/** Public: which sign-in buttons to show. A provider appears once its client id and secret are set. */
export function GET() {
  return Response.json({ providers: enabledProviders(), emailLink: emailEnabled() || demoEmails() });
}
