/**
 * A request's body as text, or null when it is longer than maxBytes: refused by its Content-Length
 * before anything is read, or as soon as more than maxBytes has come in, so a body sent without a
 * length (or with a wrong one) is never held past the cap. Read as request.text() would read it.
 */
export async function cappedText(request: Request, maxBytes: number): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      // The rest is never asked for.
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}
