import { NextResponse, type NextRequest } from "next/server";
import { routeHost } from "@/lib/site-host";

/** Sends visits to a custom domain to the published site connected to it. */
export function proxy(request: NextRequest) {
  const appHost = process.env.FLASH_APP_URL ? new URL(process.env.FLASH_APP_URL).hostname : "";
  const host = request.headers.get("host") ?? "";
  const route = routeHost(host, request.nextUrl.pathname, request.method, appHost);
  if ("pass" in route) return NextResponse.next();
  if ("rewrite" in route) return NextResponse.rewrite(new URL(route.rewrite, request.url));
  // Built from the Host header, so the visitor stays on their own domain.
  if ("redirect" in route) return NextResponse.redirect(new URL(route.redirect, `${request.nextUrl.protocol}//${host}`));
  return new NextResponse("Not found", { status: 404 });
}

export const config = {
  matcher: ["/((?!_next/).*)"],
};
