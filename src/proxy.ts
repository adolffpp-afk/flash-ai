import { NextResponse, type NextRequest } from "next/server";
import { OUTBOUND_HEADER, routeHost } from "@/lib/site-host.ts";

/** Sends visits to a custom domain to the published site connected to it, and refuses Flash calling itself. */
export async function proxy(request: NextRequest) {
  const appHost = process.env.FLASH_APP_URL ? new URL(process.env.FLASH_APP_URL).hostname : "";
  const host = request.headers.get("host") ?? "";
  const route = routeHost(host, request.nextUrl.pathname, request.method, appHost, request.headers.has(OUTBOUND_HEADER));
  if ("pass" in route) return protect(request.nextUrl.pathname, NextResponse.next());
  if ("siteApi" in route) {
    // Loaded only here, so other requests don't open the database.
    const { siteForDomain } = await import("@/lib/server/domains.ts");
    const domain = host.replace(/:\d+$/, "").toLowerCase();
    return (await siteForDomain(domain)) === route.siteApi ? NextResponse.next() : new NextResponse("Not found", { status: 404 });
  }
  if ("rewrite" in route) {
    // The query goes along, so Open as owner's one-time code reaches the site's page.
    const url = new URL(route.rewrite, request.url);
    url.search = request.nextUrl.search;
    return NextResponse.rewrite(url);
  }
  // Built from the Host header, so the visitor stays on their own domain.
  if ("redirect" in route) return NextResponse.redirect(new URL(route.redirect, `${request.nextUrl.protocol}//${host}`));
  return new NextResponse("Not found", { status: 404 });
}

// Published apps (/p/, and /d/ for custom domains), files (/f/) and the APIs may be shown inside
// other pages; Flash's own pages may not.
const EMBEDDABLE = /^\/(p|d|f|api)\//;

/**
 * The headers Flash's own pages get, or null for a path that may be shown inside other pages. They
 * can't be shown inside another site, so nobody can trick a click on them, and they don't tell other
 * sites their address (sign-in and reset links carry a code in it). The app's page ("/") tells them
 * its origin only (never a path or a query): it opens Google Drive's Picker (Settings > Connectors),
 * a frame from docs.google.com that Google shows only when the request names the site it is in,
 * since the Picker's API key is limited to Flash's site (see DrivePicker.tsx).
 */
export function ownPageHeaders(path: string): Record<string, string> | null {
  if (EMBEDDABLE.test(path)) return null;
  return {
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
    "Referrer-Policy": path === "/" ? "strict-origin-when-cross-origin" : "same-origin",
  };
}

function protect(path: string, response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(ownPageHeaders(path) ?? {})) response.headers.set(name, value);
  return response;
}

export const config = {
  matcher: ["/((?!_next/).*)"],
};
