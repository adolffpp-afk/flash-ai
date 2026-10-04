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
    icons: [
      { src: "/app-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/app-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/app-icon/maskable", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
