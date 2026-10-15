import type { Metadata } from "next";
import { TwoFactorForm } from "@/components/TwoFactorForm";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

/** The second step of signing in, for accounts with two-step sign-in on (see two-factor.ts). */
export default function TwoFactorPage() {
  return <TwoFactorForm />;
}
