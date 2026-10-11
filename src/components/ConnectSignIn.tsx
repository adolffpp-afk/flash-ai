"use client";

import { useBrowserLanguage } from "@/lib/use-t";
import { AuthScreen } from "./AuthScreen";

/** Signing in on the "Connect to Flash" page, which then shows the approval step. */
export function ConnectSignIn({ next }: { next: string }) {
  useBrowserLanguage();
  return <AuthScreen initialMode="login" next={next} onDone={() => window.location.reload()} />;
}
