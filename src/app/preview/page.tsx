import type { Metadata } from "next";
import { PreviewTab } from "@/components/PreviewTab";

export const metadata: Metadata = { title: "Preview", robots: { index: false } };

export default function PreviewPage() {
  return <PreviewTab />;
}
