import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * Claude for the automation tests, on a local server (set ANTHROPIC_BASE_URL to its url): count_tokens
 * answers with state.count (or fails with its status), and each streamed reply is the next of
 * state.replies, as Claude streams it. A reply can fail before it starts (status), break off after
 * its first words (cut), wait after its first words until hold ends, or never end (never: only the
 * caller closing it ends it). Every request is kept with its headers, so a test can see which key
 * was used. Nothing reaches Anthropic.
 */

export type Block =
  | { type: "text"; text: string; citations?: object[] }
  | { type: "web_search_tool_result"; tool_use_id: string; content: object[] }
  | { type: "server_tool_use"; id: string; name: string; input: object };
export type Reply = {
  text?: string;
  blocks?: Block[];
  stop?: string;
  usage?: { input_tokens: number; output_tokens: number };
  // Answers with this error status instead (529 overloaded, 429 rate limited, 500).
  status?: number;
  cut?: boolean;
  hold?: Promise<unknown>;
  never?: boolean;
};
export type Seen = { path: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> };

export async function claudeStandIn() {
  const state = {
    count: { tokens: 1200, status: 0 },
    replies: [] as Reply[],
    seen: [] as Seen[],
    // Streams still open (a never-ending reply), and whether the caller closed each.
    open: 0,
    closed: 0,
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        // Not JSON.
      }
      const path = new URL(req.url ?? "/", "http://stand.in").pathname;
      state.seen.push({ path, headers: req.headers, body });
      const fail = (status: number) => {
        // x-should-retry: false, so the SDK hands the error over at once instead of trying again itself.
        res.writeHead(status, { "content-type": "application/json", "x-should-retry": "false", "request-id": "req_test" });
        res.end(JSON.stringify({ type: "error", error: { type: status === 429 ? "rate_limit_error" : status === 529 ? "overloaded_error" : "api_error", message: "scripted" } }));
      };
      if (path.endsWith("/count_tokens")) {
        if (state.count.status) return fail(state.count.status);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ input_tokens: state.count.tokens }));
      }
      if (!path.endsWith("/messages")) {
        res.writeHead(404);
        return res.end();
      }
      const reply = state.replies.shift() ?? { text: "Done." };
      if (reply.status) return fail(reply.status);
      const usage = reply.usage ?? { input_tokens: state.count.tokens, output_tokens: 300 };
      const blocks: Block[] = reply.blocks ?? [{ type: "text", text: reply.text ?? "Done." }];
      const events: object[] = [
        { type: "message_start", message: { id: `msg_${state.seen.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } },
      ];
      blocks.forEach((b, index) => {
        if (b.type === "text") {
          events.push({ type: "content_block_start", index, content_block: { type: "text", text: "", ...(b.citations && { citations: [] }) } });
          events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
          for (const c of b.citations ?? []) events.push({ type: "content_block_delta", index, delta: { type: "citations_delta", citation: c } });
        } else if (b.type === "server_tool_use") {
          events.push({ type: "content_block_start", index, content_block: { ...b, input: {} } });
          events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
        } else events.push({ type: "content_block_start", index, content_block: b });
        events.push({ type: "content_block_stop", index });
      });
      events.push({ type: "message_delta", delta: { stop_reason: reply.stop ?? "end_turn", stop_sequence: null }, usage }, { type: "message_stop" });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const write = (list: object[]) => {
        for (const e of list) res.write(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`);
      };
      const first = events.findIndex((e) => (e as { type: string }).type === "content_block_delta") + 1;
      if (reply.cut) {
        write(events.slice(0, first));
        setTimeout(() => res.destroy(), 20);
        return;
      }
      if (reply.never || reply.hold) {
        state.open++;
        let closed = false;
        res.on("close", () => {
          closed = true;
          state.open--;
          state.closed++;
        });
        write(events.slice(0, first));
        if (reply.never) return;
        void reply.hold!.then(() => {
          if (closed) return;
          write(events.slice(first));
          res.end();
        });
        return;
      }
      write(events);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    state,
    /** The streamed requests (not counts). */
    streamed: () => state.seen.filter((s) => s.path.endsWith("/messages")),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
