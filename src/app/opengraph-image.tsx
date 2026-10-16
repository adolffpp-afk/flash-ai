import { ImageResponse } from "next/og";
import { PRODUCT_NAME, TAGLINE } from "@/lib/product";
import { BRAND, BrandMark, InfinitySymbol } from "./brand";

// The preview shown when a Flash link is shared. Twitter uses it too. Laid out like the logo lockup:
// the app icon, then the name with the drawn infinity, and the tagline under it.
export const alt = `${PRODUCT_NAME}: ${TAGLINE}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: `radial-gradient(circle at 30% 45%, #222944, ${BRAND.ink} 70%)`,
          color: "#f4f5fa",
        }}
      >
        <BrandMark size={232} id="og-icon" tile />
        <div style={{ display: "flex", flexDirection: "column", marginLeft: 52 }}>
          {/* Only the regular weight of the font ships with the image renderer, so an outline in the text's
              own colour thickens the name to the logo's bold. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              fontSize: 136,
              letterSpacing: 0,
              lineHeight: 1,
              WebkitTextStroke: "6px #f4f5fa",
            }}
          >
            <span>Flash</span>
            <InfinitySymbol id="og-name" width={134} height={71} style={{ margin: "12px 32px 0" }} />
            <span>AI</span>
          </div>
          <div style={{ display: "flex", marginTop: 30, fontSize: 38, color: "#a5b0cc" }}>{TAGLINE}</div>
        </div>
      </div>
    ),
    size,
  );
}
