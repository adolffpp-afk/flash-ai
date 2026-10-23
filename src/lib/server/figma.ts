import { CALL_TIMEOUT_MS, McpError, toolHash, type McpTool, type ToolOutput } from "./mcp-client.ts";
import { SafeFetchError, safeFetch, type SafeResponse } from "./safe-fetch.ts";
import { appService } from "./app-signin.ts";
import { FIGMA_TOOL_WORDS } from "../connectors.ts";

/*
 * Figma in chat: two of Flash's own tools over Figma's REST API, both reads (they run by themselves),
 * with the scopes current_user:read and file_content:read only. Flash can't change anything in Figma.
 * Claude reads a file the user links to (its pages and their frames), then one frame as a compact
 * spec: each layer's type, name and size, auto layout (direction, gap, padding, alignment), colours,
 * corner radius, borders, shadows and text (font, size, weight, line height, colour), which is what
 * it needs to build that screen as an app or as code.
 *
 * Only a file or frame the user names can be read: there is no tool to list or search their files,
 * and Figma itself answers only for files the signed-in account can open. Figma counts these reads
 * (GET file and GET file nodes are its "Tier 1"): for a View or Collab seat it allows only a few a
 * month, per app, so each tool says to read a frame once and keep using what it returned, and a
 * limit reached says so plainly (see limitText), never tried again.
 *
 * Tokens are sealed by connections.ts and only reach api.figma.com, through safeFetch (or, in
 * development only, the stand-in at FLASH_CONNECT_MOCK), with time and size limits. Nothing here
 * calls a model or moves credits.
 */

/** Why a call failed, in Flash's words, for Claude (every Figma tool only reads, so none is shown on a card). */
export const FIGMA_PROBLEMS = {
  badLink: "That isn't a Figma link Flash can read. Copy the link of a Figma design file (Share > Copy link), or of one frame in it.",
  notFound: "Figma didn't find that file or frame, or this Figma account can't open it. Check the link, or ask its owner to share it with you.",
  tooBig: "That frame is too big for Flash to read in one go. Link to a smaller part of it, like one screen or section.",
};

// How much of a file is read: its pages and frames, and of one frame, its layers.
const FILE_BYTES = 4 * 1024 * 1024;
const FRAME_BYTES = 8 * 1024 * 1024;
const MAX_FRAMES = 300;
const MAX_LAYERS = 900;
const MAX_DEPTH = 14;
const READ_CHARS = 60_000;

/** A Figma file's key as Figma writes it. Anything else is refused before it reaches a request. */
const FILE_KEY = /^[A-Za-z0-9]{8,64}$/;
/** A node id: 1:23 (an instance's inner layer: I1:23;4:56). Links write it with a dash: 1-23. */
const NODE_ID = /^I?\d{1,12}[:-]\d{1,12}(?:;\d{1,12}[:-]\d{1,12}){0,20}$/;
const FIGMA_HOSTS = new Set(["figma.com", "www.figma.com"]);
const FILE_KINDS = new Set(["file", "design", "proto", "board", "slides", "deck", "make", "buzz", "site"]);

/** A node id as the API takes it: colons, never a link's dashes. */
const apiNode = (id: string) => id.replace(/(\d)-(\d)/g, "$1:$2");

/**
 * The file (or branch) key and node a link names: https://www.figma.com/design/KEY/Name?node-id=1-23,
 * /file/, /proto/, /board/ (FigJam) and the others, a branch link (/design/KEY/branch/BRANCH/Name), or
 * a bare key. Null for anything else: a link to another site is never followed.
 */
export function parseFigmaLink(value: unknown, nodeArg?: unknown): { key: string; node: string } | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length > 2000) return null;
  let key = "";
  let node = "";
  if (FILE_KEY.test(text)) key = text;
  else {
    let url: URL;
    try {
      url = new URL(text.startsWith("http") ? text : `https://${text}`);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || !FIGMA_HOSTS.has(url.hostname.toLowerCase())) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (!FILE_KINDS.has(parts[0] ?? "") || !FILE_KEY.test(parts[1] ?? "")) return null;
    key = parts[2] === "branch" && FILE_KEY.test(parts[3] ?? "") ? parts[3] : parts[1];
    node = url.searchParams.get("node-id") ?? "";
  }
  if (typeof nodeArg === "string" && nodeArg.trim()) node = nodeArg.trim();
  if (node && !NODE_ID.test(node)) return null;
  return { key, node: node ? apiNode(node) : "" };
}

const LINK = { type: "string", description: "The Figma link the user gave (Share > Copy link), of a file or of one frame in it (a link with node-id), or a file key." };

type Definition = { name: string; title: string; description: string; inputSchema: Record<string, unknown> };

const DEFINITIONS: Definition[] = [
  {
    name: "read_file",
    title: FIGMA_TOOL_WORDS.read_file.title,
    description: FIGMA_TOOL_WORDS.read_file.description,
    inputSchema: { type: "object", properties: { link: LINK }, required: ["link"], additionalProperties: false },
  },
  {
    name: "read_frame",
    title: FIGMA_TOOL_WORDS.read_frame.title,
    description: FIGMA_TOOL_WORDS.read_frame.description,
    inputSchema: {
      type: "object",
      properties: {
        link: LINK,
        node_id: { type: "string", description: "The frame's id (like 1:23), from read_file. Leave it out when the link already names the frame." },
      },
      required: ["link"],
      additionalProperties: false,
    },
  },
];

/** The tools as a server would list them, pinned by the same hash as any connector's tools. Both only read. */
export const FIGMA_TOOLS: McpTool[] = DEFINITIONS.map((d) => {
  const annotations = { readOnlyHint: true, destructiveHint: false };
  return { name: d.name, title: d.title, description: d.description, inputSchema: d.inputSchema, annotations, hash: toolHash(d.name, d.description, d.inputSchema, { title: d.title, annotations }) };
});

const FIELDS = new Map(DEFINITIONS.map((d) => [d.name, Object.keys(d.inputSchema.properties as Record<string, unknown>)]));

const failed = (text: string): ToolOutput => ({ text, isError: true });
const unusable = (why: string) => failed(`That input wasn't usable: ${why}.`);
type Node = Record<string, unknown>;
const field = (value: unknown, key: string): unknown => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined);
const list = (value: unknown): Node[] => (Array.isArray(value) ? value.filter((v): v is Node => Boolean(v) && typeof v === "object") : []);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
/** A number as a spec shows it: whole, or with at most 1 decimal. */
const px = (value: number) => String(Math.round(value * 10) / 10);
/** One line of a name or text from the file, quoted, without control characters, cut. */
const quote = (value: unknown, max = 120) => {
  const text = String(value ?? "")
    .replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return JSON.stringify(text.length > max ? `${text.slice(0, max)}…` : text);
};

/** A Figma colour (0-1 channels) as #RRGGBB, with its opacity when it isn't 1. */
function colour(c: unknown, opacity = 1): string {
  const ch = (k: string) => Math.round(Math.min(1, Math.max(0, num(field(c, k)) ?? 0)) * 255);
  const hex = `#${[ch("r"), ch("g"), ch("b")].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
  const a = (num(field(c, "a")) ?? 1) * opacity;
  return a < 0.995 ? `${hex} ${Math.round(a * 100)}%` : hex;
}

/** A layer's visible paints (fills or strokes), shortest first: a colour, a gradient's stops, or a picture. */
function paints(value: unknown, used: Set<string>): string[] {
  return list(value)
    .filter((p) => p.visible !== false)
    .map((p) => {
      const opacity = num(p.opacity) ?? 1;
      if (p.type === "SOLID") {
        const c = colour(p.color, opacity);
        used.add(c.split(" ")[0]);
        return c;
      }
      if (typeof p.type === "string" && p.type.startsWith("GRADIENT_")) {
        const stops = list(p.gradientStops).map((s) => colour(s.color, opacity));
        return `${p.type.slice(9).toLowerCase()} gradient ${stops.join(" → ")}`;
      }
      if (p.type === "IMAGE") return `picture (${String(p.scaleMode ?? "FILL").toLowerCase()})`;
      return String(p.type ?? "").toLowerCase();
    })
    .filter(Boolean);
}

const ALIGN: Record<string, string> = { MIN: "start", CENTER: "center", MAX: "end", SPACE_BETWEEN: "space-between", BASELINE: "baseline" };

/** What a layer looks like, in short: size, layout, paints, corners, borders, shadows and text. */
function describe(node: Node, parent: Node | null, used: { colours: Set<string>; fonts: Set<string> }): string {
  const parts: string[] = [];
  const box = field(node, "absoluteBoundingBox");
  const w = num(field(box, "width"));
  const h = num(field(box, "height"));
  if (w !== null && h !== null) parts.push(`${px(w)}×${px(h)}`);
  // Where it sits, only inside a parent without auto layout (auto layout places it by itself).
  const parentBox = parent && field(parent, "absoluteBoundingBox");
  const x = num(field(box, "x"));
  const y = num(field(box, "y"));
  const px0 = num(field(parentBox, "x"));
  const py0 = num(field(parentBox, "y"));
  if (parent && (parent.layoutMode === undefined || parent.layoutMode === "NONE") && parent.type !== "CANVAS" && x !== null && y !== null && px0 !== null && py0 !== null) {
    parts.push(`at ${px(x - px0)},${px(y - py0)}`);
  }
  const sizing = [node.layoutSizingHorizontal, node.layoutSizingVertical];
  if (sizing.some((s) => s === "FILL" || s === "HUG")) parts.push(`width ${String(sizing[0] ?? "fixed").toLowerCase()}, height ${String(sizing[1] ?? "fixed").toLowerCase()}`);
  if (node.layoutPositioning === "ABSOLUTE") parts.push("absolute");
  if (node.layoutMode === "HORIZONTAL" || node.layoutMode === "VERTICAL" || node.layoutMode === "GRID") {
    const pad = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].map((k) => num(node[k]) ?? 0);
    const layout = [`auto layout ${String(node.layoutMode).toLowerCase()}`];
    if (node.layoutWrap === "WRAP") layout.push("wrap");
    if (num(node.itemSpacing)) layout.push(`gap ${px(num(node.itemSpacing)!)}`);
    if (pad.some((p) => p)) layout.push(`padding ${pad.map(px).join(" ")}`);
    const main = ALIGN[String(node.primaryAxisAlignItems ?? "MIN")];
    const cross = ALIGN[String(node.counterAxisAlignItems ?? "MIN")];
    if (main !== "start" || cross !== "start") layout.push(`align ${main ?? "start"} / ${cross ?? "start"}`);
    parts.push(layout.join(", "));
  }
  if (node.type !== "TEXT") {
    const fill = paints(node.fills, used.colours);
    if (fill.length) parts.push(`fill ${fill.join(" + ")}`);
  }
  const stroke = paints(node.strokes, used.colours);
  if (stroke.length && num(node.strokeWeight)) parts.push(`border ${px(num(node.strokeWeight)!)} ${stroke.join(" + ")}`);
  const corners = Array.isArray(node.rectangleCornerRadii) ? (node.rectangleCornerRadii as unknown[]).map((r) => num(r) ?? 0) : null;
  if (corners && corners.some((r) => r)) parts.push(`radius ${corners.map(px).join(" ")}`);
  else if (num(node.cornerRadius)) parts.push(`radius ${px(num(node.cornerRadius)!)}`);
  for (const e of list(node.effects).filter((e) => e.visible !== false)) {
    if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
      const inner = e.type === "INNER_SHADOW" ? "inner " : "";
      parts.push(`${inner}shadow ${px(num(field(e.offset, "x")) ?? 0)} ${px(num(field(e.offset, "y")) ?? 0)} ${px(num(e.radius) ?? 0)}${num(e.spread) ? ` ${px(num(e.spread)!)}` : ""} ${colour(e.color)}`);
    } else if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") parts.push(`${e.type === "LAYER_BLUR" ? "blur" : "background blur"} ${px(num(e.radius) ?? 0)}`);
  }
  if (num(node.opacity) !== null && num(node.opacity)! < 1) parts.push(`opacity ${Math.round(num(node.opacity)! * 100)}%`);
  if (node.clipsContent === true && node.type !== "TEXT") parts.push("clips content");
  if (node.type === "TEXT") {
    const s = (field(node, "style") ?? {}) as Node;
    const family = typeof s.fontFamily === "string" ? s.fontFamily.slice(0, 60) : "";
    if (family) used.fonts.add(family);
    const size = num(s.fontSize);
    const line = num(s.lineHeightPx);
    const font = [family, num(s.fontWeight) ? String(num(s.fontWeight)) : "", s.italic === true ? "italic" : "", size ? `${px(size)}px${line ? `/${px(line)}px` : ""}` : ""].filter(Boolean).join(" ");
    if (font) parts.push(font);
    if (num(s.letterSpacing)) parts.push(`letter spacing ${px(num(s.letterSpacing)!)}`);
    const fill = paints(node.fills, used.colours);
    if (fill.length) parts.push(`colour ${fill.join(" + ")}`);
    if (s.textAlignHorizontal && s.textAlignHorizontal !== "LEFT") parts.push(`align ${String(s.textAlignHorizontal).toLowerCase()}`);
    if (s.textCase && s.textCase !== "ORIGINAL") parts.push(String(s.textCase).toLowerCase().replace("_", " "));
    if (s.textDecoration && s.textDecoration !== "NONE") parts.push(String(s.textDecoration).toLowerCase());
  }
  return parts.join(" · ");
}

/** A frame and its layers as an indented spec, at most MAX_LAYERS layers MAX_DEPTH deep; hidden layers left out. */
export function frameSpec(root: Node): { text: string; layers: number; cut: boolean } {
  const used = { colours: new Set<string>(), fonts: new Set<string>() };
  const lines: string[] = [];
  let layers = 0;
  let cut = false;
  const walk = (node: Node, parent: Node | null, depth: number) => {
    if (node.visible === false) return;
    if (layers >= MAX_LAYERS) {
      cut = true;
      return;
    }
    layers++;
    const type = String(node.type ?? "LAYER");
    const words = type === "TEXT" ? ` text ${quote(node.characters, 400)}` : "";
    const look = describe(node, parent, used);
    lines.push(`${"  ".repeat(depth)}${type} ${quote(node.name)} [${String(node.id ?? "")}]${words}${look ? ` · ${look}` : ""}`);
    const children = list(node.children);
    if (!children.length) return;
    // A vector's or a boolean shape's parts are one picture: they are named, not each described.
    if (type === "VECTOR" || type === "BOOLEAN_OPERATION") return;
    if (depth + 1 >= MAX_DEPTH) {
      lines.push(`${"  ".repeat(depth + 1)}[${children.length} more layer${children.length === 1 ? "" : "s"} inside, not read]`);
      cut = true;
      return;
    }
    for (const child of children) walk(child, node, depth + 1);
  };
  walk(root, null, 0);
  const head = [
    used.colours.size ? `Colours used: ${[...used.colours].slice(0, 40).join(", ")}` : "",
    used.fonts.size ? `Fonts used: ${[...used.fonts].slice(0, 20).join(", ")}` : "",
  ].filter(Boolean);
  return { text: [...head, ...(head.length ? [""] : []), ...lines].join("\n"), layers, cut };
}

/** How long until a limit lifts, in words, from Figma's Retry-After (seconds). */
function waitWords(seconds: number): string {
  if (seconds >= 2 * 86_400) return `about ${Math.round(seconds / 86_400)} days`;
  if (seconds >= 2 * 3600) return `about ${Math.round(seconds / 3600)} hours`;
  if (seconds >= 120) return `about ${Math.round(seconds / 60)} minutes`;
  return "a minute";
}

/**
 * Figma's limit, said plainly: for a View or Collab seat (its "low" limit) Figma allows only a few
 * file reads a month, and a Dev or Full seat on a paid plan gets far more. Never tried again.
 */
export function limitText(res: Pick<SafeResponse, "headers">): string {
  const retry = Number(res.headers["retry-after"]);
  const wait = Number.isFinite(retry) && retry > 0 ? ` It lifts in ${waitWords(retry)}.` : "";
  if (String(res.headers["x-figma-rate-limit-type"] ?? "").toLowerCase() === "low") {
    return `Figma's limit for this account was reached: Figma allows only a few file reads a month for a View or Collab seat.${wait} A Dev or Full seat on a paid Figma plan gets many more. Until then, use what was already read, or a screenshot of the frame.`;
  }
  return `Figma's limit for this account was reached, so Flash didn't try again.${wait}`;
}

/**
 * A connected Figma account, as connections.ts calls any connector (listTools and callTool, like an
 * MCP client's), holding the user's access token for one reply.
 */
export class FigmaClient {
  readonly protocol = "";
  private readonly token: string;
  private readonly signal?: AbortSignal;
  private deadline = 0;

  constructor(token: string, signal?: AbortSignal) {
    this.token = token;
    this.signal = signal;
  }

  async listTools(): Promise<McpTool[]> {
    return FIGMA_TOOLS.map((t) => ({ ...t, inputSchema: structuredClone(t.inputSchema), annotations: { ...t.annotations } }));
  }

  async close(): Promise<void> {}

  /** One GET to Figma with the user's token, within the call's time. */
  private async api(path: string, maxBytes: number): Promise<SafeResponse> {
    const left = (this.deadline || Date.now() + CALL_TIMEOUT_MS) - Date.now();
    if (left < 500) throw new McpError("timeout", "Figma took too long to answer.");
    try {
      return await safeFetch(`${appService("figma").api}${path}`, {
        headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
        accept: ["json"],
        maxBytes,
        timeoutMs: left,
        signal: this.signal,
      });
    } catch (err) {
      if (this.signal?.aborted || !(err instanceof SafeFetchError)) throw err;
      if (err.code === "timeout") throw new McpError("timeout", "Figma took too long to answer.");
      if (err.code === "too_large") throw new McpError("too_large", "Figma's answer was too large.");
      throw new McpError("unreachable", "Figma couldn't be reached.");
    }
  }

  /** What an answer that isn't a success means: a refused token is thrown (renewed once by the caller); the rest is the call's own failure. */
  private problemOf(res: SafeResponse): ToolOutput | null {
    if (res.status >= 200 && res.status < 300) return null;
    if (res.status === 401) throw new McpError("auth", "Figma didn't accept the sign-in.", { status: 401 });
    if (res.status === 429) return failed(limitText(res));
    if (res.status === 403 || res.status === 404) return failed(FIGMA_PROBLEMS.notFound);
    if (res.status >= 500) return failed("Figma couldn't answer right now. Try again later.");
    return failed(`Figma didn't accept this (HTTP ${res.status}).`);
  }

  async callTool(tool: Pick<McpTool, "name">, args: Record<string, unknown>): Promise<ToolOutput> {
    this.deadline = Date.now() + CALL_TIMEOUT_MS;
    const fields = FIELDS.get(tool.name);
    const extra = fields && Object.keys(args).find((key) => !fields.includes(key));
    if (extra !== undefined) return unusable(`${extra.slice(0, 60)} isn't a field of this tool`);
    if (tool.name === "read_file") return this.readFile(args);
    if (tool.name === "read_frame") return this.readFrame(args);
    return failed("Flash has no such Figma tool.");
  }

  /** A file's name, pages and their top frames (with the ids read_frame takes), from one read two levels deep. */
  private async readFile(args: Record<string, unknown>): Promise<ToolOutput> {
    const link = parseFigmaLink(args.link);
    if (!link) return failed(FIGMA_PROBLEMS.badLink);
    let res: SafeResponse;
    try {
      res = await this.api(`/v1/files/${link.key}?depth=2`, FILE_BYTES);
    } catch (err) {
      if (err instanceof McpError && err.code === "too_large") return failed(FIGMA_PROBLEMS.tooBig);
      throw err;
    }
    const problem = this.problemOf(res);
    if (problem) return problem;
    let body: Node;
    try {
      body = JSON.parse(res.body) as Node;
    } catch {
      return failed("Figma's answer couldn't be read.");
    }
    const lines: string[] = [];
    let frames = 0;
    for (const page of list(field(body.document, "children"))) {
      lines.push(`Page ${quote(page.name)} [${String(page.id ?? "")}]`);
      for (const frame of list(page.children)) {
        if (frame.visible === false) continue;
        if (frames >= MAX_FRAMES) break;
        frames++;
        const box = frame.absoluteBoundingBox;
        const size = num(field(box, "width")) !== null ? ` ${px(num(field(box, "width"))!)}×${px(num(field(box, "height")) ?? 0)}` : "";
        lines.push(`  ${String(frame.type ?? "LAYER")} ${quote(frame.name)} [${String(frame.id ?? "")}]${size}`);
      }
    }
    const more = frames >= MAX_FRAMES ? `\n[Only the first ${MAX_FRAMES} frames are listed.]` : "";
    return {
      text:
        `Figma file ${quote(body.name, 200)} (${String(body.editorType ?? "figma")}), last changed ${String(body.lastModified ?? "").slice(0, 10)}. ` +
        `Read a frame with read_frame and its id. Its pages and their top layers:\n${lines.join("\n")}${more}`,
      isError: false,
    };
  }

  /** One frame (or any layer) as a spec of its layers. */
  private async readFrame(args: Record<string, unknown>): Promise<ToolOutput> {
    const link = parseFigmaLink(args.link, args.node_id);
    if (!link) return failed(FIGMA_PROBLEMS.badLink);
    if (!link.node) return unusable("name the frame: give node_id from read_file, or a link to the frame itself (one with node-id)");
    let res: SafeResponse;
    try {
      res = await this.api(`/v1/files/${link.key}/nodes?ids=${encodeURIComponent(link.node)}`, FRAME_BYTES);
    } catch (err) {
      if (err instanceof McpError && err.code === "too_large") return failed(FIGMA_PROBLEMS.tooBig);
      throw err;
    }
    const problem = this.problemOf(res);
    if (problem) return problem;
    let body: Node;
    try {
      body = JSON.parse(res.body) as Node;
    } catch {
      return failed("Figma's answer couldn't be read.");
    }
    const root = field(field(body.nodes, link.node), "document");
    if (!root || typeof root !== "object") return failed(FIGMA_PROBLEMS.notFound);
    const spec = frameSpec(root as Node);
    const text = spec.text.length > READ_CHARS ? `${spec.text.slice(0, READ_CHARS)}\n[The rest of this frame wasn't read.]` : spec.text;
    const cut = spec.cut ? "\n[This frame has more layers than Flash reads: only the first ones are here. Read a smaller part for the rest.]" : "";
    return {
      text:
        `Frame ${link.node} of the Figma file ${quote(body.name, 200)}, as a spec of its layers (type, "name" [id], then size, ` +
        `position inside a parent without auto layout, layout, fill, border, radius, shadow and text). Pictures in it are named, not included:\n\n${text}${cut}`,
      isError: false,
    };
  }
}
