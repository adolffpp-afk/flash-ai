import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, userForSession } from "@/lib/server/auth.ts";
import { checkAuthorize } from "@/lib/server/connector.ts";
import { ConnectSignIn } from "@/components/ConnectSignIn";
import { LogoMark } from "@/app/brand";

export const metadata: Metadata = { title: "Connect to Flash", robots: { index: false, follow: false } };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** This site's address, as auth.ts appUrl() works it out for route handlers. */
async function origin(): Promise<string> {
  const configured = process.env.FLASH_APP_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
}

/** Where an app sends people back to, shown so a look-alike app name can't hide who is asking. */
function appHost(uri: string): string {
  const url = new URL(uri);
  return url.protocol === "https:" || url.protocol === "http:" ? url.host : `${url.protocol}//`;
}

const CAN = [
  "Make and edit images, videos, music and voice with your Flash credits",
  "Publish web apps on your Flash account",
  "See how many credits you have left",
];
const CANNOT = ["See your chats, projects or files", "Buy credits or change your account"];

/** "Connect to Flash": an app like Claude or ChatGPT asks to use Flash with this account. */
export default async function Authorize({ searchParams }: Props) {
  const raw = await searchParams;
  const params = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  const checked = await checkAuthorize(params, await origin());
  if ("redirect" in checked) redirect(checked.redirect);

  const user = await userForSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!("fatal" in checked) && !user) {
    const query = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => typeof e[1] === "string"));
    return <ConnectSignIn next={`/oauth/authorize?${query}`} />;
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,0.12),transparent_60%)] px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-white/8 bg-zinc-950/70 p-6 text-zinc-100 backdrop-blur sm:p-8">
        <LogoMark size={44} className="mb-5" />
        {"fatal" in checked ? (
          <>
            <h1 className="text-xl font-medium tracking-tight">This connection can&apos;t continue</h1>
            <p className="mt-3 text-sm leading-relaxed text-zinc-400">{checked.fatal}</p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-medium tracking-tight text-balance">
              Connect <span className="text-holo">{checked.ok.client.name}</span> to Flash
            </h1>
            <p className="mt-2 text-sm text-zinc-400">
              Requested by <span className="font-medium text-zinc-200">{appHost(checked.ok.redirectUri)}</span>. Only
              allow apps you trust.
            </p>
            <div className="mt-6 grid gap-4 text-sm">
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">It will be able to</p>
                <ul className="grid gap-1.5">
                  {CAN.map((c) => (
                    <li key={c} className="flex gap-2 text-zinc-200">
                      <span className="text-primary" aria-hidden>✓</span>
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">It won&apos;t be able to</p>
                <ul className="grid gap-1.5">
                  {CANNOT.map((c) => (
                    <li key={c} className="flex gap-2 text-zinc-400">
                      <span aria-hidden>✕</span>
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="mt-6 text-xs text-zinc-500">
              Signed in as {user!.email}. What it makes uses your credits, at the same prices as in Flash. You can
              disconnect it at any time: in Flash, open your credits, then Connected apps.
            </p>
            <form method="post" action="/api/oauth/authorize" className="mt-5 flex gap-2">
              {Object.entries(params).map(([k, v]) =>
                typeof v === "string" ? <input key={k} type="hidden" name={k} value={v} /> : null,
              )}
              <button
                name="decision"
                value="deny"
                className="h-10 flex-1 rounded-lg border border-white/10 text-sm text-zinc-300 transition hover:bg-white/[0.05]"
              >
                Cancel
              </button>
              <button
                name="decision"
                value="allow"
                className="h-10 flex-1 rounded-lg bg-brand text-sm font-medium text-on-brand transition hover:brightness-110"
              >
                Allow
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
