import { cookies } from "next/headers";
import { Flash } from "@/components/Flash";
import { ACCOUNTS_COOKIE, ACCOUNTS_COOKIE_HTTP, SESSION_COOKIE } from "@/lib/server/auth.ts";
import { pricingInfo } from "@/lib/server/pricing.ts";
import { engineStatus } from "@/lib/server/status.ts";
import { studioOpen } from "@/lib/server/studio.ts";
import { falConfigured } from "@/lib/engines/fal.ts";

/*
 * Visitors without a session cookie get the landing page in the first HTML instead of a spinner.
 * With a cookie, Flash loads the account in the browser (and shows the landing page if the
 * session turns out to have expired).
 */
export default async function Home() {
  const jar = await cookies();
  // Signed in to one account or several (see the jar in auth.ts).
  const signedIn = jar.has(SESSION_COOKIE) || jar.has(ACCOUNTS_COOKIE) || jar.has(ACCOUNTS_COOKIE_HTTP);
  return <Flash signedIn={signedIn} initialStatus={engineStatus()} pricing={signedIn ? undefined : pricingInfo()} studio={studioOpen() && falConfigured()} />;
}
