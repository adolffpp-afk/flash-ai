import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

/*
 * Signed-out routes that email someone (sign-in links, password resets, sign-ups) can't be used by
 * other sites or one network to spend Flash's daily email allowance, and a very long "email" is
 * refused before the slow pattern runs.
 */
register("./support/route-hooks.mjs", import.meta.url);
process.env.DATABASE_URL = ":memory:";
process.env.RESEND_API_KEY = "test-key";
delete process.env.FLASH_DEMO_EMAILS;

const sent: string[] = [];
globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  sent.push(JSON.parse(String(init?.body)).to[0]);
  return Response.json({ id: "email" });
}) as typeof fetch;
console.warn = () => {};

const linkRoute = await import("../src/app/api/auth/email-link/request/route.ts");
const resetRoute = await import("../src/app/api/auth/reset/request/route.ts");
const { EMAIL_BUDGET } = await import("../src/lib/server/email.ts");

const ORIGIN = "https://flash-app.dev";
const ask = (path: string, body: object, ip: string, headers: Record<string, string> = { origin: ORIGIN }) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers },
    body: JSON.stringify(body),
  });

test("another site can't ask for sign-in or reset emails", async () => {
  const sites: Record<string, string>[] = [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }, { origin: "null" }];
  for (const headers of sites) {
    assert.equal((await linkRoute.POST(ask("/api/auth/email-link/request", { email: "a@b.io" }, "1.1.1.1", headers))).status, 403);
    assert.equal((await resetRoute.POST(ask("/api/auth/reset/request", { email: "a@b.io" }, "1.1.1.1", headers))).status, 403);
  }
  // A form that isn't JSON either.
  const form = new Request(`${ORIGIN}/api/auth/email-link/request`, { method: "POST", headers: { "content-type": "text/plain" }, body: '{"email":"a@b.io"}' });
  assert.equal((await linkRoute.POST(form)).status, 403);
  assert.equal(sent.length, 0);
});

test("a very long email address is refused at once", async () => {
  const email = `a@${".".repeat(200_000)}@`;
  const started = performance.now();
  assert.equal((await linkRoute.POST(ask("/api/auth/email-link/request", { email }, "1.1.1.2"))).status, 400);
  assert.ok(performance.now() - started < 200);
});

test("one network can't send more than its daily share, even to many addresses and over hours", async () => {
  let ok = 0;
  for (let i = 0; i < 40; i++) {
    // A new IPv6 address in the same /64 each time.
    const r = await linkRoute.POST(ask("/api/auth/email-link/request", { email: `x${i}@catch.all` }, `2001:db8:5:6::${i + 1}`));
    if (r.status === 200) ok++;
  }
  assert.ok(ok <= 10, "the hourly limit per network holds across addresses in one /64");
  assert.ok(ok <= EMAIL_BUDGET.perNetwork);
});

test("sign-in links to new addresses stop at their daily share, from many networks", async () => {
  for (let i = 0; i < 60; i++) await linkRoute.POST(ask("/api/auth/email-link/request", { email: `n${i}@catch.all` }, `198.51.100.${i}`));
  // Every link so far went to an address with no account, so all share one daily allowance.
  assert.equal(sent.length, EMAIL_BUDGET.forNewAddresses);
});
