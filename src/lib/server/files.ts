import { run, one, now } from "./db.ts";
import { randomId } from "./ids.ts";

/** Stores generated media for a user and returns the URL that serves it. */
export async function saveFile(userId: string, mime: string, name: string, data: Buffer): Promise<string> {
  const id = randomId(16);
  await run("INSERT INTO files (id, user_id, mime, name, data, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    id,
    userId,
    mime,
    name,
    data,
    now(),
  ]);
  return `/api/files/${id}`;
}

export async function readFile(id: string, userId: string) {
  return one<{ mime: string; name: string; data: ArrayBuffer }>(
    "SELECT mime, name, data FROM files WHERE id = ? AND user_id = ?",
    [id, userId],
  );
}
