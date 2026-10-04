import { appUrl } from "@/lib/server/auth.ts";
import { getClient, tokenUser } from "@/lib/server/connector.ts";
import { CORS, json, needsSignIn, preflight } from "@/lib/server/connector-http.ts";
import { callTool, tools, type ToolContext } from "@/lib/server/mcp-tools.ts";
import { overLimit } from "@/lib/server/limits.ts";

// Videos take a few minutes (each media job stops waiting after 240 seconds).
export const maxDuration = 300;

/**
 * The Flash connector: an MCP server (Streamable HTTP, without sessions) that lets apps like
 * Claude and ChatGPT use Flash's tools with the signed-in user's credits.
 */

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

const INSTRUCTIONS =
  "Flash AI makes images, videos, music and voice-overs with the user's Flash credits. Each tool's description gives its price. " +
  "Tell the user what something will cost before making videos, which cost the most. Share the links Flash returns; anyone with a link can open the file.";

type RpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type RpcReply = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const reply = (id: RpcMessage["id"], result: unknown): RpcReply => ({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError = (id: RpcMessage["id"], code: number, message: string): RpcReply => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handle(msg: RpcMessage, ctx: ToolContext): Promise<RpcReply | null> {
  // Notifications and replies to us need no answer.
  if (msg.id === undefined || !msg.method) return null;
  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return reply(msg.id, {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "flash-ai", title: "Flash AI", version: "1.0.0", websiteUrl: ctx.origin },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply(msg.id, {});
    case "tools/list":
      return reply(msg.id, { tools: tools() });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const result = await callTool(name, typeof args === "object" && args ? args : {}, ctx);
      return result ? reply(msg.id, result) : rpcError(msg.id, -32602, `Unknown tool: ${name}`);
    }
    default:
      return rpcError(msg.id, -32601, `Flash doesn't support ${msg.method}.`);
  }
}

export async function POST(request: Request) {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const signedIn = await tokenUser(token);
  if (!signedIn) return needsSignIn(request, token ? "invalid_token" : undefined);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(rpcError(null, -32700, "Send a JSON-RPC message."), 400);
  }
  const messages = (Array.isArray(body) ? body : [body]) as RpcMessage[];
  if (!messages.length || messages.some((m) => !m || typeof m !== "object")) {
    return json(rpcError(null, -32600, "Send a JSON-RPC message."), 400);
  }
  const app = (await getClient(signedIn.clientId))?.name ?? "a connected app";
  const calls = messages.filter((m) => m.method === "tools/call").length;
  if (calls && (await overLimit(`mcp:${signedIn.user.id}`, 60, 3600_000))) {
    return json(rpcError(messages[0].id, -32000, "Too many Flash requests this hour. Please wait a little."), 429);
  }

  const base: Omit<ToolContext, "progress"> = { user: signedIn.user, origin: appUrl(request), app };
  const single = !Array.isArray(body) ? messages[0] : null;
  const progressToken = (single?.params?._meta as { progressToken?: string | number } | undefined)?.progressToken;
  const streams = (request.headers.get("accept") ?? "").includes("text/event-stream");

  // A tool call can take minutes, so it answers as a stream: progress updates, then the result.
  if (single?.method === "tools/call" && streams) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let open = true;
        const write = (chunk: string) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            open = false;
          }
        };
        let step = 0;
        let last = "";
        const progress = (message: string) => {
          if (progressToken === undefined || message === last) return;
          last = message;
          write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: ++step, message } })}\n\n`);
        };
        // Keeps the connection open through proxies while a video films.
        const keepAlive = setInterval(() => write(": still working\n\n"), 15_000);
        try {
          const answer = await handle(single, { ...base, progress }).catch((err) => {
            console.error("[flash] connector call failed", err);
            return rpcError(single.id, -32603, "Flash had a problem. Please try again.");
          });
          if (answer) write(`data: ${JSON.stringify(answer)}\n\n`);
        } finally {
          clearInterval(keepAlive);
          open = false;
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
    });
  }

  const answers: RpcReply[] = [];
  for (const msg of messages) {
    const answer = await handle(msg, { ...base, progress: () => {} }).catch((err) => {
      console.error("[flash] connector call failed", err);
      return rpcError(msg.id, -32603, "Flash had a problem. Please try again.");
    });
    if (answer) answers.push(answer);
  }
  if (!answers.length) return new Response(null, { status: 202, headers: CORS });
  return json(Array.isArray(body) ? answers : answers[0]);
}

/** Flash never starts messages to the app, so there is no stream to open. */
export const GET = () => new Response("Use POST for MCP requests.", { status: 405, headers: { ...CORS, Allow: "POST, OPTIONS" } });
export const DELETE = () => new Response(null, { status: 405, headers: { ...CORS, Allow: "POST, OPTIONS" } });
export const OPTIONS = preflight;
