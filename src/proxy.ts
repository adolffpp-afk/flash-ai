import { NextResponse, type NextRequest } from "next/server";
import { OUTBOUND_HEADER, routeHost } from "@/lib/site-host";

/** Sends visits to a custom domain to the published site connected to it, and refuses Flash calling itself. */
export function proxy(request: NextRequest) {
  const appHost = process.env.FLASH_APP_URL ? new URL(process.env.FLASH_APP_URL).hostname : "";
  const host = request.headers.get("host") ?? "";
  const route = routeHost(host, request.nextUrl.pathname, request.method, appHost, request.headers.has(OUTBOUND_HEADER));
  if ("pass" in route) return protect(request.nextUrl.pathname, NextResponse.next());
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
 * Flash's own pages can't be shown inside another site, so nobody can trick a click on them, and
 * they don't tell other sites their address (sign-in and reset links carry a code in it).
 */
function protect(path: string, response: NextResponse): NextResponse {
  if (EMBEDDABLE.test(path)) return response;
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  response.headers.set("Referrer-Policy", "same-origin");
  return response;
}

export const config = {
  matcher: ["/((?!_next/).*)"],
};
