import { ImageResponse } from "next/og";
import { one } from "@/lib/server/db.ts";
import { sitePreview } from "@/lib/site-preview.ts";
import { BRAND, BrandMark } from "../../../brand";

const size = { width: 1200, height: 630 };

/** The picture in a published site's share card when the site has no picture of its own. */
export async function GET(_request: Request, ctx: RouteContext<"/p/[slug]/card">) {
  const { slug } = await ctx.params;
  const site = await one<{ html: string }>("SELECT html FROM sites WHERE slug = ?", [slug]);
  if (!site) return new Response("Not found", { status: 404 });
  const { title, description } = sitePreview(site.html);
  const image = new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: `radial-gradient(circle at 20% 15%, #222944, ${BRAND.ink} 65%)`,
          color: "white",
        }}
      >
        <div style={{ display: "flex", width: 120, height: 8, borderRadius: 4, background: "linear-gradient(90deg, #5eeaf4, #5b8cf6, #9b6cf4, #f472b6)" }} />
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: title.length > 40 ? 64 : 84, fontWeight: 700, letterSpacing: -2, lineHeight: 1.05 }}>{title}</div>
          {description && (
            <div style={{ display: "flex", marginTop: 28, fontSize: 34, lineHeight: 1.35, color: "#b4bad0" }}>
              {description.length > 140 ? `${description.slice(0, 139)}…` : description}
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", fontSize: 24, color: "#8a90a8" }}>
          <BrandMark size={36} />
          <span style={{ marginLeft: 10 }}>Made with Flash</span>
        </div>
      </div>
    ),
    size,
  );
  // Share apps fetch the picture once and keep it; an hour lets an updated site refresh it.
  image.headers.set("Cache-Control", "public, max-age=3600");
  return image;
}
