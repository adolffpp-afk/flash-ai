/**
 * Whether an address from a link (?next=) is a path on this site, so a crafted link can't send
 * people elsewhere once they sign in. Browsers drop tabs and line breaks from an address and read
 * "\" as "/", so "/\t/evil.example" and "/\evil.example" would leave Flash: both are refused.
 * The server (safeNext in server/oauth.ts) and the page (Flash.tsx) check the same way.
 */
export function isLocalPath(next: string | null | undefined): next is string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return false;
  // Control characters could turn the path into something a browser reads differently.
  return ![...next].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}
