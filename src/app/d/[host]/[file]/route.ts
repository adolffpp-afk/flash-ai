import { one } from "@/lib/server/db.ts";
import { siteDomains, siteForDomain } from "@/lib/server/domains.ts";
import { mainDomain } from "@/lib/seo-rules.ts";
import { parseFacts, refreshSeo } from "@/lib/server/seo.ts";

export const dynamic = "force-dynamic";

const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
const CACHE = { "Cache-Control": "public, max-age=3600" };

/*
 * robots.txt and sitemap.xml for a site on its own domain (src/proxy.ts sends those visits here). The
 * domain is the site's alone, so Google may read all of it, the app's data included, and the sitemap
 * lists its one page. A page that asks not to be listed, or a site with an open report, has an empty
 * sitemap. On www. when the bare domain shows the app too, both name the bare one's sitemap, and only
 * that one lists the page (see mainDomain). Flash's own robots.txt and sitemap.xml (src/app/robots.ts,
 * sitemap.ts) don't change.
 */
export async function GET(_request: Request, ctx: RouteContext<"/d/[host]/[file]">) {
  const { host, file } = await ctx.params;
  if (file !== "robots.txt" && file !== "sitemap.xml") return notFound();
  let domain: string;
  try {
    domain = decodeURIComponent(host).toLowerCase();
  } catch {
    return notFound();
  }
  // Only a connected domain, which Flash checked when it was added, so it's safe to write out as is.
  const slug = await siteForDomain(domain);
  if (!slug) return notFound();
  const main = mainDomain(domain, (await siteDomains(slug)).live);
  if (file === "robots.txt") {
    return new Response(`User-agent: *\nAllow: /\nSitemap: https://${main}/sitemap.xml\n`, {
      headers: { ...CACHE, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const site = await one<{ seo: string; updated_at: number; reported: number }>(
    `SELECT s.seo, s.updated_at,
            EXISTS (SELECT 1 FROM reports r WHERE r.item_kind = 'site' AND r.item_id = s.slug AND r.status = 'open') AS reported
     FROM sites s WHERE s.slug = ?`,
    [slug],
  );
  if (!site) return notFound();
  const facts = parseFacts(site.seo) ?? (await refreshSeo(slug))?.facts;
  const listed = main === domain && !facts?.noindex && !Number(site.reported);
  const day = new Date(Number(site.updated_at)).toISOString().slice(0, 10);
  const urls = listed ? `<url><loc>https://${domain}/</loc><lastmod>${day}</lastmod></url>` : "";
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`, {
    headers: { ...CACHE, "Content-Type": "application/xml; charset=utf-8" },
  });
}
