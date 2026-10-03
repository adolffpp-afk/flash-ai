import { cookies } from "next/headers";
import { Flash } from "@/components/Flash";
import { SESSION_COOKIE } from "@/lib/server/auth.ts";
import { pricingInfo } from "@/lib/server/pricing.ts";
import { engineStatus } from "@/lib/server/status.ts";

/*
 * Visitors without a session cookie get the landing page in the first HTML instead of a spinner.
 * With a cookie, Flash loads the account in the browser (and shows the landing page if the
 * session turns out to have expired).
 */
export default async function Home() {
  const signedIn = (await cookies()).has(SESSION_COOKIE);
  return <Flash signedIn={signedIn} initialStatus={engineStatus()} pricing={signedIn ? undefined : pricingInfo()} />;
}
