import type { Metadata } from "next";
import { ResetForm } from "@/components/ResetForm";

export const metadata: Metadata = { title: "Reset password · Flash AI", robots: { index: false } };

export default async function ResetPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <ResetForm token={token ?? ""} />;
}
