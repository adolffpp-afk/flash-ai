import { all } from "./db.ts";

export type RecentChat = { id: string; name: string; updatedAt: number; engine: string | null; preview: string };

// Markdown marks, table rules and underscores that aren't inside a word, which don't belong in a one-line preview.
const MARKS = /[#*`~[\]]+|-{3,}|(?<!\w)_+|_+(?!\w)/g;

/**
 * One clean line from the start of a message: code blocks go (an answer that is all code reads
 * "Code"), links keep their words, and HTML tags, quote marks and Markdown marks are dropped.
 */
export function previewText(text: string): string {
  const line = text
    // The message is cut short before this, so a code block can be left open.
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[a-z!][^>]*>/gi, " ")
    .replace(/^\s*>\s?/gm, "")
    .replace(MARKS, "")
    .replace(/[|\s]+/g, " ")
    .trim()
    .slice(0, 160);
  return line || (text.includes("```") ? "Code" : "");
}

/**
 * The user's latest chats that have messages, newest first, with the tool that answered last and
 * the start of the last message. Only these few rows are read as JSON, so it stays quick however
 * long the chats are.
 */
export async function recentChats(userId: string, limit = 6): Promise<RecentChat[]> {
  const rows = await all<{ id: string; name: string; updated_at: number; engine: string | null; last: string | null }>(
    `SELECT id, name, updated_at,
            json_extract(messages, '$[#-1].engine') AS engine,
            substr(coalesce(nullif(json_extract(messages, '$[#-1].content'), ''), json_extract(messages, '$[#-1].after'), ''), 1, 240) AS last
     FROM projects WHERE user_id = ? AND messages != '[]' ORDER BY updated_at DESC LIMIT ?`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    updatedAt: Number(r.updated_at),
    engine: r.engine ?? null,
    preview: previewText(r.last ?? ""),
  }));
}
