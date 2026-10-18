/** How many Flash accounts one browser can be signed in to at once (see the jar in server/auth.ts). */
export const MAX_ACCOUNTS = 5;

/**
 * What the sign-in and sign-up screen sends. A password sign-in carries next, the page to open
 * afterwards (a link's, or Connect to Flash's), so when two-step sign-in is on the code page can
 * open it once the code is right (the server keeps it with the pending code only after safeNext).
 * A new account has no two-step sign-in to wait for.
 */
export function signInBody(mode: "signup" | "login", fields: { name: string; email: string; password: string; next?: string }) {
  const { name, email, password, next } = fields;
  return { name, email, password, ...(mode === "login" && next && { next }) };
}
