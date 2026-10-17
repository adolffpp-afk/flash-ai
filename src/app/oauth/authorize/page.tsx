import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { MAX_ACCOUNTS, jarFromCookies } from "@/lib/server/auth.ts";
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

/**
 * "Connect to Flash": an app like Claude or ChatGPT asks to use Flash with this account. A browser
 * may be signed in to several accounts (see the jar in auth.ts): the page shows one, the default
 * unless ?account= names another one signed in here, and the answer carries it, so the app is
 * connected to exactly the account shown (see /api/oauth/authorize).
 */
export default async function Authorize({ searchParams }: Props) {
  const raw = await searchParams;
  const all = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  // Flash's own parameters, not the app's: which account, and whether the accounts here changed.
  const { account: wanted, changed, ...params } = all;
  const checked = await checkAuthorize(params, await origin());
  if ("redirect" in checked) redirect(checked.redirect);

  const cookieStore = await cookies();
  const secure = (await headers()).get("x-forwarded-proto") === "https";
  const jar = await jarFromCookies((name) => cookieStore.get(name)?.value, secure);
  const shown = jar.entries.find((e) => e.user.id === wanted) ?? jar.byDefault ?? jar.entries[0] ?? null;
  const user = shown?.user ?? null;
  const others = jar.entries.filter((e) => e !== shown);
  const query = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => typeof e[1] === "string"));
  const here = `/oauth/authorize?${query}`;
  if (!("fatal" in checked) && !user) return <ConnectSignIn next={here} />;

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
            {changed === "1" && (
              <p role="alert" className="mt-6 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                The accounts signed in here changed. Check the account below and try again.
              </p>
            )}
            <p className="mt-6 text-xs text-zinc-500">
              Signed in as <span className="font-medium text-zinc-300">{user!.email}</span>. What it makes uses this
              account&apos;s credits, at the same prices as in Flash. You can disconnect it at any time: in Flash, open
              your credits, then Connected apps.
            </p>
            <details className="mt-3 text-xs text-zinc-400">
              <summary className="cursor-pointer select-none text-zinc-300 hover:text-zinc-100">Use another account</summary>
              <ul className="mt-2 grid gap-1">
                {others.map((e) => (
                  <li key={e.user.id}>
                    <a
                      href={`${here}&account=${encodeURIComponent(e.user.id)}`}
                      className="flex min-h-10 items-center rounded-lg px-2 hover:bg-white/[0.05]"
                    >
                      <bdi className="truncate">{e.user.email}</bdi>
                    </a>
                  </li>
                ))}
                {jar.entries.length < MAX_ACCOUNTS && (
                  <li>
                    <a
                      href={`/?add=1&next=${encodeURIComponent(here)}`}
                      className="flex min-h-10 items-center rounded-lg px-2 text-primary hover:bg-white/[0.05]"
                    >
                      Sign in to another account
                    </a>
                  </li>
                )}
              </ul>
            </details>
            <form method="post" action="/api/oauth/authorize" className="mt-5 flex gap-2">
              {Object.entries(params).map(([k, v]) =>
                typeof v === "string" ? <input key={k} type="hidden" name={k} value={v} /> : null,
              )}
              <input type="hidden" name="account" value={user!.id} />
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
