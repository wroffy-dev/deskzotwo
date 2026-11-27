/**
 * What crosses the internal API, both ways: JSON, with the few types JSON loses kept by a tag, so
 * an action's arguments and a loader's rows arrive as the code on the other side expects them.
 *
 *   Date      { "$date": "<ISO>" }
 *   BigInt    { "$bigint": "<digits>" }
 *   Decimal   { "$decimal": "<digits>" }   Prisma's Decimal (anything with toFixed and a `d` array); arrives as a string
 *   Buffer    { "$bytes": "<base64>" }
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

export function decode(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decode);
  const keys = Object.keys(value);
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
