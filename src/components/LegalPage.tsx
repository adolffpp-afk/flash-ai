import Link from "next/link";
import type { ReactNode } from "react";
import { LogoMark } from "@/app/brand";

export const CONTACT = process.env.FLASH_CONTACT_EMAIL || "support@flash-app.dev";
export const COMPANY = process.env.FLASH_COMPANY_NAME || "Flash AI";

/** Shared layout for the terms and privacy pages. */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-3xl px-4 py-10">
        <Link href="/" className="flex items-center gap-2 text-sm font-semibold">
          <LogoMark size={28} />
          Flash AI
        </Link>
        <h1 className="mt-8 text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-zinc-500">Last updated {updated}</p>
        <div className="prose prose-invert mt-8 max-w-none prose-h2:mt-8 prose-h2:text-xl prose-a:text-primary-soft">
          {children}
        </div>
      </div>
    </div>
  );
}
