import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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

export const viewport: Viewport = { themeColor: "#f2f3f6" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="h-full font-sans">{children}</body>
    </html>
  );
}
