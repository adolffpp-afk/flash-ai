import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { BAR_COLORS, THEME_SCRIPT } from "@/lib/device-settings";
import { ThemeSync } from "@/components/ThemeSync";
import { SITE_URL } from "./site";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

const description =
  "Build apps, make slides, write, research, code and translate in one place. Ask once, and Flash picks the best AI for the job.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "Flash AI: one AI for everything", template: "%s · Flash AI" },
  description,
  openGraph: { title: "Flash AI: one AI for everything", siteName: "Flash AI", type: "website", url: "/", description },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = { themeColor: BAR_COLORS.dark };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="h-full font-sans">
        {children}
        <ThemeSync />
      </body>
    </html>
  );
}
