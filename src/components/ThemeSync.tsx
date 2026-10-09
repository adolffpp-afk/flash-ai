"use client";

import { useEffect } from "react";
import { applyTheme } from "@/lib/device-settings";

/**
 * Sets the picked theme again once a page is running in the browser. The script in the page head
 * sets it before anything paints, but React can redraw the <html> tag if a page's first render in
 * the browser differs from the server's, which would drop it.
 */
export function ThemeSync() {
  useEffect(() => applyTheme(), []);
  return null;
}
