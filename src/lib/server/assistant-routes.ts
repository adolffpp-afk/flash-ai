/*
 * What every assistant route does first, and how it says no (see server/assistants.ts for the work
 * itself). Nothing answers while ASSISTANTS_ON is false: each route is a 404 before it reads the
 * database. A write is taken only from Flash's own page with its exact Origin, as connectors' are.
 */
import { appUrl, getUser, unauthorized, type User } from "./auth.ts";
import { translatorFor, type ServerT } from "./i18n.ts";
import { approvalAllowed } from "./pending-actions.ts";
import { AssistantError, refusalStatus, type Refusal } from "./assistants.ts";
import { ASSISTANTS_ON, MAX_UPLOAD_BYTES } from "../assistants.ts";

export const NO_STORE = { "cache-control": "no-store" } as const;

/** How a write's body comes: JSON, a form with a file, or none (a delete). */
export type WriteBody = "json" | "form" | "none";

/**
 * Whether a write comes from Flash's own page: its exact Origin, not a page on another site, and
 * the body it should have, which a form on another site can't send as JSON.
 */
export function fromFlash(request: Request, body: WriteBody): boolean {
  const own = [new URL(appUrl(request)).origin, new URL(request.url).origin];
  if (body === "json") return approvalAllowed(request, own);
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (body === "form" && type !== "multipart/form-data") return false;
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  return Boolean(origin) && origin !== "null" && own.includes(origin!);
}

/**
 * The signed-in user and their words for a request to an assistant route, or the answer that ends
 * it: 404 while assistants are off (before anything is read), 401 for nobody signed in, and 403 for
 * a write from anywhere but Flash's own page. `write` says how a write's body comes; none for a read.
 */
export async function gate(request: Request, write?: WriteBody): Promise<{ user: User; t: ServerT } | Response> {
  if (!ASSISTANTS_ON) return Response.json({ error: (await translatorFor(request))("Not found") }, { status: 404, headers: NO_STORE });
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (write && !fromFlash(request, write)) return Response.json({ error: t("Please use Flash's own page.") }, { status: 403, headers: NO_STORE });
  return { user, t };
}

const MB = 1024 * 1024;

/** A size as storage is shown: in MB from 1 MB, else in KB. */
export function sizeText(bytes: number, t: ServerT): string {
  return bytes >= MB
    ? t("{size} MB", { size: (bytes / MB).toLocaleString(t.locale, { maximumFractionDigits: 1 }) })
    : t("{size} KB", { size: Math.max(1, Math.round(bytes / 1024)).toLocaleString(t.locale) });
}

/** A refusal in the words of the person asking. */
export function refusalText(r: Refusal, t: ServerT): string {
  const n = (value: number) => value.toLocaleString(t.locale);
  switch (r.code) {
    case "name_missing":
      return t("Give your assistant a name.");
    case "name_long":
      return t("Names can be up to {max} characters.", { max: n(r.max) });
    case "name_kept":
      return t("That name is kept for Flash itself. Pick another.");
    case "description_long":
      return t("Descriptions can be up to {max} characters.", { max: n(r.max) });
    case "instructions_long":
      return t("Instructions can be up to {max} characters. Yours has {count}.", { max: n(r.max), count: n(r.count) });
    case "starters":
      return t("Up to {max} conversation starters, each up to {chars} characters.", { max: n(r.max), chars: n(r.chars) });
    case "too_many_assistants":
      return t("You've reached {max} assistants.", { max: n(r.max) });
    case "version_conflict":
      return t("Someone changed this assistant on another device. Reload to see their change.");
    case "too_many_files":
      return t("This assistant already has {max} files.", { max: n(r.max) });
    case "duplicate":
      return t("This file is already in this assistant.");
    case "assistant_full":
      return t("This assistant's files are full: up to {chars} characters in all.", { chars: n(r.chars) });
    case "file_long":
      return t("A file can keep up to {chars} characters.", { chars: n(r.chars) });
    case "upload_big":
      return t("Files must be {size} MB or smaller.", { size: n(r.bytes / 1_000_000) });
    case "bad_file":
      return t("Couldn't read the attached files.");
    case "storage":
      return t("Not enough storage for this file: {used} of {limit} used.", { used: sizeText(r.used, t), limit: sizeText(r.limit, t) });
    case "daily_text":
      return t("You've added a lot of text today. Try again tomorrow.");
    case "not_found":
      return t("Not found");
    default:
      return t("Something went wrong. Please try again.");
  }
}

/** The answer to a refusal, with its code and, for a version conflict, the version now. */
export function refusal(r: Refusal, t: ServerT): Response {
  return Response.json(
    { error: refusalText(r, t), code: r.code, ...(r.code === "version_conflict" && { version: r.version }) },
    { status: refusalStatus(r), headers: NO_STORE },
  );
}

/** Runs a route's work, answering an AssistantError with its refusal and anything else with a 500. */
export async function answer(t: ServerT, work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof AssistantError) return refusal(err.refusal, t);
    console.error("[flash] assistant request failed", err instanceof Error ? err.message : "error");
    return refusal({ code: "failed" }, t);
  }
}

// The most an upload's request can be: its text, and room for the other fields and the form's own
// lines around them.
export const UPLOAD_CAP = MAX_UPLOAD_BYTES + 64 * 1024;

/**
 * An upload's form, read only up to `cap` bytes: a request that says it's bigger is refused before
 * a byte is read, and one that goes over as it comes is stopped there, so nothing bigger is ever
 * parsed or held. "too_big" or "bad" when it can't be read.
 */
export async function readForm(request: Request, cap = UPLOAD_CAP): Promise<FormData | "too_big" | "bad"> {
  const said = Number(request.headers.get("content-length"));
  if (said > cap) return "too_big";
  if (!request.body) return "bad";
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
    if (done || !value) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      return "too_big";
    }
    parts.push(value);
  }
  try {
    return await new Response(Buffer.concat(parts), { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return "bad";
  }
}
