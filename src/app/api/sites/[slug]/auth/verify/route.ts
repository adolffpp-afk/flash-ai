import { confirmVerifyLink } from "@/lib/server/site-verify.ts";

export const dynamic = "force-dynamic";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The link Flash emails to prove an address (see site-verify.ts). Opening it only shows a button:
 * mail scanners open links by themselves, so only pressing it (a POST) confirms the address.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Confirm your email</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f4f5;font:16px/1.5 system-ui,sans-serif;color:#18181b">
<form method="post" style="max-width:420px;margin:24px;padding:28px;background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);text-align:center">
<h1 style="margin:0 0 8px;font-size:20px">Confirm your email</h1>
<p style="margin:0 0 20px;color:#52525b">Only if you signed up yourself. If you didn't, close this page and nothing happens.</p>
<input type="hidden" name="t" value="${escape(token)}">
<button style="padding:12px 20px;border:0;border-radius:10px;background:#18181b;color:#fff;font:600 15px system-ui,sans-serif;cursor:pointer">Yes, it was me: confirm</button>
</form></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}

/** Pressing the button: the address is proved once, then the person goes to the app to sign in. */
export async function POST(request: Request, ctx: RouteContext<"/api/sites/[slug]/auth/verify">) {
  const { slug } = await ctx.params;
  const form = await request.formData().catch(() => null);
  const token = form?.get("t");
  const ok = typeof token === "string" && (await confirmVerifyLink(slug, token));
  return new Response(null, {
    status: 303,
    headers: { Location: `/p/${slug}?flash_auth=${ok ? "verified" : "link-expired"}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}
