import { ImageResponse } from "next/og";
import { Bolt, GRADIENT } from "./brand";

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
          background: "linear-gradient(180deg, #1e1b4b, #09090b)",
          color: "white",
        }}
      >
        <div style={{ display: "flex", width: 160, height: 160, borderRadius: 36, background: GRADIENT }}>
          <Bolt size={160} />
        </div>
        <div style={{ marginTop: 40, fontSize: 96, fontWeight: 700, letterSpacing: -2 }}>Flash AI</div>
        <div style={{ marginTop: 12, fontSize: 40, color: "#a1a1aa" }}>One AI for everything</div>
      </div>
    ),
    size,
  );
}
