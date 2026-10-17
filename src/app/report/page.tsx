import type { Metadata } from "next";
import { ReportPage } from "@/components/ReportPage";
import { PRODUCT_NAME } from "@/lib/product";

export const metadata: Metadata = {
  title: "Report content",
  description: `Report a shared chat, a file or an app made with ${PRODUCT_NAME} that breaks the rules.`,
};

// Public, like /delete-account: app stores and anyone who sees something wrong can open it without
// signing in. Linked from the landing page, the legal pages, shared chats and the account menu.
export default function Report() {
  return <ReportPage />;
}
