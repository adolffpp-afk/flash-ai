import type { MetadataRoute } from "next";
import { BRAND } from "./brand";

// Lets phones and computers install Flash as an app, with its own icon and window.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Flash AI",
    short_name: "Flash AI",
    description: "Build apps, make slides, write, research, code and translate in one place.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: BRAND.ink,
    theme_color: BRAND.ink,
    // "?v=2" is a new address for the new logo, so phones and computers fetch it instead of keeping the old one.
    icons: [
      { src: "/app-icon/192?v=2", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/app-icon/512?v=2", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/app-icon/maskable?v=2", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
