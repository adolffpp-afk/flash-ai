import type { Metadata } from "next";
import { SignInLink } from "@/components/SignInLink";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <SignInLink token={token ?? ""} />;
}
