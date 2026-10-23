import { CALL_TIMEOUT_MS, McpError, toolHash, type McpTool, type ToolOutput } from "./mcp-client.ts";
import { RESULT_BYTES, SafeFetchError, mockOrigin, safeFetch, type SafeRequest, type SafeResponse } from "./safe-fetch.ts";
import { PdfNotNow, pdfTextOnServer } from "./pdf-server.ts";
import { appService } from "./app-signin.ts";
import { msg } from "../i18n.ts";
import { CANVA_TOOL_WORDS } from "../connectors.ts";

/*
 * Canva in chat, through Canva's Connect API: three of Flash's own tools, all reads, which run by
 * themselves: find the user's designs, read one (its details and the words on its pages, from a PDF
 * export Flash reads and throws away) and export one as PNG, JPG or PDF download links. Outside the
 * chat, "Open in Canva" on a picture Flash made (My creations) puts it in the user's Canva uploads
 * and opens a new design with it (sendPicture): the user presses it, so it asks nothing more.
 *
 * Canva answers only for designs the signed-in account can open; its export links last a day. A
 * limit reached is said plainly and never tried again. Exports and uploads are jobs Canva finishes a
 * few seconds later: Flash asks again once a second within the call's time, and says so when Canva
 * is still busy. Tokens are sealed by connections.ts and reach only api.canva.com (Canva's export
 * links, which carry no token, are read only for read_design's PDF), through safeFetch (or, in
 * development only, the stand-in at FLASH_CONNECT_MOCK). Nothing here calls a model or moves credits.
 */

/** Why a call failed, in Flash's words, for Claude; the ones Open in Canva can meet are shown in the user's language. */
export const CANVA_PROBLEMS = {
  badDesign: "That isn't a Canva design Flash can find. Use a design from search_designs, or the link of a design you can open in Canva.",
  notFound: msg("Canva didn't find that design, or this Canva account can't open it."),
  rate: msg("Canva's limit for this account was reached, so Flash didn't try again. Wait a few minutes, then ask again."),
  busy: msg("Canva is still preparing it. Ask again in a moment."),
  pdfBusy: msg("Flash is busy reading other PDFs. Try again in a minute."),
  pdfLater: msg("Flash can't read PDFs right now. Try again later."),
};

/** A design's id as Canva writes them, or one in a design's link (https://www.canva.com/design/ID/...). */
const DESIGN_ID = /^[A-Za-z0-9_-]{6,64}$/;
const CANVA_HOSTS = new Set(["canva.com", "www.canva.com"]);
const JOB_ID = /^[\w-]{1,128}$/;

export function parseCanvaDesign(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (DESIGN_ID.test(text)) return text;
  if (text.length > 2000) return null;
  try {
    const url = new URL(text.startsWith("http") ? text : `https://${text}`);
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.protocol === "https:" && CANVA_HOSTS.has(url.hostname.toLowerCase()) && parts[0] === "design" && DESIGN_ID.test(parts[1] ?? "")) return parts[1];
  } catch {
    // Not a link.
  }
  return null;
}

const DESIGN = { type: "string", description: "The design's id, from search_designs, or the link of a Canva design the user gave." };
const FORMATS = ["png", "jpg", "pdf"] as const;
// How much is read: a page of results, a PDF up to 10 MB, and the start of its words.
const PAGE_SIZE = 25;
const PDF_BYTES = 10 * 1024 * 1024;
const READ_CHARS = 60_000;
const MAX_PAGES = 50;
const POLL_MS = 1000;

type Definition = { name: string; title: string; description: string; inputSchema: Record<string, unknown> };

const DEFINITIONS: Definition[] = [
  {
    name: "search_designs",
    title: CANVA_TOOL_WORDS.search_designs.title,
    description: CANVA_TOOL_WORDS.search_designs.description,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", maxLength: 200, description: "Words in the design's title. Leave it out for the most recently changed designs." } },
      additionalProperties: false,
    },
  },
  {
    name: "read_design",
    title: CANVA_TOOL_WORDS.read_design.title,
    description: CANVA_TOOL_WORDS.read_design.description,
    inputSchema: { type: "object", properties: { design: DESIGN }, required: ["design"], additionalProperties: false },
  },
  {
    name: "export_design",
    title: CANVA_TOOL_WORDS.export_design.title,
    description: CANVA_TOOL_WORDS.export_design.description,
    inputSchema: {
      type: "object",
      properties: {
        design: DESIGN,
        format: { type: "string", enum: [...FORMATS], description: "png (the default), jpg or pdf." },
        pages: { type: "array", items: { type: "integer", minimum: 1 }, maxItems: MAX_PAGES, description: "The page numbers to export, from 1. Leave it out for every page." },
      },
      required: ["design"],
      additionalProperties: false,
    },
  },
];

/** The tools as a server would list them, pinned by the same hash as any connector's tools. All only read. */
export const CANVA_TOOLS: McpTool[] = DEFINITIONS.map((d) => {
  const annotations = { readOnlyHint: true, destructiveHint: false };
  return { name: d.name, title: d.title, description: d.description, inputSchema: d.inputSchema, annotations, hash: toolHash(d.name, d.description, d.inputSchema, { title: d.title, annotations }) };
});

const FIELDS = new Map(DEFINITIONS.map((d) => [d.name, Object.keys(d.inputSchema.properties as Record<string, unknown>)]));

const failed = (text: string): ToolOutput => ({ text, isError: true });
const unusable = (why: string) => failed(`That input wasn't usable: ${why}.`);
type Json = Record<string, unknown>;
const field = (value: unknown, key: string): unknown => (value && typeof value === "object" ? (value as Json)[key] : undefined);
const parse = (res: SafeResponse): unknown => {
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
};
/** One line of Canva's text, quoted, without control characters, cut. */
const quote = (value: unknown, max = 200) =>
  JSON.stringify(
    String(value ?? "")
      .replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max),
  );
/** A link Canva gave, kept only when it is https (or, in development, the stand-in's). */
const link = (value: unknown) =>
  typeof value === "string" && /^[^\s"<>]{1,2000}$/.test(value) && (value.startsWith("https://") || (mockOrigin() !== "" && value.startsWith(`${mockOrigin()}/`))) ? value : "";
const day = (seconds: unknown) => (typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000).toISOString().slice(0, 10) : "");

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/** What a picture sent to Canva became: the new design's editing link, or why not (a CANVA_PROBLEMS text or Canva's limit). */
export type SentPicture = { url: string } | { problem: string };

/**
 * A connected Canva account, as connections.ts calls any connector (listTools and callTool, like an
 * MCP client's), holding the user's access token for one reply or one press of Open in Canva.
 */
export class CanvaClient {
  readonly protocol = "";
  private readonly token: string;
  private readonly owner: { userId: string };
  private readonly signal?: AbortSignal;
  private deadline = 0;

  constructor(token: string, owner: { userId: string }, signal?: AbortSignal) {
    this.token = token;
    this.owner = owner;
    this.signal = signal;
  }

  async listTools(): Promise<McpTool[]> {
    return CANVA_TOOLS.map((t) => ({ ...t, inputSchema: structuredClone(t.inputSchema), annotations: { ...t.annotations } }));
  }

  async close(): Promise<void> {}

  /** One request to Canva's API with the user's token, within the call's time; a POST never redirected. */
  private async api(
    path: string,
    { method = "GET", json, bytes, headers = {}, maxBytes = RESULT_BYTES }: { method?: "GET" | "POST"; json?: unknown; bytes?: Buffer; headers?: Record<string, string>; maxBytes?: number } = {},
  ): Promise<SafeResponse> {
    return this.send(`${appService("canva").api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        ...(json !== undefined && { "content-type": "application/json" }),
        ...(bytes && { "content-type": "application/octet-stream" }),
        ...headers,
      },
      ...(json !== undefined && { body: JSON.stringify(json) }),
      ...(bytes && { body: bytes }),
      accept: ["json"],
      maxBytes,
      ...(method !== "GET" && { followRedirects: false as const }),
    });
  }

  private async send(url: string, req: SafeRequest): Promise<SafeResponse> {
    const left = (this.deadline || Date.now() + CALL_TIMEOUT_MS) - Date.now();
    if (left < 500) throw new McpError("timeout", "Canva took too long to answer.");
    try {
      return await safeFetch(url, { ...req, timeoutMs: left, signal: this.signal });
    } catch (err) {
      if (this.signal?.aborted || !(err instanceof SafeFetchError)) throw err;
      if (err.code === "timeout") throw new McpError("timeout", "Canva took too long to answer.");
      if (err.code === "too_large") throw new McpError("too_large", "Canva's answer was too large.");
      throw new McpError("unreachable", "Canva couldn't be reached.");
    }
  }

  /** What an answer that isn't a success means: a refused token is thrown (renewed once by the caller); the rest is the call's own failure. */
  private problemOf(res: SafeResponse): ToolOutput | null {
    if (res.status >= 200 && res.status < 300) return null;
    if (res.status === 401) throw new McpError("auth", "Canva didn't accept the sign-in.", { status: 401 });
    if (res.status === 429) return failed(CANVA_PROBLEMS.rate);
    if (res.status === 403 || res.status === 404) return failed(CANVA_PROBLEMS.notFound);
    if (res.status >= 500) return failed("Canva couldn't answer right now. Try again later.");
    const message = String(field(parse(res), "message") ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    return failed(`Canva didn't accept this${message ? `: ${message}` : ` (HTTP ${res.status})`}.`);
  }

  /**
   * A job Canva runs (an export or an upload): asked about once a second until it is done, while the
   * call's time lasts. Its finished body ({ done }), a failure, or null while Canva is still at it.
   */
  private async job(path: string, started: SafeResponse): Promise<{ done: Json } | ToolOutput | null> {
    const problem = this.problemOf(started);
    if (problem) return problem;
    let job = field(parse(started), "job") as Json | undefined;
    const id = String(field(job, "id") ?? "");
    if (!JOB_ID.test(id)) return failed("Canva's answer couldn't be read.");
    while (field(job, "status") === "in_progress") {
      if (this.deadline - Date.now() < POLL_MS + 3000) return null;
      await pause(POLL_MS, this.signal);
      if (this.signal?.aborted) return null;
      const res = await this.api(`${path}/${encodeURIComponent(id)}`);
      const later = this.problemOf(res);
      if (later) return later;
      job = field(parse(res), "job") as Json | undefined;
    }
    if (field(job, "status") !== "success") {
      const why = String(field(field(job, "error"), "message") ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
      return failed(`Canva couldn't do it${why ? `: ${why}` : ""}.`);
    }
    return job ? { done: job } : null;
  }

  async callTool(tool: Pick<McpTool, "name">, args: Record<string, unknown>): Promise<ToolOutput> {
    this.deadline = Date.now() + CALL_TIMEOUT_MS;
    const fields = FIELDS.get(tool.name);
    const extra = fields && Object.keys(args).find((key) => !fields.includes(key));
    if (extra !== undefined) return unusable(`${extra.slice(0, 60)} isn't a field of this tool`);
    switch (tool.name) {
      case "search_designs":
        return this.searchDesigns(args);
      case "read_design":
        return this.readDesign(args);
      case "export_design":
        return this.exportDesign(args);
      default:
        return failed("Flash has no such Canva tool.");
    }
  }

  /** A design as one line: its title, id, pages, last change and editing link. */
  private line(d: unknown): string {
    const pages = Number(field(d, "page_count") ?? 0);
    const edit = link(field(field(d, "urls"), "edit_url"));
    return `- ${quote(field(d, "title") || "Untitled")} (id ${String(field(d, "id") ?? "")}${pages ? `, ${pages} page${pages === 1 ? "" : "s"}` : ""}${day(field(d, "updated_at")) ? `, changed ${day(field(d, "updated_at"))}` : ""})${edit ? `: ${edit}` : ""}`;
  }

  private async searchDesigns(args: Record<string, unknown>): Promise<ToolOutput> {
    if (args.query !== undefined && (typeof args.query !== "string" || args.query.length > 200)) return unusable("query must be text, at most 200 characters");
    const query = typeof args.query === "string" ? args.query.trim() : "";
    const q = new URLSearchParams({ ownership: "any", sort_by: query ? "relevance" : "modified_descending", limit: String(PAGE_SIZE) });
    if (query) q.set("query", query);
    const res = await this.api(`/v1/designs?${q}`);
    const problem = this.problemOf(res);
    if (problem) return problem;
    const items = field(parse(res), "items");
    const designs = (Array.isArray(items) ? items : []).filter((d) => DESIGN_ID.test(String(field(d, "id") ?? ""))).slice(0, PAGE_SIZE);
    if (!designs.length) return { text: query ? `No Canva design's title matches ${quote(query)}.` : "This Canva account has no designs yet.", isError: false };
    return { text: `${query ? `Canva designs matching ${quote(query)}` : "The most recently changed Canva designs"} (read one with read_design, export it with export_design):\n${designs.map((d) => this.line(d)).join("\n")}`, isError: false };
  }

  /** A design's details, and the words on its pages from a PDF export (pictures and layout aren't read). */
  private async readDesign(args: Record<string, unknown>): Promise<ToolOutput> {
    const id = parseCanvaDesign(args.design);
    if (!id) return failed(CANVA_PROBLEMS.badDesign);
    const info = await this.api(`/v1/designs/${id}`);
    const problem = this.problemOf(info);
    if (problem) return problem;
    const design = field(parse(info), "design");
    const head = `Canva design:\n${this.line(design)}`;
    const job = await this.job("/v1/exports", await this.api("/v1/exports", { method: "POST", json: { design_id: id, format: { type: "pdf" } } }));
    if (job === null) return { text: `${head}\n\n${CANVA_PROBLEMS.busy}`, isError: false };
    if (!("done" in job)) return { text: `${head}\n\nIts words couldn't be read: ${job.text}`, isError: false };
    const file = link((field(job.done, "urls") as unknown[] | undefined)?.[0]);
    if (!file) return { text: `${head}\n\nIts words couldn't be read: Canva sent no file.`, isError: false };
    let pdf: SafeResponse;
    try {
      // Canva's export link carries no token, and none is sent with it.
      pdf = await this.send(file, { accept: ["pdf"], raw: true, maxBytes: PDF_BYTES });
    } catch (err) {
      if (err instanceof McpError && err.code === "too_large") return { text: `${head}\n\nIts words weren't read: its PDF is larger than the 10 MB Flash reads.`, isError: false };
      throw err;
    }
    if (pdf.status !== 200) return { text: `${head}\n\nIts words couldn't be read: Canva's file couldn't be downloaded.`, isError: false };
    let read: Awaited<ReturnType<typeof pdfTextOnServer>>;
    try {
      read = await pdfTextOnServer(new Uint8Array(Buffer.from(pdf.body, "latin1")), { maxChars: READ_CHARS, deadline: this.deadline - 500, user: this.owner.userId });
    } catch (err) {
      if (err instanceof PdfNotNow) return { text: `${head}\n\n${err.why === "busy" ? CANVA_PROBLEMS.pdfBusy : CANVA_PROBLEMS.pdfLater}`, isError: false };
      return { text: `${head}\n\nIts words couldn't be read.`, isError: false };
    }
    const words = read.text.replace(/--- Page \d+ ---/g, "").trim() ? read.text.slice(0, READ_CHARS) : "[No words Flash can read: its text may be in pictures.]";
    const cut = read.stopped || read.read < read.pages ? `\n\n[Only the first ${read.read} of ${read.pages} pages were read.]` : "";
    return { text: `${head}\n\nThe words on its pages (pictures and layout aren't included):\n\n${words}${cut}`, isError: false };
  }

  /** Download links for a design as PNG, JPG (a link for each page) or one PDF. */
  private async exportDesign(args: Record<string, unknown>): Promise<ToolOutput> {
    const id = parseCanvaDesign(args.design);
    if (!id) return failed(CANVA_PROBLEMS.badDesign);
    const format = args.format === undefined ? "png" : args.format;
    if (typeof format !== "string" || !(FORMATS as readonly string[]).includes(format)) return unusable("format must be png, jpg or pdf");
    let pages: number[] | undefined;
    if (args.pages !== undefined) {
      if (!Array.isArray(args.pages) || !args.pages.length || args.pages.length > MAX_PAGES || args.pages.some((p) => !Number.isSafeInteger(p) || p < 1 || p > 10_000)) {
        return unusable(`pages must be 1 to ${MAX_PAGES} page numbers, from 1`);
      }
      pages = [...new Set(args.pages as number[])];
    }
    const body = { design_id: id, format: { type: format, ...(format === "jpg" && { quality: 90 }), ...(pages && { pages }) } };
    const job = await this.job("/v1/exports", await this.api("/v1/exports", { method: "POST", json: body }));
    if (job === null) return failed(CANVA_PROBLEMS.busy);
    if (!("done" in job)) return job;
    const urls = (Array.isArray(field(job.done, "urls")) ? (field(job.done, "urls") as unknown[]) : []).map(link).filter(Boolean).slice(0, MAX_PAGES);
    if (!urls.length) return failed("Canva sent no file.");
    const lines = urls.map((u, i) => (format === "pdf" || (urls.length === 1 && !pages) ? u : `Page ${pages?.[i] ?? i + 1}: ${u}`));
    return { text: `The design exported as ${format.toUpperCase()}. These download links work for about a day:\n${lines.join("\n")}`, isError: false };
  }

  /**
   * Open in Canva: a picture of the user's own (its bytes, read by connections.ts from their
   * creations) goes to their Canva uploads, then a new design is made with it, sized to it. The new
   * design's editing link, or why not.
   */
  async sendPicture(name: string, bytes: Buffer): Promise<SentPicture> {
    this.deadline = Date.now() + 3 * CALL_TIMEOUT_MS;
    const title = name.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 50) || "Flash picture";
    const upload = await this.job(
      "/v1/asset-uploads",
      await this.api("/v1/asset-uploads", { method: "POST", bytes, headers: { "asset-upload-metadata": JSON.stringify({ name_base64: Buffer.from(title).toString("base64") }) } }),
    );
    if (upload === null) return { problem: CANVA_PROBLEMS.busy };
    if (!("done" in upload)) return { problem: upload.text };
    const asset = String(field(field(upload.done, "asset"), "id") ?? "");
    if (!/^[\w-]{1,128}$/.test(asset)) return { problem: "Canva's answer couldn't be read." };
    const res = await this.api("/v1/designs", { method: "POST", json: { asset_id: asset, title } });
    const problem = this.problemOf(res);
    if (problem) return { problem: problem.text };
    const url = link(field(field(field(parse(res), "design"), "urls"), "edit_url"));
    return url ? { url } : { problem: "Canva's answer couldn't be read." };
  }
}
