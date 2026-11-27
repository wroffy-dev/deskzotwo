/**
 * What crosses the internal API, both ways: JSON, with the few types JSON loses kept by a tag, so
 * an action's arguments and a loader's rows arrive as the code on the other side expects them.
 *
 *   Date      { "$date": "<ISO>" }
 *   BigInt    { "$bigint": "<digits>" }
 *   Decimal   { "$decimal": "<digits>" }   Prisma's Decimal (anything with toFixed and a `d` array); arrives as a string
 *   Buffer    { "$bytes": "<base64>" }
 *   FormData  { "$form": [[name, value], …] }       a File value as { "$file": { name, type, bytes } }
 *
 * FormData and File have to be read before they are encoded (`materialize`): a server action that takes
 * an upload gets it, on the CRM, as the FormData and File it was written for.
 *
 * The admin app carries the same file. Keys starting with "$" are reserved: an object that has one
 * of these keys and nothing else is read as the tag.
 */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isDecimal(value: object): boolean {
  const v = value as { toFixed?: unknown; d?: unknown; constructor?: { name?: string } };
  return typeof v.toFixed === "function" && Array.isArray(v.d) && v.constructor?.name === "Decimal";
}

export function encode(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (typeof value !== "object") return typeof value === "function" || typeof value === "symbol" ? null : (value as Json);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : { $date: value.toISOString() };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
  if (isDecimal(value)) return { $decimal: String(value) };
  if (Array.isArray(value)) return value.map(encode);
  if (value instanceof Map) return encode(Object.fromEntries(value));
  if (value instanceof Set) return encode([...value]);
  const out: { [key: string]: Json } = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || typeof v === "function") continue;
    out[k] = encode(v);
  }
  return out;
}

/** FormData and Blobs in `value`, read into tagged plain objects that `encode` can carry. */
export async function materialize(value: unknown): Promise<unknown> {
  if (value === null || typeof value !== "object") return value;
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    const name = typeof File !== "undefined" && value instanceof File ? value.name : "blob";
    return { $file: { name, type: value.type, bytes: Buffer.from(await value.arrayBuffer()) } };
  }
  if (typeof FormData !== "undefined" && value instanceof FormData) {
    const entries: [string, unknown][] = [];
    for (const [k, v] of value.entries()) entries.push([k, await materialize(v)]);
    return { $form: entries };
  }
  if (Array.isArray(value)) return Promise.all(value.map(materialize));
  if (value instanceof Date || Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof Map || value instanceof Set) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = await materialize(v);
  return out;
}

function fileOf(v: unknown): File | null {
  if (!v || typeof v !== "object" || !("$file" in v)) return null;
  const f = (v as { $file: { name?: unknown; type?: unknown; bytes?: unknown } }).$file;
  const bytes = Buffer.isBuffer(f.bytes) ? f.bytes : Buffer.alloc(0);
  return new File([new Uint8Array(bytes)], typeof f.name === "string" ? f.name : "file", { type: typeof f.type === "string" ? f.type : "" });
}

export function decode(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decode);
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "$form" && Array.isArray((value as { $form: unknown }).$form)) {
    const form = new FormData();
    for (const pair of (value as { $form: unknown[] }).$form) {
      if (!Array.isArray(pair) || typeof pair[0] !== "string") continue;
      const v = decode(pair[1]);
      const file = fileOf(v);
      if (file) form.append(pair[0], file);
      else form.append(pair[0], typeof v === "string" ? v : String(v ?? ""));
    }
    return form;
  }
  if (keys.length === 1 && keys[0] === "$file") return fileOf({ $file: decode((value as { $file: unknown }).$file) });
  if (keys.length === 1) {
    const v = (value as Record<string, unknown>)[keys[0]];
    if (typeof v === "string") {
      if (keys[0] === "$date") return new Date(v);
      if (keys[0] === "$bigint") return BigInt(v);
      if (keys[0] === "$decimal") return v;
      if (keys[0] === "$bytes") return Buffer.from(v, "base64");
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = decode(v);
  return out;
}
