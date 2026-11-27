/**
 * A request body read with a byte ceiling that holds whatever the sender declares (security audit, 11 Nov 2026 —
 * SEC-27). Checking `content-length` and then calling `request.text()` holds nothing: a chunked request has no length,
 * reads as 0 and passes, and `text()` then buffers all of it in the one process every workspace shares. This reads the
 * stream and stops at the limit. Null when the body is larger than `limit` bytes.
 */
export async function readTextWithin(request: Request, limit: number): Promise<string | null> {
  const bytes = await readBytesWithin(request, limit);
  return bytes === null ? null : bytes.toString("utf8");
}

/** The body's bytes, read the same way: streamed, and null past `limit` bytes. */
export async function readBytesWithin(request: Request, limit: number): Promise<Buffer | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * A multipart (or url-encoded) form read within `limit` bytes (SEC-27): the bytes are streamed and stopped at
 * the ceiling first, and only then parsed — `request.formData()` alone buffers whatever arrives. Null when too
 * large; throws, as `formData()` does, when the body isn't a form.
 */
export async function readFormWithin(request: Request, limit: number): Promise<FormData | null> {
  const bytes = await readBytesWithin(request, limit);
  if (bytes === null) return null;
  const type = request.headers.get("content-type") ?? "";
  return new Response(new Uint8Array(bytes), { headers: { "content-type": type } }).formData();
}
