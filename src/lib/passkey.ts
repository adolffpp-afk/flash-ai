/*
 * The browser's half of passkeys (see server/passkeys.ts): turns the server's options into what
 * navigator.credentials wants, and the device's answer back into JSON, base64url throughout.
 */

const toBytes = (b64url: string) => {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const toB64url = (buf: ArrayBuffer | null | undefined) => {
  if (!buf) return undefined;
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

type Described = { id: string; type?: string; transports?: string[] };
const described = (list: Described[] | undefined) =>
  list?.map((c) => ({ ...c, type: "public-key" as const, id: toBytes(c.id) })) as PublicKeyCredentialDescriptor[] | undefined;

import { useSyncExternalStore } from "react";

/** Whether this browser can use passkeys at all. */
export const passkeysSupported = () =>
  typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && !!navigator.credentials;

const never = () => () => {};
/** passkeysSupported for a component: false while it renders on the server, then the browser's answer. */
export const usePasskeysSupported = () => useSyncExternalStore(never, passkeysSupported, () => false);

/** Whether the person closed the device's prompt (or it timed out): nothing to report. */
export const cancelled = (err: unknown) => err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError");

/** Makes a new passkey on this device from the server's options; returns it as JSON for the server. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createPasskey(options: any): Promise<Record<string, unknown>> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: toBytes(options.challenge),
      user: { ...options.user, id: toBytes(options.user.id) },
      excludeCredentials: described(options.excludeCredentials),
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException("No passkey made", "NotAllowedError");
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      attestationObject: toB64url(r.attestationObject),
      transports: typeof r.getTransports === "function" ? r.getTransports() : undefined,
    },
  };
}

/** Signs the server's challenge with a passkey on this device; returns the answer as JSON for the server. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function signWithPasskey(options: any): Promise<Record<string, unknown>> {
  const cred = (await navigator.credentials.get({
    publicKey: { ...options, challenge: toBytes(options.challenge), allowCredentials: described(options.allowCredentials) },
  })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException("No passkey chosen", "NotAllowedError");
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      authenticatorData: toB64url(r.authenticatorData),
      signature: toB64url(r.signature),
      userHandle: toB64url(r.userHandle),
    },
  };
}

/**
 * Signs in with a passkey on this device: the server's challenge, the device's lock, then the
 * server's check. Returns the account signed in to, as the password sign-in does.
 */
export async function signInWithPasskey(next?: string): Promise<{ account?: string }> {
  const { api } = await import("./store");
  const { options } = await api<{ options: unknown }>("/api/auth/passkey", { method: "POST", json: { step: "options" } });
  const response = await signWithPasskey(options);
  return api<{ account?: string }>("/api/auth/passkey", { method: "POST", json: { step: "verify", response, next } });
}
