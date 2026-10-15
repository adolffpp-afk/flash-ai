import type { MetadataRoute } from "next";
import { PRODUCT_NAME, TAGLINE } from "@/lib/product";
import { BRAND } from "./brand";

// Lets phones and computers install Flash as an app, with its own icon and window.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    // Ten characters, short enough for the name under a home-screen icon too.
    name: PRODUCT_NAME,
    short_name: PRODUCT_NAME,
    description: `${TAGLINE} Build apps, make slides, write, research, code and translate in one place.`,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: BRAND.ink,
    theme_color: BRAND.ink,
    // "?v=3" is a new address for the infinity logo, so phones and computers fetch it instead of keeping the old one.
    icons: [
      { src: "/app-icon/192?v=3", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/app-icon/512?v=3", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/app-icon/maskable?v=3", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
