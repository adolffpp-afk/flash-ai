import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getShare } from "@/lib/server/shares.ts";
import { referralCode } from "@/lib/server/referrals.ts";
import { Message } from "@/components/Message";
import { Logo } from "@/app/brand";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const share = await getShare((await params).id);
  return {
    title: share ? `${share.title} · made with Flash AI` : "Shared chat",
    description: "A chat made with Flash AI, the all-in-one AI app.",
    // Shared chats are for the people given the link, not for search engines.
    robots: { index: false, follow: false },
  };
}

/** A read-only copy of a chat, as it was when it was shared. */
export default async function SharedChat({ params }: Props) {
  const share = await getShare((await params).id);
  if (!share) notFound();
  // Visitors who sign up from a shared chat count as the sharer's referral.
  const ref = await referralCode(share.user_id).catch(() => null);
  const start = ref ? `/?ref=${encodeURIComponent(ref)}` : "/";
  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-white/6 bg-zinc-950/80 px-4 backdrop-blur-md">
        <a href={start} aria-label="Flash AI">
          <Logo size={26} className="text-[15px]" />
        </a>
        <span className="hidden min-w-0 flex-1 truncate text-sm text-zinc-400 sm:block">{share.title}</span>
        <a
          href={start}
          className="ml-auto h-9 shrink-0 rounded-full bg-brand px-4 text-sm font-medium leading-9 text-on-brand transition hover:brightness-110"
        >
          Try Flash free
        </a>
      </header>
      <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
        <p className="text-center text-xs text-zinc-500">
          Shared chat · {new Date(share.created_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
        </p>
        {share.messages.map((m) => (
          <Message key={m.id} m={m} />
        ))}
        <div className="mt-12 rounded-2xl border border-white/8 bg-white/[0.02] p-6 text-center">
          <p className="text-lg font-medium text-white">
            Made with <span className="text-holo">Flash AI</span>
          </p>
          <p className="mx-auto mt-2 max-w-md text-sm text-zinc-400">
            Apps, slides, images, video, movies, music and more from one sentence. Start free with credits every month.
          </p>
          <a
            href={start}
            className="mt-4 inline-flex h-10 items-center rounded-full bg-holo px-5 text-sm font-medium text-night transition hover:brightness-105"
          >
            Try Flash free
          </a>
        </div>
      </main>
    </div>
  );
}
