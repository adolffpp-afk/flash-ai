import { all, one, run, now } from "./db.ts";
import { randomId } from "./ids.ts";
import { readFile } from "./files.ts";
import type { UIMessage } from "../store.ts";

const FILE_URL = /^\/api\/files\/([\w-]+)$/;

/** The address a shared file is served from, so viewers who aren't signed in can see it. */
const sharedFileUrl = (shareId: string, url: string) => {
  const id = url.match(FILE_URL)?.[1];
  return id ? `/s/${shareId}/files/${id}` : url;
};

/**
 * A copy of a chat that is safe to show anyone: finished messages only, with no errors, costs or
 * app code, and with file links pointing at the share. A published app keeps its public link.
 */
export function shareable(messages: UIMessage[], shareId: string): UIMessage[] {
  return messages
    .filter((m) => !m.pending && !(m.error && !m.content && !m.images?.length && !m.videos?.length && !m.audio))
    .map((m): UIMessage => {
      const appNote = m.app ? (m.app.slug ? `\n\n[Open the app](/p/${m.app.slug})` : "\n\n*Flash built an app here.*") : "";
      return {
        id: m.id,
        role: m.role,
        content: (m.content ?? "") + appNote + (m.after ? `\n\n${m.after}` : ""),
        attachmentName: m.attachmentName,
        engine: m.engine,
        model: m.model,
        images: m.images?.map((x) => ({ ...x, url: sharedFileUrl(shareId, x.url) })),
        videos: m.videos?.map((x) => ({ ...x, url: sharedFileUrl(shareId, x.url) })),
        audio: m.audio ? sharedFileUrl(shareId, m.audio) : undefined,
        audioLabel: m.audioLabel,
        sources: m.sources,
      };
    });
}

/** Shares a project as it is now. Returns the share's id, or null when the project isn't the user's. */
export async function createShare(userId: string, projectId: string): Promise<string | null> {
  const project = await one<{ name: string; messages: string }>(
    "SELECT name, messages FROM projects WHERE id = ? AND user_id = ?",
    [projectId, userId],
  );
  if (!project) return null;
  const id = randomId(12);
  const messages = shareable(JSON.parse(project.messages) as UIMessage[], id);
  await run("INSERT INTO shares (id, user_id, project_id, title, messages, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    id,
    userId,
    projectId,
    project.name,
    JSON.stringify(messages),
    now(),
  ]);
  return id;
}

export async function getShare(id: string) {
  const row = await one<{ user_id: string; title: string; messages: string; created_at: number }>(
    "SELECT user_id, title, messages, created_at FROM shares WHERE id = ?",
    [id],
  );
  return row && { ...row, messages: JSON.parse(row.messages) as UIMessage[] };
}

/** Stops sharing: every link to this project stops working. */
export async function deleteShares(userId: string, projectId: string): Promise<number> {
  const r = await run("DELETE FROM shares WHERE user_id = ? AND project_id = ?", [userId, projectId]);
  return r.rowsAffected;
}

export async function sharesFor(userId: string, projectId: string): Promise<string[]> {
  const rows = await all<{ id: string }>("SELECT id FROM shares WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC", [
    userId,
    projectId,
  ]);
  return rows.map((r) => r.id);
}

/** A file in a share, only if the shared chat shows it. */
export async function sharedFile(shareId: string, fileId: string) {
  const share = await getShare(shareId);
  if (!share) return null;
  const url = `/s/${shareId}/files/${fileId}`;
  const shown = share.messages.some(
    (m) => m.audio === url || m.images?.some((x) => x.url === url) || m.videos?.some((x) => x.url === url),
  );
  return shown ? readFile(fileId, share.user_id) : null;
}
