import { ImageResponse } from "next/og";
import { Bolt, GRADIENT } from "./brand";

// The home-screen icon on iPhones and iPads, which need a PNG.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: GRADIENT }}>
        <Bolt size={180} />
      </div>
    ),
    size,
  );
}
