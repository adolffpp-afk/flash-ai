/*
 * Several files sent with one message, like two contracts to compare. The first is the message's
 * main file (photo edits, transcripts and the router look at it); the rest ride along.
 */
import type { Attachment } from "./types.ts";

export const MAX_FILES = 5;
// Together they must fit in one request, like a single file.
export const MAX_TOTAL_BYTES = 3 * 1024 * 1024;

/** The bytes in a base64 attachment. */
export const base64Bytes = (a: { data: string }) => (a.data.length * 3) / 4;

const isMedia = (a: Attachment) => /^(audio|video)\//.test(a.mediaType);

/** The files with one more added (a file of the same name is replaced), or why it can't be. */
export function addAttachment(files: Attachment[], file: Attachment): { files: Attachment[] } | { error: string } {
  const others = files.filter((f) => f.name !== file.name);
  if (others.length && (isMedia(file) || others.some(isMedia))) {
    return { error: "Audio and video files go on their own. Send them in a separate message." };
  }
  if (others.length >= MAX_FILES) return { error: `You can attach up to ${MAX_FILES} files to one message.` };
  const total = [...others, file].reduce((n, f) => n + base64Bytes(f), 0);
  if (total > MAX_TOTAL_BYTES) {
    return { error: `These files add up to more than ${MAX_TOTAL_BYTES / 1024 / 1024} MB. Send ${file.name} in its own message.` };
  }
  return { files: [...others, file] };
}

/** Why a message's files can't be sent together, or null when they can. */
export function checkFiles(first: Attachment | undefined, more: unknown): string | null {
  if (more === undefined) return null;
  if (!Array.isArray(more) || !first) return "Couldn't read the attached files.";
  const all = [first, ...more] as Attachment[];
  if (all.some((f) => !f || typeof f.name !== "string" || typeof f.mediaType !== "string" || typeof f.data !== "string")) {
    return "Couldn't read the attached files.";
  }
  if (all.length > MAX_FILES) return `You can attach up to ${MAX_FILES} files to one message.`;
  if (all.length > 1 && all.some(isMedia)) return "Audio and video files go on their own. Send them in a separate message.";
  if (all.reduce((n, f) => n + base64Bytes(f), 0) > MAX_TOTAL_BYTES) return "Files must add up to 3 MB or less.";
  return null;
}
