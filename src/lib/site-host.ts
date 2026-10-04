// Flash's own addresses; any other host is a custom domain showing a published site.
const OWN_HOST = /(^|\.)flash-app\.dev$|\.vercel\.app$|^localhost$|^127\.0\.0\.1$|^\[::1\]$/;
// What a site on its own domain may call: its flashDB data and its form inbox.
const SITE_API = /^\/api\/sites\/[\w-]+\/(data|inbox)$/;

export type HostRoute = { pass: true } | { rewrite: string } | { redirect: "/" } | { notFound: true };

/** What to do with a request, by the host it came to (see src/proxy.ts). */
export function routeHost(hostHeader: string, path: string, method: string, appHost = ""): HostRoute {
  const host = hostHeader.replace(/:\d+$/, "").toLowerCase();
  if (!host || host === appHost || OWN_HOST.test(host)) return { pass: true };
  if (SITE_API.test(path)) return { pass: true };
  if (path === "/") return { rewrite: `/d/${encodeURIComponent(host)}` };
  // A site is one page, so other paths go home; Flash's own pages aren't reachable from here.
  if (method === "GET" && path !== "/favicon.ico") return { redirect: "/" };
  return { notFound: true };
}
