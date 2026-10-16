import type { Metadata } from "next";
import { AdminDashboard } from "@/components/AdminDashboard";

export const metadata: Metadata = { title: "Dashboard" };

export default async function Admin({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { tab } = await searchParams;
  return <AdminDashboard initialTab={typeof tab === "string" ? tab : undefined} />;
}
