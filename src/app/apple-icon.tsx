import { ImageResponse } from "next/og";
import { BrandMark, GRADIENT } from "./brand";

// The home-screen icon on iPhones and iPads, which need a PNG. iOS rounds the corners itself, so the
// emerald fills the square and the mark is drawn without its own tile.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: GRADIENT }}>
        <BrandMark size={170} tile={false} />
      </div>
    ),
    size,
  );
}
