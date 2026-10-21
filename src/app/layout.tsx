import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { BAR_COLORS, THEME_SCRIPT } from "@/lib/device-settings";
import { ThemeSync } from "@/components/ThemeSync";
import { PRODUCT_NAME, TAGLINE } from "@/lib/product";
import { SITE_URL } from "./site";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

// Search results and shared links are in English, like the landing page.
const title = `${PRODUCT_NAME}™: ${TAGLINE}`;
const description = `${TAGLINE} Build apps, make slides, write, research, code and translate in one place. Ask once, and Flash picks the best AI for the job.`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: title, template: `%s · ${PRODUCT_NAME}` },
  description,
  applicationName: PRODUCT_NAME,
  // On an iPhone: the name suggested for the Home Screen icon, and Flash opening full screen from it.
  appleWebApp: { capable: true, title: PRODUCT_NAME },
  // iPhones before iOS 16.4 open a Home Screen web app full screen only with Apple's own tag.
  other: { "apple-mobile-web-app-capable": "yes" },
  openGraph: { title, siteName: PRODUCT_NAME, type: "website", url: "/", description },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = { themeColor: BAR_COLORS.light };

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
