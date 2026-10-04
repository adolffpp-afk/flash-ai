import { all } from "./db.ts";

export type ChatHit = { id: string; name: string; snippet: string; role: "user" | "assistant" | null };

const MAX_HITS = 20;

/** A short piece of text around the first match, on one line. */
function snippetOf(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + length + 60);
  const piece = text.slice(start, end).replace(/[#*_`>|]+/g, "").replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + piece + (end < text.length ? "…" : "");
}

/** The user's projects whose name or messages contain the words, newest first, with where they matched. */
export async function searchChats(userId: string, query: string): Promise<ChatHit[]> {
  const q = query.trim().slice(0, 100);
  if (q.length < 2) return [];
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await all<{ id: string; name: string; messages: string }>(
    "SELECT id, name, messages FROM projects WHERE user_id = ? AND (name LIKE ? ESCAPE '\\' OR messages LIKE ? ESCAPE '\\') " +
      "ORDER BY updated_at DESC LIMIT ?",
    [userId, like, like, MAX_HITS],
  );
  const needle = q.toLowerCase();
  const hits: ChatHit[] = [];
  for (const row of rows) {
    let messages: { role?: string; content?: string }[] = [];
    try {
      messages = JSON.parse(row.messages);
    } catch {}
    const found = messages.find((m) => typeof m.content === "string" && m.content.toLowerCase().includes(needle));
    if (found) {
      const text = found.content!;
      hits.push({
        id: row.id,
        name: row.name,
        snippet: snippetOf(text, text.toLowerCase().indexOf(needle), q.length),
        role: found.role === "user" ? "user" : "assistant",
      });
    } else if (row.name.toLowerCase().includes(needle)) {
      hits.push({ id: row.id, name: row.name, snippet: "", role: null });
    }
    // Otherwise the words only matched message details (like a file name), not something the user would see.
  }
  return hits;
}
