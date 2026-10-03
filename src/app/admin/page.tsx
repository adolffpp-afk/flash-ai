import type { Metadata } from "next";
import { AdminDashboard } from "@/components/AdminDashboard";

export const metadata: Metadata = { title: "Dashboard" };

export default function Admin() {
  return <AdminDashboard />;
}
