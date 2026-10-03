import { ImageResponse } from "next/og";
import { BRAND, BrandMark, HOLO } from "./brand";

// The preview shown when a Flash link is shared. Twitter uses it too.
export const alt = "Flash AI: one AI for everything";
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
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: `radial-gradient(circle at 50% 35%, #0f3d2c, ${BRAND.ink} 70%)`,
          color: "white",
        }}
      >
        <BrandMark size={200} />
        <div style={{ display: "flex", marginTop: 36, fontSize: 96, fontWeight: 700, letterSpacing: -2 }}>
          <span>Flash</span>
          <span style={{ marginLeft: 24, backgroundImage: HOLO, backgroundClip: "text", color: "transparent" }}>AI</span>
          <svg width="28" height="28" viewBox="0 0 16 16" style={{ marginLeft: 6, marginTop: 14 }}>
            <path d="M8 0l1.9 6.1L16 8l-6.1 1.9L8 16l-1.9-6.1L0 8l6.1-1.9z" fill={BRAND.spark} />
          </svg>
        </div>
        <div style={{ marginTop: 12, fontSize: 40, color: "#b6c5bc" }}>One AI for everything</div>
        <div style={{ display: "flex", marginTop: 36, width: 220, height: 6, borderRadius: 3, background: `linear-gradient(90deg, ${BRAND.emerald}, ${BRAND.holoMint}, ${BRAND.holoLavender}, ${BRAND.holoRose}, ${BRAND.gold}, ${BRAND.spark})` }} />
      </div>
    ),
    size,
  );
}
