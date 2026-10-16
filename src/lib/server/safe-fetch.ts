import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { OUTBOUND_HEADER } from "../site-host.ts";

/*
 * Every server-side request to an address a user typed (a connector's server), or found from one,
 * goes through safeFetch, so a user can't point Flash at its own network, the cloud's metadata
 * service or another private address. It:
 * - takes https on port 443 only, with no user name or password in the address, no IP addresses,
 *   no local or internal names, and never Flash's own hosts (and marks every request it sends with
 *   OUTBOUND_HEADER, which Flash refuses, for an address of Flash's that isn't on that list);
 * - looks the name up itself and connects only to an address it checked (every address the name has
 *   must be public, so a name that also points inside can't be used to switch between them);
 * - follows at most 3 redirects, checking each one the same way and dropping the Authorization
 *   header when one goes to another server;
 * - gives 5 seconds to connect and 20 in all, reads at most maxBytes, asks for no compression, and
 *   takes only JSON or event-stream answers, unless the caller names others (Google Drive's plain
 *   text, CSV and PDF files, see google.ts).
 *
 * FLASH_CONNECT_MOCK (dev only) names one local origin, like http://127.0.0.1:7788, that is let
 * through for scripts/mock-connectors.ts. It is ignored whenever VERCEL_ENV is set, so it can never
 * open a hole in a deployment.
 */

export type SafeFetchCode = "blocked" | "timeout" | "too_large" | "bad_type" | "network" | "redirects";

/** Why a request wasn't made or didn't finish, with a message safe to show (it never holds the address or a header). */
export class SafeFetchError extends Error {
  code: SafeFetchCode;
  constructor(code: SafeFetchCode, message: string) {
    super(message);
    this.code = code;
  }
}

const BLOCKED_V4 = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const;
const BLOCKED_V6 = [
  ["::", 96], // unspecified, loopback and the old IPv4-compatible addresses
  ["::ffff:0:0", 96], // IPv4-mapped
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local NAT64
  ["100::", 64], // discard
  ["2001::", 23], // protocol assignments, Teredo included
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // old site-local
  ["ff00::", 8], // multicast
] as const;

// Two lists: a BlockList holding an IPv6 range like ::ffff:0:0/96 also matches every IPv4 address.
const blockedV4 = new BlockList();
for (const [net, prefix] of BLOCKED_V4) blockedV4.addSubnet(net, prefix, "ipv4");
const blockedV6 = new BlockList();
for (const [net, prefix] of BLOCKED_V6) blockedV6.addSubnet(net, prefix, "ipv6");

/** Whether an address is one Flash never connects to for a user: private, local, reserved or a way into one. */
export function blockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedV4.check(address, "ipv4");
  if (family === 6) return blockedV6.check(address, "ipv6");
  return true;
}

// Names that only mean something inside a network.
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".home.arpa", ".arpa", ".localdomain", ".test", ".invalid"];

/** Flash's own hosts, which a connector may never point back at. */
function ownHosts(): string[] {
  const hosts = ["flash-app.dev"];
  for (const value of [process.env.FLASH_APP_URL, process.env.VERCEL_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL, process.env.VERCEL_BRANCH_URL]) {
    if (!value) continue;
    try {
      hosts.push(new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase());
    } catch {
      // Not an address.
    }
  }
  return hosts;
}

/** The local origin FLASH_CONNECT_MOCK lets through in development, or "" (always "" on Vercel). */
export function mockOrigin(): string {
  const value = process.env.FLASH_CONNECT_MOCK?.trim();
  if (!value || process.env.VERCEL_ENV) return "";
  try {
    const url = new URL(value);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost") ? url.origin : "";
  } catch {
    return "";
  }
}

const BLOCKED = "Flash can only connect to public https addresses.";

/** Checks an address before anything is looked up: https, port 443, a public-looking name. Throws SafeFetchError("blocked"). */
export function checkUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SafeFetchError("blocked", "That isn't a web address.");
  }
  if (mockOrigin() && url.origin === mockOrigin()) return url;
  if (url.protocol !== "https:") throw new SafeFetchError("blocked", "The address must start with https://.");
  if (url.port && url.port !== "443") throw new SafeFetchError("blocked", BLOCKED);
  if (url.username || url.password) throw new SafeFetchError("blocked", BLOCKED);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.startsWith("[") || isIP(host)) throw new SafeFetchError("blocked", BLOCKED);
  if (!host.includes(".") || host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) throw new SafeFetchError("blocked", BLOCKED);
  if (ownHosts().some((own) => host === own || host.endsWith(`.${own}`))) throw new SafeFetchError("blocked", BLOCKED);
  return url;
}

export type Resolved = { address: string; family: number };
/** Looks a name up: every address it has. Tests pass their own. */
export type Resolver = (hostname: string) => Promise<Resolved[]>;
const systemResolver: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * The address to connect to for a name: the first, once every one has been checked. The lookup
 * keeps to the request's time and Stop (signal): a slow name server can't hold either up.
 */
async function vetted(hostname: string, resolve: Resolver, signal: AbortSignal): Promise<Resolved> {
  let found: Resolved[];
  let onAbort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    found = await Promise.race([resolve(hostname), stopped]);
  } catch {
    if (signal.aborted) throw abortError(signal);
    throw new SafeFetchError("network", "That server's name couldn't be found.");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (!found.length || found.some((a) => blockedAddress(a.address))) throw new SafeFetchError("blocked", BLOCKED);
  return found[0];
}

export type SafeRequest = {
  method?: "GET" | "POST" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  // At most this many bytes of answer: 1 MB by default (metadata); tool results pass 2 MB.
  maxBytes?: number;
  // At most this long in all, redirects included.
  timeoutMs?: number;
  signal?: AbortSignal;
  // The answers taken from a server, by content type. Error answers (400 and up) are read whatever their type.
  accept?: ("json" | "sse" | "text" | "pdf")[];
  // The body as its bytes, one character each (latin1), not as UTF-8 text: for a file (a PDF) to be
  // read back exactly with Buffer.from(body, "latin1").
  raw?: boolean;
  // A success longer than maxBytes is cut there (truncated: true) instead of refused: for a long text
  // file, of which only the start is ever read.
  truncate?: boolean;
  // false: a redirect is answered as it is, never followed. For a request whose body carries a secret
  // (an OAuth token or registration request), which a 307 would send on to wherever it points.
  followRedirects?: false;
};

export type SafeResponse = { status: number; headers: IncomingMessage["headers"]; contentType: string; body: string; url: string; truncated?: boolean };

export const CONNECT_TIMEOUT_MS = 5000;
export const TOTAL_TIMEOUT_MS = 20_000;
export const METADATA_BYTES = 1024 * 1024;
export const RESULT_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
// What is read of an error answer.
const ERROR_BYTES = 16 * 1024;

const TYPES = { json: /^application\/([\w.+-]+\+)?json$/, sse: /^text\/event-stream$/, text: /^text\/(plain|csv)$/, pdf: /^application\/pdf$/ };

/**
 * One request and its answer, to an address already checked, connecting only to `to` whatever the
 * name resolves to now (or by the system's lookup for the mock origin, when `to` is null).
 */
export function sendTo(url: URL, to: Resolved | null, req: SafeRequest, headers: Record<string, string>, signal: AbortSignal, maxBytes: number): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    const lookup: LookupFunction = (_hostname, options, callback) => {
      const cb = callback as (err: Error | null, address: string | Resolved[], family?: number) => void;
      if (options.all) cb(null, [to!]);
      else cb(null, to!.address, to!.family);
    };
    const options: RequestOptions = {
      method: req.method ?? "GET",
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      headers: { ...headers, "accept-encoding": "identity", [OUTBOUND_HEADER]: "1", ...(req.body !== undefined && { "content-length": String(Buffer.byteLength(req.body)) }) },
      signal,
      // A new connection every time, never one kept from an earlier request: it goes only to `to`.
      agent: false,
      ...(to && { lookup }),
    };
    const r = (url.protocol === "https:" ? httpsRequest : httpRequest)(options, (res) => {
      const status = res.statusCode ?? 0;
      const contentType = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      const redirect = status >= 300 && status < 400 && res.headers.location;
      const limit = redirect ? 0 : status >= 400 ? ERROR_BYTES : maxBytes;
      // A success must be JSON or an event stream; one with no type may only be empty (a notification's answer).
      const typed = Boolean(redirect) || status >= 400 || (req.accept ?? ["json", "sse"]).some((t) => TYPES[t].test(contentType));
      if (!typed && contentType !== "") {
        res.destroy();
        return reject(new SafeFetchError("bad_type", "That server didn't answer with JSON."));
      }
      // A success cut at maxBytes (req.truncate) is read up to there, whatever its length.
      const cut = Boolean(req.truncate) && status < 300 && !redirect;
      const decode = (bytes: Buffer) => bytes.toString(req.raw && status < 300 ? "latin1" : "utf8");
      if (Number(res.headers["content-length"] ?? 0) > Math.max(limit, ERROR_BYTES) && status < 400 && !cut) {
        res.destroy();
        return reject(new SafeFetchError("too_large", "That server's answer was too large."));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          if (cut) {
            const keep = limit - (size - chunk.length);
            if (keep > 0) chunks.push(chunk.subarray(0, keep));
            res.destroy();
            return resolve({ status, headers: res.headers, contentType, body: decode(Buffer.concat(chunks)), url: url.href, truncated: true });
          }
          if (status >= 400 || redirect) {
            // An error's start is enough; a redirect's body is never read.
            const keep = limit - (size - chunk.length);
            if (keep > 0) chunks.push(chunk.subarray(0, keep));
            res.destroy();
            return resolve({ status, headers: res.headers, contentType, body: Buffer.concat(chunks).toString("utf8"), url: url.href });
          }
          res.destroy();
          return reject(new SafeFetchError("too_large", "That server's answer was too large."));
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (!typed && size > 0) return reject(new SafeFetchError("bad_type", "That server didn't answer with JSON."));
        resolve({ status, headers: res.headers, contentType, body: decode(Buffer.concat(chunks)), url: url.href });
      });
      res.on("error", (err) => reject(signal.aborted ? abortError(signal) : new SafeFetchError("network", messageFor(err))));
    });
    const connectTimer = setTimeout(() => r.destroy(new SafeFetchError("timeout", "That server took too long to answer.")), CONNECT_TIMEOUT_MS);
    r.on("socket", (socket) => {
      const connected = () => clearTimeout(connectTimer);
      if (!socket.connecting) connected();
      else socket.once(url.protocol === "https:" ? "secureConnect" : "connect", connected);
    });
    r.on("close", () => clearTimeout(connectTimer));
    r.on("error", (err) => {
      clearTimeout(connectTimer);
      reject(err instanceof SafeFetchError ? err : signal.aborted ? abortError(signal) : new SafeFetchError("network", messageFor(err)));
    });
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });
}

/** A fixed message for a network error, never its text (which can carry the address or a header). */
function messageFor(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  if (code === "ECONNREFUSED" || code === "ECONNRESET") return "That server refused the connection.";
  if (/CERT|SSL|TLS/i.test(code)) return "That server's security certificate isn't valid.";
  return "That server couldn't be reached.";
}

/** Why a request was stopped: the time running out (a SafeFetchError), or the caller's own reason (Stop). */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(String(reason ?? "stopped"), "AbortError");
}

/**
 * Sends one request to a user's address under the rules above and returns the answer, its body
 * read in full (at most maxBytes). Throws SafeFetchError with a message safe to show, or the signal's
 * reason when the caller stopped it.
 */
export async function safeFetch(
  input: string,
  req: SafeRequest = {},
  // Tests pass their own name lookup and sender; nothing else does.
  { resolve = systemResolver, send = sendTo }: { resolve?: Resolver; send?: typeof sendTo } = {},
): Promise<SafeResponse> {
  const maxBytes = req.maxBytes ?? METADATA_BYTES;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new SafeFetchError("timeout", "That server took too long to answer.")), req.timeoutMs ?? TOTAL_TIMEOUT_MS);
  const signal = req.signal ? AbortSignal.any([req.signal, deadline.signal]) : deadline.signal;
  let url = checkUrl(input);
  let headers = { ...req.headers };
  let method = req.method ?? "GET";
  let body = req.body;
  try {
    for (let hop = 0; ; hop++) {
      if (signal.aborted) throw abortError(signal);
      const mock = Boolean(mockOrigin()) && url.origin === mockOrigin();
      const to = mock ? null : await vetted(url.hostname, resolve, signal);
      const res = await send(url, to, { ...req, method, body }, headers, signal, maxBytes);
      const location = res.status >= 300 && res.status < 400 ? res.headers.location : undefined;
      if (!location || req.followRedirects === false) return res;
      if (hop >= MAX_REDIRECTS) throw new SafeFetchError("redirects", "That server redirected too many times.");
      // A Location that isn't an address is a server problem, said without the address (which can hold a key).
      let target: URL;
      try {
        target = new URL(location, url);
      } catch {
        throw new SafeFetchError("network", "That server sent a redirect Flash couldn't follow.");
      }
      const next = checkUrl(target);
      if (next.origin !== url.origin) {
        // Another server never gets the user's key, or this server's session.
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(authorization|cookie|mcp-session-id)$/i.test(k)));
      }
      if (res.status !== 307 && res.status !== 308) {
        method = "GET";
        body = undefined;
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== "content-type"));
      }
      url = next;
    }
  } finally {
    clearTimeout(timer);
  }
}
