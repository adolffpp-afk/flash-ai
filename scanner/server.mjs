/*
 * The web front of Flash's virus scanner. Takes one file per request and asks ClamAV (clamd) about
 * it over its local socket, without saving it anywhere.
 *
 *   POST /scan    the file's bytes as the body, with "Authorization: Bearer <SCANNER_KEY>".
 *                 200 {"clean":true} or {"clean":false,"virus":"<name>"}; 503 while ClamAV starts.
 *   GET  /health  200 when ClamAV answers, else 503. Says nothing else, so it needs no key.
 */
import { createServer } from "node:http";
import { connect } from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";

const KEY = process.env.SCANNER_KEY ?? "";
const PORT = Number(process.env.PORT || 8080);
const SOCKET = process.env.CLAMD_SOCKET || "/tmp/clamd.sock";
// Flash's uploads are 5 MB at most; ClamAV's own stream limit is 25 MB.
const MAX_BYTES = Number(process.env.MAX_BYTES || 20 * 1024 * 1024);

if (KEY.length < 24) {
  console.error("Set SCANNER_KEY to a long random password (at least 24 characters).");
  process.exit(1);
}

const digest = (s) => createHash("sha256").update(s).digest();
const keyOk = (header) => {
  const given = /^Bearer (.+)$/.exec(header ?? "")?.[1] ?? "";
  return timingSafeEqual(digest(given), digest(KEY));
};

/** Sends one command to clamd and returns its answer, without the trailing NUL. */
function clamd(command, body) {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCKET);
    const parts = [];
    sock.setTimeout(30_000, () => sock.destroy(new Error("clamd timed out")));
    sock.on("error", reject);
    sock.on("data", (d) => parts.push(d));
    sock.on("end", () => resolve(Buffer.concat(parts).toString("utf8").replace(/\0+$/, "").trim()));
    sock.on("connect", () => {
      sock.write(`z${command}\0`);
      if (body) {
        // INSTREAM: chunks each led by their length, then a zero length.
        for (let i = 0; i < body.length; i += 64 * 1024) {
          const chunk = body.subarray(i, i + 64 * 1024);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(chunk.length);
          sock.write(len);
          sock.write(chunk);
        }
        sock.write(Buffer.alloc(4));
      }
    });
  });
}

/** What ClamAV makes of a file: clean, or the name of what it found. */
async function scan(bytes) {
  const answer = await clamd("INSTREAM", bytes);
  if (/^stream: OK$/.test(answer)) return { clean: true };
  const found = /^stream: (.+) FOUND$/.exec(answer);
  if (found) return { clean: false, virus: found[1] };
  throw new Error(`clamd: ${answer}`);
}

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      const ready = await clamd("PING").then((a) => a === "PONG", () => false);
      return send(res, ready ? 200 : 503, { ready });
    }
    if (req.method !== "POST" || req.url !== "/scan") return send(res, 404, { error: "Not found" });
    if (!keyOk(req.headers.authorization)) return send(res, 401, { error: "Wrong key" });
    if (Number(req.headers["content-length"] ?? 0) > MAX_BYTES) return send(res, 413, { error: "Too big" });
    const parts = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BYTES) return send(res, 413, { error: "Too big" });
      parts.push(chunk);
    }
    const result = await scan(Buffer.concat(parts)).catch((err) => {
      console.error("[scanner]", err.message);
      return null;
    });
    return result ? send(res, 200, result) : send(res, 503, { error: "ClamAV isn't ready" });
  } catch (err) {
    console.error("[scanner]", err);
    if (!res.headersSent) send(res, 500, { error: "Scan failed" });
  }
});

server.listen(PORT, () => console.log(`[scanner] listening on ${PORT}`));
