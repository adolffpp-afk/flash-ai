import type { UIMessage } from "./store.ts";
import type { StreamEvent } from "./types.ts";

/**
 * A reply with one more line of the chat stream applied. The browser builds the reply it shows
 * with this, and the chat route builds the copy it saves with it, so both are the same message.
 */
export function applyEvent(m: UIMessage, e: StreamEvent): UIMessage {
  switch (e.type) {
    case "route":
      return { ...m, engine: e.engine, reason: e.reason, demo: e.demo, cost: e.cost, model: e.model, modelWhy: e.modelWhy, free: e.free, about: e.about, charge: e.charge };
    case "text":
      return m.app ? { ...m, after: (m.after ?? "") + e.delta } : { ...m, content: m.content + e.delta };
    case "status":
      return { ...m, status: e.message };
    case "cost":
      return { ...m, cost: e.credits };
    case "image":
      return { ...m, status: undefined, images: [...(m.images ?? []), { url: e.url, prompt: e.prompt, ...(e.label && { label: e.label }) }] };
    case "video":
      return { ...m, status: undefined, videos: [...(m.videos ?? []), { url: e.url, prompt: e.prompt }] };
    case "audio":
      return { ...m, status: undefined, audio: e.url, audioLabel: e.label };
    case "app":
      return { ...m, status: undefined, app: e.app };
    case "sources":
      return { ...m, sources: e.items };
    case "posts":
      return { ...m, posts: e.posts };
    case "error":
      return { ...m, error: e.message };
    case "stopped":
      return { ...m, stopped: true };
    case "done":
      return { ...m, pending: false, status: undefined };
    // An event from a newer server than this page knows is left out, never breaking the reply.
    default:
      return m;
  }
}
