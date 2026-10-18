import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import { startStandIns } from "./research-stand-ins.ts";

/*
 * What the tests of chatting with an assistant share: Flash's chat and project routes, with
 * assistants on (on) or as shipped, on a libSQL file database with foreign keys off, as Turso runs,
 * and stand-ins for Claude and a free model (see research-stand-ins.ts). Assistants, their files, links
 * and visitors are written as the API would leave them. Call it before importing anything of Flash's.
 */
export async function assistantKit({ on }: { on: boolean }) {
  register("./route-hooks.mjs", import.meta.url);
  if (on) register("./assistants-on.mjs", import.meta.url);
  const stand = await startStandIns();
  stand.install();
  const dir = mkdtempSync(join(tmpdir(), "flash-assistant-chat-"));
  process.env.DATABASE_URL = `file:${join(dir, "chat.db")}`;
  process.env.ANTHROPIC_API_KEY = "sk-fake";
  process.env.ANTHROPIC_BASE_URL = `${stand.origin}/anthropic`;
  process.env.GROQ_API_KEY = "groq-test";
  process.env.GROQ_BASE_URL = `${stand.origin}/groq`;
  for (const name of [
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    "MISTRAL_API_KEY",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_BASE_URL",
    "VERCEL_ENV",
    "RESEND_API_KEY",
    "FLASH_APP_URL",
    "CONNECTOR_KEYS",
    "SEARXNG_URL",
    "FRED_API_KEY",
  ]) {
    delete process.env[name];
  }

  const { afterwards } = await import("./next-server.mjs");
  const { db, one, all, run } = await import("../../src/lib/server/db.ts");
  const { createSession } = await import("../../src/lib/server/auth.ts");
  const { indexFile } = await import("../../src/lib/server/assistant-search.ts");
  const { STORE_FACTOR } = await import("../../src/lib/assistants.ts");
  const chatRoute = await import("../../src/app/api/chat/route.ts");
  const projectRoute = await import("../../src/app/api/projects/[id]/route.ts");
  await db();
  await run("PRAGMA foreign_keys = OFF");

  const ORIGIN = "http://localhost";
  const bytes = (s: string) => Buffer.byteLength(s);
  const month = () => {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };

  let users = 0;
  /** A signed-in, verified user with this many credits and a plain chat of their own. */
  async function account(credits = 1000, o: { preferences?: string } = {}) {
    const id = `user${++users}`;
    await run("INSERT INTO users (id, email, name, password_hash, preferences, created_at, last_free_grant, verified_at) VALUES (?, ?, '', 'x', ?, 0, 0, 1)", [
      id,
      `${id}@example.com`,
      o.preferences ?? "",
    ]);
    await run("INSERT INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, 'test', ?, 0)", [id, credits, `free:${id}:${month()}`]);
    await run("INSERT INTO projects (id, user_id, name, messages, updated_at) VALUES (?, ?, 'Notes', '[]', 0)", [`proj_${id}`, id]);
    return { id, cookie: (await createSession(id, true)).split(";")[0], projectId: `proj_${id}` };
  }
  type Who = Awaited<ReturnType<typeof account>>;

  let assistants = 0;
  type AssistantRow = { name?: string; instructions?: string; description?: string; starters?: string[]; level?: string; instrTokens?: number; freeOk?: boolean; showFiles?: boolean; version?: number };
  /** An assistant of the owner's, as the API saves one. */
  async function assistant(owner: Who, o: AssistantRow = {}) {
    const id = (++assistants).toString(16).padStart(2, "0").repeat(16);
    await run(
      `INSERT INTO assistants (id, user_id, name, description, instructions, starters, level, color, instr_tokens, free_ok, show_files, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'teal', ?, ?, ?, ?, 0, 0)`,
      [
        id,
        owner.id,
        o.name ?? "Crumb helper",
        o.description ?? "Answers questions about Golden Crumb's bread.",
        o.instructions ?? "Answer as Golden Crumb's baker. Quote prices from the price list.",
        JSON.stringify(o.starters ?? ["What's fresh today?"]),
        o.level ?? "auto",
        o.instrTokens ?? 40,
        o.freeOk ? 1 : 0,
        o.showFiles ? 1 : 0,
        o.version ?? 3,
      ],
    );
    return id;
  }
  let files = 0;
  /** A file of an assistant's, indexed as an upload leaves it. */
  async function file(assistantId: string, name: string, text: string, o: { tokens?: number; exact?: boolean } = {}) {
    const id = `file${++files}`;
    const tokens = o.tokens ?? Math.ceil(bytes(text) / 4);
    await run(
      "INSERT INTO assistant_files (id, assistant_id, name, kind, chars, bytes, stored, tokens, exact, hash, created_at) VALUES (?, ?, ?, 'text', ?, ?, ?, ?, ?, ?, ?)",
      [id, assistantId, name, text.length, bytes(text), STORE_FACTOR * bytes(text), tokens, o.exact === false ? 0 : 1, id, files],
    );
    await indexFile(assistantId, id, text, tokens);
    return id;
  }
  /** Turns an assistant's link on (a new one each time), and lets a visitor in through it. */
  async function share(assistantId: string, shareId: string, ...visitors: Who[]) {
    await run("UPDATE assistants SET share_id = ?, shared_at = 1 WHERE id = ?", [shareId, assistantId]);
    for (const v of visitors) await run("INSERT OR REPLACE INTO assistant_visitors (assistant_id, user_id, share_id, first_at, last_at) VALUES (?, ?, ?, 0, 0)", [assistantId, v.id, shareId]);
  }
  /** A chat of the user's started with an assistant, named after it as startAssistantChat names it. */
  async function chatWith(who: Who, assistantId: string, name = "Crumb helper") {
    const id = `chat_${who.id}_${assistantId.slice(0, 6)}_${++files}`;
    await run("INSERT INTO projects (id, user_id, name, messages, updated_at, assistant_id) VALUES (?, ?, ?, '[]', 0, ?)", [id, who.id, name, assistantId]);
    return id;
  }

  const PRICES = "Sourdough loaf: 4 euros. Rye loaf: 5 euros. Croissant: 2 euros.";
  /** An owner's assistant with a price list, shared with a visitor, and a chat each with it. */
  async function bakery(o: AssistantRow = {}) {
    const owner = await account();
    const visitor = await account();
    const id = await assistant(owner, o);
    await file(id, "Prices.txt", PRICES);
    await share(id, `l${id.slice(0, 8)}`, visitor);
    return { owner, visitor, id, own: await chatWith(owner, id), theirs: await chatWith(visitor, id) };
  }

  const balance = async (id: string) => Number((await one<{ b: number }>("SELECT COALESCE(SUM(amount), 0) AS b FROM credit_ledger WHERE user_id = ?", [id]))!.b);
  const ledger = async (id: string) => all<{ amount: number; reason: string }>("SELECT amount, reason FROM credit_ledger WHERE user_id = ? ORDER BY rowid", [id]);

  type ChatEvent = { type: string; delta?: string; reason?: string; engine?: string; free?: boolean; cost?: number; items?: { label: string }[]; nomatch?: boolean; message?: string };
  let n = 0;
  /** A chat request as the page sends it, read to its end. */
  async function chat(who: Who, projectId: string, content: string, body: Record<string, unknown> = {}) {
    const replyId = `r${++n}`;
    const res = await chatRoute.POST(
      new Request(`${ORIGIN}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie: who.cookie },
        body: JSON.stringify({
          projectId,
          replyId,
          userMessage: { id: `u${n}`, role: "user", content },
          afterId: null,
          engine: "text",
          level: "ascend",
          messages: [{ role: "user", content }],
          ...body,
        }),
      }),
    );
    const events: ChatEvent[] = [];
    if (!res.ok || !res.body) {
      await afterwards();
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // Not JSON.
      }
      return { status: res.status, events, json };
    }
    let buffer = "";
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines.filter((l) => l.trim())) events.push(JSON.parse(line) as ChatEvent);
    }
    await afterwards();
    return { status: res.status, events, json: {} as Record<string, unknown> };
  }
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
  /** GET /api/projects/[id]. */
  async function getProject(who: Who, id: string) {
    const res = await projectRoute.GET(new Request(`${ORIGIN}/api/projects/${id}`, { headers: { cookie: who.cookie } }), ctx(id));
    return { status: res.status, body: (await res.json()) as { project?: Record<string, unknown>; error?: string } };
  }
  /** PUT /api/projects/[id]. */
  async function putProject(who: Who, id: string, json: Record<string, unknown>) {
    const res = await projectRoute.PUT(
      new Request(`${ORIGIN}/api/projects/${id}`, { method: "PUT", headers: { cookie: who.cookie, "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(json) }),
      ctx(id),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  type ClaudeBody = { model: string; system: string; tools?: { name: string; type?: string }[]; max_tokens: number; messages: { role: string; content: unknown }[] };
  const claudeSent = () => stand.state.claude.sent as unknown as ClaudeBody[];
  type FreeBody = { messages: { role: string; content: string }[]; max_tokens: number };
  const freeSent = () => stand.state.free.sent as unknown as FreeBody[];
  const said = (events: ChatEvent[]) => events.filter((e) => e.type === "text").map((e) => e.delta).join("");
  type Doc = { type: string; title?: string; context?: string; source?: { data: string }; text?: string };
  /** The documents (passages) in a message's content as Claude is sent it. */
  const docs = (content: unknown) => (Array.isArray(content) ? (content as Doc[]).filter((b) => b.type === "document") : []);

  return {
    stand,
    db,
    one,
    all,
    run,
    account,
    assistant,
    file,
    share,
    chatWith,
    PRICES,
    bakery,
    balance,
    ledger,
    chat,
    getProject,
    putProject,
    claudeSent,
    freeSent,
    said,
    docs,
    async close() {
      await stand.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
